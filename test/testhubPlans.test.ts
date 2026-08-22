import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness, type CliRun } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * Coverage for `src/cli/commands/testhub/plans.ts` — `testhub plans {list,get,create,update}`.
 *
 * This suite drives the **real** tree through `createCliHarness` (`buildProgram()`),
 * so every assertion is against the root the binary actually runs. No network: the
 * harness swaps in a fake `fetch`, and each test runs in its own temp config dir, so
 * the metadata cache is empty per test and never contaminates a sibling.
 *
 * What is exercised here beyond the shared `testhubCommands` suite:
 *  - `list --name` (the substring filter) and `list --all` (the `iteratePlans` +
 *    `printCollection({all:true})` branch, distinct from the single-page `listPlans` +
 *    `printPage` branch);
 *  - `get` by id / short_id / name, and the human-mode field block;
 *  - `create` with `--type-id` / `--assignee-id` (the `passThrough` half of
 *    `resolvePair`, which skips every lookup), the human-mode "created" notice, the
 *    TZ-pinned 00:00:00 / 23:59:59 boundary rule and the unix-seconds verbatim form;
 *  - `update`'s empty-patch and empty-summary refusals, every `--x` / `--x-id` pair
 *    (`--state`/`--type`/`--assignee` and their `-id` siblings), the name → id + all
 *    byId full patch, `--dry-run` (reads still run, nothing is written) and human mode.
 */

// The harness owns a temp config dir per test via these hooks.
const h = createCliHarness({ beforeEach, afterEach });

function pathOf(call: { url: string } | undefined): string {
  return new URL(call?.url ?? 'https://x.invalid/').pathname;
}

function parseStdout(run: CliRun): unknown {
  expect(run.stdout.trim(), `stdout was not pure JSON:\n${run.stdout}`).not.toBe('');
  return JSON.parse(run.stdout) as unknown;
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

const planStatesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 3,
    values: [
      { id: 'ps-todo', name: '未开始', type: 'pending', is_system: 1 },
      { id: 'ps-doing', name: '进行中', type: 'in_progress', is_system: 1 },
      { id: 'ps-done', name: '已完成', type: 'completed', is_system: 1 },
    ],
  });

/** The plan a `get` / `update` resolves and returns. */
const planDetail = () =>
  jsonResponse({
    id: 'plan-1',
    short_id: 'p8x2k1',
    name: '2026 S1 回归',
    library: { id: 'lib-1', name: '核心测试库' },
    type: { id: 'pt-plain', name: '普通测试' },
    state: { id: 'ps-doing', name: '进行中' },
    assignee: { id: 'user-7', name: '张三' },
    start_at: 1_786_291_200,
    end_at: 1_788_191_999,
    created_at: 1_730_000_000,
    updated_at: 1_730_000_000,
    html_url: 'https://example.com/plan-1',
    summary: 'initial',
  });

/** The `create` POST response — short_id is what the human notice echoes. */
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

