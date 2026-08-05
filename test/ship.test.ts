import { describe, expect, it } from 'vitest';
import {
  parseShipIdea,
  parseShipIdeaTransitionHistory,
  parseShipPlan,
  parseShipPlanSummary,
  parseShipProduct,
  parseShipProperty,
  parseShipTicket,
  parseShipTicketType,
  parseTicketChannel,
} from '../src/api/parse';
import {
  createIdea,
  createTicket,
  getIdea,
  getIdeaTransitionHistory,
  getProduct,
  getProductPlan,
  getTicket,
  iterateIdeaTransitionHistories,
  iterateProductPlans,
  listIdeaPlans,
  listIdeaPriorities,
  listIdeaProperties,
  listIdeaStates,
  listIdeaSuites,
  listIdeaTransitionHistories,
  listProductMembers,
  listProductPlans,
  listProducts,
  listTicketChannels,
  listTicketPriorities,
  listTicketProperties,
  listTicketStates,
  listTicketTypes,
  searchIdeas,
  searchTickets,
  updateIdea,
  updateTicket,
} from '../src/api/ship';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { ApiError, DryRunHalt, NotFoundError } from '../src/core/errors';
import { collect } from '../src/core/paginate';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S3: the ship API wrappers. Injected `fetch`, zero network. Every assertion is
 * either a wire fact (method, path, query, body) or a normalisation the research
 * file demands (0/1 → boolean, `channel` Object-or-String, `is_system` absence).
 *
 * The two ticket-state-plan wrappers are NOT here: they are `core/metadata`'s, and their
 * `form_state` spelling fix is asserted in `test/shipMetadata.test.ts` (G3 closeout, design
 * §D21.3).
 */

const NOW = 1_700_000_000_000;

function ctxFor(responses: Array<() => Response>, options: { dryRun?: boolean } = {}) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { ctx, fake };
}

function envelope(values: unknown[]): Response {
  return jsonResponse({ page_index: 0, page_size: 100, total: values.length, values });
}

describe('ship normalisation', () => {
  it('turns 0/1 archive flags into booleans on every ship object', () => {
    expect(parseShipProduct({ id: 'p', is_archived: 1, is_deleted: 0 }).is_archived).toBe(true);
    expect(parseShipIdea({ id: 'i', is_archived: 0, is_deleted: 1 }).is_deleted).toBe(true);
    expect(parseShipTicket({ id: 't', is_archived: 1 }).is_archived).toBe(true);
  });

  it('keeps ticket.channel as an object OR the bare string "internal" (ship GOTCHA #3)', () => {
    expect(parseTicketChannel('internal')).toBe('internal');
    expect(parseTicketChannel({ id: 'c1', name: '邮件' })).toMatchObject({ id: 'c1', name: '邮件' });
    expect(parseTicketChannel(undefined)).toBeUndefined();
    expect(parseShipTicket({ id: 't', channel: 'internal' }).channel).toBe('internal');
    expect((parseShipTicket({ id: 't', channel: { id: 'c1' } }).channel as { id: string }).id).toBe(
      'c1',
    );
  });

  it('normalises option ids onto `_id` and tolerates the `id` variant (ship GOTCHA #8)', () => {
    const property = parseShipProperty({
      id: 'backlog_type',
      name: '需求类型',
      type: 'select',
      options: [
        { _id: 'o1', text: '功能需求' },
        { id: 'o2', text: '体验优化' },
      ],
    });
    expect(property.options.map((option) => option._id)).toEqual(['o1', 'o2']);
    // property ids are frequently slugs, never 24-hex — and never validated
    expect(property.id).toBe('backlog_type');
  });

  it('leaves `is_system` absent rather than defaulting it to false (ship GOTCHA #12)', () => {
    expect(parseShipTicketType({ id: 't1', name: '故障' }).is_system).toBeUndefined();
    expect(parseShipTicketType({ id: 't1', is_system: 1 }).is_system).toBe(true);
  });

  it('keeps timestamps raw and preserves unknown fields and custom properties', () => {
    const idea = parseShipIdea({
      id: 'i1',
      created_at: 1578897962,
      properties: { backlog_type: '5cb7e763fda1ce4ca0010002' },
      future_field: 'kept',
    });
    expect(idea.created_at).toBe(1578897962);
    expect(idea.properties).toEqual({ backlog_type: '5cb7e763fda1ce4ca0010002' });
    expect(idea.future_field).toBe('kept');
  });

  it('parses plan_at as a whole object (it is written all-or-nothing)', () => {
    const idea = parseShipIdea({
      id: 'i1',
      plan_at: { from: 1730000000, to: 1730600000, granularity: 'day' },
    });
    expect(idea.plan_at).toMatchObject({ from: 1730000000, granularity: 'day' });
  });
});

