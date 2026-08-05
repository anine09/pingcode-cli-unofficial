import type { Command } from 'commander';
import {
  getProduct,
  getProductPlan,
  iterateProductPlans,
  iterateProducts,
  listIdeaPlans,
  listIdeaPriorities,
  listIdeaProperties,
  listIdeaStates,
  listIdeaSuites,
  listProductMembers,
  listProductPlans,
  listProducts,
  listTicketChannels,
  listTicketPriorities,
  listTicketProperties,
  listTicketStates,
  listTicketTypes,
  type ProductListQuery,
} from '../../api/ship';
import type { Ctx } from '../../core/context';
import { resolveProduct } from '../../core/metadata';
import { collect } from '../../core/paginate';
import type {
  ShipChannel,
  ShipPlan,
  ShipPlanSummary,
  ShipPriority,
  ShipProduct,
  ShipProductMember,
  ShipProperty,
  ShipState,
  ShipSuite,
  ShipTicketType,
} from '../../types/api';
import { addGlobalOptions } from '../globals';
import type { Column } from '../output';
import {
  addPagingOptions,
  contextFor,
  modeOf,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refName,
  requireFlag,
  timestampCell,
  type PagingFlags,
} from './common';
import { registerIdeaCommands } from './idea';
import { registerTicketCommands } from './ticket';

/**
 * `pingcode product …` — the 产品管理 (ship) module, mirroring the GUI's own
 * grouping: the product itself, then its 需求 / 工单 resources, then the id
 * lookups every write inside the module needs.
 *
 * `product list|get` is `GET /v1/ship/products[/{id}]` (ship §A). A product is
 * the parent of everything else in ship: `state_id`, `priority_id`, `suite_id`,
 * `type_id`, `channel_id`, the `properties` keys and the assignee candidate set
 * are all resolved inside one product, so this group is the first call of any
 * ship workflow — and the reason the whole module hangs off it.
 *
 * There is deliberately no `create`, `update` or `delete`: ship exposes no
 * product DELETE at all, and `PATCH` edits only three cosmetic fields
 * (ship GOTCHA #15/#17). Product governance stays in the console.
 */

type ListFlags = PagingFlags & {
  keywords?: string | undefined;
  includeArchived?: boolean | undefined;
  includeDeleted?: boolean | undefined;
};

type GetFlags = {
  includeArchived?: boolean | undefined;
  includeDeleted?: boolean | undefined;
};

type ProductFlag = { product: string };

const PRODUCT_HELP = 'product name, identifier such as SLC, or id';

export const PRODUCT_COLUMNS: Column<ShipProduct>[] = [
  { header: 'IDENTIFIER', value: (p) => p.identifier ?? '' },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
  { header: 'VISIBILITY', value: (p) => p.visibility ?? '' },
  { header: 'ID', value: (p) => p.id },
];

const SHIP_STATE_COLUMNS: Column<ShipState>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
  { header: 'GROUP', value: (s) => s.type ?? '' },
];

const SHIP_PRIORITY_COLUMNS: Column<ShipPriority>[] = [
  { header: 'ID', value: (p) => p.id },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
];

const SHIP_SUITE_COLUMNS: Column<ShipSuite>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
  { header: 'TYPE', value: (s) => s.type ?? '' },
  { header: 'PARENT', value: (s) => refName(s.parent) },
];

const SHIP_PROPERTY_COLUMNS: Column<ShipProperty>[] = [
  { header: 'ID', value: (p) => p.id },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
  { header: 'TYPE', value: (p) => p.type ?? '' },
  {
    header: 'OPTIONS',
    value: (p) =>
      p.options
        .map((option) => `${option.text ?? '?'}=${option._id ?? '?'}`)
        .join(' | '),
    flex: true,
  },
];

const SHIP_MEMBER_COLUMNS: Column<ShipProductMember>[] = [
  { header: 'ID', value: (m) => m.id },
  {
    header: 'NAME',
    value: (m) => refName(m.user) || refName(m.user_group),
    flex: true,
  },
  { header: 'TYPE', value: (m) => m.type ?? '' },
  { header: 'ROLE', value: (m) => refName(m.role) },
];

const SHIP_TICKET_TYPE_COLUMNS: Column<ShipTicketType>[] = [
  { header: 'ID', value: (t) => t.id },
  { header: 'NAME', value: (t) => t.name ?? '', flex: true },
];

const SHIP_CHANNEL_COLUMNS: Column<ShipChannel>[] = [
  { header: 'ID', value: (c) => c.id },
  { header: 'NAME', value: (c) => c.name ?? '', flex: true },
  { header: 'DESCRIPTION', value: (c) => c.description ?? '', flex: true },
];

const SHIP_PLAN_SUMMARY_COLUMNS: Column<ShipPlanSummary>[] = [
  { header: 'ID', value: (p) => p.id },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
];

/** The full 排期 record; `product meta idea-plans` gets the thin one above. */
const SHIP_PLAN_COLUMNS: Column<ShipPlan>[] = [
  { header: 'ID', value: (p) => p.id },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
  { header: 'ASSIGNEE', value: (p) => refName(p.assignee) },
  { header: 'START', value: (p) => timestampCell(p.start_at) },
  { header: 'END', value: (p) => timestampCell(p.end_at) },
];

