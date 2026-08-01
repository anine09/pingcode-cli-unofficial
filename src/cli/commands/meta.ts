import type { Command } from 'commander';
import {
  iterateUsers,
  listSprints,
  listUsers,
  listWorkItemPriorities,
  listWorkItemStates,
  listWorkItemTypes,
  type SprintListQuery,
  type UserListQuery,
} from '../../api/meta';
import {
  listIdeaPriorities,
  listIdeaProperties,
  listIdeaStates,
  listIdeaSuites,
  listProductMembers,
  listTicketChannels,
  listTicketPriorities,
  listTicketProperties,
  listTicketStates,
  listTicketTypes,
} from '../../api/ship';
import type { Ctx } from '../../core/context';
import { resolveProduct, resolveProject, resolveWorkItemType } from '../../core/metadata';
import { collect } from '../../core/paginate';
import type {
  ShipChannel,
  ShipPriority,
  ShipProductMember,
  ShipProperty,
  ShipState,
  ShipSuite,
  ShipTicketType,
  Sprint,
  User,
  WorkItemPriority,
  WorkItemState,
  WorkItemType,
} from '../../types/api';
import { addGlobalOptions } from '../globals';
import type { Column } from '../output';
import {
  addPagingOptions,
  contextFor,
  modeOf,
  printCollection,
  readPaging,
  refName,
  timestampCell,
  type PagingFlags,
} from './common';

/**
 * `pingcode meta …` — the id lookups a write cannot be built without.
 *
 * This group is load-bearing, not scope creep. In pjm, `type_id`, `state_id` and
 * `priority_id` are **project-scoped** (research §6.13). In ship, everything is
 * **product-scoped** — states, priorities, suites, types, channels, the writable
 * `properties` keys and the assignee candidate set (ship §5) — and ticket create
 * additionally *requires* a `type_id`, so `meta ticket-types` is mandatory rather
 * than convenient.
 */

type ProjectFlag = { project: string };
type StatesFlags = ProjectFlag & { type: string };
type SprintsFlags = ProjectFlag & { status?: string | undefined };
type UsersFlags = PagingFlags & { keywords?: string | undefined };
type ProductFlag = { product: string };

const TYPE_COLUMNS: Column<WorkItemType>[] = [
  { header: 'ID', value: (t) => t.id },
  { header: 'NAME', value: (t) => t.name ?? '', flex: true },
  { header: 'DESCRIPTION', value: (t) => t.description ?? '', flex: true },
];

const STATE_COLUMNS: Column<WorkItemState>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
  { header: 'GROUP', value: (s) => s.type ?? '' },
];

const PRIORITY_COLUMNS: Column<WorkItemPriority>[] = [
  { header: 'ID', value: (p) => p.id },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
];

const SPRINT_COLUMNS: Column<Sprint>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
  { header: 'STATUS', value: (s) => s.status ?? '' },
  { header: 'START', value: (s) => timestampCell(s.start_at) },
  { header: 'END', value: (s) => timestampCell(s.end_at) },
];

const USER_COLUMNS: Column<User>[] = [
  { header: 'ID', value: (u) => u.id },
  { header: 'NAME', value: (u) => u.display_name ?? u.name ?? '', flex: true },
  { header: 'USERNAME', value: (u) => u.username ?? '' },
  { header: 'EMAIL', value: (u) => u.email ?? '', flex: true },
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

export function registerMetaCommands(program: Command): void {
  const meta = program
    .command('meta')
    .description(
      'ids you need before writing: project-scoped for work items, product-scoped for ship',
    );

  addGlobalOptions(
    meta
      .command('types')
      .description('work-item types of a project (values for --type / type_id)')
      .requiredOption('--project <name|id>', 'project name or id'),
    { hidden: true },
  ).action(async (flags: ProjectFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const project = await resolveProject(ctx, flags.project);
    const values = await listWorkItemTypes(ctx, project.id);
    printCollection(values, TYPE_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    meta
      .command('states')
      .description('work-item states of one (project, type) pair — both are required')
      .requiredOption('--project <name|id>', 'project name or id')
      .requiredOption('--type <name|id>', 'work-item type name or id'),
    { hidden: true },
  ).action(async (flags: StatesFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const project = await resolveProject(ctx, flags.project);
    const type = await resolveWorkItemType(ctx, project.id, flags.type);
    const values = await listWorkItemStates(ctx, project.id, type.id);
    printCollection(values, STATE_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    meta
      .command('priorities')
      .description('work-item priorities of a project')
      .requiredOption('--project <name|id>', 'project name or id'),
    { hidden: true },
  ).action(async (flags: ProjectFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const project = await resolveProject(ctx, flags.project);
    const values = await listWorkItemPriorities(ctx, project.id);
    printCollection(values, PRIORITY_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    meta
      .command('sprints')
      .description('sprints of a project (scrum/hybrid only)')
      .requiredOption('--project <name|id>', 'project name or id')
      .option('--status <status>', 'pending | in_progress | completed'),
    { hidden: true },
  ).action(async (flags: SprintsFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const project = await resolveProject(ctx, flags.project);
    const query: SprintListQuery = {
      ...(flags.status === undefined ? {} : { status: flags.status as SprintListQuery['status'] }),
    };
    const values = await listSprints(ctx, project.id, query);
    printCollection(values, SPRINT_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    addPagingOptions(
      meta
        .command('users')
        .description('organisation members (scope pcp:read:global:team)')
        .option('--keywords <text>', 'fuzzy search over name and username'),
    ),
    { hidden: true },
  ).action(async (flags: UsersFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const paging = readPaging(flags);
    const query: UserListQuery = {
      ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
    };

    if (paging.all) {
      const values = await collect(
        iterateUsers(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
      );
      printCollection(values, USER_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listUsers(ctx, query, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    // `meta` commands all emit `{values,count}` in --json, even this paginated one,
    // so an agent never has to branch on which lookup it asked for
    // (research/s8-smoke.md, cosmetic nits). `--page`/`--page-size` still control
    // the request itself.
    printCollection(page.values, USER_COLUMNS, modeOf(ctx));
  });

  // -------------------------------------------------------------------------
  // ship: every lookup is scoped to one product
  // -------------------------------------------------------------------------

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
      const product = await resolveProduct(ctx, flags.product);
      printCollection(await load(ctx, product.id), columns, modeOf(ctx));
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
    'product-members',
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
