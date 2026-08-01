import { describe, expect, it } from 'vitest';
import {
  parseShipIdea,
  parseShipProduct,
  parseShipProperty,
  parseShipStateFlow,
  parseShipTicket,
  parseShipTicketType,
  parseTicketChannel,
} from '../src/api/parse';
import {
  createIdea,
  createTicket,
  getIdea,
  getProduct,
  getTicket,
  listIdeaPriorities,
  listIdeaProperties,
  listIdeaStates,
  listIdeaSuites,
  listProductMembers,
  listProducts,
  listTicketChannels,
  listTicketPriorities,
  listTicketProperties,
  listTicketStateFlows,
  listTicketStatePlans,
  listTicketStates,
  listTicketTypes,
  searchIdeas,
  searchTickets,
  updateIdea,
  updateTicket,
} from '../src/api/ship';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { DryRunHalt } from '../src/core/errors';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S3: the ship API wrappers. Injected `fetch`, zero network. Every assertion is
 * either a wire fact (method, path, query, body) or a normalisation the research
 * file demands (0/1 → boolean, `channel` Object-or-String, `form_state` typo,
 * `is_system` absence).
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

  it('accepts both `form_state` and `from_state` on a state flow (ship GOTCHA #2)', () => {
    expect(parseShipStateFlow({ id: 'f1', form_state: { id: 'a' }, to_state: { id: 'b' } })).
      toMatchObject({ from_state: { id: 'a' }, to_state: { id: 'b' } });
    expect(parseShipStateFlow({ id: 'f1', from_state: { id: 'a' }, to_state: { id: 'b' } })).
      toMatchObject({ from_state: { id: 'a' } });
    expect(parseShipStateFlow({ id: 'f1', to_state: { id: 'b' } }).from_state).toBeUndefined();
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

  it('lists state plans unfiltered — there is no ?product_id= (ship GOTCHA #23)', async () => {
    const { ctx, fake } = ctxFor([
      () => envelope([{ id: 'plan-org', product: null }, { id: 'plan-1', product: { id: 'prod-1' } }]),
    ]);
    const plans = await listTicketStatePlans(ctx);
    expect(plans.map((plan) => plan.product?.id)).toEqual([undefined, 'prod-1']);
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/ship/ticket_state_plans');
    expect(url.searchParams.get('product_id')).toBeNull();
  });

  it('lists state flows under the plan', async () => {
    const { ctx, fake } = ctxFor([
      () => envelope([{ id: 'f1', form_state: { id: 's1' }, to_state: { id: 's2' } }]),
    ]);
    const flows = await listTicketStateFlows(ctx, 'plan-1');
    expect(flows[0]?.from_state?.id).toBe('s1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe(
      '/v1/ship/ticket_state_plans/plan-1/ticket_state_flows',
    );
  });
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
