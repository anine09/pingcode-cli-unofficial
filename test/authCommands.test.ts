import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program';
import { loginHooks } from '../src/cli/commands/auth';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { DryRunHalt, exitCodeFor } from '../src/core/errors';
import { captureOutput } from '../src/cli/output';
import { createFakeFetch, jsonResponse } from './helpers/fake';

/**
 * `auth login | status | logout` end to end, through the real `buildProgram()`
 * tree with `fetch` replaced at the global boundary and the config dir
 * redirected to a temp dir. No network, no TTY, no browser — the interactive
 * steps are driven through `loginHooks` seams (design D13).
 */

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret';
const NOW = Date.now();
const EXPIRES = NOW + THIRTY_DAYS_MS;

let dir: string;
let prevConfigDir: string | undefined;
const savedHooks = { ...loginHooks };

function writeConfig(config: unknown): void {
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
}

function baseConfig(): Record<string, unknown> {
  return {
    host: 'https://open.pingcode.com',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    token: { accessToken: 'test-token', expiresAtMs: EXPIRES, obtainedAtMs: NOW },
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-auth-cmd-'));
  writeConfig(baseConfig());
  prevConfigDir = process.env.PINGCODE_CONFIG_DIR;
  process.env.PINGCODE_CONFIG_DIR = dir;
  Object.assign(loginHooks, savedHooks);
  loginHooks.openBrowser = () => {};
});

