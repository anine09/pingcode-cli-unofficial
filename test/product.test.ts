import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode product …` end to end, with `fetch` replaced at the global boundary
 * and the config directory redirected to a temp dir. No network, no real
 * credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/product.ts`:
 * `runList` (the `--all` collect branch, the single-page branch, the
 * `keywords`/`include_archived`/`include_deleted` query and paging),
 * `runGet` (the name→id resolution, the `include_*` query, the curated field
 * block with the archived `yes`/`no` ternary and the member count),
 * `registerProductPlanCommands` (the `--all`/single-page split, `plan get`'s
 * field block and the 100721→exit-7 path), `registerProductMetaCommands` +
 * `productScoped` (every column set, rendered in human mode to exercise the
 * cell functions), the `--dry-run` no-op on reads, and the JSON stdout
 * contract. Name→id resolution is exercised by `--product <identifier>`,
 * `<id>` pass-through, an unknown name (exit 2) and an ambiguous name (exit 2).
 *
 * Everything in this group is product-scoped, so every lookup that takes a
 * `--product` resolves it first against `GET /v1/ship/products` (the
 * `ship-product` resolver) before the real request. `product list` is the
 * only leaf that takes no `--product` and resolves nothing.
 */

const PRODUCT_ID = 'prod-1';
const IDENT = 'SLC';
const NAME = 'Sales Cloud';

// ---------------------------------------------------------------------------
// response builders — every one is a zero-arg factory. A factory with a default
// parameter, passed as a handler, has its first parameter bound to the FakeCall
// and corrupts the body; these take nothing.
// ---------------------------------------------------------------------------

/** The product list, used both for `product list` and for `--product` resolution. */
const productsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [
      { id: PRODUCT_ID, identifier: IDENT, name: NAME, is_archived: 0, visibility: 'private' },
    ],
  });

/** Two products sharing a name, for the ambiguous-resolution branch. */
const ambiguousProductsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'prod-a', identifier: 'SLA', name: 'Sales', is_archived: 0 },
      { id: 'prod-b', identifier: 'SLB', name: 'Sales', is_archived: 0 },
    ],
  });

/** The full product detail body `product get` parses and renders. */
function productBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PRODUCT_ID,
    identifier: IDENT,
    name: NAME,
    visibility: 'private',
    scope_type: 'organization',
    members: [{ id: 'u1', type: 'user', user: { id: 'u1', name: '张三' } }],
    created_by: { id: 'u1', name: 'luoxiutao' },
    is_archived: 0,
    created_at: 1730000000,
    updated_at: 1730600000,
    url: 'https://open.pingcode.com/ship/products/prod-1',
    description: 'a product',
    ...overrides,
  };
}
const productDetail = () => jsonResponse(productBody());
const productDetailArchived = () => jsonResponse(productBody({ is_archived: 1 }));

/** The full 需求排期 record `product plan get` parses and renders. */
function planBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1',
    name: '2026 Q3',
    product: { id: PRODUCT_ID, name: NAME },
    assignee: { id: 'u1', name: 'luoxiutao' },
    start_at: 1780243027,
    end_at: 1780620720,
    url: 'https://open.pingcode.com/ship/products/prod-1/plans/plan-1',
    ...overrides,
  };
}
const planDetail = () => jsonResponse(planBody());

/** One page of 需求排期, for `product plan list`. */
const plansPage = () =>
  jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [planBody()] });

/** A page of one meta row, for a given lookup. */
function metaPage(row: Record<string, unknown>): () => Response {
  return () =>
    jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [row] });
}

/**
 * Every `product meta` leaf, its endpoint path, a representative row, and the
 * cell fragments a human-mode render must contain. Drives the column-coverage
 * loop: one render per unique column set, plus the four that repeat a set, so
 * every `Column<…>[]` value function in the file is exercised.
 */
