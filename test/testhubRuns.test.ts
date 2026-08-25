import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness, type CliRun } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * Coverage for `src/cli/commands/testhub/runs.ts` — `testhub runs {list,create,update,
 * bulk-create,bulk-update,bulk}` and `testhub runs history {list,get}`.
 *
 * The suite drives the **real** tree through `createCliHarness` (`buildProgram()`),
 * so every assertion is against the root the binary actually runs. No network: the
 * harness swaps in a fake `fetch`, and each test runs in its own temp config dir, so
 * the metadata cache is empty per test and never contaminates a sibling.
 *
 * What this suite targets beyond the shared `testhubCommands` / `testhubEntries`
 * suites — the branches of `runs.ts` those left cold:
 *  - `list`: `--all` (the `iterateRuns` + `printCollection({all:true})` branch, distinct
 *    from the single-page `searchRuns` + `printPage` branch), `--keywords`, `--case-id`,
 *    `--executor <name>` (org-level, needs no library), a name plan/status demanding a
 *    library, and the human-mode table;
 *  - `create`: `--case`/`--case-id`, executor optional, `--dry-run` (reads run, nothing
 *    written), the no-plan / no-case / no-library refusals and human-mode notice;
 *  - `update`: inheriting `status_id`/`executor_id`, the no-executor warning, the
 *    no-status refusal, the whole-array `--step` replacement (with `--step-actual`), the
 *    partial / unknown / no-step refusals, `--executor`/`--executor-id` overrides,
 *    `--status <name>` resolved against the run's library, `--dry-run`, a failed pre-read;
 *  - `bulk-create`: `--case` resolution, executor, `--dry-run`, the caps and the
 *    per-element failure rendering;
 *  - `bulk-update`: the `--run` form (short_id → id, shared status), `--run-id` (no
 *    lookup), `--dry-run`, the mutual-exclusion refusals;
 *  - `bulk`: inserts + updates + deletes together, `--dry-run`, human mode, the caps and
 *    the no-work / no-plan refusals;
 *  - `history list` / `history get`: the id-only path reached through the short_id-accepting
 *    run read, `--all`, single page and human mode.
 */

// The harness owns a temp config dir per test via these hooks.
const h = createCliHarness({ beforeEach, afterEach });

// A separate temp dir for the JSON files the `--file` form reads.
let fileDir: string;
beforeEach(() => {
  fileDir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-runs-'));
});
afterEach(() => {
  rmSync(fileDir, { recursive: true, force: true });
});

