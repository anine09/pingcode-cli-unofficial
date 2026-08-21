import type { Command } from 'commander';
import {
  listSprints,
  listWorkItemPriorities,
  listWorkItemStates,
  listWorkItemTypes,
  type SprintListQuery,
} from '../../api/meta';
import {
  createProject,
  getProject,
  getProjectProgress,
  iterateProjects,
  listProjects,
  updateProject,
  type CreateProjectInput,
  type ProjectListQuery,
  type UpdateProjectInput,
} from '../../api/projects';
import {
  listWorkItemRelationTypes,
  listWorkItemTagVocabulary,
} from '../../api/workItems';
import type { Ctx } from '../../core/context';
import { UsageError } from '../../core/errors';
import { collect } from '../../core/paginate';
import {
  resolveProject,
  resolveUser,
  resolveWorkItemType,
  type ResolveResult,
} from '../../core/metadata';
import type {
  Project,
  Sprint,
  WorkItemPriority,
  WorkItemRelationType,
  WorkItemState,
  WorkItemTag,
  WorkItemType,
} from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import {
  addPagingOptions,
  collectValue,
  contextFor,
  modeOf,
  parseTimestampFlag,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refName,
  requireFlag,
  runWrite,
  timestampCell,
  type PagingFlags,
  type ResolvedWrite,
} from './common';
import { registerBoardCommands } from './projectBoard';
import { registerMemberCommands } from './projectMember';
import { registerSprintCommands } from './projectSprint';
import { registerVersionCommands } from './projectVersion';
import { registerWorkItemCommands } from './workItem';

/**
 * `pingcode project …` — the 项目管理 (pjm) module: the project itself, its work
 * items, and the project-scoped id lookups every work-item write needs.
 *
 * `project list|get` is `GET /v1/pjm/projects[/{id}]` (research §4 rows 2–3).
 */

type ListFlags = PagingFlags & {
  keywords?: string | undefined;
  type?: string | undefined;
  includeArchived?: boolean | undefined;
};

type GetFlags = {
  includeArchived?: boolean | undefined;
};

type ProjectFlag = { project: string };
type StatesFlags = ProjectFlag & { type: string };
type SprintsFlags = ProjectFlag & { status?: string | undefined };
type TagsFlags = ProjectFlag & { name?: string | undefined };

type CreateFlags = {
  name: string;
  identifier: string;
  type: string;
  description?: string | undefined;
  visibility?: string | undefined;
  assignee?: string | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
  member?: string[] | undefined;
  processId?: string | undefined;
};

type UpdateFlags = {
  name?: string | undefined;
  identifier?: string | undefined;
  description?: string | undefined;
  assignee?: string | undefined;
  stateId?: string | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
};

/** The four 项目流程 kinds. Enum-validated server-side, but the message names none of them. */
const PROJECT_TYPES = ['scrum', 'kanban', 'waterfall', 'hybrid'];

/**
 * A project's window is stored **verbatim** — unlike a sprint's or a release's, which
 * the server snaps to 00:00:00 / 23:59:59 of the date (design D15.4). So these are
 * instants and take `parseTimestampFlag`, matching `work-item create/update` rather than
 * `sprint create` two commands away. The inconsistency is upstream's.
 */
const TIMESTAMP_HELP = 'unix seconds or a date like 2026-01-31';

export const PROJECT_COLUMNS: Column<Project>[] = [
  { header: 'IDENTIFIER', value: (p) => p.identifier ?? '' },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
  { header: 'TYPE', value: (p) => p.type ?? '' },
  { header: 'ID', value: (p) => p.id },
];

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

const RELATION_TYPE_COLUMNS: Column<WorkItemRelationType>[] = [
  // CATEGORY first, deliberately: it is the stable, scriptable key, while ID differs per
  // tenant and NAME is localized.
  { header: 'CATEGORY', value: (type) => type.category ?? '' },
  { header: 'NAME', value: (type) => type.name ?? '', flex: true },
  { header: 'ID', value: (type) => type.id },
  { header: 'SYSTEM', value: (type) => (type.is_system ? 'yes' : 'no') },
];

