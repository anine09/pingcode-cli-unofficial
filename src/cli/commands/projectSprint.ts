import type { Command } from 'commander';
import {
  bulkCreateSprints,
  createSprint,
  getSprint,
  updateSprint,
  type BulkSprintEntry,
  type CreateSprintInput,
  type UpdateSprintInput,
} from '../../api/projects';
import type { Ctx } from '../../core/context';
import { PingcodeError, UsageError, type PingcodeErrorOptions } from '../../core/errors';
import { resolveProject, resolveSprint, resolveUser, type ResolveResult } from '../../core/metadata';
import type { BulkCreateResult, Sprint } from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import { readBulkEntries, readSharedRefs, resolveBulkEntry } from './_shared/bulkEntries';
import {
  collectValue,
  contextFor,
  modeOf,
  parseDateBoundaryFlag,
  printCollection,
  printResource,
  refName,
  requireFlag,
  runWrite,
  timestampCell,
  type ResolvedWrite,
} from './common';

/**
 * `pingcode project sprint …` — 迭代 ([S§3.8.5]), the write half of the sprint
 * surface. Live-verified 2026-08-04 (design D15).
 *
 * **There is no `list` leaf here, and that is not an omission.** The sprint list was
 * already covered before this task, as `pingcode project meta sprints --project <p>`,
 * because it was first needed as a *lookup* — it is what `--sprint <name>` on a work
 * item resolves against. Adding a second leaf over the same endpoint would duplicate
 * a command rather than reach a new one, so this group's `--help` points at the
 * existing one instead.
 *
 * **There is no `delete` leaf either, and that one is upstream's**: the path supports
 * GET and PATCH only ([S§3.8.5], confirmed live — `pingcode api DELETE …/sprints/<id>`
 * is refused by the catalog pre-flight, not by us). A sprint created by mistake is
 * permanent, so `create` and `bulk` are the two most consequential leaves in this
 * group and both say so.
 *
 * Group-wide facts, so no leaf repeats them:
 *
 *  - scopes `pcp:read:pjm:sprint` / `pcp:write:pjm:sprint`.
 *  - **sprints exist only in scrum and hybrid projects.** A kanban project's list
 *    answers 200 with zero rows, but a `create` against it fails with the same code
 *    an absent project gives (`100300 'project'资源不存在`) — which is why that code
 *    is not mapped to exit 5 and why `create` explains it in its own hint.
 *  - the window is **day-granular**: the server stores `--start` at 00:00:00 and
 *    `--end` at 23:59:59 of the date given, so these are dates, not instants.
 *  - `--status` writes a field, it does **not** run the sprint lifecycle: patching a
 *    sprint to `in_progress` or `completed` leaves `started_at` / `completed_at`
 *    `null`, and neither is writable at all.
 */

const DATE_FLAG_HELP = 'a date (2026-08-31) or a 10-digit unix seconds value';
const STATUS_HELP = 'pending | in_progress | completed';

const PROJECT_HELP = 'project name or id — a sprint lives inside one project';

/** 迭代 status values the API validates (400 `100003` on anything else). */
const SPRINT_STATUSES = ['pending', 'in_progress', 'completed'];

type SprintFlags = { project: string };

type CreateFlags = SprintFlags & {
  name: string;
  start: string;
  end: string;
  assignee: string;
  description?: string | undefined;
  status?: string | undefined;
  categoryId?: string[] | undefined;
};

type UpdateFlags = SprintFlags & {
  name?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  assignee?: string | undefined;
  description?: string | undefined;
  status?: string | undefined;
  categoryId?: string[] | undefined;
};

type BulkFlags = {
  file: string;
  project?: string | undefined;
  assignee?: string | undefined;
};

/**
 * Local, not exported: `project meta sprints` keeps its own narrower column set. The
 * two are deliberately not merged — widening an existing leaf's human output is a
 * change to a command this task does not own.
 */
const SPRINT_COLUMNS: Column<Sprint>[] = [
  { header: 'ID', value: (sprint) => sprint.id },
  { header: 'NAME', value: (sprint) => sprint.name ?? '', flex: true },
  { header: 'STATUS', value: (sprint) => sprint.status ?? '' },
  { header: 'ASSIGNEE', value: (sprint) => refName(sprint.assignee) },
  { header: 'START', value: (sprint) => timestampCell(sprint.start_at) },
  { header: 'END', value: (sprint) => timestampCell(sprint.end_at) },
];

