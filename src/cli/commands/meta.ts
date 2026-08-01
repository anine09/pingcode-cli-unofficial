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
import { resolveProject, resolveWorkItemType } from '../../core/metadata';
import { collect } from '../../core/paginate';
import type {
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
  timestampCell,
  type PagingFlags,
} from './common';

/**
 * `pingcode meta types|states|priorities|sprints|users`.
 *
 * This group is load-bearing, not scope creep: `type_id`, `state_id` and
 * `priority_id` are **project-scoped** (research §6.13), so an agent cannot build
 * a valid `work-item create` without discovering them here first.
 */

type ProjectFlag = { project: string };
type StatesFlags = ProjectFlag & { type: string };
type SprintsFlags = ProjectFlag & { status?: string | undefined };
type UsersFlags = PagingFlags & { keywords?: string | undefined };

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

export function registerMetaCommands(program: Command): void {
  const meta = program
    .command('meta')
    .description('project-scoped ids you need before creating or updating work items');

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
}
