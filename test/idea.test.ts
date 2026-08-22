import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness, type CliRun } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `product idea …` — the branches that `test/shipCommands.test.ts` leaves dark.
 *
 * The ship suite drives the idea leaves' **happy paths**: the `POST …/search`
 * read route, the `--all`/`--state`/`--state-id`/`--suite`/`--participant`/date
 * filters, and create/update with the fewest fields. This file targets the
 * sibling arms the happy path never reaches:
 *
 *  - the `=== undefined ? undefined : resolve` arms of **`--priority`** and the
 *    whole **completed-at** date boundary (created/updated are already covered),
 *  - the human-mode table and the `printIdea` verb announcements
 *    (`created`/`updated` on stderr),
 *  - every `locator.id === ''` refusal — `idea get`, `idea update`, and
 *    `resolveIdeaId` for the history sub-collection,
 *  - `idea update`'s "did not report a product" guard, the scalar-patch-that-
 *    survives-no-product path, the `--progress` scalar arm, and the
 *    priority/assignee/suite reference arms,
 *  - `idea history list --all` (the paging branch),
 *  - `ideaRefLabel`'s identifier-absent fallback,
 *  - and the four `explainIdeaStates` answers the ship suite never drives:
 *    a non-state error (skipped), a wrong-kind error (429), an empty configured-
 *    states list, and a states lookup that itself fails (best-effort swallow).
 *
 * Responses are no-arg constructors consumed in order (the last repeats). Each
 * resolution list is a single short page so the fetch count per invocation is
 * deterministic — `--state-id` carries a synthetic, non-cached resolution, so a
 * rejected write never retries (see `withCacheInvalidation`).
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

/** A write is a POST that is not the read-only `…/search` endpoint. */
const mutations = (run: CliRun) => run.writes.filter((call) => !call.url.includes('/search'));

// ---------------------------------------------------------------------------
// response factories (single short pages → deterministic fetch counts)
// ---------------------------------------------------------------------------

const productsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'prod-1', identifier: 'SLC', name: 'Sales Cloud', is_archived: 0 }],
  });

const membersPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'u1', type: 'user', user: { id: 'u1', display_name: '张三', username: 'zhangsan' } }],
  });

const statesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'st-review', name: '待评审' },
      { id: 'st-doing', name: '开发中' },
    ],
  });

const emptyStatesPage = () => jsonResponse({ page_index: 0, page_size: 100, total: 0, values: [] });

const prioritiesPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'pr-high', name: '高' }] });

const suitesPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'su1', name: '登录', type: 'module' }] });

const propertiesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'backlog_type', name: '需求类型', type: 'select', options: [{ _id: 'opt-1', text: '功能需求' }] }],
  });

const ideasPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 1,
    values: [
      {
        id: 'i1',
        identifier: 'SLC-1',
        title: 'single sign-on',
        state: { id: 'st-review', name: '待评审' },
        priority: { id: 'pr-high', name: '高' },
        assignee: { id: 'u1', name: '张三' },
        suite: { id: 'su1', name: '登录' },
        created_at: 1730000000,
        is_archived: 0,
      },
    ],
  });

/** An idea as returned by `GET /v1/ship/ideas/{id}` — carries a product + state. */
const ideaDetail = () =>
  jsonResponse({
    id: 'i1',
    identifier: 'SLC-1',
    title: 'single sign-on',
    product: { id: 'prod-1' },
    state: { id: 'st-review', name: '待评审' },
    is_archived: 0,
  });

/** An idea the locator can read but that reports no product (for the update guard). */
const ideaNoProduct = () => jsonResponse({ id: 'i1', identifier: 'SLC-1', title: 'x', is_archived: 0 });

/** A search hit with no `id`, so `shipLocatorOf` yields `id: ''` → local refusal. */
const searchHitNoId = () =>
  jsonResponse({ page_index: 0, page_size: 20, total: 1, values: [{ identifier: 'SLC-1' }] });

