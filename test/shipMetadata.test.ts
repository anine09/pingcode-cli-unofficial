import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { cacheDirPath } from '../src/core/config';
import { NotFoundError, UsageError } from '../src/core/errors';
import {
  CACHE_TTL_MS,
  cacheKeyFor,
  findTicketStatePlanId,
  loadTicketStateFlows,
  resolveIdeaPriority,
  resolveIdeaProperty,
  resolveIdeaState,
  resolveIdeaSuite,
  resolveProduct,
  resolveProductMember,
  resolveShipRef,
  resolveTicketChannel,
  resolveTicketState,
  resolveTicketType,
} from '../src/core/metadata';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S4 / Gate G2: the ship resolvers.
 *
 * Two invariants are load-bearing and are asserted directly rather than implied:
 *  - **no id shape is ever validated** — 24-hex, 32-hex and bare slugs all pass
 *    through untouched (ship GOTCHA #4, §25);
 *  - **`ship-ticket-state-flow` is keyed by the state-plan id, not the product** —
 *    everything else ship-scoped is keyed by the product (design §13.3).
 */

const NOW = 1_700_000_000_000;

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-ship-meta-'));
  env = { PINGCODE_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function page(values: unknown[], pageIndex = 0): unknown {
  return { page_index: pageIndex, page_size: 100, total: values.length, values };
}

function ctxFor(
  responses: Array<() => Response>,
  options: { useCache?: boolean; now?: number } = {},
) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: options.now ?? NOW,
    env,
    clientId: 'client-1',
    clientSecret: 'shh',
    ...(options.useCache === undefined ? {} : { useCache: options.useCache }),
  });
  return { ctx, fake };
}

const BASE = { apiBase: 'https://open.pingcode.com', clientId: 'client-1' } as const;

describe('cache keys (Gate G2)', () => {
  it('keys every product-scoped kind by the product id', () => {
    const a = cacheKeyFor({ ...BASE, parentId: 'prod-a', kind: 'ship-idea-state' });
    const b = cacheKeyFor({ ...BASE, parentId: 'prod-b', kind: 'ship-idea-state' });
    expect(a).not.toBe(b);
  });

  it('never lets two kinds share a key under the same product', () => {
    const kinds = [
      'ship-idea-state',
      'ship-idea-priority',
      'ship-idea-suite',
      'ship-idea-property',
      'ship-product-member',
      'ship-ticket-state',
      'ship-ticket-priority',
      'ship-ticket-type',
      'ship-ticket-channel',
      'ship-ticket-property',
    ] as const;
    const keys = kinds.map((kind) => cacheKeyFor({ ...BASE, parentId: 'prod-a', kind }));
    expect(new Set(keys).size).toBe(kinds.length);
  });

  it('keys ship-ticket-state-flow by the plan id, not the product (design §13.3)', () => {
    const planA = cacheKeyFor({ ...BASE, parentId: 'plan-a', kind: 'ship-ticket-state-flow' });
    const planB = cacheKeyFor({ ...BASE, parentId: 'plan-b', kind: 'ship-ticket-state-flow' });
    expect(planA).not.toBe(planB);

    // Two products sharing one plan must land on the same key: nothing about the
    // product may enter it.
    const viaProduct = cacheKeyFor({ ...BASE, parentId: 'prod-1', kind: 'ship-ticket-state-flow' });
    expect(viaProduct).not.toBe(planA);
    expect(planA.startsWith('ship-ticket-state-flow-')).toBe(true);
  });

  it('still separates two client ids and two hosts', () => {
    const one = cacheKeyFor({ ...BASE, parentId: 'prod-a', kind: 'ship-product' });
    const other = cacheKeyFor({ ...BASE, clientId: 'client-2', parentId: 'prod-a', kind: 'ship-product' });
    const host = cacheKeyFor({
      apiBase: 'https://pingcode.example.com/open',
      clientId: 'client-1',
      parentId: 'prod-a',
      kind: 'ship-product',
    });
    expect(new Set([one, other, host]).size).toBe(3);
  });
});

describe('product resolution', () => {
  it('resolves a product by name', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse(page([{ id: 'prod-1', identifier: 'SLC', name: 'Sales Cloud' }])),
    ]);
    expect((await resolveProduct(ctx, 'sales cloud')).id).toBe('prod-1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/products');
  });

  it('resolves a product by its identifier, which the API cannot search on', async () => {
    // `keywords` matches the name only (ship §5), so the identifier has to be an
    // alias matched client-side over the full list.
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'prod-1', identifier: 'SLC', name: 'Sales Cloud' },
            { id: 'prod-2', identifier: 'MKT', name: 'Marketing' },
          ]),
        ),
    ]);
    expect((await resolveProduct(ctx, 'SLC')).id).toBe('prod-1');
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('keywords')).toBeNull();
  });

  it('refuses to guess between two products with the same name', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'prod-1', name: 'Sales' }, { id: 'prod-2', name: 'sales' }])),
    ]);
    const error = await resolveProduct(ctx, 'Sales').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    expect((error as UsageError).message).toContain('prod-1');
    expect((error as UsageError).message).toContain('prod-2');
  });
});

