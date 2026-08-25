import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness, type CliRun } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * Coverage for `src/cli/commands/testhub/meta.ts` — the eight
 * `testhub meta …` lookup leaves.
 *
 * The suite drives the **real** tree through `createCliHarness` (`buildProgram()`),
 * so every assertion is against the root the binary actually runs. No network: the
 * harness swaps in a fake `fetch`, and each test runs in its own temp config dir, so
 * the metadata cache is empty per test and never contaminates a sibling.
 *
 * These are all **read-only** lookups, so `run.writes` is always empty and there is
 * no `--dry-run` surface. What the suite pins instead:
 *  - the **scope split**: `case-states`/`run-statuses`/`important-levels`/`plan-states`
 *    ride the `pcp:read:testhub:configuration` scope and enrich a bare 403 with it;
 *    `case-types`/`plan-types`/`case-properties` do not, and must not borrow the hint;
 *  - the **org-level trap**: `important-levels` and `plan-states` refuse `--library` /
 *    `--library-id` at exit 2 and send no `library_id`, while the library-scoped
 *    leaves require one;
 *  - `suites`'s **computed path**: walked from the `parent` refs in the result set,
 *    with the server `paths` field used only as a fallback prefix when a parent is
 *    outside the filtered set, and a cycle guard so a malformed chain cannot hang.
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

/** The library a `--library LIB` resolves to. */
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
    total: 3,
    values: [
      { id: 'cs-design', name: '设计', type: 'start' },
      { id: 'cs-ready', name: '就绪', type: 'normal' },
      // No `type` — exercises the `?? ''` fallback in the GROUP column.
      { id: 'cs-notype', name: '无类型' },
    ],
  });

const caseTypesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 3,
    values: [
      { id: 'ct-functional', name: '功能测试' },
      { id: 'ct-perf', name: '性能测试' },
      // No `name` — exercises the `?? ''` fallback in the NAME column.
      { id: 'ct-noname' },
    ],
  });

const importantLevelsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 3,
    values: [
      { id: 'il-high', name: '高', color: '#f00' },
      { id: 'il-mid', name: '中', color: '#fa0' },
      { id: 'il-low', name: '低', color: '#0a0' },
    ],
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
    ],
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

const casePropertiesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 3,
    values: [
      { id: 'state_id', name: '状态', type: 'single_select', options: [{ id: 'a' }] },
      { id: 'custom_x', name: '自定义 X', type: 'text', options: [] },
      // No `name` and no `type` — exercises both `?? ''` fallbacks; empty options.
      { id: 'precondition', options: [] },
    ],
  });

/**
 * A flat suite tree that exercises every branch of `withComputedPaths`:
 *  - a root (no parent) → its own name;
 *  - a child whose parent is in the set → walked up;
 *  - a grandchild → the full ancestor chain;
 *  - an orphan whose parent is outside the set → the server `paths` fallback prefix;
 *  - an unnamed node → the `(unnamed)` placeholder.
 */
const suitesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 5,
    values: [
      { id: 's-root', name: '登录', parent: undefined, paths: '' },
      { id: 's-child', name: '子模块', parent: { id: 's-root' }, paths: '登录' },
      { id: 's-grand', name: '深层', parent: { id: 's-child' }, paths: '登录/子模块' },
      { id: 's-orphan', name: '外部', parent: { id: 's-missing' }, paths: '甲/乙' },
      // No `paths` field at all — exercises the `?? ''` fallback when the parent
      // is outside the filtered set and the server sent no ancestor chain.
      { id: 's-nopath', name: '无路径', parent: { id: 's-gone' } },
      { id: 's-unnamed', parent: { id: 's-root' }, paths: '登录' },
    ],
  });

/** A two-node cycle: each lists the other as parent. The guard must stop the walk. */
const cyclicSuitesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 's-a', name: 'A', parent: { id: 's-b' }, paths: '' },
      { id: 's-b', name: 'B', parent: { id: 's-a' }, paths: '' },
    ],
  });

// ===========================================================================
// meta case-states — library-scoped, configuration scope
// ===========================================================================