describe('products api', () => {
  it('lists products with keywords and paging', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [{ id: 'prod-1', identifier: 'SLC', name: 'Sales', is_archived: 0 }],
        }),
    ]);
    const page = await listProducts(ctx, { keywords: 'Sales' }, { pageSize: 30 });
    expect(page.values[0]?.identifier).toBe('SLC');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/ship/products');
    expect(url.searchParams.get('keywords')).toBe('Sales');
    expect(fake.calls[0]?.method).toBe('GET');
  });

  it('gets one product and parses its embedded members', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          id: 'prod-1',
          name: 'Sales',
          members: [{ id: 'u1', type: 'user', user: { id: 'u1', name: '张三' } }],
          is_archived: 0,
        }),
    ]);
    const product = await getProduct(ctx, 'prod-1', { include_archived: true });
    expect(product.members[0]?.user?.name).toBe('张三');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/ship/products/prod-1');
    expect(url.searchParams.get('include_archived')).toBe('true');
  });

  it('lists product members under the product path', async () => {
    const { ctx, fake } = ctxFor([
      () => envelope([{ id: 'u1', type: 'user', user: { id: 'u1', name: '张三' }, role: { id: 'r1' } }]),
    ]);
    const members = await listProductMembers(ctx, 'prod-1');
    expect(members[0]?.id).toBe('u1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/products/prod-1/members');
  });
});

describe('ideas api', () => {
  it('reads through POST …/search, never GET /v1/ship/ideas (PRD D2)', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 2, total: 1, values: [{ id: 'i1', title: 'x' }] }),
    ]);
    const page = await searchIdeas(
      ctx,
      { filter: { 'product.id': { in: ['prod-1'] } }, keywords: 'login' },
      { pageSize: 2 },
    );
    expect(page.values[0]?.title).toBe('x');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/ideas/search');
    expect(fake.calls[0]?.body).toEqual({
      mode: 'query',
      payload: {
        filter: { 'product.id': { in: ['prod-1'] } },
        keywords: 'login',
        page_index: 0,
        page_size: 2,
      },
    });
  });

  it('gets one idea by id', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'i1', identifier: 'SLC-1' })]);
    expect((await getIdea(ctx, 'i1')).identifier).toBe('SLC-1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/ideas/i1');
  });

  it('creates with a compacted body — only product_id and title are required', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'i-new' }, { status: 201 })]);
    const created = await createIdea(ctx, {
      product_id: 'prod-1',
      title: 'hello',
      description: undefined,
      assignee_id: 'u1',
    });
    expect(created.id).toBe('i-new');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/ideas');
    expect(fake.calls[0]?.body).toEqual({ product_id: 'prod-1', title: 'hello', assignee_id: 'u1' });
  });

  it('patches only the provided fields', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'i1', state: { id: 's2' } })]);
    await updateIdea(ctx, 'i1', { state_id: 's2', title: undefined });
    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ state_id: 's2' });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/ideas/i1');
  });
});

describe('tickets api', () => {
  it('reads through POST …/search', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [{ id: 't1' }] }),
    ]);
    await searchTickets(ctx, { filter: { 'type.id': { in: ['ty1'] } } });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/tickets/search');
    expect((fake.calls[0]?.body as { payload: { filter: unknown } }).payload.filter).toEqual({
      'type.id': { in: ['ty1'] },
    });
  });

  it('gets one ticket', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 't1', channel: 'internal' })]);
    expect((await getTicket(ctx, 't1')).channel).toBe('internal');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/tickets/t1');
  });

  it('creates with the mandatory type_id (PRD D12)', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 't-new' }, { status: 201 })]);
    await createTicket(ctx, {
      product_id: 'prod-1',
      title: 'cannot log in',
      type_id: 'ty1',
      channel_id: 'ch1',
      priority_id: undefined,
    });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/tickets');
    expect(fake.calls[0]?.body).toEqual({
      product_id: 'prod-1',
      title: 'cannot log in',
      type_id: 'ty1',
      channel_id: 'ch1',
    });
  });

  it('patches only the provided fields', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 't1' })]);
    await updateTicket(ctx, 't1', { state_id: 's9', solution_id: undefined });
    expect(fake.calls[0]?.method).toBe('PATCH');
    expect(fake.calls[0]?.body).toEqual({ state_id: 's9' });
  });
});

