import type { Command } from 'commander';
import { listWorkItemStates } from '../../api/meta';
import {
  createWorkItem,
  findWorkItemByIdentifier,
  getWorkItem,
  iterateWorkItems,
  listWorkItems,
  updateWorkItem,
  type CreateWorkItemInput,
  type UpdateWorkItemInput,
  type WorkItemListQuery,
} from '../../api/workItems';
import type { Ctx } from '../../core/context';
import { NotFoundError, PingcodeError, UsageError } from '../../core/errors';
import {
  parseWorkItemRef,
  resolveProject,
  resolveSprint,
  resolveUser,
  resolveWorkItem,
  resolveWorkItemPriority,
  resolveWorkItemType,
  type ResolveResult,
  type WorkItemLocator,
} from '../../core/metadata';
import { collect } from '../../core/paginate';
import type { Ref, WorkItem } from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import { addCrosscutting } from './_shared/crosscutting';
import {
  addPagingOptions,
  addStateOptions,
  contextFor,
  modeOf,
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
 * `pingcode project work-item list|get|create|update|transition`.
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
    keywords?: string | undefined;
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
          .description('list work items of a project')
          .requiredOption('--project <name|id>', 'project name or id')
          .option('--type <name|id>', 'work-item type')
          .option('--assignee <name|id>', 'assignee: display name, username, email or id')
          .option('--sprint <name|id>', 'sprint (scrum/hybrid projects only)')
          .option('--keywords <text>', 'fuzzy search over title and description'),
      ),
      'filter by state',
      'requires --type',
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
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
        .option('--end-at <when>', 'unix seconds or a date like 2026-01-31'),
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
        .option('--assignee <name|id>', 'new assignee')
        .option('--priority <name|id>', 'new priority')
        .option('--parent <ref>', 'new parent work item')
        .option('--start-at <when>', 'unix seconds or a date like 2026-01-31')
        .option('--end-at <when>', 'unix seconds or a date like 2026-01-31')
        .option('--story-points <n>', 'story points')
        .option('--estimated-workload <n>', 'estimated workload in hours')
        .option('--remaining-workload <n>', 'remaining workload in hours'),
      'new state',
    ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
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

  // The four cross-object families, injected rather than written here (design D5.2).
  // All four accept `principal_type=work_item`, live-verified 2026-08-03. `relation`
  // is the cross-*kind* linker: work-item↔work-item links are the separate typed
  // family `/v1/pjm/work_items/{id}/relations`, which is not this.
  addCrosscutting(group, 'work_item', {
    resolveId: async (ctx, ref) => (await resolveWorkItem(ctx, ref)).id,
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

  const query: WorkItemListQuery = {
    project_id: project.id,
    ...(type === undefined ? {} : { type_id: type.id }),
    ...(state === undefined ? {} : { state_id: state.id }),
    ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
    ...(sprint === undefined ? {} : { sprint_id: sprint.id }),
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
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
      ...(startAt === undefined ? {} : { start_at: startAt }),
      ...(endAt === undefined ? {} : { end_at: endAt }),
    };

    return {
      resolutions: present([project, type, state, priority, assignee, sprint]),
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
    flags.parent !== undefined;

  // An empty PATCH is a usage error (exit 2), never a no-op round-trip (design §7.2).
  if (Object.keys(scalarPatch).length === 0 && !wantsReference) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint: 'pass at least one of --title / --description / --state / --state-id / --assignee / --priority / --parent / --start-at / --end-at / --story-points / --estimated-workload / --remaining-workload',
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
    const assignee =
      flags.assignee === undefined ? undefined : await resolveUser(attemptCtx, flags.assignee);
    const parent =
      flags.parent === undefined ? undefined : await resolveWorkItem(attemptCtx, flags.parent);

    const patch: UpdateWorkItemInput = {
      ...scalarPatch,
      ...(state === undefined ? {} : { state_id: state.id }),
      ...(priority === undefined ? {} : { priority_id: priority.id }),
      ...(assignee === undefined ? {} : { assignee_id: assignee.id }),
      ...(parent === undefined ? {} : { parent_id: parent.id }),
    };

    return { resolutions: present([type, state, priority, assignee]), value: patch };
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