export function registerProductCommands(program: Command): void {
  const product = program
    .command('product')
    .description('产品管理 ship: products, ideas 需求, tickets 工单 (scope pcp:read:ship:product)')
    // Deliberately an epilog, not part of the description: a group description is also
    // rendered in `pingcode --help`, where a four-line warning would crowd out the other
    // nine groups (and `test/help/__snapshots__/root.test.ts.snap` pins that listing).
    // Everything below is visible on `pingcode product --help`, which is where someone
    // about to write is standing.
    .addHelpText(
      'after',
      '\nPERMANENT: nothing in this group can be deleted. ship publishes 8 DELETEs and every\n' +
        'one of them removes a configuration or membership row — a scheme entry, a product\n' +
        'member, a suite, a tag, an external user, a state flow — never a product, a\n' +
        'requirement or a ticket. So a requirement or ticket you create here is forever, and\n' +
        '`--dry-run` is worth the extra call. There is no archive either.\n',
    );

  addGlobalOptions(
    addPagingOptions(
      product
        .command('list')
        .description('list products')
        .option('--keywords <text>', 'search product names (the identifier is NOT searchable)')
        .option('--include-archived', 'include archived products')
        .option('--include-deleted', 'include deleted products'),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    product
      .command('get')
      .description('show one product, including its members')
      .argument('<product>', 'product name, identifier such as SLC, or id')
      .option('--include-archived', 'allow an archived product to be returned')
      .option('--include-deleted', 'allow a deleted product to be returned'),
    { hidden: true },
  ).action(async (target: string, flags: GetFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  // Registration order is asserted by `test/help.test.ts`: the group's own verbs
  // first, then the resource subgroups, then the lookups.
  registerIdeaCommands(product);
  registerTicketCommands(product);
  registerProductPlanCommands(product);
  registerProductMetaCommands(product);
}

// ---------------------------------------------------------------------------
// 需求排期 requirement schedules — read-only, and one of three unrelated "plans"
// ---------------------------------------------------------------------------

/**
 * `pingcode product plan list|get` — 需求排期 (ship §E), the schedule a 需求 can be
 * planned into and the values `product idea update --plan-id` takes.
 *
 * **Read-only, and provably rather than presumably**: `POST`, `PATCH` and `DELETE` on
 * the path all answer HTTP 405 `Method Not Allowed` (live 2026-08-05), so there is no
 * write leaf to add here later and no generic-layer route to one either.
 *
 * ⚠️ **"Plan" means three unrelated things in this API.** This group is the only 排期.
 * `pingcode testhub plans …` is a 测试计划 — a test cycle. And the `*_state_plans` /
 * `*_property_plans` families are **configuration schemes**, reachable only through
 * `pingcode api`. An id from one is never valid in another.
 */
function registerProductPlanCommands(parent: Command): void {
  const group = parent
    .command('plan')
    .description('需求排期 requirement schedules of a product, read-only (scope pcp:read:ship:product)');

  group.addHelpText(
    'after',
    '\nThis is a 需求排期 — the schedule a requirement is planned into, and the only\n' +
      'thing `pingcode product idea update --plan-id` accepts. It is NOT a 测试计划\n' +
      '(`pingcode testhub plans`) and NOT a configuration scheme (`ticket_state_plans`,\n' +
      '`idea_property_plans`), both of which this API also calls a "plan".\n' +
      'Read-only: create, update and delete all answer HTTP 405 upstream, so they are\n' +
      'unavailable through `pingcode api` too.\n' +
      'There is no filter flag because the endpoint documents none and an undeclared\n' +
      '`?name=` changed nothing when tried. Use --all and filter client-side.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list the requirement schedules of a product')
        .requiredOption('--product <name|id>', PRODUCT_HELP),
    ),
    { hidden: true },
  ).action(async (flags: PagingFlags & ProductFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const product = await resolveProduct(ctx, flags.product);
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateProductPlans(ctx, product.id, {
          pageSize: paging.pageSize,
          limit: paging.limit,
        }),
      );
      printCollection(values, SHIP_PLAN_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listProductPlans(ctx, product.id, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, SHIP_PLAN_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one requirement schedule')
      .argument('<plan-id>', 'schedule id, as printed by `product plan list` — names are not lookup keys')
      .requiredOption('--product <name|id>', PRODUCT_HELP)
      .addHelpText(
        'after',
        '\nA missing schedule exits 7, not 5: the vendor code (100721) is also what an idea\n' +
          'PATCH answers for an unknown --plan-id, and whether it can additionally mean\n' +
          '"exists, but in another product" could not be measured — no tenant reached so far\n' +
          'has a single 排期. Read the message, not just the exit code.\n',
      ),
    { hidden: true },
  ).action(async (planId: string, flags: ProductFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const product = await resolveProduct(ctx, flags.product);
    const plan = await getProductPlan(ctx, product.id, requireFlag(planId, '<plan-id>'));

    printResource(
      plan,
      [
        ['id', plan.id],
        ['name', plan.name ?? ''],
        ['product', refName(plan.product)],
        ['assignee', refName(plan.assignee)],
        ['start', timestampCell(plan.start_at)],
        ['end', timestampCell(plan.end_at)],
        ['url', plan.url ?? ''],
      ],
      modeOf(ctx),
    );
  });
}


// ---------------------------------------------------------------------------
// product meta: every ship lookup is scoped to one product
// ---------------------------------------------------------------------------

/**
 * `pingcode product meta …` — the id lookups a ship write cannot be built
 * without.
 *
 * This subgroup is load-bearing, not scope creep. In ship everything is
 * **product-scoped** — states, priorities, suites, types, channels, the writable
 * `properties` keys and the assignee candidate set (ship §5) — and ticket create
 * additionally *requires* a `type_id`, so `product meta ticket-types` is
 * mandatory rather than convenient.
 */
function registerProductMetaCommands(parent: Command): void {
  const meta = parent
    .command('meta')
    .description('ids you need before writing: every ship lookup is scoped to one product');

  function productScoped<T>(
    name: string,
    description: string,
    load: (ctx: Ctx, productId: string) => Promise<T[]>,
    columns: Column<T>[],
  ): void {
    addGlobalOptions(
      meta
        .command(name)
        .description(description)
        .requiredOption('--product <name|id>', 'product name, identifier such as SLC, or id'),
      { hidden: true },
    ).action(async (flags: ProductFlag, command: Command) => {
      const { ctx } = contextFor(command);
      const resolved = await resolveProduct(ctx, flags.product);
      printCollection(await load(ctx, resolved.id), columns, modeOf(ctx));
    });
  }

  productScoped(
    'idea-states',
    'idea states of a product (values for --state / state_id)',
    listIdeaStates,
    SHIP_STATE_COLUMNS,
  );
  productScoped(
    'idea-priorities',
    'idea priorities of a product',
    listIdeaPriorities,
    SHIP_PRIORITY_COLUMNS,
  );
  productScoped(
    'idea-suites',
    'requirement modules 需求模块 of a product (a tree, listed flat with parents)',
    listIdeaSuites,
    SHIP_SUITE_COLUMNS,
  );
  productScoped(
    'idea-properties',
    'writable idea property keys and their option ids — the only source for --set values',
    listIdeaProperties,
    SHIP_PROPERTY_COLUMNS,
  );
  productScoped(
    'idea-plans',
    'requirement schedules 需求排期 of a product (values for `idea update --plan-id`); `product plan list` shows the same rows with their dates',
    listIdeaPlans,
    SHIP_PLAN_SUMMARY_COLUMNS,
  );
  productScoped(
    'members',
    'members of a product — the only valid --assignee candidates',
    listProductMembers,
    SHIP_MEMBER_COLUMNS,
  );
  productScoped(
    'ticket-states',
    'ticket states of a product (values for --state / state_id)',
    listTicketStates,
    SHIP_STATE_COLUMNS,
  );
  productScoped(
    'ticket-priorities',
    'ticket priorities of a product',
    listTicketPriorities,
    SHIP_PRIORITY_COLUMNS,
  );
  productScoped(
    'ticket-types',
    'ticket types of a product — required to create a ticket',
    listTicketTypes,
    SHIP_TICKET_TYPE_COLUMNS,
  );
  productScoped(
    'ticket-channels',
    'ticket channels of a product (set once, at create time)',
    listTicketChannels,
    SHIP_CHANNEL_COLUMNS,
  );
  productScoped(
    'ticket-properties',
    'writable ticket property keys and their option ids — the only source for --set values',
    listTicketProperties,
    SHIP_PROPERTY_COLUMNS,
  );
}

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const query: ProductListQuery = {
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
    ...(flags.includeArchived === true ? { include_archived: true } : {}),
    ...(flags.includeDeleted === true ? { include_deleted: true } : {}),
  };

  if (paging.all) {
    const values = await collect(
      iterateProducts(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, PRODUCT_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listProducts(ctx, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, PRODUCT_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: GetFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const resolved = await resolveProduct(ctx, requireFlag(target, '<product>'));
  const product = await getProduct(ctx, resolved.id, {
    ...(flags.includeArchived === true ? { include_archived: true } : {}),
    ...(flags.includeDeleted === true ? { include_deleted: true } : {}),
  });

  printResource(
    product,
    [
      ['name', product.name ?? ''],
      ['identifier', product.identifier ?? ''],
      ['id', product.id],
      ['visibility', product.visibility ?? ''],
      ['scope', product.scope_type ?? ''],
      ['members', String(product.members.length)],
      ['owner', refName(product.created_by)],
      ['archived', product.is_archived ? 'yes' : 'no'],
      ['created', timestampCell(product.created_at)],
      ['updated', timestampCell(product.updated_at)],
      ['url', product.url ?? ''],
      ['description', product.description ?? ''],
    ],
    modeOf(ctx),
  );
}
