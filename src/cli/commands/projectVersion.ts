import type { Command } from 'commander';
import {
  bulkCreateVersions,
  createVersion,
  deleteVersion,
  getVersion,
  iterateVersions,
  listVersions,
  updateVersion,
  type BulkVersionEntry,
  type CreateVersionInput,
  type UpdateVersionInput,
  type VersionListQuery,
} from '../../api/projects';
import type { Ctx } from '../../core/context';
import { UsageError } from '../../core/errors';
import {
  resolveProject,
  resolveProjectVersion,
  resolveUser,
  type ResolveResult,
} from '../../core/metadata';
import { collect } from '../../core/paginate';
import type { BulkCreateResult, ProjectVersion } from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import { readBulkEntries, readSharedRefs, resolveBulkEntry } from './_shared/bulkEntries';
import {
  addPagingOptions,
  collectValue,
  contextFor,
  modeOf,
  parseDateBoundaryFlag,
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

/**
 * `pingcode project version …` — 发布 ([S§3.8.6]), a project's release plans.
 * Live-verified 2026-08-04 (design D15).
 *
 * **Read the name carefully: this is one of four things the API calls a version or a
 * plan** ([S§6], design D7.2). A 发布 is a dated release of one project. It is *not*
 * a wiki page revision (`/v1/wiki/pages/{id}/versions`), *not* a configuration scheme
 * (`work_item_state_plans`, `*_property_plans`), and *not* a testhub 测试计划 or a
 * ship 需求排期. Nothing here touches any of those.
 *
 * Group-wide facts, so no leaf repeats them:
 *
 *  - scopes `pcp:read:pjm:release` / `pcp:write:pjm:release` — note the scope is
 *    called *release* while the resource is called *version*.
 *  - **available in every project type**, unlike a sprint: a kanban project can carry
 *    releases.
 *  - the window is **day-granular**: the server stores `--start` at 00:00:00 and
 *    `--end` at 23:59:59 of the date given.
 *  - `progress` and `changelog` are **read-only**. There is no documented body field
 *    for either, and sending one is accepted and silently dropped — so a release's
 *    only long-text field cannot be written through the API at all.
 *
 * One live asymmetry worth knowing before scripting anything: **`GET` and `PATCH`
 * ignore the project in the path.** A version id is effectively an organisation-wide
 * key, so `--project` naming the wrong project still reads and still writes — the
 * change lands on the version in its real project. Only `delete` checks the pairing
 * (400 `1003107` `发布与项目不匹配`). The CLI cannot detect this locally, because it
 * has no independent source for "which project owns this version".
 */

const DATE_FLAG_HELP = 'a date (2026-08-31) or a 10-digit unix seconds value';
const PROJECT_HELP = 'project name or id';
const VERSION_HELP = 'release 发布 name or id';

/** The stage `type` values `?status=` filters on — the resource has no `status` field. */
const STAGE_TYPES = ['pending', 'in_progress', 'published'];

type ProjectFlag = { project: string };

type ListFlags = PagingFlags &
  ProjectFlag & {
    name?: string | undefined;
    status?: string | undefined;
  };

type CreateFlags = ProjectFlag & {
  name: string;
  start: string;
  end: string;
  assignee: string;
  stageId?: string | undefined;
  categoryId?: string[] | undefined;
};

type UpdateFlags = ProjectFlag & {
  name?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  assignee?: string | undefined;
  stageId?: string | undefined;
  operateAt?: string | undefined;
  categoryId?: string[] | undefined;
};

type DeleteFlags = ProjectFlag & { yes?: boolean | undefined };

type BulkFlags = {
  file: string;
  project?: string | undefined;
  assignee?: string | undefined;
};

const VERSION_COLUMNS: Column<ProjectVersion>[] = [
  { header: 'ID', value: (version) => version.id },
  { header: 'NAME', value: (version) => version.name ?? '', flex: true },
  { header: 'STAGE', value: (version) => refName(version.stage) },
  { header: 'ASSIGNEE', value: (version) => refName(version.assignee) },
  { header: 'START', value: (version) => timestampCell(version.start_at) },
  { header: 'END', value: (version) => timestampCell(version.end_at) },
];

export function registerVersionCommands(parent: Command): void {
  const group = parent
    .command('version')
    .description(
      '发布 releases of a project (scopes pcp:read:pjm:release / pcp:write:pjm:release)',
    )
    .addHelpText(
      'after',
      '\n"version" here is a project RELEASE 发布 — not a wiki page revision, not a work-item\n' +
        'state/property scheme, and not a test plan. Those are unrelated resources that share\n' +
        'the word.\n' +
        'Releases work in every project type, including kanban (sprints do not).\n' +
        'The API ignores --project on `get` and `update`: a version id is effectively\n' +
        'organisation-wide, so naming the wrong project still reads — and still writes, to the\n' +
        'version in its real project. Only `delete` refuses a mismatched pair.\n' +
        '`progress` and `changelog` are read-only: no body field writes them.\n' +
        'Release stages and categories are ids from the generic layer —\n' +
        '  pingcode api GET /v1/pjm/stages\n' +
        '  pingcode api GET /v1/pjm/projects/<project_id>/version_categories\n' +
        '— because those endpoints are outside this command group and a --stage <name> flag\n' +
        'would need one of them.\n',
    );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list the releases of a project')
        .requiredOption('--project <name|id>', PROJECT_HELP)
        .option('--name <text>', 'name SUBSTRING, case-insensitive — a search, not an exact match')
        .option(
          '--status <status>',
          `filter by stage kind: ${STAGE_TYPES.join(' | ')} (the stage's type, not a field)`,
        ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one release')
      .argument('<version>', VERSION_HELP)
      .requiredOption('--project <name|id>', PROJECT_HELP),
    { hidden: true },
  ).action(async (target: string, flags: ProjectFlag, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    group
      .command('create')
      .description('create a release')
      .requiredOption('--project <name|id>', PROJECT_HELP)
      .requiredOption('--name <text>', 'release name, unique within the project')
      .requiredOption('--start <date>', `start — ${DATE_FLAG_HELP}, stored at 00:00:00 local`)
      .requiredOption('--end <date>', `end — ${DATE_FLAG_HELP}, stored at 23:59:59 local`)
      .requiredOption('--assignee <name|id>', 'release owner 负责人 — the API requires one')
      .option(
        '--stage-id <id>',
        'release stage id from `pingcode api GET /v1/pjm/stages`; omitted, the API picks the first',
      )
      .option('--category-id <id>', '发布类别 id, repeatable — replaces the whole set', collectValue),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    group
      .command('update')
      .description('patch a release — only the fields you pass are sent, and arrays replace')
      .argument('<version>', VERSION_HELP)
      .requiredOption('--project <name|id>', `${PROJECT_HELP} (the API does not check this one)`)
      .option('--name <text>', 'new name')
      .option('--start <date>', `new start — ${DATE_FLAG_HELP}, stored at 00:00:00 local`)
      .option('--end <date>', `new end — ${DATE_FLAG_HELP}, stored at 23:59:59 local`)
      .option('--assignee <name|id>', 'new owner')
      .option(
        '--stage-id <id>',
        'move to this stage; needs --operate-at unless the release has been in it before',
      )
      .option(
        '--operate-at <date>',
        `when the release reached --stage-id — ${DATE_FLAG_HELP}, read at 00:00:00 local like ` +
          '--start. Must fall inside the release window, and is only valid WITH --stage-id: ' +
          'alone the API accepts it, echoes the old value and stores nothing',
      )
      .option('--category-id <id>', 'repeatable; replaces the whole set', collectValue),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });

  addGlobalOptions(
    group
      .command('delete')
      .description('delete a release — the only delete in the pjm planning surface')
      .argument('<version>', VERSION_HELP)
      .requiredOption('--project <name|id>', `${PROJECT_HELP} — checked on this verb only`)
      .option('--yes', 'confirm: this cannot be undone'),
    { hidden: true },
  ).action(async (target: string, flags: DeleteFlags, command: Command) => {
    await runDelete(target, flags, command);
  });

  addGlobalOptions(
    group
      .command('bulk')
      .description('create many releases in one atomic call — 企业令牌 only')
      .requiredOption('--file <path|->', 'JSON array of entries, or - for stdin (see below)')
      .option('--project <name|id>', 'default project for entries that name none')
      .option('--assignee <name|id>', 'default owner for entries that name none'),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\nEach entry: {"name": "1.4.0", "start": "2026-09-01", "end": "2026-09-30"} plus any of\n' +
        'project / project_id, assignee / assignee_id, stage_id, categories (ids). A\n' +
        '{"versions": [ … ]} wrapper is accepted too. Unknown keys are REFUSED before\n' +
        'anything is sent, because the API would accept them and silently drop the value.\n' +
        'The docs mark stage_id required on this endpoint; it is not — omitted, the API picks\n' +
        'the first stage, exactly as `create` does.\n' +
        'The call is atomic: if any entry is rejected, none is created. No entry limit is\n' +
        'imposed — 60 in one call was accepted upstream. Two entries sharing a name inside\n' +
        'one batch is an HTTP 500 and creates nothing.\n' +
        'This endpoint is 企业令牌 only and the docs declare NO scope for it; whether it is\n' +
        'genuinely scope-exempt is unverified. `pingcode api describe pjm.versions.bulk` says\n' +
        'the same.\n',
    )
    .action(async (flags: BulkFlags, command: Command) => {
      await runBulk(flags, command);
    });
}

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const project = await resolveProject(ctx, flags.project);
  const query: VersionListQuery = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.status === undefined ? {} : { status: readStageType(flags.status) }),
  };

  if (paging.all) {
    const values = await collect(
      iterateVersions(ctx, project.id, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, VERSION_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listVersions(ctx, project.id, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, VERSION_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: ProjectFlag, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const project = await resolveProject(ctx, flags.project);
  const version = await resolveProjectVersion(ctx, project.id, requireFlag(target, '<version>'));
  printVersion(await getVersion(ctx, project.id, version.id), ctx);
}

// ---------------------------------------------------------------------------
// create / update
// ---------------------------------------------------------------------------

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const name = requireFlag(flags.name, '--name');
  const start = parseDateBoundaryFlag(flags.start, '--start', 'start');
  const end = parseDateBoundaryFlag(flags.end, '--end', 'end');
  requireOrderedWindow(start, end);

  const version = await runWrite(
    ctx,
    async (
      attemptCtx,
    ): Promise<ResolvedWrite<{ projectId: string; input: CreateVersionInput }>> => {
      const project = await resolveProject(attemptCtx, flags.project);
      const assignee = await resolveUser(attemptCtx, requireFlag(flags.assignee, '--assignee'));
      return {
        resolutions: [project, assignee],
        value: {
          projectId: project.id,
          input: {
            name,
            start_at: start,
            end_at: end,
            assignee_id: assignee.id,
            ...(flags.stageId === undefined ? {} : { stage_id: flags.stageId }),
            ...(flags.categoryId === undefined ? {} : { category_ids: flags.categoryId }),
          },
        },
      };
    },
    async (attemptCtx, { projectId, input }) => await createVersion(attemptCtx, projectId, input),
  );

  printVersion(version, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const start =
    flags.start === undefined ? undefined : parseDateBoundaryFlag(flags.start, '--start', 'start');
  const end = flags.end === undefined ? undefined : parseDateBoundaryFlag(flags.end, '--end', 'end');
  if (start !== undefined && end !== undefined) requireOrderedWindow(start, end);
  // `parseDateBoundaryFlag`, not `parseTimestampFlag`: the latter reads a bare date as
  // **UTC**, which would put `--start 2026-11-01 --operate-at 2026-11-01` eight hours
  // apart on this tenant and could push the value outside the window the server checks
  // it against (400 `100395`). All three date flags on this leaf are therefore local and
  // start-of-day.
  const operateAt =
    flags.operateAt === undefined
      ? undefined
      : parseDateBoundaryFlag(flags.operateAt, '--operate-at', 'start');

  // `operate_at` without `stage_id` is accepted upstream, echoes the old value and
  // stores nothing (design D15.7). Sending it anyway would report success for a change
  // that did not happen, which is the one failure mode worth spending a refusal on.
  if (operateAt !== undefined && flags.stageId === undefined) {
    throw new UsageError('--operate-at requires --stage-id', {
      hint:
        'the API stores operate_at only as part of a stage change: sent alone it answers 200, ' +
        'echoes the previous value and changes nothing. Pass --stage-id <id> as well',
    });
  }

  const patchBase: UpdateVersionInput = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(start === undefined ? {} : { start_at: start }),
    ...(end === undefined ? {} : { end_at: end }),
    ...(flags.stageId === undefined ? {} : { stage_id: flags.stageId }),
    ...(operateAt === undefined ? {} : { operate_at: operateAt }),
    ...(flags.categoryId === undefined ? {} : { category_ids: flags.categoryId }),
  };

  if (Object.keys(patchBase).length === 0 && flags.assignee === undefined) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --name / --start / --end / --assignee / --stage-id / ' +
        '--category-id. progress and changelog are read-only',
    });
  }

  const version = await runWrite(
    ctx,
    async (
      attemptCtx,
    ): Promise<
      ResolvedWrite<{ projectId: string; versionId: string; patch: UpdateVersionInput }>
    > => {
      const project = await resolveProject(attemptCtx, flags.project);
      const versionRef = await resolveProjectVersion(
        attemptCtx,
        project.id,
        requireFlag(target, '<version>'),
      );
      const resolutions: ResolveResult[] = [project, versionRef];
      const patch: UpdateVersionInput = { ...patchBase };
      if (flags.assignee !== undefined) {
        const assignee = await resolveUser(attemptCtx, flags.assignee);
        resolutions.push(assignee);
        patch.assignee_id = assignee.id;
      }
      return { resolutions, value: { projectId: project.id, versionId: versionRef.id, patch } };
    },
    async (attemptCtx, { projectId, versionId, patch }) =>
      await updateVersion(attemptCtx, projectId, versionId, patch),
  );

  printVersion(version, ctx, 'updated');
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function runDelete(target: string, flags: DeleteFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const project = await resolveProject(ctx, flags.project);
  const versionRef = await resolveProjectVersion(ctx, project.id, requireFlag(target, '<version>'));

  // One GET before the gate, so the confirmation names the release rather than an id
  // (design D8.1). Worth the request: this is irreversible and it silently edits work
  // items.
  const existing = await getVersion(ctx, project.id, versionRef.id);

  if (flags.yes !== true) {
    throw new UsageError(
      `refusing to delete release ${describe(existing)} without --yes`,
      {
        hint:
          'this cannot be undone, and it also DETACHES the release from every work item that ' +
          'references it (verified live: the work item keeps existing, its version link ' +
          'disappears). Re-run with --yes, or with --yes --dry-run to see the request first',
      },
    );
  }

  printVersion(await deleteVersion(ctx, project.id, versionRef.id), ctx, 'deleted');
}