export function registerSprintCommands(parent: Command): void {
  const group = parent
    .command('sprint')
    .description('迭代 sprints: plan and update them (scopes pcp:read:pjm:sprint / pcp:write:pjm:sprint)')
    // Two absences and one lookup, stated where the reader is. Both absences are
    // things a user will otherwise hunt for: `list` exists under another name, and
    // `delete` does not exist at all.
    .addHelpText(
      'after',
      '\nThere is no `sprint list` here: the sprint list is `pingcode project meta sprints\n' +
        '--project <p>`, which already existed because --sprint <name> resolves against it.\n' +
        'There is no `sprint delete` anywhere, and there cannot be: the API exposes only GET\n' +
        'and PATCH on a sprint, so a sprint you create is permanent. Neither is\n' +
        '`pingcode api DELETE /v1/pjm/projects/<p>/sprints/<id>` — it is refused before any\n' +
        'request, because the endpoint is not documented to exist.\n' +
        'Sprints exist only in scrum/hybrid projects. In a kanban project the list is empty\n' +
        "and a create fails with 'project'资源不存在 — the project is fine, sprints are not\n" +
        'available in it.\n',
    );

  addGlobalOptions(
    group
      .command('get')
      .description('show one sprint')
      .argument('<sprint>', 'sprint name or id')
      .requiredOption('--project <name|id>', PROJECT_HELP),
    { hidden: true },
  ).action(async (target: string, flags: SprintFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    group
      .command('create')
      .description('create a sprint (permanent — there is no way to delete one)')
      .requiredOption('--project <name|id>', PROJECT_HELP)
      .requiredOption('--name <text>', 'sprint name, unique within the project')
      .requiredOption('--start <date>', `start — ${DATE_FLAG_HELP}, stored at 00:00:00 local`)
      .requiredOption('--end <date>', `end — ${DATE_FLAG_HELP}, stored at 23:59:59 local`)
      .requiredOption('--assignee <name|id>', 'sprint owner 负责人 — the API requires one')
      .option('--description <text>', 'description')
      .option('--status <status>', `initial status: ${STATUS_HELP} (default pending)`)
      .option('--category-id <id>', '迭代类别 id, repeatable — replaces the whole set', collectValue),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    group
      .command('update')
      .description('patch a sprint — only the fields you pass are sent, and arrays replace')
      .argument('<sprint>', 'sprint name or id')
      .requiredOption('--project <name|id>', PROJECT_HELP)
      .option('--name <text>', 'new name')
      .option('--start <date>', `new start — ${DATE_FLAG_HELP}, stored at 00:00:00 local`)
      .option('--end <date>', `new end — ${DATE_FLAG_HELP}, stored at 23:59:59 local`)
      .option('--assignee <name|id>', 'new owner')
      .option('--description <text>', 'new description (replaces the old one)')
      .option(
        '--status <status>',
        `${STATUS_HELP} — writes the field only; it does NOT start or complete the sprint`,
      )
      .option('--category-id <id>', 'repeatable; replaces the whole set, none clears it', collectValue),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });

  addGlobalOptions(
    group
      .command('bulk')
      .description('create many sprints in one atomic call — 企业令牌 only, and permanent')
      .requiredOption('--file <path|->', 'JSON array of entries, or - for stdin (see below)')
      .option('--project <name|id>', 'default project for entries that name none')
      .option('--assignee <name|id>', 'default owner for entries that name none'),
    { hidden: true },
  )
    .addHelpText(
      'after',
      '\nEach entry: {"name": "Sprint 5", "start": "2026-09-01", "end": "2026-09-14"} plus any\n' +
        'of project / project_id, assignee / assignee_id, description, status, categories\n' +
        '(ids). A {"sprints": [ … ]} wrapper is accepted too, so a body from the API docs\n' +
        'works unchanged. Unknown keys are REFUSED before anything is sent, because the API\n' +
        'would accept them and silently drop the value.\n' +
        'The call is atomic: if any entry is rejected, none of them is created (verified\n' +
        'live). No entry limit is imposed — 60 in one call was accepted upstream.\n' +
        'This endpoint is 企业令牌 only and the docs declare NO scope for it; whether it is\n' +
        'genuinely scope-exempt is unverified. `pingcode api describe pjm.sprints.bulk` says\n' +
        'the same.\n',
    )
    .action(async (flags: BulkFlags, command: Command) => {
      await runBulk(flags, command);
    });
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function runGet(target: string, flags: SprintFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const project = await resolveProject(ctx, flags.project);
  const sprint = await resolveSprint(ctx, project.id, requireFlag(target, '<sprint>'));
  printSprint(await getSprint(ctx, project.id, sprint.id), ctx);
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
  const status = readStatus(flags.status);

  const sprint = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<{ projectId: string; input: CreateSprintInput }>> => {
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
            ...(flags.description === undefined ? {} : { description: flags.description }),
            ...(status === undefined ? {} : { status }),
            ...(flags.categoryId === undefined ? {} : { category_ids: flags.categoryId }),
          },
        },
      };
    },
    async (attemptCtx, { projectId, input }) => await createSprint(attemptCtx, projectId, input),
  ).catch(explainKanban);

  printSprint(sprint, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const start = flags.start === undefined ? undefined : parseDateBoundaryFlag(flags.start, '--start', 'start');
  const end = flags.end === undefined ? undefined : parseDateBoundaryFlag(flags.end, '--end', 'end');
  if (start !== undefined && end !== undefined) requireOrderedWindow(start, end);
  const status = readStatus(flags.status);

  const patchBase: UpdateSprintInput = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(start === undefined ? {} : { start_at: start }),
    ...(end === undefined ? {} : { end_at: end }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(status === undefined ? {} : { status }),
    ...(flags.categoryId === undefined ? {} : { category_ids: flags.categoryId }),
  };

  if (Object.keys(patchBase).length === 0 && flags.assignee === undefined) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --name / --start / --end / --assignee / --description / ' +
        '--status / --category-id',
    });
  }

  // Only one end of the window in a patch is checked against the **stored** other end
  // (400 `100042`), so a window can be moved forward by sending both — which this API
  // allows and `release deploy` does not (design D14.6). Nothing to guard client-side.
  const sprint = await runWrite(
    ctx,
    async (
      attemptCtx,
    ): Promise<ResolvedWrite<{ projectId: string; sprintId: string; patch: UpdateSprintInput }>> => {
      const project = await resolveProject(attemptCtx, flags.project);
      const sprintRef = await resolveSprint(attemptCtx, project.id, requireFlag(target, '<sprint>'));
      const resolutions: ResolveResult[] = [project, sprintRef];
      const patch: UpdateSprintInput = { ...patchBase };
      if (flags.assignee !== undefined) {
        const assignee = await resolveUser(attemptCtx, flags.assignee);
        resolutions.push(assignee);
        patch.assignee_id = assignee.id;
      }
      return { resolutions, value: { projectId: project.id, sprintId: sprintRef.id, patch } };
    },
    async (attemptCtx, { projectId, sprintId, patch }) =>
      await updateSprint(attemptCtx, projectId, sprintId, patch),
  );

  printSprint(sprint, ctx, 'updated');
}