afterEach(() => {
  Object.assign(loginHooks, savedHooks);
  if (prevConfigDir === undefined) delete process.env.PINGCODE_CONFIG_DIR;
  else process.env.PINGCODE_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

type CliRun = { stdout: string; stderr: string; exit: number; calls: ReturnType<typeof createFakeFetch>['calls'] };

async function runCli(argv: string[], responses: Array<() => Response> = []): Promise<CliRun> {
  const fake = createFakeFetch(responses.length === 0 ? [() => jsonResponse({})] : responses);
  let stdout = '';
  let stderr = '';
  const restoreOutput = captureOutput(
    (chunk) => {
      stdout += chunk;
    },
    (chunk) => {
      stderr += chunk;
    },
  );
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch as unknown as typeof globalThis.fetch;

  let exit = 0;
  try {
    await buildProgram().parseAsync(['node', 'pingcode', ...argv]);
  } catch (error) {
    if (error instanceof DryRunHalt) {
      const { printDryRun } = await import('../src/cli/output');
      printDryRun(error.plan, { json: argv.includes('--json') });
    } else if (error instanceof CommanderError) {
      exit = error.exitCode === 0 ? 0 : 2;
    } else {
      const { printError } = await import('../src/cli/output');
      printError(error, { json: argv.includes('--json') });
      exit = exitCodeFor(error);
    }
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realStderr;
    restoreOutput();
  }
  return { stdout, stderr, exit, calls: fake.calls };
}

const tokenUser = (): Response =>
  jsonResponse({ access_token: 'user-tok', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 });
const myself = (name = '张三'): Response =>
  jsonResponse({ id: 'u1', name, display_name: name, username: 'zs', is_deleted: 0 });

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe('auth login — user mode (authorization_code)', () => {
  it('defaults to user mode when --mode is omitted (R2)', async () => {
    loginHooks.captureCode = async () => ({ code: 'BROWSER-CODE' });
    const run = await runCli(['auth', 'login', '--json'], [tokenUser, myself]);
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout).mode).toBe('user');
  });

  it('browser channel persists the user slot, verifies with /v1/myself, prints the URL to stderr', async () => {
    loginHooks.captureCode = async () => ({ code: 'BROWSER-CODE', domain: 'htz' });
    const run = await runCli(['auth', 'login', '--mode', 'user', '--json'], [tokenUser, () => myself('张三')]);

    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(out.mode).toBe('user');
    expect(out.kind).toBe('user');
    expect(out.verified_with).toBe('GET /v1/myself');
    expect((out.user as { display_name?: string }).display_name).toBe('张三');

    // The authorize URL goes to stderr, never stdout (R9 / JSON purity).
    expect(run.stdout).not.toContain('oauth2/authorize');
    expect(run.stderr).toContain('oauth2/authorize');
    expect(run.stderr).toContain('client_id=test-client');

    // Token exchange carried grant_type=authorization_code + the code.
    const tokenCall = run.calls[0]?.url ?? '';
    expect(tokenCall).toContain('grant_type=authorization_code');
    expect(tokenCall).toContain('code=BROWSER-CODE');

    const cfg = readConfig();
    expect(cfg.authMode).toBe('user');
    expect((cfg.userToken as { accessToken?: string }).accessToken).toBe('user-tok');
    expect((cfg.userToken as { refreshToken?: string }).refreshToken).toBe('rt-1');
    // Enterprise slot untouched (coexistence, R1).
    expect((cfg.token as { accessToken?: string }).accessToken).toBe('test-token');
  });

  it('paste channel reads the code from the prompt and persists the user slot', async () => {
    loginHooks.selectChannel = async () => 'paste';
    loginHooks.readCode = async () => 'PASTED-CODE';
    const run = await runCli(['auth', 'login', '--mode', 'user', '--json'], [tokenUser, () => myself('李四')]);

    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(out.mode).toBe('user');
    expect((out.user as { display_name?: string }).display_name).toBe('李四');

    const tokenCall = run.calls[0]?.url ?? '';
    expect(tokenCall).toContain('code=PASTED-CODE');
    const cfg = readConfig();
    expect(cfg.authMode).toBe('user');
    expect((cfg.userToken as { accessToken?: string }).accessToken).toBe('user-tok');
  });

  it('--code flag uses the code directly, bypassing the channel and hooks (non-interactive)', async () => {
    // If the flag path were wrong, these would be invoked and throw.
    loginHooks.captureCode = async () => {
      throw new Error('captureCode must not be called when --code is given');
    };
    loginHooks.readCode = async () => {
      throw new Error('readCode must not be called when --code is given');
    };
    const run = await runCli(['auth', 'login', '--mode', 'user', '--code', 'FLAG-CODE', '--json'], [tokenUser, myself]);

    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url ?? '').toContain('code=FLAG-CODE');
    const cfg = readConfig();
    expect(cfg.authMode).toBe('user');
    expect((cfg.userToken as { accessToken?: string }).accessToken).toBe('user-tok');
  });

  it('two-app isolation: user login routes --client-id to the user slot, leaving the enterprise app intact', async () => {
    // Base config holds the ENTERPRISE app (test-client/test-secret).
    loginHooks.captureCode = async () => ({ code: 'BROWSER-CODE' });
    const run = await runCli(
      [
        'auth',
        'login',
        '--mode',
        'user',
        '--client-id',
        'user-app-id',
        '--client-secret',
        'user-app-secret',
        '--save',
        '--json',
      ],
      [tokenUser, myself],
    );

    expect(run.exit).toBe(0);
    // The authorize URL + token exchange use the USER app, not the enterprise one.
    expect(run.stderr).toContain('client_id=user-app-id');
    expect(run.calls[0]?.url ?? '').toContain('client_id=user-app-id');
    expect(run.calls[0]?.url ?? '').toContain('client_secret=user-app-secret');

    const cfg = readConfig();
    // Enterprise app untouched (R1 coexistence — the two apps do not clobber).
    expect(cfg.clientId).toBe(CLIENT_ID);
    expect(cfg.clientSecret).toBe(CLIENT_SECRET);
    // User app persisted to its own slot.
    expect(cfg.userClientId).toBe('user-app-id');
    expect(cfg.userClientSecret).toBe('user-app-secret');
    expect(cfg.authMode).toBe('user');
  });

  it('user login falls back to the stored userClientId (file) when no --client-id is given', async () => {
    writeConfig({
      ...baseConfig(),
      userClientId: 'stored-user-id',
      userClientSecret: 'stored-user-secret',
    });
    loginHooks.captureCode = async () => ({ code: 'BROWSER-CODE' });
    const run = await runCli(['auth', 'login', '--mode', 'user', '--json'], [tokenUser, myself]);

    expect(run.exit).toBe(0);
    // The stored USER app is used, not the enterprise test-client.
    expect(run.calls[0]?.url ?? '').toContain('client_id=stored-user-id');
    expect(run.calls[0]?.url ?? '').not.toContain('client_id=test-client');
  });
});

