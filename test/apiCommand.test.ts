import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerApiCommands } from '../src/cli/commands/api';
import { addGlobalOptions } from '../src/cli/globals';
import { captureOutput } from '../src/cli/output';
import { HELP_WIDTH } from '../src/cli/program';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { CATALOG, type CatalogEntry } from '../src/core/catalog';
import { DryRunHalt, exitCodeFor } from '../src/core/errors';
import { REDACTED } from '../src/core/redact';
import { createFakeFetch, emptyResponse, jsonResponse, type FakeCall } from './helpers/fake';

/**
 * `pingcode api …` end to end, with `fetch` replaced at the global boundary and the
 * config directory redirected to a temp dir. No network, no real credentials.
 *
 * Three things are proven here that cannot be proven anywhere else:
 *
 *  1. **All 459 catalog endpoints are callable** — every write produces a `--dry-run`
 *     plan with a parseable, placeholder-free, secret-free URL; every read produces
 *     one legal request; the seven user-token endpoints are refused with exit 2
 *     *before* any IO. That sweep is the PRD's "完全体可达" acceptance.
 *  2. **The pre-flight checks of design D3.2** — unknown path with suggestions, the
 *     `authorize` page, a wrong method listing the methods the path does support,
 *     named missing fields, the user-token refusal and the `--yes` gate. Each is
 *     exit 2 with zero requests.
 *  3. **The generic layer inherits, rather than reimplements, the transport's
 *     behaviour (design D3.5)** — dry-run refusal, redaction, the single 401 replay,
 *     the 429 wait, and the exit-code mapping all show up here without this layer
 *     containing a line of code for any of them.
 */