/** `"1.4.0"`, falling back to the id — what the `--yes` gate echoes. */
function describe(version: ProjectVersion): string {
  const name = version.name?.replace(/\s+/g, ' ').trim() ?? '';
  return name === '' ? version.id : `"${name}" (${version.id})`;
}

// ---------------------------------------------------------------------------
// bulk
// ---------------------------------------------------------------------------

async function runBulk(flags: BulkFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const entries = await readBulkEntries(
    { file: flags.file },
    { wrapperKey: 'versions', extraKeys: ['stage_id'] },
  );

  const results = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<BulkVersionEntry[]>> => {
      const resolutions: ResolveResult[] = [];
      const shared = await readSharedRefs(attemptCtx, flags, resolutions, {
        project: resolveProject,
        assignee: resolveUser,
      });
      const payload: BulkVersionEntry[] = [];

      for (const [index, entry] of entries.entries()) {
        const resolved = await resolveBulkEntry(attemptCtx, entry, {
          ...shared,
          resolveProject,
          resolveAssignee: resolveUser,
          at: `entry ${index}`,
        });
        resolutions.push(...resolved.resolutions);
        requireOrderedWindow(entry.start, entry.end, `entry ${index}`);
        payload.push({
          project_id: resolved.projectId,
          name: entry.name,
          start_at: entry.start,
          end_at: entry.end,
          assignee_id: resolved.assigneeId,
          ...(entry.extra.stage_id === undefined
            ? {}
            : { stage_id: String(entry.extra.stage_id) }),
          ...(entry.categoryIds === undefined ? {} : { category_ids: entry.categoryIds }),
        });
      }
      return { resolutions, value: payload };
    },
    async (attemptCtx, payload) => await bulkCreateVersions(attemptCtx, payload),
  );

  printBulk(results, ctx);
}

