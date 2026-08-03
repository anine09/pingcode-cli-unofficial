import { Option, type Command } from 'commander';
import {
  bulkRuns,
  caseStates,
  caseTypes,
  createCase,
  createLibrary,
  createPlan,
  getCase,
  getLibrary,
  getPlan,
  getRun,
  importantLevels,
  iterateCases,
  iterateLibraries,
  iteratePlans,
  iterateRuns,
  iterateSuites,
  listLibraries,
  listPlans,
  patchRun,
  planTypes,
  runStatuses,
  searchCases,
  searchRuns,
  updateCase,
  type BulkRunInsert,
  type BulkRunUpdate,
  type BulkRunsInput,
  type CreateCaseInput,
  type CreateLibraryInput,
  type CreatePlanInput,
  type LibraryListQuery,
  type PatchRunInput,
  type PlanListQuery,
  type RunStepInput,
  type UpdateCaseInput,
} from '../../api/testhub';
import type { Ctx } from '../../core/context';
import { PermissionError, UsageError } from '../../core/errors';
import {
  resolveCaseImportantLevel,
  resolveCaseState,
  resolveCaseType,
  resolveRunStatus,
  resolveTestLibrary,
  resolveTestPlan,
  resolveTestPlanType,
  resolveTestSuite,
  resolveUser,
  SUITE_PATH_SEPARATOR,
  type MetaKind,
  type ResolveResult,
} from '../../core/metadata';
import { collect, type SearchPayload } from '../../core/paginate';
import type {
  TestCase,
  TestCaseImportantLevel,
  TestCaseState,
  TestCaseType,
  TestLibrary,
  TestPlan,
  TestPlanType,
  TestRun,
  TestSuite,
  TestRunStatus,
} from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import { addCrosscutting } from './_shared/crosscutting';
import {
  addPagingOptions,
  collectValue,
  contextFor,
  mergeFilters,
  modeOf,
  parseDateBoundaryFlag,
  parseSetFlags,
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
} from './common';

/**
 * `pingcode testhub …` — the 测试管理 module, mirroring the GUI's grouping and
 * the shape `product` already established: the parent resource first, then the
 * resources that hang off it, then the id lookups every write needs.
 *
 * Five facts from `design.md` shape this whole file:
 *
 *  - **A library is the bootstrap hop.** `state_id`, `type_id`, `status_id`, the
 *    suite tree and the plan list are all library-scoped (design §5), so
 *    `--library <name|id>` is resolved *once* at the top of an action and the
 *    resolved id is handed down to every other resolver. The one exception is
 *    importance levels, which are genuinely org-level and take no library.
 *  - **Search is the read path.** `cases list` and `runs list` are
 *    `POST …/search`; the plain `GET /v1/testhub/{cases,runs}` lists are never
 *    called (design §2).
 *  - **Writes take `*_id`, reads return objects.** Every name-resolvable field
 *    is a `--x` / `--x-id` pair: `--x` resolves, `--x-id` is sent verbatim, and
 *    the two are mutually exclusive (design §6).
 *  - **`PATCH /runs/{id}` is a read-modify-write.** `status_id` is required even
 *    on PATCH, and the executor has to be carried over by hand (GOTCHA #7/#8).
 *    `runs patch` therefore always reads the run first, always sends
 *    `status_id`, and re-sends the run's executor unless the run has none
 *    (design §7).
 *  - **Arrays replace, they never merge.** `steps[]` and `properties` overwrite
 *    wholesale, and a step that arrives without its `step_id` is re-created with
 *    a new one, orphaning its history (GOTCHA #9). Nothing here synthesises a
 *    step: a partial step edit is refused with the full list of steps rather
 *    than guessed at.
 *
 * Deliberately not exposed in this slice: case deletion (irreversible, no
 * undelete), plan create/update, run create (`runs bulk --add-case` covers it
 * and is the only way to *delete* a run), every configuration write, the history
 * reads, and `PUT /runs/{id}` — documented to blank the executor when the field
 * is omitted, a claim never disproved and never worth testing in anger.
 */

// ---------------------------------------------------------------------------
// scopes and shared help text
// ---------------------------------------------------------------------------

const CONFIGURATION_SCOPE = 'pcp:read:testhub:configuration';

const LIBRARY_HELP = 'test library name, identifier such as LIB, or id';

const SET_HELP =
  'custom case property, repeatable: --set key=value. Keys are raw property keys and values for ' +
  'select-typed properties are option ids, not labels. Replaces, never merges';

/**
 * The hint `parseSetFlags` prints on a malformed `--set`.
 *
 * Ship points at `product meta {idea,ticket}-properties`; testhub has no property
 * lookup leaf in this milestone (`GET /v1/testhub/case/properties` is outside the
 * endpoint set), so pointing anywhere would name a command that does not exist.
 * The honest answer is: read the keys off a case you already have.
 */
const SET_HINT =
  'pass --set <key>=<value>. testhub has no property-lookup command in this milestone: read the ' +
  'keys off an existing case with `pingcode testhub cases get <case> --json`';

const SHORT_ID_WRITE_CAVEAT =
  'a short_id is accepted on reads but rejected by every write, so this is resolved to a real id first';

const RUN_LIBRARY_FILTER_CAVEAT =
  'run search cannot filter by library.id — it is on the API exclusion list, so scope runs with --plan instead';

