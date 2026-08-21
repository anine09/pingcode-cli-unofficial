import type { Command } from 'commander';
import { listWorkItemStates } from '../../api/meta';
import {
  addWorkItemTag,
  bulkUpdateWorkItems,
  createWorkItem,
  createWorkItemLink,
  deleteWorkItem,
  deleteWorkItemLink,
  deleteWorkItemTag,
  findWorkItemByIdentifier,
  getWorkItem,
  getWorkItemLink,
  getWorkItemTag,
  getWorkItemTransitionHistory,
  iterateWorkItemLinks,
  iterateWorkItemTransitionHistories,
  iterateSearchWorkItems,
  iterateWorkItems,
  listWorkItemLinks,
  listWorkItemTagVocabulary,
  listWorkItemTransitionHistories,
  listWorkItems,
  searchWorkItems,
  updateWorkItem,
  type BulkUpdateWorkItemsInput,
  type CreateWorkItemInput,
  type UpdateWorkItemInput,
  type WorkItemListQuery,
} from '../../api/workItems';
import type { Ctx } from '../../core/context';
import { ApiError, NotFoundError, PingcodeError, UsageError } from '../../core/errors';
import {
  parseWorkItemRef,
  resolveProject,
  resolveProjectVersion,
  resolveRelationType,
  resolveSprint,
  resolveUser,
  resolveWorkItem,
  resolveWorkItemPriority,
  resolveWorkItemType,
  resolveBoard,
  resolveEntry,
  resolveSwimlane,
  resolveWorkItemTag,
  type ResolveResult,
  type WorkItemLocator,
} from '../../core/metadata';
import { collect, type SearchPayload } from '../../core/paginate';
import type {
  Ref,
  WorkItem,
  WorkItemBulkUpdateResult,
  WorkItemLink,
  WorkItemTagAttachment,
  WorkItemTransitionHistory,
} from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import { addCrosscutting } from './_shared/crosscutting';
import {
  addPagingOptions,
  addStateOptions,
  collectValue,
  contextFor,
  dateRangeFilter,
  modeOf,
  parseDateBoundaryFlag,
  parseNumberFlag,
  parseTimestampFlag,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refName,
  requireFlag,
  resolveStateFlags,
  runWrite,
  timestampCell,
  type PagingFlags,
  type ResolvedWrite,
  type StateFlags,
} from './common';

/**
 * `pingcode project work-item …` — the work item itself, its typed links to other
 * work items, its tags, and its state history.
 *
 * Three rules from the design shape this file:
 *  - **replace, not merge**: only fields given on the command line are sent, and
 *    arrays / `properties` replace their previous value wholesale (design §7.2);
 *  - a `PATCH` with **zero** fields is a `UsageError` (exit 2) raised here, before
 *    the request layer is reached;
 *  - `transition` is `update --state` with better errors — one code path, and on
 *    rejection the candidate states for the item's type are printed, because state
 *    changes are workflow-validated (design §7.1, research §6.12).
 */

type ListFlags = PagingFlags &
  StateFlags & {
    project: string;
    type?: string | undefined;
    assignee?: string | undefined;
    sprint?: string | undefined;
    parent?: string | undefined;
    keywords?: string | undefined;
    /** The five below switch the transport to `POST …/search` — see `runList`. */
    titleContains?: string | undefined;
    createdAfter?: string | undefined;
    createdBefore?: string | undefined;
    updatedAfter?: string | undefined;
    updatedBefore?: string | undefined;
    unassigned?: boolean | undefined;
    // ---- REST + search 共有 ----
    priority?: string | undefined;
    board?: string | undefined;
    entry?: string | undefined;
    swimlane?: string | undefined;
    phase?: string | undefined;
    release?: string | undefined;
    tag?: string | undefined;
    createdBy?: string | undefined;
    participant?: string | undefined;
    // ---- search-only ----
    descriptionContains?: string | undefined;
    startAfter?: string | undefined;
    startBefore?: string | undefined;
    endAfter?: string | undefined;
    endBefore?: string | undefined;
    completedAfter?: string | undefined;
    completedBefore?: string | undefined;
    storyPoints?: string | undefined;
    // ---- REST-only ----
    identifier?: string | undefined;
    bugType?: string | undefined;
  };

type CreateFlags = StateFlags & {
  project: string;
  type: string;
  title: string;
  description?: string | undefined;
  assignee?: string | undefined;
  priority?: string | undefined;
  parent?: string | undefined;
  sprint?: string | undefined;
  /** Board / entry / swimlane — resolved by name against the project's boards. */
  board?: string | undefined;
  entry?: string | undefined;
  swimlane?: string | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
};

type UpdateFlags = StateFlags & {
  title?: string | undefined;
  description?: string | undefined;
  /** Only ever used to resolve `--state <name>` and to list candidate states. */
  type?: string | undefined;
  assignee?: string | undefined;
  priority?: string | undefined;
  parent?: string | undefined;
  sprint?: string | undefined;
  /** Board / entry / swimlane — resolved by name against the project's boards. */
  board?: string | undefined;
  entry?: string | undefined;
  swimlane?: string | undefined;
  /**
   * Repeatable, and the collected list **replaces** `version_ids` wholesale. Named
   * `--release`, not `--version`, for a hard reason — see the note on the option.
   */
  release?: string[] | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
  storyPoints?: string | undefined;
  estimatedWorkload?: string | undefined;
  remainingWorkload?: string | undefined;
};

/**
 * `--type` used to be mandatory for a state *name* because the CLI believed the API
 * never reported a work item's type. It does — as a bare slug string, live-verified
 * 2026-08-04 — so the flag is now an override, needed only when the item cannot be
 * read first (it never sends a `type_id`: `PATCH` has no such field).
 */
const TYPE_FLAG_HELP =
  'work-item type — overrides the type read off the item when resolving --state <name>, and lists candidate states on rejection; never sent';

/**
 * A work item's `type` is a **slug string** on the wire (`"task"`), not the reference
 * object every neighbouring field is. Both shapes are read here so no call site has to
 * know, and the slug doubles as the `work_item_type_id` a state lookup needs.
 */
export function typeIdOf(type: Ref | string | undefined): string | undefined {
  if (typeof type === 'string') return type === '' ? undefined : type;
  return type?.id;
}

/** What a table cell or a field block shows: the name if there is one, else the slug. */
export function typeLabelOf(type: Ref | string | undefined): string {
  if (typeof type === 'string') return type;
  return refName(type);
}

export const WORK_ITEM_COLUMNS: Column<WorkItem>[] = [
  { header: 'IDENTIFIER', value: (item) => item.identifier ?? item.short_id ?? item.id },
  { header: 'TITLE', value: (item) => item.title ?? '', flex: true },
  { header: 'TYPE', value: (item) => typeLabelOf(item.type) },
  { header: 'STATE', value: (item) => refName(item.state) },
  { header: 'ASSIGNEE', value: (item) => refName(item.assignee) },
  { header: 'END', value: (item) => timestampCell(item.end_at) },
];