/** An identifier search that resolves to a real idea id. */
const ideaByIdentifier = () =>
  jsonResponse({
    page_index: 0,
    page_size: 20,
    total: 1,
    values: [{ id: 'i1', identifier: 'SLC-1', product: { id: 'prod-1' }, is_archived: 0 }],
  });

const rejectState = () => jsonResponse({ code: '100303', message: '状态不存在' }, { status: 400 });
const rejectApi = () => jsonResponse({ code: '100008', message: '缺少必填字段' }, { status: 400 });
// A 429 on a code the override table does NOT claim, so the status wins → RateLimitError (exit 6).
const rateLimit = () => jsonResponse({ code: '100702', message: 'too many' }, { status: 429 });
/** The configured-states read fails (403): explainIdeaStates must swallow it. */
const statesForbidden = () => jsonResponse({ code: '100001', message: '无权限' }, { status: 403 });

function parseStdout(run: CliRun): unknown {
  expect(run.stdout.trim(), `stdout was not pure JSON:\n${run.stdout}`).not.toBe('');
  return JSON.parse(run.stdout) as unknown;
}

function errorOf(run: CliRun): { kind: string; message: string; exit: number; code?: string } {
  const line = run.stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{'));
  return (JSON.parse(line ?? '{}') as { error: { kind: string; message: string; exit: number; code?: string } })
    .error;
}

// ---------------------------------------------------------------------------
// list — --priority and the completed-at date arms the ship suite never drives
// ---------------------------------------------------------------------------

describe('idea list resolves --priority and the completed date boundary', () => {
  it('resolves --priority into priority.id', async () => {
    const run = await runCli(
      ['product', 'idea', 'list', '--product', 'SLC', '--priority', '高', '--json'],
      [productsPage, prioritiesPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe('/v1/ship/idea/priorities');
    const body = run.calls[2]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter).toEqual({
      'product.id': { in: ['prod-1'] },
      'priority.id': { in: ['pr-high'] },
    });
  });

  it('builds a between window for a two-sided completed range', async () => {
    const run = await runCli(
      [
        'product',
        'idea',
        'list',
        '--product',
        'SLC',
        '--completed-after',
        '2026-01-01',
        '--completed-before',
        '2026-01-31',
        '--json',
      ],
      [productsPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    const completed = body.payload.filter.completed_at as { between: number[] };
    expect(Array.isArray(completed.between)).toBe(true);
    expect(completed.between[1]! - completed.between[0]!).toBe(30 * 86400 + 86399);
  });

  it('uses gte for a one-sided completed boundary', async () => {
    const run = await runCli(
      ['product', 'idea', 'list', '--product', 'SLC', '--completed-after', '2026-06-01', '--json'],
      [productsPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    const completed = body.payload.filter.completed_at as { gte: number };
    expect(Object.keys(completed)).toEqual(['gte']);
    expect(completed.gte).toEqual(expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// list — human-mode table (the IDEA_COLUMNS arrows) and stdout purity
// ---------------------------------------------------------------------------

describe('idea list human mode', () => {
  it('renders a full row and keeps the row count on stderr', async () => {
    const run = await runCli(['product', 'idea', 'list', '--product', 'SLC'], [productsPage, ideasPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('IDENTIFIER');
    expect(run.stdout).toContain('SLC-1');
    expect(run.stdout).toContain('待评审');
    expect(run.stdout).toContain('登录');
    expect(run.stderr).toContain('row(s)');
    expect(run.stdout).not.toContain('row(s)');
  });
});

// ---------------------------------------------------------------------------
// get — the locator.id === '' refusal + happy paths
// ---------------------------------------------------------------------------

describe('idea get', () => {
  it('refuses a reference that resolves to an empty id (exit 5, before the detail read)', async () => {
    const run = await runCli(['product', 'idea', 'get', 'SLC-1', '--json'], [searchHitNoId]);
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('could not resolve');
    // only the identifier search ran; the detail GET never fired
    expect(run.calls).toHaveLength(1);
  });

  it('renders the idea verbatim under --json', async () => {
    const run = await runCli(['product', 'idea', 'get', 'i1', '--json'], [ideaDetail]);
    expect(run.exit).toBe(0);
    expect((parseStdout(run) as { id: string }).id).toBe('i1');
    expect(new URL(run.calls[0]?.url ?? '').pathname).toBe('/v1/ship/ideas/i1');
  });

  it('prints the curated field block in human mode and does not announce a verb', async () => {
    const run = await runCli(['product', 'idea', 'get', 'i1'], [ideaDetail]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('SLC-1');
    expect(run.stdout).toContain('single sign-on');
    // get passes no verb, so no "created"/"updated" announcement on stderr
    expect(run.stderr).not.toMatch(/updated|created/);
  });
});

// ---------------------------------------------------------------------------
// create — the optional-field arms + the human-mode verb announcement
// ---------------------------------------------------------------------------

describe('idea create optional fields', () => {
  it('folds --description into the create body', async () => {
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'x', '--description', 'notes', '--dry-run', '--json'],
      [productsPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { request: { body: Record<string, unknown> } };
    expect(plan.request.body).toEqual({ product_id: 'prod-1', title: 'x', description: 'notes' });
  });

  it('folds --priority into the create body', async () => {
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'x', '--priority', '高', '--dry-run', '--json'],
      [productsPage, prioritiesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { request: { body: Record<string, unknown> } };
    expect(plan.request.body).toEqual({ product_id: 'prod-1', title: 'x', priority_id: 'pr-high' });
  });

  it('folds --suite into the create body', async () => {
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'x', '--suite', '登录', '--dry-run', '--json'],
      [productsPage, suitesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { request: { body: Record<string, unknown> } };
    expect(plan.request.body).toEqual({ product_id: 'prod-1', title: 'x', suite_id: 'su1' });
  });

  it('creates for real in human mode and announces the verb on stderr', async () => {
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'hello'],
      [productsPage, () => jsonResponse({ id: 'i-new', identifier: 'SLC-2', title: 'hello', is_archived: 0 }, { status: 201 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(run.stdout).toContain('SLC-2');
    expect(run.stderr).toContain('created SLC-2');
  });
});

// ---------------------------------------------------------------------------
// update — the "no product" guard, the empty-id refusal, optional fields, verb
// ---------------------------------------------------------------------------

describe('idea update', () => {
  it('refuses a reference that resolves to an empty id (exit 5)', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'SLC-1', '--title', 'x', '--json'],
      [searchHitNoId],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('could not resolve');
    expect(run.calls).toHaveLength(1);
  });

  it('refuses name resolution when the idea reports no product (exit 2)', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--priority', '高', '--json'],
      [ideaNoProduct],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1); // the idea read, then the local guard
    expect(run.stderr).toContain('did not report a product');
  });

  it('still patches a scalar field when the idea reports no product (no reference to resolve)', async () => {
    // wantsReference is false (only --title), so the "no product" guard does not fire;
    // the priority/assignee/suite arms each short-circuit on `productId === undefined`.
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--title', 'x', '--json'],
      [ideaNoProduct, () => jsonResponse({ id: 'i1', title: 'x', is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ title: 'x' });
    // only the idea read + the PATCH — no priority/assignee/suite/property lookups
    expect(run.calls).toHaveLength(2);
  });

  it('folds --progress into the scalar patch under --dry-run', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--progress', '0.75', '--dry-run', '--json'],
      [ideaDetail],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { method: string; body: Record<string, unknown> } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.body).toEqual({ progress: 0.75 });
    // one GET for the idea, the write gated by --dry-run
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toHaveLength(0);
  });

  it('folds priority / assignee / suite / --set into the patch under --dry-run', async () => {
    const run = await runCli(
      [
        'product',
        'idea',
        'update',
        'i1',
        '--priority',
        '高',
        '--assignee',
        'zhangsan',
        '--suite',
        '登录',
        '--set',
        '需求类型=opt-1',
        '--dry-run',
        '--json',
      ],
      [ideaDetail, prioritiesPage, membersPage, suitesPage, propertiesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { request: { body: Record<string, unknown> } };
    expect(plan.request.body).toEqual({
      priority_id: 'pr-high',
      assignee_id: 'u1',
      suite_id: 'su1',
      properties: { backlog_type: 'opt-1' },
    });
    // idea read + four lookups, no write
    expect(run.calls).toHaveLength(5);
    expect(run.writes).toHaveLength(0);
  });

  it('updates for real in human mode and announces the verb on stderr', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--title', 'renamed'],
      [ideaDetail, () => jsonResponse({ id: 'i1', identifier: 'SLC-1', title: 'renamed', is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ title: 'renamed' });
    expect(run.stderr).toContain('updated SLC-1');
  });
});

// ---------------------------------------------------------------------------
// update — explainIdeaStates: the arms the ship suite never drives
// ---------------------------------------------------------------------------

describe('idea update explainIdeaStates', () => {
  it('does not enrich an api refusal when the update requested no state', async () => {
    // wantsState is false (only --title), so the catch skips explainIdeaStates:
    // no state-vocabulary read, no "states configured" note, exit 7.
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--title', 'x', '--json'],
      [ideaDetail, rejectApi],
    );
    expect(run.exit).toBe(7);
    expect(run.calls).toHaveLength(2); // idea read + the gated-out PATCH, no states read
    const error = errorOf(run);
    expect(error.kind).toBe('api');
    expect(error.message).not.toContain('states configured');
  });

  it('does not enrich a refusal whose kind is not api / not_found / permission (429)', async () => {
    // A 429 with no retry header fails fast to RateLimitError (kind rate_limit).
    // explainIdeaStates returns it untouched — no state-vocabulary read.
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--state-id', 'bogus', '--json'],
      [ideaDetail, rateLimit],
    );
    expect(run.exit).toBe(6);
    expect(run.calls).toHaveLength(2); // idea read + the PATCH, no states read
    const error = errorOf(run);
    expect(error.kind).toBe('rate_limit');
    expect(error.message).not.toContain('states configured');
    expect(error.message).not.toContain('no idea state-flow');
  });

  it('adds no note when the configured-states list is empty', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--state-id', 'bogus', '--json'],
      [ideaDetail, rejectState, emptyStatesPage],
    );
    expect(run.exit).toBe(5);
    expect(run.calls).toHaveLength(3); // idea read + PATCH + the empty states read
    const error = errorOf(run);
    expect(error.kind).toBe('not_found');
    expect(error.message).not.toContain('states configured');
  });

  it('swallows a failing configured-states lookup and still surfaces the original error', async () => {
    // listIdeaStates throws (403); the best-effort catch must not mask the original
    // not_found refusal, and no states note reaches the message.
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--state-id', 'bogus', '--json'],
      [ideaDetail, rejectState, statesForbidden],
    );
    expect(run.exit).toBe(5);
    expect(run.calls).toHaveLength(3); // idea read + PATCH + the failing states read
    const error = errorOf(run);
    expect(error.kind).toBe('not_found');
    expect(error.message).toContain('状态不存在');
    expect(error.message).not.toContain('states configured');
  });

  it('enriches a permission refusal by listing the configured states', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--state-id', 'bogus', '--json'],
      [ideaDetail, () => jsonResponse({ code: '100001', message: '无权限' }, { status: 403 }), statesPage],
    );
    expect(run.exit).toBe(4);
    expect(run.calls).toHaveLength(3);
    expect(run.stderr).toContain('states configured for this product');
    expect(run.stderr).toContain('待评审');
    expect(run.stderr).toContain('no idea state-flow endpoint');
  });
});

// ---------------------------------------------------------------------------
// history list --all (the paging.all branch → collect / printCollection)
// ---------------------------------------------------------------------------

describe('idea history list --all', () => {
  it('walks every page and emits {values,count,all}', async () => {
    const historyRow = (id: string) => ({
      id,
      created_at: 1730000000,
      from_state: { id: 'st-a', name: '草稿' },
      to_state: { id: 'st-review', name: '待评审' },
      created_by: { id: 'u1', name: '张三' },
    });
    const run = await runCli(
      ['product', 'idea', 'history', 'list', 'SLC-1', '--all', '--page-size', '2', '--json'],
      [
        ideaByIdentifier,
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 2,
            total: 2,
            values: [historyRow('h1'), historyRow('h2')],
          }),
        () => jsonResponse({ page_index: 1, page_size: 2, total: 2, values: [] }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toMatchObject({ count: 2, all: true });
    // the sub-collection is addressed by the resolved id, never the identifier
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe('/v1/ship/ideas/i1/transition_histories');
  });

  it('renders the collected rows in human mode and counts on stderr', async () => {
    const historyRow = (id: string) => ({
      id,
      created_at: 1730000000,
      from_state: null,
      to_state: { id: 'st-review', name: '待评审' },
      created_by: { id: 'u1', name: '张三' },
    });
    const run = await runCli(
      ['product', 'idea', 'history', 'list', 'SLC-1', '--all'],
      [
        ideaByIdentifier,
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 100,
            total: 1,
            values: [historyRow('h1')],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    // the creation row renders FROM as (new)
    expect(run.stdout).toContain('(new)');
    expect(run.stderr).toContain('row(s)');
    expect(run.stdout).not.toContain('row(s)');
  });
});

// ---------------------------------------------------------------------------
// history — resolveIdeaId's empty-id refusal + ideaRefLabel fallbacks
// ---------------------------------------------------------------------------

describe('idea history reference resolution', () => {
  it('resolveIdeaId refuses a reference resolving to an empty id (exit 5)', async () => {
    const run = await runCli(
      ['product', 'idea', 'history', 'list', 'SLC-1', '--json'],
      [searchHitNoId],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('could not resolve');
    // only the identifier search ran; the sub-collection never fired
    expect(run.calls).toHaveLength(1);
  });

  it('labels the parent by identifier when the row.idea has none (falls back to the id)', async () => {
    // ideaRefLabel: identifier is absent, so it returns refName(ref) === the raw id.
    const historyRow = () =>
      jsonResponse({
        id: 'h2',
        created_at: 1730000000,
        from_state: { id: 'st-a', name: '草稿' },
        to_state: { id: 'st-review', name: '待评审' },
        created_by: { id: 'u1', name: '张三' },
        idea: { id: 'i1' },
      });
    const run = await runCli(
      ['product', 'idea', 'history', 'get', 'i1', 'h2', '--json'],
      [historyRow],
    );
    expect(run.exit).toBe(0);
    const row = parseStdout(run) as { idea: { id: string } };
    expect(row.idea.id).toBe('i1');
  });

  it('renders an empty parent label when row.idea is absent entirely', async () => {
    const historyRow = () =>
      jsonResponse({
        id: 'h2',
        created_at: 1730000000,
        from_state: null,
        to_state: { id: 'st-review', name: '待评审' },
        created_by: { id: 'u1', name: '张三' },
      });
    const run = await runCli(['product', 'idea', 'history', 'get', 'i1', 'h2'], [historyRow]);
    expect(run.exit).toBe(0);
    // ideaRefLabel(undefined) → '' so printFields drops the empty requirement label
    // rather than printing "undefined"; the rest of the block still renders.
    expect(run.stdout).toContain('待评审');
    expect(run.stdout).not.toContain('undefined');
  });
});