function writeEntries(content: string): string {
  const file = path.join(fileDir, `runs-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, content, 'utf8');
  return file;
}

function pathOf(call: { url: string } | undefined): string {
  return new URL(call?.url ?? 'https://x.invalid/').pathname;
}

function parseStdout(run: CliRun): unknown {
  expect(run.stdout.trim(), `stdout was not pure JSON:\n${run.stdout}`).not.toBe('');
  return JSON.parse(run.stdout) as unknown;
}

/** Only the requests that would change server state. */
function writes(run: CliRun): CliRun['writes'] {
  return run.writes;
}

// ---------------------------------------------------------------------------
// fixtures — zero-arg factories, so a handler passed to the fake fetch is never
// called with the FakeCall as a defaulted first argument.
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

const plansPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'plan-1', short_id: 'p8x2k1', name: '2026 S1 回归' }],
  });

const runStatusesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 5,
    values: [
      { id: 'rs-notstart', name: '未测', is_system: 1 },
      { id: 'rs-pass', name: '通过', is_system: 1 },
      { id: 'rs-block', name: '受阻', is_system: 1 },
      { id: 'rs-fail', name: '失败', is_system: 1 },
      { id: 'rs-skip', name: '跳过', is_system: 1 },
    ],
  });

const usersPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'user-7', display_name: '张三', username: 'zhangsan' }],
  });

const caseDetail = () =>
  jsonResponse({
    id: 'case-1',
    identifier: 'LIB-1',
    short_id: 'c9y3',
    title: '登录',
    is_archived: 0,
    steps: [],
  });

/** The run `update` / `history` resolve and return: an assigned, executed run. */
const runDetail = () =>
  jsonResponse({
    id: 'run-1',
    short_id: 'r4m2',
    library: { id: 'lib-1', name: '核心测试库' },
    plan: { id: 'plan-1', name: '2026 S1 回归', status: 'in_progress' },
    case: { id: 'case-1', name: '登录' },
    suite: { id: 'suite-1', name: '登录模块' },
    status: 'pass',
    latest_executed_status: { id: 'rs-pass', name: '通过' },
    executor: { id: 'user-7', name: '张三' },
    remark: 'ok',
    steps: [
      { step_id: 'st-1', status: 'pass' },
      { step_id: 'st-2', status: 'block' },
    ],
    created_at: 1_730_000_000,
    updated_at: 1_730_000_001,
    is_archived: 0,
  });

const runsSearchPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 1,
    values: [
      {
        id: 'run-1',
        short_id: 'r4m2',
        case: { id: 'case-1', name: '登录' },
        latest_executed_status: { id: 'rs-pass', name: '通过' },
        executor: { id: 'user-7', name: '张三' },
        is_archived: 0,
        steps: [],
      },
    ],
  });

const createdRun = () =>
  jsonResponse({
    id: 'run-new',
    short_id: 'rn1',
    library: { id: 'lib-1', name: '核心测试库' },
    plan: { id: 'plan-1', name: '2026 S1 回归' },
    case: { id: 'case-1', name: '登录' },
    status: 'not_start',
    steps: [{ step_id: 'st-1' }],
    is_archived: 0,
  });

const patchedRun = () =>
  jsonResponse({
    id: 'run-1',
    short_id: 'r4m2',
    status: 'block',
    latest_executed_status: { id: 'rs-block', name: '受阻' },
    executor: { id: 'user-7', name: '张三' },
    remark: 'x',
    steps: [],
    is_archived: 0,
  });

const bulkCreateRunsOk = () =>
  jsonResponse([
    { state: 'success', run: { id: 'run-a', short_id: 'ra', is_archived: 0, steps: [] } },
    {
      state: 'failure',
      message: '创建失败或已创建',
      run: { id: 'run-b', short_id: 'rb', is_archived: 0, steps: [] },
    },
  ]);

const bulkCreateRunsAllOk = () =>
  jsonResponse([{ state: 'success', run: { id: 'run-a', short_id: 'ra', is_archived: 0, steps: [] } }]);

const bulkUpdateRunsOk = () =>
  jsonResponse([{ state: 'success', run: { id: 'run-1', short_id: 'r4m2', is_archived: 0, steps: [] } }]);

const bulkResult = () => jsonResponse({ inserts: 1, updates: 1, deletes: 1 });

const historyPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 2,
    values: [historyRow, historyRowSecond],
  });

const historyRow = {
  id: 'hist-1',
  run: { id: 'run-1', short_id: 'r4m2' },
  case: { id: 'case-1', identifier: 'LIB-1' },
  plan: { id: 'plan-1', name: '2026 S1 回归' },
  library: { id: 'lib-1', name: '核心测试库' },
  executed_status: { id: 'rs-pass', name: '通过' },
  status: 'pass',
  executed_by: { id: 'user-7', name: '张三' },
  executed_at: 1_730_000_100,
  steps: [],
  remark: 'first',
};

// A row whose run/case refs carry neither short_id nor identifier — refLabel must
// fall back to refName (the name, then the id).
const historyRowSecond = {
  id: 'hist-2',
  run: { id: 'run-9', name: '运行九' },
  case: { id: 'case-9', name: '用例九' },
  plan: { id: 'plan-1', name: '2026 S1 回归' },
  library: { id: 'lib-1', name: '核心测试库' },
  executed_status: { id: 'rs-block', name: '受阻' },
  status: 'block',
  executed_by: { id: 'user-7', name: '张三' },
  executed_at: 1_730_000_200,
  steps: [{ step_id: 'st-1' }],
  remark: 'second',
};

// ===========================================================================
// runs list
// ===========================================================================

describe('testhub runs list', () => {
  it('resolves library, plan, status and executor, then POSTs the merged search filter', async () => {
    const run = await h.run(
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
        '--executor',
        'zhangsan',
        '--json',
      ],
      [librariesPage, plansPage, runStatusesPage, usersPage, runsSearchPage],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/libraries');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plans');
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/run/statuses');
    expect(new URL(run.calls[2]?.url ?? '').searchParams.get('library_id')).toBe('lib-1');
    expect(pathOf(run.calls[3])).toBe('/v1/directory/users');
    expect(pathOf(run.calls[4])).toBe('/v1/testhub/runs/search');
    expect(run.calls[4]?.method).toBe('POST');
    expect(run.calls[4]?.body).toMatchObject({
      payload: {
        filter: {
          'plan.id': { in: ['plan-1'] },
          'latest_executed_status.id': { in: ['rs-pass'] },
          'executor.id': { in: ['user-7'] },
        },
      },
    });
  });

  it('forwards --keywords and a bare --case-id as search filters', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'list',
        '--library',
        'LIB',
        '--case-id',
        'case-1',
        '--keywords',
        '登录',
        '--json',
      ],
      [librariesPage, runsSearchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown>; keywords: string } };
    expect(body.payload.filter).toMatchObject({ 'case.id': { in: ['case-1'] } });
    expect(body.payload.keywords).toBe('登录');
  });

  it('resolves an executor by name with no library at all — users are org-level', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'list', '--executor', 'zhangsan', '--json'],
      [usersPage, runsSearchPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(pathOf(run.calls[0])).toBe('/v1/directory/users');
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter).toMatchObject({ 'executor.id': { in: ['user-7'] } });
  });

  it('sends only the run search when every reference is an id', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'list',
        '--library-id',
        'lib-1',
        '--plan-id',
        'plan-1',
        '--status-id',
        'rs-pass',
        '--executor-id',
        'user-7',
        '--case-id',
        'case-1',
        '--json',
      ],
      [runsSearchPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/search');
  });

  it('forwards --page and --page-size inside the search payload body', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'list',
        '--library',
        'LIB',
        '--page',
        '2',
        '--page-size',
        '5',
        '--json',
      ],
      [librariesPage, runsSearchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { page_index: number; page_size: number } };
    expect(body.payload.page_index).toBe(2);
    expect(body.payload.page_size).toBe(5);
  });

  it('--all walks every page and emits {values,count,all}', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'list', '--library', 'LIB', '--all', '--json'],
      [librariesPage, runsSearchPage],
    );
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toEqual({
      values: [
        {
          id: 'run-1',
          short_id: 'r4m2',
          case: { id: 'case-1', name: '登录' },
          latest_executed_status: { id: 'rs-pass', name: '通过' },
          executor: { id: 'user-7', name: '张三' },
          is_archived: false,
          is_deleted: false,
          steps: [],
        },
      ],
      count: 1,
      all: true,
    });
  });

  it('renders a table on stdout and the page count on stderr in human mode', async () => {
    const run = await h.run(['testhub', 'runs', 'list', '--library', 'LIB'], [
      librariesPage,
      runsSearchPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('CASE');
    expect(run.stdout).toContain('登录');
    expect(run.stderr).toContain('row(s)');
    // the library-without-plan caveat is a stderr note, never stdout
    expect(run.stderr).toContain('cannot filter by library.id');
    expect(run.stdout).not.toContain('cannot filter by library.id');
  });

  it('requires a library before resolving a plan name', async () => {
    const run = await h.run(['testhub', 'runs', 'list', '--plan', '2026 S1 回归', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });

  it('requires a library before resolving a status name', async () => {
    const run = await h.run(['testhub', 'runs', 'list', '--status', '通过', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ===========================================================================
// runs create
// ===========================================================================

describe('testhub runs create', () => {
  it('resolves library, plan and case, then POSTs the four ids', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'create',
        '--library',
        'LIB',
        '--plan',
        '2026 S1 回归',
        '--case',
        'c9y3',
        '--executor',
        'zhangsan',
        '--json',
      ],
      [librariesPage, plansPage, caseDetail, usersPage, createdRun],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/libraries');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plans');
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/cases/c9y3');
    expect(pathOf(run.calls[3])).toBe('/v1/directory/users');
    expect(writes(run)).toHaveLength(1);
    expect(pathOf(writes(run)[0])).toBe('/v1/testhub/runs');
    expect(writes(run)[0]?.body).toEqual({
      library_id: 'lib-1',
      plan_id: 'plan-1',
      case_id: 'case-1',
      executor_id: 'user-7',
    });
    expect(parseStdout(run)).toMatchObject({ id: 'run-new', short_id: 'rn1' });
  });

  it('skips the case read when --case-id is given and omits executor_id when none named', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'create',
        '--library',
        'LIB',
        '--plan',
        '2026 S1 回归',
        '--case-id',
        'case-1',
        '--json',
      ],
      [librariesPage, plansPage, createdRun],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(writes(run)[0]?.body).toEqual({
      library_id: 'lib-1',
      plan_id: 'plan-1',
      case_id: 'case-1',
    });
  });

  it('--dry-run resolves the references but writes nothing', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'create',
        '--library',
        'LIB',
        '--plan',
        '2026 S1 回归',
        '--case',
        'c9y3',
        '--executor',
        'zhangsan',
        '--dry-run',
        '--json',
      ],
      [librariesPage, plansPage, caseDetail, usersPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { method: string; body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.body).toEqual({
      library_id: 'lib-1',
      plan_id: 'plan-1',
      case_id: 'case-1',
      executor_id: 'user-7',
    });
    expect(writes(run)).toHaveLength(0);
    // four reads happened: ids really are resolved under --dry-run
    expect(run.calls).toHaveLength(4);
  });

  it('prints the created notice on stderr and keeps stdout the resource in human mode', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'create', '--library', 'LIB', '--plan', '2026 S1 回归', '--case-id', 'case-1'],
      [librariesPage, plansPage, createdRun],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created rn1');
    expect(run.stdout).toContain('run-new');
    expect(run.stderr).not.toContain('run-new');
  });

  it('requires --plan, --case and --library up front, sending nothing', async () => {
    const noPlan = await h.run(
      ['testhub', 'runs', 'create', '--library-id', 'lib-1', '--case-id', 'case-1', '--json'],
      [],
    );
    expect(noPlan.exit).toBe(2);
    expect(noPlan.calls).toHaveLength(0);
    expect(noPlan.stderr).toContain('--plan');

    const noCase = await h.run(
      ['testhub', 'runs', 'create', '--library-id', 'lib-1', '--plan-id', 'plan-1', '--json'],
      [],
    );
    expect(noCase.exit).toBe(2);
    expect(noCase.calls).toHaveLength(0);
    expect(noCase.stderr).toContain('--case');

    const noLibrary = await h.run(
      ['testhub', 'runs', 'create', '--case-id', 'case-1', '--plan-id', 'plan-1', '--json'],
      [],
    );
    expect(noLibrary.exit).toBe(2);
    expect(noLibrary.calls).toHaveLength(0);
    expect(noLibrary.stderr).toContain('--library');
  });
});

// ===========================================================================
// runs update — the read-then-patch contract (design §7)
// ===========================================================================

describe('testhub runs update', () => {
  it('re-emits the current status_id and executor_id when neither was given', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--remark', 'x', '--json'],
      [runDetail, patchedRun],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/run-1');
    expect(writes(run)).toHaveLength(1);
    expect(writes(run)[0]?.body).toEqual({
      status_id: 'rs-pass',
      executor_id: 'user-7',
      remark: 'x',
    });
  });

  it('resolves a short_id to a real id via the pre-read, then patches the id-only path', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'r4m2', '--status-id', 'rs-block', '--json'],
      [runDetail, patchedRun],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/r4m2');
    expect(pathOf(writes(run)[0])).toBe('/v1/testhub/runs/run-1');
    expect(writes(run)[0]?.body).toEqual({ status_id: 'rs-block', executor_id: 'user-7' });
  });

  it('overrides the executor with --executor-id, resolved against the directory', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--status-id', 'rs-block', '--executor-id', 'user-9', '--json'],
      [runDetail, patchedRun],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(writes(run)[0]?.body).toEqual({ status_id: 'rs-block', executor_id: 'user-9' });
  });

  it('resolves --executor by name and sends the resolved id', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--status-id', 'rs-block', '--executor', 'zhangsan', '--json'],
      [runDetail, usersPage, patchedRun],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/directory/users');
    expect(writes(run)[0]?.body).toEqual({ status_id: 'rs-block', executor_id: 'user-7' });
  });

  it('resolves --status by name against the library the run reports', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--status', '受阻', '--json'],
      [runDetail, runStatusesPage, patchedRun],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/run/statuses');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('library_id')).toBe('lib-1');
    expect(writes(run)[0]?.body).toEqual({ status_id: 'rs-block', executor_id: 'user-7' });
  });

  it('resolves --status by name against an explicitly named library', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--library', 'LIB', '--status', '受阻', '--json'],
      [runDetail, librariesPage, runStatusesPage, patchedRun],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries');
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/run/statuses');
    expect(writes(run)[0]?.body).toEqual({ status_id: 'rs-block', executor_id: 'user-7' });
  });

  it('omits executor_id, with a warning, when the run is unassigned and none was named', async () => {
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
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-3', '--remark', 'smoke', '--json'],
      [unassigned, patchedRun],
    );
    expect(run.exit).toBe(0);
    const body = writes(run)[0]?.body as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('executor_id');
    expect(body).toEqual({ status_id: 'rs-pass', remark: 'smoke' });
    expect(run.stderr).toContain('has no executor');
    expect(run.stderr).toContain('stays unassigned');
  });

  it('refuses when the run was never executed and no --status was given', async () => {
    const never = () =>
      jsonResponse({
        id: 'run-2',
        short_id: 'r0',
        library: { id: 'lib-1' },
        executor: { id: 'user-7', name: '张三' },
        steps: [],
        is_archived: 0,
      });
    const run = await h.run(['testhub', 'runs', 'update', 'run-2', '--remark', 'x', '--json'], [never]);
    expect(run.exit).toBe(2);
    expect(writes(run)).toHaveLength(0);
    expect(run.stderr).toContain('--status is required');
  });

  it('cannot resolve a status name when the run reports no library', async () => {
    const noLibrary = () =>
      jsonResponse({
        id: 'run-5',
        short_id: 'r5',
        latest_executed_status: { id: 'rs-pass', name: '通过' },
        executor: { id: 'user-7', name: '张三' },
        steps: [],
        is_archived: 0,
      });
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-5', '--status', '受阻', '--json'],
      [noLibrary],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(writes(run)).toHaveLength(0);
    expect(run.stderr).toContain('did not report a library');
  });

  it('replaces the whole steps array when every step is given a status', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'update',
        'run-1',
        '--step',
        'st-1=通过',
        '--step',
        'st-2=受阻',
        '--step-actual',
        'st-2=timed out',
        '--json',
      ],
      [runDetail, runStatusesPage, patchedRun],
    );
    expect(run.exit).toBe(0);
    expect(writes(run)[0]?.body).toEqual({
      status_id: 'rs-pass',
      executor_id: 'user-7',
      steps: [
        { step_id: 'st-1', status_id: 'rs-pass' },
        { step_id: 'st-2', status_id: 'rs-block', actual_value: 'timed out' },
      ],
    });
    expect(run.stderr).toContain('replacing all 2 step(s)');
  });

  it('refuses a partial step edit rather than orphaning the untouched steps', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--step', 'st-1=通过', '--json'],
      [runDetail],
    );
    expect(run.exit).toBe(2);
    expect(writes(run)).toHaveLength(0);
    expect(run.stderr).toContain('every step needs a status');
  });

  it('refuses a step the run does not have, naming it and listing the real steps', async () => {
    const run = await h.run(['testhub', 'runs', 'update', 'run-1', '--step', 'st-9=通过'], [runDetail]);
    expect(run.exit).toBe(2);
    expect(writes(run)).toHaveLength(0);
    // human mode keeps the hint on stderr, where the run's real steps are listed
    expect(run.stderr).toContain('no step(s) st-9');
    expect(run.stderr).toContain('st-1');
    expect(run.stderr).toContain('st-2');
  });

  it('refuses --step on a run that reports no steps', async () => {
    const noSteps = () =>
      jsonResponse({
        id: 'run-6',
        short_id: 'r6',
        latest_executed_status: { id: 'rs-pass', name: '通过' },
        executor: { id: 'user-7', name: '张三' },
        steps: [],
        is_archived: 0,
      });
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-6', '--step', 'st-1=通过', '--json'],
      [noSteps],
    );
    expect(run.exit).toBe(2);
    expect(writes(run)).toHaveLength(0);
    expect(run.stderr).toContain('reports no steps');
  });

  it('rejects a malformed --step (no key=value) before the run is read', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--step', 'bogus', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--step expects key=value');
  });

  it('surfaces a failed pre-read and never attempts the PATCH', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'nope', '--status-id', 'rs-pass', '--json'],
      [() => jsonResponse({ code: '100317', message: '不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.calls).toHaveLength(1);
    expect(writes(run)).toHaveLength(0);
  });

  it('--dry-run shows the inherited body and sends nothing', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--status', '受阻', '--dry-run', '--json'],
      [runDetail, runStatusesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ status_id: 'rs-block', executor_id: 'user-7' });
    expect(writes(run)).toHaveLength(0);
  });

  it('prints the updated notice on stderr in human mode', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'update', 'run-1', '--status-id', 'rs-block'],
      [runDetail, patchedRun],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('updated r4m2');
    expect(run.stdout).toContain('run-1');
  });
});

// ===========================================================================
// runs bulk-create
// ===========================================================================

describe('testhub runs bulk-create', () => {
  it('resolves --case refs and --case-id ids, then POSTs one run per case', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk-create',
        '--library',
        'LIB',
        '--plan',
        '2026 S1 回归',
        '--case',
        'c9y3',
        '--case-id',
        'case-2',
        '--executor',
        'zhangsan',
        '--json',
      ],
      [librariesPage, plansPage, caseDetail, usersPage, bulkCreateRunsAllOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/libraries');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plans');
    // the ref costs a case read; the id does not
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/cases/c9y3');
    expect(pathOf(run.calls[3])).toBe('/v1/directory/users');
    expect(writes(run)[0]?.body).toEqual({
      runs: [
        { library_id: 'lib-1', plan_id: 'plan-1', case_id: 'case-2', executor_id: 'user-7' },
        { library_id: 'lib-1', plan_id: 'plan-1', case_id: 'case-1', executor_id: 'user-7' },
      ],
    });
  });

  it('surfaces the per-element failure and keeps stdout JSON-only', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--plan-id',
        'plan-1',
        '--case-id',
        'case-1',
        '--case-id',
        'case-2',
      ],
      [bulkCreateRunsOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('创建失败或已创建');
    expect(run.stderr).toContain('1 of 2 entries failed');
  });

  it('--dry-run resolves nothing extra and writes nothing', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--plan-id',
        'plan-1',
        '--case-id',
        'case-1',
        '--dry-run',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(0);
    expect(writes(run)).toHaveLength(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({
      runs: [{ library_id: 'lib-1', plan_id: 'plan-1', case_id: 'case-1' }],
    });
  });

  it('caps at 100 cases and refuses an empty case list, before any request', async () => {
    const many = Array.from({ length: 101 }, (_, index) => ['--case-id', `case-${index}`]).flat();
    const capped = await h.run(
      ['testhub', 'runs', 'bulk-create', '--library-id', 'lib-1', '--plan-id', 'plan-1', ...many, '--json'],
      [],
    );
    expect(capped.exit).toBe(2);
    expect(capped.calls).toHaveLength(0);

    const empty = await h.run(
      ['testhub', 'runs', 'bulk-create', '--library-id', 'lib-1', '--plan-id', 'plan-1', '--json'],
      [],
    );
    expect(empty.exit).toBe(2);
    expect(empty.calls).toHaveLength(0);
    expect(empty.stderr).toContain('nothing to add');
  });

  it('requires --plan and --library up front', async () => {
    const noPlan = await h.run(
      ['testhub', 'runs', 'bulk-create', '--library-id', 'lib-1', '--case-id', 'case-1', '--json'],
      [],
    );
    expect(noPlan.exit).toBe(2);
    expect(noPlan.calls).toHaveLength(0);
    expect(noPlan.stderr).toContain('--plan');

    const noLibrary = await h.run(
      ['testhub', 'runs', 'bulk-create', '--plan-id', 'plan-1', '--case-id', 'case-1', '--json'],
      [],
    );
    expect(noLibrary.exit).toBe(2);
    expect(noLibrary.calls).toHaveLength(0);
    expect(noLibrary.stderr).toContain('--library');
  });

  it('prints the success count on stderr in human mode', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--plan-id',
        'plan-1',
        '--case-id',
        'case-1',
      ],
      [bulkCreateRunsAllOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created 1 run(s)');
  });
});

// ===========================================================================
// runs bulk-update — the --run form (the --file form lives in testhubEntries)
// ===========================================================================

describe('testhub runs bulk-update --run', () => {
  it('resolves each short_id to a real id first, then PATCHes the batch with one status', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk-update',
        '--run',
        'r4m2',
        '--run-id',
        'run-2',
        '--library',
        'LIB',
        '--status',
        '通过',
        '--remark',
        'ok',
        '--json',
      ],
      [runDetail, librariesPage, runStatusesPage, bulkUpdateRunsOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    // the ref costs a run read; the id is passed through
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/r4m2');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries');
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/run/statuses');
    expect(writes(run)[0]?.body).toEqual({
      runs: [
        { run_id: 'run-1', status_id: 'rs-pass', remark: 'ok' },
        { run_id: 'run-2', status_id: 'rs-pass', remark: 'ok' },
      ],
    });
  });

  it('passes --status-id through with no status lookup, and needs no library', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--run-id', 'run-1', '--status-id', 'rs-pass', '--json'],
      [bulkUpdateRunsOk],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(writes(run)[0]?.body).toEqual({ runs: [{ run_id: 'run-1', status_id: 'rs-pass' }] });
  });

  it('--dry-run resolves the ids and prints the plan but writes nothing', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk-update',
        '--run',
        'r4m2',
        '--library-id',
        'lib-1',
        '--status-id',
        'rs-pass',
        '--dry-run',
        '--json',
      ],
      [runDetail],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ runs: [{ run_id: 'run-1', status_id: 'rs-pass' }] });
    expect(writes(run)).toHaveLength(0);
  });

  it('requires a status: this endpoint has no remark-only mode', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--run-id', 'run-1', '--remark', 'ok', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--status');
  });

  it('requires a library to resolve a status name in the --run form', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--run-id', 'run-1', '--status', '通过', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });

  it('refuses --file alongside --run', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk-update',
        '--run-id',
        'run-1',
        '--status-id',
        'rs-pass',
        '--file',
        '-',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--file cannot be combined');
  });

  it('is exit 2 when no run was named and no --file was given', async () => {
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('testhub runs bulk-update --file (run-side extras)', () => {
  it('resolves an entry-level executor by name with an id status, needing no library', async () => {
    const file = writeEntries(
      JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass', executor: 'zhangsan' }]),
    );
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--file', file, '--json'],
      [usersPage, bulkUpdateRunsOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/directory/users');
    expect(writes(run)[0]?.body).toEqual({
      runs: [{ run_id: 'run-1', status_id: 'rs-pass', executor_id: 'user-7' }],
    });
  });

  it('resolves an entry-level status name against the named library', async () => {
    const file = writeEntries(JSON.stringify([{ run_id: 'run-1', status: '通过' }]));
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--library', 'LIB', '--file', file, '--json'],
      [librariesPage, runStatusesPage, bulkUpdateRunsOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/libraries');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/run/statuses');
    expect(writes(run)[0]?.body).toEqual({ runs: [{ run_id: 'run-1', status_id: 'rs-pass' }] });
  });

  it('resolves a --run ref inside a file entry through the run read', async () => {
    const file = writeEntries(JSON.stringify([{ run: 'r4m2', status_id: 'rs-pass' }]));
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--file', file, '--json'],
      [runDetail, bulkUpdateRunsOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/r4m2');
    expect(writes(run)[0]?.body).toEqual({ runs: [{ run_id: 'run-1', status_id: 'rs-pass' }] });
  });

  it('refuses an entry that sets both run and run_id', async () => {
    const file = writeEntries(
      JSON.stringify([{ run: 'r4m2', run_id: 'run-1', status_id: 'rs-pass' }]),
    );
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--file', file, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('both run and run_id');
  });

  it('refuses an entry that names no run', async () => {
    const file = writeEntries(JSON.stringify([{ status_id: 'rs-pass' }]));
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--file', file, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('names no run');
  });

  it('refuses a file entry that carries no status at all', async () => {
    const file = writeEntries(JSON.stringify([{ run_id: 'run-1', remark: 'a' }]));
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--file', file, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('names no status');
  });

  it('applies the global --executor to an entry that names none', async () => {
    const file = writeEntries(JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass' }]));
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--file', file, '--executor', 'zhangsan', '--json'],
      [usersPage, bulkUpdateRunsOk],
    );
    expect(run.exit).toBe(0);
    expect(writes(run)[0]?.body).toEqual({
      runs: [{ run_id: 'run-1', status_id: 'rs-pass', executor_id: 'user-7' }],
    });
  });

  it('lets an entry-level executor_id override the global one, sent verbatim', async () => {
    const file = writeEntries(
      JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass', executor_id: 'user-9' }]),
    );
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--file', file, '--json'],
      [bulkUpdateRunsOk],
    );
    expect(run.exit).toBe(0);
    expect(writes(run)[0]?.body).toEqual({
      runs: [{ run_id: 'run-1', status_id: 'rs-pass', executor_id: 'user-9' }],
    });
  });
});

// ===========================================================================
// runs bulk — insert + update + delete in one call
// ===========================================================================

describe('testhub runs bulk', () => {
  it('inserts, updates and deletes in a single POST scoped to the plan', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk',
        '--library',
        'LIB',
        '--plan',
        '2026 S1 回归',
        '--add-case',
        'case-1',
        '--set-status',
        'run-1=通过',
        '--remove-run',
        'run-2',
        '--executor',
        'zhangsan',
        '--json',
      ],
      [librariesPage, plansPage, usersPage, runStatusesPage, bulkResult],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/libraries');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plans');
    expect(pathOf(run.calls[2])).toBe('/v1/directory/users');
    expect(pathOf(run.calls[3])).toBe('/v1/testhub/run/statuses');
    expect(writes(run)[0]?.body).toEqual({
      inserts: [{ case_id: 'case-1', executor_id: 'user-7' }],
      updates: [{ run_id: 'run-1', status_id: 'rs-pass', executor_id: 'user-7' }],
      deletes: ['run-2'],
    });
    expect(pathOf(writes(run)[0])).toBe('/v1/testhub/libraries/lib-1/plans/plan-1/runs/bulk');
    expect(parseStdout(run)).toMatchObject({ inserts: 1, updates: 1, deletes: 1 });
  });

  it('omits executor_id from inserts/updates when none was named', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk',
        '--library-id',
        'lib-1',
        '--plan-id',
        'plan-1',
        '--add-case',
        'case-1',
        '--set-status',
        'run-1=通过',
        '--json',
      ],
      [runStatusesPage, bulkResult],
    );
    expect(run.exit).toBe(0);
    expect(writes(run)[0]?.body).toEqual({
      inserts: [{ case_id: 'case-1' }],
      updates: [{ run_id: 'run-1', status_id: 'rs-pass' }],
    });
  });

  it('resolves a short_id plan into the bulk URL', async () => {
    const run = await h.run(
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
    expect(pathOf(writes(run)[0])).toBe('/v1/testhub/libraries/lib-1/plans/plan-1/runs/bulk');
  });

  it('--dry-run resolves the plan and prints the plan, writing nothing', async () => {
    const run = await h.run(
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
        '--set-status',
        'run-1=通过',
        '--dry-run',
        '--json',
      ],
      [librariesPage, plansPage, runStatusesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({
      inserts: [{ case_id: 'case-1' }],
      updates: [{ run_id: 'run-1', status_id: 'rs-pass' }],
    });
    expect(writes(run)).toHaveLength(0);
  });

  it('prints the counts on stdout and the "counts only" note on stderr in human mode', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk',
        '--library',
        'LIB',
        '--plan',
        '2026 S1 回归',
        '--add-case',
        'case-1',
      ],
      [librariesPage, plansPage, bulkResult],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('inserted');
    expect(run.stderr).toContain('counts only');
  });

  it('caps each of the three lists independently at 50', async () => {
    for (const [flag, sample] of [
      ['--add-case', 'case-x'],
      ['--remove-run', 'run-x'],
    ] as const) {
      const argv = ['testhub', 'runs', 'bulk', '--library-id', 'lib-1', '--plan-id', 'plan-1'];
      for (let index = 0; index < 51; index += 1) argv.push(flag, `${sample}-${index}`);
      const run = await h.run([...argv, '--json'], []);
      expect(run.exit, flag).toBe(2);
      expect(run.calls, flag).toHaveLength(0);
      expect(run.stderr, flag).toContain('50');
    }
  });

  it('rejects a malformed --set-status (no key=value) before any request', async () => {
    const run = await h.run(
      [
        'testhub',
        'runs',
        'bulk',
        '--library-id',
        'lib-1',
        '--plan-id',
        'plan-1',
        '--set-status',
        'run-1',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--set-status expects key=value');
  });

  it('is exit 2 when no work was described, and when no plan was given', async () => {
    const noWork = await h.run(
      ['testhub', 'runs', 'bulk', '--library', 'LIB', '--plan', 'x', '--json'],
      [],
    );
    expect(noWork.exit).toBe(2);
    expect(noWork.calls).toHaveLength(0);
    expect(noWork.stderr).toContain('nothing to do');

    const noPlan = await h.run(
      ['testhub', 'runs', 'bulk', '--library', 'LIB', '--add-case', 'case-1', '--json'],
      [],
    );
    expect(noPlan.exit).toBe(2);
    expect(noPlan.calls).toHaveLength(0);
    expect(noPlan.stderr).toContain('--plan');
  });
});

// ===========================================================================
// runs history list / get
// ===========================================================================

describe('testhub runs history list', () => {
  it('reads the run (accepting a short_id) then lists its id-only histories', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'history', 'list', 'r4m2', '--json'],
      [runDetail, historyPage],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/r4m2');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/runs/run-1/histories');
    const out = parseStdout(run) as { total: number; values: unknown[] };
    expect(out.total).toBe(2);
    expect(out.values).toHaveLength(2);
  });

  it('--all walks every history page and emits {values,count,all}', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'history', 'list', 'run-1', '--all', '--json'],
      [runDetail, historyPage],
    );
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toEqual({ values: [historyRow, historyRowSecond], count: 2, all: true });
  });

  it('renders the history table on stdout and the page count on stderr in human mode', async () => {
    const run = await h.run(['testhub', 'runs', 'history', 'list', 'run-1'], [runDetail, historyPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('WHEN');
    expect(run.stdout).toContain('RESULT');
    expect(run.stderr).toContain('row(s)');
  });

  it('surfaces a failed run pre-read and never lists histories', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'history', 'list', 'nope', '--json'],
      [() => jsonResponse({ code: '100317', message: '不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.calls).toHaveLength(1);
  });
});

describe('testhub runs history get', () => {
  it('reads the run then fetches one history record by id', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'history', 'get', 'run-1', 'hist-1', '--json'],
      [runDetail, () => jsonResponse(historyRow)],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/runs/run-1');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/runs/run-1/histories/hist-1');
    expect(parseStdout(run)).toMatchObject({ id: 'hist-1' });
  });

  it('falls back to the id when a run/case ref carries no short_id / identifier', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'history', 'get', 'run-1', 'hist-2', '--json'],
      [runDetail, () => jsonResponse(historyRowSecond)],
    );
    expect(run.exit).toBe(0);
    // refLabel must have picked the name, not printed an empty cell
    expect(parseStdout(run)).toMatchObject({ id: 'hist-2' });
  });

  it('renders the curated field block on stdout in human mode', async () => {
    const run = await h.run(
      ['testhub', 'runs', 'history', 'get', 'run-1', 'hist-1'],
      [runDetail, () => jsonResponse(historyRow)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('result');
    expect(run.stdout).toContain('通过');
    expect(run.stdout).toContain('remark');
  });
});