// ---------------------------------------------------------------------------
// bulk
// ---------------------------------------------------------------------------

async function runBulk(flags: BulkFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const entries = await readBulkEntries(
    { file: flags.file },
    { wrapperKey: 'sprints', extraKeys: ['description', 'status'] },
  );
  for (const entry of entries) readStatus(entry.extra.status as string | undefined);

  const results = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<BulkSprintEntry[]>> => {
      const resolutions: ResolveResult[] = [];
      const shared = await readSharedRefs(attemptCtx, flags, resolutions, {
        project: resolveProject,
        assignee: resolveUser,
      });
      const payload: BulkSprintEntry[] = [];

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
          ...(entry.extra.description === undefined
            ? {}
            : { description: String(entry.extra.description) }),
          ...(entry.extra.status === undefined ? {} : { status: String(entry.extra.status) }),
          ...(entry.categoryIds === undefined ? {} : { category_ids: entry.categoryIds }),
        });
      }
      return { resolutions, value: payload };
    },
    async (attemptCtx, payload) => await bulkCreateSprints(attemptCtx, payload),
  ).catch(explainKanban);

  printBulk(results, ctx);
}

// ---------------------------------------------------------------------------
// shared checks and rendering
// ---------------------------------------------------------------------------

/**
 * Refuse a backwards window locally, so it costs no request.
 *
 * The server checks it too (400 `100042` `开始时间必须小于结束时间`), and unlike a state
 * transition this is judgeable from the input alone — no server knowledge is being
 * guessed at, which is the line design §13.2 drew for local pre-validation.
 */