describe('product-scoped lookups all send ?product_id=', () => {
  const cases = [
    ['idea state', resolveIdeaState, '/v1/ship/idea/states'],
    ['idea priority', resolveIdeaPriority, '/v1/ship/idea/priorities'],
    ['idea property', resolveIdeaProperty, '/v1/ship/idea/properties'],
    ['ticket state', resolveTicketState, '/v1/ship/ticket/states'],
    ['ticket type', resolveTicketType, '/v1/ship/ticket/types'],
    ['ticket channel', resolveTicketChannel, '/v1/ship/ticket/channels'],
  ] as const;

  for (const [label, resolve, expected] of cases) {
    it(`${label} → ${expected}`, async () => {
      const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'x1', name: '待评审' }]))]);
      expect((await resolve(ctx, 'prod-1', '待评审')).id).toBe('x1');
      const url = new URL(fake.urls()[0] ?? '');
      expect(url.pathname).toBe(expected);
      expect(url.searchParams.get('product_id')).toBe('prod-1');
    });
  }

  it('caches per product, so two products never share a candidate list', async () => {
    const first = ctxFor([() => jsonResponse(page([{ id: 's-a', name: 'Open' }]))]);
    expect((await resolveIdeaState(first.ctx, 'prod-a', 'Open')).id).toBe('s-a');

    // A different product must miss the cache and fetch again.
    const second = ctxFor([() => jsonResponse(page([{ id: 's-b', name: 'Open' }]))]);
    const resolved = await resolveIdeaState(second.ctx, 'prod-b', 'Open');
    expect(resolved.id).toBe('s-b');
    expect(resolved.fromCache).toBe(false);
    expect(second.fake.calls).toHaveLength(1);

    // The same product hits it.
    const third = ctxFor([() => jsonResponse(page([{ id: 's-a', name: 'Open' }]))]);
    expect((await resolveIdeaState(third.ctx, 'prod-a', 'Open')).fromCache).toBe(true);
    expect(third.fake.calls).toHaveLength(0);
    expect(readdirSync(cacheDirPath(env)).length).toBe(2);
  });

  it('re-fetches once the 24h TTL has passed', async () => {
    const seed = ctxFor([() => jsonResponse(page([{ id: 's-a', name: 'Open' }]))]);
    await resolveIdeaState(seed.ctx, 'prod-a', 'Open');

    const later = ctxFor([() => jsonResponse(page([{ id: 's-a', name: 'Open' }]))], {
      now: NOW + CACHE_TTL_MS + 1,
    });
    expect((await resolveIdeaState(later.ctx, 'prod-a', 'Open')).fromCache).toBe(false);
    expect(later.fake.calls).toHaveLength(1);
  });

  it('--no-cache bypasses both the read and the write', async () => {
    const { ctx, fake } = ctxFor(
      [
        () => jsonResponse(page([{ id: 's-a', name: 'Open' }])),
        () => jsonResponse(page([{ id: 's-a', name: 'Open' }])),
      ],
      { useCache: false },
    );
    await resolveIdeaState(ctx, 'prod-a', 'Open');
    await resolveIdeaState(ctx, 'prod-a', 'Open');
    expect(fake.calls).toHaveLength(2);
    expect(() => readdirSync(cacheDirPath(env))).toThrow();
  });
});

describe('no id shape is ever validated (Gate G2)', () => {
  it('passes a 24-hex state id, a slug property id and a 32-hex member id through', async () => {
    const hex24 = '5cb9466afda1ce4ca0090005';
    const states = ctxFor([() => jsonResponse(page([{ id: hex24, name: 'P0' }]))]);
    expect((await resolveIdeaPriority(states.ctx, 'prod-1', hex24)).id).toBe(hex24);

    // System property ids are slugs, not ObjectIds (ship GOTCHA #4).
    const properties = ctxFor([
      () => jsonResponse(page([{ id: 'backlog_type', name: '需求类型' }, { id: 'identifier' }])),
    ]);
    expect((await resolveIdeaProperty(properties.ctx, 'prod-1', 'backlog_type')).id).toBe(
      'backlog_type',
    );

    const hex32 = 'a0417f68e846aae315c85d24643678a9';
    const members = ctxFor([
      () => jsonResponse(page([{ id: hex32, type: 'user', user: { id: hex32, name: '张三' } }])),
    ]);
    expect((await resolveProductMember(members.ctx, 'prod-1', hex32)).id).toBe(hex32);
  });

  it('reports an unmatched value as a usage error and still lists the candidates', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 's1', name: 'Open' }]))]);
    const error = await resolveIdeaState(ctx, 'prod-1', 'Nope').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    const hint = (error as UsageError).hint ?? '';
    // the candidate list is the actionable half — a scoping explanation alone is a dead end
    expect(hint).toContain('Open');
    expect(hint).toContain('no idea state-flow endpoint');
  });
});