describe('product-scoped metadata reads', () => {
  const cases: Array<[string, (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>, string]> =
    [
      ['idea states', (ctx) => listIdeaStates(ctx, 'prod-1'), '/v1/ship/idea/states'],
      ['idea priorities', (ctx) => listIdeaPriorities(ctx, 'prod-1'), '/v1/ship/idea/priorities'],
      ['idea suites', (ctx) => listIdeaSuites(ctx, 'prod-1'), '/v1/ship/idea/suites'],
      ['idea properties', (ctx) => listIdeaProperties(ctx, 'prod-1'), '/v1/ship/idea/properties'],
      ['ticket states', (ctx) => listTicketStates(ctx, 'prod-1'), '/v1/ship/ticket/states'],
      [
        'ticket priorities',
        (ctx) => listTicketPriorities(ctx, 'prod-1'),
        '/v1/ship/ticket/priorities',
      ],
      ['ticket types', (ctx) => listTicketTypes(ctx, 'prod-1'), '/v1/ship/ticket/types'],
      ['ticket channels', (ctx) => listTicketChannels(ctx, 'prod-1'), '/v1/ship/ticket/channels'],
      [
        'ticket properties',
        (ctx) => listTicketProperties(ctx, 'prod-1'),
        '/v1/ship/ticket/properties',
      ],
    ];

  for (const [label, call, path] of cases) {
    it(`${label} hit ${path} with ?product_id=`, async () => {
      const { ctx, fake } = ctxFor([() => envelope([{ id: 'x', name: 'X' }])]);
      await call(ctx);
      const url = new URL(fake.urls()[0] ?? '');
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get('product_id')).toBe('prod-1');
      expect(fake.calls[0]?.method).toBe('GET');
    });
  }
});

describe('the api layer neither logs nor sends under --dry-run', () => {
  it('logs nothing beyond transport debug lines', async () => {
    const { ctx } = ctxFor([() => jsonResponse({ id: 'i1' })]);
    await getIdea(ctx, 'i1');
    for (const line of ctx.logLines) {
      expect(line).toMatch(/^(→|←)/);
    }
  });

  it('halts every ship write under --dry-run with zero requests sent', async () => {
    const writes: Array<[string, (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>]> = [
      ['createIdea', (ctx) => createIdea(ctx, { product_id: 'prod-1', title: 't' })],
      ['updateIdea', (ctx) => updateIdea(ctx, 'i1', { title: 't' })],
      [
        'createTicket',
        (ctx) => createTicket(ctx, { product_id: 'prod-1', title: 't', type_id: 'ty1' }),
      ],
      ['updateTicket', (ctx) => updateTicket(ctx, 't1', { title: 't' })],
    ];

    for (const [label, call] of writes) {
      const { ctx, fake } = ctxFor([() => jsonResponse({})], { dryRun: true });
      const error = await call(ctx).catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(DryRunHalt);
      expect(fake.calls, label).toHaveLength(0);
    }
  });
});

/**
 * S4 — 需求排期 (requirement schedules) and 需求流转记录 (idea state history).
 *
 * Live-verified 2026-08-05 against the real tenant (design §D18). Two things this
 * block pins that only a live run could establish: the API answers **two different
 * structures for one 排期 resource** depending on the endpoint (ship GOTCHA #12), and
 * the idea history is a **third** `transition_histories` shape whose parent key is
 * `idea` rather than pjm's `work_item`.
 */
describe('需求排期 requirement schedules (S4)', () => {
  it('lists the full records under the product, with no filter query', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          page_index: 0,
          page_size: 30,
          total: 1,
          values: [
            {
              id: 'plan-1',
              name: '2026 Q3',
              assignee: { id: 'u1', name: 'luoxiutao' },
              start_at: 1780243027,
              end_at: 1780620720,
            },
          ],
        }),
    ]);
    const page = await listProductPlans(ctx, 'prod-1');
    expect(page.values[0]?.name).toBe('2026 Q3');
    expect(page.values[0]?.start_at).toBe(1780243027);
    const url = new URL(fake.urls()[0] ?? '');
    expect(fake.calls[0]?.method).toBe('GET');
    expect(url.pathname).toBe('/v1/ship/products/prod-1/plans');
    // No filter is offered, so none may be sent: `?name=` was accepted and ignored.
    expect(url.searchParams.get('name')).toBeNull();
  });

  it('walks pages through the shared query paginator', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [{ id: 'plan-1' }] }),
      () => jsonResponse({ page_index: 1, page_size: 1, total: 2, values: [{ id: 'plan-2' }] }),
      () => jsonResponse({ page_index: 2, page_size: 1, total: 2, values: [] }),
    ]);
    const all = await collect(iterateProductPlans(ctx, 'prod-1', { pageSize: 1 }));
    expect(all.map((plan) => plan.id)).toEqual(['plan-1', 'plan-2']);
    expect(fake.calls).toHaveLength(3);
  });

  it('gets one schedule under its product', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'plan-1', name: '2026 Q3' })]);
    expect((await getProductPlan(ctx, 'prod-1', 'plan-1')).name).toBe('2026 Q3');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/products/prod-1/plans/plan-1');
  });

  it('reads the same rows through the singular idea lookup with ?product_id=', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: 'plan-1', name: '2026 Q3' }])]);
    expect((await listIdeaPlans(ctx, 'prod-1'))[0]?.name).toBe('2026 Q3');
    const url = new URL(fake.urls()[0] ?? '');
    // Singular `idea`, the module's oldest trap — `/v1/ship/ideas` is the resource.
    expect(url.pathname).toBe('/v1/ship/idea/plans');
    expect(url.searchParams.get('product_id')).toBe('prod-1');
  });

  it('does not share a deserializer between the two plan shapes (ship GOTCHA #12)', async () => {
    const wire = {
      id: 'plan-1',
      name: '2026 Q3',
      assignee: { id: 'u1', name: 'luoxiutao' },
      start_at: 1780243027,
      end_at: 1780620720,
    };
    // The full parser lifts the window and the owner…
    expect(parseShipPlan(wire)).toMatchObject({
      assignee: { id: 'u1' },
      start_at: 1780243027,
      end_at: 1780620720,
    });
    // …while the summary parser asserts only what its endpoint documents. Anything
    // the wire does carry still survives untouched, which is what makes that safe.
    const summary = parseShipPlanSummary(wire);
    expect(Object.keys(summary)).not.toContain('assignee_id');
    expect(summary.start_at).toBe(1780243027);
    expect(parseShipPlanSummary({ id: 'plan-1', name: '2026 Q3' })).toEqual({
      id: 'plan-1',
      name: '2026 Q3',
      url: undefined,
    });
  });

  it('leaves 100721 (missing schedule) on exit 7 — it is also a write-path code', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100721', message: '产品排期不存在' }, { status: 400 }),
    ]);
    const error = await getProductPlan(ctx, 'prod-1', 'nope').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(NotFoundError);
  });
});

