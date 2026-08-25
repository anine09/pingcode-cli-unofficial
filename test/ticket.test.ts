import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness, type CliRun } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `product ticket …` end to end, through the real `buildProgram()` tree with
 * `fetch` replaced at the global boundary and the config directory redirected to
 * a temp dir. No network, no real credentials (design D3).
 *
 * `test/shipCommands.test.ts` already exercises the ticket leaves' happy paths
 * and the transition advisory machinery. This file targets the **branches that
 * suite leaves dark** — the `=== undefined ? undefined : resolve` arms of every
 * list filter, the `--all` paging branch, the `locator.id === ''` / "no product"
 * refusals, the create/update optional-field arms, `checkNoOpTransition`'s
 * no-throw branch, and the three `reachableStates` / `explainStateRejection`
 * answers the transition suite never drives ("no plan", "no edges", "empty
 * configured states", "wrong error kind").
 *
 * Responses are no-arg constructors consumed in order (the last repeats), exactly
 * as the rest of the `createCliHarness` suites do. Each resolution list is a
 * single short page so the fetch count per invocation is deterministic.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

/** A write is a POST that is not one of the read-only `…/search` endpoints. */
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

const typesPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'ty-fault', name: '故障' }] });

const prioritiesPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'pr-high', name: '高' }] });

const channelsPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'ch-email', name: '邮件' }] });

const propertiesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'severity', name: 'severity', type: 'text' }],
  });

const membersPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'u1', type: 'user', user: { id: 'u1', display_name: '王小', username: 'wangxiao' } }],
  });

const statesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'ts-pending', name: '待处理' },
      { id: 'ts-doing', name: '处理中' },
    ],
  });

/** The state vocabulary including 已关闭, so `--state 已关闭` resolves before a PATCH. */
const statesWithClosed = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 3,
    values: [
      { id: 'ts-pending', name: '待处理' },
      { id: 'ts-doing', name: '处理中' },
      { id: 'ts-closed', name: '已关闭' },
    ],
  });

const emptyStatesPage = () => jsonResponse({ page_index: 0, page_size: 100, total: 0, values: [] });

const searchPage = () => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] });

/** A ticket as returned by `GET /v1/ship/tickets/{id}` — carries a product + state. */
const ticketDetail = () =>
  jsonResponse({
    id: 't1',
    identifier: 'SLC-7',
    title: 'cannot log in',
    product: { id: 'prod-1' },
    state: { id: 'ts-pending', name: '待处理' },
    channel: 'internal',
    is_archived: 0,
  });

/** A ticket the locator can read but that reports no product (for the update guard). */
const ticketNoProduct = () => jsonResponse({ id: 't1', identifier: 'SLC-7', title: 'x', is_archived: 0 });

/** A ticket with no state at all, so `checkNoOpTransition` takes its no-throw branch. */
const ticketNoState = () =>
  jsonResponse({ id: 't1', identifier: 'SLC-7', product: { id: 'prod-1' }, is_archived: 0 });

/** A search hit with no `id`, so `shipLocatorOf` yields `id: ''` → local refusal. */
const searchHitNoId = () =>
  jsonResponse({ page_index: 0, page_size: 20, total: 1, values: [{ identifier: 'SLC-7' }] });

// transition advisory pieces
const singleNullPlan = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'plan-org', product: null }] });
const ambiguousPlans = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'plan-a', product: null },
      { id: 'plan-b', product: null },
    ],
  });
const emptyFlows = () => jsonResponse({ page_index: 0, page_size: 100, total: 0, values: [] });
const flowsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'flow-1', form_state: { id: 'ts-pending', name: '待处理' }, to_state: { id: 'ts-doing', name: '处理中' } }],
  });

const rejectState = () => jsonResponse({ code: '100702', message: '工单状态不存在' }, { status: 400 });
const rejectNotFound = () => jsonResponse({ code: '100711', message: '工单不存在' }, { status: 400 });
const rateLimit = () => jsonResponse({ code: '100702', message: 'too many' }, { status: 429 });
/** The configured-states read fails (403): explainStateRejection must swallow it. */
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
// list — every reference filter's `=== undefined ? undefined : resolve` arm
// ---------------------------------------------------------------------------

