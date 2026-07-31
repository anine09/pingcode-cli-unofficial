import type { Command } from 'commander';
import { getProject, iterateProjects, listProjects, type ProjectListQuery } from '../../api/projects';
import { collect } from '../../core/paginate';
import { resolveProject } from '../../core/metadata';
import type { Project } from '../../types/api';
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

/** `pingcode project list|get` — `GET /v1/pjm/projects[/{id}]` (research §4 rows 2–3). */

type ListFlags = PagingFlags & {
  keywords?: string | undefined;
  type?: string | undefined;
  includeArchived?: boolean | undefined;
};

type GetFlags = {
  includeArchived?: boolean | undefined;
};

export const PROJECT_COLUMNS: Column<Project>[] = [
  { header: 'IDENTIFIER', value: (p) => p.identifier ?? '' },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
  { header: 'TYPE', value: (p) => p.type ?? '' },
  { header: 'ID', value: (p) => p.id },
];

export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('projects (scope pcp:read:pjm:project)');

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
