import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommanderError, Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerTesthubCommands } from '../src/cli/commands/testhub';
import { addGlobalOptions } from '../src/cli/globals';
import { captureOutput } from '../src/cli/output';
import { HELP_WIDTH } from '../src/cli/program';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { DryRunHalt, exitCodeFor } from '../src/core/errors';
import { createFakeFetch, jsonResponse, type FakeCall } from './helpers/fake';

/**
 * Gate G2: the testhub command layer end to end, with `fetch` replaced at the
 * global boundary and the config directory redirected to a temp dir. No network,
 * no real credentials.
 *
 * What is proven here and cannot be proven at the api or metadata layer:
 *  - every `--x` / `--x-id` pair is mutually exclusive **before** any request;
 *  - an empty `cases update` patch is exit 2 with nothing sent;
 *  - `runs patch` reads the run first, re-emits its current `status_id` (which
 *    the API demands even on PATCH) and its current executor, and omits
 *    `executor_id` outright — with a warning — when the run has none;
 *  - `runs bulk` refuses more than 50 entries client-side, on **all three** lists;
 *  - `meta important-levels` refuses `--library` (org-level, no per-library view);
 *  - `--json` keeps stdout JSON-only, and `--dry-run` writes nothing;
 *  - a **search still executes** under `--dry-run`, unlike a write.
 *
 * The harness builds a root program carrying only the `testhub` group. That keeps
 * these tests independent of the other four groups' registration — the leaf-count
 * and `--help` contract for the whole tree is `help.test.ts`'s job, not this
 * file's.
 */

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-testhub-cmd-'));
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

function buildTesthubProgram(): Command {
  const program = new Command();
  program
    .name('pingcode')
    .configureHelp({ helpWidth: HELP_WIDTH })
    .showHelpAfterError()
    .exitOverride();
  addGlobalOptions(program);
  registerTesthubCommands(program);
  return program;
}

type CliRun = {
  stdout: string;
  stderr: string;
  exit: number;
  calls: FakeCall[];
  writes: FakeCall[];
};

/** Run one `pingcode testhub …` invocation exactly as `bin/pingcode.ts` does. */
async function runCli(argv: string[], responses: Array<() => Response>): Promise<CliRun> {
  const fake = createFakeFetch(responses.length === 0 ? [] : responses);
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
    await buildTesthubProgram().parseAsync(['node', 'pingcode', ...argv]);
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

/** A write is a POST/PATCH that is not one of the two read-only `…/search` endpoints. */
function mutations(run: CliRun): FakeCall[] {
  return run.writes.filter((call) => !call.url.includes('/search'));
}

function parseStdout(run: CliRun): unknown {
  expect(run.stdout.trim(), `stdout was not pure JSON:\n${run.stdout}`).not.toBe('');
  return JSON.parse(run.stdout) as unknown;
}

function pathOf(call: FakeCall | undefined): string {
  return new URL(call?.url ?? 'https://x.invalid/').pathname;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const librariesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [
      {
        id: 'lib-1',
        identifier: 'LIB',
        name: '核心测试库',
        visibility: 'private',
        members: [],
        is_archived: 0,
      },
    ],
  });

const caseStatesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'cs-draft', name: '草稿', type: 'pending' },
      { id: 'cs-ready', name: '已评审', type: 'completed' },
    ],
  });

const caseTypesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'ct-func', name: '功能测试' }],
  });

const importantLevelsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'il-high', name: '高', color: '#f00' },
      { id: 'il-low', name: '低', color: '#0f0' },
    ],
  });

const runStatusesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'rs-pass', name: '通过', is_system: 1 },
      { id: 'rs-block', name: '受阻', is_system: 1 },
    ],
  });

const suitesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'su-login', name: '登录', paths: '', parent: null },
      { id: 'su-sms', name: '短信验证码', parent: { id: 'su-login', name: '登录' }, paths: '登录' },
    ],
  });

const plansPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'plan-1', short_id: 'p8x2k1', name: '2026 S1 回归' }],
  });

const casesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 1,
    values: [
      {
        id: 'case-1',
        identifier: 'LIB-10',
        short_id: 'c9y3',
        title: '短信验证码登录',
        state: { id: 'cs-draft', name: '草稿' },
        created_at: 1730000000,
        is_archived: 0,
      },
    ],
  });

const caseDetail = () =>
  jsonResponse({
    id: 'case-1',
    identifier: 'LIB-10',
    short_id: 'c9y3',
    title: '短信验证码登录',
    library: { id: 'lib-1', name: '核心测试库' },
    state: { id: 'cs-draft', name: '草稿' },
    created_at: 1730000000,
    is_archived: 0,
  });

/** A run that has already been executed once, so both ids are inheritable. */
const runDetail = () =>
  jsonResponse({
    id: 'run-1',
    short_id: 'r4m2',
    library: { id: 'lib-1', name: '核心测试库' },
    plan: { id: 'plan-1', name: '2026 S1 回归', status: 'in_progress' },
    case: { id: 'case-1', name: '短信验证码登录' },
    status: 'pass',
    latest_executed_status: { id: 'rs-pass', name: '通过' },
    executor: { id: 'user-7', name: '张三' },
    remark: 'ok',
    steps: [
      { step_id: 'st-1', status: 'pass', actual_value: 'ok' },
      { step_id: 'st-2', status: 'not_start' },
    ],
    is_archived: 0,
  });

// ---------------------------------------------------------------------------
// libraries
// ---------------------------------------------------------------------------