describe('ticket list resolves each reference filter', () => {
  it('resolves --priority into priority.id', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--priority', '高', '--json'],
      [productsPage, prioritiesPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[2]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter).toEqual({
      'product.id': { in: ['prod-1'] },
      'priority.id': { in: ['pr-high'] },
    });
  });

  it('resolves --assignee against the product members, never the directory', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--assignee', 'wangxiao', '--json'],
      [productsPage, membersPage, searchPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls.some((call) => call.url.includes('/v1/directory/users'))).toBe(false);
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe('/v1/ship/products/prod-1/members');
    const body = run.calls[2]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter['assignee.id']).toEqual({ in: ['u1'] });
  });

  it('resolves --channel into channel.id', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--channel', '邮件', '--json'],
      [productsPage, channelsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[2]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter['channel.id']).toEqual({ in: ['ch-email'] });
  });

  it('folds --keywords into the payload verbatim', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--keywords', 'login', '--json'],
      [productsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { keywords: string } };
    expect(body.payload.keywords).toBe('login');
  });

  it('resolves --state into state.id', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--state', '待处理', '--json'],
      [productsPage, statesPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[2]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter['state.id']).toEqual({ in: ['ts-pending'] });
  });

  it('--state-id passes the id through with no lookup', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--state-id', 'ts-pending', '--json'],
      [productsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter['state.id']).toEqual({ in: ['ts-pending'] });
    // one product read + one search, no state-vocabulary read
    expect(run.calls).toHaveLength(2);
  });

  it('refuses --state together with --state-id before any state lookup', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--state', 'x', '--state-id', 'y', '--json'],
      [productsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1); // product resolved, then the mutual-exclusion refusal
    expect(run.stderr).toContain('mutually exclusive');
  });
});

// ---------------------------------------------------------------------------
// list --all (the paging.all branch → collect / printCollection)
// ---------------------------------------------------------------------------

describe('ticket list --all', () => {
  it('walks every page and emits {values,count,all}', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--all', '--page-size', '1', '--json'],
      [
        productsPage,
        () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [{ id: 't1' }] }),
        () => jsonResponse({ page_index: 1, page_size: 1, total: 2, values: [{ id: 't2' }] }),
        () => jsonResponse({ page_index: 2, page_size: 1, total: 2, values: [] }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toMatchObject({ count: 2, all: true });
  });

  it('renders the collected rows in human mode and counts on stderr', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--all'],
      [
        productsPage,
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 100,
            total: 1,
            values: [{ id: 't1', identifier: 'SLC-7', title: 'a', channel: 'internal' }],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('SLC-7');
    expect(run.stderr).toContain('row(s)');
    expect(run.stdout).not.toContain('row(s)');
  });
});

// ---------------------------------------------------------------------------
// list — the date-boundary arms the ship suite never drives (created / completed)
// ---------------------------------------------------------------------------