describe('auth login — enterprise mode (unchanged, D11)', () => {
  it('acquires via client_credentials, verifies with listProjects, persists the enterprise slot', async () => {
    const run = await runCli(['auth', 'login', '--mode', 'enterprise', '--json'], [
      () => jsonResponse({ access_token: 'ent-tok', token_type: 'Bearer', expires_in: 3600 }),
      () => jsonResponse({ page_index: 0, page_size: 1, total: 7, values: [] }),
    ]);

    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(out.mode).toBe('enterprise');
    expect(out.kind).toBe('enterprise');
    expect(out.projects_total).toBe(7);
    expect(out.verified_with).toBe('GET /v1/pjm/projects?page_size=1');

    const tokenCall = run.calls[0]?.url ?? '';
    expect(tokenCall).toContain('grant_type=client_credentials');
    expect(tokenCall).not.toContain('refresh_token');

    const cfg = readConfig();
    expect(cfg.authMode).toBe('enterprise');
    expect((cfg.token as { accessToken?: string }).accessToken).toBe('ent-tok');
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('auth status', () => {
  it('reports user mode, kind, and refresh-token presence (AC8)', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'user',
      userToken: { accessToken: 'ut', refreshToken: 'rt', expiresAtMs: EXPIRES, obtainedAtMs: NOW, kind: 'user' },
    });
    const run = await runCli(['auth', 'status', '--json'], []);
    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(out.auth_mode).toBe('user');
    expect(out.token_kind).toBe('user');
    expect(out.user_token_present).toBe(true);
    expect(out.user_refresh_token_present).toBe(true);
  });

  it('reports enterprise mode and no user slot', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'enterprise',
      token: { accessToken: 'et', expiresAtMs: EXPIRES, obtainedAtMs: NOW, kind: 'enterprise' },
    });
    const run = await runCli(['auth', 'status', '--json'], []);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(out.auth_mode).toBe('enterprise');
    expect(out.token_kind).toBe('enterprise');
    expect(out.user_token_present).toBe(false);
  });

  it('--check verifies user mode with /v1/myself', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'user',
      userToken: { accessToken: 'ut', refreshToken: 'rt', expiresAtMs: EXPIRES, obtainedAtMs: NOW, kind: 'user' },
    });
    const run = await runCli(['auth', 'status', '--check', '--json'], [() => myself('王五')]);
    const out = JSON.parse(run.stdout) as { check: { endpoint: string; user: string } };
    expect(out.check.endpoint).toBe('GET /v1/myself');
    expect(out.check.user).toBe('王五');
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe('auth logout', () => {
  it('clears only the active (user) slot by default, keeping the enterprise slot (R8)', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'user',
      userToken: { accessToken: 'ut', refreshToken: 'rt', expiresAtMs: EXPIRES, obtainedAtMs: NOW, kind: 'user' },
    });
    const run = await runCli(['auth', 'logout', '--json'], []);
    expect(run.exit).toBe(0);
    const cfg = readConfig();
    expect(cfg.userToken).toBeUndefined();
    expect((cfg.token as { accessToken?: string }).accessToken).toBe('test-token');
  });

  it('clears only the active (enterprise) slot by default', async () => {
    const run = await runCli(['auth', 'logout', '--json'], []);
    expect(run.exit).toBe(0);
    const cfg = readConfig();
    expect(cfg.token).toBeUndefined();
  });

  it('--all clears both token slots + authMode, keeping host (AC9, D14)', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'user',
      userToken: { accessToken: 'ut', refreshToken: 'rt', expiresAtMs: EXPIRES, obtainedAtMs: NOW, kind: 'user' },
    });
    const run = await runCli(['auth', 'logout', '--all', '--json'], []);
    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as { cleared: string[] };
    // Both slots + authMode are cleared; `host` is the one thing always kept.
    expect(out.cleared).toEqual(expect.arrayContaining(['token', 'user_token', 'auth_mode']));
    const cfg = readConfig();
    expect(cfg.token).toBeUndefined();
    expect(cfg.userToken).toBeUndefined();
    expect(cfg.authMode).toBeUndefined();
    expect(cfg.host).toBe('https://open.pingcode.com');
  });
});

