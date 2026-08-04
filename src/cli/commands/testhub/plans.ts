import type { Command } from 'commander';
import {
  createPlan,
  getPlan,
  iteratePlans,
  listPlans,
  type CreatePlanInput,
  type PlanListQuery,
} from '../../../api/testhub';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import {
  resolveTestPlan,
  resolveTestPlanType,
  resolveUser,
} from '../../../core/metadata';
import { collect } from '../../../core/paginate';
import type { TestPlan } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  addPagingOptions,
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
} from '../common';
import {
  addPairOptions,
  LIBRARY_HELP,
  present,
  readPair,
  requireLibraryFlag,
  resolvePair,
  type LibraryFlags,
} from './libraries';

/**
 * `pingcode testhub plans …` — 测试计划, the only testhub resource addressed
 * **under** its library in the URL, which is why `--library` is structurally
 * required on every leaf here rather than merely useful.
 */

/**
 * The two accepted `--start` / `--end` forms. The end-of-day asymmetry is spelled
 * out per flag at the call site, because it is the surprising half: a plan runs
 * *through* its end date, so `--end` is 23:59:59 rather than midnight.
 */
const DATE_FLAG_HELP = 'YYYY-MM-DD, or a 10-digit unix seconds value used verbatim';

type TypeFlags = { type?: string | undefined; typeId?: string | undefined };
/**
 * 负责人 on a plan. A separate pair from `--executor` (执行人 on a run) even
 * though both resolve through the org directory: they are different fields on
 * different resources, and merging them would let a `plans create` typo silently
 * read a run flag.
 */
type AssigneeFlags = { assignee?: string | undefined; assigneeId?: string | undefined };

const TEST_PLAN_COLUMNS: Column<TestPlan>[] = [
  { header: 'ID', value: (p) => p.short_id ?? p.id },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
  { header: 'TYPE', value: (p) => refName(p.type) },
  { header: 'STATE', value: (p) => refName(p.state) },
  { header: 'START', value: (p) => timestampCell(p.start_at) },
  { header: 'END', value: (p) => timestampCell(p.end_at) },
];

type PlanListFlags = PagingFlags & LibraryFlags & { name?: string | undefined };

type PlanCreateFlags = LibraryFlags &
  TypeFlags &
  AssigneeFlags & {
    name: string;
    start: string;
    end: string;
  };

/**
 * Plans are the **only** testhub resource addressed under their library in the
 * URL, so `--library` is structurally required here rather than merely useful.
 *
 * `create` covers the plain (普通) plan, which needs none of `project_id` /
 * `sprint_id` / `version_id`. It cannot do better: a plan *type* carries no kind
 * discriminator (testhub §10.7), so the CLI cannot tell which types demand those
 * fields, and inferring it from the localized name is not an option because
 * tenants rename them. Choose an iteration or release type and the server's
 * refusal is what surfaces — deliberately, rather than a guess.
 *
 * `update` and `delete` remain out of scope.
 */
export function registerPlanCommands(parent: Command): void {
  const group = parent
    .command('plans')
    .description('test plans 测试计划 (scope pcp:read:testhub:testplan)');

  const list = addPagingOptions(
    group
      .command('list')
      .description('list the plans of a library')
      .option('--name <text>', 'filter by plan name (names are unique per library)'),
  );
  addPairOptions(list, 'library', LIBRARY_HELP);
  addGlobalOptions(list, { hidden: true }).action(
    async (flags: PlanListFlags, command: Command) => {
      const { ctx } = contextFor(command);
      const paging = readPaging(flags);
      const library = await requireLibraryFlag(ctx, flags);
      const query: PlanListQuery = {
        ...(flags.name === undefined ? {} : { name: flags.name }),
      };

      if (paging.all) {
        const values = await collect(
          iteratePlans(ctx, library.id, query, {
            pageSize: paging.pageSize,
            limit: paging.limit,
          }),
        );
        printCollection(values, TEST_PLAN_COLUMNS, modeOf(ctx), { all: true });
        return;
      }

      const page = await listPlans(ctx, library.id, query, {
        pageIndex: paging.pageIndex,
        pageSize: paging.pageSize,
      });
      printPage(page, TEST_PLAN_COLUMNS, modeOf(ctx));
    },
  );

  const get = group
    .command('get')
    .description('show one plan (accepts an id or a short_id)')
    .argument('<plan>', 'plan id, short_id or name');
  addPairOptions(get, 'library', LIBRARY_HELP);
  addGlobalOptions(get, { hidden: true }).action(
    async (target: string, flags: LibraryFlags, command: Command) => {
      const { ctx } = contextFor(command);
      const library = await requireLibraryFlag(ctx, flags);
      const plan = await resolveTestPlan(ctx, library.id, requireFlag(target, '<plan>'));
      const resource = await getPlan(ctx, library.id, plan.id);

      printResource(
        resource,
        [
          ['name', resource.name ?? ''],
          ['id', resource.id],
          ['short id', resource.short_id ?? ''],
          ['library', refName(resource.library)],
          ['type', refName(resource.type)],
          ['state', refName(resource.state)],
          ['assignee', refName(resource.assignee)],
          ['project', refName(resource.project)],
          ['sprint', refName(resource.sprint)],
          ['version', refName(resource.version)],
          ['start', timestampCell(resource.start_at)],
          ['end', timestampCell(resource.end_at)],
          ['created', timestampCell(resource.created_at)],
          ['updated', timestampCell(resource.updated_at)],
          ['url', resource.html_url ?? resource.url ?? ''],
          ['summary', resource.summary ?? ''],
        ],
        modeOf(ctx),
      );
    },
  );

  const create = group
    .command('create')
    .description('create a test plan (the name must be unique within the library)')
    .requiredOption('--name <text>', 'plan name, unique within the library')
    .requiredOption('--start <date>', `start of the plan — ${DATE_FLAG_HELP}, at 00:00:00 local`)
    .requiredOption('--end <date>', `end of the plan — ${DATE_FLAG_HELP}, at 23:59:59 local`);
  addPairOptions(create, 'library', LIBRARY_HELP);
  addPairOptions(create, 'type', 'plan type; list them with `testhub meta plan-types`');
  addPairOptions(create, 'assignee', 'plan owner 负责人, from the organisation directory');
  addGlobalOptions(create, { hidden: true }).action(
    async (flags: PlanCreateFlags, command: Command) => {
      await runPlanCreate(flags, command);
    },
  );

}