describe('product members', () => {
  it('reads the display name out of user / user_group, not off the membership row', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse(
          page([
            {
              id: 'u1',
              type: 'user',
              user: { id: 'u1', name: '张三', display_name: '张三', username: 'zhangsan', email: 'z@example.com' },
            },
            { id: 'g1', type: 'user_group', user_group: { id: 'g1', name: '前端组' } },
          ]),
        ),
    ]);
    expect((await resolveProductMember(ctx, 'prod-1', '张三')).id).toBe('u1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/products/prod-1/members');
  });

  it('matches a member by username or email too', async () => {
    const rows = [
      { id: 'u1', type: 'user', user: { id: 'u1', display_name: '张三', username: 'zhangsan', email: 'z@example.com' } },
    ];
    const byUsername = ctxFor([() => jsonResponse(page(rows))]);
    expect((await resolveProductMember(byUsername.ctx, 'prod-1', 'zhangsan')).id).toBe('u1');

    const byEmail = ctxFor([() => jsonResponse(page(rows))]);
    expect((await resolveProductMember(byEmail.ctx, 'prod-2', 'z@example.com')).id).toBe('u1');
  });

  it('resolves a user group by name', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'g1', type: 'user_group', user_group: { id: 'g1', name: '前端组' } }])),
    ]);
    expect((await resolveProductMember(ctx, 'prod-1', '前端组')).id).toBe('g1');
  });
});

describe('suite tree', () => {
  const tree = [
    { id: 'root', name: '客户端', type: 'product' },
    { id: 'ios', name: '登录', type: 'module', parent: { id: 'root' } },
    { id: 'web', name: 'Web', type: 'product' },
    { id: 'web-login', name: '登录', type: 'module', parent: { id: 'web' } },
  ];

  it('resolves an unambiguous module by its bare name', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse(page([{ id: 'root', name: '客户端' }, { id: 'ios', name: '登录', parent: { id: 'root' } }])),
    ]);
    expect((await resolveIdeaSuite(ctx, 'prod-1', '登录')).id).toBe('ios');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/idea/suites');
  });

  it('errors with both full paths when a name collides across branches', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page(tree))]);
    const error = await resolveIdeaSuite(ctx, 'prod-1', '登录').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    const message = (error as UsageError).message;
    expect(message).toContain('客户端 / 登录');
    expect(message).toContain('Web / 登录');
  });

  it('lets the user disambiguate by typing the full path', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page(tree))]);
    expect((await resolveIdeaSuite(ctx, 'prod-1', 'Web / 登录')).id).toBe('web-login');
  });

  it('does not hang on a cyclic parent chain', async () => {
    const { ctx } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'a', name: 'A', parent: { id: 'b' } },
            { id: 'b', name: 'B', parent: { id: 'a' } },
          ]),
        ),
    ]);
    expect((await resolveIdeaSuite(ctx, 'prod-1', 'A')).id).toBe('a');
  });
});

