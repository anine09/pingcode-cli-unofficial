import type { Command } from 'commander';
import {
  bulkCreateRuns,
  bulkRuns,
  bulkUpdateRuns,
  createRun,
  getCase,
  getRun,
  getRunHistory,
  iterateRunHistories,
  iterateRuns,
  listRunHistories,
  patchRun,
  searchRuns,
  type BulkRunInsert,
  type BulkRunUpdate,
  type BulkRunsInput,
  type BulkUpdateRunEntry,
  type CreateRunInput,
  type PatchRunInput,
  type RunStepInput,
} from '../../../api/testhub';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import {
  resolveRunStatus,
  resolveTestPlan,
  resolveUser,
  type ResolveResult,
} from '../../../core/metadata';
import { collect, type SearchPayload } from '../../../core/paginate';
import type { TestRun, TestRunBulkItem, TestRunHistoryItem } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import { addCrosscutting } from '../_shared/crosscutting';
import {
  addPagingOptions,
  collectValue,
  contextFor,
  mergeFilters,
  modeOf,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refFilter,
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
  refId,
  requireLibraryFlag,
  resolveLibraryFlag,
  resolvePair,
  SHORT_ID_WRITE_CAVEAT,
  withConfigurationScope,
  type LibraryFlags,
  type PairInput,
} from './libraries';
import {
  checkBulkLimit,
  entryPair,
  optionalEntryString,
  readEntryFile,
  type RawEntry,
} from './entries';

/**
 * `pingcode testhub runs …` — 执行用例, one case's placement in one plan plus its
 * latest result. The module's sharpest edges live here: `PATCH /runs/{id}`
 * requires `status_id` even when nothing about the result changes, `steps[]` is a
 * whole-array replacement, and the executor has to be carried over by hand
 * (design §7).
 */

const RUN_LIBRARY_FILTER_CAVEAT =
  'run search cannot filter by library.id — it is on the API exclusion list, so scope runs with --plan instead';

type StatusFlags = { status?: string | undefined; statusId?: string | undefined };
type ExecutorFlags = { executor?: string | undefined; executorId?: string | undefined };
type PlanFlags = { plan?: string | undefined; planId?: string | undefined };

// ---------------------------------------------------------------------------
// key=value assignments (--step, --step-actual, --set-status)
// ---------------------------------------------------------------------------

type Assignment = { key: string; value: string };

/**
 * `--flag key=value`, repeatable.
 *
 * Deliberately **not** `parseSetFlags`: that one is about custom *properties*
 * and says so in its hint. These three flags address steps and runs, so a
 * property-flavoured error would point the user at the wrong lookup.
 */
function parseAssignments(values: string[] | undefined, flag: string, hint: string): Assignment[] {
  const assignments: Assignment[] = [];
  for (const raw of values ?? []) {
    const separator = raw.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(`${flag} expects key=value, got "${raw}"`, { hint });
    }
    assignments.push({ key: raw.slice(0, separator).trim(), value: raw.slice(separator + 1) });
  }
  return assignments;
}

const TEST_RUN_COLUMNS: Column<TestRun>[] = [
  { header: 'ID', value: (r) => r.short_id ?? r.id },
  { header: 'CASE', value: (r) => refName(r.case), flex: true },
  { header: 'STATUS', value: (r) => refName(r.latest_executed_status) || (r.status ?? '') },
  { header: 'EXECUTOR', value: (r) => refName(r.executor) },
  { header: 'REMARK', value: (r) => r.remark ?? '', flex: true },
];

type RunListFlags = PagingFlags &
  LibraryFlags &
  PlanFlags &
  StatusFlags &
  ExecutorFlags & {
    caseId?: string | undefined;
    keywords?: string | undefined;
  };

type RunCreateFlags = LibraryFlags &
  PlanFlags &
  ExecutorFlags & {
    case?: string | undefined;
    caseId?: string | undefined;
  };

type RunBulkCreateFlags = LibraryFlags &
  PlanFlags &
  ExecutorFlags & {
    case?: string[] | undefined;
    caseId?: string[] | undefined;
  };

type RunBulkUpdateFlags = LibraryFlags &
  StatusFlags &
  ExecutorFlags & {
    run?: string[] | undefined;
    runId?: string[] | undefined;
    file?: string | undefined;
    remark?: string | undefined;
  };

type RunPatchFlags = LibraryFlags &
  StatusFlags &
  ExecutorFlags & {
    remark?: string | undefined;
    step?: string[] | undefined;
    stepActual?: string[] | undefined;
  };

type RunBulkFlags = LibraryFlags &
  PlanFlags &
  ExecutorFlags & {
    addCase?: string[] | undefined;
    setStatus?: string[] | undefined;
    removeRun?: string[] | undefined;
  };

/** `inserts[]`, `updates[]` and `deletes[]` are each capped at 50 ([th#49]). */
const BULK_LIMIT = 50;