const META_CASES: Array<{
  name: string;
  path: string;
  row: Record<string, unknown>;
  contains: string[];
}> = [
  {
    name: 'idea-states',
    path: '/v1/ship/idea/states',
    row: { id: 'st-1', name: '待评审', type: 'pending' },
    contains: ['st-1', '待评审', 'pending'],
  },
  {
    name: 'idea-priorities',
    path: '/v1/ship/idea/priorities',
    row: { id: 'pr-1', name: '高' },
    contains: ['pr-1', '高'],
  },
  {
    name: 'idea-suites',
    path: '/v1/ship/idea/suites',
    row: { id: 'su-1', name: '登录', type: 'module', parent: { id: 'su-root', name: '客户端' } },
    contains: ['su-1', '登录', 'module', '客户端'],
  },
  {
    name: 'idea-properties',
    path: '/v1/ship/idea/properties',
    row: {
      id: 'backlog_type',
      name: '需求类型',
      type: 'select',
      options: [{ _id: 'opt-1', text: '功能需求' }],
    },
    contains: ['backlog_type', '需求类型', 'select', '功能需求=opt-1'],
  },
  {
    name: 'idea-plans',
    path: '/v1/ship/idea/plans',
    row: { id: 'plan-1', name: '2026 Q3' },
    contains: ['plan-1', '2026 Q3'],
  },
  {
    name: 'members',
    path: '/v1/ship/products/prod-1/members',
    row: { id: 'u1', type: 'user', user: { id: 'u1', name: '张三' }, role: { id: 'r1', name: '管理员' } },
    contains: ['u1', '张三', 'user', '管理员'],
  },
  {
    name: 'ticket-states',
    path: '/v1/ship/ticket/states',
    row: { id: 'ts-1', name: '待处理', type: 'pending' },
    contains: ['ts-1', '待处理', 'pending'],
  },
  {
    name: 'ticket-priorities',
    path: '/v1/ship/ticket/priorities',
    row: { id: 'tp-1', name: '紧急' },
    contains: ['tp-1', '紧急'],
  },
  {
    name: 'ticket-types',
    path: '/v1/ship/ticket/types',
    row: { id: 'ty-1', name: '故障' },
    contains: ['ty-1', '故障'],
  },
  {
    name: 'ticket-channels',
    path: '/v1/ship/ticket/channels',
    row: { id: 'ch-1', name: '邮件', description: '邮件渠道' },
    contains: ['ch-1', '邮件', '邮件渠道'],
  },
  {
    name: 'ticket-properties',
    path: '/v1/ship/ticket/properties',
    row: {
      id: 'solution',
      name: '解决方案',
      type: 'select',
      options: [{ _id: 'opt-9', text: '远程' }],
    },
    contains: ['solution', '解决方案', 'select', '远程=opt-9'],
  },
  {
    name: 'ticket-customers',
    path: '/v1/ship/products/prod-1/customers',
    row: { id: 'cust-1', name: 'Acme', assignee: { id: 'u1', name: '张三' }, scale: 3 },
    contains: ['cust-1', 'Acme', '张三', '3'],
  },
  {
    name: 'ticket-solutions',
    path: '/v1/ship/ticket/solutions',
    row: { id: 'sol-1', name: '重启服务' },
    contains: ['sol-1', '重启服务'],
  },
  {
    name: 'ticket-tags',
    path: '/v1/ship/ticket/tags',
    row: { id: 'tag-1', name: 'vip', color: '#f00' },
    contains: ['tag-1', 'vip', '#f00'],
  },
];

const harness = createCliHarness({ beforeEach, afterEach });

// ---------------------------------------------------------------------------
// product list
// ---------------------------------------------------------------------------