describe('需求流转记录 idea state history (S4)', () => {
  const historyRow = {
    id: 'h1',
    idea: { id: 'i1', identifier: 'PD-YYHC-1', title: '称重 App', short_id: 'HxUyPHCz' },
    from_state: null,
    to_state: { id: 'st-1', name: '待排期', type: 'pending' },
    created_by: { id: 'u1', name: 'luoxiutao' },
    created_at: 1780243027,
  };

  it('lists a state history under the plural idea path, with no filter query', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [historyRow] }),
    ]);
    const page = await listIdeaTransitionHistories(ctx, 'i1');
    expect(page.values[0]?.to_state?.name).toBe('待排期');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/ship/ideas/i1/transition_histories');
    // All three of ?name=, ?state_id= and ?keywords= are ignored upstream, so the
    // wrapper offers none of them: the paging cursor is the only query it sends.
    expect([...url.searchParams.keys()].sort()).toEqual(['page_index', 'page_size']);
  });

  it('walks pages and gets one row', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse({ page_index: 0, page_size: 1, total: 1, values: [historyRow] }),
      () => jsonResponse({ page_index: 1, page_size: 1, total: 1, values: [] }),
    ]);
    expect(await collect(iterateIdeaTransitionHistories(ctx, 'i1', { pageSize: 1 }))).toHaveLength(1);

    const { ctx: single, fake: singleFake } = ctxFor([() => jsonResponse(historyRow)]);
    expect((await getIdeaTransitionHistory(single, 'i1', 'h1')).id).toBe('h1');
    expect(new URL(singleFake.urls()[0] ?? '').pathname).toBe(
      '/v1/ship/ideas/i1/transition_histories/h1',
    );
    expect(fake.calls[0]?.method).toBe('GET');
  });

  it('parses the third history shape: the parent key is `idea`, not `work_item`', async () => {
    const parsed = parseShipIdeaTransitionHistory(historyRow);
    expect(parsed.idea?.id).toBe('i1');
    expect(parsed.idea?.identifier).toBe('PD-YYHC-1');
    expect(parsed.work_item).toBeUndefined();
    // `from_state: null` on the creation row — the renderer prints "(new)" for it.
    expect(parsed.from_state).toBeUndefined();
    expect(parsed.created_at).toBe(1780243027);
  });

  it('maps 100740 to exit 5 for an unknown id AND for a mismatched pair', async () => {
    for (const label of ['unknown history id', 'history of another idea']) {
      const { ctx } = ctxFor([
        () => jsonResponse({ code: '100740', message: '需求流转记录不存在' }, { status: 400 }),
      ]);
      const error = await getIdeaTransitionHistory(ctx, 'i1', 'nope').catch(
        (caught: unknown) => caught,
      );
      expect(error, label).toBeInstanceOf(NotFoundError);
    }
  });

  it('surfaces an unknown parent idea as exit 5 through the already-mapped 100725', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse({ code: '100725', message: '需求不存在或无权访问' }, { status: 400 }),
    ]);
    const error = await listIdeaTransitionHistories(ctx, 'nope').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NotFoundError);
  });
});