export function registerWorkItemCommands(parent: Command): void {
  const group = parent
    .command('work-item')
    .description('work items (scopes pcp:read:pjm:workitem / pcp:write:pjm:workitem)');

  addGlobalOptions(
    addStateOptions(
      addPagingOptions(
        group
          .command('list')
          .description('list work items of a project (some filters switch to the search endpoint)')
          .requiredOption('--project <name|id>', 'project name or id')
          .option('--type <name|id>', 'work-item type')
          .option('--assignee <name|id>', 'assignee: display name, username, email or id')
          .option('--sprint <name|id>', 'sprint (scrum/hybrid projects only)')
          .option('--parent <ref>', 'only children of this work item: id, short_id, identifier or URL')
          .option('--keywords <text>', 'fuzzy search over title and description')
          .option('--identifier <text>', 'work-item identifier such as SCR-5 (REST list only)')
          .option('--priority <name|id>', 'priority')
          .option('--board <name|id>', 'board')
          .option('--entry <name|id>', 'board entry (column)')
          .option('--swimlane <name|id>', 'swimlane')
          .option('--phase <name|id>', 'phase')
          .option('--release <name|id>', 'release / version')
          .option('--tag <name|id>', 'tag')
          .option('--bug-type <id>', 'bug type id (REST list only, pass-through)')
          .option('--created-by <name|id>', 'creator: display name, username, email or id')
          .option('--participant <name|id>', 'participant: display name, username, email or id')
          .option('--unassigned', `${SEARCH_FLAG_MARK}only work items with no assignee`)
          .option('--title-contains <text>', `${SEARCH_FLAG_MARK}substring of the title`)
          .option('--description-contains <text>', `${SEARCH_FLAG_MARK}substring of the description`)
          .option('--start-after <date>', `${SEARCH_FLAG_MARK}start on or after this DATE`)
          .option('--start-before <date>', `${SEARCH_FLAG_MARK}start on or before this DATE`)
          .option('--end-after <date>', `${SEARCH_FLAG_MARK}end on or after this DATE`)
          .option('--end-before <date>', `${SEARCH_FLAG_MARK}end on or before this DATE`)
          .option('--completed-after <date>', `${SEARCH_FLAG_MARK}completed on or after this DATE`)
          .option('--completed-before <date>', `${SEARCH_FLAG_MARK}completed on or before this DATE`)
          .option('--story-points <n>', `${SEARCH_FLAG_MARK}story points (exact match)`)
          .option('--created-after <date>', `${SEARCH_FLAG_MARK}created on or after this DATE (00:00 local)`)
          .option('--created-before <date>', `${SEARCH_FLAG_MARK}created on or before this DATE (23:59 local)`)
          .option('--updated-after <date>', `${SEARCH_FLAG_MARK}updated on or after this DATE`)
          .option('--updated-before <date>', `${SEARCH_FLAG_MARK}updated on or before this DATE`),
      ),
      'filter by state',
      'requires --type',
    ),
    { hidden: true },
  )
    .addHelpText(
      'after',
      `\nFlags marked ${SEARCH_FLAG_MARK.trim()} can only be expressed by POST /v1/pjm/work_items/search, so\n` +
        'passing any of them switches this command to that endpoint. Paging, --all and the\n' +
        'reported total behave identically on both transports (verified live 2026-08-04), so\n' +
        'the switch is invisible except for which filters are available.\n' +
        'The two endpoints do filter on different things. Search cannot filter by\n' +
        'identifier, short_id or bug type at all; the simple list cannot filter by date,\n' +
        'title/description text, "unassigned" or story points. Everything else works in both.\n' +
        'Search-only flags: --title-contains, --description-contains, --unassigned,\n' +
        '--start-after/before, --end-after/before, --completed-after/before, --story-points,\n' +
        '--created-after/before, --updated-after/before.\n' +
        'REST-only flags: --identifier, --bug-type.\n',
    )
    .action(async (flags: ListFlags, command: Command) => {
      await runList(flags, command);
    });

  addGlobalOptions(
    group
      .command('get')
      .description('show one work item')
      .argument('<work-item>', 'id, short_id, identifier such as SCR-5, or a pasted work-item URL'),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    await runGet(target, command);
  });

  addGlobalOptions(
    addStateOptions(
      group
        .command('create')
        .description('create a work item (ids are project-scoped: run `pingcode project meta` first)')
        .requiredOption('--project <name|id>', 'project name or id')
        .requiredOption('--type <name|id>', 'work-item type, e.g. task / story / bug')
        .requiredOption('--title <text>', 'title')
        .option('--description <text>', 'description (rich text is accepted as plain text)')
        .option('--assignee <name|id>', 'assignee: display name, username, email or id')
        .option('--priority <name|id>', 'priority')
        .option('--parent <ref>', 'parent work item: id, short_id, identifier or URL')
        .option('--sprint <name|id>', 'sprint (scrum/hybrid projects only)')
        .option('--start-at <when>', 'unix seconds or a date like 2026-01-31')
        .option('--end-at <when>', 'unix seconds or a date like 2026-01-31')
        .option('--board <name|id>', '看板 board — list with `project board list`')
        .option('--entry <name|id>', '看板栏 board entry — list with `project board entries list`')
        .option('--swimlane <name|id>', '泳道 swimlane — list with `project board swimlanes list`'),
      'initial state',
      'requires --type, which create already requires',
    ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    addStateOptions(
      group
        .command('update')
        .description('patch a work item — only the fields you pass are sent, and they replace')
        .argument('<work-item>', 'id, short_id, identifier such as SCR-5, or a pasted URL')
        .option('--title <text>', 'new title')
        .option('--description <text>', 'new description (replaces the old one)')
        .option('--type <name|id>', TYPE_FLAG_HELP)
        .option('--assignee <name|id>', 'new assignee (the Open API cannot clear it — use the Web UI to unassign)')
        .option('--priority <name|id>', 'new priority')
        .option('--parent <ref>', 'new parent work item')
        .option('--sprint <name|id>', 'move into this sprint (scrum/hybrid projects only)')
        // NOT `--version`: the root program owns that flag, and commander's root parses
        // options across the whole argv, so `work-item update X --version 1.4.0` prints
        // the CLI version and exits 0 without sending anything (verified 2026-08-05 on
        // the built binary). A flag that silently succeeds while doing nothing is the
        // worst available failure, so the field takes the resolver's own label —
        // `pjm-version` is labelled *release*, and 发布 is what the API calls it.
        .option(
          '--release <name|id>',
          '发布/release to put this item on, repeatable — replaces the whole list (--version is the CLI\'s own flag)',
          collectValue,
        )
        .option('--start-at <when>', 'unix seconds or a date like 2026-01-31')
        .option('--end-at <when>', 'unix seconds or a date like 2026-01-31')
        .option('--story-points <n>', 'story points')
        .option('--estimated-workload <n>', 'estimated workload in hours')
        .option('--remaining-workload <n>', 'remaining workload in hours')
        .option('--board <name|id>', '看板 board — list with `project board list`')
        .option('--entry <name|id>', '看板栏 board entry — list with `project board entries list`')
        .option('--swimlane <name|id>', '泳道 swimlane — list with `project board swimlanes list`'),
      'new state',
    ),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\n--sprint and --release are how an item that already EXISTS joins a sprint or a\n' +
        'release; `create` has --sprint too, and `bulk-update` can do neither (it answers\n' +
        '200 / "updated 0" for sprint_id and version_ids alike, verified live).\n' +
        'The two fields have different shapes upstream, which is why the flags differ:\n' +
        '  - sprint_id is a SCALAR, so --sprint takes one sprint and moving an item from\n' +
        '    one sprint to another is a single call;\n' +
        '  - version_ids is an ARRAY that REPLACES, so --release is repeatable and the\n' +
        '    releases you pass become the complete list. Pass every release the item\n' +
        '    should end up on, in one invocation — `work-item get` prints the current\n' +
        '    ones. Omitting --release leaves the list alone.\n' +
        'NEITHER field can be EMPTIED, here or anywhere: `version_ids: []` is refused\n' +
        '(400 100006 "数组不能为空"), `null` answers 200 and changes nothing, and sprint_id\n' +
        'behaves the same (live 2026-08-05). You can move an item to a DIFFERENT sprint or\n' +
        'release; you cannot take it off all of them.\n' +
        'The flag is --release and NOT --version because `--version` belongs to the CLI\n' +
        'itself: it would print 0.1.0 and exit 0 without sending anything. This is the\n' +
        'same 发布/release these ids come from — `project version list` prints them.\n' +
        'Both names resolve per PROJECT, and the project comes from the work item itself,\n' +
        'so no --project is needed here. Both changes are audited: they appear in\n' +
        '`work-item activity list` as property_key iteration / version.\n',
    )
    .action(async (target: string, flags: UpdateFlags, command: Command) => {
      await runUpdate(target, flags, command);
    });

  addGlobalOptions(
    addStateOptions(
      group
        .command('transition')
        .description('move a work item to another state (workflow-validated by the server)')
        .argument('<work-item>', 'id, short_id, identifier such as SCR-5, or a pasted URL')
        .option('--type <name|id>', TYPE_FLAG_HELP),
      'target state',
    ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    if (
      (flags.state === undefined || flags.state.trim() === '') &&
      (flags.stateId === undefined || flags.stateId.trim() === '')
    ) {
      throw new UsageError('transition requires --state <name> or --state-id <id>', {
        hint: 'list the states of the item\'s type with `pingcode project meta states --project <p> --type <t>`',
      });
    }
    await runUpdate(target, flags, command);
  });

  addGlobalOptions(
    addStateOptions(
      group
        .command('bulk-update')
        .description('set ONE property on many work items in a single call')
        .requiredOption(
          '--id <ref>',
          'work item to change, repeatable: id, short_id, identifier or URL',
          collectValue,
        )
        .option('--project <name|id>', 'scope for resolving --state / --priority by NAME')
        .option('--type <name|id>', 'work-item type, needed with --state <name>')
        .option('--assignee <name|id>', 'new assignee')
        .option('--assignee-id <id>', 'new assignee, given as an id')
        .option('--priority <name>', 'new priority (needs --project)')
        .option('--priority-id <id>', 'new priority, given as an id')
        .option('--title <text>', 'new title — the same title for every work item')
        .option('--description <text>', 'new description — the same one for every work item')
        .option('--property <name>', 'any other property_name, for a property this CLI has no flag for')
        .option('--value <json>', 'the value for --property: JSON if it parses, otherwise the raw string'),
      'new state',
    ),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\nThe endpoint takes ONE property_name and ONE value, so exactly one of --assignee /\n' +
        '--assignee-id / --state / --state-id / --priority / --priority-id / --title /\n' +
        '--description / --property must be given. Two properties need two calls.\n' +
        'Verified to work upstream: assignee_id, state_id, priority_id, title, description.\n' +
        'Verified ACCEPTED AND SILENTLY IGNORED (HTTP 200, "updated 0"): sprint_id and\n' +
        'version_ids — so a bulk move into a sprint or onto a release is NOT possible here,\n' +
        'however valid the id. Do it ONE AT A TIME with `work-item update --sprint <s>` /\n' +
        '`work-item update --release <r>`, which patch the single-item endpoint and do work.\n' +
        'Also ignored here: type_id, tag_ids, participant_ids, properties, bug_type_id,\n' +
        'entry_id, swimlane_id, phase_id. parent_id and board_id are refused outright.\n' +
        '--property is the escape hatch for anything not listed; it is not validated, and a\n' +
        'property the server ignores still answers 200, so always read the "updated" count.\n' +
        'Other live facts worth knowing before scripting this:\n' +
        '  - it is BEST EFFORT, not atomic: an unknown id is skipped silently and the rest\n' +
        '    still land (the sprint/release bulk creates are atomic — do not generalise);\n' +
        '  - the change appears in NO activity record, unlike the single-item update, so it\n' +
        '    is invisible to an audit;\n' +
        '  - the ids may span projects, which is why --state / --priority by name need\n' +
        '    --project: their ids are project-scoped and one batch may not share a project;\n' +
        '  - each --id costs one read, because the endpoint accepts real ids only.\n',
    )
    .action(async (flags: BulkUpdateFlags, command: Command) => {
      await runBulkUpdate(flags, command);
    });

  addGlobalOptions(
    group
      .command('delete')
      .description('delete a work item — recoverable from the recycle bin in the web UI')
      .argument('<work-item>', 'id, short_id, identifier such as SCR-5, or a pasted URL')
      .option('--yes', 'confirm: the item leaves every list, sprint and board immediately'),
    { hidden: true },
  ).action(async (target: string, flags: YesFlag, command: Command) => {
    await runDelete(target, flags, command);
  });

  registerLinkCommands(group);
  registerTagCommands(group);
  registerHistoryCommands(group);

  // The four cross-object families, injected rather than written here (design D5.2).
  // All four accept `principal_type=work_item`, live-verified 2026-08-03. `relation`
  // is the cross-*kind* linker: work-item↔work-item links are the separate typed
  // family `/v1/pjm/work_items/{id}/relations`, which is `link` above.
  addCrosscutting(group, 'work_item', {
    resolveId: async (ctx, ref) => (await resolveWorkItem(ctx, ref)).id,
  });
}