export function registerRunCommands(parent: Command): void {
  const group = parent
    .command('runs')
    .description(
      'test runs 执行用例 (scopes pcp:read:testhub:testplan / pcp:write:testhub:testplan)',
    )
    .addHelpText(
      'after',
      '\nThree batch verbs, and the naming difference between them is deliberate:\n' +
        '`bulk-create` adds cases, `bulk-update` records results, and plain `bulk` is the one\n' +
        'COMPOSITE call — inserts, updates and deletes in a single request, and the only way to\n' +
        'delete a run. It keeps the bare name because no create/update pair describes it.\n' +
        'Everywhere else in this CLI a batch leaf spells out what it does to each row.\n',
    );

  const list = addPagingOptions(
    group
      .command('list')
      .description(`search runs (POST /v1/testhub/runs/search) — ${RUN_LIBRARY_FILTER_CAVEAT}`)
      .option(
        '--case-id <id>',
        'filter by case id — a full id only. There is deliberately no `--case <ref>` twin ' +
          'here, unlike `runs create` / `runs bulk-create`: a short_id reaches the filter ' +
          'unresolved and the search answers 400 `100044`',
      )
      .option('--keywords <text>', 'fuzzy search over the case title'),
  );
  addPairOptions(list, 'library', `${LIBRARY_HELP}; used only to resolve the other names`);
  addPairOptions(list, 'plan', 'test plan; the only way to scope runs to a library');
  addPairOptions(list, 'status', 'run result 执行结果');
  addPairOptions(list, 'executor', 'executor 执行人, from the organisation directory');
  addGlobalOptions(list, { hidden: true }).action(
    async (flags: RunListFlags, command: Command) => {
      await runRunList(flags, command);
    },
  );

  const create = group
    .command('create')
    .description('add one case to a plan as a run (POST /v1/testhub/runs)')
    .option('--case <id|short_id>', 'the case to execute')
    .option('--case-id <id>', 'the case to execute, given as an id (no lookup)')
    .addHelpText(
      'after',
      '\nThe new run starts at 未测 / not_start and inherits the case\'s steps.\n' +
        'Adding a case the plan already contains is REFUSED (400 `100605`), not deduplicated —\n' +
        'so this is safe to retry only after checking `runs list --plan <p>`.\n' +
        'Without --executor the run is left UNASSIGNED; it is not defaulted to the creator.\n' +
        'For many cases at once use `runs bulk-create`, which reports per-case failures instead\n' +
        'of refusing the whole call.\n',
    );
  addPairOptions(create, 'library', LIBRARY_HELP);
  addPairOptions(create, 'plan', 'the test plan to add the run to');
  addPairOptions(create, 'executor', 'executor 执行人, from the organisation directory');
  addGlobalOptions(create, { hidden: true }).action(
    async (flags: RunCreateFlags, command: Command) => {
      await runRunCreate(flags, command);
    },
  );

  const patch = group
    .command('update')
    .description(
      'record a result on a run — always sends status_id, and re-sends the run\'s own executor ' +
        'unless you name another one',
    )
    .argument('<run>', `run id or short_id (${SHORT_ID_WRITE_CAVEAT})`)
    .option('--remark <text>', 'remark 备注 (replaces the old one)')
    .option(
      '--step <step_id=status>',
      'per-step result, repeatable. steps[] is a whole-array replacement, so every step of ' +
        'the run must be given one',
      collectValue,
    )
    .option('--step-actual <step_id=text>', 'per-step actual value 实际结果, repeatable', collectValue);
  addPairOptions(patch, 'library', `${LIBRARY_HELP} (defaults to the run's own library)`);
  addPairOptions(patch, 'status', 'new run result 执行结果; inherited from the run when omitted');
  addPairOptions(patch, 'executor', 'executor 执行人; inherited from the run when omitted');
  addGlobalOptions(patch, { hidden: true }).action(
    async (target: string, flags: RunPatchFlags, command: Command) => {
      await runRunPatch(target, flags, command);
    },
  );

  const bulkCreate = group
    .command('bulk-create')
    .description('add many cases to a plan as runs in one call (POST /v1/testhub/runs/bulk)')
    .option('--case <id|short_id>', 'case to add, repeatable', collectValue)
    .option('--case-id <id>', 'case to add, repeatable: an id, sent with no lookup', collectValue)
    .addHelpText(
      'after',
      '\nPER-ELEMENT BEST EFFORT, and that is the reason to prefer this over a loop of\n' +
        '`runs create`: the call answers HTTP 200 and reports one row per case, so a batch that\n' +
        'contains an already-added case still lands the rest and marks that one failure\n' +
        '("创建失败或已创建"). Read the STATE column, not the exit code.\n' +
        'Up to 100 cases per call. Each --case costs one read to resolve the reference; use\n' +
        '--case-id to skip it when you already hold ids.\n',
    );
  addPairOptions(bulkCreate, 'library', LIBRARY_HELP);
  addPairOptions(bulkCreate, 'plan', 'the test plan to add the runs to');
  addPairOptions(bulkCreate, 'executor', 'executor 执行人 applied to every added run');
  addGlobalOptions(bulkCreate, { hidden: true }).action(
    async (flags: RunBulkCreateFlags, command: Command) => {
      await runRunBulkCreate(flags, command);
    },
  );

  const bulkUpdate = group
    .command('bulk-update')
    .description('record results on many runs in one call, across plans and libraries')
    .option('--run <id|short_id>', 'run to update, repeatable', collectValue)
    .option('--run-id <id>', 'run to update, repeatable: an id, sent with no lookup', collectValue)
    .option('--file <path|->', 'JSON array of per-run entries, or - for stdin')
    .option('--remark <text>', 'remark 备注 applied to every named run (replaces)')
    .addHelpText(
      'after',
      '\nATOMIC — the opposite of `runs bulk-create`, and undocumented: one unknown run id\n' +
        'rejects the WHOLE batch (400 `100016` 存在无效run_id) and nothing is applied. Verified\n' +
        'live by reading the valid run back afterwards.\n' +
        'Two forms, mutually exclusive:\n' +
        '  · --run/--run-id (repeatable) plus --status, one result for all;\n' +
        '  · --file, when each run needs its own. Entry keys: run | run_id (one required),\n' +
        '    status | status_id (required), remark, executor | executor_id.\n' +
        'status_id is required on every entry — the API has no "remark only" mode here either.\n' +
        'An omitted executor preserves each run\'s current one. Every applied entry appends a\n' +
        'row to that run\'s history, so a bulk result stays auditable.\n' +
        'Steps are deliberately not settable here: a step array replaces wholesale and a step\n' +
        'sent without its status would be re-created. Use `runs update --step` per run.\n' +
        'Unlike `runs bulk`, this endpoint carries no plan or library in its URL, so it can span\n' +
        'plans — and it cannot delete anything.\n',
    );
  addPairOptions(bulkUpdate, 'library', `${LIBRARY_HELP} (needed to resolve a status by name)`);
  addPairOptions(bulkUpdate, 'status', 'run result 执行结果 applied to every named run');
  addPairOptions(bulkUpdate, 'executor', 'executor 执行人 applied to every named run');
  addGlobalOptions(bulkUpdate, { hidden: true }).action(
    async (flags: RunBulkUpdateFlags, command: Command) => {
      await runRunBulkUpdate(flags, command);
    },
  );

  const bulk = group
    .command('bulk')
    .description(
      'insert, update and delete the runs of one plan in a single call — the only way to ' +
        `delete a run. Each list is capped at ${BULK_LIMIT}, checked before the request`,
    )
    .option('--add-case <case_id>', 'add this case to the plan as a run, repeatable', collectValue)
    .option(
      '--set-status <run_id=status>',
      'record a result on an existing run, repeatable',
      collectValue,
    )
    .option('--remove-run <run_id>', 'delete this run, repeatable', collectValue);
  addPairOptions(bulk, 'library', LIBRARY_HELP);
  addPairOptions(bulk, 'plan', `test plan (${SHORT_ID_WRITE_CAVEAT})`);
  addPairOptions(bulk, 'executor', 'executor 执行人 applied to every added and updated run');
  addGlobalOptions(bulk, { hidden: true }).action(
    async (flags: RunBulkFlags, command: Command) => {
      await runRunBulk(flags, command);
    },
  );

  registerRunHistoryCommands(group);

  // `principal_type=test_run`, all four families live-verified 2026-08-03.
  //
  // **This is where design D5.2's list was wrong and live evidence corrected it**: it
  // named `testhub plans` as the fifth mount, but a test *plan* is not a principal in
  // any of the four families — `comments`/`attachments` reject it and `activities`
  // answers HTTP 500. A run is, so the mount moved here. Its relation matrix is also
  // the narrowest of the five: a run links to a work item and to nothing else.
  addCrosscutting(group, 'test_run', {
    resolveId: async (ctx, ref) => (await getRun(ctx, ref)).id,
  });
}