describe('product list', () => {
  it('emits the raw page envelope on stdout only under --json', async () => {
    const run = await harness.run(['product', 'list', '--json'], [productsPage]);
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      page_index: 0,
      total: 1,
      values: [{ id: PRODUCT_ID, identifier: IDENT }],
    });
    expect(new URL(run.calls[0]?.url ?? '').pathname).toBe('/v1/ship/products');
    expect(run.stderr).toBe('');
  });

  it('renders a table on stdout and the row count on stderr in human mode', async () => {
    const run = await harness.run(['product', 'list'], [productsPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('IDENTIFIER');
    expect(run.stdout).toContain(NAME);
    expect(run.stdout).toContain(IDENT);
    expect(run.stderr).toContain('row(s)');
    // the count annotation must never contaminate stdout
    expect(run.stdout).not.toContain('row(s)');
  });

  it('list drops empty identifier / name / visibility cells for a bare product', async () => {
    // Covers the `identifier ?? ''`, `name ?? ''`, `visibility ?? ''` fallbacks
    // in PRODUCT_COLUMNS.
    const bare = () =>
      jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'p9' }] });
    const run = await harness.run(['product', 'list'], [bare]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('p9');
    expect(run.stdout).not.toContain(IDENT);
  });

  it('forwards --keywords to the query (name only — identifier is not searchable)', async () => {
    const run = await harness.run(['product', 'list', '--keywords', 'Sales', '--json'], [productsPage]);
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[0]?.url ?? '').searchParams.get('keywords')).toBe('Sales');
  });

  it('forwards --include-archived and --include-deleted only when set', async () => {
    const none = await harness.run(['product', 'list', '--json'], [productsPage]);
    expect(new URL(none.calls[0]?.url ?? '').searchParams.get('include_archived')).toBeNull();
    expect(new URL(none.calls[0]?.url ?? '').searchParams.get('include_deleted')).toBeNull();

    const both = await harness.run(
      ['product', 'list', '--include-archived', '--include-deleted', '--json'],
      [productsPage],
    );
    const q = new URL(both.calls[0]?.url ?? '').searchParams;
    expect(q.get('include_archived')).toBe('true');
    expect(q.get('include_deleted')).toBe('true');
  });

  it('forwards --page / --page-size as page_index / page_size', async () => {
    const run = await harness.run(
      ['product', 'list', '--page', '2', '--page-size', '5', '--json'],
      [productsPage],
    );
    expect(run.exit).toBe(0);
    const q = new URL(run.calls[0]?.url ?? '').searchParams;
    expect(q.get('page_index')).toBe('2');
    expect(q.get('page_size')).toBe('5');
  });

  it('--all collects the (short) page into {values,count,all}', async () => {
    const run = await harness.run(['product', 'list', '--all', '--json'], [productsPage]);
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ all: true, count: 1 });
  });

  it('--all walks multiple pages, deduping and stopping at the limit', async () => {
    const page0 = () =>
      jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [{ id: 'p1', identifier: 'A' }] });
    const page1 = () =>
      jsonResponse({ page_index: 1, page_size: 1, total: 2, values: [{ id: 'p2', identifier: 'B' }] });
    const run = await harness.run(
      ['product', 'list', '--all', '--page-size', '1', '--limit', '2', '--json'],
      [page0, page1],
    );
    expect(run.exit).toBe(0);
    const out = JSON.parse(run.stdout) as { all: boolean; count: number; values: unknown[] };
    expect(out.all).toBe(true);
    expect(out.count).toBe(2);
    expect(out.values).toHaveLength(2);
    expect(run.calls).toHaveLength(2);
  });

  it('--dry-run still sends the GET read and writes nothing', async () => {
    const run = await harness.run(['product', 'list', '--dry-run', '--json'], [productsPage]);
    expect(run.exit).toBe(0);
    // dry-run only halts mutating verbs; a list read still runs.
    expect(run.writes).toEqual([]);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// product get
// ---------------------------------------------------------------------------

describe('product get', () => {
  it('resolves an identifier to an id before fetching the detail', async () => {
    const run = await harness.run(['product', 'get', IDENT, '--json'], [productsPage, productDetail]);
    expect(run.exit).toBe(0);
    expect((JSON.parse(run.stdout) as { id: string }).id).toBe(PRODUCT_ID);
    expect(new URL(run.calls[0]?.url ?? '').pathname).toBe('/v1/ship/products');
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe(`/v1/ship/products/${PRODUCT_ID}`);
  });

  it('passes a 24-hex id through the resolver untouched (no shape validation)', async () => {
    const run = await harness.run(
      ['product', 'get', PRODUCT_ID, '--json'],
      [productsPage, productDetail],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe(`/v1/ship/products/${PRODUCT_ID}`);
  });

  it('sends no include query when neither flag is set', async () => {
    const run = await harness.run(['product', 'get', IDENT, '--json'], [productsPage, productDetail]);
    expect(new URL(run.calls[1]?.url ?? '').search).toBe('');
  });

  it('adds include_archived only when the flag is set', async () => {
    const run = await harness.run(
      ['product', 'get', IDENT, '--include-archived', '--json'],
      [productsPage, productDetail],
    );
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('include_archived')).toBe('true');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('include_deleted')).toBeNull();
  });

  it('adds include_deleted only when the flag is set', async () => {
    const run = await harness.run(
      ['product', 'get', IDENT, '--include-deleted', '--json'],
      [productsPage, productDetail],
    );
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('include_deleted')).toBe('true');
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('include_archived')).toBeNull();
  });

  it('adds both include flags together', async () => {
    const run = await harness.run(
      ['product', 'get', IDENT, '--include-archived', '--include-deleted', '--json'],
      [productsPage, productDetail],
    );
    const q = new URL(run.calls[1]?.url ?? '').searchParams;
    expect(q.get('include_archived')).toBe('true');
    expect(q.get('include_deleted')).toBe('true');
  });

  it('renders the curated field block in human mode, with the member count and owner', async () => {
    const run = await harness.run(['product', 'get', IDENT], [productsPage, productDetail]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(NAME);
    expect(run.stdout).toContain(IDENT);
    expect(run.stdout).toContain(PRODUCT_ID);
    expect(run.stdout).toContain('private');
    expect(run.stdout).toContain('organization');
    expect(run.stdout).toContain('luoxiutao');
    expect(run.stdout).toContain('a product');
    expect(run.stdout).toContain('ship/products/prod-1');
    // the archived label is always shown; with is_archived=0 the value is "no".
    expect(run.stdout).toContain('archived');
    expect(run.stdout).not.toContain('yes');
  });

  it('prints "yes" when the product is archived', async () => {
    const run = await harness.run(
      ['product', 'get', IDENT],
      [productsPage, productDetailArchived],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('yes');
  });

  it('renders empty cells (not crashes) when the product omits optional fields', async () => {
    // A bare product: every optional field is absent, so each `?? ''` fallback
    // in runGet's field block is taken and timestampCell(undefined) → ''.
    const minimal = () => jsonResponse({ id: PRODUCT_ID, members: [], is_archived: 0 });
    const run = await harness.run(['product', 'get', IDENT], [productsPage, minimal]);
    expect(run.exit).toBe(0);
    // id, the zero member count and the archived row still render; the absent
    // optional fields collapse to '' and are dropped by printFields.
    expect(run.stdout).toContain(PRODUCT_ID);
    expect(run.stdout).toContain('members');
    expect(run.stdout).toContain('no');
  });

  it('reports an unknown product as exit 2 before the detail fetch', async () => {
    const run = await harness.run(['product', 'get', 'NoSuch', '--json'], [productsPage]);
    expect(run.exit).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.calls).toHaveLength(1);
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'usage', exit: 2 });
    expect(run.stderr).toContain('NoSuch');
  });

  it('lists candidates when the name is ambiguous', async () => {
    const run = await harness.run(
      ['product', 'get', 'Sales', '--json'],
      [ambiguousProductsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('matches 2');
  });
});

