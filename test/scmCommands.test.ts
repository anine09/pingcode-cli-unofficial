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

// ---------------------------------------------------------------------------
// S1b: branches / commits / refs
// ---------------------------------------------------------------------------

const BRANCH = '6a706a6d39cbed1cf7126c22';
const COMMIT = '6a706a9a919cce9794f011a3';
const REF = '6a706ac439cbed1cf7126c2d';
/** A real 40-hex SHA — the one identifier this API shape-validates (design D12.2). */
const SHA = 'e35cc1ed300bfe85da6d6b8108ddb33d28b26ae5';

/** The response `resolveBranchRef` reads: `?name=` is exact, so a hit is one row. */
const branchesPage = (values: unknown[] = [{ id: BRANCH, name: 'feature/x', is_default: false }]) =>
  jsonResponse({ page_index: 0, page_size: 30, total: values.length, values });

describe('scm branch commands', () => {
  it('resolves --repo under --platform, then lists that repository’s branches', async () => {
    const run = await runCli(
      ['scm', 'branch', 'list', '--platform', 'Github', '--repo', 'code-interpreter', '--json'],
      [platformsPage, reposPage, () => branchesPage()],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[2]?.url).toContain(`/repositories/${REPO}/branches?`);
  });

  it('requires --repo, and says where to find one, before any request', async () => {
    const run = await runCli(['scm', 'branch', 'list', '--platform-id', PLATFORM], [platformsPage]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--repo <name|full_name|id> is required');
  });

  it('rejects --repo together with --repo-id', async () => {
    const run = await runCli(
      ['scm', 'branch', 'list', '--platform-id', PLATFORM, '--repo', 'x', '--repo-id', REPO],
      [platformsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('sends --repo-id verbatim, with no repository lookup at all', async () => {
    const run = await runCli(
      ['scm', 'branch', 'list', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [() => branchesPage()],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories/${REPO}/branches?`);
  });

  it('resolves a branch NAME through the exact ?name= filter, in one request', async () => {
    // Design D12.7: no metadata kind, no cache — one filtered list is the whole lookup,
    // because `?name=` is exact and branch names are unique per repository.
    const run = await runCli(
      ['scm', 'branch', 'get', 'feature/x', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [() => branchesPage(), () => jsonResponse({ id: BRANCH, name: 'feature/x' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('name=feature%2Fx');
    expect(run.calls[1]?.url).toContain(`/branches/${BRANCH}`);
  });

  it('passes an unmatched reference through as an id without validating its shape', async () => {
    // A miss is not an error: the server answers 100201 → exit 5 if it is not an id.
    const run = await runCli(
      ['scm', 'branch', 'get', 'not-a-branch-name', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [() => branchesPage([]), () => jsonResponse({ id: 'not-a-branch-name' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain('/branches/not-a-branch-name');
  });

  it('prints the request plan and sends nothing on a dry-run create', async () => {
    const run = await runCli(
      [
        'scm', 'branch', 'create',
        '--platform-id', PLATFORM, '--repo-id', REPO,
        '--name', 'feature/x', '--sender', 'bot',
        '--dry-run', '--json',
      ],
      [() => jsonResponse({ id: BRANCH })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as { request: { method: string; body: unknown } };
    expect(plan.request.method).toBe('POST');
    expect(plan.request.body).toEqual({ name: 'feature/x', sender_name: 'bot' });
  });

  it('only sends is_default when --default was passed', async () => {
    const bare = await runCli(
      ['scm', 'branch', 'create', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--name', 'a', '--sender', 'bot', '--json'],
      [() => jsonResponse({ id: BRANCH })],
    );
    expect(bare.writes[0]?.body).toEqual({ name: 'a', sender_name: 'bot' });

    const flagged = await runCli(
      ['scm', 'branch', 'create', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--name', 'a', '--sender', 'bot', '--default', '--json'],
      [() => jsonResponse({ id: BRANCH })],
    );
    expect(flagged.writes[0]?.body).toEqual({ name: 'a', sender_name: 'bot', is_default: true });
  });

  it('refuses `--default false`, which commander would otherwise read as --default', async () => {
    // Found live: commander silently discards an excess positional, so `--default false`
    // meant `--default true` — the exact inverse of the request. `--private true|false`
    // in the neighbouring `scm repo` subgroup is why a user would try this spelling.
    // Now enforced program-wide from `cli/program.ts`, not per leaf.
    const run = await runCli(
      ['scm', 'branch', 'update', 'feature/x', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--default', 'false'],
      [() => branchesPage()],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toEqual([]);
    expect(run.stderr).toContain('too many arguments');
  });

  it('refuses `--yes false` on delete, so a bad spelling cannot delete anything', async () => {
    // The bug this closes was reproduced against a live tenant: the branch was deleted.
    const run = await runCli(
      ['scm', 'branch', 'delete', 'feature/x', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--yes', 'false'],
      [() => branchesPage()],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toEqual([]);
    // Nothing at all is sent: the parse fails before the reference is even resolved.
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('too many arguments');
  });

  it('refuses an excess argument on a read leaf too, not just the dangerous ones', async () => {
    // S1b could only afford to guard its own three write leaves and left a note that the
    // laxity was program-wide; `scm platform get X EXTRA` was its example. Asserting a
    // read leaf here is what proves the fix moved to the tree-building site rather than
    // being re-scattered over the verbs that happen to own a bare boolean switch.
    const run = await runCli(
      ['scm', 'platform', 'get', 'Github', 'EXTRA'],
      [() => platformsPage()],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('too many arguments');
  });

  it('warns when the API silently dropped a work-item link, and still exits 0', async () => {
    // Design D12.4: an unknown identifier is ignored with a 200, so the response's
    // `work_items` is the only evidence. stdout must stay JSON-only.
    const run = await runCli(
      ['scm', 'branch', 'create', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--name', 'a', '--sender', 'bot',
       '--work-item', 'YYHC-10', '--work-item', 'NOSUCH-99999', '--json'],
      [() => jsonResponse({ id: BRANCH, work_items: [{ id: 'w1', identifier: 'YYHC-10' }] })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      name: 'a',
      sender_name: 'bot',
      work_item_identifiers: ['YYHC-10', 'NOSUCH-99999'],
    });
    expect(run.stderr).toContain('NOSUCH-99999');
    expect(run.stderr).not.toContain('YYHC-10');
    JSON.parse(run.stdout);
  });

  it('says nothing when every requested work item came back linked', async () => {
    const run = await runCli(
      ['scm', 'branch', 'create', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--name', 'a', '--sender', 'bot', '--work-item', 'YYHC-10', '--json'],
      [() => jsonResponse({ id: BRANCH, work_items: [{ id: 'w1', identifier: 'YYHC-10' }] })],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('refuses an empty branch patch before any request (exit 2)', async () => {
    const run = await runCli(
      ['scm', 'branch', 'update', 'feature/x', '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => branchesPage()],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('nothing to update');
  });

  it('names the resolved branch in the --yes refusal, not just the id (AC2)', async () => {
    const run = await runCli(
      ['scm', 'branch', 'delete', 'feature/x', '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => branchesPage()],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toEqual([]);
    expect(run.stderr).toContain('refusing to delete the branch "feature/x"');
    // And it warns about the consequence that is specific to this endpoint.
    expect(run.stderr).toContain('commit refs');
  });

  it('warns in the gate when the target is the undeletable default branch', async () => {
    const run = await runCli(
      ['scm', 'branch', 'delete', 'main', '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => branchesPage([{ id: BRANCH, name: 'main', is_default: true }])],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('default branch');
  });

  it('reads the branch to name it when the caller passed an id', async () => {
    const run = await runCli(
      ['scm', 'branch', 'delete', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => branchesPage([]), () => jsonResponse({ id: BRANCH, name: 'feature/from-id' })],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toEqual([]);
    expect(run.stderr).toContain('"feature/from-id"');
  });

  it('deletes with --yes and sends exactly one DELETE', async () => {
    const run = await runCli(
      ['scm', 'branch', 'delete', 'feature/x', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--yes', '--json'],
      [() => branchesPage(), () => jsonResponse({ id: BRANCH, name: 'feature/x' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.writes[0]?.url).toContain(`/branches/${BRANCH}`);
  });

  it('appends the way out when the server refuses to delete the default branch', async () => {
    // `100223` stays exit 7 (it is not an absence), but the message has to carry the
    // remedy: a `--json` error drops the hint, so an agent could not otherwise learn it.
    const run = await runCli(
      ['scm', 'branch', 'delete', 'main', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--yes', '--json'],
      [
        () => branchesPage([{ id: BRANCH, name: 'main', is_default: true }]),
        () => jsonResponse({ code: '100223', message: '默认分支不能被删除' }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(7);
    const error = JSON.parse(run.stderr) as { error: { message: string; code: string } };
    expect(error.error.code).toBe('100223');
    expect(error.error.message).toContain('scm branch update');
    expect(error.error.message).toContain('default');
  });

  it('has no --all on delete, so a bulk deletion cannot be spelled', async () => {
    const run = await runCli(
      ['scm', 'branch', 'delete', 'feature/x', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--yes', '--all'],
      [() => branchesPage()],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });
});

describe('scm commit commands', () => {
  it('takes no --platform: the endpoint is organisation-level', async () => {
    const run = await runCli(
      ['scm', 'commit', 'list', '--platform', 'Github'],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
    );
    // commander rejects the unknown option; nothing is sent.
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('lists commits with no platform segment in the URL', async () => {
    const run = await runCli(
      ['scm', 'commit', 'list', '--sha', SHA, '--json'],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [{ id: COMMIT, sha: SHA }] })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/commits?');
    expect(run.calls[0]?.url).not.toContain('/products/');
  });

  it('gets a commit by SHA, sending it verbatim and resolving nothing first (AC1)', async () => {
    const run = await runCli(
      ['scm', 'commit', 'get', SHA, '--json'],
      [() => jsonResponse({ id: COMMIT, sha: SHA })],
    );
    expect(run.exit).toBe(0);
    // Exactly one request: no lookup, no shape check, no id resolution.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toMatch(new RegExp(`/v1/scm/commits/${SHA}$`));
  });

  it('accepts a date for --committed-at and sends unix seconds', async () => {
    const run = await runCli(
      ['scm', 'commit', 'create', '--sha', SHA, '--message', 'feat: x', '--committer', 'bot',
       '--committed-at', '2026-08-03T10:00:00Z', '--json'],
      [() => jsonResponse({ id: COMMIT })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      sha: SHA,
      message: 'feat: x',
      committer_name: 'bot',
      committed_at: 1785751200,
      files_added: [],
      files_removed: [],
      files_modified: [],
    });
  });

  it('collects repeatable file flags into the three arrays', async () => {
    const run = await runCli(
      ['scm', 'commit', 'create', '--sha', SHA, '--message', 'm', '--committer', 'bot',
       '--committed-at', '1785751200',
       '--added', 'a.ts', '--added', 'b.ts', '--removed', 'c.ts', '--modified', 'd.ts', '--json'],
      [() => jsonResponse({ id: COMMIT })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toMatchObject({
      files_added: ['a.ts', 'b.ts'],
      files_removed: ['c.ts'],
      files_modified: ['d.ts'],
    });
  });

  it('refuses a non-date --committed-at before any request', async () => {
    const run = await runCli(
      ['scm', 'commit', 'create', '--sha', SHA, '--message', 'm', '--committer', 'bot',
       '--committed-at', 'yesterday'],
      [() => jsonResponse({ id: COMMIT })],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('warns about a dropped work-item link here too', async () => {
    const run = await runCli(
      ['scm', 'commit', 'create', '--sha', SHA, '--message', 'm', '--committer', 'bot',
       '--committed-at', '1785751200', '--work-item', 'NOSUCH-1', '--json'],
      [() => jsonResponse({ id: COMMIT, work_items: [] })],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('NOSUCH-1');
  });

  it('offers no update and no delete leaf, because upstream has neither', async () => {
    for (const verb of ['update', 'delete']) {
      const run = await runCli(['scm', 'commit', verb, COMMIT], []);
      expect(run.exit, verb).toBe(2);
      expect(run.calls, verb).toEqual([]);
    }
  });
});

describe('scm ref commands', () => {
  it('requires --branch-id on list, because the API requires meta_id', async () => {
    const run = await runCli(
      ['scm', 'ref', 'list', '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--branch-id');
  });

  it('always sends meta_type=branch, the only value the API accepts', async () => {
    const run = await runCli(
      ['scm', 'ref', 'list', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--branch-id', BRANCH, '--json'],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('meta_type=branch');
    expect(run.calls[0]?.url).toContain(`meta_id=${BRANCH}`);
  });

  it('creates a ref from --sha plus --branch-id', async () => {
    const run = await runCli(
      ['scm', 'ref', 'create', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--sha', SHA, '--branch-id', BRANCH, '--json'],
      [() => jsonResponse({ id: REF, meta: { id: BRANCH, name: 'feature/x', type: 'branch' } })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.body).toEqual({ sha: SHA, meta_type: 'branch', meta_id: BRANCH });
  });

  it('sends nothing on a dry-run ref create', async () => {
    const run = await runCli(
      ['scm', 'ref', 'create', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--sha', SHA, '--branch-id', BRANCH, '--dry-run', '--json'],
      [() => jsonResponse({ id: REF })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toEqual([]);
    expect(JSON.parse(run.stdout)).toMatchObject({ dry_run: true });
  });

  it('surfaces a missing commit on ref create as exit 5, naming the absent row', async () => {
    const run = await runCli(
      ['scm', 'ref', 'create', '--platform-id', PLATFORM, '--repo-id', REPO,
       '--sha', SHA, '--branch-id', BRANCH, '--json'],
      [() => jsonResponse({ code: '100206', message: "'commit'资源不存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; code: string } };
    expect(error.error).toMatchObject({ kind: 'not_found', code: '100206' });
  });

  it('offers no ref update and no ref delete leaf', async () => {
    for (const verb of ['update', 'delete']) {
      const run = await runCli(['scm', 'ref', verb, REF, '--platform-id', PLATFORM], []);
      expect(run.exit, verb).toBe(2);
      expect(run.calls, verb).toEqual([]);
    }
  });
});