/**
 * `POST /libraries/{id}/plans` — all five body fields are required ([th#47]).
 *
 * Two of them are name-resolved against the 24 h metadata cache (`--type`,
 * `--assignee`), so this goes through `runWrite`: a stale type id is possible,
 * and `runWrite` re-resolves once with the cache bypassed before giving up.
 *
 * `--assignee` has **no default**, deliberately. An enterprise token acts as the
 * bot user, so defaulting to "me" would silently make a bot the owner of every
 * plan the CLI creates — invisible until someone wonders who to ask about it.
 */
async function runPlanCreate(flags: PlanCreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  // Flag shape is validated before the library hop, so a bad date or a
  // conflicting pair costs no requests at all.
  const typePair = readPair('type', flags.type, flags.typeId);
  const assigneePair = readPair('assignee', flags.assignee, flags.assigneeId);
  const name = requireFlag(flags.name, '--name');
  const startAt = parseDateBoundaryFlag(flags.start, '--start', 'start');
  const endAt = parseDateBoundaryFlag(flags.end, '--end', 'end');

  if (endAt < startAt) {
    throw new UsageError('--end is before --start', {
      hint: `--start resolved to ${startAt} and --end to ${endAt} (unix seconds)`,
    });
  }
  if (typePair === undefined) {
    throw new UsageError('--type <name|id> is required', {
      hint: 'list the types configured for this library with `pingcode testhub meta plan-types --library <library>`',
    });
  }
  if (assigneePair === undefined) {
    throw new UsageError('--assignee <name|id> is required', {
      hint:
        'a plan needs an explicit owner: an enterprise token acts as the bot user, so there is ' +
        'no meaningful "me" to default to. List candidates with `pingcode settings users`',
    });
  }

  const library = await requireLibraryFlag(ctx, flags);

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<CreatePlanInput>> => {
    const type = await resolvePair('testhub-plan-type', typePair, (input) =>
      resolveTestPlanType(attemptCtx, library.id, input),
    );
    const assignee = await resolvePair('user', assigneePair, (input) =>
      resolveUser(attemptCtx, input),
    );
    if (type === undefined || assignee === undefined) {
      throw new UsageError('--type and --assignee are both required');
    }

    const input: CreatePlanInput = {
      name,
      type_id: type.id,
      start_at: startAt,
      end_at: endAt,
      assignee_id: assignee.id,
    };
    return { resolutions: present([type, assignee]), value: input };
  };

  const plan = await runWrite(ctx, resolve, (attemptCtx, input) =>
    createPlan(attemptCtx, library.id, input),
  );

  const mode = modeOf(ctx);
  printResource(
    plan,
    [
      ['name', plan.name ?? ''],
      ['id', plan.id],
      ['short id', plan.short_id ?? ''],
      ['library', refName(plan.library)],
      ['type', refName(plan.type)],
      ['state', refName(plan.state)],
      ['assignee', refName(plan.assignee)],
      ['start', timestampCell(plan.start_at)],
      ['end', timestampCell(plan.end_at)],
      ['url', plan.html_url ?? plan.url ?? ''],
    ],
    mode,
  );
  if (!mode.json) errLine(paint.green(`created ${plan.short_id ?? plan.id}`));
}