/**
 * The two accepted `--start` / `--end` forms. The end-of-day asymmetry is spelled
 * out per flag at the call site, because it is the surprising half: a plan runs
 * *through* its end date, so `--end` is 23:59:59 rather than midnight.
 */
const DATE_FLAG_HELP = 'YYYY-MM-DD, or a 10-digit unix seconds value used verbatim';

// ---------------------------------------------------------------------------
// flag pairs: --x resolves by name, --x-id is sent verbatim (design §6)
// ---------------------------------------------------------------------------

type LibraryFlags = { library?: string | undefined; libraryId?: string | undefined };
type SuiteFlags = { suite?: string | undefined; suiteId?: string | undefined };
type StateFlags = { state?: string | undefined; stateId?: string | undefined };
type TypeFlags = { type?: string | undefined; typeId?: string | undefined };
type LevelFlags = {
  importantLevel?: string | undefined;
  importantLevelId?: string | undefined;
};
type StatusFlags = { status?: string | undefined; statusId?: string | undefined };
type ExecutorFlags = { executor?: string | undefined; executorId?: string | undefined };
type PlanFlags = { plan?: string | undefined; planId?: string | undefined };
/**
 * 负责人 on a plan. A separate pair from `--executor` (执行人 on a run) even
 * though both resolve through the org directory: they are different fields on
 * different resources, and merging them would let a `plans create` typo silently
 * read a run flag.
 */
type AssigneeFlags = { assignee?: string | undefined; assigneeId?: string | undefined };

/**
 * Declare a `--x` / `--x-id` pair.
 *
 * Same contract as ship's `addShipStateOptions`, generalised because testhub has
 * seven of these rather than one: the name variant triggers a lookup, the id
 * variant is passed through untouched, and no id is ever shape-validated —
 * testhub ids are 24-hex, `short_id`s are 8-char base62 and users are 32-hex.
 */
function addPairOptions(command: Command, flag: string, description: string): Command {
  return command
    .option(`--${flag} <name|id>`, description)
    .option(`--${flag}-id <id>`, `${description} (an id, sent unchanged with no lookup)`);
}

type PairInput = { byId: string } | { byName: string };

/** Reject `--x` together with `--x-id` before anything is sent (exit 2). */
function readPair(
  flag: string,
  name: string | undefined,
  id: string | undefined,
): PairInput | undefined {
  const byName = name?.trim() ?? '';
  const byId = id?.trim() ?? '';

  if (byName !== '' && byId !== '') {
    throw new UsageError(`--${flag} and --${flag}-id are mutually exclusive`, {
      hint: `use --${flag} <name> to resolve by name, or --${flag}-id <id> to send an id unchanged`,
    });
  }
  if (byId !== '') return { byId };
  if (byName !== '') return { byName };
  return undefined;
}

function passThrough(kind: MetaKind, id: string): ResolveResult {
  // No lookup, no shape check, and no cache key — so nothing to invalidate later.
  return { kind, input: id, id, name: undefined, fromCache: false, cacheKey: null };
}

async function resolvePair(
  kind: MetaKind,
  pair: PairInput | undefined,
  resolve: (input: string) => Promise<ResolveResult>,
): Promise<ResolveResult | undefined> {
  if (pair === undefined) return undefined;
  if ('byId' in pair) return passThrough(kind, pair.byId);
  return await resolve(pair.byName);
}

function present(resolutions: (ResolveResult | undefined)[]): ResolveResult[] {
  return resolutions.filter((resolution): resolution is ResolveResult => resolution !== undefined);
}

// ---------------------------------------------------------------------------
// the library hop
// ---------------------------------------------------------------------------

async function resolveLibraryFlag(
  ctx: Ctx,
  flags: LibraryFlags,
): Promise<ResolveResult | undefined> {
  return await resolvePair(
    'testhub-library',
    readPair('library', flags.library, flags.libraryId),
    (input) => resolveTestLibrary(ctx, input),
  );
}

/** Every library-scoped command starts here: no library id, no lookups at all. */
async function requireLibraryFlag(ctx: Ctx, flags: LibraryFlags): Promise<ResolveResult> {
  const library = await resolveLibraryFlag(ctx, flags);
  if (library === undefined) {
    throw new UsageError('--library <name|id> is required', {
      hint:
        'nothing in testhub is reachable without a library id: states, types, statuses, modules ' +
        'and plans are all library-scoped. List them with `pingcode testhub libraries list`',
    });
  }
  return library;
}

/**
 * The **configuration-scope trap** (design §9, GOTCHA #2).
 *
 * `case/states` and `run/statuses` need `pcp:read:testhub:configuration`, while
 * their sibling `case/types` needs only `…:testcase`. A token granted
 * `testcase` + `testplan` gets a *bare* 403 from those two — and since they are
 * the only source of a `state_id` or a `status_id`, that token cannot perform
 * any run write at all. The server never says so, so we do.
 *
 * The error class is unchanged (`PermissionError`, exit 4): only the message and
 * hint are enriched, and the vendor `code`/`status` are carried through.
 */
