import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureOutput } from '../src/cli/output';
import { buildProgram } from '../src/cli/program';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { DryRunHalt, exitCodeFor } from '../src/core/errors';
import { createFakeFetch, jsonResponse, type FakeCall } from './helpers/fake';

/**
 * S1a: the scm command layer end to end, with `fetch` replaced at the global
 * boundary and the config directory redirected to a temp dir. No network, no real
 * credentials.
 *
 * What is proven here and cannot be proven at the api layer:
 *  - `--json` keeps **stdout JSON-only**, with tables, notices and errors on stderr;
 *  - `--dry-run` on a write prints `{"dry_run":true,"request":{…}}` on stdout and
 *    sends **zero** mutating requests;
 *  - every flag refusal (missing `--platform`, `--platform` with `--platform-id`, an
 *    empty patch, a non-boolean `--private`) happens **before** any request goes out;
 *  - `--platform <name>` and `<repo>` really do resolve through `core/metadata`, so
 *    the id that reaches the URL came from the list rather than from the user.
 */

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-scm-cmd-'));
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      clientId: 'test-client',
      clientSecret: 'test-secret',
      token: {
        accessToken: 'test-token',
        expiresAtMs: Date.now() + THIRTY_DAYS_MS,
        obtainedAtMs: Date.now(),
      },
    }),
    { mode: 0o600 },
  );
  previousConfigDir = process.env.PINGCODE_CONFIG_DIR;
  process.env.PINGCODE_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.PINGCODE_CONFIG_DIR;
  else process.env.PINGCODE_CONFIG_DIR = previousConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

type CliRun = {
  stdout: string;
  stderr: string;
  exit: number;
  calls: FakeCall[];
  /** Only the requests that would change server state. */
  writes: FakeCall[];
};

/** Run one `pingcode …` invocation exactly as `bin/pingcode.ts` does. */
async function runCli(argv: string[], responses: Array<() => Response>): Promise<CliRun> {
  const fake = createFakeFetch(responses);
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
  // `core/logger.ts` writes straight to process.stderr, bypassing captureOutput.
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch as unknown as typeof globalThis.fetch;

  let exit = 0;
  try {
    const program = buildProgram();
    await program.parseAsync(['node', 'pingcode', ...argv]);
  } catch (error) {
    if (error instanceof DryRunHalt) {
      const { printDryRun } = await import('../src/cli/output');
      printDryRun(error.plan, { json: argv.includes('--json') });
      exit = 0;
    } else if (error instanceof CommanderError) {
      exit = error.exitCode === 0 ? 0 : 2;
    } else {
      const { printError } = await import('../src/cli/output');
      printError(error, { json: argv.includes('--json') });
      exit = exitCodeFor(error);
    }
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realStderrWrite;
    restoreOutput();
  }

  const writes = fake.calls.filter((call) =>
    ['POST', 'PATCH', 'PUT', 'DELETE'].includes(call.method),
  );
  return { stdout, stderr, exit, calls: fake.calls, writes };
}

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const REPO = '685d393c47512a5d5d52aa70';

const platformsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: PLATFORM, name: 'Github', type: 'github' },
      { id: 'p2', name: 'GitHub Enterprise', type: 'github' },
    ],
  });

const reposPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [
      {
        id: REPO,
        name: 'code-interpreter',
        full_name: 'acme/code-interpreter',
        is_private: true,
        is_fork: false,
        owner: { id: 'u1', name: 'acme' },
      },
    ],
  });