describe('ticket state plan and flows', () => {
  it('finds a product plan by scanning, skipping the null (org default) plan', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'plan-org', product: null },
            { id: 'plan-1', product: { id: 'prod-1' } },
          ]),
        ),
    ]);
    expect(await findTicketStatePlanId(ctx, 'prod-1')).toBe('plan-1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/ticket_state_plans');
  });

  it('returns undefined rather than throwing when no plan matches', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 'plan-org', product: null }]))]);
    expect(await findTicketStatePlanId(ctx, 'prod-1')).toBeUndefined();
  });

  it('caches the plan lookup under the product', async () => {
    const first = ctxFor([() => jsonResponse(page([{ id: 'plan-1', product: { id: 'prod-1' } }]))]);
    await findTicketStatePlanId(first.ctx, 'prod-1');
    const second = ctxFor([() => jsonResponse(page([]))]);
    expect(await findTicketStatePlanId(second.ctx, 'prod-1')).toBe('plan-1');
    expect(second.fake.calls).toHaveLength(0);
  });

  it('reads the flows of a plan, accepting the documented `form_state` spelling', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'f1', form_state: { id: 's1', name: '待处理' }, to_state: { id: 's2', name: '处理中' } },
            { id: 'f2', from_state: { id: 's2' }, to_state: { id: 's3', name: '已解决' } },
          ]),
        ),
    ]);
    const { edges } = await loadTicketStateFlows(ctx, 'plan-1');
    expect(edges).toEqual([
      { fromId: 's1', toId: 's2', toName: '处理中' },
      { fromId: 's2', toId: 's3', toName: '已解决' },
    ]);
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe(
      '/v1/ship/ticket_state_plans/plan-1/ticket_state_flows',
    );
  });

  it('round-trips the flows through the cache under a plan-keyed entry', async () => {
    const seed = ctxFor([
      () => jsonResponse(page([{ id: 'f1', form_state: { id: 's1' }, to_state: { id: 's2', name: 'Doing' } }])),
    ]);
    const seeded = await loadTicketStateFlows(seed.ctx, 'plan-1');
    expect(seeded.cacheKey).toContain('ship-ticket-state-flow-');

    const cached = ctxFor([() => jsonResponse(page([]))]);
    const reread = await loadTicketStateFlows(cached.ctx, 'plan-1');
    expect(cached.fake.calls).toHaveLength(0);
    expect(reread.edges).toEqual([{ fromId: 's1', toId: 's2', toName: 'Doing' }]);
    expect(reread.cacheKey).toBe(seeded.cacheKey);

    // A different plan is a different key and therefore a real fetch.
    const otherPlan = ctxFor([() => jsonResponse(page([]))]);
    const other = await loadTicketStateFlows(otherPlan.ctx, 'plan-2');
    expect(other.cacheKey).not.toBe(seeded.cacheKey);
    expect(otherPlan.fake.calls).toHaveLength(1);
  });

  it('keeps an edge with no source state (the initial transition)', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'f1', to_state: { id: 's1', name: 'New' } }])),
    ]);
    const { edges } = await loadTicketStateFlows(ctx, 'plan-1');
    expect(edges).toEqual([{ fromId: undefined, toId: 's1', toName: 'New' }]);
  });
});

describe('idea / ticket references', () => {
  it('GETs a raw id directly', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          id: 'i1',
          identifier: 'SLC-1',
          title: 'hello',
          product: { id: 'prod-1' },
          state: { id: 's1', name: '待评审' },
        }),
    ]);
    const locator = await resolveShipRef(ctx, 'idea', 'i1');
    expect(locator).toEqual({
      id: 'i1',
      identifier: 'SLC-1',
      title: 'hello',
      productId: 'prod-1',
      stateId: 's1',
      stateName: '待评审',
      typeId: undefined,
    });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/ideas/i1');
  });

  it('resolves an identifier through search, then filters to an exact match', async () => {
    // `keywords` matches identifier OR title, so a title containing "SLC-1"
    // must not be mistaken for the item itself.
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'i-other', identifier: 'SLC-10', title: 'mentions SLC-1' },
            { id: 'i1', identifier: 'SLC-1', title: 'the real one' },
          ]),
        ),
    ]);
    const locator = await resolveShipRef(ctx, 'idea', 'SLC-1');
    expect(locator.id).toBe('i1');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/ideas/search');
    expect((fake.calls[0]?.body as { payload: { keywords: string } }).payload.keywords).toBe('SLC-1');
  });

  it('searches tickets on the ticket endpoint', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse(page([{ id: 't1', identifier: 'SLC-9', type: { id: 'ty1' } }])),
    ]);
    const locator = await resolveShipRef(ctx, 'ticket', 'SLC-9');
    expect(locator.typeId).toBe('ty1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/tickets/search');
  });

  it('passes an unrecognised reference shape through as an id rather than rejecting it', async () => {
    // Ship ids come in three shapes and identifiers are product-prefixed; a token
    // that is not obviously an identifier is sent as an id and allowed to fail on
    // the server rather than being second-guessed here (ship §25).
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'weird-ref' })]);
    await resolveShipRef(ctx, 'ticket', 'weird-ref');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/tickets/weird-ref');
    expect(fake.calls[0]?.method).toBe('GET');
  });

  it('is a NotFoundError (exit 5) when an identifier matches nothing', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 'x', identifier: 'SLC-99' }]))]);
    const error = await resolveShipRef(ctx, 'idea', 'SLC-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(5);
  });

  it('is a UsageError when an identifier is somehow ambiguous', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'a', identifier: 'SLC-1' }, { id: 'b', identifier: 'slc-1' }])),
    ]);
    await expect(resolveShipRef(ctx, 'idea', 'SLC-1')).rejects.toBeInstanceOf(UsageError);
  });

  it('takes the trailing segment of a pasted URL', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: 'i1' })]);
    await resolveShipRef(ctx, 'idea', 'https://example.pingcode.com/ship/ideas/Ogf1EYey?tab=detail');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/ship/ideas/Ogf1EYey');
  });

  it('rejects an empty reference before sending anything', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({})]);
    await expect(resolveShipRef(ctx, 'idea', '   ')).rejects.toBeInstanceOf(UsageError);
    expect(fake.calls).toHaveLength(0);
  });
});