function requireOrderedWindow(start: number, end: number, at?: string): void {
  if (start <= end) return;
  const where = at === undefined ? '--end is before --start' : `${at}: end is before start`;
  throw new UsageError(where, {
    hint: 'the API rejects a backwards window too (开始时间必须小于结束时间); swap the two dates',
  });
}

/** Reject an unknown status before the request; the server's message names no valid values. */
function readStatus(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const status = value.trim();
  if (!SPRINT_STATUSES.includes(status)) {
    throw new UsageError(`unknown sprint status "${value}"`, {
      hint: `expected one of ${SPRINT_STATUSES.join(' | ')} — the API validates this and its message does not list them`,
    });
  }
  return status;
}

/**
 * A kanban project reports `100300 'project'资源不存在` for a sprint write even though
 * the project exists (design D15.8). The code is deliberately **not** mapped to exit 5
 * for exactly that reason, so the explanation has to come from here — this is the only
 * layer that knows the request was a *sprint* write.
 *
 * The text goes on the **message**, not the hint: `--json` renders errors as
 * `{kind,message,code,exit}` and drops the hint, and an agent told "that project does
 * not exist" about a project it just listed will otherwise loop. Same mechanism as
 * ship's `explainStateRejection` (design §14.3).
 */
function explainKanban(error: unknown): never {
  if (!(error instanceof PingcodeError) || error.code !== '100300') throw error;
  const Ctor = error.constructor as new (
    message: string,
    options?: PingcodeErrorOptions,
  ) => PingcodeError;
  throw new Ctor(
    `${error.message} — sprints exist only in scrum/hybrid projects: a kanban or waterfall ` +
      "project answers 'project'资源不存在 for a sprint write even though the project itself " +
      'is fine. Check the project type with `pingcode project get <project>`',
    {
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.status === undefined ? {} : { status: error.status }),
      hint:
        'if the project type is kanban or waterfall there is nothing to fix — plan with ' +
        '`project version` instead, which works in every project type',
      cause: error,
    },
  );
}

function printSprint(sprint: Sprint, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    sprint,
    [
      ['name', sprint.name ?? ''],
      ['id', sprint.id],
      ['project', refName(sprint.project)],
      ['status', sprint.status ?? ''],
      ['owner', refName(sprint.assignee)],
      ['start', timestampCell(sprint.start_at)],
      ['end', timestampCell(sprint.end_at)],
      ['started', timestampCell(sprint.started_at)],
      ['completed', timestampCell(sprint.completed_at)],
      ['story points', storyPointCell(sprint)],
      ['categories', sprint.categories.map((category) => refName(category)).join(', ')],
      ['description', sprint.description ?? ''],
      ['url', sprint.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${sprint.name ?? sprint.id}`));
  }
}

/**
 * `completed / total` — and deliberately blank when the sprint reports neither.
 * A fresh sprint reports `0` for all three (design D15.9), so `0/0` is a real answer;
 * `undefined` is "the field was not sent at all", which is not.
 */
function storyPointCell(sprint: Sprint): string {
  if (sprint.total_story_points === undefined && sprint.completed_story_points === undefined) {
    return '';
  }
  return `${sprint.completed_story_points ?? 0} / ${sprint.total_story_points ?? 0}`;
}

function printBulk(results: BulkCreateResult<Sprint>[], ctx: Ctx): void {
  const created = results.flatMap((result) =>
    result.resource === undefined ? [] : [result.resource],
  );
  const mode = modeOf(ctx);
  if (mode.json) {
    // `--json` keeps the wire's own per-entry `{state, sprint}` shape rather than
    // flattening to the resources: `state` is the only place a caller can see that the
    // server acknowledged each entry, and this response is the one bare array in the
    // API. No columns, because the JSON branch never renders a table.
    printCollection(results, [], mode);
    return;
  }
  printCollection(created, SPRINT_COLUMNS, mode);
  errLine(paint.green(`created ${created.length} sprint(s) — sprints cannot be deleted`));
}