async function withConfigurationScope<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof PermissionError)) throw error;
    throw new PermissionError(
      `${error.message} — reading ${what} requires the ${CONFIGURATION_SCOPE} scope`,
      {
        hint:
          `grant ${CONFIGURATION_SCOPE} to this application in the PingCode console. ` +
          'A token with only pcp:read:testhub:testcase + pcp:read:testhub:testplan can list ' +
          'cases, plans and runs but cannot resolve a state_id or a status_id, which makes ' +
          'every run write impossible',
        code: error.code,
        status: error.status,
        cause: error,
      },
    );
  }
}

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

// ---------------------------------------------------------------------------
// columns (design §10)
// ---------------------------------------------------------------------------

const TEST_LIBRARY_COLUMNS: Column<TestLibrary>[] = [
  { header: 'IDENTIFIER', value: (l) => l.identifier ?? '' },
  { header: 'NAME', value: (l) => l.name ?? '', flex: true },
  { header: 'VISIBILITY', value: (l) => l.visibility ?? '' },
  { header: 'MEMBERS', value: (l) => String(l.members.length) },
  { header: 'ID', value: (l) => l.id },
];

const TEST_CASE_COLUMNS: Column<TestCase>[] = [
  { header: 'IDENTIFIER', value: (c) => c.identifier ?? c.short_id ?? c.id },
  { header: 'TITLE', value: (c) => c.title ?? '', flex: true },
  { header: 'STATE', value: (c) => refName(c.state) },
  { header: 'TYPE', value: (c) => refName(c.type) },
  { header: 'LEVEL', value: (c) => refName(c.important_level) || (c.level ?? '') },
  { header: 'MODULE', value: (c) => refName(c.suite), flex: true },
];

const TEST_PLAN_COLUMNS: Column<TestPlan>[] = [
  { header: 'ID', value: (p) => p.short_id ?? p.id },
  { header: 'NAME', value: (p) => p.name ?? '', flex: true },
  { header: 'TYPE', value: (p) => refName(p.type) },
  { header: 'STATE', value: (p) => refName(p.state) },
  { header: 'START', value: (p) => timestampCell(p.start_at) },
  { header: 'END', value: (p) => timestampCell(p.end_at) },
];

const TEST_RUN_COLUMNS: Column<TestRun>[] = [
  { header: 'ID', value: (r) => r.short_id ?? r.id },
  { header: 'CASE', value: (r) => refName(r.case), flex: true },
  { header: 'STATUS', value: (r) => refName(r.latest_executed_status) || (r.status ?? '') },
  { header: 'EXECUTOR', value: (r) => refName(r.executor) },
  { header: 'REMARK', value: (r) => r.remark ?? '', flex: true },
];

const CASE_STATE_COLUMNS: Column<TestCaseState>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
  { header: 'GROUP', value: (s) => s.type ?? '' },
];

const CASE_TYPE_COLUMNS: Column<TestCaseType>[] = [
  { header: 'ID', value: (t) => t.id },
  { header: 'NAME', value: (t) => t.name ?? '', flex: true },
];

const IMPORTANT_LEVEL_COLUMNS: Column<TestCaseImportantLevel>[] = [
  { header: 'ID', value: (l) => l.id },
  { header: 'NAME', value: (l) => l.name ?? '', flex: true },
  { header: 'COLOR', value: (l) => l.color ?? '' },
];

const RUN_STATUS_COLUMNS: Column<TestRunStatus>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
  { header: 'SYSTEM', value: (s) => (s.is_system === undefined ? '' : s.is_system ? 'yes' : 'no') },
];

const PLAN_TYPE_COLUMNS: Column<TestPlanType>[] = [
  { header: 'ID', value: (t) => t.id },
  { header: 'NAME', value: (t) => t.name ?? '', flex: true },
];

/**
 * A suite row plus the path the resolver will accept for it.
 *
 * The path is **computed**, never the server's `paths` field: verified live in
 * `f74ecd2`, `paths` is the parent chain *excluding* the node itself (`""` at a
 * root), so printing it raw would label every child with its parent's path.
 */
type SuiteRow = TestSuite & { computed_path: string };

/** `meta suites` takes the library pair plus the server-side subtree filter. */
type SuiteListFlags = LibraryFlags & { parentId?: string | undefined };

const SUITE_COLUMNS: Column<SuiteRow>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
  { header: 'PATH', value: (s) => s.computed_path, flex: true },
  { header: 'PARENT', value: (s) => refName(s.parent) },
];

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerTesthubCommands(program: Command): void {
  const testhub = program
    .command('testhub')
    .description(
      '测试管理 testhub: libraries 测试库, cases 用例, plans 测试计划, runs 执行用例 ' +
        '(scopes pcp:read:testhub:testcase / :testplan / :configuration)',
    );

  registerLibraryCommands(testhub);
  registerCaseCommands(testhub);
  registerPlanCommands(testhub);
  registerRunCommands(testhub);
  registerTesthubMetaCommands(testhub);
}

// ---------------------------------------------------------------------------
// testhub libraries
// ---------------------------------------------------------------------------

type LibraryListFlags = PagingFlags & {
  keywords?: string | undefined;
  includeArchived?: boolean | undefined;
  includeDeleted?: boolean | undefined;
};

type LibraryGetFlags = {
  includeArchived?: boolean | undefined;
  includeDeleted?: boolean | undefined;
};