const TAG_COLUMNS: Column<WorkItemTag>[] = [
  { header: 'ID', value: (tag) => tag.id },
  { header: 'NAME', value: (tag) => tag.name ?? '', flex: true },
  { header: 'COLOR', value: (tag) => tag.color ?? '' },
];

const SPRINT_COLUMNS: Column<Sprint>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
  { header: 'STATUS', value: (s) => s.status ?? '' },
  { header: 'START', value: (s) => timestampCell(s.start_at) },
  { header: 'END', value: (s) => timestampCell(s.end_at) },
];

export function registerProjectCommands(program: Command): void {
  const project = program
    .command('project')
    .description('项目管理 pjm: projects and work items (scope pcp:read:pjm:project)');

  addGlobalOptions(
    addPagingOptions(
      project
        .command('list')
        .description('list projects')
        .option('--keywords <text>', 'fuzzy search over project names')
        .option('--type <type>', 'scrum | kanban | waterfall | hybrid')
        .option('--include-archived', 'include archived projects'),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    project
      .command('get')
      .description('show one project')
      .argument('<project>', 'project name or id')
      .option('--include-archived', 'allow an archived project to be returned'),
    { hidden: true },
  ).action(async (target: string, flags: GetFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    project
      .command('create')
      .description('create a project — PERMANENT: there is no delete and no archive')
      .requiredOption('--name <text>', 'project name')
      .requiredOption(
        '--identifier <KEY>',
        'short uppercase key, unique in the organisation — it prefixes every work-item id',
      )
      .requiredOption('--type <type>', `one of ${PROJECT_TYPES.join(' | ')}`)
      .option('--description <text>', 'description')
      .option('--visibility <visibility>', 'private (default) | public — CANNOT be changed later')
      .option('--assignee <name|id>', '负责人; need not be a member, and is not added as one')
      .option('--start-at <when>', `${TIMESTAMP_HELP} — stored verbatim, not snapped to a day`)
      .option('--end-at <when>', `${TIMESTAMP_HELP} — stored verbatim, not snapped to a day`)
      .option('--member <name|id>', 'initial member, repeatable: user name or id', collectValue)
      .option(
        '--process-id <id>',
        'project process template; omitted, --type picks the matching system one (`pingcode api GET /v1/pjm/processes`)',
      ),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\nThis is IRREVERSIBLE. The API has no DELETE for a project, and `is_archived` is\n' +
        'read-only (a patch containing it is accepted and silently dropped), so a project\n' +
        'created by mistake stays in every listing forever. There is no --dry-run substitute\n' +
        'for reading this paragraph, but `--dry-run` does show the exact body first.\n' +
        '--identifier must be uppercase with no spaces and reasonably short; anything else is\n' +
        'rejected as a bad format rather than truncated. It is the only required field that\n' +
        'can still be changed afterwards, with `project update --identifier`.\n' +
        '--visibility can only be set here: patching it later does nothing.\n' +
        'Unlike a sprint or a release, --start-at / --end-at are stored EXACTLY as given —\n' +
        'the server does not round them to the start and end of the day.\n',
    )
    .action(async (flags: CreateFlags, command: Command) => {
      await runCreate(flags, command);
    });

  addGlobalOptions(
    project
      .command('update')
      .description('patch a project — only the fields you pass are sent')
      .argument('<project>', 'project name or id')
      .option('--name <text>', 'new name')
      .option('--identifier <KEY>', 'new short key — this renames every work-item id in the project')
      .option('--description <text>', 'new description')
      .option('--assignee <name|id>', 'new 负责人')
      .option(
        '--state-id <id>',
        'project state id from `pingcode api GET /v1/pjm/project/states?project_id=<id>`',
      )
      .option('--start-at <when>', TIMESTAMP_HELP)
      .option('--end-at <when>', TIMESTAMP_HELP),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\n--state-id takes an id and has NO `--state <name>` twin, because there is no\n' +
        'project-state resolver kind: the lookup lives at `/v1/pjm/project/states`, outside\n' +
        'this command group, and `pingcode resolve list` has no entry for it. The generic\n' +
        'layer above prints the ids. This is the one place in the CLI where an `--x-id` flag\n' +
        'is deliberately unpaired.\n' +
        'Not patchable, and silently ignored by the API if you send them another way:\n' +
        'visibility, type, process_id, is_archived. A project cannot be archived or deleted\n' +
        'through this API at all.\n',
    )
    .action(async (target: string, flags: UpdateFlags, command: Command) => {
      await runUpdate(target, flags, command);
    });

  addGlobalOptions(
    project
      .command('progress')
      .description('work-item counts for a project (open / in progress / done)')
      .argument('<project>', 'project name or id'),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\nWork items only: there is no sprint, release or workload figure in this endpoint, and\n' +
        'no paging (it returns a single count block, not a list, despite what the API docs\n' +
        'imply). The three counts group every state by its `type`, so a custom state counts\n' +
        'towards whichever of pending / in_progress / completed it is configured as.\n',
    )
    .action(async (target: string, _flags: unknown, command: Command) => {
      await runProgress(target, command);
    });

  // Registration order is the `--help` order and is asserted by
  // `test/help/project.test.ts`: the group's own verbs first, then the resource
  // subgroups, then the lookups. S2a inserted `sprint` and `version` between
  // `work-item` and `meta` — planning objects that work items are filed into, so they
  // read after the work item and before the id lookups. S2b added `member` after them,
  // for the same reason in reverse: it is the least often reached of the four.
  registerWorkItemCommands(project);
  registerSprintCommands(project);
  registerVersionCommands(project);
  registerBoardCommands(project);
  registerMemberCommands(project);
  registerProjectMetaCommands(project);
}

// ---------------------------------------------------------------------------
// project meta: the pjm lookups a work-item write cannot be built without
// ---------------------------------------------------------------------------

/**
 * `pingcode project meta …` — in pjm, `type_id`, `state_id` and `priority_id`
 * are **project-scoped** (research §6.13), so there is no org-wide list to read
 * them from: every lookup here takes `--project`.
 */
function registerProjectMetaCommands(parent: Command): void {
  const meta = parent
    .command('meta')
    .description('ids you need before writing: every pjm lookup is scoped to one project');

  addGlobalOptions(
    meta
      .command('types')
      .description('work-item types of a project (values for --type / type_id)')
      .requiredOption('--project <name|id>', 'project name or id'),
    { hidden: true },
  ).action(async (flags: ProjectFlag, command: Command) => {
    const { ctx } = contextFor(command);
    const resolved = await resolveProject(ctx, flags.project);
    const values = await listWorkItemTypes(ctx, resolved.id);
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
    const resolved = await resolveProject(ctx, flags.project);
    const type = await resolveWorkItemType(ctx, resolved.id, flags.type);
    const values = await listWorkItemStates(ctx, resolved.id, type.id);
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
    const resolved = await resolveProject(ctx, flags.project);
    const values = await listWorkItemPriorities(ctx, resolved.id);
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
    const resolved = await resolveProject(ctx, flags.project);
    const query: SprintListQuery = {
      ...(flags.status === undefined ? {} : { status: flags.status as SprintListQuery['status'] }),
    };
    const values = await listSprints(ctx, resolved.id, query);
    printCollection(values, SPRINT_COLUMNS, modeOf(ctx));
  });
  addGlobalOptions(
    meta
      .command('relation-types')
      .description('link types for `work-item link add` (organisation-wide, 9 system rows)'),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\nThese belong to the TYPED work item ↔ work item family\n' +
        '(`project work-item link`). The cross-kind family (`project work-item relation`,\n' +
        '/v1/relations) has no types at all and does not use this list.\n' +
        'CATEGORY is the stable key and is what to script against: the ids are 24-hex and\n' +
        'differ per tenant, while relate / block / blocked_by / cause / caused_by / clone /\n' +
        'cloned_by / duplicate / mention do not. `link add --relation` accepts the category,\n' +
        'the localized name or the id.\n' +
        'The four inverse pairs are maintained by the server: adding one adds the other.\n',
    )
    .action(async (_flags: unknown, command: Command) => {
      const { ctx } = contextFor(command);
      printCollection(await listWorkItemRelationTypes(ctx), RELATION_TYPE_COLUMNS, modeOf(ctx));
    });

  addGlobalOptions(
    meta
      .command('tags')
      .description('work-item tags — the only tag enumerator, and it is ORGANISATION-wide')
      .requiredOption('--project <name|id>', 'project name or id (required by the API, but see below)')
      .option('--name <text>', 'name SUBSTRING, case-insensitive — a search, not an exact match'),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\nRead this before using an id from here.\n' +
        '--project is REQUIRED by the endpoint and then IGNORED by it: three different\n' +
        'projects returned byte-identical lists (verified live 2026-08-04). So what you get\n' +
        'is every tag in the organisation, not this project\'s.\n' +
        'Tags are nevertheless project-scoped where it counts: `work-item tag add` refuses a\n' +
        "tag belonging to another project with \"'tag'资源不存在\", which reads as though the\n" +
        'tag did not exist. It does — it is simply not this project\'s. There is no endpoint\n' +
        'that lists only a given project\'s tags, so the reliable way to find a usable id is\n' +
        "to read the tags[] of a work item in that project (`work-item get`).\n" +
        'Names are not unique either: several projects each define their own 后端 / 前端.\n' +
        'This is also why `pingcode resolve` has no work-item-tag kind — a cached resolver\n' +
        'would hand back ids the write refuses.\n',
    )
    .action(async (flags: TagsFlags, command: Command) => {
      const { ctx } = contextFor(command);
      const resolved = await resolveProject(ctx, flags.project);
      const values = await listWorkItemTagVocabulary(
        ctx,
        resolved.id,
        flags.name === undefined ? {} : { name: flags.name },
      );
      printCollection(values, TAG_COLUMNS, modeOf(ctx));
    });
}

// ---------------------------------------------------------------------------
// create / update / progress
// ---------------------------------------------------------------------------

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const type = readProjectType(requireFlag(flags.type, '--type'));
  const startAt = parseTimestampFlag(flags.startAt, '--start-at');
  const endAt = parseTimestampFlag(flags.endAt, '--end-at');

  const project = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<CreateProjectInput>> => {
      const resolutions: ResolveResult[] = [];
      const members: { id: string; type: string }[] = [];
      for (const ref of flags.member ?? []) {
        const user = await resolveUser(attemptCtx, ref);
        resolutions.push(user);
        members.push({ id: user.id, type: 'user' });
      }
      let assigneeId: string | undefined;
      if (flags.assignee !== undefined) {
        const assignee = await resolveUser(attemptCtx, flags.assignee);
        resolutions.push(assignee);
        assigneeId = assignee.id;
      }

      return {
        resolutions,
        value: {
          type,
          name: requireFlag(flags.name, '--name'),
          identifier: requireFlag(flags.identifier, '--identifier'),
          ...(flags.description === undefined ? {} : { description: flags.description }),
          ...(flags.visibility === undefined ? {} : { visibility: flags.visibility }),
          ...(flags.processId === undefined ? {} : { process_id: flags.processId }),
          ...(assigneeId === undefined ? {} : { assignee_id: assigneeId }),
          ...(startAt === undefined ? {} : { start_at: startAt }),
          ...(endAt === undefined ? {} : { end_at: endAt }),
          ...(members.length === 0 ? {} : { members }),
        },
      };
    },
    async (attemptCtx, input) => await createProject(attemptCtx, input),
  );

  printProject(project, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const startAt = parseTimestampFlag(flags.startAt, '--start-at');
  const endAt = parseTimestampFlag(flags.endAt, '--end-at');

  const patchBase: UpdateProjectInput = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.identifier === undefined ? {} : { identifier: flags.identifier }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(flags.stateId === undefined ? {} : { state_id: flags.stateId }),
    ...(startAt === undefined ? {} : { start_at: startAt }),
    ...(endAt === undefined ? {} : { end_at: endAt }),
  };

  // An empty body answers 200 and changes nothing upstream, which would report a no-op
  // as a success (design §7.2 / §8).
  if (Object.keys(patchBase).length === 0 && flags.assignee === undefined) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --name / --identifier / --description / --assignee / --state-id / ' +
        '--start-at / --end-at. visibility, type and is_archived are not patchable at all',
    });
  }

  const project = await runWrite(
    ctx,
    async (
      attemptCtx,
    ): Promise<ResolvedWrite<{ projectId: string; patch: UpdateProjectInput }>> => {
      const resolved = await resolveProject(attemptCtx, requireFlag(target, '<project>'));
      const resolutions: ResolveResult[] = [resolved];
      const patch: UpdateProjectInput = { ...patchBase };
      if (flags.assignee !== undefined) {
        const assignee = await resolveUser(attemptCtx, flags.assignee);
        resolutions.push(assignee);
        patch.assignee_id = assignee.id;
      }
      return { resolutions, value: { projectId: resolved.id, patch } };
    },
    async (attemptCtx, { projectId, patch }) => await updateProject(attemptCtx, projectId, patch),
  );

  printProject(project, ctx, 'updated');
}