describe('testhub libraries', () => {
  it('list --json emits the raw page envelope on stdout only', async () => {
    const run = await runCli(['testhub', 'libraries', 'list', '--json'], [librariesPage]);
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toMatchObject({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [{ id: 'lib-1', identifier: 'LIB' }],
    });
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/libraries');
  });

  it('renders a table on stdout and the row count on stderr in human mode', async () => {
    const run = await runCli(['testhub', 'libraries', 'list'], [librariesPage]);
    expect(run.stdout).toContain('IDENTIFIER');
    expect(run.stdout).toContain('核心测试库');
    expect(run.stderr).toContain('row(s)');
    expect(run.stdout).not.toContain('row(s)');
  });

  it('get resolves an identifier to an id before fetching', async () => {
    const run = await runCli(
      ['testhub', 'libraries', 'get', 'LIB', '--json'],
      [librariesPage, () => jsonResponse({ id: 'lib-1', identifier: 'LIB', name: '核心测试库' })],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1');
  });

  it('keeps timestamps as raw unix seconds under --json', async () => {
    const run = await runCli(
      ['testhub', 'libraries', 'get', 'LIB', '--json'],
      [librariesPage, () => jsonResponse({ id: 'lib-1', name: 'x', created_at: 1730000000 })],
    );
    expect(parseStdout(run)).toMatchObject({ created_at: 1730000000 });
  });
});

describe('testhub libraries create', () => {
  const created = () =>
    jsonResponse({
      id: 'lib-new',
      identifier: 'CLIB',
      name: 'CLI Bootstrap',
      visibility: 'private',
      members: [],
      is_archived: 0,
    });

  it('sends name and identifier only, and resolves nothing first', async () => {
    const run = await runCli(
      ['testhub', 'libraries', 'create', '--name', 'CLI Bootstrap', '--identifier', 'CLIB', '--json'],
      [created],
    );
    expect(run.exit).toBe(0);
    // Nothing is name-resolved, so this is the very first request.
    expect(run.calls).toHaveLength(1);
    expect(mutations(run)).toHaveLength(1);
    expect(pathOf(mutations(run)[0])).toBe('/v1/testhub/libraries');
    expect(mutations(run)[0]?.method).toBe('POST');
    expect(mutations(run)[0]?.body).toEqual({ name: 'CLI Bootstrap', identifier: 'CLIB' });
    expect(parseStdout(run)).toMatchObject({ id: 'lib-new' });
  });

  it('passes --description and --visibility through when given', async () => {
    const run = await runCli(
      [
        'testhub',
        'libraries',
        'create',
        '--name',
        'CLI Bootstrap',
        '--identifier',
        'CLIB',
        '--description',
        'smoke fixtures',
        '--visibility',
        'public',
        '--json',
      ],
      [created],
    );
    expect(mutations(run)[0]?.body).toEqual({
      name: 'CLI Bootstrap',
      identifier: 'CLIB',
      description: 'smoke fixtures',
      visibility: 'public',
    });
  });

  it('--dry-run prints the plan on stdout and sends nothing at all', async () => {
    const run = await runCli(
      [
        'testhub',
        'libraries',
        'create',
        '--name',
        'CLI Bootstrap',
        '--identifier',
        'CLIB',
        '--dry-run',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/testhub/libraries');
    expect(plan.request.body).toEqual({ name: 'CLI Bootstrap', identifier: 'CLIB' });
    // This leaf resolves nothing, so a dry run really is zero requests.
    expect(run.calls).toHaveLength(0);
  });

  it('requires --name and --identifier, refusing at exit 2 with no request', async () => {
    for (const argv of [
      ['testhub', 'libraries', 'create', '--identifier', 'CLIB'],
      ['testhub', 'libraries', 'create', '--name', 'CLI Bootstrap'],
      ['testhub', 'libraries', 'create'],
    ]) {
      const run = await runCli([...argv, '--json'], []);
      expect(run.exit, argv.join(' ')).toBe(2);
      expect(run.calls, argv.join(' ')).toHaveLength(0);
    }
  });

  it('rejects a --visibility outside the documented enum before sending', async () => {
    const run = await runCli(
      [
        'testhub',
        'libraries',
        'create',
        '--name',
        'n',
        '--identifier',
        'I',
        '--visibility',
        'secret',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('public or private');
  });

  it('warns on stderr that the library can never be deleted, keeping stdout pure', async () => {
    const human = await runCli(
      ['testhub', 'libraries', 'create', '--name', 'CLI Bootstrap', '--identifier', 'CLIB'],
      [created],
    );
    expect(human.stderr).toContain('no library delete endpoint');
    expect(human.stdout).not.toContain('no library delete endpoint');

    const json = await runCli(
      ['testhub', 'libraries', 'create', '--name', 'CLI Bootstrap', '--identifier', 'CLIB', '--json'],
      [created],
    );
    expect(() => parseStdout(json)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// the --x / --x-id matrix (design §6)
// ---------------------------------------------------------------------------

describe('every --x / --x-id pair is mutually exclusive, before any request', () => {
  const pairs: Array<[string, string[]]> = [
    ['library', ['testhub', 'cases', 'list', '--library', 'a', '--library-id', 'b']],
    ['suite', ['testhub', 'cases', 'list', '--library', 'LIB', '--suite', 'a', '--suite-id', 'b']],
    ['state', ['testhub', 'cases', 'list', '--library', 'LIB', '--state', 'a', '--state-id', 'b']],
    ['type', ['testhub', 'cases', 'list', '--library', 'LIB', '--type', 'a', '--type-id', 'b']],
    [
      'important-level',
      [
        'testhub',
        'cases',
        'list',
        '--library',
        'LIB',
        '--important-level',
        'a',
        '--important-level-id',
        'b',
      ],
    ],
    ['plan', ['testhub', 'runs', 'list', '--plan', 'a', '--plan-id', 'b']],
    ['status', ['testhub', 'runs', 'list', '--status', 'a', '--status-id', 'b']],
    ['executor', ['testhub', 'runs', 'list', '--executor', 'a', '--executor-id', 'b']],
    // the pairs S4 added
    [
      'library',
      ['testhub', 'meta', 'plan-types', '--library', 'a', '--library-id', 'b'],
    ],
    ['library', ['testhub', 'meta', 'suites', '--library', 'a', '--library-id', 'b']],
    [
      'type',
      [
        'testhub',
        'plans',
        'create',
        '--library',
        'LIB',
        '--name',
        'p',
        '--start',
        '2026-08-10',
        '--end',
        '2026-08-31',
        '--assignee',
        'zhangsan',
        '--type',
        'a',
        '--type-id',
        'b',
      ],
    ],
    [
      'assignee',
      [
        'testhub',
        'plans',
        'create',
        '--library',
        'LIB',
        '--name',
        'p',
        '--start',
        '2026-08-10',
        '--end',
        '2026-08-31',
        '--type',
        '普通测试',
        '--assignee',
        'a',
        '--assignee-id',
        'b',
      ],
    ],
  ];

  for (const [flag, argv] of pairs) {
    const leaf = argv.slice(0, 3).join(' ');
    it(`${leaf}: --${flag} and --${flag}-id cannot be combined`, async () => {
      const run = await runCli([...argv, '--json'], []);
      expect(run.exit).toBe(2);
      expect(run.calls).toHaveLength(0);
      expect(run.stdout).toBe('');
      const payload = JSON.parse(run.stderr) as { error: { kind: string; message: string } };
      expect(payload.error.kind).toBe('usage');
      expect(payload.error.message).toContain(`--${flag} and --${flag}-id`);
    });
  }

  it('--x-id is passed through verbatim, with no lookup at all', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'list', '--library-id', 'lib-raw', '--state-id', 'cs-raw', '--json'],
      [casesPage],
    );
    expect(run.exit).toBe(0);
    // one call only: neither the library nor the state was looked up
    expect(run.calls).toHaveLength(1);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/search');
    expect(run.calls[0]?.body).toMatchObject({
      payload: {
        filter: { 'library.id': { in: ['lib-raw'] }, 'state.id': { in: ['cs-raw'] } },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// cases
// ---------------------------------------------------------------------------

describe('testhub cases list', () => {
  it('reads through POST …/search and never touches GET /v1/testhub/cases', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--json'],
      [librariesPage, casesPage],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/cases/search');
    expect(run.calls.some((call) => pathOf(call) === '/v1/testhub/cases')).toBe(false);
  });

  it('requires a library — nothing in testhub is reachable without one', async () => {
    const run = await runCli(['testhub', 'cases', 'list', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });

  it('builds the filter with the documented reference operator', async () => {
    const run = await runCli(
      [
        'testhub',
        'cases',
        'list',
        '--library',
        'LIB',
        '--suite',
        '登录 / 短信验证码',
        '--state',
        '草稿',
        '--type',
        '功能测试',
        '--important-level',
        '高',
        '--keywords',
        '登录',
        '--json',
      ],
      [librariesPage, suitesPage, caseStatesPage, caseTypesPage, importantLevelsPage, casesPage],
    );
    expect(run.exit).toBe(0);
    // the computed `Parent / Child` path resolved the nested module
    expect(run.calls[run.calls.length - 1]?.body).toMatchObject({
      mode: 'query',
      payload: {
        filter: {
          'library.id': { in: ['lib-1'] },
          'suite.id': { in: ['su-sms'] },
          'state.id': { in: ['cs-draft'] },
          'type.id': { in: ['ct-func'] },
          'important_level.id': { in: ['il-high'] },
        },
        keywords: '登录',
      },
    });
  });

  it('resolves importance levels org-wide, with no library_id on the request', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--important-level', '高', '--json'],
      [librariesPage, importantLevelsPage, casesPage],
    );
    const levels = new URL(run.calls[1]?.url ?? '');
    expect(levels.pathname).toBe('/v1/testhub/case_important_levels');
    expect(levels.searchParams.get('library_id')).toBeNull();
  });

  it('--all switches the envelope to {values,count,all}', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--all', '--json'],
      [librariesPage, casesPage],
    );
    expect(parseStdout(run)).toMatchObject({ count: 1, all: true });
  });

  it('rejects a page size above the API cap before any request', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--page-size', '101'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('get accepts a short_id and sends it unchanged', async () => {
    const run = await runCli(['testhub', 'cases', 'get', 'c9y3', '--json'], [caseDetail]);
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/c9y3');
  });
});

describe('testhub cases create', () => {
  const created = () =>
    jsonResponse({ id: 'case-new', identifier: 'LIB-11', title: '[CLI smoke] x', is_archived: 0 });

  it('sends test_library_id and title only, when nothing else was given', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'create', '--library', 'LIB', '--title', 'hello', '--json'],
      [librariesPage, created],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    // the body field is `test_library_id`, not `library_id`
    expect(mutations(run)[0]?.body).toEqual({ test_library_id: 'lib-1', title: 'hello' });
  });

  it('--dry-run prints the plan on stdout and sends zero writes', async () => {
    const run = await runCli(
      [
        'testhub',
        'cases',
        'create',
        '--library',
        'LIB',
        '--title',
        'hello',
        '--dry-run',
        '--json',
      ],
      [librariesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/testhub/cases');
    expect(plan.request.body).toEqual({ test_library_id: 'lib-1', title: 'hello' });
    // the library lookup still ran — ids are genuinely resolved — but nothing was written
    expect(mutations(run)).toHaveLength(0);
    expect(run.calls).toHaveLength(1);
  });

  it('requires a library', async () => {
    const run = await runCli(['testhub', 'cases', 'create', '--title', 'hello', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('requires --title', async () => {
    const run = await runCli(['testhub', 'cases', 'create', '--library', 'LIB', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('turns --set key=value into a verbatim properties map', async () => {
    const run = await runCli(
      [
        'testhub',
        'cases',
        'create',
        '--library',
        'LIB',
        '--title',
        'hello',
        '--set',
        'risk=opt-1',
        '--dry-run',
        '--json',
      ],
      [librariesPage],
    );
    const plan = parseStdout(run) as { request: { body: { properties: Record<string, unknown> } } };
    expect(plan.request.body.properties).toEqual({ risk: 'opt-1' });
  });
});

describe('testhub cases update', () => {
  const updated = () =>
    jsonResponse({ id: 'case-1', identifier: 'LIB-10', title: 'new', is_archived: 0 });

  it('is exit 2 with no request when no field was given', async () => {
    const run = await runCli(['testhub', 'cases', 'update', 'case-1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('reads the case first, so a short_id never reaches the PATCH path', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'update', 'c9y3', '--title', 'new', '--json'],
      [caseDetail, updated],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.method).toBe('GET');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/c9y3');
    expect(mutations(run)).toHaveLength(1);
    expect(pathOf(mutations(run)[0])).toBe('/v1/testhub/cases/case-1');
    expect(mutations(run)[0]?.body).toEqual({ title: 'new' });
  });

  it('resolves --state against the library the case itself reports', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'update', 'case-1', '--state', '已评审', '--json'],
      [caseDetail, caseStatesPage, updated],
    );
    expect(run.exit).toBe(0);
    const states = new URL(run.calls[1]?.url ?? '');
    expect(states.pathname).toBe('/v1/testhub/case/states');
    expect(states.searchParams.get('library_id')).toBe('lib-1');
    expect(mutations(run)[0]?.body).toEqual({ state_id: 'cs-ready' });
  });
});

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------

describe('testhub plans', () => {
  it('list is addressed under the library', async () => {
    const run = await runCli(
      ['testhub', 'plans', 'list', '--library', 'LIB', '--json'],
      [librariesPage, plansPage],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plans');
  });

  it('get resolves a short_id to a real id first', async () => {
    const run = await runCli(
      ['testhub', 'plans', 'get', 'p8x2k1', '--library', 'LIB', '--json'],
      [librariesPage, plansPage, () => jsonResponse({ id: 'plan-1', name: '2026 S1 回归' })],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/libraries/lib-1/plans/plan-1');
  });

  it('requires a library, because the plan URL contains one', async () => {
    const run = await runCli(['testhub', 'plans', 'list', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('testhub plans create', () => {
  const planTypesPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 2,
      values: [
        { id: 'pt-plain', name: '普通测试' },
        { id: 'pt-sprint', name: '迭代测试' },
      ],
    });

  const usersPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [{ id: 'user-7', display_name: '张三', username: 'zhangsan' }],
    });

  const created = () =>
    jsonResponse({
      id: 'plan-new',
      short_id: 'ab12',
      name: 'Bootstrap Plan',
      type: { id: 'pt-plain', name: '普通测试' },
      assignee: { id: 'user-7', name: '张三' },
      start_at: 1_786_291_200,
      end_at: 1_788_191_999,
    });

  const argvFor = (extra: string[] = []): string[] => [
    'testhub',
    'plans',
    'create',
    '--library',
    'LIB',
    '--name',
    'Bootstrap Plan',
    '--type',
    '普通测试',
    '--start',
    '2026-08-10',
    '--end',
    '2026-08-31',
    '--assignee',
    'zhangsan',
    ...extra,
  ];

  it('resolves library, type and assignee then POSTs all five fields', async () => {
    const run = await runCli(argvFor(['--json']), [
      librariesPage,
      planTypesPage,
      usersPage,
      created,
    ]);
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plan_types');
    expect(pathOf(run.calls[2])).toBe('/v1/directory/users');
    expect(mutations(run)).toHaveLength(1);
    expect(pathOf(mutations(run)[0])).toBe('/v1/testhub/libraries/lib-1/plans');
    const body = mutations(run)[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'assignee_id',
      'end_at',
      'name',
      'start_at',
      'type_id',
    ]);
    expect(body).toMatchObject({
      name: 'Bootstrap Plan',
      type_id: 'pt-plain',
      assignee_id: 'user-7',
    });
    // project_id / sprint_id / version_id are never sent.
    expect('project_id' in body).toBe(false);
    expect('sprint_id' in body).toBe(false);
  });

  it('maps --start to 00:00:00 and --end to 23:59:59 of the local day', async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      const run = await runCli(argvFor(['--dry-run', '--json']), [
        librariesPage,
        planTypesPage,
        usersPage,
      ]);
      const plan = parseStdout(run) as { request: { body: { start_at: number; end_at: number } } };
      // The literals the API must receive for "10 through 31 August" in UTC+8.
      expect(plan.request.body.start_at).toBe(1_786_291_200);
      expect(plan.request.body.end_at).toBe(1_788_191_999);
      expect(plan.request.body.end_at - plan.request.body.start_at).toBe(21 * 86_400 + 86_399);
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it('accepts a 10-digit unix seconds value verbatim on either date flag', async () => {
    const run = await runCli(
      [
        'testhub',
        'plans',
        'create',
        '--library',
        'LIB',
        '--name',
        'p',
        '--type',
        '普通测试',
        '--start',
        '1786291200',
        '--end',
        '1788191999',
        '--assignee',
        'zhangsan',
        '--dry-run',
        '--json',
      ],
      [librariesPage, planTypesPage, usersPage],
    );
    const plan = parseStdout(run) as { request: { body: { start_at: number; end_at: number } } };
    expect(plan.request.body.start_at).toBe(1_786_291_200);
    expect(plan.request.body.end_at).toBe(1_788_191_999);
  });

  it('--dry-run resolves the references but writes nothing', async () => {
    const run = await runCli(argvFor(['--dry-run', '--json']), [
      librariesPage,
      planTypesPage,
      usersPage,
    ]);
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { method: string; url: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/testhub/libraries/lib-1/plans');
    expect(mutations(run)).toHaveLength(0);
    // three reads happened: ids really are resolved under --dry-run
    expect(run.calls).toHaveLength(3);
  });

  it('rejects a malformed date at exit 2 before any request', async () => {
    for (const [flag, value] of [
      ['--start', '2026-8-1'],
      ['--end', '08/31/2026'],
      ['--end', '1786291200000'],
    ] as const) {
      const argv = argvFor(['--json']);
      argv[argv.indexOf(flag) + 1] = value;
      const run = await runCli(argv, []);
      expect(run.exit, `${flag} ${value}`).toBe(2);
      expect(run.calls, `${flag} ${value}`).toHaveLength(0);
    }
  });

  it('rejects an --end that precedes --start, before any request', async () => {
    const argv = argvFor(['--json']);
    argv[argv.indexOf('--end') + 1] = '2026-08-01';
    const run = await runCli(argv, []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('before --start');
  });

  it('requires --assignee — it must never default to the bot user', async () => {
    const argv = argvFor(['--json']).filter(
      (token, index, all) => token !== '--assignee' && all[index - 1] !== '--assignee',
    );
    const run = await runCli(argv, []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('--assignee');
  });

  it('requires --type, pointing at the lookup that lists them', async () => {
    const argv = argvFor(['--json']).filter(
      (token, index, all) => token !== '--type' && all[index - 1] !== '--type',
    );
    const run = await runCli(argv, []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--type');
  });

  it('requires --name and a library', async () => {
    const withoutName = argvFor(['--json']).filter(
      (token, index, all) => token !== '--name' && all[index - 1] !== '--name',
    );
    expect((await runCli(withoutName, [])).exit).toBe(2);

    const withoutLibrary = argvFor(['--json']).filter(
      (token, index, all) => token !== '--library' && all[index - 1] !== '--library',
    );
    const run = await runCli(withoutLibrary, []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('keeps stdout JSON-only, with the created notice on stderr', async () => {
    // Both runs share one temp config dir, so the metadata cache would be warm
    // for the second and it would resolve nothing — `--no-cache` keeps the two
    // invocations symmetrical instead of depending on that.
    const human = await runCli(argvFor(['--no-cache']), [
      librariesPage,
      planTypesPage,
      usersPage,
      created,
    ]);
    expect(human.stderr).toContain('created ab12');
    expect(human.stdout).not.toContain('created ab12');

    const json = await runCli(argvFor(['--no-cache', '--json']), [
      librariesPage,
      planTypesPage,
      usersPage,
      created,
    ]);
    expect(parseStdout(json)).toMatchObject({ id: 'plan-new' });
  });

  it('surfaces the server refusal verbatim for a type it cannot satisfy', async () => {
    // An iteration type needs sprint_id, which the CLI cannot know to send.
    const run = await runCli(
      argvFor(['--json']).map((token) => (token === '普通测试' ? '迭代测试' : token)),
      [
        librariesPage,
        planTypesPage,
        usersPage,
        () => jsonResponse({ code: '100500', message: 'sprint_id 不能为空' }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(7);
    expect(run.stderr).toContain('sprint_id');
    const payload = JSON.parse(run.stderr) as { error: { code: string } };
    expect(payload.error.code).toBe('100500');
  });
});

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

describe('testhub runs list', () => {
  const runsPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 30,
      total: 1,
      values: [
        {
          id: 'run-1',
          short_id: 'r4m2',
          case: { id: 'case-1', name: '短信验证码登录' },
          status: 'pass',
          latest_executed_status: { id: 'rs-pass', name: '通过' },
          executor: { id: 'user-7', name: '张三' },
          steps: [],
          is_archived: 0,
        },
      ],
    });

  it('filters by plan.id and latest_executed_status.id', async () => {
    const run = await runCli(
      [
        'testhub',
        'runs',
        'list',
        '--library',
        'LIB',
        '--plan',
        '2026 S1 回归',
        '--status',
        '通过',
        '--json',
      ],
      [librariesPage, plansPage, runStatusesPage, runsPage],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[3])).toBe('/v1/testhub/runs/search');
    expect(run.calls[3]?.body).toMatchObject({
      payload: {
        filter: {
          'plan.id': { in: ['plan-1'] },
          'latest_executed_status.id': { in: ['rs-pass'] },
        },
      },
    });
    // library.id is on the API exclusion list, so it must never be sent
    expect(JSON.stringify(run.calls[3]?.body)).not.toContain('library.id');
  });

  it('warns on stderr when runs are listed without a plan, keeping stdout pure', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'list', '--library', 'LIB', '--json'],
      [librariesPage, runsPage],
    );
    expect(run.stderr).toContain('cannot filter by library.id');
    expect(() => parseStdout(run)).not.toThrow();
  });

  it('needs no library at all when only ids are given', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'list', '--plan-id', 'plan-9', '--json'],
      [runsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
  });

  it('demands a library before it will resolve a plan name', async () => {
    const run = await runCli(['testhub', 'runs', 'list', '--plan', '2026 S1 回归', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });
});

describe('testhub runs patch — the read-then-patch contract (design §7)', () => {
  const patched = () =>
    jsonResponse({
      id: 'run-1',
      short_id: 'r4m2',
      status: 'pass',
      latest_executed_status: { id: 'rs-pass', name: '通过' },
      executor: { id: 'user-7', name: '张三' },
      remark: 'smoke',
      steps: [],
      is_archived: 0,
    });

  it('re-emits the current status_id when --status was not given', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'patch', 'run-1', '--remark', 'smoke', '--json'],
      [runDetail, patched],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.method).toBe('GET');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/run-1');
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.method).toBe('PATCH');
    // status_id is required even on PATCH: inherited from latest_executed_status
    expect(mutations(run)[0]?.body).toEqual({
      status_id: 'rs-pass',
      executor_id: 'user-7',
      remark: 'smoke',
    });
  });

  it('re-sends the executor the run already has, so a remark-only patch keeps it', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'patch', 'run-1', '--status-id', 'rs-block', '--json'],
      [runDetail, patched],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)[0]?.body).toEqual({ status_id: 'rs-block', executor_id: 'user-7' });
  });

  it('omits executor_id entirely, with a warning, when the run has no executor', async () => {
    // Verified live on 2026-08-02 (design §7): an omitted `executor_id` is a
    // no-op on PATCH — it neither clears nor reassigns — so recording a result
    // on an unassigned run is a legitimate operation, not a refusal.
    const unassigned = () =>
      jsonResponse({
        id: 'run-3',
        short_id: 'r7',
        library: { id: 'lib-1' },
        latest_executed_status: { id: 'rs-pass', name: '通过' },
        executor: null,
        steps: [],
        is_archived: 0,
      });
    const run = await runCli(
      ['testhub', 'runs', 'patch', 'run-3', '--remark', 'smoke', '--json'],
      [unassigned, patched],
    );
    expect(run.exit).toBe(0);
    const body = mutations(run)[0]?.body as Record<string, unknown>;
    // absence of the key, not an `undefined` value: `toEqual` cannot tell them apart
    expect(Object.keys(body)).not.toContain('executor_id');
    expect(body).toEqual({ status_id: 'rs-pass', remark: 'smoke' });
    expect(run.stderr).toContain('has no executor');
    expect(run.stderr).toContain('stays unassigned');
    expect(parseStdout(run)).toBeTruthy();
  });

  it('resolves --status against the library the run itself reports', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'patch', 'r4m2', '--status', '受阻', '--json'],
      [runDetail, runStatusesPage, patched],
    );
    expect(run.exit).toBe(0);
    const statuses = new URL(run.calls[1]?.url ?? '');
    expect(statuses.pathname).toBe('/v1/testhub/run/statuses');
    expect(statuses.searchParams.get('library_id')).toBe('lib-1');
    // the short_id was resolved to the real id by the pre-read
    expect(pathOf(mutations(run)[0])).toBe('/v1/testhub/runs/run-1');
    expect(mutations(run)[0]?.body).toEqual({ status_id: 'rs-block', executor_id: 'user-7' });
  });

  it('refuses when the run has never been executed and no --status was given', async () => {
    const never = () =>
      jsonResponse({
        id: 'run-2',
        short_id: 'r0',
        executor: { id: 'user-7' },
        steps: [],
        is_archived: 0,
      });
    const run = await runCli(['testhub', 'runs', 'patch', 'run-2', '--remark', 'x', '--json'], [never]);
    expect(run.exit).toBe(2);
    expect(mutations(run)).toHaveLength(0);
    expect(run.stderr).toContain('--status is required');
  });

  it('surfaces a failed pre-read and never attempts the PATCH', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'patch', 'nope', '--status-id', 'rs-pass', '--json'],
      [() => jsonResponse({ code: '404', message: 'not found' }, { status: 404 })],
    );
    expect(run.exit).toBe(5);
    expect(run.calls).toHaveLength(1);
    expect(mutations(run)).toHaveLength(0);
  });

  it('--dry-run shows the full inherited body and sends nothing', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'patch', 'run-1', '--remark', 'x', '--dry-run', '--json'],
      [runDetail],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({
      status_id: 'rs-pass',
      executor_id: 'user-7',
      remark: 'x',
    });
    expect(mutations(run)).toHaveLength(0);
  });

  it('refuses a partial step edit rather than orphaning the untouched steps', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'patch', 'run-1', '--step', 'st-1=通过', '--json'],
      [runDetail],
    );
    expect(run.exit).toBe(2);
    expect(mutations(run)).toHaveLength(0);
    expect(run.stderr).toContain('every step needs a status');
  });

  it('replaces the whole steps array when every step is given a status', async () => {
    const run = await runCli(
      [
        'testhub',
        'runs',
        'patch',
        'run-1',
        '--step',
        'st-1=通过',
        '--step',
        'st-2=受阻',
        '--step-actual',
        'st-2=timed out',
        '--json',
      ],
      [runDetail, runStatusesPage, patched],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)[0]?.body).toEqual({
      status_id: 'rs-pass',
      executor_id: 'user-7',
      steps: [
        { step_id: 'st-1', status_id: 'rs-pass' },
        { step_id: 'st-2', status_id: 'rs-block', actual_value: 'timed out' },
      ],
    });
    expect(run.stderr).toContain('replacing all 2 step(s)');
  });

  it('rejects a step the run does not have', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'patch', 'run-1', '--step', 'st-9=通过', '--json'],
      [runDetail],
    );
    expect(run.exit).toBe(2);
    expect(mutations(run)).toHaveLength(0);
    expect(run.stderr).toContain('st-9');
  });
});

describe('testhub runs bulk', () => {
  const bulkResult = () => jsonResponse({ inserts: 2, updates: 0, deletes: 0 });

  /**
   * The `≤50` cap is one loop over all three lists, so asserting only
   * `--remove-run` would let a refactor that special-cased a single list pass
   * unnoticed. Each entry carries the extra lookups its flag triggers:
   * `--set-status` resolves a run status (once — the rest hit the 24h cache),
   * the other two resolve nothing beyond the library and the plan.
   */
  const capped: Array<[string, (index: number) => string, Array<() => Response>]> = [
    ['--add-case', (index) => `case-${index}`, [librariesPage, plansPage, bulkResult]],
    [
      '--set-status',
      (index) => `run-${index}=通过`,
      [librariesPage, plansPage, runStatusesPage, bulkResult],
    ],
    ['--remove-run', (index) => `run-${index}`, [librariesPage, plansPage, bulkResult]],
  ];

  for (const [flag, entry, responses] of capped) {
    it(`${flag} rejects 51 entries client-side, before any request is sent`, async () => {
      const argv = ['testhub', 'runs', 'bulk', '--library', 'LIB', '--plan', 'x'];
      for (let index = 0; index < 51; index += 1) argv.push(flag, entry(index));
      const run = await runCli([...argv, '--json'], []);
      expect(run.exit).toBe(2);
      expect(run.calls).toHaveLength(0);
      expect(run.stderr).toContain(flag);
      expect(run.stderr).toContain('51');
      expect(run.stderr).toContain('50');
    });

    it(`${flag} accepts exactly 50`, async () => {
      const argv = ['testhub', 'runs', 'bulk', '--library', 'LIB', '--plan', '2026 S1 回归'];
      for (let index = 0; index < 50; index += 1) argv.push(flag, entry(index));
      const run = await runCli([...argv, '--json'], responses);
      expect(run.exit).toBe(0);
      expect(mutations(run)).toHaveLength(1);
      const body = mutations(run)[0]?.body as Record<string, unknown[]>;
      const list = body.inserts ?? body.updates ?? body.deletes;
      expect(list).toHaveLength(50);
    });
  }

  it('caps each list independently, so three lists of 50 are one legal call', async () => {
    const argv = ['testhub', 'runs', 'bulk', '--library', 'LIB', '--plan', '2026 S1 回归'];
    for (let index = 0; index < 50; index += 1) {
      argv.push('--add-case', `case-${index}`);
      argv.push('--set-status', `run-${index}=通过`);
      argv.push('--remove-run', `old-${index}`);
    }
    const run = await runCli(
      [...argv, '--json'],
      [librariesPage, plansPage, runStatusesPage, bulkResult],
    );
    expect(run.exit).toBe(0);
    const body = mutations(run)[0]?.body as Record<string, unknown[]>;
    expect(body.inserts).toHaveLength(50);
    expect(body.updates).toHaveLength(50);
    expect(body.deletes).toHaveLength(50);
  });

  it('names only the list that overflowed when just one of the three does', async () => {
    const argv = ['testhub', 'runs', 'bulk', '--library', 'LIB', '--plan', 'x', '--add-case', 'c1'];
    for (let index = 0; index < 51; index += 1) argv.push('--remove-run', `run-${index}`);
    const run = await runCli([...argv, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('--remove-run');
    expect(payload.error.message).not.toContain('--add-case');
  });

  it('resolves the plan to a real id for the URL and sends counts back', async () => {
    const run = await runCli(
      [
        'testhub',
        'runs',
        'bulk',
        '--library',
        'LIB',
        '--plan',
        'p8x2k1',
        '--add-case',
        'case-1',
        '--json',
      ],
      [librariesPage, plansPage, bulkResult],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(mutations(run)[0])).toBe('/v1/testhub/libraries/lib-1/plans/plan-1/runs/bulk');
    expect(mutations(run)[0]?.body).toEqual({ inserts: [{ case_id: 'case-1' }] });
    expect(parseStdout(run)).toMatchObject({ inserts: 2 });
  });

  it('resolves --set-status values against the library run statuses', async () => {
    const run = await runCli(
      [
        'testhub',
        'runs',
        'bulk',
        '--library',
        'LIB',
        '--plan',
        'p8x2k1',
        '--set-status',
        'run-1=通过',
        '--dry-run',
        '--json',
      ],
      [librariesPage, plansPage, runStatusesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { request: { body: unknown } };
    expect(plan.request.body).toEqual({ updates: [{ run_id: 'run-1', status_id: 'rs-pass' }] });
    expect(mutations(run)).toHaveLength(0);
  });

  it('is exit 2 when no work was described', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'bulk', '--library', 'LIB', '--plan', 'x', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('requires a plan', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'bulk', '--library', 'LIB', '--add-case', 'case-1', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--plan');
  });
});

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

describe('a search still executes under --dry-run, unlike a write', () => {
  // `--dry-run` gates on the HTTP **verb**, so `POST …/search` would halt like a
  // write unless `asReadContext` exempted it. That exemption is unit-tested in
  // `searchPaginate.test.ts`; what is proven here is that the two testhub read
  // leaves actually inherit it end to end — a leaf that built its own context, or
  // a future refactor that stopped routing through `searchPaginate`, would break
  // this while the shared unit test stayed green.
  const runsPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 30,
      total: 1,
      values: [{ id: 'run-1', short_id: 'r4m2', status: 'pass', steps: [], is_archived: 0 }],
    });

  it('cases list --dry-run issues its POST and prints the results', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--dry-run', '--json'],
      [librariesPage, casesPage],
    );
    expect(run.exit).toBe(0);
    // The search really went out.
    expect(run.calls).toHaveLength(2);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/cases/search');
    expect(run.calls[1]?.method).toBe('POST');
    // stdout carries results, not a request plan.
    const payload = parseStdout(run) as { values: Array<{ id: string }>; dry_run?: boolean };
    expect(payload.dry_run).toBeUndefined();
    expect(payload.values[0]?.id).toBe('case-1');
    expect(run.stdout).not.toContain('dry_run');
  });

  it('runs list --dry-run issues its POST and prints the results', async () => {
    const run = await runCli(
      ['testhub', 'runs', 'list', '--plan-id', 'plan-9', '--dry-run', '--json'],
      [runsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/search');
    expect(run.calls[0]?.method).toBe('POST');
    const payload = parseStdout(run) as { values: Array<{ id: string }>; dry_run?: boolean };
    expect(payload.dry_run).toBeUndefined();
    expect(payload.values[0]?.id).toBe('run-1');
  });

  it('--all keeps walking pages under --dry-run', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--all', '--dry-run', '--json'],
      [librariesPage, casesPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls.some((call) => pathOf(call) === '/v1/testhub/cases/search')).toBe(true);
    expect(parseStdout(run)).toMatchObject({ count: 1, all: true });
  });

  it('but a write on the same verb still halts — the contrast that makes this meaningful', async () => {
    const search = await runCli(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--dry-run', '--json'],
      [librariesPage, casesPage],
    );
    const write = await runCli(
      [
        'testhub',
        'cases',
        'create',
        '--library-id',
        'lib-1',
        '--title',
        'hello',
        '--dry-run',
        '--json',
      ],
      [],
    );
    // Same POST verb, opposite treatment.
    expect(search.stdout).not.toContain('dry_run');
    expect((parseStdout(write) as { dry_run: boolean }).dry_run).toBe(true);
    expect(mutations(write)).toHaveLength(0);
  });
});

describe('testhub meta', () => {
  const libraryScoped: Array<[string, string, () => Response]> = [
    ['case-states', '/v1/testhub/case/states', caseStatesPage],
    ['case-types', '/v1/testhub/case/types', caseTypesPage],
    ['run-statuses', '/v1/testhub/run/statuses', runStatusesPage],
  ];

  for (const [name, expectedPath, page] of libraryScoped) {
    it(`${name} is library-scoped and emits {values,count}`, async () => {
      const run = await runCli(
        ['testhub', 'meta', name, '--library', 'LIB', '--json'],
        [librariesPage, page],
      );
      expect(run.exit).toBe(0);
      const url = new URL(run.calls[1]?.url ?? '');
      expect(url.pathname).toBe(expectedPath);
      expect(url.searchParams.get('library_id')).toBe('lib-1');
      const payload = parseStdout(run) as { count: number; values: unknown[] };
      expect(payload.count).toBe(payload.values.length);
    });

    it(`${name} requires a library`, async () => {
      const run = await runCli(['testhub', 'meta', name, '--json'], []);
      expect(run.exit).toBe(2);
      expect(run.calls).toHaveLength(0);
    });
  }

  it('important-levels is org-level and sends no library_id', async () => {
    const run = await runCli(['testhub', 'meta', 'important-levels', '--json'], [
      importantLevelsPage,
    ]);
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/testhub/case_important_levels');
    expect(url.searchParams.get('library_id')).toBeNull();
    expect(parseStdout(run)).toMatchObject({ count: 2 });
  });

  it('important-levels refuses --library instead of ignoring it', async () => {
    const run = await runCli(
      ['testhub', 'meta', 'important-levels', '--library', 'LIB', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { kind: string; message: string } };
    expect(payload.error.kind).toBe('usage');
    expect(payload.error.message).toContain('takes no --library');
  });

  it('important-levels refuses --library-id too', async () => {
    const run = await runCli(
      ['testhub', 'meta', 'important-levels', '--library-id', 'lib-1', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('plan-types is nested under the library and sends no library_id', async () => {
    const planTypesPage = () =>
      jsonResponse({
        page_index: 0,
        page_size: 100,
        total: 1,
        values: [{ id: 'pt-plain', name: '普通测试' }],
      });
    const run = await runCli(
      ['testhub', 'meta', 'plan-types', '--library', 'LIB', '--json'],
      [librariesPage, planTypesPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[1]?.url ?? '');
    // Path-scoped, unlike the singular-segment config views.
    expect(url.pathname).toBe('/v1/testhub/libraries/lib-1/plan_types');
    expect(url.searchParams.get('library_id')).toBeNull();
    expect(parseStdout(run)).toEqual({ values: [{ id: 'pt-plain', name: '普通测试' }], count: 1 });
  });

  it('plan-types requires a library', async () => {
    const run = await runCli(['testhub', 'meta', 'plan-types', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('suites lists the whole tree with the computed Parent / Child path', async () => {
    const run = await runCli(
      ['testhub', 'meta', 'suites', '--library', 'LIB', '--json'],
      [librariesPage, suitesPage],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/suites');
    // No parent_id when the flag is absent: that means the whole tree.
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('parent_id')).toBeNull();

    const payload = parseStdout(run) as { values: Array<{ id: string; computed_path: string }> };
    const paths = Object.fromEntries(
      payload.values.map((row) => [row.id, row.computed_path]),
    );
    // The child carries its own full path, not the parent chain the server sends.
    expect(paths['su-login']).toBe('登录');
    expect(paths['su-sms']).toBe('登录 / 短信验证码');
  });

  it('suites shows the spelling --suite accepts, not the server `paths` field', async () => {
    const run = await runCli(
      ['testhub', 'meta', 'suites', '--library', 'LIB', '--json'],
      [librariesPage, suitesPage],
    );
    const payload = parseStdout(run) as {
      values: Array<{ id: string; paths?: string; computed_path: string }>;
    };
    const child = payload.values.find((row) => row.id === 'su-sms');
    // `paths` is the parent chain excluding self (f74ecd2) — it is preserved in
    // the JSON but must not be what the PATH column reports.
    expect(child?.paths).toBe('登录');
    expect(child?.computed_path).not.toBe(child?.paths);
    expect(child?.computed_path).toContain(' / ');
  });

  it('suites passes --parent-id root through as a server-side filter', async () => {
    const rootOnly = () =>
      jsonResponse({
        page_index: 0,
        page_size: 100,
        total: 1,
        values: [{ id: 'su-login', name: '登录', paths: '', parent: null }],
      });
    const run = await runCli(
      ['testhub', 'meta', 'suites', '--library', 'LIB', '--parent-id', 'root', '--json'],
      [librariesPage, rootOnly],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('parent_id')).toBe('root');
    const payload = parseStdout(run) as { values: Array<{ computed_path: string }>; count: number };
    expect(payload.count).toBe(1);
    expect(payload.values[0]?.computed_path).toBe('登录');
  });

  it('suites rebuilds the prefix when --parent-id hides the ancestors', async () => {
    // A filtered view returns children whose parents are outside the result set,
    // so the parent walk cannot reach them; the server chain fills the gap.
    const childrenOnly = () =>
      jsonResponse({
        page_index: 0,
        page_size: 100,
        total: 1,
        values: [
          {
            id: 'su-sms',
            name: '短信验证码',
            parent: { id: 'su-login', name: '登录' },
            paths: '登录',
          },
        ],
      });
    const run = await runCli(
      ['testhub', 'meta', 'suites', '--library', 'LIB', '--parent-id', 'su-login', '--json'],
      [librariesPage, childrenOnly],
    );
    const payload = parseStdout(run) as { values: Array<{ computed_path: string }> };
    expect(payload.values[0]?.computed_path).toBe('登录 / 短信验证码');
  });

  it('suites requires a library', async () => {
    const run = await runCli(['testhub', 'meta', 'suites', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('the configuration-scope trap (design §9)', () => {
  const forbidden = () =>
    jsonResponse({ code: '403', message: 'forbidden' }, { status: 403 });

  it('names the missing scope when run/statuses answers 403', async () => {
    const run = await runCli(
      ['testhub', 'meta', 'run-statuses', '--library', 'LIB'],
      [librariesPage, forbidden],
    );
    expect(run.exit).toBe(4);
    expect(run.stderr).toContain('pcp:read:testhub:configuration');
    expect(run.stderr).toContain('run statuses');
  });

  it('names the missing scope when case/states answers 403 during name resolution', async () => {
    const run = await runCli(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--state', '草稿'],
      [librariesPage, forbidden],
    );
    expect(run.exit).toBe(4);
    expect(run.stderr).toContain('pcp:read:testhub:configuration');
  });

  it('names the missing scope when case_important_levels answers 403', async () => {
    // Org-level, so no library lookup precedes it — one call, and the same
    // enrichment as its two library-scoped siblings ([th#36]/[th#40]).
    const run = await runCli(['testhub', 'meta', 'important-levels'], [forbidden]);
    expect(run.exit).toBe(4);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('pcp:read:testhub:configuration');
    expect(run.stderr).toContain('importance levels');
  });

  it('leaves case/types alone — it needs no configuration scope', async () => {
    const run = await runCli(
      ['testhub', 'meta', 'case-types', '--library', 'LIB'],
      [librariesPage, forbidden],
    );
    expect(run.exit).toBe(4);
    expect(run.stderr).not.toContain('reading case types requires');
  });

  it('never blames the configuration scope for a plan-types 403', async () => {
    // Plan types are pcp:read:testhub:testplan. Borrowing the configuration hint
    // would send the investigation after a scope that was never involved.
    const run = await runCli(
      ['testhub', 'meta', 'plan-types', '--library', 'LIB'],
      [librariesPage, forbidden],
    );
    expect(run.exit).toBe(4);
    expect(run.stderr).not.toContain('configuration');
  });

  it('never blames the configuration scope for a suites 403', async () => {
    // Suites are pcp:read:testhub:library.
    const run = await runCli(
      ['testhub', 'meta', 'suites', '--library', 'LIB'],
      [librariesPage, forbidden],
    );
    expect(run.exit).toBe(4);
    expect(run.stderr).not.toContain('configuration');
  });

  it('never blames the configuration scope for a plan-type 403 during plans create', async () => {
    const run = await runCli(
      [
        'testhub',
        'plans',
        'create',
        '--library',
        'LIB',
        '--name',
        'p',
        '--type',
        '普通测试',
        '--start',
        '2026-08-10',
        '--end',
        '2026-08-31',
        '--assignee',
        'zhangsan',
      ],
      [librariesPage, forbidden],
    );
    expect(run.exit).toBe(4);
    expect(run.stderr).not.toContain('configuration');
  });
});