const CLIENT_SECRET = 'SECRET-must-never-be-printed';
const ACCESS_TOKEN = 'TOKEN-must-never-be-printed';

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-api-cmd-'));
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      clientId: 'test-client',
      clientSecret: CLIENT_SECRET,
      token: {
        accessToken: ACCESS_TOKEN,
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

/** A root program carrying only the `api` group, so this file does not depend on the others. */
function buildApiProgram(): Command {
  const program = new Command();
  program
    .name('pingcode')
    .configureHelp({ helpWidth: HELP_WIDTH })
    .showHelpAfterError()
    // Mirrors `buildProgram()`. Root settings reach every leaf through commander's
    // `copyInheritedSettings`, so a root this harness builds by hand has to carry the
    // same ones or it tests a tree the CLI never runs — `api DELETE <path> --yes false`
    // passed here while the real program refused it.
    .allowExcessArguments(false)
    .exitOverride();
  addGlobalOptions(program);
  registerApiCommands(program);
  return program;
}

type CliRun = {
  stdout: string;
  stderr: string;
  exit: number;
  calls: FakeCall[];
};

/** Run one `pingcode api …` invocation exactly as `bin/pingcode.ts` does. */
async function runCli(argv: string[], responses: Array<() => Response> = []): Promise<CliRun> {
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
    await buildApiProgram().parseAsync(['node', 'pingcode', ...argv]);
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

  return { stdout, stderr, exit, calls: fake.calls };
}

const page = (values: unknown[] = [], pageIndex = 0, pageSize = 30) => () =>
  jsonResponse({ page_index: pageIndex, page_size: pageSize, total: values.length, values });

const object = (body: unknown) => () => jsonResponse(body);

function parseStdout(run: CliRun): unknown {
  expect(run.stdout.trim(), `stdout was not JSON:\n${run.stdout}`).not.toBe('');
  return JSON.parse(run.stdout) as unknown;
}

function urlOf(run: CliRun, index = 0): URL {
  return new URL(run.calls[index]?.url ?? 'https://x.invalid/');
}

// ---------------------------------------------------------------------------
// 1. pre-flight refusals: exit 2, before any network IO (design D3.2)
// ---------------------------------------------------------------------------

describe('the catalog answers before anything is sent (design D3.2)', () => {
  it('rejects an unknown path with the nearest documented paths', async () => {
    const run = await runCli(['api', 'GET', '/v1/pjm/projekts']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('not in the endpoint catalog');
    expect(run.stderr).toContain('did you mean');
    expect(run.stderr).toContain('/v1/pjm/projects');
  });

  it('suggests the right template when a segment is misspelled next to an id', async () => {
    const run = await runCli(['api', 'GET', '/v1/pjm/projects/abc/sprint']);
    expect(run.exit).toBe(2);
    // `{project_id}` costs nothing because it matches any value, so the ranking is
    // decided by `sprint` vs `sprints` alone.
    expect(run.stderr).toContain('/v1/pjm/projects/{project_id}/sprints');
  });

  it('explains that {oauth2_root}/authorize is a browser page, not an endpoint', async () => {
    const run = await runCli(['api', 'GET', '/oauth2/authorize']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('browser authorization page');
    expect(run.stderr).toContain('not a REST endpoint');
    // and it must not pretend this is a typo
    expect(run.stderr).not.toContain('did you mean');
  });

  it('lists the methods a path really supports when the verb is wrong', async () => {
    // [S§3.8.1]: there is no project delete on this API, by design.
    const run = await runCli(['api', 'DELETE', '/v1/pjm/projects/abc', '--yes']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('DELETE /v1/pjm/projects/abc is not a documented endpoint');
    expect(run.stderr).toContain('that path supports GET, PATCH');
  });

  it('names the missing required fields instead of forwarding a 400', async () => {
    const run = await runCli(['api', 'GET', '/v1/relations']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('missing required field(s)');
    expect(run.stderr).toContain('principal_type (query)');
    expect(run.stderr).toContain('principal_id (query)');
  });

  it('refuses the seven user-token endpoints before any IO (design D8.5)', async () => {
    for (const target of [
      ['GET', '/v1/myself'],
      ['GET', '/v1/permission/my/global'],
      ['POST', '/v1/permission/check/global'],
    ] as const) {
      const run = await runCli(['api', ...target]);
      expect(run.exit, target.join(' ')).toBe(2);
      expect(run.calls, target.join(' ')).toHaveLength(0);
      expect(run.stderr).toContain('用户令牌');
    }
  });

  it('still allows the token-less endpoints (an absent tokenType is not "unknown")', async () => {
    // The three `GET /v1/auth/token` grants carry no tokenType at all, which means
    // "needs no token" — refusing them because the field is undefined would be a bug.
    const run = await runCli(
      [
        'api',
        'GET',
        '/v1/auth/token',
        '--query',
        'grant_type=client_credentials',
        '--query',
        'client_id=test-client',
        '--query',
        `client_secret=${CLIENT_SECRET}`,
      ],
      [object({ access_token: 'x', expires_in: 1 })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
  });

  it('refuses a DELETE without --yes, and names what it would have sent', async () => {
    const run = await runCli([
      'api',
      'DELETE',
      '/v1/comments/c1',
      '--query',
      'principal_type=work_item',
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('without --yes');
    expect(run.stderr).toContain('/v1/comments/c1?principal_type=work_item');
  });

  it('refuses `--yes false` on a DELETE, so a bad spelling cannot delete anything', async () => {
    // `api DELETE` is the single door onto all 49 documented DELETE endpoints, so the
    // `--yes` gate here is the danger surface of the whole passthrough. commander used
    // to discard the excess `false` and read the switch as set, which inverted the
    // user's meaning and sent the request. `<path>` is this leaf's only positional, so
    // `allowExcessArguments(false)` on the root program refuses the second one.
    const run = await runCli(['api', 'DELETE', '/v1/comments/c1', '--yes', 'false']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('too many arguments');
  });

  it('refuses a path that still carries a placeholder or a query string', async () => {
    const placeholder = await runCli(['api', 'GET', '/v1/pjm/projects/{project_id}']);
    expect(placeholder.exit).toBe(2);
    expect(placeholder.stderr).toContain('{project_id}');
    expect(placeholder.calls).toHaveLength(0);

    const queryInPath = await runCli(['api', 'GET', '/v1/relations?principal_type=work_item']);
    expect(queryInPath.exit).toBe(2);
    expect(queryInPath.stderr).toContain('must not carry a query string');
    expect(queryInPath.calls).toHaveLength(0);
  });

  it('refuses paging flags on an endpoint that is not a collection', async () => {
    const run = await runCli(['api', 'GET', '/v1/pjm/projects/abc', '--page', '2']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('is not a paged collection');
  });

  it('refuses two body sources at once', async () => {
    const run = await runCli([
      'api',
      'POST',
      '/v1/comments',
      '--set',
      'content=hi',
      '--body',
      '{"content":"hi"}',
    ]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('mutually exclusive');
    expect(run.calls).toHaveLength(0);
  });

  it('reports an unparseable --body as usage, not as a transport failure', async () => {
    const run = await runCli(['api', 'POST', '/v1/comments', '--body', '{nope']);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('not valid JSON');
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. the passthrough itself
// ---------------------------------------------------------------------------

describe('the executor is a pipe: raw JSON out, nothing added to the request', () => {
  it('prints the response body verbatim, and --json changes nothing', async () => {
    const body = { id: 'w1', title: '登录接口超时', extra: { unknown_field: [1, 2, 3] } };
    const plain = await runCli(['api', 'GET', '/v1/pjm/work_items/w1'], [object(body)]);
    const json = await runCli(['api', 'GET', '/v1/pjm/work_items/w1', '--json'], [object(body)]);

    expect(plain.exit).toBe(0);
    expect(parseStdout(plain)).toEqual(body);
    // Byte-identical: `--json` is a no-op on the verbs, which is the whole reason this
    // layer is agent-safe by construction (no table, no local time, no column clipping).
    expect(json.stdout).toBe(plain.stdout);
  });

  it('sends the query parameters verbatim and repeats a key as CSV', async () => {
    const run = await runCli(
      [
        'api',
        'GET',
        '/v1/directory/users',
        '--query',
        'department_ids=d1',
        '--query',
        'department_ids=d2',
        '--query',
        'keywords=李',
      ],
      [page([])],
    );
    expect(run.exit).toBe(0);
    const url = urlOf(run);
    expect(url.pathname).toBe('/v1/directory/users');
    expect(url.searchParams.get('department_ids')).toBe('d1,d2');
    expect(url.searchParams.get('keywords')).toBe('李');
  });

  it('adds no paging parameters unless a paging flag was typed', async () => {
    const bare = await runCli(['api', 'GET', '/v1/directory/users'], [page([])]);
    expect(urlOf(bare).search).toBe('');

    const paged = await runCli(
      ['api', 'GET', '/v1/directory/users', '--page', '2', '--page-size', '100'],
      [page([])],
    );
    const url = urlOf(paged);
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('100');
  });

  it('enforces the API page-size cap before sending', async () => {
    const run = await runCli(['api', 'GET', '/v1/directory/users', '--page-size', '101']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('walks pages with --all and prints {values,count,all}', async () => {
    const run = await runCli(
      ['api', 'GET', '/v1/directory/users', '--all', '--page-size', '2'],
      [
        page([{ id: 'u1' }, { id: 'u2' }], 0, 2),
        page([{ id: 'u3' }], 1, 2), // short page ⇒ the end
      ],
    );
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toEqual({
      values: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
      count: 3,
      all: true,
    });
    expect(run.calls).toHaveLength(2);
  });

  it('sends --set values verbatim, with no type guessing', async () => {
    const run = await runCli(
      [
        'api',
        'POST',
        '/v1/comments',
        '--set',
        'principal_type=work_item',
        '--set',
        'principal_id=w1',
        '--set',
        'content=CI #123 failed',
      ],
      [object({ id: 'c1' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.body).toEqual({
      principal_type: 'work_item',
      principal_id: 'w1',
      content: 'CI #123 failed',
    });
  });

  it('sends a --body-file body as-is, nested structures included', async () => {
    const file = path.join(dir, 'body.json');
    writeFileSync(
      file,
      JSON.stringify({ ids: ['w1', 'w2'], property_name: 'sprint_id', property_value: 's1' }),
    );
    const run = await runCli(
      ['api', 'PATCH', '/v1/pjm/work_items', '--body-file', file],
      [object({ total: 2 })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.method).toBe('PATCH');
    expect(run.calls[0]?.body).toEqual({
      ids: ['w1', 'w2'],
      property_name: 'sprint_id',
      property_value: 's1',
    });
  });

  it('reports a missing --body-file as usage', async () => {
    const run = await runCli([
      'api',
      'PATCH',
      '/v1/pjm/work_items',
      '--body-file',
      path.join(dir, 'nope.json'),
    ]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('could not be read');
    expect(run.calls).toHaveLength(0);
  });

  it('says so on stdout-free 2xx bodies instead of inventing JSON', async () => {
    const run = await runCli(
      ['api', 'DELETE', '/v1/pjm/projects/p1/versions/v1', '--yes'],
      [() => emptyResponse(204)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('empty response body');
  });

  it('routes a POST …/search through core/paginate, cursor in the payload', async () => {
    const run = await runCli(
      [
        'api',
        'POST',
        '/v1/pjm/work_items/search',
        '--body',
        '{"mode":"query","payload":{"keywords":"login"}}',
        '--page-size',
        '2',
      ],
      [page([{ id: 'w1' }], 0, 2)],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.body).toEqual({
      mode: 'query',
      payload: { keywords: 'login', page_index: 0, page_size: 2 },
    });
    expect(parseStdout(run)).toEqual({
      page_index: 0,
      page_size: 2,
      total: 1,
      values: [{ id: 'w1' }],
    });
  });

  it('runs a search even under --dry-run (it is a read wearing a POST)', async () => {
    const run = await runCli(
      [
        'api',
        'POST',
        '/v1/pjm/work_items/search',
        '--body',
        '{"mode":"query","payload":{}}',
        '--dry-run',
      ],
      [page([{ id: 'w1' }])],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.stdout).toContain('"values"');
  });

  it('refuses a search body that is not {mode:"query", payload:{…}}', async () => {
    const run = await runCli([
      'api',
      'POST',
      '/v1/pjm/work_items/search',
      '--set',
      'mode=query',
      '--set',
      'payload=oops',
    ]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('"payload" object');
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. inherited transport behaviour (design D3.5) — none of it is coded here
// ---------------------------------------------------------------------------

describe('everything the transport already does is inherited, not reimplemented', () => {
  it('halts every write under --dry-run and prints a redacted plan', async () => {
    const run = await runCli([
      'api',
      'DELETE',
      '/v1/wiki/pages/p1',
      '--yes',
      '--dry-run',
      '--json',
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(0);
    const plan = parseStdout(run) as {
      dry_run: boolean;
      request: { method: string; url: string; headers: Record<string, string> };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('DELETE');
    expect(new URL(plan.request.url).pathname).toBe('/v1/wiki/pages/p1');
    expect(plan.request.headers.Authorization).toBe(REDACTED);
    expect(run.stdout).not.toContain(ACCESS_TOKEN);
  });

  it('redacts client_secret out of the verbose log of a token request', async () => {
    const run = await runCli(
      [
        'api',
        'GET',
        '/v1/auth/token',
        '--query',
        'grant_type=client_credentials',
        '--query',
        'client_id=test-client',
        '--query',
        `client_secret=${CLIENT_SECRET}`,
        '--verbose',
      ],
      [object({ access_token: 'x' })],
    );
    expect(run.exit).toBe(0);
    // The secret travels in the **query string** on this API, which is exactly why
    // every printing path goes through `redactUrl`.
    expect(run.stderr).toContain(REDACTED);
    expect(run.stderr).not.toContain(CLIENT_SECRET);
  });

  it('replays a 401 exactly once, after re-acquiring the token', async () => {
    const run = await runCli(
      ['api', 'GET', '/v1/pjm/work_items/w1'],
      [
        () => jsonResponse({ code: '100010', message: 'unauthorized' }, { status: 401 }),
        () => jsonResponse({ access_token: 'fresh-token', expires_in: 2_592_000 }),
        object({ id: 'w1' }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/pjm/work_items/w1',
      '/v1/auth/token',
      '/v1/pjm/work_items/w1',
    ]);
  });

  it('waits once for x-pc-retry-after on a 429, then succeeds', async () => {
    const run = await runCli(
      ['api', 'GET', '/v1/pjm/work_items/w1'],
      [
        () =>
          jsonResponse(
            { code: '100002', message: 'too many requests' },
            // `0` keeps the suite fast; what is under test is that the header is read
            // and the request replayed once, not the length of the nap.
            { status: 429, headers: { 'x-pc-retry-after': '0' } },
          ),
        object({ id: 'w1' }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.stderr).toContain('rate limited');
  });

  it('maps a 403 to exit 4 and appends the scope the docs declare (design D3.3)', async () => {
    const run = await runCli(
      ['api', 'PATCH', '/v1/build/builds/b1', '--set', 'status=success'],
      [() => jsonResponse({ code: '100003', message: '无权限' }, { status: 403 })],
    );
    expect(run.exit).toBe(4);
    expect(run.stderr).toContain('pcp:write:devops:build');
    expect(run.stderr).toContain('403');
  });

  it('says so when the docs declare no scope at all, rather than inventing one', async () => {
    const run = await runCli(
      ['api', 'GET', '/v1/relations/r1'],
      [() => jsonResponse({ code: '100003', message: '无权限' }, { status: 403 })],
    );
    expect(run.exit).toBe(4);
    expect(run.stderr).toContain('declares no scope in the docs');
  });

  it('keeps the code-override mapping: a 400 with 100317 is exit 5', async () => {
    const run = await runCli(
      ['api', 'GET', '/v1/pjm/work_items/w1'],
      [() => jsonResponse({ code: '100317', message: '工作项不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 4. discovery (design D3.6)
// ---------------------------------------------------------------------------

describe('api list', () => {
  async function count(argv: string[]): Promise<{ rows: number; tableRows: number }> {
    const json = await runCli(['api', 'list', ...argv, '--json']);
    expect(json.exit, json.stderr).toBe(0);
    const payload = parseStdout(json) as { values: unknown[]; count: number };
    expect(payload.values).toHaveLength(payload.count);

    const table = await runCli(['api', 'list', ...argv]);
    expect(table.exit).toBe(0);
    // one header line plus one line per endpoint
    const lines = table.stdout.trimEnd().split('\n');
    return { rows: payload.count, tableRows: lines.length - 1 };
  }

  it('never touches the network', async () => {
    const run = await runCli(['api', 'list', '--module', 'build']);
    expect(run.calls).toHaveLength(0);
  });

  it('enumerates the whole catalog by default', async () => {
    const { rows, tableRows } = await count([]);
    expect(rows).toBe(459);
    expect(tableRows).toBe(459);
  });

  it('counts the four facets the acceptance criteria name', async () => {
    // scm 36, pjm 145, ENT-only 61, PUT 10 — the last two are the interesting ones:
    // the 61 are what only a machine identity can call (and this CLI holds exactly
    // that token), and the 10 PUTs are permanently generic-layer-only (design D8.4).
    expect((await count(['--module', 'scm'])).rows).toBe(36);
    expect((await count(['--module', 'pjm'])).rows).toBe(145);
    expect((await count(['--token', 'ENT'])).rows).toBe(61);
    expect((await count(['--method', 'PUT'])).rows).toBe(10);
  });

  it('also counts the danger surface and the token-less grants', async () => {
    expect((await count(['--method', 'DELETE'])).rows).toBe(49);
    expect((await count(['--token', 'USER'])).rows).toBe(7);
    expect((await count(['--token', 'NONE'])).rows).toBe(3);
  });

  it('matches --search over path, title and group', async () => {
    const byPath = await runCli(['api', 'list', '--search', 'scm/commits', '--json']);
    const values = (parseStdout(byPath) as { values: CatalogEntry[] }).values;
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((entry) => entry.path.includes('scm/commits'))).toBe(true);

    const byTitle = await runCli(['api', 'list', '--search', '构建记录', '--json']);
    expect((parseStdout(byTitle) as { count: number }).count).toBe(6);
  });

  it('combines filters', async () => {
    const run = await runCli([
      'api',
      'list',
      '--module',
      'build',
      '--method',
      'GET',
      '--token',
      'ENT',
      '--json',
    ]);
    expect((parseStdout(run) as { count: number }).count).toBe(2);
  });

  it('refuses a typo instead of returning zero rows', async () => {
    for (const argv of [
      ['--module', 'pmj'],
      ['--method', 'HEAD'],
      ['--token', 'BEARER'],
    ]) {
      const run = await runCli(['api', 'list', ...argv]);
      expect(run.exit, argv.join(' ')).toBe(2);
    }
  });

  it('emits catalog entries verbatim in --json', async () => {
    const run = await runCli(['api', 'list', '--search', '/v1/build/builds', '--json']);
    const values = (parseStdout(run) as { values: CatalogEntry[] }).values;
    const create = values.find((entry) => entry.id === 'build.builds.create');
    expect(create).toEqual(CATALOG.find((entry) => entry.id === 'build.builds.create'));
  });
});

describe('api describe', () => {
  it('describes by id, without a request', async () => {
    const run = await runCli(['api', 'describe', 'scm.commits.get']);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(0);
    expect(run.stdout).toContain('GET /v1/scm/commits/{commit_id_or_sha}');
    expect(run.stdout).toContain('pcp:read:devops:code');
    expect(run.stdout).toContain('企业令牌 only');
  });

  it('describes by method + path, through the same wildcard rules', async () => {
    const run = await runCli(['api', 'describe', 'GET', '/v1/scm/commits/9f3c1ab']);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('scm.commits.get');
  });

  it('prints the documented fields, marking the required ones', async () => {
    const run = await runCli(['api', 'describe', 'relations.create']);
    expect(run.stdout).toMatch(/body/);
    expect(run.stdout).toMatch(/\(required\)/);
  });

  it('warns that PUT is a full replacement (design D8.4)', async () => {
    const run = await runCli(['api', 'describe', 'build.builds.replace']);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('full replacement');
    expect(run.stderr).toContain('Use PATCH');
  });

  it('warns that a user-token endpoint is unreachable here', async () => {
    const run = await runCli(['api', 'describe', 'myself.get']);
    expect(run.stderr).toContain('user-token-only');
  });

  it('names the other grants when three entries share GET /v1/auth/token', async () => {
    const run = await runCli(['api', 'describe', 'GET', '/v1/auth/token']);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('entries share GET /v1/auth/token');
    expect(run.stderr).toContain('auth.token.client_credentials');
  });

  it('suggests near ids for an unknown one', async () => {
    const run = await runCli(['api', 'describe', 'scm.commit.get']);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('did you mean');
    expect(run.stderr).toContain('scm.commits.get');
  });

  it('emits the catalog entry verbatim in --json', async () => {
    const run = await runCli(['api', 'describe', 'scm.commits.get', '--json']);
    expect(parseStdout(run)).toEqual(CATALOG.find((entry) => entry.id === 'scm.commits.get'));
  });
});

// ---------------------------------------------------------------------------
// 5. the acceptance sweep: all 459 endpoints (PRD A3, "完全体可达")
// ---------------------------------------------------------------------------

/**
 * The whole catalog, one invocation per entry.
 *
 * Each entry is classified once, and the classification *is* the contract:
 *
 *  - `tokenType === 'USER'` (7) — refused with exit 2 and **zero** fetch calls, so
 *    the refusal provably precedes any network IO;
 *  - `paged === 'search'` (5) — a read wearing a POST: it executes (even though
 *    `--dry-run` is not passed for it here) and its URL must be legal;
 *  - every other write (201) — `--dry-run` must produce a `DryRunHalt` plan whose
 *    URL parses, contains no `{placeholder}`, and leaks neither the client secret
 *    nor the access token; nothing may be sent;
 *  - every other read (246) — must produce exactly one legal request whose path is
 *    the substituted path.
 *
 * 7 + 5 + 201 + 246 = 459. The arithmetic is asserted, so an entry that stops being
 * classifiable (a sixth search endpoint, an eighth user-token endpoint) fails here
 * rather than silently dropping out of the sweep.
 */
describe('all 459 documented endpoints are callable (PRD A3)', () => {
  const PLACEHOLDER_RE = /\{([^}]+)\}/g;

  function substitute(pathTemplate: string): string {
    return pathTemplate.replace(PLACEHOLDER_RE, (_match, name: string) => `id-${name}`);
  }

  function argvFor(entry: CatalogEntry): string[] {
    const argv = [entry.method, substitute(entry.path)];

    for (const param of entry.query) {
      if (param.required) argv.push('--query', `${param.name}=sample-${param.name}`);
    }

    if (entry.paged === 'search') {
      // The documented body of the five search endpoints is `{mode, payload}`, and
      // `--set` cannot express a nested object — which is what `--body` is for.
      argv.push('--body', '{"mode":"query","payload":{}}');
    } else {
      for (const param of entry.body) {
        // Nested apiDoc fields (`updates[].id`) have no top-level presence to satisfy.
        if (param.required && !param.name.includes('.')) {
          argv.push('--set', `${param.name}=sample-${param.name}`);
        }
      }
    }

    if (entry.method === 'DELETE') argv.push('--yes');
    return argv;
  }

  it(
    'every entry is either callable or refused for a documented reason',
    async () => {
      const failures: string[] = [];
      const counts = { user: 0, search: 0, write: 0, read: 0 };

      for (const entry of CATALOG) {
        const label = `${entry.id} (${entry.method} ${entry.path})`;
        const expectedPath = substitute(entry.path);

        if (entry.tokenType === 'USER') {
          counts.user += 1;
          const run = await runCli(['api', ...argvFor(entry)]);
          if (run.exit !== 2) failures.push(`${label}: user-token endpoint exited ${run.exit}`);
          if (run.calls.length !== 0) failures.push(`${label}: sent ${run.calls.length} request(s)`);
          continue;
        }

        const isWrite =
          entry.paged !== 'search' &&
          ['POST', 'PATCH', 'PUT', 'DELETE'].includes(entry.method);

        if (isWrite) {
          counts.write += 1;
          const run = await runCli(['api', ...argvFor(entry), '--dry-run', '--json']);
          if (run.exit !== 0) {
            failures.push(`${label}: dry run exited ${run.exit} — ${run.stderr.trim()}`);
            continue;
          }
          if (run.calls.length !== 0) {
            failures.push(`${label}: --dry-run sent ${run.calls.length} request(s)`);
          }
          let plan: { dry_run?: unknown; request?: { url?: unknown; method?: unknown } };
          try {
            plan = JSON.parse(run.stdout) as typeof plan;
          } catch {
            failures.push(`${label}: dry run printed no plan`);
            continue;
          }
          if (plan.dry_run !== true) failures.push(`${label}: plan is not a dry run`);
          if (plan.request?.method !== entry.method) failures.push(`${label}: wrong plan method`);
          const url = String(plan.request?.url ?? '');
          try {
            const parsed = new URL(url);
            if (parsed.pathname !== expectedPath) {
              failures.push(`${label}: plan path ${parsed.pathname} ≠ ${expectedPath}`);
            }
          } catch {
            failures.push(`${label}: plan url is not a URL: ${url}`);
          }
          if (url.includes('{') || url.includes('}')) {
            failures.push(`${label}: plan url still has a placeholder`);
          }
          const printed = run.stdout + run.stderr;
          if (printed.includes(CLIENT_SECRET) || printed.includes(ACCESS_TOKEN)) {
            failures.push(`${label}: a secret reached the output`);
          }
          continue;
        }

        if (entry.paged === 'search') counts.search += 1;
        else counts.read += 1;

        const run = await runCli(['api', ...argvFor(entry)], [page([{ id: 'x' }])]);
        if (run.exit !== 0) {
          failures.push(`${label}: read exited ${run.exit} — ${run.stderr.trim()}`);
          continue;
        }
        const call = run.calls[0];
        if (call === undefined) {
          failures.push(`${label}: nothing was sent`);
          continue;
        }
        if (run.calls.length !== 1) failures.push(`${label}: sent ${run.calls.length} requests`);
        try {
          const parsed = new URL(call.url);
          if (parsed.pathname !== expectedPath) {
            failures.push(`${label}: path ${parsed.pathname} ≠ ${expectedPath}`);
          }
        } catch {
          failures.push(`${label}: url is not a URL: ${call.url}`);
        }
        if (call.url.includes('{') || call.url.includes('}')) {
          failures.push(`${label}: url still has a placeholder`);
        }
        const printed = run.stdout + run.stderr;
        if (printed.includes(CLIENT_SECRET) || printed.includes(ACCESS_TOKEN)) {
          failures.push(`${label}: a secret reached the output`);
        }
      }

      expect(failures).toEqual([]);
      expect(counts).toEqual({ user: 7, search: 5, write: 201, read: 246 });
      expect(counts.user + counts.search + counts.write + counts.read).toBe(CATALOG.length);
      expect(CATALOG.length).toBe(459);
    },
    600_000,
  );
});