async function runProgress(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const resolved = await resolveProject(ctx, requireFlag(target, '<project>'));
  const progress = await getProjectProgress(ctx, resolved.id);
  const counts = progress.work_item ?? {};
  printResource(
    progress,
    [
      ['project', resolved.name ?? resolved.id],
      ['work items', String(counts.total ?? 0)],
      ['open', String(counts.pending_count ?? 0)],
      ['in progress', String(counts.in_progress_count ?? 0)],
      ['completed', String(counts.completed_count ?? 0)],
    ],
    modeOf(ctx),
  );
}

/**
 * `--type` is checked here because the server's rejection (`'type'不是有效的枚举值`) does
 * not list the legal values, and this is a create that cannot be undone.
 */
function readProjectType(value: string): string {
  const type = value.trim();
  if (!PROJECT_TYPES.includes(type)) {
    throw new UsageError(`unknown project type "${value}"`, {
      hint: `expected one of ${PROJECT_TYPES.join(' | ')}`,
    });
  }
  return type;
}

function printProject(project: Project, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    project,
    [
      ['name', project.name ?? ''],
      ['identifier', project.identifier ?? ''],
      ['id', project.id],
      ['type', project.type ?? ''],
      ['visibility', project.visibility ?? ''],
      ['state', refName(project.state)],
      ['owner', refName(project.assignee)],
      ['start', timestampCell(project.start_at)],
      ['end', timestampCell(project.end_at)],
      ['archived', project.is_archived ? 'yes' : 'no'],
      ['url', project.html_url ?? project.url ?? ''],
      ['description', project.description ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${project.identifier ?? project.id}`));
  }
}

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const query: ProjectListQuery = {
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
    ...(flags.type === undefined ? {} : { type: flags.type }),
    ...(flags.includeArchived === true ? { include_archived: true } : {}),
  };

  if (paging.all) {
    const values = await collect(
      iterateProjects(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, PROJECT_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listProjects(ctx, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, PROJECT_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: GetFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const resolved = await resolveProject(ctx, requireFlag(target, '<project>'));
  const project = await getProject(
    ctx,
    resolved.id,
    flags.includeArchived === true ? { include_archived: true } : {},
  );

  printResource(
    project,
    [
      ['name', project.name ?? ''],
      ['identifier', project.identifier ?? ''],
      ['id', project.id],
      ['type', project.type ?? ''],
      ['archived', project.is_archived ? 'yes' : 'no'],
      ['created', timestampCell(project.created_at)],
      ['updated', timestampCell(project.updated_at)],
      ['url', project.html_url ?? project.url ?? ''],
      ['description', project.description ?? ''],
    ],
    modeOf(ctx),
  );
}