// ---------------------------------------------------------------------------
// login — error / edge branches (no network)
// ---------------------------------------------------------------------------

describe('auth login — resolveMode / resolveChannel / requireClientId errors', () => {
  it('rejects an invalid --mode before any network call', async () => {
    const run = await runCli(['auth', 'login', '--mode', 'bogus', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('--mode must be');
    expect(run.calls).toHaveLength(0);
  });

  it('rejects an invalid --channel before printing the authorize URL or touching the network', async () => {
    const run = await runCli(['auth', 'login', '--mode', 'user', '--channel', 'bogus', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('--channel must be');
    // The authorize URL is printed only after the channel resolves, so it must be absent here.
    expect(run.stderr).not.toContain('oauth2/authorize');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses an empty --client-id in user mode (no authorize URL can be built)', async () => {
    // An empty string is a defined value, so the TTY prompt is skipped and
    // requireClientId rejects it client-side before any request.
    const run = await runCli(['auth', 'login', '--mode', 'user', '--client-id', '', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('no client id available');
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// login — human (non-json) output
// ---------------------------------------------------------------------------

describe('auth login — human output', () => {
  it('user login prints the field block to stdout and the authenticated note to stderr', async () => {
    loginHooks.captureCode = async () => ({ code: 'BROWSER-CODE' });
    const run = await runCli(['auth', 'login', '--mode', 'user'], [tokenUser, myself]);

    expect(run.exit).toBe(0);
    // Results (the field block) go to stdout.
    expect(run.stdout).toContain('host');
    expect(run.stdout).toContain('api base');
    expect(run.stdout).toContain('mode');
    expect(run.stdout).toContain('token expires');
    // The trailing status note goes to stderr, never stdout.
    expect(run.stderr).toContain('authenticated');
  });

  it('warns that the app credentials were not stored when they arrive by flag without --save', async () => {
    loginHooks.captureCode = async () => ({ code: 'BROWSER-CODE' });
    // Flag-supplied app creds, no --save, and no user slot on disk → not persisted.
    const run = await runCli(
      ['auth', 'login', '--mode', 'user', '--client-id', 'user-app-id', '--client-secret', 'user-app-secret'],
      [tokenUser, myself],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('not written to disk');
    expect(run.stderr).toContain('pass --save to store them');
  });

  it('enterprise login prints the projects-visible count in human mode', async () => {
    const run = await runCli(['auth', 'login', '--mode', 'enterprise'], [
      () => jsonResponse({ access_token: 'ent-tok', token_type: 'Bearer', expires_in: 3600 }),
      () => jsonResponse({ page_index: 0, page_size: 1, total: 7, values: [] }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('projects visible');
    expect(run.stdout).toContain('7');
    expect(run.stderr).toContain('authenticated');
  });

  it('enterprise login with --save persists the app credentials (storeId/storeSecret true branch)', async () => {
    // A flag-supplied client id has source 'flag', so --save drives shouldPersistSecret
    // to true and the patch writes clientId/clientSecret (the `if (storeId)` true branch).
    const run = await runCli(
      ['auth', 'login', '--mode', 'enterprise', '--client-id', 'ent-app', '--client-secret', 'ent-secret', '--save', '--json'],
      [
        () => jsonResponse({ access_token: 'ent-tok', token_type: 'Bearer', expires_in: 3600 }),
        () => jsonResponse({ page_index: 0, page_size: 1, total: 3, values: [] }),
      ],
    );
    expect(run.exit).toBe(0);
    const cfg = readConfig();
    expect(cfg.clientId).toBe('ent-app');
    expect(cfg.clientSecret).toBe('ent-secret');
  });
});

// ---------------------------------------------------------------------------
// status — human output & edges
// ---------------------------------------------------------------------------

describe('auth status — human output & edges', () => {
  it('human mode prints the field block and skips the live check by default', async () => {
    const run = await runCli(['auth', 'status'], []);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('auth mode');
    expect(run.stdout).toContain('client id');
    expect(run.stdout).toContain('live check');
    expect(run.stdout).toContain('skipped');
    // No live call is made without --check.
    expect(run.calls).toHaveLength(0);
  });

  it('--check verifies enterprise mode with listProjects and reports the project count', async () => {
    const run = await runCli(['auth', 'status', '--check', '--json'], [
      () => jsonResponse({ page_index: 0, page_size: 1, total: 7, values: [] }),
    ]);
    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as { check: { endpoint: string; projects_total: number } };
    expect(out.check.endpoint).toBe('GET /v1/pjm/projects?page_size=1');
    expect(out.check.projects_total).toBe(7);
  });

  it('reports a stale token as not fresh (token_fresh false)', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'enterprise',
      token: { accessToken: 'et', expiresAtMs: Date.now() - 1000, obtainedAtMs: NOW, kind: 'enterprise' },
    });
    const run = await runCli(['auth', 'status', '--json'], []);
    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as { token_present: boolean; token_fresh: boolean };
    expect(out.token_present).toBe(true);
    expect(out.token_fresh).toBe(false);
  });

  it('human mode renders a stale token with the re-acquire hint', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'enterprise',
      token: { accessToken: 'et', expiresAtMs: Date.now() - 1000, obtainedAtMs: NOW, kind: 'enterprise' },
    });
    const run = await runCli(['auth', 'status'], []);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('present but stale');
  });

  it('reports no token at all (token_present false, null expiry)', async () => {
    writeConfig({ host: 'https://open.pingcode.com', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const run = await runCli(['auth', 'status', '--json'], []);
    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as { token_present: boolean; token_expires_at: unknown };
    expect(out.token_present).toBe(false);
    expect(out.token_expires_at).toBeNull();
  });

  it('human mode shows the no-token guidance when there is no token', async () => {
    writeConfig({ host: 'https://open.pingcode.com', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const run = await runCli(['auth', 'status'], []);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('(none)');
    expect(run.stdout).toContain('run `pingcode auth login`');
  });

  it('--check human mode signs in as the user via /v1/myself', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'user',
      userToken: { accessToken: 'ut', refreshToken: 'rt', expiresAtMs: EXPIRES, obtainedAtMs: NOW, kind: 'user' },
    });
    const run = await runCli(['auth', 'status', '--check'], [() => myself('赵六')]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('signed in as 赵六');
    expect(run.stdout).toContain('GET /v1/myself');
  });

  it('--check human mode reports the enterprise project count', async () => {
    const run = await runCli(['auth', 'status', '--check'], [
      () => jsonResponse({ page_index: 0, page_size: 1, total: 7, values: [] }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('7 project(s) visible');
  });

  it('human mode shows the present user slot (with refresh token)', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'enterprise',
      userToken: { accessToken: 'ut', refreshToken: 'rt', expiresAtMs: EXPIRES, obtainedAtMs: NOW, kind: 'user' },
    });
    const run = await runCli(['auth', 'status'], []);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('present (with refresh token)');
  });
});

// ---------------------------------------------------------------------------
// logout — human output
// ---------------------------------------------------------------------------

describe('auth logout — human output', () => {
  it('default logout prints the cleared slots to stderr', async () => {
    const run = await runCli(['auth', 'logout'], []);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('cleared token, auth_mode, metadata_cache');
    const cfg = readConfig();
    expect(cfg.token).toBeUndefined();
  });

  it('--all logout prints both token slots as cleared', async () => {
    writeConfig({
      ...baseConfig(),
      authMode: 'user',
      userToken: { accessToken: 'ut', refreshToken: 'rt', expiresAtMs: EXPIRES, obtainedAtMs: NOW, kind: 'user' },
    });
    const run = await runCli(['auth', 'logout', '--all'], []);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('cleared token, user_token, auth_mode');
  });
});
