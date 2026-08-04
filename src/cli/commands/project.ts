import type { Command } from 'commander';
import {
  listSprints,
  listWorkItemPriorities,
  listWorkItemStates,
  listWorkItemTypes,
  type SprintListQuery,
} from '../../api/meta';
import { getProject, iterateProjects, listProjects, type ProjectListQuery } from '../../api/projects';
import { collect } from '../../core/paginate';
import { resolveProject, resolveWorkItemType } from '../../core/metadata';
import type {
  Project,
  Sprint,
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
  printPage,
  printResource,
  readPaging,
  requireFlag,
  timestampCell,
  type PagingFlags,
} from './common';
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

  // Registration order is the `--help` order and is asserted by
  // `test/help/project.test.ts`: the group's own verbs first, then the resource
  // subgroups, then the lookups. S2a inserted `sprint` and `version` between
  // `work-item` and `meta` — planning objects that work items are filed into, so they
  // read after the work item and before the id lookups.
  registerWorkItemCommands(project);
  registerSprintCommands(project);
  registerVersionCommands(project);
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