type LibraryCreateFlags = {
  name: string;
  identifier: string;
  description?: string | undefined;
  visibility?: string | undefined;
};

/**
 * `pingcode testhub libraries …` — the entry point of the module.
 *
 * `create` exists so the CLI can produce the fixtures its own acceptance run
 * needs; the previous milestone had to bootstrap a library over raw HTTP because
 * this leaf was missing. There is still no `update` or `delete`: testhub
 * publishes **no library DELETE at all**, so anything created here is permanent
 * — which is why the `--name` a smoke run passes should be marked and
 * timestamped.
 */
function registerLibraryCommands(parent: Command): void {
  const group = parent
    .command('libraries')
    .description('test libraries 测试库 — the parent of every other testhub id');

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list test libraries')
        .option('--keywords <text>', 'search library names (the identifier is NOT searchable)')
        .option('--include-archived', 'include archived libraries')
        .option('--include-deleted', 'include deleted libraries'),
    ),
    { hidden: true },
  ).action(async (flags: LibraryListFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const paging = readPaging(flags);
    const query: LibraryListQuery = {
      ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
      ...(flags.includeArchived === true ? { include_archived: true } : {}),
      ...(flags.includeDeleted === true ? { include_deleted: true } : {}),
    };

    if (paging.all) {
      const values = await collect(
        iterateLibraries(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
      );
      printCollection(values, TEST_LIBRARY_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listLibraries(ctx, query, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, TEST_LIBRARY_COLUMNS, modeOf(ctx));
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one test library')
      .argument('<library>', LIBRARY_HELP)
      .option('--include-archived', 'allow an archived library to be returned')
      .option('--include-deleted', 'allow a deleted library to be returned'),
    { hidden: true },
  ).action(async (target: string, flags: LibraryGetFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const resolved = await resolveTestLibrary(ctx, requireFlag(target, '<library>'));
    const library = await getLibrary(ctx, resolved.id, {
      ...(flags.includeArchived === true ? { include_archived: true } : {}),
      ...(flags.includeDeleted === true ? { include_deleted: true } : {}),
    });

    printResource(
      library,
      [
        ['name', library.name ?? ''],
        ['identifier', library.identifier ?? ''],
        ['id', library.id],
        ['visibility', library.visibility ?? ''],
        ['scope', library.scope_type ?? ''],
        ['members', String(library.members.length)],
        ['owner', refName(library.created_by)],
        ['archived', library.is_archived ? 'yes' : 'no'],
        ['created', timestampCell(library.created_at)],
        ['updated', timestampCell(library.updated_at)],
        ['url', library.url ?? ''],
        ['description', library.description ?? ''],
      ],
      modeOf(ctx),
    );
  });

  addGlobalOptions(
    group
      .command('create')
      .description('create a test library (the identifier must be unique in the organisation)')
      .requiredOption('--name <text>', 'library name')
      .requiredOption(
        '--identifier <key>',
        'short key, uppercase, unique across the organisation — the server rejects a duplicate',
      )
      .option('--description <text>', 'description')
      .option(
        '--visibility <public|private>',
        'who can see the library; the API defaults to private',
      ),
    { hidden: true },
  ).action(async (flags: LibraryCreateFlags, command: Command) => {
    const { ctx } = contextFor(command);
    const visibility = flags.visibility?.trim();
    if (visibility !== undefined && visibility !== 'public' && visibility !== 'private') {
      throw new UsageError(`--visibility must be public or private, got "${flags.visibility}"`);
    }

    // Nothing here is name-resolved, so there is no cached id to invalidate and
    // `runWrite` would add a retry path with nothing to retry.
    const input: CreateLibraryInput = {
      name: requireFlag(flags.name, '--name'),
      identifier: requireFlag(flags.identifier, '--identifier'),
      ...(flags.description === undefined ? {} : { description: flags.description }),
      ...(visibility === undefined ? {} : { visibility }),
    };

    const library = await createLibrary(ctx, input);
    const mode = modeOf(ctx);
    printResource(
      library,
      [
        ['name', library.name ?? ''],
        ['identifier', library.identifier ?? ''],
        ['id', library.id],
        ['visibility', library.visibility ?? ''],
        ['scope', library.scope_type ?? ''],
        ['created', timestampCell(library.created_at)],
        ['url', library.url ?? ''],
        ['description', library.description ?? ''],
      ],
      mode,
    );
    if (!mode.json) {
      errLine(paint.green(`created ${library.identifier ?? library.id}`));
      // Testhub exposes no library DELETE; say so at the moment it matters.
      errLine(paint.dim('testhub has no library delete endpoint — this library is permanent'));
    }
  });
}

// ---------------------------------------------------------------------------
// testhub cases
// ---------------------------------------------------------------------------

type CaseListFlags = PagingFlags &
  LibraryFlags &
  SuiteFlags &
  StateFlags &
  TypeFlags &
  LevelFlags & {
    keywords?: string | undefined;
    includeArchived?: boolean | undefined;
    includeDeleted?: boolean | undefined;
  };

type CaseCreateFlags = LibraryFlags &
  SuiteFlags &
  TypeFlags &
  LevelFlags & {
    title: string;
    description?: string | undefined;
    precondition?: string | undefined;
    set?: string[] | undefined;
  };

type CaseUpdateFlags = LibraryFlags &
  SuiteFlags &
  StateFlags &
  TypeFlags &
  LevelFlags & {
    title?: string | undefined;
    description?: string | undefined;
    precondition?: string | undefined;
    set?: string[] | undefined;
  };

function registerCaseCommands(parent: Command): void {
  const group = parent
    .command('cases')
    .description('test cases 用例 (scopes pcp:read:testhub:testcase / pcp:write:testhub:testcase)');

  const list = addPagingOptions(
    group
      .command('list')
      .description('search cases in a library (POST /v1/testhub/cases/search)')
      .option('--keywords <text>', 'fuzzy search over case number and title')
      .option('--include-archived', 'include archived cases')
      .option('--include-deleted', 'include deleted cases'),
  );
  addPairOptions(list, 'library', LIBRARY_HELP);
  addPairOptions(list, 'suite', 'case module 模块; a tree, so pass "Parent / Child" to disambiguate');
  addPairOptions(list, 'state', 'case state');
  addPairOptions(list, 'type', 'case type');
  addPairOptions(list, 'important-level', 'importance level; organisation-wide, not per library');
  addGlobalOptions(list, { hidden: true }).action(
    async (flags: CaseListFlags, command: Command) => {
      await runCaseList(flags, command);
    },
  );

  addGlobalOptions(
    group
      .command('get')
      .description('show one case (accepts an id or a short_id)')
      .argument('<case>', 'case id or short_id'),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    const { ctx } = contextFor(command);
    printCase(await getCase(ctx, requireFlag(target, '<case>')), ctx);
  });

  const create = group
    .command('create')
    .description('create a case (only the library and --title are required)')
    .requiredOption('--title <text>', 'title, 1–200 characters')
    .option('--description <text>', 'description 描述')
    .option('--precondition <text>', 'precondition 前置条件')
    .option('--set <key=value>', SET_HELP, collectValue);
  addPairOptions(create, 'library', LIBRARY_HELP);
  addPairOptions(create, 'suite', 'case module 模块');
  addPairOptions(create, 'type', 'case type');
  addPairOptions(create, 'important-level', 'importance level; organisation-wide, not per library');
  addGlobalOptions(create, { hidden: true }).action(
    async (flags: CaseCreateFlags, command: Command) => {
      await runCaseCreate(flags, command);
    },
  );

  const update = group
    .command('update')
    .description('patch a case — only the fields you pass are sent, and they replace')
    .argument('<case>', `case id or short_id (${SHORT_ID_WRITE_CAVEAT})`)
    .option('--title <text>', 'new title')
    .option('--description <text>', 'new description (replaces the old one)')
    .option('--precondition <text>', 'new precondition (replaces the old one)')
    .option('--set <key=value>', SET_HELP, collectValue);
  addPairOptions(update, 'library', `${LIBRARY_HELP} (defaults to the case's own library)`);
  addPairOptions(update, 'suite', 'new case module 模块');
  addPairOptions(update, 'state', 'new case state; PATCH is the only way to move a case');
  addPairOptions(update, 'type', 'new case type');
  addPairOptions(update, 'important-level', 'new importance level');
  addGlobalOptions(update, { hidden: true }).action(
    async (target: string, flags: CaseUpdateFlags, command: Command) => {
      await runCaseUpdate(target, flags, command);
    },
  );

  // All four families accept `principal_type=test_case` — **spelled `test_case`, not
  // `case`**, which is the segment trap of [th#2] showing up again in a vocabulary
  // (live-verified 2026-08-03). `relation` here is the case↔work-item traceability
  // link the whole DevOps loop depends on (design D5.2).
  addCrosscutting(group, 'test_case', {
    resolveId: async (ctx, ref) => (await getCase(ctx, ref)).id,
  });
}

async function runCaseList(flags: CaseListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);

  // Every pair is read (and so validated) before any request goes out.
  const suitePair = readPair('suite', flags.suite, flags.suiteId);
  const statePair = readPair('state', flags.state, flags.stateId);
  const typePair = readPair('type', flags.type, flags.typeId);
  const levelPair = readPair('important-level', flags.importantLevel, flags.importantLevelId);

  const library = await requireLibraryFlag(ctx, flags);
  const suite = await resolvePair('testhub-suite', suitePair, (input) =>
    resolveTestSuite(ctx, library.id, input),
  );
  const state = await resolvePair('testhub-case-state', statePair, (input) =>
    withConfigurationScope('case states', () => resolveCaseState(ctx, library.id, input)),
  );
  const type = await resolvePair('testhub-case-type', typePair, (input) =>
    resolveCaseType(ctx, library.id, input),
  );
  const level = await resolvePair('testhub-case-important-level', levelPair, (input) =>
    resolveCaseImportantLevel(ctx, input),
  );

  const payload: SearchPayload = {
    filter: mergeFilters([
      refFilter('library', library.id),
      refFilter('suite', suite?.id),
      refFilter('state', state?.id),
      refFilter('type', type?.id),
      refFilter('important_level', level?.id),
    ]),
    ...(flags.keywords === undefined ? {} : { keywords: flags.keywords }),
    ...(flags.includeArchived === true ? { include_archived: true } : {}),
    ...(flags.includeDeleted === true ? { include_deleted: true } : {}),
  };

  if (paging.all) {
    const values = await collect(
      iterateCases(ctx, payload, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, TEST_CASE_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await searchCases(ctx, payload, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, TEST_CASE_COLUMNS, modeOf(ctx));
}

async function runCaseCreate(flags: CaseCreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const title = requireFlag(flags.title, '--title');
  const assignments = parseSetFlags(flags.set, SET_HINT);

  const suitePair = readPair('suite', flags.suite, flags.suiteId);
  const typePair = readPair('type', flags.type, flags.typeId);
  const levelPair = readPair('important-level', flags.importantLevel, flags.importantLevelId);

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<CreateCaseInput>> => {
    const library = await requireLibraryFlag(attemptCtx, flags);
    const suite = await resolvePair('testhub-suite', suitePair, (input) =>
      resolveTestSuite(attemptCtx, library.id, input),
    );
    const type = await resolvePair('testhub-case-type', typePair, (input) =>
      resolveCaseType(attemptCtx, library.id, input),
    );
    const level = await resolvePair('testhub-case-important-level', levelPair, (input) =>
      resolveCaseImportantLevel(attemptCtx, input),
    );

    // The body field is `test_library_id`, not `library_id`, even though the
    // response embeds the same thing as `library` (GOTCHA #5).
    const input: CreateCaseInput = {
      test_library_id: library.id,
      title,
      ...(suite === undefined ? {} : { suite_id: suite.id }),
      ...(type === undefined ? {} : { type_id: type.id }),
      ...(level === undefined ? {} : { important_level_id: level.id }),
      ...(flags.description === undefined ? {} : { description: flags.description }),
      ...(flags.precondition === undefined ? {} : { precondition: flags.precondition }),
      ...(assignments.length === 0 ? {} : { properties: propertiesOf(assignments) }),
    };

    return { resolutions: present([library, suite, type, level]), value: input };
  };

  const created = await runWrite(ctx, resolve, (attemptCtx, input) =>
    createCase(attemptCtx, input),
  );
  printCase(created, ctx, 'created');
}

async function runCaseUpdate(
  target: string,
  flags: CaseUpdateFlags,
  command: Command,
): Promise<void> {
  const { ctx } = contextFor(command);
  const assignments = parseSetFlags(flags.set, SET_HINT);

  const suitePair = readPair('suite', flags.suite, flags.suiteId);
  const statePair = readPair('state', flags.state, flags.stateId);
  const typePair = readPair('type', flags.type, flags.typeId);
  const levelPair = readPair('important-level', flags.importantLevel, flags.importantLevelId);

  const scalarPatch: UpdateCaseInput = {
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(flags.precondition === undefined ? {} : { precondition: flags.precondition }),
  };

  const wantsReference =
    suitePair !== undefined ||
    statePair !== undefined ||
    typePair !== undefined ||
    levelPair !== undefined;

  // An empty PATCH is a usage error (exit 2), raised here — never a no-op
  // round-trip against the API (PRD R4).
  if (Object.keys(scalarPatch).length === 0 && !wantsReference && assignments.length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --title / --description / --precondition / --suite / --suite-id / ' +
        '--state / --state-id / --type / --type-id / --important-level / --important-level-id / --set',
    });
  }

  // PATCH documents only `id`, so a short_id has to become one first — and the
  // same read hands back the library every name lookup below needs.
  const existing = await getCase(ctx, requireFlag(target, '<case>'));
  const ownLibraryId = refId(existing.library);

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<UpdateCaseInput>> => {
    const flagged = await resolveLibraryFlag(attemptCtx, flags);
    const libraryId = flagged?.id ?? ownLibraryId;
    if (wantsReference && libraryId === undefined) {
      throw new UsageError(
        `the case ${existing.identifier ?? existing.id} did not report a library, so names cannot be resolved`,
        { hint: 'pass --library <name|id>, or use the --*-id flags to send ids unchanged' },
      );
    }

    const suite =
      libraryId === undefined
        ? undefined
        : await resolvePair('testhub-suite', suitePair, (input) =>
            resolveTestSuite(attemptCtx, libraryId, input),
          );
    const state =
      libraryId === undefined
        ? undefined
        : await resolvePair('testhub-case-state', statePair, (input) =>
            withConfigurationScope('case states', () =>
              resolveCaseState(attemptCtx, libraryId, input),
            ),
          );
    const type =
      libraryId === undefined
        ? undefined
        : await resolvePair('testhub-case-type', typePair, (input) =>
            resolveCaseType(attemptCtx, libraryId, input),
          );
    const level = await resolvePair('testhub-case-important-level', levelPair, (input) =>
      resolveCaseImportantLevel(attemptCtx, input),
    );

    const patch: UpdateCaseInput = {
      ...scalarPatch,
      ...(suite === undefined ? {} : { suite_id: suite.id }),
      ...(state === undefined ? {} : { state_id: state.id }),
      ...(type === undefined ? {} : { type_id: type.id }),
      ...(level === undefined ? {} : { important_level_id: level.id }),
      ...(assignments.length === 0 ? {} : { properties: propertiesOf(assignments) }),
    };

    return { resolutions: present([flagged, suite, state, type, level]), value: patch };
  };

  const updated = await runWrite(ctx, resolve, (attemptCtx, patch) =>
    updateCase(attemptCtx, existing.id, patch),
  );
  printCase(updated, ctx, 'updated');
}

/**
 * `--set key=value` becomes a `properties` object with the keys **verbatim**.
 *
 * Unlike ship, testhub exposes no property lookup in this milestone's leaf
 * inventory (`GET /v1/testhub/case/properties` is out of the PRD's 15-endpoint
 * MVP), so there is nothing to resolve a key against and nothing to invalidate.
 * `properties` replaces wholesale — merge semantics are undocumented (design §12).
 */
function propertiesOf(assignments: { key: string; value: string }[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const assignment of assignments) properties[assignment.key] = assignment.value;
  return properties;
}

function printCase(testCase: TestCase, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    testCase,
    [
      ['identifier', testCase.identifier ?? ''],
      ['id', testCase.id],
      ['short id', testCase.short_id ?? ''],
      ['title', testCase.title ?? ''],
      ['library', refName(testCase.library)],
      ['module', refName(testCase.suite)],
      ['state', refName(testCase.state)],
      ['type', refName(testCase.type)],
      ['importance', refName(testCase.important_level) || (testCase.level ?? '')],
      ['maintainer', refName(testCase.maintenance)],
      ['test type', testCase.test_type ?? ''],
      ['steps', String(testCase.steps.length)],
      ['created', timestampCell(testCase.created_at)],
      ['updated', timestampCell(testCase.updated_at)],
      ['url', testCase.html_url ?? testCase.url ?? ''],
      ['precondition', testCase.precondition ?? ''],
      ['description', testCase.description ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${testCase.identifier ?? testCase.id}`));
  }
}

// ---------------------------------------------------------------------------
// testhub plans
// ---------------------------------------------------------------------------

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
function registerPlanCommands(parent: Command): void {
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

// ---------------------------------------------------------------------------
// testhub runs
// ---------------------------------------------------------------------------

type RunListFlags = PagingFlags &
  LibraryFlags &
  PlanFlags &
  StatusFlags &
  ExecutorFlags & {
    caseId?: string | undefined;
    keywords?: string | undefined;
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

function registerRunCommands(parent: Command): void {
  const group = parent
    .command('runs')
    .description(
      'test runs 执行用例 (scopes pcp:read:testhub:testplan / pcp:write:testhub:testplan)',
    );

  const list = addPagingOptions(
    group
      .command('list')
      .description(`search runs (POST /v1/testhub/runs/search) — ${RUN_LIBRARY_FILTER_CAVEAT}`)
      .option('--case-id <id>', 'filter by case id')
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

  const patch = group
    .command('patch')
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
// testhub meta
// ---------------------------------------------------------------------------

/**
 * `pingcode testhub meta …` — the ids a testhub write cannot be built without,
 * structurally the same subgroup as `product meta` / `project meta`.
 *
 * Five of the six are library-scoped. The sixth, `important-levels`, is **not**:
 * it is the one lookup with no `?library_id=` variant anywhere ([th#40]), so it
 * rejects `--library` rather than quietly ignoring it.
 *
 * **The scope split is not uniform, and the hints must not be borrowed.**
 * `case-states`, `run-statuses` and `important-levels` need
 * `pcp:read:testhub:configuration` and say so on a 403. `case-types` is
 * `pcp:read:testhub:testcase`, `plan-types` is `pcp:read:testhub:testplan` and
 * `suites` is `pcp:read:testhub:library` — none of those three carry a
 * configuration-scope hint, because a misplaced one sends a 403 investigation
 * after a scope that was never the problem.
 */
function registerTesthubMetaCommands(parent: Command): void {
  const meta = parent
    .command('meta')
    .description(
      'ids you need before writing: case states, types, importance levels, run results, ' +
        'plan types, modules',
    );

  function libraryScoped<T>(
    name: string,
    description: string,
    load: (ctx: Ctx, libraryId: string) => Promise<T[]>,
    columns: Column<T>[],
    configurationScope?: string,
  ): void {
    const leaf = meta.command(name).description(description);
    addPairOptions(leaf, 'library', LIBRARY_HELP);
    addGlobalOptions(leaf, { hidden: true }).action(
      async (flags: LibraryFlags, command: Command) => {
        const { ctx } = contextFor(command);
        const library = await requireLibraryFlag(ctx, flags);
        const values =
          configurationScope === undefined
            ? await load(ctx, library.id)
            : await withConfigurationScope(configurationScope, () => load(ctx, library.id));
        printCollection(values, columns, modeOf(ctx));
      },
    );
  }

  libraryScoped(
    'case-states',
    `case states of a library (values for --state / state_id) — scope ${CONFIGURATION_SCOPE}`,
    caseStates,
    CASE_STATE_COLUMNS,
    'case states',
  );

  libraryScoped(
    'case-types',
    'case types of a library (values for --type / type_id) — needs only pcp:read:testhub:testcase',
    caseTypes,
    CASE_TYPE_COLUMNS,
  );

  // The one asymmetry in the module: org-level, so no --library at all.
  const levels = meta
    .command('important-levels')
    .description(
      'case importance levels (values for --important-level) — organisation-wide, so this ' +
        'takes no library',
    )
    // Declared and refused on purpose: the other three meta leaves take
    // --library, and silently ignoring it here would imply a scoping the API
    // does not have.
    .addOption(libraryTrap('--library <name|id>'))
    .addOption(libraryTrap('--library-id <id>'));
  addGlobalOptions(levels, { hidden: true }).action(
    async (flags: LibraryFlags, command: Command) => {
      if (flags.library !== undefined || flags.libraryId !== undefined) {
        throw new UsageError('important-levels takes no --library', {
          hint:
            'importance levels are organisation-wide in testhub — there is no per-library ' +
            'variant of this lookup, so the same list applies to every library',
        });
      }
      const { ctx } = contextFor(command);
      // Org-level, but still part of the 用例配置 family ([th#36]/[th#40]), so it
      // sits behind the same configuration scope as case states and run statuses.
      const values = await withConfigurationScope('importance levels', () => importantLevels(ctx));
      printCollection(values, IMPORTANT_LEVEL_COLUMNS, modeOf(ctx));
    },
  );

  libraryScoped(
    'run-statuses',
    `run results 执行结果 of a library (values for --status / status_id) — scope ${CONFIGURATION_SCOPE}`,
    runStatuses,
    RUN_STATUS_COLUMNS,
    'run statuses',
  );

  // Path-scoped, and `pcp:read:testhub:testplan` — so no configuration hint.
  // The factory still fits: it takes a `load` callback and builds no URL itself,
  // which is what makes it indifferent to whether the library id rides in the
  // path or the query. (Its namesake in `core/metadata.ts` is not — that one
  // hardcodes `?library_id=`, which is why `resolveTestPlanType` bypassed it.)
  libraryScoped(
    'plan-types',
    'plan types of a library (values for --type on `plans create`) — scope pcp:read:testhub:testplan',
    planTypes,
    PLAN_TYPE_COLUMNS,
  );

  // Not through the factory: this one takes an extra flag and post-processes the
  // rows, neither of which the factory expresses.
  const suites = meta
    .command('suites')
    .description(
      'case modules 模块 of a library (values for --suite) — a tree, listed flat with the full ' +
        'path; scope pcp:read:testhub:library',
    )
    .option(
      '--parent-id <id|root>',
      "restrict to the children of one node; 'root' lists the top level only",
    );
  addPairOptions(suites, 'library', LIBRARY_HELP);
  addGlobalOptions(suites, { hidden: true }).action(
    async (flags: SuiteListFlags, command: Command) => {
      const { ctx } = contextFor(command);
      const library = await requireLibraryFlag(ctx, flags);
      const parentId = flags.parentId?.trim();

      // The whole (filtered) set is collected rather than paged: a tree is a
      // lookup, and a partial page would produce partial paths.
      const rows = await collect(
        iterateSuites(
          ctx,
          library.id,
          parentId === undefined || parentId === '' ? {} : { parent_id: parentId },
          { pageSize: 100, limit: 1000 },
        ),
      );
      printCollection(withComputedPaths(rows), SUITE_COLUMNS, modeOf(ctx));
    },
  );
}

/**
 * Attach the path spelling `--suite` accepts to each row.
 *
 * The path is computed by walking the `parent` refs present in the result set,
 * matching how `core/metadata.ts` builds the alias it resolves against — so what
 * this leaf prints is what `--suite` takes.
 *
 * The server's own `paths` field is **not** displayed: verified live in
 * `f74ecd2` it is the parent chain *excluding* the node, so a child would appear
 * to carry its parent's path. It is used only as a fallback prefix under
 * `--parent-id <id>`, where the parents are outside the result set and the walk
 * cannot reach them; re-joining it with the CLI's separator reconstructs the same
 * full path.
 */
function withComputedPaths(rows: TestSuite[]): SuiteRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));

  const walk = (row: TestSuite): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cursor: TestSuite | undefined = row;
    // `seen` guards a cyclic parent chain, which would otherwise hang.
    while (cursor !== undefined && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      parts.unshift(cursor.name ?? '(unnamed)');
      const parentId = refId(cursor.parent);
      if (parentId === undefined) return parts.join(SUITE_PATH_SEPARATOR);
      const parent = byId.get(parentId);
      if (parent === undefined) {
        // Filtered view: rebuild the missing prefix from the server's chain.
        const ancestors = (cursor.paths ?? '')
          .split('/')
          .map((part) => part.trim())
          .filter((part) => part !== '');
        return [...ancestors, ...parts].join(SUITE_PATH_SEPARATOR);
      }
      cursor = parent;
    }
    return parts.join(SUITE_PATH_SEPARATOR);
  };

  return rows.map((row) => ({ ...row, computed_path: walk(row) }));
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function refId(ref: { id: string } | undefined): string | undefined {
  const id = ref?.id;
  return id === undefined || id === '' ? undefined : id;
}

/**
 * A `--library` flag that exists only to be refused.
 *
 * `meta important-levels` is org-level, and the other three `meta` leaves all
 * take `--library`, so the flag *will* be typed here. Declaring it hidden and
 * failing with an explanation beats commander's bare "unknown option", and beats
 * accepting it and quietly ignoring it — which would imply a per-library
 * scoping the API does not have ([th#40]).
 */
function libraryTrap(flags: string): Option {
  return new Option(flags, 'not accepted: importance levels are organisation-wide').hideHelp();
}