/** A canonical `plans create` argv with every required flag spelled out by name. */
function createArgv(extra: string[] = []): string[] {
  return [
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
}

/** Run `body` under a fixed zone, restoring the previous `TZ` afterwards. */
async function withTz<T>(tz: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

// ---------------------------------------------------------------------------
// plans list
// ---------------------------------------------------------------------------

describe('testhub plans list', () => {
  it('is addressed under the resolved library', async () => {
    const run = await h.run(['testhub', 'plans', 'list', '--library', 'LIB', '--json'], [
      librariesPage,
      plansPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plans');
    expect(parseStdout(run)).toMatchObject({ total: 1, values: [{ id: 'plan-1' }] });
  });

  it('forwards --name as the substring filter the server performs', async () => {
    const run = await h.run(['testhub', 'plans', 'list', '--library', 'LIB', '--name', 'S1', '--json'], [
      librariesPage,
      plansPage,
    ]);
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('name')).toBe('S1');
  });

  it('--all walks every page and emits {values,count,all}', async () => {
    const run = await h.run(['testhub', 'plans', 'list', '--library', 'LIB', '--all', '--json'], [
      librariesPage,
      plansPage,
    ]);
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toEqual({
      values: [{ id: 'plan-1', short_id: 'p8x2k1', name: '2026 S1 回归' }],
      count: 1,
      all: true,
    });
  });

  it('passes a custom --page-size through to the single-page list', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'list', '--library', 'LIB', '--page-size', '5', '--json'],
      [librariesPage, plansPage],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('page_size')).toBe('5');
  });

  it('renders a table on stdout and the page count on stderr in human mode', async () => {
    const run = await h.run(['testhub', 'plans', 'list', '--library', 'LIB'], [
      librariesPage,
      plansPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('NAME');
    expect(run.stdout).toContain('2026 S1 回归');
    expect(run.stderr).toContain('page 0');
    expect(run.stderr).toContain('row(s)');
    expect(run.stdout).not.toContain('row(s)');
  });

  it('requires a library, because the plan URL contains one', async () => {
    const run = await h.run(['testhub', 'plans', 'list', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });
});

// ---------------------------------------------------------------------------
// plans get
// ---------------------------------------------------------------------------

describe('testhub plans get', () => {
  it('accepts an id and sends it to the id-only path', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'get', 'plan-1', '--library-id', 'lib-1', '--json'],
      [plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    // The id still goes through name resolution (exact id match), so the list is
    // fetched once; the resolved real id — never the short_id — reaches the path.
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plans/plan-1');
    expect(parseStdout(run)).toMatchObject({ id: 'plan-1', name: '2026 S1 回归' });
  });

  it('resolves a short_id to a real id before the GET', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'get', 'p8x2k1', '--library', 'LIB', '--json'],
      [librariesPage, plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plans');
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/libraries/lib-1/plans/plan-1');
  });

  it('resolves a name to a plan, then fetches it by id', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'get', '2026 S1 回归', '--library', 'LIB', '--json'],
      [librariesPage, plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/libraries/lib-1/plans/plan-1');
    expect(parseStdout(run)).toMatchObject({ short_id: 'p8x2k1' });
  });

  it('renders the curated field block on stdout in human mode', async () => {
    const run = await h.run(['testhub', 'plans', 'get', 'plan-1', '--library', 'LIB'], [
      librariesPage,
      plansPage,
      planDetail,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('2026 S1 回归');
    expect(run.stdout).toContain('summary');
    expect(run.stdout).toContain('initial');
  });

  it('requires a library', async () => {
    const run = await h.run(['testhub', 'plans', 'get', 'plan-1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('requires the <plan> argument', async () => {
    const run = await h.run(['testhub', 'plans', 'get', '--library', 'LIB', '--json'], []);
    expect(run.exit).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// plans create
// ---------------------------------------------------------------------------

describe('testhub plans create', () => {
  it('resolves library, type and assignee, then POSTs exactly the five fields', async () => {
    const run = await h.run(createArgv(['--json']), [
      librariesPage,
      planTypesPage,
      usersPage,
      created,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plan_types');
    expect(pathOf(run.calls[2])).toBe('/v1/directory/users');
    expect(run.writes).toHaveLength(1);
    expect(pathOf(run.writes[0])).toBe('/v1/testhub/libraries/lib-1/plans');
    const body = run.writes[0]?.body as Record<string, unknown>;
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
    // The conditionally-required fields are never guessed at.
    expect('project_id' in body).toBe(false);
    expect('sprint_id' in body).toBe(false);
    expect('version_id' in body).toBe(false);
    expect(parseStdout(run)).toMatchObject({ id: 'plan-new', short_id: 'ab12' });
  });

  it('passes --type-id / --assignee-id through with no lookups at all', async () => {
    const run = await h.run(
      [
        'testhub',
        'plans',
        'create',
        '--library',
        'LIB',
        '--name',
        'P',
        '--type-id',
        'pt-plain',
        '--start',
        '2026-08-10',
        '--end',
        '2026-08-31',
        '--assignee-id',
        'user-7',
        '--json',
      ],
      [librariesPage, created],
    );
    expect(run.exit).toBe(0);
    // Only the library was resolved; type and assignee are verbatim ids.
    expect(run.calls).toHaveLength(2);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.body).toMatchObject({ type_id: 'pt-plain', assignee_id: 'user-7' });
  });

  it('maps --start to 00:00:00 and --end to 23:59:59 of the local day', async () => {
    const run = await withTz('Asia/Shanghai', () =>
      h.run(createArgv(['--dry-run', '--json']), [librariesPage, planTypesPage, usersPage]),
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { request: { body: { start_at: number; end_at: number } } };
    // The literals the API must receive for "10 through 31 August" in UTC+8.
    expect(plan.request.body.start_at).toBe(1_786_291_200);
    expect(plan.request.body.end_at).toBe(1_788_191_999);
    expect(plan.request.body.end_at - plan.request.body.start_at).toBe(21 * 86_400 + 86_399);
  });

  it('accepts a 10-digit unix seconds value verbatim on either date flag', async () => {
    const run = await h.run(
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
    const run = await h.run(createArgv(['--dry-run', '--json']), [
      librariesPage,
      planTypesPage,
      usersPage,
    ]);
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/testhub/libraries/lib-1/plans');
    expect(run.writes).toHaveLength(0);
    // three reads happened: ids really are resolved under --dry-run
    expect(run.calls).toHaveLength(3);
  });

  it('rejects a malformed date at exit 2 before any request', async () => {
    for (const [flag, value] of [
      ['--start', '2026-8-1'],
      ['--end', '08/31/2026'],
      ['--end', '1786291200000'],
    ] as const) {
      const argv = createArgv(['--json']);
      argv[argv.indexOf(flag) + 1] = value;
      const run = await h.run(argv, []);
      expect(run.exit, `${flag} ${value}`).toBe(2);
      expect(run.calls, `${flag} ${value}`).toHaveLength(0);
    }
  });

  it('rejects an --end that precedes --start, before any request', async () => {
    const argv = createArgv(['--json']);
    argv[argv.indexOf('--end') + 1] = '2026-08-01';
    const run = await h.run(argv, []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('before --start');
  });

  it('requires --type, pointing at the lookup that lists them', async () => {
    const argv = createArgv(['--json']).filter(
      (token, index, all) => token !== '--type' && all[index - 1] !== '--type',
    );
    const run = await h.run(argv, []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--type');
  });

  it('requires --assignee — it must never default to the bot user', async () => {
    const argv = createArgv(['--json']).filter(
      (token, index, all) => token !== '--assignee' && all[index - 1] !== '--assignee',
    );
    const run = await h.run(argv, []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('--assignee');
  });

  it('requires --name', async () => {
    const argv = createArgv(['--json']).filter(
      (token, index, all) => token !== '--name' && all[index - 1] !== '--name',
    );
    const run = await h.run(argv, []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('keeps stdout JSON-only, with the created notice on stderr', async () => {
    const human = await h.run(createArgv(['--no-cache']), [
      librariesPage,
      planTypesPage,
      usersPage,
      created,
    ]);
    expect(human.stderr).toContain('created ab12');
    expect(human.stdout).not.toContain('created ab12');

    const json = await h.run(createArgv(['--no-cache', '--json']), [
      librariesPage,
      planTypesPage,
      usersPage,
      created,
    ]);
    expect(parseStdout(json)).toMatchObject({ id: 'plan-new' });
  });

  it('surfaces the server refusal verbatim for a type it cannot satisfy', async () => {
    // An iteration type needs sprint_id, which the CLI cannot know to send.
    const run = await h.run(
      createArgv(['--json']).map((token) => (token === '普通测试' ? '迭代测试' : token)),
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
// plans update
// ---------------------------------------------------------------------------

describe('testhub plans update', () => {
  it('refuses an empty patch before sending anything (the API answers 200 to one)', async () => {
    const run = await h.run(['testhub', 'plans', 'update', 'p8x2k1', '--library-id', 'lib-1'], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('nothing to update');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses an empty --summary rather than asking the server to clear one', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--summary', '', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('--summary');
  });

  it('resolves the plan and the ORG-level state, then patches only what was given', async () => {
    const run = await h.run(
      [
        'testhub',
        'plans',
        'update',
        '2026 S1 回归',
        '--library',
        'LIB',
        '--state',
        '进行中',
        '--summary',
        'done',
        '--json',
      ],
      [librariesPage, plansPage, planStatesPage, planDetail],
    );
    expect(run.exit).toBe(0);
    // Plan states come from the organisation-level path, with no library_id anywhere.
    const statesUrl = new URL(run.calls[2]?.url ?? '');
    expect(statesUrl.pathname).toBe('/v1/testhub/plan_states');
    expect(statesUrl.searchParams.get('library_id')).toBeNull();

    const patch = run.writes[0];
    expect(pathOf(patch)).toBe('/v1/testhub/libraries/lib-1/plans/plan-1');
    expect(patch?.body).toEqual({ summary: 'done', state_id: 'ps-doing' });
  });

  it('passes --state-id through with no plan-state lookup', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--state-id', 'ps-doing', '--json'],
      [plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.writes[0]?.body).toEqual({ state_id: 'ps-doing' });
  });

  it('resolves --type against the library the plan lives in', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--type', '普通测试', '--json'],
      [plansPage, planTypesPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plan_types');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('library_id')).toBeNull();
    expect(run.writes[0]?.body).toEqual({ type_id: 'pt-plain' });
  });

  it('passes --type-id through with no type lookup', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--type-id', 'pt-plain', '--json'],
      [plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.writes[0]?.body).toEqual({ type_id: 'pt-plain' });
  });

  it('resolves --assignee against the organisation directory', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--assignee', 'zhangsan', '--json'],
      [plansPage, usersPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/directory/users');
    expect(run.writes[0]?.body).toEqual({ assignee_id: 'user-7' });
  });

  it('passes --assignee-id through with no directory lookup', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--assignee-id', 'user-7', '--json'],
      [plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.writes[0]?.body).toEqual({ assignee_id: 'user-7' });
  });

  it('patches a name-only edit without touching anything else', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--name', 'Renamed', '--json'],
      [plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ name: 'Renamed' });
  });

  it('converts --start/--end with the same boundary rule as create', async () => {
    const run = await h.run(
      [
        'testhub',
        'plans',
        'update',
        'plan-1',
        '--library-id',
        'lib-1',
        '--start',
        '2026-08-10',
        '--end',
        '2026-08-31',
        '--json',
      ],
      [plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as { start_at: number; end_at: number };
    // 2026-08-10 00:00:00 → 2026-08-31 23:59:59 is 22 calendar days minus one second.
    expect(body.end_at - body.start_at).toBe(22 * 86_400 - 1);
  });

  it('rejects an inverted window before any request', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--start', '2026-08-31', '--end', '2026-08-10'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('resolves plan, type and assignee together and sends a three-field patch', async () => {
    const run = await h.run(
      [
        'testhub',
        'plans',
        'update',
        '2026 S1 回归',
        '--library',
        'LIB',
        '--type',
        '普通测试',
        '--assignee',
        'zhangsan',
        '--json',
      ],
      [librariesPage, plansPage, planTypesPage, usersPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/libraries/lib-1/plan_types');
    expect(pathOf(run.calls[3])).toBe('/v1/directory/users');
    expect(run.writes[0]?.body).toEqual({ type_id: 'pt-plain', assignee_id: 'user-7' });
  });

  it('resolves state, type and assignee together and sends a full patch', async () => {
    const run = await h.run(
      [
        'testhub',
        'plans',
        'update',
        '2026 S1 回归',
        '--library',
        'LIB',
        '--state',
        '进行中',
        '--type',
        '普通测试',
        '--assignee',
        'zhangsan',
        '--json',
      ],
      [librariesPage, plansPage, planStatesPage, planTypesPage, usersPage, planDetail],
    );
    expect(run.exit).toBe(0);
    const patch = run.writes[0];
    expect(pathOf(patch)).toBe('/v1/testhub/libraries/lib-1/plans/plan-1');
    expect(patch?.body).toEqual({
      state_id: 'ps-doing',
      type_id: 'pt-plain',
      assignee_id: 'user-7',
    });
  });

  it('sends all four reference ids verbatim when only -id flags are given', async () => {
    const run = await h.run(
      [
        'testhub',
        'plans',
        'update',
        'plan-1',
        '--library-id',
        'lib-1',
        '--state-id',
        'ps-doing',
        '--type-id',
        'pt-plain',
        '--assignee-id',
        'user-7',
        '--json',
      ],
      [plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    // Only the plan (resolved from its id) and the PATCH — no lookups for the ids.
    expect(run.calls).toHaveLength(2);
    expect(run.writes[0]?.body).toEqual({
      state_id: 'ps-doing',
      type_id: 'pt-plain',
      assignee_id: 'user-7',
    });
  });

  it('--dry-run resolves the plan, prints the plan on stdout and sends nothing', async () => {
    const run = await h.run(
      [
        'testhub',
        'plans',
        'update',
        'plan-1',
        '--library-id',
        'lib-1',
        '--state-id',
        'ps-doing',
        '--name',
        'Renamed',
        '--dry-run',
        '--json',
      ],
      [plansPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ name: 'Renamed', state_id: 'ps-doing' });
    // The plan lookup (a read) still ran; the PATCH did not.
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toHaveLength(0);
  });

  it('prints the updated notice on stderr and keeps stdout the resource in human mode', async () => {
    const run = await h.run(
      ['testhub', 'plans', 'update', 'plan-1', '--library-id', 'lib-1', '--name', 'Renamed'],
      [plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('updated p8x2k1');
    expect(run.stdout).toContain('2026 S1 回归');
    expect(run.stderr).not.toContain('2026 S1 回归');
  });

  it('requires --library, because the plan lives under it in the URL', async () => {
    const run = await h.run(['testhub', 'plans', 'update', 'plan-1', '--name', 'x'], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('--library');
    expect(run.calls).toHaveLength(0);
  });

  it('resolves a plan given by name for an id-only write path', async () => {
    // The PATCH path is id-only, so the reference is resolved first — which is also
    // what lets `<plan>` be a name rather than only an id/short_id.
    const run = await h.run(
      ['testhub', 'plans', 'update', '2026 S1 回归', '--library', 'LIB', '--name', 'Renamed', '--json'],
      [librariesPage, plansPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.writes[0])).toBe('/v1/testhub/libraries/lib-1/plans/plan-1');
    expect(run.writes[0]?.body).toEqual({ name: 'Renamed' });
  });
});