async function runRunList(flags: RunListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);

  const planPair = readPair('plan', flags.plan, flags.planId);
  const statusPair = readPair('status', flags.status, flags.statusId);
  const executorPair = readPair('executor', flags.executor, flags.executorId);

  const library = await resolveLibraryFlag(ctx, flags);
  // A name needs the library hop; a bare `--x-id` does not, so `runs list
  // --plan-id …` works with no library at all.
  const byName = (pair: PairInput | undefined): boolean =>
    pair !== undefined && 'byName' in pair;
  if ((byName(planPair) || byName(statusPair)) && library === undefined) {
    throw new UsageError('--library <name|id> is required to resolve a plan or status by name', {
      hint: 'plans and run statuses are library-scoped; pass --library, or use --plan-id / --status-id',
    });
  }
  const libraryId = library?.id;

  const plan = await resolvePair('testhub-plan', planPair, (input) =>
    resolveTestPlan(ctx, libraryId as string, input),
  );
  const status = await resolvePair('testhub-run-status', statusPair, (input) =>
    withConfigurationScope('run statuses', () =>
      resolveRunStatus(ctx, libraryId as string, input),
    ),
  );
  const executor = await resolvePair('user', executorPair, (input) => resolveUser(ctx, input));

  if (library !== undefined && plan === undefined) ctx.logger.warn(RUN_LIBRARY_FILTER_CAVEAT);

  const payload: SearchPayload = {
    filter: mergeFilters([
      refFilter('plan', plan?.id),
      // The run's own status id lives on `latest_executed_status`; the flat
      // `status` slug is not a filterable attribute (design §8).
      refFilter('latest_executed_status', status?.id),
      refFilter('executor', executor?.id),
      refFilter('case', flags.caseId?.trim()),
    ]),
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
  };

  if (paging.all) {
    const values = await collect(
      iterateRuns(ctx, payload, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, TEST_RUN_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await searchRuns(ctx, payload, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, TEST_RUN_COLUMNS, modeOf(ctx));
}

/**
 * `PATCH /v1/testhub/runs/{run_id}` is the module's sharpest edge (design §7).
 *
 * Three separate reasons force a read before the write, so it always happens:
 *
 *  1. **`short_id` is read-only** (GOTCHA #19) — the PATCH path needs a real id.
 *  2. **`status_id` is required even on PATCH** (GOTCHA #7). There is no
 *     "only change the remark" mode, so when the user names no status the run's
 *     current one is re-emitted. The id comes from `latest_executed_status`,
 *     which is the localized *object* carrying an id; the flat `status` slug
 *     cannot be turned into an id at all (there is no slug field on a run
 *     status).
 *  3. **The executor must be carried over by hand** — a PATCH body describes the
 *     whole result, so the run's own `executor_id` is re-sent when the user
 *     names none. It is omitted (with a stderr warning) only when the run has
 *     no executor at all: an omitted `executor_id` is a verified no-op on PATCH,
 *     but `PUT` blanks the field, so nothing here relies on omission (GOTCHA #8,
 *     design §7).
 *
 * If the pre-read fails the error is surfaced untouched — a 404/400 on the run
 * is reported as it arrives, and no PATCH is attempted.
 */
async function runRunPatch(
  target: string,
  flags: RunPatchFlags,
  command: Command,
): Promise<void> {
  const { ctx } = contextFor(command);

  const statusPair = readPair('status', flags.status, flags.statusId);
  const executorPair = readPair('executor', flags.executor, flags.executorId);
  const stepStatuses = parseAssignments(
    flags.step,
    '--step',
    'pass --step <step_id>=<status>; list the step ids with `pingcode testhub cases get <case>`',
  );
  const stepActuals = parseAssignments(
    flags.stepActual,
    '--step-actual',
    'pass --step-actual <step_id>=<text>',
  );

  const run = await getRun(ctx, requireFlag(target, '<run>'));

  const inheritedStatusId = refId(run.latest_executed_status);
  if (statusPair === undefined && inheritedStatusId === undefined) {
    throw new UsageError(
      `the run ${run.short_id ?? run.id} has no recorded result to inherit, so --status is required`,
      {
        hint:
          'PATCH /runs/{id} requires status_id even when you only want to change the remark. ' +
          'List the values with `pingcode testhub meta run-statuses --library <l>`',
      },
    );
  }

  const inheritedExecutorId = refId(run.executor);
  if (executorPair === undefined && inheritedExecutorId === undefined) {
    ctx.logger.warn(
      `the run ${run.short_id ?? run.id} has no executor, so executor_id is omitted from the ` +
        'PATCH and the run stays unassigned — pass --executor <name|id> to assign one',
    );
  }

  const steps = planStepReplacement(ctx, run, stepStatuses, stepActuals);

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<PatchRunInput>> => {
    const flagged = await resolveLibraryFlag(attemptCtx, flags);
    const libraryId = flagged?.id ?? refId(run.library);
    const needsLibrary =
      (statusPair !== undefined && 'byName' in statusPair) || steps?.needsResolution === true;
    if (needsLibrary && libraryId === undefined) {
      throw new UsageError(
        `the run ${run.short_id ?? run.id} did not report a library, so a status name cannot be resolved`,
        { hint: 'pass --library <name|id>, or use --status-id <id> to send an id unchanged' },
      );
    }

    const resolveStatus = async (input: string): Promise<ResolveResult> => {
      if (libraryId === undefined) {
        throw new UsageError('--library <name|id> is required to resolve a run status by name');
      }
      return await withConfigurationScope('run statuses', () =>
        resolveRunStatus(attemptCtx, libraryId, input),
      );
    };

    const status = await resolvePair('testhub-run-status', statusPair, resolveStatus);
    const executor = await resolvePair('user', executorPair, (input) =>
      resolveUser(attemptCtx, input),
    );

    const stepResolutions: ResolveResult[] = [];
    const stepInputs: RunStepInput[] = [];
    for (const step of steps?.steps ?? []) {
      const resolved = await resolvePair('testhub-run-status', { byName: step.status }, resolveStatus);
      if (resolved === undefined) continue;
      stepResolutions.push(resolved);
      stepInputs.push({
        step_id: step.stepId,
        status_id: resolved.id,
        ...(step.actual === undefined ? {} : { actual_value: step.actual }),
      });
    }

    // status_id is unconditional: this is the main point of the pre-read.
    // executor_id is sent whenever there is one to send, and omitted only when
    // the run is unassigned and the user named nobody (design §7).
    const executorId = executor?.id ?? inheritedExecutorId;
    const patch: PatchRunInput = {
      status_id: status?.id ?? (inheritedStatusId as string),
      ...(executorId === undefined ? {} : { executor_id: executorId }),
      ...(flags.remark === undefined ? {} : { remark: flags.remark }),
      ...(stepInputs.length === 0 ? {} : { steps: stepInputs }),
    };

    return {
      resolutions: present([flagged, status, executor, ...stepResolutions]),
      value: patch,
    };
  };

  const patched = await runWrite(ctx, resolve, (attemptCtx, patch) =>
    patchRun(attemptCtx, run.id, patch),
  );
  printRun(patched, ctx, 'updated');
}

type StepPlan = {
  steps: { stepId: string; status: string; actual: string | undefined }[];
  needsResolution: boolean;
};

/**
 * `steps[]` is a **whole-array replacement**, and a step that arrives without
 * its `step_id` is created fresh, orphaning every result recorded against the
 * old one (GOTCHA #9).
 *
 * A *partial* step edit therefore cannot be expressed safely, and this is the
 * one place the design's read-modify-write recipe does not close: re-emitting an
 * untouched step needs its `status_id`, but a run step only reports an English
 * `status` **slug** and a run status carries **no slug field** — the join exists
 * only through the localized name, which tenants may have changed (GOTCHA #10,
 * PRD open question 2). Rather than guess that mapping, the CLI refuses: every
 * step of the run must be given a status, and the replacement is echoed to
 * stderr before it is sent.
 */
function planStepReplacement(
  ctx: Ctx,
  run: TestRun,
  stepStatuses: Assignment[],
  stepActuals: Assignment[],
): StepPlan | undefined {
  if (stepStatuses.length === 0 && stepActuals.length === 0) return undefined;

  const existing = run.steps.map((step) => step.step_id).filter((id): id is string => id !== undefined);
  if (existing.length === 0) {
    throw new UsageError(
      `the run ${run.short_id ?? run.id} reports no steps, so --step / --step-actual cannot be used`,
      { hint: 'record the overall result with --status instead' },
    );
  }

  const statuses = new Map(stepStatuses.map((entry) => [entry.key, entry.value]));
  const actuals = new Map(stepActuals.map((entry) => [entry.key, entry.value]));

  const unknown = [...statuses.keys(), ...actuals.keys()].filter((id) => !existing.includes(id));
  if (unknown.length > 0) {
    throw new UsageError(
      `this run has no step(s) ${unknown.join(', ')}`,
      { hint: `its steps are: ${existing.join(', ')}` },
    );
  }

  const missing = existing.filter((id) => !statuses.has(id));
  if (missing.length > 0) {
    throw new UsageError(
      `steps[] replaces the whole array, so every step needs a status: ${missing.join(', ')} ${
        missing.length === 1 ? 'was' : 'were'
      } not given one`,
      {
        hint:
          `pass --step <step_id>=<status> for each of: ${existing.join(', ')}. ` +
          'A step sent without a status would be re-created with a new id and lose its history, ' +
          'and its current result cannot be re-sent: a run step reports a slug while a status ' +
          'write needs an id, and the two are only joined by the localized status name',
      },
    );
  }

  const steps = existing.map((stepId) => ({
    stepId,
    status: statuses.get(stepId) as string,
    actual: actuals.get(stepId),
  }));

  ctx.logger.warn(
    `replacing all ${steps.length} step(s) of run ${run.short_id ?? run.id}: ` +
      steps.map((step) => `${step.stepId}=${step.status}`).join(', '),
  );

  return { steps, needsResolution: true };
}

async function runRunBulk(flags: RunBulkFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const planPair = readPair('plan', flags.plan, flags.planId);
  const executorPair = readPair('executor', flags.executor, flags.executorId);
  const updates = parseAssignments(
    flags.setStatus,
    '--set-status',
    'pass --set-status <run_id>=<status>',
  );
  const inserts = (flags.addCase ?? []).map((value) => value.trim()).filter((value) => value !== '');
  const deletes = (flags.removeRun ?? [])
    .map((value) => value.trim())
    .filter((value) => value !== '');

  if (planPair === undefined) {
    throw new UsageError('--plan <name|id> is required', {
      hint: 'runs are bulk-edited per plan: the plan id is part of the URL',
    });
  }
  if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
    throw new UsageError('nothing to do: pass --add-case, --set-status or --remove-run', {
      hint: `each list is capped at ${BULK_LIMIT} entries`,
    });
  }

  // The cap is checked here, before anything is sent (design §7, PRD R4).
  for (const [label, count] of [
    ['--add-case', inserts.length],
    ['--set-status', updates.length],
    ['--remove-run', deletes.length],
  ] as const) {
    if (count > BULK_LIMIT) {
      throw new UsageError(
        `${label} was given ${count} entries, but the API accepts at most ${BULK_LIMIT} per call`,
        { hint: `split the work into batches of ${BULK_LIMIT} or fewer` },
      );
    }
  }

  const library = await requireLibraryFlag(ctx, flags);

  // Resolved even when it looks like an id: the bulk URL needs a real plan id,
  // and reads accept a short_id that this write would reject (GOTCHA #19).
  const plan = await resolvePair('testhub-plan', planPair, (input) =>
    resolveTestPlan(ctx, library.id, input),
  );
  if (plan === undefined) throw new UsageError('--plan <name|id> is required');

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<BulkRunsInput>> => {
    const executor = await resolvePair('user', executorPair, (input) =>
      resolveUser(attemptCtx, input),
    );

    const statusResolutions: ResolveResult[] = [];
    const updateInputs: BulkRunUpdate[] = [];
    for (const update of updates) {
      const status = await withConfigurationScope('run statuses', () =>
        resolveRunStatus(attemptCtx, library.id, update.value),
      );
      statusResolutions.push(status);
      updateInputs.push({
        run_id: update.key,
        status_id: status.id,
        ...(executor === undefined ? {} : { executor_id: executor.id }),
      });
    }

    const insertInputs: BulkRunInsert[] = inserts.map((caseId) => ({
      case_id: caseId,
      ...(executor === undefined ? {} : { executor_id: executor.id }),
    }));

    const input: BulkRunsInput = {
      ...(insertInputs.length === 0 ? {} : { inserts: insertInputs }),
      ...(updateInputs.length === 0 ? {} : { updates: updateInputs }),
      ...(deletes.length === 0 ? {} : { deletes }),
    };

    return { resolutions: present([executor, ...statusResolutions]), value: input };
  };

  const result = await runWrite(ctx, resolve, (attemptCtx, input) =>
    bulkRuns(attemptCtx, library.id, plan.id, input),
  );

  const mode = modeOf(ctx);
  printResource(
    result,
    [
      ['inserted', String(result.inserts ?? 0)],
      ['updated', String(result.updates ?? 0)],
      ['deleted', String(result.deletes ?? 0)],
    ],
    mode,
  );
  if (!mode.json) {
    // The response carries counts only — never the ids of the runs it created.
    errLine(paint.dim('the API returns counts only: re-list the plan to see the new run ids'));
  }
}

function printRun(run: TestRun, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    run,
    [
      ['id', run.id],
      ['short id', run.short_id ?? ''],
      ['library', refName(run.library)],
      ['plan', run.plan === undefined ? '' : (run.plan.name ?? run.plan.id)],
      ['case', refName(run.case)],
      ['module', refName(run.suite)],
      ['status', refName(run.latest_executed_status) || (run.status ?? '')],
      ['executor', refName(run.executor)],
      ['steps', String(run.steps.length)],
      ['created', timestampCell(run.created_at)],
      ['updated', timestampCell(run.updated_at)],
      ['url', run.html_url ?? run.url ?? ''],
      ['remark', run.remark ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${run.short_id ?? run.id}`));
  }
}

// ---------------------------------------------------------------------------
// create / bulk-create / bulk-update
// ---------------------------------------------------------------------------

const RUN_BULK_COLUMNS: Column<TestRunBulkItem>[] = [
  { header: 'STATE', value: (row) => row.state ?? '' },
  { header: 'RUN', value: (row) => row.run?.short_id ?? row.run?.id ?? '' },
  { header: 'CASE', value: (row) => refName(row.run?.case), flex: true },
  { header: 'STATUS', value: (row) => refName(row.run?.latest_executed_status) || (row.run?.status ?? '') },
  { header: 'EXECUTOR', value: (row) => refName(row.run?.executor) },
  { header: 'MESSAGE', value: (row) => row.message ?? '', flex: true },
];

/**
 * `POST /v1/testhub/runs` — three ids, so no `--file` form and nothing to merge.
 *
 * The case reference is resolved through a read because a `short_id` is a legitimate
 * thing to hold and the write takes ids only; `--case-id` skips it.
 */
async function runRunCreate(flags: RunCreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const planPair = readPair('plan', flags.plan, flags.planId);
  const executorPair = readPair('executor', flags.executor, flags.executorId);
  const casePair = readPair('case', flags.case, flags.caseId);
  if (planPair === undefined) {
    throw new UsageError('--plan <name|id> is required', {
      hint: 'a run is a case inside a plan — list the plans with `pingcode testhub plans list --library <l>`',
    });
  }
  if (casePair === undefined) {
    throw new UsageError('--case <id|short_id> is required', {
      hint: 'list the cases of the library with `pingcode testhub cases list --library <l>`',
    });
  }

  const library = await requireLibraryFlag(ctx, flags);
  const plan = await resolvePair('testhub-plan', planPair, (input) =>
    resolveTestPlan(ctx, library.id, input),
  );
  if (plan === undefined) throw new UsageError('--plan <name|id> is required');
  const caseId = await resolveCaseRef(ctx, casePair);

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<CreateRunInput>> => {
    const executor = await resolvePair('user', executorPair, (input) =>
      resolveUser(attemptCtx, input),
    );
    const input: CreateRunInput = {
      library_id: library.id,
      plan_id: plan.id,
      case_id: caseId,
      ...(executor === undefined ? {} : { executor_id: executor.id }),
    };
    return { resolutions: present([library, plan, executor]), value: input };
  };

  const run = await runWrite(ctx, resolve, (attemptCtx, input) => createRun(attemptCtx, input));
  printRun(run, ctx, 'created');
}

async function runRunBulkCreate(flags: RunBulkCreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const planPair = readPair('plan', flags.plan, flags.planId);
  const executorPair = readPair('executor', flags.executor, flags.executorId);
  const refs = (flags.case ?? []).map((value) => value.trim()).filter((value) => value !== '');
  const ids = (flags.caseId ?? []).map((value) => value.trim()).filter((value) => value !== '');

  if (planPair === undefined) {
    throw new UsageError('--plan <name|id> is required', {
      hint: 'runs are created inside one plan: pass --plan once for the whole batch',
    });
  }
  if (refs.length === 0 && ids.length === 0) {
    throw new UsageError('nothing to add: pass --case <ref> or --case-id <id>', {
      hint: `both are repeatable, up to ${100} cases per call`,
    });
  }
  checkBulkLimit(refs.length + ids.length, 'cases');

  const library = await requireLibraryFlag(ctx, flags);
  const plan = await resolvePair('testhub-plan', planPair, (input) =>
    resolveTestPlan(ctx, library.id, input),
  );
  if (plan === undefined) throw new UsageError('--plan <name|id> is required');

  // Outside the retry: each reference costs a read, and a cache-invalidation retry
  // must not repeat them (nothing here comes from the metadata cache anyway).
  const caseIds = [...ids];
  for (const ref of refs) caseIds.push((await getRunCaseId(ctx, ref)));

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<CreateRunInput[]>> => {
    const executor = await resolvePair('user', executorPair, (input) =>
      resolveUser(attemptCtx, input),
    );
    const runs: CreateRunInput[] = caseIds.map((caseId) => ({
      library_id: library.id,
      plan_id: plan.id,
      case_id: caseId,
      ...(executor === undefined ? {} : { executor_id: executor.id }),
    }));
    return { resolutions: present([library, plan, executor]), value: runs };
  };

  const items = await runWrite(ctx, resolve, (attemptCtx, runs) =>
    bulkCreateRuns(attemptCtx, { runs }),
  );
  printRunBulkItems(items, ctx, 'created');
}

/**
 * `PATCH /v1/testhub/runs/bulk` — **atomic**, unlike its `POST` sibling.
 *
 * Every entry needs a `status_id`, so the shared `--status` is required in the
 * `--run` form and each entry must carry one in the `--file` form. That is the
 * endpoint's rule, not a CLI choice: an entry without it answers `100008`.
 */
async function runRunBulkUpdate(flags: RunBulkUpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const refs = (flags.run ?? []).map((value) => value.trim()).filter((value) => value !== '');
  const ids = (flags.runId ?? []).map((value) => value.trim()).filter((value) => value !== '');
  const usesFile = (flags.file?.trim() ?? '') !== '';

  const statusPair = readPair('status', flags.status, flags.statusId);
  const executorPair = readPair('executor', flags.executor, flags.executorId);

  if (usesFile && (refs.length > 0 || ids.length > 0)) {
    throw new UsageError('--file cannot be combined with --run / --run-id', {
      hint: 'use --file when each run needs its own result, or --run with a shared --status',
    });
  }
  if (usesFile && (statusPair !== undefined || flags.remark !== undefined)) {
    throw new UsageError('--file carries its own status and remark, so those flags are refused', {
      hint: 'put status / status_id and remark in the entries, or drop --file',
    });
  }
  if (!usesFile) {
    if (refs.length === 0 && ids.length === 0) {
      throw new UsageError('nothing to update: pass --run <ref> … or --file <path|->');
    }
    if (statusPair === undefined) {
      throw new UsageError('--status <name|id> is required', {
        hint:
          'every entry of this endpoint needs a status_id — there is no remark-only mode. ' +
          'List the values with `pingcode testhub meta run-statuses --library <l>`',
      });
    }
  }

  const entries = usesFile
    ? await readEntryFile(
        flags,
        RUN_BULK_UPDATE_SCHEMA,
        'pass a JSON array of run entries, or - to read it from stdin. Each entry needs run or ' +
          'run_id and a status or status_id',
      )
    : [];
  checkBulkLimit(usesFile ? entries.length : refs.length + ids.length, 'runs');

  // Run ids first, outside the retry: the write is id-only and a short_id needs a read.
  const runIds = new Map<string, string>();
  for (const ref of refs) runIds.set(ref, (await getRun(ctx, ref)).id);
  for (const id of ids) runIds.set(id, id);
  for (const entry of entries) {
    const byId = optionalEntryString(entry, 'run_id');
    const byRef = optionalEntryString(entry, 'run');
    if (byId !== undefined && byRef !== undefined) {
      throw new UsageError(`${entry.at} sets both run and run_id`, {
        hint: 'use run for an id or short_id to resolve, or run_id for an id sent unchanged',
      });
    }
    if (byId !== undefined) {
      runIds.set(entry.at, byId);
      continue;
    }
    if (byRef === undefined) {
      throw new UsageError(`${entry.at} names no run`, {
        hint: 'give the entry a run (id or short_id) or a run_id',
      });
    }
    runIds.set(entry.at, (await getRun(ctx, byRef)).id);
  }

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<BulkUpdateRunEntry[]>> => {
    const flagged = await resolveLibraryFlag(attemptCtx, flags);
    const resolutions: ResolveResult[] = present([flagged]);
    const libraryId = flagged?.id;

    const resolveStatusName = async (input: string): Promise<string> => {
      if (libraryId === undefined) {
        throw new UsageError('--library <name|id> is required to resolve a run status by name', {
          hint: 'run statuses are library-scoped; pass --library, or use --status-id / status_id',
        });
      }
      const resolved = await withConfigurationScope('run statuses', () =>
        resolveRunStatus(attemptCtx, libraryId, input),
      );
      resolutions.push(resolved);
      return resolved.id;
    };

    const executor = await resolvePair('user', executorPair, (input) =>
      resolveUser(attemptCtx, input),
    );
    if (executor !== undefined) resolutions.push(executor);

    if (!usesFile) {
      const statusId =
        statusPair === undefined
          ? undefined
          : 'byId' in statusPair
            ? statusPair.byId
            : await resolveStatusName(statusPair.byName);
      const rows: BulkUpdateRunEntry[] = [...refs, ...ids].map((key) => ({
        run_id: runIds.get(key) as string,
        status_id: statusId as string,
        ...(flags.remark === undefined ? {} : { remark: flags.remark }),
        ...(executor === undefined ? {} : { executor_id: executor.id }),
      }));
      return { resolutions, value: rows };
    }

    const rows: BulkUpdateRunEntry[] = [];
    for (const entry of entries) {
      const statusEntry = entryPair(entry, 'status');
      if (statusEntry === undefined) {
        throw new UsageError(`${entry.at} names no status`, {
          hint: 'status_id is required on every entry of this endpoint — there is no remark-only mode',
        });
      }
      const statusId =
        'byId' in statusEntry ? statusEntry.byId : await resolveStatusName(statusEntry.byName);
      const entryExecutor = await resolveEntryExecutor(attemptCtx, entry, resolutions);
      const remark = optionalEntryString(entry, 'remark');
      rows.push({
        run_id: runIds.get(entry.at) as string,
        status_id: statusId,
        ...(remark === undefined ? {} : { remark }),
        ...(entryExecutor === undefined
          ? executor === undefined
            ? {}
            : { executor_id: executor.id }
          : { executor_id: entryExecutor }),
      });
    }
    return { resolutions, value: rows };
  };

  const items = await runWrite(ctx, resolve, (attemptCtx, runs) =>
    bulkUpdateRuns(attemptCtx, { runs }),
  );
  printRunBulkItems(items, ctx, 'updated');
}

const RUN_BULK_UPDATE_SCHEMA = {
  wrapperKey: 'runs',
  allowed: ['run', 'run_id', 'status', 'status_id', 'remark', 'executor', 'executor_id'],
  refused: {
    steps:
      'a step array replaces wholesale and a step sent without its status would be re-created, ' +
      'orphaning its results — record steps one run at a time with `testhub runs update --step`',
  },
} as const;

async function resolveEntryExecutor(
  ctx: Ctx,
  entry: RawEntry,
  resolutions: ResolveResult[],
): Promise<string | undefined> {
  const pair = entryPair(entry, 'executor');
  if (pair === undefined) return undefined;
  if ('byId' in pair) return pair.byId;
  const resolved = await resolveUser(ctx, pair.byName);
  resolutions.push(resolved);
  return resolved.id;
}

/** A `--case` reference for a run write: `short_id` is accepted on the read, not the write. */
async function resolveCaseRef(ctx: Ctx, pair: PairInput): Promise<string> {
  if ('byId' in pair) return pair.byId;
  return await getRunCaseId(ctx, pair.byName);
}

/**
 * A case reference → a real case id.
 *
 * `getCase` comes from the api layer rather than from `cases.ts`: the two resource
 * files must not reach into each other, and a case read is one wrapper call.
 */
async function getRunCaseId(ctx: Ctx, ref: string): Promise<string> {
  return (await getCase(ctx, ref)).id;
}

function printRunBulkItems(items: TestRunBulkItem[], ctx: Ctx, verb: string): void {
  const mode = modeOf(ctx);
  printCollection(items, RUN_BULK_COLUMNS, mode);
  if (mode.json) return;
  const failed = items.filter((item) => item.state !== undefined && item.state !== 'success');
  if (failed.length > 0) {
    errLine(
      paint.yellow(
        `${failed.length} of ${items.length} entries failed — read the STATE and MESSAGE columns`,
      ),
    );
    return;
  }
  errLine(paint.green(`${verb} ${items.length} run(s)`));
}

// ---------------------------------------------------------------------------
// history: every result ever recorded on one run
// ---------------------------------------------------------------------------

const RUN_HISTORY_COLUMNS: Column<TestRunHistoryItem>[] = [
  { header: 'ID', value: (row) => row.id },
  { header: 'WHEN', value: (row) => timestampCell(row.executed_at) },
  { header: 'RESULT', value: (row) => refName(row.executed_status) || (row.status ?? '') },
  { header: 'BY', value: (row) => refName(row.executed_by) },
  { header: 'STEPS', value: (row) => String(row.steps.length) },
  { header: 'REMARK', value: (row) => row.remark ?? '', flex: true },
];

/**
 * `runs history …` — the audit trail of one run, oldest first.
 *
 * This is the half a test report was missing: `runs list` shows only the latest
 * result, while every `runs update` and every applied `runs bulk-update` entry appends
 * a row here.
 */
function registerRunHistoryCommands(parent: Command): void {
  const group = parent
    .command('history')
    .description('执行历史 every result ever recorded on one run (read-only)');

  group.addHelpText(
    'after',
    '\nOldest first, one row per recorded result — `runs list` shows only the latest. A\n' +
      '`runs update` and every applied `runs bulk-update` entry both append a row, so a bulk\n' +
      'result is auditable (unlike a pjm bulk update, which appears in no feed).\n' +
      'For the latest result of every run of one CASE, use `testhub cases history list <case>`.\n' +
      'A history id belonging to a different run is refused as a mismatch (400 `100643`), not\n' +
      'reported as missing.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list every result recorded on a run')
        .argument('<run>', 'run id or short_id'),
    ),
    { hidden: true },
  ).action(async (target: string, flags: PagingFlags, command: Command) => {
    const { ctx } = contextFor(command);
    // The histories path is id-only (a short_id answers 404), so the reference goes
    // through the run read that does accept one.
    const run = await getRun(ctx, requireFlag(target, '<run>'));
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateRunHistories(ctx, run.id, { pageSize: paging.pageSize, limit: paging.limit }),
      );
      printCollection(values, RUN_HISTORY_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listRunHistories(ctx, run.id, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, RUN_HISTORY_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one recorded result')
      .argument('<run>', 'run id or short_id')
      .argument('<history-id>', 'result record id, as printed by list'),
    { hidden: true },
  ).action(async (target: string, historyId: string, _flags: unknown, command: Command) => {
    const { ctx } = contextFor(command);
    const run = await getRun(ctx, requireFlag(target, '<run>'));
    const row = await getRunHistory(ctx, run.id, requireFlag(historyId, '<history-id>'));

    printResource(
      row,
      [
        ['id', row.id],
        // A history's `run` and `case` refs carry no `name` — the run has a `short_id`
        // and the case an `identifier` — so `refName` alone would print bare ids.
        ['run', refLabel(row.run, 'short_id')],
        ['case', refLabel(row.case, 'identifier')],
        ['plan', row.plan === undefined ? '' : (row.plan.name ?? row.plan.id)],
        ['library', refName(row.library)],
        ['result', refName(row.executed_status) || (row.status ?? '')],
        ['by', refName(row.executed_by)],
        ['when', timestampCell(row.executed_at)],
        ['steps', String(row.steps.length)],
        ['remark', row.remark ?? ''],
      ],
      modeOf(ctx),
    );
  });
}

/**
 * A `Ref`'s most human key, falling back to the id.
 *
 * `refName` is right for the many refs that carry a `name`, but a history's `run` and
 * `case` do not: they carry `short_id` and `identifier`. `Ref`'s extra keys are typed
 * `unknown`, so the read is narrowed here rather than asserted.
 */
function refLabel(
  ref: { id: string; name?: string | undefined; [key: string]: unknown } | undefined,
  key: 'short_id' | 'identifier',
): string {
  if (ref === undefined) return '';
  const value = ref[key];
  if (typeof value === 'string' && value !== '') return value;
  return refName(ref);
}