describe('testhub meta case-states', () => {
  it('resolves the library, then reads its states with library_id in the query', async () => {
    const run = await h.run(['testhub', 'meta', 'case-states', '--library', 'LIB', '--json'], [
      librariesPage,
      caseStatesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/libraries');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/case/states');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('library_id')).toBe('lib-1');
    expect(parseStdout(run)).toEqual({
      values: [
        { id: 'cs-design', name: '设计', type: 'start' },
        { id: 'cs-ready', name: '就绪', type: 'normal' },
        { id: 'cs-notype', name: '无类型' },
      ],
      count: 3,
    });
  });

  it('passes --library-id through with no library lookup', async () => {
    const run = await h.run(['testhub', 'meta', 'case-states', '--library-id', 'lib-1', '--json'], [
      caseStatesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/case/states');
  });

  it('requires a library, because the state URL is library-scoped', async () => {
    const run = await h.run(['testhub', 'meta', 'case-states', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });

  it('enriches a bare 403 with the configuration scope (exit 4)', async () => {
    const run = await h.run(['testhub', 'meta', 'case-states', '--library-id', 'lib-1', '--json'], [
      () => jsonResponse({ code: '100403', message: '无权访问' }, { status: 403 }),
    ]);
    expect(run.exit).toBe(4);
    expect(run.calls).toHaveLength(1);
    const payload = JSON.parse(run.stderr) as { error: { message: string; kind: string } };
    expect(payload.error.kind).toBe('permission');
    expect(payload.error.message).toContain('reading case states requires');
    expect(payload.error.message).toContain('pcp:read:testhub:configuration');
  });

  it('renders the state table on stdout in human mode', async () => {
    const run = await h.run(['testhub', 'meta', 'case-states', '--library', 'LIB'], [
      librariesPage,
      caseStatesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('NAME');
    expect(run.stdout).toContain('设计');
    expect(run.stderr).toContain('3 row(s)');
  });
});

// ===========================================================================
// meta case-types — library-scoped, NO configuration scope
// ===========================================================================

describe('testhub meta case-types', () => {
  it('reads the library case types, addressed under the resolved library', async () => {
    const run = await h.run(['testhub', 'meta', 'case-types', '--library', 'LIB', '--json'], [
      librariesPage,
      caseTypesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/case/types');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('library_id')).toBe('lib-1');
    expect(parseStdout(run)).toEqual({
      values: [
        { id: 'ct-functional', name: '功能测试' },
        { id: 'ct-perf', name: '性能测试' },
        { id: 'ct-noname' },
      ],
      count: 3,
    });
  });

  it('does NOT borrow the configuration-scope hint on a 403 (exit 4, plain)', async () => {
    const run = await h.run(['testhub', 'meta', 'case-types', '--library-id', 'lib-1', '--json'], [
      () => jsonResponse({ code: '100403', message: '无权访问' }, { status: 403 }),
    ]);
    expect(run.exit).toBe(4);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).not.toContain('configuration');
  });

  it('requires a library', async () => {
    const run = await h.run(['testhub', 'meta', 'case-types', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ===========================================================================
// meta important-levels — org-level, refuses --library, configuration scope
// ===========================================================================

describe('testhub meta important-levels', () => {
  it('is org-level: no library_id is sent and no library is resolved', async () => {
    const run = await h.run(['testhub', 'meta', 'important-levels', '--json'], [importantLevelsPage]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.calls).toHaveLength(1);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/case_important_levels');
    expect(new URL(run.calls[0]?.url ?? '').searchParams.get('library_id')).toBeNull();
    expect(parseStdout(run)).toEqual({
      values: [
        { id: 'il-high', name: '高', color: '#f00' },
        { id: 'il-mid', name: '中', color: '#fa0' },
        { id: 'il-low', name: '低', color: '#0a0' },
      ],
      count: 3,
    });
  });

  it('refuses --library, explaining the org-wide scope, before any request', async () => {
    const run = await h.run(
      ['testhub', 'meta', 'important-levels', '--library', 'LIB', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('takes no --library');
  });

  it('refuses --library-id the same way', async () => {
    const run = await h.run(
      ['testhub', 'meta', 'important-levels', '--library-id', 'lib-1', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('prints the org-wide hint on stderr in human mode', async () => {
    const run = await h.run(['testhub', 'meta', 'important-levels', '--library', 'LIB'], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('organisation-wide');
  });

  it('enriches a bare 403 with the configuration scope (exit 4)', async () => {
    const run = await h.run(['testhub', 'meta', 'important-levels', '--json'], [
      () => jsonResponse({ code: '100403', message: '无权访问' }, { status: 403 }),
    ]);
    expect(run.exit).toBe(4);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('reading importance levels requires');
  });

  it('renders the level table with the COLOR column in human mode', async () => {
    const run = await h.run(['testhub', 'meta', 'important-levels'], [importantLevelsPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('COLOR');
    expect(run.stdout).toContain('#f00');
    expect(run.stderr).toContain('3 row(s)');
  });
});

// ===========================================================================
// meta run-statuses — library-scoped, configuration scope
// ===========================================================================

describe('testhub meta run-statuses', () => {
  it('reads the library run statuses with library_id in the query', async () => {
    const run = await h.run(['testhub', 'meta', 'run-statuses', '--library', 'LIB', '--json'], [
      librariesPage,
      runStatusesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/run/statuses');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('library_id')).toBe('lib-1');
    // is_system 0/1 is normalised to a boolean in the JSON output.
    expect(parseStdout(run)).toEqual({
      values: [
        { id: 'rs-notstart', name: '未测', is_system: true },
        { id: 'rs-pass', name: '通过', is_system: true },
        { id: 'rs-block', name: '受阻', is_system: true },
      ],
      count: 3,
    });
  });

  it('enriches a bare 403 with the configuration scope (exit 4)', async () => {
    const run = await h.run(['testhub', 'meta', 'run-statuses', '--library-id', 'lib-1', '--json'], [
      () => jsonResponse({ code: '100403', message: '无权访问' }, { status: 403 }),
    ]);
    expect(run.exit).toBe(4);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('reading run statuses requires');
  });

  it('requires a library', async () => {
    const run = await h.run(['testhub', 'meta', 'run-statuses', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ===========================================================================
// meta plan-types — library-scoped, NO configuration scope
// ===========================================================================

describe('testhub meta plan-types', () => {
  it('reads the plan types, with the library id in the path (not the query)', async () => {
    const run = await h.run(['testhub', 'meta', 'plan-types', '--library', 'LIB', '--json'], [
      librariesPage,
      planTypesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/plan_types');
    // The library id rides in the path here, never as a query param.
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('library_id')).toBeNull();
    expect(parseStdout(run)).toEqual({
      values: [
        { id: 'pt-plain', name: '普通测试' },
        { id: 'pt-sprint', name: '迭代测试' },
      ],
      count: 2,
    });
  });

  it('does NOT borrow the configuration-scope hint on a 403 (exit 4, plain)', async () => {
    const run = await h.run(['testhub', 'meta', 'plan-types', '--library-id', 'lib-1', '--json'], [
      () => jsonResponse({ code: '100403', message: '无权访问' }, { status: 403 }),
    ]);
    expect(run.exit).toBe(4);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).not.toContain('configuration');
  });
});

// ===========================================================================
// meta plan-states — org-level, refuses --library, configuration scope
// ===========================================================================

describe('testhub meta plan-states', () => {
  it('is org-level: hits /plan_states with no library_id and no library lookup', async () => {
    const run = await h.run(['testhub', 'meta', 'plan-states', '--json'], [planStatesPage]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.calls).toHaveLength(1);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/plan_states');
    expect(new URL(run.calls[0]?.url ?? '').searchParams.get('library_id')).toBeNull();
  });

  it('refuses --library, pointing at the whole-tree lookup, before any request', async () => {
    const run = await h.run(['testhub', 'meta', 'plan-states', '--library', 'LIB', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('takes no --library');
    // JSON errors carry no hint field; the org-wide explanation is for human mode.
  });

  it('refuses --library-id the same way', async () => {
    const run = await h.run(
      ['testhub', 'meta', 'plan-states', '--library-id', 'lib-1', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('prints the org-wide hint on stderr in human mode', async () => {
    const run = await h.run(['testhub', 'meta', 'plan-states', '--library', 'LIB'], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('no parameters at all');
    expect(run.stderr).toContain('organisation-wide');
  });

  it('enriches a bare 403 with the configuration scope (exit 4)', async () => {
    const run = await h.run(['testhub', 'meta', 'plan-states', '--json'], [
      () => jsonResponse({ code: '100403', message: '无权访问' }, { status: 403 }),
    ]);
    expect(run.exit).toBe(4);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('reading plan states requires');
  });
});

// ===========================================================================
// meta case-properties — library-scoped, NO configuration scope
// ===========================================================================

describe('testhub meta case-properties', () => {
  it('reads the library case properties with library_id in the query', async () => {
    const run = await h.run(['testhub', 'meta', 'case-properties', '--library', 'LIB', '--json'], [
      librariesPage,
      casePropertiesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/case/properties');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('library_id')).toBe('lib-1');
    expect(parseStdout(run)).toEqual({
      values: [
        { id: 'state_id', name: '状态', type: 'single_select', options: [{ id: 'a' }] },
        { id: 'custom_x', name: '自定义 X', type: 'text', options: [] },
        { id: 'precondition', options: [] },
      ],
      count: 3,
    });
  });

  it('does NOT borrow the configuration-scope hint on a 403 (exit 4, plain)', async () => {
    const run = await h.run(
      ['testhub', 'meta', 'case-properties', '--library-id', 'lib-1', '--json'],
      [() => jsonResponse({ code: '100403', message: '无权访问' }, { status: 403 })],
    );
    expect(run.exit).toBe(4);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).not.toContain('configuration');
  });

  it('renders the OPTIONS column: empty for zero, the count otherwise', async () => {
    const run = await h.run(['testhub', 'meta', 'case-properties', '--library', 'LIB'], [
      librariesPage,
      casePropertiesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('OPTIONS');
    // state_id has one option; custom_x and precondition have none.
    expect(run.stdout).toContain('state_id');
    expect(run.stdout).toContain('custom_x');
  });

  it('requires a library', async () => {
    const run = await h.run(['testhub', 'meta', 'case-properties', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ===========================================================================
// meta suites — library-scoped, --parent-id, withComputedPaths
// ===========================================================================

describe('testhub meta suites', () => {
  it('reads the whole suite tree under the resolved library', async () => {
    const run = await h.run(['testhub', 'meta', 'suites', '--library', 'LIB', '--json'], [
      librariesPage,
      suitesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/suites');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('library_id')).toBeNull();
  });

  it('computes each path by walking the parent refs in the result set', async () => {
    const run = await h.run(['testhub', 'meta', 'suites', '--library-id', 'lib-1', '--json'], [
      suitesPage,
    ]);
    expect(run.exit).toBe(0);
    const out = parseStdout(run) as { values: Array<{ id: string; computed_path: string }> };
    const byId = new Map(out.values.map((row) => [row.id, row.computed_path]));
    expect(byId.get('s-root')).toBe('登录');
    expect(byId.get('s-child')).toBe('登录 / 子模块');
    expect(byId.get('s-grand')).toBe('登录 / 子模块 / 深层');
    // The orphan's parent is outside the set, so the server `paths` prefix is used.
    expect(byId.get('s-orphan')).toBe('甲 / 乙 / 外部');
    // No server paths and a missing parent: the fallback yields the name alone.
    expect(byId.get('s-nopath')).toBe('无路径');
    // An unnamed node renders the placeholder.
    expect(byId.get('s-unnamed')).toBe('登录 / (unnamed)');
  });

  it('guards a cyclic parent chain instead of hanging', async () => {
    const run = await h.run(['testhub', 'meta', 'suites', '--library-id', 'lib-1', '--json'], [
      cyclicSuitesPage,
    ]);
    expect(run.exit).toBe(0);
    const out = parseStdout(run) as { values: Array<{ id: string; computed_path: string }> };
    const byId = new Map(out.values.map((row) => [row.id, row.computed_path]));
    // Each walk stops at the cycle and returns the chain it collected so far.
    expect(byId.get('s-a')).toBe('B / A');
    expect(byId.get('s-b')).toBe('A / B');
  });

  it('forwards --parent-id as the server-side subtree filter', async () => {
    const run = await h.run(
      ['testhub', 'meta', 'suites', '--library-id', 'lib-1', '--parent-id', 's-root', '--json'],
      [suitesPage],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[0]?.url ?? '').searchParams.get('parent_id')).toBe('s-root');
  });

  it('omits parent_id when --parent-id is absent', async () => {
    const run = await h.run(['testhub', 'meta', 'suites', '--library-id', 'lib-1', '--json'], [
      suitesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[0]?.url ?? '').searchParams.get('parent_id')).toBeNull();
  });

  it('renders the PATH column on stdout in human mode', async () => {
    const run = await h.run(['testhub', 'meta', 'suites', '--library', 'LIB'], [
      librariesPage,
      suitesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('PATH');
    expect(run.stdout).toContain('登录 / 子模块');
    expect(run.stderr).toContain('row(s)');
  });

  it('requires a library', async () => {
    const run = await h.run(['testhub', 'meta', 'suites', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});