// ---------------------------------------------------------------------------
// link: the TYPED, same-kind family — /v1/pjm/work_items/{id}/relations
// ---------------------------------------------------------------------------

const LINK_COLUMNS: Column<WorkItemLink>[] = [
  { header: 'LINK ID', value: (link) => link.id },
  { header: 'TYPE', value: (link) => link.relation_type ?? '' },
  { header: 'TARGET', value: (link) => endRef(link.target_work_item, 'identifier') },
  { header: 'TITLE', value: (link) => endRef(link.target_work_item, 'title'), flex: true },
];

/**
 * `pingcode project work-item link …` — work item ↔ work item, **with a type**.
 *
 * This is the second of two unrelated "relation" families, and the help says which is
 * which because nothing else will (design D7.6, F5):
 *
 *  - `link` (here) is `/v1/pjm/work_items/{id}/relations`: both ends are work items,
 *    a `relation_type` is **required**, and the server maintains the inverse edge.
 *  - `relation` (the injected cross-object family) is `/v1/relations`: it links
 *    objects of **different** kinds — a work item to an idea, a ticket, a test case, a
 *    wiki page — has no type at all, and **refuses** work-item→work-item outright
 *    (400 `100049`).
 */
function registerLinkCommands(parent: Command): void {
  const group = parent
    .command('link')
    .description('typed links between two WORK ITEMS (blocks, duplicates, relates, …)');

  group.addHelpText(
    'after',
    '\nUse `link` for work item ↔ work item and `relation` for work item ↔ anything else:\n' +
      'the cross-kind /v1/relations family refuses two work items, and this one accepts\n' +
      'nothing but work items. Only this family has a type.\n' +
      'List the types with `pingcode project meta relation-types`. --relation takes the\n' +
      'localized name (关联), the stable category slug (relate) or the id; the slug is the\n' +
      'safest, because the ids differ per tenant.\n' +
      'The server keeps the INVERSE edge in step: adding "block" here adds "blocked_by"\n' +
      'there, and deleting either side removes both. The two sides have DIFFERENT link\n' +
      'ids, so delete the one `link list` printed for the work item you are on.\n' +
      'Links may cross projects, and a work item can be linked to itself (the API allows\n' +
      'it; nothing here stops you).\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list the work items linked to this one')
        .argument('<work-item>', WORK_ITEM_REF_HELP)
        .option('--relation <name|id>', 'only links of this type')
        .option('--relation-id <id>', 'only links of this type, given as an id'),
    ),
    { hidden: true },
  ).action(async (target: string, flags: PagingFlags & RelationFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
    const relation = await resolveRelationFlags(ctx, flags);
    const query = relation === undefined ? {} : { relation_type: relation.id };
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateWorkItemLinks(ctx, item.id, query, {
          pageSize: paging.pageSize,
          limit: paging.limit,
        }),
      );
      printCollection(values, LINK_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listWorkItemLinks(ctx, item.id, query, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, LINK_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one link — the work item in the path is checked, unlike a release')
      .argument('<work-item>', WORK_ITEM_REF_HELP)
      .argument('<link-id>', 'link id, as printed by `link list` for THIS work item'),
    { hidden: true },
  ).action(async (target: string, linkId: string, _flags: unknown, command: Command) => {
    const { ctx } = contextFor(command);
    const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
    printLink(await getWorkItemLink(ctx, item.id, requireFlag(linkId, '<link-id>')), ctx);
  });

  addGlobalOptions(
    group
      .command('add')
      .description('link this work item to another one, with a type')
      .argument('<work-item>', WORK_ITEM_REF_HELP)
      .requiredOption('--target <ref>', `the other work item — ${WORK_ITEM_REF_HELP}`)
      .option('--relation <name|id>', 'link type: category slug (relate), name (关联) or id')
      .option('--relation-id <id>', 'link type, given as an id (no lookup)'),
    { hidden: true },
  ).action(async (target: string, flags: AddLinkFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const link = await runWrite(
      ctx,
      async (attemptCtx): Promise<ResolvedWrite<{ id: string; input: { target_work_item_id: string; relation_type: string } }>> => {
        const item = await resolveWorkItem(attemptCtx, requireFlag(target, '<work-item>'));
        const other = await resolveWorkItem(attemptCtx, requireFlag(flags.target, '--target'));
        const relation = await resolveRelationFlags(attemptCtx, flags);
        if (relation === undefined) {
          throw new UsageError('link add requires --relation <name|id> or --relation-id <id>', {
            hint: 'the API requires a relation_type; list them with `pingcode project meta relation-types`',
          });
        }
        return {
          resolutions: [relation],
          value: {
            id: item.id,
            input: { target_work_item_id: other.id, relation_type: relation.id },
          },
        };
      },
      async (attemptCtx, { id, input }) => await createWorkItemLink(attemptCtx, id, input),
    );
    printLink(link, ctx, 'linked');
  });

  addGlobalOptions(
    group
      .command('delete')
      .description('remove a link — both directions go at once')
      .argument('<work-item>', WORK_ITEM_REF_HELP)
      .argument('<link-id>', 'link id, as printed by `link list` for THIS work item')
      .option('--yes', 'confirm: the inverse link on the other work item goes too'),
    { hidden: true },
  ).action(async (target: string, linkId: string, flags: YesFlag, command: Command) => {
    const id = requireFlag(linkId, '<link-id>');
    const { ctx } = contextFor(command);
    const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
    // One read before the gate so the confirmation names both ends (design D8.1).
    const existing = await getWorkItemLink(ctx, item.id, id);
    if (flags.yes !== true) {
      throw new UsageError(
        `refusing to delete the ${existing.relation_type ?? 'link'} between ` +
          `${describeItem(item)} and ${endRef(existing.target_work_item, 'identifier')} without --yes`,
        {
          hint:
            'the inverse link on the other work item is removed too, and the two link ids do ' +
            'not come back. Re-run with --yes, or with --yes --dry-run to see the request first',
        },
      );
    }
    printLink(await deleteWorkItemLink(ctx, item.id, id), ctx, 'unlinked');
  });
}

// ---------------------------------------------------------------------------
// tag: add / get / delete. There is NO list, upstream.
// ---------------------------------------------------------------------------

/**
 * `pingcode project work-item tag …`.
 *
 * **There is no `tag list`, and there cannot be**: upstream documents
 * `POST …/{id}/tags`, `GET …/{id}/tags/{tag_id}` and `DELETE …/{id}/tags/{tag_id}`, and
 * no collection GET (research §3.8.3). A work item's own `tags[]` — printed by
 * `work-item get` — is the complete answer, and `project meta tags` is the only way to
 * enumerate the vocabulary.
 */
function registerTagCommands(parent: Command): void {
  const group = parent.command('tag').description('标签 tags on a work item (add / get / remove)');

  group.addHelpText(
    'after',
    '\nThere is no `tag list`: the API has no collection GET here (only add, get-one and\n' +
      'remove), so read the tags[] field of `work-item get` instead. Enumerate the\n' +
      'vocabulary with `pingcode project meta tags --project <p>`.\n' +
      'Tags are PROJECT-scoped on the write side but the vocabulary list is org-wide, so\n' +
      'most ids it prints belong to other projects and are refused here with\n' +
      '"\'tag\'资源不存在". If that happens, the tag exists — it just is not this project\'s.\n' +
      'Tag names are not unique either, so --tag <name> can be ambiguous; --tag-id always\n' +
      'works.\n' +
      'A second remove is safe HERE — this leaf reads the tag first, so it fails cleanly with\n' +
      '"工作项不包含此标签". The raw endpoint answers HTTP 500 to a repeat DELETE, so reach it\n' +
      'through `pingcode api DELETE` only if you are ready for that.\n',
  );

  addGlobalOptions(
    group
      .command('add')
      .description('add a tag to a work item')
      .argument('<work-item>', WORK_ITEM_REF_HELP)
      .option('--tag <name>', "tag name, resolved against the work item's project")
      .option('--tag-id <id>', 'tag id, sent unchanged (no lookup)'),
    { hidden: true },
  ).action(async (target: string, flags: TagFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
    const tagId = await tagIdOf(ctx, item, flags);
    try {
      printTag(await addWorkItemTag(ctx, item.id, tagId), ctx, 'tagged');
    } catch (error) {
      explainForeignTag(error);
      throw error;
    }
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one tag of a work item (there is no list — see above)')
      .argument('<work-item>', WORK_ITEM_REF_HELP)
      .argument('<tag-id>', "tag id, as printed by `work-item get`'s tags[] or `project meta tags`"),
    { hidden: true },
  ).action(async (target: string, tagId: string, _flags: unknown, command: Command) => {
    const { ctx } = contextFor(command);
    const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
    printTag(await getWorkItemTag(ctx, item.id, requireFlag(tagId, '<tag-id>')), ctx);
  });

  addGlobalOptions(
    group
      .command('delete')
      .description('remove a tag from a work item (the tag itself survives)')
      .argument('<work-item>', WORK_ITEM_REF_HELP)
      .argument('<tag-id>', 'tag id to remove')
      .option('--yes', 'confirm: re-adding it is one command, but this is still a write'),
    { hidden: true },
  ).action(async (target: string, tagId: string, flags: YesFlag, command: Command) => {
    const id = requireFlag(tagId, '<tag-id>');
    const { ctx } = contextFor(command);
    const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
    const existing = await getWorkItemTag(ctx, item.id, id);
    if (flags.yes !== true) {
      throw new UsageError(
        `refusing to remove tag ${describeTag(existing)} from ${describeItem(item)} without --yes`,
        {
          hint:
            're-add it with `tag add --tag-id ' +
            `${id}`.trim() +
            '`. A repeated remove through this leaf is safe — it reads the tag first — but the ' +
            'raw endpoint answers HTTP 500 to a repeat DELETE',
        },
      );
    }
    printTag(await deleteWorkItemTag(ctx, item.id, id), ctx, 'untagged');
  });
}

// ---------------------------------------------------------------------------
// history: state changes only
// ---------------------------------------------------------------------------

const HISTORY_COLUMNS: Column<WorkItemTransitionHistory>[] = [
  { header: 'ID', value: (row) => row.id },
  { header: 'WHEN', value: (row) => timestampCell(row.created_at) },
  { header: 'FROM', value: (row) => (row.from_state === undefined ? '(new)' : refName(row.from_state)) },
  { header: 'TO', value: (row) => refName(row.to_state) },
  { header: 'BY', value: (row) => refName(row.created_by), flex: true },
];

function registerHistoryCommands(parent: Command): void {
  const group = parent
    .command('history')
    .description('流转记录 the STATE history of a work item (read-only)');

  group.addHelpText(
    'after',
    '\nState changes only. A title, assignee or sprint change is not here — that is the\n' +
      '`activity` subgroup, which is the free-form audit feed. Every work item has one row\n' +
      'from creation, with FROM shown as (new).\n' +
      'A bulk update (`work-item bulk-update`) appears in NEITHER feed, verified live: it\n' +
      'changes the record without recording that it did.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list the state changes of a work item')
        .argument('<work-item>', WORK_ITEM_REF_HELP),
    ),
    { hidden: true },
  ).action(async (target: string, flags: PagingFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateWorkItemTransitionHistories(ctx, item.id, {
          pageSize: paging.pageSize,
          limit: paging.limit,
        }),
      );
      printCollection(values, HISTORY_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listWorkItemTransitionHistories(ctx, item.id, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, HISTORY_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one state change')
      .argument('<work-item>', WORK_ITEM_REF_HELP)
      .argument('<history-id>', 'transition record id, as printed by list'),
    { hidden: true },
  ).action(async (target: string, historyId: string, _flags: unknown, command: Command) => {
    const { ctx } = contextFor(command);
    const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
    const row = await getWorkItemTransitionHistory(
      ctx,
      item.id,
      requireFlag(historyId, '<history-id>'),
    );
    printResource(
      row,
      [
        ['id', row.id],
        ['work item', refName(row.work_item)],
        ['from', row.from_state === undefined ? '(new)' : refName(row.from_state)],
        ['to', refName(row.to_state)],
        ['by', refName(row.created_by)],
        ['when', timestampCell(row.created_at)],
      ],
      modeOf(ctx),
    );
  });
}

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);

  const project = await resolveProject(ctx, flags.project);
  const type =
    flags.type === undefined ? undefined : await resolveWorkItemType(ctx, project.id, flags.type);
  const state = await resolveStateFlags(ctx, flags, {
    projectId: project.id,
    ...(type === undefined ? {} : { typeId: type.id }),
  });
  const assignee = flags.assignee === undefined ? undefined : await resolveUser(ctx, flags.assignee);
  const sprint =
    flags.sprint === undefined ? undefined : await resolveSprint(ctx, project.id, flags.sprint);
  const parent = flags.parent === undefined ? undefined : await resolveWorkItem(ctx, flags.parent);
  const priority =
    flags.priority === undefined
      ? undefined
      : await resolveWorkItemPriority(ctx, project.id, flags.priority);
  const board =
    flags.board === undefined ? undefined : await resolveBoard(ctx, project.id, flags.board);
  const entry =
    flags.entry === undefined ? undefined : await resolveEntry(ctx, project.id, flags.entry);
  const swimlane =
    flags.swimlane === undefined
      ? undefined
      : await resolveSwimlane(ctx, project.id, flags.swimlane);
  const release =
    flags.release === undefined
      ? undefined
      : await resolveProjectVersion(ctx, project.id, flags.release);
  const tag =
    flags.tag === undefined ? undefined : await resolveWorkItemTag(ctx, project.id, flags.tag);
  const createdBy =
    flags.createdBy === undefined ? undefined : await resolveUser(ctx, flags.createdBy);
  const participant =
    flags.participant === undefined ? undefined : await resolveUser(ctx, flags.participant);

  if (searchOnlyFlagsOf(flags).length > 0) {
    await runSearch(ctx, flags, paging, {
      projectId: project.id,
      ...(type === undefined ? {} : { typeId: type.id }),
      ...(state === undefined ? {} : { stateId: state.id }),
      ...(assignee === undefined ? {} : { assigneeId: assignee.id }),
      ...(sprint === undefined ? {} : { sprintId: sprint.id }),
      ...(parent === undefined ? {} : { parentId: parent.id }),
      ...(priority === undefined ? {} : { priorityId: priority.id }),
      ...(board === undefined ? {} : { boardId: board.id }),
      ...(entry === undefined ? {} : { entryId: entry.id }),
      ...(swimlane === undefined ? {} : { swimlaneId: swimlane.id }),
      ...(flags.phase === undefined ? {} : { phaseId: flags.phase }),
      ...(release === undefined ? {} : { versionId: release.id }),
      ...(tag === undefined ? {} : { tagId: tag.id }),
      ...(createdBy === undefined ? {} : { createdById: createdBy.id }),
      ...(participant === undefined ? {} : { participantId: participant.id }),
    });
    return;
  }

  const query: WorkItemListQuery = {
    project_id: project.id,
    ...(type === undefined ? {} : { type_id: type.id }),
    ...(state === undefined ? {} : { state_id: state.id }),
    ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
    ...(sprint === undefined ? {} : { sprint_id: sprint.id }),
    ...(parent === undefined ? {} : { parent_id: parent.id }),
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
    ...(flags.identifier === undefined ? {} : { identifier: flags.identifier }),
    ...(priority === undefined ? {} : { priority_id: priority.id }),
    ...(board === undefined ? {} : { board_id: board.id }),
    ...(entry === undefined ? {} : { entry_id: entry.id }),
    ...(swimlane === undefined ? {} : { swimlane_id: swimlane.id }),
    ...(flags.phase === undefined ? {} : { phase_id: flags.phase }),
    ...(release === undefined ? {} : { version_id: release.id }),
    ...(tag === undefined ? {} : { tag_id: tag.id }),
    ...(flags.bugType === undefined ? {} : { bug_type_id: flags.bugType }),
    ...(createdBy === undefined ? {} : { created_by: createdBy.id }),
    ...(participant === undefined ? {} : { participant_id: participant.id }),
  };

  if (paging.all) {
    const values = await collect(
      iterateWorkItems(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, WORK_ITEM_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listWorkItems(ctx, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, WORK_ITEM_COLUMNS, modeOf(ctx));
}

/** Which of the search-only flags the user passed. Empty ⇒ stay on the simple list. */
function searchOnlyFlagsOf(flags: ListFlags): string[] {
  const given: string[] = [];
  if (flags.unassigned === true) given.push('--unassigned');
  if (flags.titleContains !== undefined) given.push('--title-contains');
  if (flags.descriptionContains !== undefined) given.push('--description-contains');
  if (flags.startAfter !== undefined) given.push('--start-after');
  if (flags.startBefore !== undefined) given.push('--start-before');
  if (flags.endAfter !== undefined) given.push('--end-after');
  if (flags.endBefore !== undefined) given.push('--end-before');
  if (flags.completedAfter !== undefined) given.push('--completed-after');
  if (flags.completedBefore !== undefined) given.push('--completed-before');
  if (flags.storyPoints !== undefined) given.push('--story-points');
  if (flags.createdAfter !== undefined) given.push('--created-after');
  if (flags.createdBefore !== undefined) given.push('--created-before');
  if (flags.updatedAfter !== undefined) given.push('--updated-after');
  if (flags.updatedBefore !== undefined) given.push('--updated-before');
  return given;
}

/**
 * `POST /v1/pjm/work_items/search`.
 *
 * **This endpoint pages normally.** An earlier revision of this function believed it did
 * not, refused `--all` on that basis, and warned on every invocation that "there is no
 * way to ask for the rest". Both were wrong: the belief came from a probe that wrote the
 * cursor into the request *body*, where `buildSearchBody` overwrites it (design D16.1,
 * and the block above `searchWorkItems`). Re-measured live 2026-08-04 the index is
 * echoed, pages are disjoint, and 197 rows walk over seven pages of 30.
 *
 * The refusal was the more expensive half of the mistake, and is the reason this note is
 * long: a CLI that refuses a legal operation stops an agent dead, and no flag could
 * override it. Refusing something the API supports is worse than the round-trip a check
 * would have saved — the same conclusion `08-01-ship-cli`'s §14.3 reached about
 * pre-validating transitions.
 *
 * What *is* real, and stays: the two transports accept **different filters**, so the
 * switch has to be visible in `--help`, and a search-only flag combined with `--assignee`
 * is still a `UsageError`.
 */
async function runSearch(
  ctx: Ctx,
  flags: ListFlags,
  paging: { all: boolean; pageIndex: number; pageSize: number; limit: number },
  ids: {
    projectId: string;
    typeId?: string | undefined;
    stateId?: string | undefined;
    assigneeId?: string | undefined;
    sprintId?: string | undefined;
    parentId?: string | undefined;
    priorityId?: string | undefined;
    boardId?: string | undefined;
    entryId?: string | undefined;
    swimlaneId?: string | undefined;
    phaseId?: string | undefined;
    versionId?: string | undefined;
    tagId?: string | undefined;
    createdById?: string | undefined;
    participantId?: string | undefined;
  },
): Promise<void> {

  if (flags.unassigned === true && (flags.assignee !== undefined || ids.assigneeId !== undefined)) {
    throw new UsageError('--unassigned and --assignee are mutually exclusive');
  }

  const createdAfter =
    flags.createdAfter === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.createdAfter, '--created-after', 'start');
  const createdBefore =
    flags.createdBefore === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.createdBefore, '--created-before', 'end');
  const updatedAfter =
    flags.updatedAfter === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.updatedAfter, '--updated-after', 'start');
  const updatedBefore =
    flags.updatedBefore === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.updatedBefore, '--updated-before', 'end');
  const startAfter =
    flags.startAfter === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.startAfter, '--start-after', 'start');
  const startBefore =
    flags.startBefore === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.startBefore, '--start-before', 'end');
  const endAfter =
    flags.endAfter === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.endAfter, '--end-after', 'start');
  const endBefore =
    flags.endBefore === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.endBefore, '--end-before', 'end');
  const completedAfter =
    flags.completedAfter === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.completedAfter, '--completed-after', 'start');
  const completedBefore =
    flags.completedBefore === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.completedBefore, '--completed-before', 'end');

  const filter: Record<string, unknown> = { 'project.id': { in: [ids.projectId] } };
  // `type`, not `type.id`: the search vocabulary differs from the query string's, and
  // `type.id` / `type_id` are both refused with 400 `100043` (see `core/endpoints.ts`).
  if (ids.typeId !== undefined) filter.type = { in: [ids.typeId] };
  if (ids.stateId !== undefined) filter['state.id'] = { in: [ids.stateId] };
  if (ids.sprintId !== undefined) filter['sprint.id'] = { in: [ids.sprintId] };
  if (ids.parentId !== undefined) filter['parent.id'] = { in: [ids.parentId] };
  if (ids.priorityId !== undefined) filter['priority.id'] = { in: [ids.priorityId] };
  if (ids.boardId !== undefined) filter['board.id'] = { in: [ids.boardId] };
  if (ids.entryId !== undefined) filter['entry.id'] = { in: [ids.entryId] };
  if (ids.swimlaneId !== undefined) filter['swimlane.id'] = { in: [ids.swimlaneId] };
  if (ids.phaseId !== undefined) filter['phase.id'] = { in: [ids.phaseId] };
  if (ids.versionId !== undefined) filter['versions.id'] = { in: [ids.versionId] };
  if (ids.tagId !== undefined) filter['tags.id'] = { in: [ids.tagId] };
  if (ids.createdById !== undefined) filter['created_by.id'] = { in: [ids.createdById] };
  if (ids.participantId !== undefined) filter['participants.id'] = { in: [ids.participantId] };
  if (flags.unassigned === true) filter['assignee.id'] = { exists: false };
  else if (ids.assigneeId !== undefined) filter['assignee.id'] = { in: [ids.assigneeId] };
  if (flags.titleContains !== undefined) filter.title = { contains: flags.titleContains };
  if (flags.descriptionContains !== undefined) filter.description = { contains: flags.descriptionContains };
  if (flags.storyPoints !== undefined) {
    const sp = parseNumberFlag(flags.storyPoints, '--story-points');
    if (sp !== undefined) filter.story_points = { eq: sp };
  }
  // One operator per field, so a two-sided window has to be `between`, not two entries.
  const created = dateRangeFilter(createdAfter, createdBefore);
  if (created !== undefined) filter.created_at = created;
  const updated = dateRangeFilter(updatedAfter, updatedBefore);
  if (updated !== undefined) filter.updated_at = updated;
  const start = dateRangeFilter(startAfter, startBefore);
  if (start !== undefined) filter.start_at = start;
  const end = dateRangeFilter(endAfter, endBefore);
  if (end !== undefined) filter.end_at = end;
  const completed = dateRangeFilter(completedAfter, completedBefore);
  if (completed !== undefined) filter.completed_at = completed;

  const payload: SearchPayload = {
    filter,
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
  };

  if (paging.all) {
    const values = await collect(
      iterateSearchWorkItems(ctx, payload, {
        pageSize: paging.pageSize,
        limit: paging.limit,
      }),
    );
    printCollection(values, WORK_ITEM_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await searchWorkItems(ctx, payload, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, WORK_ITEM_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const ref = parseWorkItemRef(requireFlag(target, '<work-item>'));

  // `GET /v1/pjm/work_items/{id}` takes an id **or** a short_id (research §6.9);
  // an identifier such as SCR-5 has to go through the list endpoint.
  const item =
    ref.kind === 'identifier'
      ? await getByIdentifier(ctx, ref.value)
      : await getWorkItem(ctx, ref.value);

  printWorkItem(item, ctx);
}

async function getByIdentifier(ctx: Ctx, identifier: string): Promise<WorkItem> {
  const matches = await findWorkItemByIdentifier(ctx, identifier);
  if (matches.length === 0) {
    throw new NotFoundError(`no work item has identifier "${identifier}"`, {
      hint: 'identifiers look like SCR-5 and are project-prefixed',
    });
  }
  if (matches.length > 1) {
    throw new UsageError(
      `identifier "${identifier}" matched ${matches.length} work items: ${matches
        .map((item) => item.id)
        .join(', ')}`,
      { hint: 'pass the id instead' },
    );
  }
  return matches[0] as WorkItem;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const title = requireFlag(flags.title, '--title');
  const startAt = parseTimestampFlag(flags.startAt, '--start-at');
  const endAt = parseTimestampFlag(flags.endAt, '--end-at');

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<CreateWorkItemInput>> => {
    const project = await resolveProject(attemptCtx, flags.project);
    const type = await resolveWorkItemType(attemptCtx, project.id, flags.type);
    const state = await resolveStateFlags(attemptCtx, flags, {
      projectId: project.id,
      typeId: type.id,
    });
    const priority =
      flags.priority === undefined
        ? undefined
        : await resolveWorkItemPriority(attemptCtx, project.id, flags.priority);
    const assignee =
      flags.assignee === undefined ? undefined : await resolveUser(attemptCtx, flags.assignee);
    const sprint =
      flags.sprint === undefined
        ? undefined
        : await resolveSprint(attemptCtx, project.id, flags.sprint);
    const parent =
      flags.parent === undefined ? undefined : await resolveWorkItem(attemptCtx, flags.parent);
    // Board/entry/swimlane: project-scoped, resolved by name against the
    // project's boards. Entry and swimlane use the boardChildren loader so
    // they work without an explicit --board.
    const board =
      flags.board === undefined ? undefined : await resolveBoard(attemptCtx, project.id, flags.board);
    const entry =
      flags.entry === undefined ? undefined : await resolveEntry(attemptCtx, project.id, flags.entry);
    const swimlane =
      flags.swimlane === undefined
        ? undefined
        : await resolveSwimlane(attemptCtx, project.id, flags.swimlane);

    const input: CreateWorkItemInput = {
      project_id: project.id,
      type_id: type.id,
      title,
      ...(flags.description === undefined ? {} : { description: flags.description }),
      ...(state === undefined ? {} : { state_id: state.id }),
      ...(priority === undefined ? {} : { priority_id: priority.id }),
      ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
      ...(sprint === undefined ? {} : { sprint_id: sprint.id }),
      ...(parent === undefined ? {} : { parent_id: parent.id }),
      ...(board === undefined ? {} : { board_id: board.id }),
      ...(entry === undefined ? {} : { entry_id: entry.id }),
      ...(swimlane === undefined ? {} : { swimlane_id: swimlane.id }),
      ...(startAt === undefined ? {} : { start_at: startAt }),
      ...(endAt === undefined ? {} : { end_at: endAt }),
    };

    return {
      resolutions: present([project, type, state, priority, assignee, sprint, board, entry, swimlane]),
      value: input,
    };
  };

  const item = await runWrite(ctx, resolve, (attemptCtx, input) =>
    createWorkItem(attemptCtx, input),
  );
  printWorkItem(item, ctx, 'created');
}

// ---------------------------------------------------------------------------
// update / transition (one code path — design §7.1)
// ---------------------------------------------------------------------------

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const startAt = parseTimestampFlag(flags.startAt, '--start-at');
  const endAt = parseTimestampFlag(flags.endAt, '--end-at');
  const storyPoints = parseNumberFlag(flags.storyPoints, '--story-points');
  const estimatedWorkload = parseNumberFlag(flags.estimatedWorkload, '--estimated-workload');
  const remainingWorkload = parseNumberFlag(flags.remainingWorkload, '--remaining-workload');

  const scalarPatch: UpdateWorkItemInput = {
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(startAt === undefined ? {} : { start_at: startAt }),
    ...(endAt === undefined ? {} : { end_at: endAt }),
    ...(storyPoints === undefined ? {} : { story_points: storyPoints }),
    ...(estimatedWorkload === undefined ? {} : { estimated_workload: estimatedWorkload }),
    ...(remainingWorkload === undefined ? {} : { remaining_workload: remainingWorkload }),
  };

  const wantsState =
    (flags.state !== undefined && flags.state.trim() !== '') ||
    (flags.stateId !== undefined && flags.stateId.trim() !== '');
  const wantsReference =
    wantsState ||
    flags.assignee !== undefined ||
    flags.priority !== undefined ||
    flags.parent !== undefined ||
    flags.sprint !== undefined ||
    flags.board !== undefined ||
    flags.entry !== undefined ||
    flags.swimlane !== undefined ||
    (flags.release !== undefined && flags.release.length > 0);

  // An empty PATCH is a usage error (exit 2), never a no-op round-trip (design §7.2).
  if (Object.keys(scalarPatch).length === 0 && !wantsReference) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint: 'pass at least one of --title / --description / --state / --state-id / --assignee / --priority / --parent / --sprint / --board / --entry / --swimlane / --release / --start-at / --end-at / --story-points / --estimated-workload / --remaining-workload',
    });
  }

  // PATCH documents only `id` (research §6.9), so resolve the reference first —
  // which also hands back the project a name lookup needs. It does **not** hand
  // back a type: the live API omits `type` from work-item payloads entirely
  // (research/s8-smoke.md F1), which is why `--type` exists on this command.
  const locator = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
  if (locator.id === '') {
    throw new NotFoundError(`could not resolve "${target}" to a work item id`);
  }

  // Remembered for explainStates(): the id the state lookup actually used.
  let typeIdUsed: string | undefined = locator.typeId;

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<UpdateWorkItemInput>> => {
    const projectId = locator.projectId;
    if (wantsReference && (projectId === undefined || projectId === '')) {
      throw new UsageError(
        `the work item ${locator.identifier ?? locator.id} did not report a project, so names cannot be resolved`,
        { hint: 'pass ids directly (--state-id <id>) instead of names' },
      );
    }

    // Resolve the type only when a state *name* needs it: with --state-id the
    // whole lookup is skipped, which keeps the request count where it was.
    const needsTypeForName = flags.state !== undefined && flags.state.trim() !== '';
    const type =
      needsTypeForName && flags.type !== undefined && projectId !== undefined
        ? await resolveWorkItemType(attemptCtx, projectId, flags.type)
        : undefined;
    const typeId = type?.id ?? locator.typeId;
    typeIdUsed = typeId;

    const state =
      projectId === undefined
        ? undefined
        : await resolveStateFlags(attemptCtx, flags, {
            projectId,
            ...(typeId === undefined ? {} : { typeId }),
          });
    const priority =
      flags.priority === undefined || projectId === undefined
        ? undefined
        : await resolveWorkItemPriority(attemptCtx, projectId, flags.priority);
    // An empty `--assignee` is the natural way a user tries to *clear* the assignee,
    // but the PingCode Open API cannot (research/clear-assignee-api.md): `null` is a
    // silent 200 no-op and `""` is a 400. Catch the clear-intent *before* resolveUser
    // (whose generic empty guard would only say "user must not be empty") and answer it
    // honestly — no request is sent, no false success.
    let assignee: ResolveResult | undefined;
    if (flags.assignee !== undefined) {
      if (flags.assignee.trim() === '') {
        throw new UsageError("the PingCode Open API cannot clear a work item's assignee", {
          hint: 'clearing the assignee is only supported in the PingCode web UI — `--assignee ""` is not accepted by the API',
        });
      }
      assignee = await resolveUser(attemptCtx, flags.assignee);
    }
    const parent =
      flags.parent === undefined ? undefined : await resolveWorkItem(attemptCtx, flags.parent);
    // Both are project-scoped, and the project came off the item — so unlike `create`
    // this command needs no --project (the guard above already refused a payload that
    // reports none). `sprint_id` is a scalar; `version_ids` is an array that replaces,
    // which is why `--release` is repeatable and every value is resolved in order. The
    // second and later releases cost no request: they hit the list the first one cached.
    const sprint =
      flags.sprint === undefined || projectId === undefined
        ? undefined
        : await resolveSprint(attemptCtx, projectId, flags.sprint);
    const releases: ResolveResult[] = [];
    if (flags.release !== undefined && projectId !== undefined) {
      for (const input of flags.release) {
        releases.push(await resolveProjectVersion(attemptCtx, projectId, input));
      }
    }
    // Board/entry/swimlane: all project-scoped, resolved by name against the
    // project's boards. Entry and swimlane resolution uses the boardChildren
    // loader (lists all boards, then their children) so --entry/--swimlane
    // work without an explicit --board.
    const board =
      flags.board === undefined || projectId === undefined
        ? undefined
        : await resolveBoard(attemptCtx, projectId, flags.board);
    const entry =
      flags.entry === undefined || projectId === undefined
        ? undefined
        : await resolveEntry(attemptCtx, projectId, flags.entry);
    const swimlane =
      flags.swimlane === undefined || projectId === undefined
        ? undefined
        : await resolveSwimlane(attemptCtx, projectId, flags.swimlane);

    const patch: UpdateWorkItemInput = {
      ...scalarPatch,
      ...(state === undefined ? {} : { state_id: state.id }),
      ...(priority === undefined ? {} : { priority_id: priority.id }),
      ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
      ...(parent === undefined ? {} : { parent_id: parent.id }),
      ...(sprint === undefined ? {} : { sprint_id: sprint.id }),
      ...(board === undefined ? {} : { board_id: board.id }),
      ...(entry === undefined ? {} : { entry_id: entry.id }),
      ...(swimlane === undefined ? {} : { swimlane_id: swimlane.id }),
      ...(releases.length === 0 ? {} : { version_ids: releases.map((release) => release.id) }),
    };

    return {
      resolutions: present([type, state, priority, assignee, sprint, board, entry, swimlane, ...releases]),
      value: patch,
    };
  };

  try {
    const item = await runWrite(ctx, resolve, (attemptCtx, patch) =>
      updateWorkItem(attemptCtx, locator.id, patch),
    );
    printWorkItem(item, ctx, 'updated');
  } catch (error) {
    if (wantsState) {
      await explainStates(ctx, locator, error, { typeFlag: flags.type, typeId: typeIdUsed });
    }
    throw error;
  }
}