describe('ticket list date boundaries', () => {
  it('builds a between window for a two-sided created range', async () => {
    const run = await runCli(
      [
        'product',
        'ticket',
        'list',
        '--product',
        'SLC',
        '--created-after',
        '2026-01-01',
        '--created-before',
        '2026-01-31',
        '--json',
      ],
      [productsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    const created = body.payload.filter.created_at as { between: number[] };
    expect(Array.isArray(created.between)).toBe(true);
    expect(created.between[1]! - created.between[0]!).toBe(30 * 86400 + 86399);
  });

  it('uses gte for a one-sided completed boundary', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--completed-after', '2026-06-01', '--json'],
      [productsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    const completed = body.payload.filter.completed_at as { gte: number };
    expect(Object.keys(completed)).toEqual(['gte']);
    expect(completed.gte).toEqual(expect.any(Number));
  });

  it('uses lte for the trailing ends of updated and completed', async () => {
    const run = await runCli(
      [
        'product',
        'ticket',
        'list',
        '--product',
        'SLC',
        '--updated-before',
        '2026-12-31',
        '--completed-before',
        '2026-12-31',
        '--json',
      ],
      [productsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    expect(Object.keys(body.payload.filter.updated_at as object)).toEqual(['lte']);
    expect(Object.keys(body.payload.filter.completed_at as object)).toEqual(['lte']);
  });
});

// ---------------------------------------------------------------------------
// list — human mode table (the column .value arrows)
// ---------------------------------------------------------------------------

describe('ticket list human mode', () => {
  it('renders a full row and keeps the row count on stderr', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC'],
      [
        productsPage,
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 30,
            total: 1,
            values: [
              {
                id: 't1',
                identifier: 'SLC-7',
                title: 'login fail',
                state: { id: 's', name: '待处理' },
                priority: { id: 'p', name: '高' },
                assignee: { id: 'u', name: '王小' },
                channel: 'internal',
              },
            ],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('IDENTIFIER');
    expect(run.stdout).toContain('SLC-7');
    expect(run.stdout).toContain('待处理');
    expect(run.stdout).toContain('王小');
    expect(run.stderr).toContain('row(s)');
    expect(run.stdout).not.toContain('row(s)');
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('ticket get', () => {
  it('refuses a reference that resolves to an empty id (exit 5, before the detail read)', async () => {
    const run = await runCli(['product', 'ticket', 'get', 'SLC-7', '--json'], [searchHitNoId]);
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('could not resolve');
    // only the identifier search ran; the detail GET never fired
    expect(run.calls).toHaveLength(1);
  });

  it('renders a ticket with an object channel that has no name, falling back to the id', async () => {
    const run = await runCli(
      ['product', 'ticket', 'get', 'SLC-7'],
      [
        () => jsonResponse({ page_index: 0, page_size: 20, total: 1, values: [{ id: 't1', identifier: 'SLC-7' }] }),
        () =>
          jsonResponse({
            id: 't1',
            identifier: 'SLC-7',
            title: 'x',
            product: { id: 'prod-1' },
            state: { id: 'ts-pending', name: '待处理' },
            channel: { id: 'ch1' },
            is_archived: 0,
          }),
      ],
    );
    expect(run.exit).toBe(0);
    // channelName falls back to the id when the object has no name
    expect(run.stdout).toContain('ch1');
    // absent priority/assignee/customer/solution render as dropped empty cells, not "undefined"
    expect(run.stdout).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// create — every optional-field arm + the happy path
// ---------------------------------------------------------------------------

describe('ticket create', () => {
  it('requires --type (commander) before any request', async () => {
    const run = await runCli(['product', 'ticket', 'create', '--product', 'SLC', '--title', 'x', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('folds description / assignee / priority / --set into the create body under --dry-run', async () => {
    const run = await runCli(
      [
        'product',
        'ticket',
        'create',
        '--product',
        'SLC',
        '--type',
        '故障',
        '--title',
        'x',
        '--description',
        'broken',
        '--assignee',
        'wangxiao',
        '--priority',
        '高',
        '--set',
        'severity=high',
        '--dry-run',
        '--json',
      ],
      [productsPage, typesPage, membersPage, prioritiesPage, propertiesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: Record<string, unknown> } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({
      product_id: 'prod-1',
      title: 'x',
      type_id: 'ty-fault',
      description: 'broken',
      assignee_id: 'u1',
      priority_id: 'pr-high',
      properties: { severity: 'high' },
    });
    // five name lookups ran; the write was gated by --dry-run
    expect(run.calls).toHaveLength(5);
    expect(run.writes).toHaveLength(0);
  });

  it('creates for real in human mode and announces the verb on stderr', async () => {
    const run = await runCli(
      ['product', 'ticket', 'create', '--product', 'SLC', '--type', '故障', '--title', 'x'],
      [
        productsPage,
        typesPage,
        () => jsonResponse({ id: 't-new', identifier: 'SLC-8', title: 'x', channel: 'internal', is_archived: 0 }, { status: 201 }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ product_id: 'prod-1', title: 'x', type_id: 'ty-fault' });
    expect(run.stdout).toContain('SLC-8');
    expect(run.stderr).toContain('created SLC-8');
  });
});

// ---------------------------------------------------------------------------
// update — the "no product" guard, the empty-id refusal, optional fields
// ---------------------------------------------------------------------------

describe('ticket update', () => {
  it('is exit 2 with no request when no field was given', async () => {
    const run = await runCli(['product', 'ticket', 'update', 't1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('refuses a reference that resolves to an empty id (exit 5)', async () => {
    const run = await runCli(
      ['product', 'ticket', 'update', 'SLC-7', '--title', 'x', '--json'],
      [searchHitNoId],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('could not resolve');
    expect(run.calls).toHaveLength(1);
  });

  it('refuses name resolution when the ticket reports no product (exit 2)', async () => {
    const run = await runCli(
      ['product', 'ticket', 'update', 't1', '--type', '故障', '--json'],
      [ticketNoProduct],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1); // the ticket read, then the local guard
    expect(run.stderr).toContain('did not report a product');
  });

  it('still patches a scalar field when the ticket reports no product (no reference to resolve)', async () => {
    // wantsReference is false (only --title), so the "no product" guard does not fire;
    // the state/type/priority/assignee arms each short-circuit on `productId === undefined`.
    const run = await runCli(
      ['product', 'ticket', 'update', 't1', '--title', 'x', '--json'],
      [ticketNoProduct, () => jsonResponse({ id: 't1', title: 'x', is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ title: 'x' });
    // only the ticket read + the PATCH — no state/type/priority/assignee/property lookups
    expect(run.calls).toHaveLength(2);
  });

  it('folds type / priority / assignee / --set into the patch under --dry-run', async () => {
    const run = await runCli(
      [
        'product',
        'ticket',
        'update',
        't1',
        '--type',
        '故障',
        '--priority',
        '高',
        '--assignee',
        'wangxiao',
        '--set',
        'severity=high',
        '--dry-run',
        '--json',
      ],
      [ticketDetail, typesPage, prioritiesPage, membersPage, propertiesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { method: string; body: Record<string, unknown> } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.body).toEqual({
      type_id: 'ty-fault',
      priority_id: 'pr-high',
      assignee_id: 'u1',
      properties: { severity: 'high' },
    });
    // ticket read + four lookups, no write
    expect(run.calls).toHaveLength(5);
    expect(run.writes).toHaveLength(0);
  });

  it('sends only the fields passed on a scalar update', async () => {
    const run = await runCli(
      ['product', 'ticket', 'update', 't1', '--title', 'renamed', '--json'],
      [ticketDetail, () => jsonResponse({ id: 't1', title: 'renamed', is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.method).toBe('PATCH');
    expect(mutations(run)[0]?.body).toEqual({ title: 'renamed' });
  });

  it('updates by --state-id for real and announces the verb on stderr', async () => {
    const run = await runCli(
      ['product', 'ticket', 'update', 't1', '--state-id', 'ts-doing'],
      [ticketDetail, () => jsonResponse({ id: 't1', identifier: 'SLC-7', state: { id: 'ts-doing', name: '处理中' }, is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ state_id: 'ts-doing' });
    expect(run.stderr).toContain('updated SLC-7');
  });
});

// ---------------------------------------------------------------------------
// checkNoOpTransition — the no-throw branch (state absent, or different)
// ---------------------------------------------------------------------------

describe('checkNoOpTransition does not refuse a real move', () => {
  it('sends the transition when the ticket has no current state to compare against', async () => {
    // locator.stateId is undefined, so `currentStateId !== undefined` is false and
    // the only local refusal is skipped — the move goes to the server.
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state-id', 'ts-doing', '--json'],
      [ticketNoState, () => jsonResponse({ id: 't1', state: { id: 'ts-doing' }, is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ state_id: 'ts-doing' });
  });
});

// ---------------------------------------------------------------------------
// reachableStates — the two "unknown" answers that are not a thrown lookup error
// ---------------------------------------------------------------------------

describe('reachableStates distinguishes unreadable from empty', () => {
  it('reports "could not read the plan" when no plan matches (planId undefined)', async () => {
    // Two org-default plans are ambiguous, so findTicketStatePlanId returns undefined
    // without throwing — reachableStates answers `unknown`, not `none`.
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state-id', 'ts-closed', '--dry-run', '--json'],
      [ticketDetail, ambiguousPlans],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('could not read the state plan');
    expect(run.stderr).not.toContain('no transition out of');
    expect((parseStdout(run) as { dry_run: boolean }).dry_run).toBe(true);
    expect(run.writes).toHaveLength(0);
  });

  it('reports "could not read the plan" when the plan has no edges at all', async () => {
    // A matched plan whose flow list is empty is `unknown` (we could not read a
    // usable plan), distinct from `none` (a plan that genuinely lists no exit).
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state-id', 'ts-closed', '--dry-run', '--json'],
      [ticketDetail, singleNullPlan, emptyFlows],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('could not read the state plan');
    expect(run.stderr).not.toContain('no transition out of');
    expect((parseStdout(run) as { dry_run: boolean }).dry_run).toBe(true);
    expect(run.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// explainStateRejection — the arms the transition suite leaves dark
// ---------------------------------------------------------------------------

describe('explainStateRejection', () => {
  it('enriches an api refusal even when the configured-states list is empty', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '已关闭', '--json'],
      [ticketDetail, statesWithClosed, rejectState, emptyStatesPage, singleNullPlan, flowsPage],
    );
    expect(run.exit).toBe(7);
    expect(mutations(run)).toHaveLength(1);
    expect(run.stdout).toBe('');
    const error = errorOf(run);
    expect(error.kind).toBe('api');
    expect(error.message).toContain('工单状态不存在');
    // the empty states list contributed no note …
    expect(error.message).not.toContain('states configured for this product');
    // … but the reachability note still rode in the message
    expect(error.message).toContain('current state: 待处理');
    expect(error.message).toContain('reachable from 待处理: 处理中 (ts-doing)');
  });

  it('enriches a not_found refusal exactly like an api one', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '已关闭', '--json'],
      [ticketDetail, statesWithClosed, rejectNotFound, statesWithClosed, singleNullPlan, flowsPage],
    );
    expect(run.exit).toBe(5);
    expect(mutations(run)).toHaveLength(1);
    const error = errorOf(run);
    expect(error.kind).toBe('not_found');
    expect(error.message).toContain('reachable from 待处理');
  });

  it('swallows a failing configured-states lookup and still enriches from the plan', async () => {
    // listTicketStates throws (403); the best-effort catch must not mask the original
    // refusal, and the reachability note (read separately) still reaches the message.
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '已关闭', '--json'],
      [ticketDetail, statesWithClosed, rejectState, statesForbidden, singleNullPlan, flowsPage],
    );
    expect(run.exit).toBe(7);
    expect(mutations(run)).toHaveLength(1);
    expect(run.stdout).toBe('');
    const error = errorOf(run);
    expect(error.kind).toBe('api');
    expect(error.message).not.toContain('states configured for this product');
    expect(error.message).toContain('current state: 待处理');
    expect(error.message).toContain('reachable from 待处理: 处理中 (ts-doing)');
  });

  it('does not enrich a refusal whose kind is not api / not_found / permission', async () => {
    // A 429 with no retry header fails fast to a RateLimitError (kind rate_limit).
    // explainStateRejection returns it untouched — no state-vocabulary or flow read.
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '已关闭', '--json'],
      [ticketDetail, statesWithClosed, rateLimit],
    );
    expect(run.exit).toBe(6);
    expect(mutations(run)).toHaveLength(1);
    expect(run.calls).toHaveLength(3); // ticket read + state resolve + the gated-out PATCH
    const error = errorOf(run);
    expect(error.kind).toBe('rate_limit');
    expect(error.message).not.toContain('states configured');
    expect(error.message).not.toContain('reachable from');
    expect(run.stdout).toBe('');
  });
});