// ---------------------------------------------------------------------------
// shared checks and rendering
// ---------------------------------------------------------------------------

function requireOrderedWindow(start: number, end: number, at?: string): void {
  if (start <= end) return;
  const where = at === undefined ? '--end is before --start' : `${at}: end is before start`;
  throw new UsageError(where, {
    hint: 'the API rejects a backwards window too (开始时间必须小于结束时间); swap the two dates',
  });
}

/**
 * `?status=` names the **stage's `type`**, not a field of the release — which is why an
 * unknown value is caught here: the server's `100003` says "not a valid enum" without
 * listing one, and a reader would look for a `status` field that does not exist.
 */
function readStageType(value: string): string {
  const status = value.trim();
  if (!STAGE_TYPES.includes(status)) {
    throw new UsageError(`unknown release stage kind "${value}"`, {
      hint:
        `expected one of ${STAGE_TYPES.join(' | ')} — these are stage *types*, not stage names; ` +
        'list the stages themselves with `pingcode api GET /v1/pjm/stages`',
    });
  }
  return status;
}

function printVersion(version: ProjectVersion, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    version,
    [
      ['name', version.name ?? ''],
      ['id', version.id],
      ['project', refName(version.project)],
      ['stage', refName(version.stage)],
      ['reached', timestampCell(version.operate_at)],
      ['owner', refName(version.assignee)],
      ['start', timestampCell(version.start_at)],
      ['end', timestampCell(version.end_at)],
      ['progress', version.progress === undefined ? '' : `${version.progress}%`],
      ['categories', version.categories.map((category) => refName(category)).join(', ')],
      ['changelog', version.changelog ?? ''],
      ['url', version.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${version.name ?? version.id}`));
  }
}

function printBulk(results: BulkCreateResult<ProjectVersion>[], ctx: Ctx): void {
  const created = results.flatMap((result) =>
    result.resource === undefined ? [] : [result.resource],
  );
  const mode = modeOf(ctx);
  if (mode.json) {
    // Same reasoning as `project sprint bulk`: keep the wire's per-entry `{state,
    // version}` shape, because `state` is the only per-entry acknowledgement there is.
    printCollection(results, [], mode);
    return;
  }
  printCollection(created, VERSION_COLUMNS, mode);
  errLine(paint.green(`created ${created.length} release(s)`));
}