/**
 * A state change is only accepted if the target state belongs to the type's state
 * scheme **and** a legal transition exists (research §6.12). The server message
 * rarely says which states are legal, so we add them.
 *
 * The states endpoint needs `(project_id, work_item_type_id)` and the payload
 * carries no type, so this can only list candidates when the user passed
 * `--type`. When they did not, say so instead of printing nothing — silence was
 * exactly the S8 complaint (research/s8-smoke.md F1, step 11c).
 */
async function explainStates(
  ctx: Ctx,
  locator: WorkItemLocator,
  error: unknown,
  source: { typeFlag?: string | undefined; typeId?: string | undefined },
): Promise<void> {
  if (!(error instanceof PingcodeError)) return;
  if (!['api', 'usage', 'not_found', 'permission'].includes(error.kind)) return;

  const projectId = locator.projectId;
  if (projectId === undefined) return;

  if (source.typeFlag === undefined && source.typeId === undefined) {
    // A local UsageError already tells the user to pass --type, so saying it
    // twice is just noise; a *server* rejection is where the silence hurt.
    if (error.kind === 'usage') return;
    ctx.logger.warn(
      'the candidate states cannot be listed because this API does not report a work item\'s type; ' +
        're-run with --type <name|id> to see the states configured for it',
    );
    return;
  }

  try {
    const typeId =
      source.typeId ??
      (source.typeFlag === undefined
        ? undefined
        : (await resolveWorkItemType(ctx, projectId, source.typeFlag)).id);
    if (typeId === undefined) return;

    const states = await listWorkItemStates(ctx, projectId, typeId);
    if (states.length === 0) return;
    const listed = states.map((state) => `${state.name ?? '(unnamed)'} (${state.id})`).join(', ');
    ctx.logger.warn(
      `states configured for this (project, type): ${listed}. ` +
        `Current state: ${locator.stateName ?? '(unknown)'}. ` +
        'A state change also needs a legal workflow transition from the current state.',
    );
  } catch {
    // Best effort: never mask the original failure with a lookup failure.
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function printWorkItem(item: WorkItem, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    item,
    [
      ['identifier', item.identifier ?? item.short_id ?? ''],
      ['id', item.id],
      ['title', item.title ?? ''],
      ['type', typeLabelOf(item.type)],
      ['state', refName(item.state)],
      ['priority', refName(item.priority)],
      ['assignee', refName(item.assignee)],
      ['project', refName(item.project)],
      ['sprint', refName(item.sprint)],
      ['parent', refName(item.parent)],
      ['start', timestampCell(item.start_at)],
      ['end', timestampCell(item.end_at)],
      ['completed', timestampCell(item.completed_at)],
      ['created', timestampCell(item.created_at)],
      ['updated', timestampCell(item.updated_at)],
      ['url', item.html_url ?? item.url ?? ''],
      ['description', item.description ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${item.identifier ?? item.id}`));
  }
}

function present(resolutions: (ResolveResult | undefined)[]): ResolveResult[] {
  return resolutions.filter((resolution): resolution is ResolveResult => resolution !== undefined);
}

// ---------------------------------------------------------------------------
// bulk-update / delete
// ---------------------------------------------------------------------------

/**
 * `PATCH /v1/pjm/work_items` sets **one** property on many work items, so this maps a
 * flag set to exactly one `(property_name, property_value)` pair and refuses zero or
 * two.
 *
 * The five flags with a dedicated spelling are the five verified to actually apply
 * (live 2026-08-04). Everything else goes through `--property`/`--value`, which is not
 * validated — because a flag for a property the server ignores would be a dead knob
 * (design D11.2) while a *generic* escape hatch is honest about not knowing.
 */
async function runBulkUpdate(flags: BulkUpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const refs = flags.id ?? [];
  if (refs.length === 0) throw new UsageError('--id is required at least once');

  const chosen = chosenProperty(flags);

  const result = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<BulkUpdateWorkItemsInput>> => {
      const resolutions: ResolveResult[] = [];
      // One read per --id: the endpoint takes real ids only ('ids.0'格式不正确 for
      // anything else), and this is what lets an identifier or a pasted URL work.
      const ids: string[] = [];
      for (const ref of refs) {
        ids.push((await resolveWorkItem(attemptCtx, ref)).id);
      }

      const project =
        flags.project === undefined ? undefined : await resolveProject(attemptCtx, flags.project);
      if (project !== undefined) resolutions.push(project);

      const pair = await resolvePropertyValue(attemptCtx, flags, chosen, project?.id, resolutions);
      return {
        resolutions,
        value: { ids, property_name: pair.name, property_value: pair.value },
      };
    },
    async (attemptCtx, input) => await bulkUpdateWorkItems(attemptCtx, input),
  );

  printBulkUpdate(result, refs.length, chosen, ctx);
}

/** Exactly one property per call — the endpoint's own shape, not a CLI restriction. */
type BulkProperty =
  | 'assignee'
  | 'state'
  | 'priority'
  | 'title'
  | 'description'
  | 'property';

function chosenProperty(flags: BulkUpdateFlags): BulkProperty {
  const given: BulkProperty[] = [];
  if (flags.assignee !== undefined || flags.assigneeId !== undefined) given.push('assignee');
  if (flags.state !== undefined || flags.stateId !== undefined) given.push('state');
  if (flags.priority !== undefined || flags.priorityId !== undefined) given.push('priority');
  if (flags.title !== undefined) given.push('title');
  if (flags.description !== undefined) given.push('description');
  if (flags.property !== undefined) given.push('property');

  if (given.length === 0) {
    throw new UsageError('nothing to update: no property was given', {
      hint:
        'pass exactly one of --assignee / --assignee-id / --state / --state-id / --priority / ' +
        '--priority-id / --title / --description / --property. The endpoint takes one ' +
        'property_name per call',
    });
  }
  if (given.length > 1) {
    throw new UsageError(`only one property can be set per call, got ${given.length}`, {
      hint:
        'PATCH /v1/pjm/work_items carries a single property_name, so two properties need two ' +
        'invocations — the API cannot do them together',
    });
  }
  return given[0] as BulkProperty;
}

async function resolvePropertyValue(
  ctx: Ctx,
  flags: BulkUpdateFlags,
  chosen: BulkProperty,
  projectId: string | undefined,
  resolutions: ResolveResult[],
): Promise<{ name: string; value: unknown }> {
  switch (chosen) {
    case 'assignee': {
      if (flags.assigneeId !== undefined) return { name: 'assignee_id', value: flags.assigneeId };
      const user = await resolveUser(ctx, requireFlag(flags.assignee, '--assignee'));
      resolutions.push(user);
      return { name: 'assignee_id', value: user.id };
    }
    case 'state': {
      if (flags.stateId !== undefined) return { name: 'state_id', value: flags.stateId };
      // A batch may span projects, so a state NAME needs an explicit scope: there is no
      // single work item to read the project and type off.
      if (projectId === undefined) {
        throw new UsageError('--state <name> requires --project', {
          hint:
            'state ids are scoped to (project, work-item type) and one batch may span projects, ' +
            'so a name cannot be resolved without --project (and --type). Use --state-id <id> to ' +
            'send an id unchanged',
        });
      }
      const type =
        flags.type === undefined
          ? undefined
          : await resolveWorkItemType(ctx, projectId, flags.type);
      if (type !== undefined) resolutions.push(type);
      const state = await resolveStateFlags(ctx, flags, {
        projectId,
        ...(type === undefined ? {} : { typeId: type.id }),
      });
      if (state === undefined) throw new UsageError('--state could not be resolved');
      resolutions.push(state);
      return { name: 'state_id', value: state.id };
    }
    case 'priority': {
      if (flags.priorityId !== undefined) return { name: 'priority_id', value: flags.priorityId };
      if (projectId === undefined) {
        throw new UsageError('--priority <name> requires --project', {
          hint: 'priority ids are project-scoped; use --priority-id <id> to send an id unchanged',
        });
      }
      const priority = await resolveWorkItemPriority(
        ctx,
        projectId,
        requireFlag(flags.priority, '--priority'),
      );
      resolutions.push(priority);
      return { name: 'priority_id', value: priority.id };
    }
    case 'title':
      return { name: 'title', value: requireFlag(flags.title, '--title') };
    case 'description':
      // Not `requireFlag`: an empty description is a legitimate value here, and the
      // endpoint distinguishes "empty string" from "no property_value at all" (the
      // latter clears the field, which is why `--value` is mandatory below).
      return { name: 'description', value: flags.description ?? '' };
    case 'property': {
      const name = requireFlag(flags.property, '--property');
      if (flags.value === undefined) {
        throw new UsageError(`--property ${name} requires --value`, {
          hint:
            'the API treats a missing property_value as "clear this field" (verified live), so ' +
            'the CLI will not send one by accident. Pass --value \'\' for an empty string',
        });
      }
      return { name, value: parseJsonish(flags.value) };
    }
  }
}

/** `--value` is JSON when it parses, and the raw string otherwise. */
function parseJsonish(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function printBulkUpdate(
  result: WorkItemBulkUpdateResult,
  requested: number,
  chosen: BulkProperty,
  ctx: Ctx,
): void {
  const mode = modeOf(ctx);
  const updated = result.updates ?? 0;
  printResource(
    result,
    [
      ['requested', String(requested)],
      ['updated', String(updated)],
    ],
    mode,
  );

  // The count is the ONLY signal the endpoint gives: an unapplied property, an ignored
  // value and a nonexistent id all answer 200. Saying nothing here would report a
  // no-op as a success — which is exactly how `sprint_id` looks.
  if (updated < requested) {
    ctx.logger.warn(
      `${updated} of ${requested} work item(s) were updated. The API answers 200 whether or not ` +
        `it applied the change, so the shortfall means one of: an id that does not exist, a value ` +
        `it rejected silently, or a property it does not support in bulk` +
        (chosen === 'property'
          ? ' (--property is not validated: sprint_id, type_id, tag_ids, version_ids, ' +
            'participant_ids, properties and bug_type_id are all accepted and ignored)'
          : '') +
        '. Read the items back to confirm.',
    );
  } else if (!mode.json) {
    errLine(paint.green(`updated ${updated} work item(s)`));
  }
}

async function runDelete(target: string, flags: YesFlag, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  // The locator read is what makes the confirmation name the item rather than an id
  // (design D8.1) — and it also lets an identifier or a pasted URL be deleted.
  const item = await resolveWorkItem(ctx, requireFlag(target, '<work-item>'));
  if (item.id === '') {
    throw new NotFoundError(`could not resolve "${target}" to a work item id`);
  }

  if (flags.yes !== true) {
    throw new UsageError(`refusing to delete work item ${describeItem(item)} without --yes`, {
      hint:
        'it disappears from every list, sprint, board and link immediately. The web UI recycle ' +
        'bin can restore it, but this API cannot. Re-run with --yes, or with --yes --dry-run to ' +
        'see the request first',
    });
  }

  printWorkItem(await deleteWorkItem(ctx, item.id), ctx, 'deleted');
}

// ---------------------------------------------------------------------------
// shared bits for the three subgroups
// ---------------------------------------------------------------------------

const WORK_ITEM_REF_HELP = 'id, short_id, identifier such as SCR-5, or a pasted URL';

/** Prefix that marks a flag as reachable only through `POST …/search`. */
const SEARCH_FLAG_MARK = '(search) ';

type YesFlag = { yes?: boolean | undefined };
type RelationFlags = { relation?: string | undefined; relationId?: string | undefined };
type AddLinkFlags = RelationFlags & { target: string };
type TagFlags = { tag?: string | undefined; tagId?: string | undefined };

type BulkUpdateFlags = StateFlags & {
  id?: string[] | undefined;
  project?: string | undefined;
  type?: string | undefined;
  assignee?: string | undefined;
  assigneeId?: string | undefined;
  priority?: string | undefined;
  priorityId?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  property?: string | undefined;
  value?: string | undefined;
};

/**
 * `--relation <name|category|id>` vs `--relation-id <id>`, the usual pair.
 *
 * The resolved **id** is what gets sent even though the API also accepts the `category`
 * slug: both work (verified live, and the response echoes the slug either way), and
 * sending the id keeps one code path for the id flag and the name flag.
 */
async function resolveRelationFlags(
  ctx: Ctx,
  flags: RelationFlags,
): Promise<ResolveResult | undefined> {
  const name = flags.relation?.trim();
  const id = flags.relationId?.trim();
  if (name !== undefined && name !== '' && id !== undefined && id !== '') {
    throw new UsageError('--relation and --relation-id are mutually exclusive');
  }
  if (id !== undefined && id !== '') {
    return { kind: 'pjm-relation-type', input: id, id, name: undefined, fromCache: false, cacheKey: null };
  }
  if (name === undefined || name === '') return undefined;
  return await resolveRelationType(ctx, name);
}

/**
 * `--tag <name>` resolved **here**, live and uncached, rather than through
 * `core/metadata`'s registry.
 *
 * The registry's contract is "a name in this parent scope → an id valid in that scope",
 * and the tag vocabulary cannot honour it: `GET /v1/pjm/work_item/tags?project_id=`
 * ignores the project it demands and returns the whole organisation's tags, while the
 * write accepts only the ones belonging to this work item's project. A cached resolver
 * row would therefore promote a wrong answer to a remembered fact — the argument is
 * spelled out in `core/metadata/registry.ts`. Resolving inline keeps the lookup honest:
 * one live read, no cache entry, and an ambiguity error when a name repeats (which the
 * commonest tag names do).
 */
async function tagIdOf(ctx: Ctx, item: WorkItemLocator, flags: TagFlags): Promise<string> {
  const name = flags.tag?.trim();
  const id = flags.tagId?.trim();
  if (name !== undefined && name !== '' && id !== undefined && id !== '') {
    throw new UsageError('--tag and --tag-id are mutually exclusive');
  }
  if (id !== undefined && id !== '') return id;
  if (name === undefined || name === '') {
    throw new UsageError('tag add requires --tag <name> or --tag-id <id>');
  }

  const projectId = item.projectId;
  if (projectId === undefined || projectId === '') {
    throw new UsageError(
      `the work item ${item.identifier ?? item.id} did not report a project, so a tag name cannot be resolved`,
      { hint: 'pass --tag-id <id> instead' },
    );
  }

  const tags = await listWorkItemTagVocabulary(ctx, projectId);
  const wanted = name.toLowerCase();
  const matches = tags.filter((tag) => (tag.name ?? '').toLowerCase() === wanted);
  if (matches.length === 1) return (matches[0] as { id: string }).id;

  if (matches.length === 0) {
    const known = tags
      .map((tag) => tag.name ?? tag.id)
      .filter((label, index, all) => all.indexOf(label) === index)
      .join(', ');
    throw new UsageError(`no tag matches "${name}"`, {
      hint:
        (known === '' ? 'no tags are configured at all. ' : `known tags: ${known}. `) +
        'Note this list is organisation-wide, not this project\'s — see ' +
        '`pingcode project meta tags --help`',
    });
  }

  throw new UsageError(
    `"${name}" matches ${matches.length} tags: ${matches.map((tag) => tag.id).join(', ')}`,
    {
      hint:
        'tag names are not unique in this API — several projects each define their own tag with ' +
        'the same name. Pass --tag-id <id>; only the one belonging to this work item\'s project ' +
        'will be accepted',
    },
  );
}

/**
 * The one rejection whose message points at the wrong thing.
 *
 * `100354` says `'tag'资源不存在` for a tag that exists perfectly well and merely belongs
 * to another project — which is why it is **not** in `ERROR_CODE_OVERRIDES` (mapping it
 * to `not_found` would send an agent hunting for a row `project meta tags` had just
 * printed, S2a's `100300` mistake). The explanation goes here instead.
 */
function explainForeignTag(error: unknown): void {
  if (!(error instanceof ApiError) || error.code !== FOREIGN_TAG_CODE) return;
  errLine(
    paint.dim(
      "the API reports this as a tag that does not exist, but the tag is real — it belongs to a " +
        'different project. `project meta tags` lists every tag in the organisation regardless of ' +
        'the --project you give it (verified live), while this write accepts only tags of this ' +
        "work item's own project. There is no endpoint that lists just those, so pick another id " +
        'or create the tag in this project through the web UI.',
    ),
  );
}

/** `'tag'资源不存在` — deliberately kept out of `ERROR_CODE_OVERRIDES`. */
const FOREIGN_TAG_CODE = '100354';

/** `YYHC-219 "the title"`, falling back to the id — what a `--yes` gate echoes. */
function describeItem(item: WorkItemLocator): string {
  const title = item.title?.replace(/\s+/g, ' ').trim() ?? '';
  const label = item.identifier ?? item.shortId ?? item.id;
  return title === '' ? label : `${label} "${title}"`;
}

function describeTag(attachment: WorkItemTagAttachment): string {
  const name = attachment.tag?.name;
  return name === undefined ? attachment.id : `"${name}" (${attachment.id})`;
}

/** One field of a link's richer end, which carries more than a `Ref` declares. */
function endRef(end: Ref | undefined, field: string): string {
  const value = end?.[field];
  if (typeof value === 'string' && value !== '') return value;
  return end?.id ?? '';
}

function printLink(link: WorkItemLink, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    link,
    [
      ['link id', link.id],
      ['type', link.relation_type ?? ''],
      ['from', `${endRef(link.origin_work_item, 'identifier')} ${endRef(link.origin_work_item, 'title')}`.trim()],
      ['to', `${endRef(link.target_work_item, 'identifier')} ${endRef(link.target_work_item, 'title')}`.trim()],
      ['to url', endRef(link.target_work_item, 'html_url')],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${endRef(link.target_work_item, 'identifier')}`));
  }
}

function printTag(attachment: WorkItemTagAttachment, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    attachment,
    [
      ['tag id', attachment.id],
      ['name', attachment.tag?.name ?? ''],
      ['work item', endRef(attachment.work_item, 'identifier')],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${attachment.tag?.name ?? attachment.id}`));
  }
}