// ---------------------------------------------------------------------------
// product plan (需求排期) — read-only
// ---------------------------------------------------------------------------

describe('product plan', () => {
  it('list resolves --product first and emits the raw envelope on stdout only', async () => {
    const run = await harness.run(
      ['product', 'plan', 'list', '--product', IDENT, '--json'],
      [productsPage, plansPage],
    );
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ total: 1, values: [{ id: 'plan-1' }] });
    expect(run.calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/v1/ship/products',
      `/v1/ship/products/${PRODUCT_ID}/plans`,
    ]);
    expect(run.stderr).toBe('');
  });

  it('list forwards --page / --page-size to the plans endpoint', async () => {
    const run = await harness.run(
      ['product', 'plan', 'list', '--product', IDENT, '--page', '1', '--page-size', '5', '--json'],
      [productsPage, plansPage],
    );
    expect(run.exit).toBe(0);
    const q = new URL(run.calls[1]?.url ?? '').searchParams;
    expect(q.get('page_index')).toBe('1');
    expect(q.get('page_size')).toBe('5');
  });

  it('list --all walks pages and reports {values,count,all}', async () => {
    const p0 = () =>
      jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [{ id: 'plan-1' }] });
    const p1 = () =>
      jsonResponse({ page_index: 1, page_size: 1, total: 2, values: [{ id: 'plan-2' }] });
    const run = await harness.run(
      ['product', 'plan', 'list', '--product', IDENT, '--all', '--page-size', '1', '--json'],
      [productsPage, p0, p1],
    );
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ count: 2, all: true });
  });

  it('list renders the schedule window in human mode and counts rows on stderr', async () => {
    const run = await harness.run(
      ['product', 'plan', 'list', '--product', IDENT],
      [productsPage, plansPage],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('2026 Q3');
    expect(run.stdout).toContain('START');
    expect(run.stdout).toContain('luoxiutao');
    expect(run.stderr).toContain('row(s)');
    expect(run.stdout).not.toContain('row(s)');
  });

  it('list drops an empty name cell for a schedule that omits it', async () => {
    // Covers the `name ?? ''` fallback in SHIP_PLAN_COLUMNS.
    const namelessPlansPage = () =>
      jsonResponse({
        page_index: 0,
        page_size: 30,
        total: 1,
        values: [
          {
            id: 'plan-9',
            assignee: { id: 'u1', name: 'luoxiutao' },
            start_at: 1780243027,
            end_at: 1780620720,
          },
        ],
      });
    const run = await harness.run(
      ['product', 'plan', 'list', '--product', IDENT],
      [productsPage, namelessPlansPage],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('plan-9');
    expect(run.stdout).toContain('luoxiutao');
    expect(run.stdout).toContain('START');
    expect(run.stdout).not.toContain('2026 Q3');
  });

  it('list --dry-run still resolves the product and reads the plans', async () => {
    const run = await harness.run(
      ['product', 'plan', 'list', '--product', IDENT, '--dry-run', '--json'],
      [productsPage, plansPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toEqual([]);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.method).toBe('GET');
  });

  it('get puts the plan under the resolved product', async () => {
    const run = await harness.run(
      ['product', 'plan', 'get', 'plan-1', '--product', IDENT, '--json'],
      [productsPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe(
      `/v1/ship/products/${PRODUCT_ID}/plans/plan-1`,
    );
  });

  it('get renders the schedule block in human mode', async () => {
    const run = await harness.run(
      ['product', 'plan', 'get', 'plan-1', '--product', IDENT],
      [productsPage, planDetail],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('plan-1');
    expect(run.stdout).toContain('2026 Q3');
    expect(run.stdout).toContain(NAME);
    expect(run.stdout).toContain('luoxiutao');
    expect(run.stdout).toContain('ship/products/prod-1/plans/plan-1');
  });

  it('get reports an unknown schedule as exit 7 (vendor code 100721, deliberately unmapped)', async () => {
    const run = await harness.run(
      ['product', 'plan', 'get', 'ghost', '--product', IDENT, '--json'],
      [productsPage, () => jsonResponse({ code: '100721', message: '产品排期不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(7);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number; code: string } };
    expect(error.error).toMatchObject({ kind: 'api', exit: 7, code: '100721' });
  });

  it('get requires a resolvable --product before any plan request', async () => {
    const run = await harness.run(
      ['product', 'plan', 'get', 'plan-1', '--product', 'NoSuch', '--json'],
      [productsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('NoSuch');
  });
});

// ---------------------------------------------------------------------------
// product meta — every ship lookup is scoped to one product
// ---------------------------------------------------------------------------

describe('product meta lookups', () => {
  for (const { name, path, row, contains } of META_CASES) {
    it(`meta ${name} resolves the product and renders its columns in human mode`, async () => {
      const run = await harness.run(
        ['product', 'meta', name, '--product', IDENT],
        [productsPage, metaPage(row)],
      );
      expect(run.exit).toBe(0);
      expect(new URL(run.calls[0]?.url ?? '').pathname).toBe('/v1/ship/products');
      const listUrl = new URL(run.calls[1]?.url ?? '');
      expect(listUrl.pathname).toBe(path);
      // path-scoped lookups (members, customers) carry no ?product_id=.
      if (!path.includes('/products/')) {
        expect(listUrl.searchParams.get('product_id')).toBe(PRODUCT_ID);
      }
      for (const fragment of contains) {
        expect(run.stdout).toContain(fragment);
      }
      expect(run.stderr).toContain('row(s)');
    });
  }

  it('meta resolves a product id pass-through (no name lookup)', async () => {
    const run = await harness.run(
      ['product', 'meta', 'idea-states', '--product', PRODUCT_ID, '--json'],
      [productsPage, () => jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'st-1' }] })],
    );
    expect(run.exit).toBe(0);
    const listUrl = new URL(run.calls[1]?.url ?? '');
    expect(listUrl.pathname).toBe('/v1/ship/idea/states');
    expect(listUrl.searchParams.get('product_id')).toBe(PRODUCT_ID);
    expect(JSON.parse(run.stdout)).toEqual({ values: [{ id: 'st-1' }], count: 1 });
  });

  it('meta members falls back to user_group when user is absent', async () => {
    const row = {
      id: 'g1',
      type: 'user_group',
      user_group: { id: 'g1', name: '开发组' },
      role: { id: 'r1', name: '成员' },
    };
    const run = await harness.run(
      ['product', 'meta', 'members', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('开发组');
    expect(run.stdout).toContain('user_group');
  });

  it('meta drops empty name and color cells for a tag that omits them', async () => {
    // Covers the `name ?? ''` and `color ?? ''` fallbacks in SHIP_TAG_COLUMNS.
    const row = { id: 'tag-2' };
    const run = await harness.run(
      ['product', 'meta', 'ticket-tags', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('tag-2');
    expect(run.stdout).not.toContain('vip');
  });

  it('meta drops an empty name cell for an idea-plan summary that omits it', async () => {
    // Covers the `name ?? ''` fallback in SHIP_PLAN_SUMMARY_COLUMNS.
    const row = { id: 'plan-2' };
    const run = await harness.run(
      ['product', 'meta', 'idea-plans', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('plan-2');
  });

  it('meta solutions drops an empty name cell', async () => {
    const row = { id: 'sol-2' };
    const run = await harness.run(
      ['product', 'meta', 'ticket-solutions', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('sol-2');
    expect(run.stdout).not.toContain('重启服务');
  });

  it('meta customers drops empty name / assignee / scale cells', async () => {
    // Covers the `name ?? ''` and `scale === undefined ? ''` fallbacks.
    const row = { id: 'cust-2' };
    const run = await harness.run(
      ['product', 'meta', 'ticket-customers', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('cust-2');
    expect(run.stdout).not.toContain('Acme');
  });

  it('meta ticket-types drops an empty name cell', async () => {
    // Covers the `name ?? ''` fallback in SHIP_TICKET_TYPE_COLUMNS.
    const row = { id: 'ty-2' };
    const run = await harness.run(
      ['product', 'meta', 'ticket-types', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('ty-2');
    expect(run.stdout).not.toContain('故障');
  });

  it('meta ticket-channels drops empty name and description cells', async () => {
    // Covers the `name ?? ''` and `description ?? ''` fallbacks.
    const row = { id: 'ch-2' };
    const run = await harness.run(
      ['product', 'meta', 'ticket-channels', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('ch-2');
    expect(run.stdout).not.toContain('邮件');
  });

  it('meta idea-properties drops empty name and type cells', async () => {
    // Covers the `name ?? ''` and `type ?? ''` fallbacks. options must be an
    // array — the OPTIONS cell calls .map on it.
    const row = { id: 'p2', options: [] };
    const run = await harness.run(
      ['product', 'meta', 'idea-properties', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('p2');
    expect(run.stdout).not.toContain('需求类型');
  });

  it('meta members drops an empty type cell', async () => {
    // Covers the `type ?? ''` fallback in SHIP_MEMBER_COLUMNS.
    const row = { id: 'm2' };
    const run = await harness.run(
      ['product', 'meta', 'members', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('m2');
    expect(run.stdout).not.toContain('user_group');
  });

  it('meta idea-states drops empty name and group cells', async () => {
    // Covers the `name ?? ''` and `type ?? ''` fallbacks in SHIP_STATE_COLUMNS.
    const row = { id: 'st-2' };
    const run = await harness.run(
      ['product', 'meta', 'idea-states', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('st-2');
    expect(run.stdout).not.toContain('pending');
  });

  it('meta idea-priorities drops an empty name cell', async () => {
    // Covers the `name ?? ''` fallback in SHIP_PRIORITY_COLUMNS.
    const row = { id: 'pr-2' };
    const run = await harness.run(
      ['product', 'meta', 'idea-priorities', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('pr-2');
  });

  it('meta idea-suites drops empty name and type cells', async () => {
    // Covers the `name ?? ''` and `type ?? ''` fallbacks in SHIP_SUITE_COLUMNS.
    const row = { id: 'su-2', parent: { id: 'su-root', name: '客户端' } };
    const run = await harness.run(
      ['product', 'meta', 'idea-suites', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('su-2');
    expect(run.stdout).toContain('客户端');
    expect(run.stdout).not.toContain('module');
  });

  it('meta renders ?=? for a property option missing text or _id', async () => {
    const row = {
      id: 'p1',
      name: 'P',
      type: 'select',
      options: [{ text: 'only-text' }, { _id: 'only-id' }],
    };
    const run = await harness.run(
      ['product', 'meta', 'idea-properties', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('only-text=?');
    expect(run.stdout).toContain('?=only-id');
  });

  it('meta drops the parent cell when a suite has no parent', async () => {
    const row = { id: 'su-1', name: '登录', type: 'product' };
    const run = await harness.run(
      ['product', 'meta', 'idea-suites', '--product', IDENT],
      [productsPage, metaPage(row)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('登录');
    expect(run.stdout).toContain('product');
  });

  it('meta reports an unknown product as exit 2 before the lookup', async () => {
    const run = await harness.run(
      ['product', 'meta', 'idea-states', '--product', 'NoSuch', '--json'],
      [productsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('NoSuch');
  });

  it('meta reports an ambiguous product name as exit 2', async () => {
    const run = await harness.run(
      ['product', 'meta', 'idea-states', '--product', 'Sales', '--json'],
      [ambiguousProductsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('matches 2');
  });
});

// ---------------------------------------------------------------------------
// stdout / stderr contract
// ---------------------------------------------------------------------------

describe('product json stdout contract', () => {
  it('keeps stdout JSON-only and stderr empty across every read leaf', async () => {
    const list = await harness.run(['product', 'list', '--json'], [productsPage]);
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const got = await harness.run(
      ['product', 'get', IDENT, '--json'],
      [productsPage, productDetail],
    );
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();

    const planList = await harness.run(
      ['product', 'plan', 'list', '--product', IDENT, '--json'],
      [productsPage, plansPage],
    );
    expect(planList.exit).toBe(0);
    expect(planList.stderr).toBe('');
    expect(() => JSON.parse(planList.stdout)).not.toThrow();

    const planGet = await harness.run(
      ['product', 'plan', 'get', 'plan-1', '--product', IDENT, '--json'],
      [productsPage, planDetail],
    );
    expect(planGet.exit).toBe(0);
    expect(planGet.stderr).toBe('');
    expect(() => JSON.parse(planGet.stdout)).not.toThrow();

    const meta = await harness.run(
      ['product', 'meta', 'idea-states', '--product', IDENT, '--json'],
      [productsPage, () => jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'st-1' }] })],
    );
    expect(meta.exit).toBe(0);
    expect(meta.stderr).toBe('');
    expect(() => JSON.parse(meta.stdout)).not.toThrow();
  });

  it('has no create / update / delete leaf: a product is permanent, so an unknown verb is refused', async () => {
    const run = await harness.run(['product', 'create'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });
});