describe('scm platform commands', () => {
  it('lists platforms as a table on stdout with the row count on stderr', async () => {
    const run = await runCli(['scm', 'platform', 'list'], [platformsPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('Github');
    expect(run.stdout).toContain('github');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(['scm', 'platform', 'list', '--json'], [platformsPage]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { total: number; values: { name: string }[] };
    expect(parsed.total).toBe(2);
    expect(parsed.values[0]?.name).toBe('Github');
  });

  it('resolves a platform name to an id before the GET', async () => {
    const run = await runCli(
      ['scm', 'platform', 'get', 'github', '--json'],
      [platformsPage, () => jsonResponse({ id: PLATFORM, name: 'Github' })],
    );
    expect(run.exit).toBe(0);
    // First call is the candidate list, second the resolved resource.
    expect(run.calls[1]?.url).toContain(`/v1/scm/products/${PLATFORM}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: PLATFORM });
  });

  it('prints the request plan and sends nothing on a dry-run create', async () => {
    const run = await runCli(
      ['scm', 'platform', 'create', '--name', 'Gitea', '--type', 'other', '--dry-run', '--json'],
      [() => jsonResponse({ id: 'new' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/scm/products');
    expect(plan.request.body).toEqual({ name: 'Gitea', type: 'other' });
  });

  it('refuses an empty patch before any request (exit 2)', async () => {
    const run = await runCli(['scm', 'platform', 'update', 'Github'], [platformsPage]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('nothing to update');
  });

  it('writes the --json error to stderr and leaves stdout empty', async () => {
    const run = await runCli(['scm', 'platform', 'get', 'gitlab', '--json'], [platformsPage]);
    expect(run.exit).toBe(2);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'usage', exit: 2 });
  });
});

describe('scm platform-user commands', () => {
  it('requires --platform, and says why, before any request', async () => {
    const run = await runCli(['scm', 'platform-user', 'list'], [platformsPage]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('rejects --platform together with --platform-id', async () => {
    const run = await runCli(
      ['scm', 'platform-user', 'list', '--platform', 'Github', '--platform-id', PLATFORM],
      [platformsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('sends --platform-id verbatim, with no lookup at all', async () => {
    const run = await runCli(
      ['scm', 'platform-user', 'list', '--platform-id', PLATFORM, '--name', 'bot', '--json'],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/users?`);
    expect(run.calls[0]?.url).toContain('name=bot');
  });

  it('creates a git identity with only the documented fields', async () => {
    const run = await runCli(
      [
        'scm',
        'platform-user',
        'create',
        '--platform-id',
        PLATFORM,
        '--name',
        'bot',
        '--display-name',
        'Bot',
        '--json',
      ],
      [() => jsonResponse({ id: 'u-new', name: 'bot', display_name: 'Bot' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toEqual({ name: 'bot', display_name: 'Bot' });
  });

  it('refuses an empty identity patch (exit 2)', async () => {
    const run = await runCli(
      ['scm', 'platform-user', 'update', 'u1', '--platform-id', PLATFORM],
      [platformsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });
});

describe('scm repo commands', () => {
  it('resolves a repository name under the platform, then GETs it by id', async () => {
    const run = await runCli(
      [
        'scm',
        'repo',
        'get',
        'code-interpreter',
        '--platform-id',
        PLATFORM,
        '--json',
      ],
      [reposPage, () => jsonResponse({ id: REPO, full_name: 'acme/code-interpreter' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}`);
  });

  it('sends is_private: false rather than dropping it', async () => {
    // A repository going public is a real update; a flag that could only ever mean
    // `true` would make it unexpressible.
    const run = await runCli(
      [
        'scm',
        'repo',
        'update',
        'code-interpreter',
        '--platform-id',
        PLATFORM,
        '--private',
        'false',
        '--json',
      ],
      [reposPage, () => jsonResponse({ id: REPO, is_private: false })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.body).toEqual({ is_private: false });
  });

  it('refuses a non-boolean --private before any request (exit 2)', async () => {
    const run = await runCli(
      ['scm', 'repo', 'update', 'code-interpreter', '--platform-id', PLATFORM, '--private', 'maybe'],
      [reposPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('true|false');
  });

  it('keeps a url template intact through create, braces and all', async () => {
    const run = await runCli(
      [
        'scm',
        'repo',
        'create',
        '--platform-id',
        PLATFORM,
        '--name',
        'cli',
        '--full-name',
        'acme/cli',
        '--commits-url',
        'https://github.com/acme/cli/commit/{sha}',
        '--json',
      ],
      [() => jsonResponse({ id: 'r-new' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      name: 'cli',
      full_name: 'acme/cli',
      commits_url: 'https://github.com/acme/cli/commit/{sha}',
    });
  });

  it('does not offer a --name filter on list, because upstream ignores it', async () => {
    const run = await runCli(
      ['scm', 'repo', 'list', '--platform-id', PLATFORM, '--name', 'cli'],
      [reposPage],
    );
    // commander rejects the unknown option; nothing is sent.
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });
});
