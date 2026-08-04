import type { Command } from 'commander';
import {
  bulkCreateCases,
  bulkUpdateCases,
  createCase,
  deleteCase,
  getCase,
  iterateCaseHistories,
  iterateCases,
  listCaseHistories,
  searchCases,
  searchRuns,
  updateCase,
  type BulkCreateCaseEntry,
  type BulkUpdateCaseEntry,
  type CreateCaseInput,
  type UpdateCaseInput,
} from '../../../api/testhub';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import {
  resolveCaseImportantLevel,
  resolveCaseState,
  resolveCaseType,
  resolveTestSuite,
  resolveUser,
  type ResolveResult,
} from '../../../core/metadata';
import { collect, type SearchPayload } from '../../../core/paginate';
import type { TestCase, TestCaseBulkItem, TestCaseHistoryItem } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import { addCrosscutting } from '../_shared/crosscutting';
import {
  addPagingOptions,
  collectValue,
  contextFor,
  mergeFilters,
  modeOf,
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
  entryProperties,
  entrySteps,
  entryString,
  optionalEntryString,
  readEntryFile,
  type RawEntry,
} from './entries';

/**
 * `pingcode testhub cases …` — 用例, the module's centre of gravity.
 *
 * Two facts shape every leaf here (design §2, §6): **search is the read path**, so
 * `list` is `POST /v1/testhub/cases/search` and the plain `GET /v1/testhub/cases`
 * is never called; and **writes take `*_id` while reads return objects**, so every
 * name-resolvable field is a `--x` / `--x-id` pair resolved against the library.
 */

export const SET_HELP =
  'custom case property, repeatable: --set key=value. Keys are raw property keys and values for ' +
  'select-typed properties are option ids, not labels. Replaces, never merges';

/**
 * The hint `parseSetFlags` prints on a malformed `--set`.
 *
 * S3 added the lookup this used to say did not exist — but it points at it with a
 * warning rather than a promise, because live 2026-08-04 every row
 * `testhub meta case-properties` returns on this tenant is a **built-in field**
 * whose `id` is the field's own name, and pushing one of those through the
 * `properties` map either answers HTTP 500 (`important_level`) or silently rewrites
 * the top-level field of the same name (`description`). Only a genuinely custom
 * property is a `--set` key.
 */
export const SET_HINT =
  'pass --set <key>=<value>. List the fields of a library with `pingcode testhub meta ' +
  'case-properties --library <l>` — but only genuinely CUSTOM properties are --set keys: the ' +
  'built-in rows (state_id, description, steps, type, important_level, maintenance_uid, ' +
  'precondition, test_type) are top-level fields and must be set with their own flags';

const SUITE_REFUSAL =
  'the API accepts suite_id on the bulk endpoints and lands nothing (verified live) — file the ' +
  'case afterwards with `pingcode testhub cases update <case> --suite <module>`';

const STATE_REFUSAL =
  'a bulk-created case always starts in the library default state (state_id is accepted and ' +
  'ignored, verified live) — move it afterwards with `cases bulk-update --state`';

type SuiteFlags = { suite?: string | undefined; suiteId?: string | undefined };
type StateFlags = { state?: string | undefined; stateId?: string | undefined };
type TypeFlags = { type?: string | undefined; typeId?: string | undefined };
type LevelFlags = {
  importantLevel?: string | undefined;
  importantLevelId?: string | undefined;
};

const TEST_CASE_COLUMNS: Column<TestCase>[] = [
  { header: 'IDENTIFIER', value: (c) => c.identifier ?? c.short_id ?? c.id },
  { header: 'TITLE', value: (c) => c.title ?? '', flex: true },
  { header: 'STATE', value: (c) => refName(c.state) },
  { header: 'TYPE', value: (c) => refName(c.type) },
  { header: 'LEVEL', value: (c) => refName(c.important_level) || (c.level ?? '') },
  { header: 'MODULE', value: (c) => refName(c.suite), flex: true },
];

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

type CaseBulkCreateFlags = LibraryFlags &
  TypeFlags &
  LevelFlags & {
    file?: string | undefined;
  };

type CaseBulkUpdateFlags = LibraryFlags &
  StateFlags &
  TypeFlags &
  LevelFlags & {
    case?: string[] | undefined;
    caseId?: string[] | undefined;
    file?: string | undefined;
    title?: string | undefined;
    description?: string | undefined;
    precondition?: string | undefined;
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

export function registerCaseCommands(parent: Command): void {
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

  const bulkCreate = group
    .command('bulk-create')
    .description('import many cases from a JSON file in one call (POST /v1/testhub/cases/bulk)')
    .option('--file <path|->', 'JSON array of case entries, or - to read it from stdin')
    .addHelpText(
      'after',
      '\nEach entry needs a title; everything else is optional:\n' +
        '  {"title": "…", "description": "…", "precondition": "…",\n' +
        '   "type": "接口测试" | "type_id": "…", "important_level": "P1" | "important_level_id": "…",\n' +
        '   "maintenance": "luoxiutao" | "maintenance_id": "…", "participant_ids": ["…"],\n' +
        '   "properties": {"<custom key>": "…"},\n' +
        '   "steps": [{"description": "…", "expected_value": "…"}]}\n' +
        'A bare array or {"cases": [ … ]} are both accepted, so a body copied from the docs works.\n' +
        'Refused on purpose, because the server accepts them and then LANDS NOTHING (verified\n' +
        'live): suite/suite_id and state/state_id. A bulk-created case always starts in the\n' +
        "library's default state and in no module — file it afterwards with `cases update`\n" +
        'or `cases bulk-update`. type/type_id, by contrast, is undocumented upstream and DOES\n' +
        'work, so it is offered here.\n' +
        'Up to 100 entries per call (the API\'s own limit). The response reports one row per\n' +
        'entry; read its STATE column rather than the exit code.\n',
    );
  addPairOptions(bulkCreate, 'library', LIBRARY_HELP);
  addPairOptions(bulkCreate, 'type', 'case type applied to every entry that names none');
  addPairOptions(
    bulkCreate,
    'important-level',
    'importance level applied to every entry that names none',
  );
  addGlobalOptions(bulkCreate, { hidden: true }).action(
    async (flags: CaseBulkCreateFlags, command: Command) => {
      await runCaseBulkCreate(flags, command);
    },
  );

  const bulkUpdate = group
    .command('bulk-update')
    .description('patch many cases in one call — either --case … with shared fields, or --file')
    .option('--case <ref>', 'case to change, repeatable: id or short_id', collectValue)
    .option('--case-id <id>', 'case to change, repeatable: an id, sent with no lookup', collectValue)
    .option('--file <path|->', 'JSON array of per-case entries, or - for stdin')
    .option('--title <text>', 'new title for every named case')
    .option('--description <text>', 'new description for every named case (replaces)')
    .option('--precondition <text>', 'new precondition for every named case (replaces)')
    .addHelpText(
      'after',
      '\nTwo forms, and they are mutually exclusive:\n' +
        '  · --case/--case-id (repeatable) plus the shared field flags — one value for all;\n' +
        '  · --file, when each case needs its own values. Entry keys: case | case_id (one is\n' +
        '    required), title, description, precondition, state | state_id, type | type_id,\n' +
        '    important_level | important_level_id, maintenance | maintenance_id, properties, steps.\n' +
        'suite/suite_id is refused: the API accepts it here and lands nothing (verified live).\n' +
        'Use `cases update --suite` for that, one case at a time.\n' +
        'The patch is partial per entry — unmentioned fields are left alone — but steps and\n' +
        'properties REPLACE wholesale, and a step sent without its step_id is re-created with a\n' +
        'new one, orphaning its results.\n' +
        'Up to 100 entries per call.\n',
    );
  addPairOptions(bulkUpdate, 'library', `${LIBRARY_HELP} (needed to resolve names)`);
  addPairOptions(bulkUpdate, 'state', 'new case state for every named case');
  addPairOptions(bulkUpdate, 'type', 'new case type for every named case');
  addPairOptions(bulkUpdate, 'important-level', 'new importance level for every named case');
  addGlobalOptions(bulkUpdate, { hidden: true }).action(
    async (flags: CaseBulkUpdateFlags, command: Command) => {
      await runCaseBulkUpdate(flags, command);
    },
  );

  addGlobalOptions(
    group
      .command('delete')
      .description('delete a case — and every execution record it has in every plan')
      .argument('<case>', `case id or short_id (${SHORT_ID_WRITE_CAVEAT})`)
      .option('--yes', 'confirm: the case and its runs disappear from every plan and report')
      .addHelpText(
        'after',
        '\nVerified live: deleting a case CASCADES to its runs. A case with a run in a plan took\n' +
          'the run with it — the plan lost the row and the run id answers "not found" afterwards.\n' +
          'The confirmation therefore counts the runs first and names the number.\n' +
          'It is a soft delete: `cases list --include-deleted` still finds the case, but this API\n' +
          'publishes no undelete endpoint, so from here it is one-way.\n',
      ),
    { hidden: true },
  ).action(async (target: string, flags: { yes?: boolean | undefined }, command: Command) => {
    await runCaseDelete(target, flags, command);
  });

  registerCaseHistoryCommands(group);

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
// bulk create / bulk update
// ---------------------------------------------------------------------------

const CASE_BULK_COLUMNS: Column<TestCaseBulkItem>[] = [
  { header: 'STATE', value: (row) => row.state ?? '' },
  { header: 'IDENTIFIER', value: (row) => row.case?.identifier ?? '' },
  { header: 'TITLE', value: (row) => row.case?.title ?? '', flex: true },
  { header: 'ID', value: (row) => row.case?.id ?? '' },
  { header: 'MESSAGE', value: (row) => row.message ?? '', flex: true },
];

/**
 * Keys a bulk-create entry may carry, and the two the API takes and throws away.
 *
 * `type` is here although the endpoint does not document it: live 2026-08-04 a bulk
 * entry's `type_id` lands (read back on the created case), while `suite_id` and
 * `state_id` answer 200 and change nothing. Refusing the two that vanish is the
 * whole reason this leaf validates keys at all — a silent 60-case import into the
 * wrong module looks like a success.
 */
const BULK_CREATE_SCHEMA = {
  wrapperKey: 'cases',
  allowed: [
    'title',
    'description',
    'precondition',
    'type',
    'type_id',
    'important_level',
    'important_level_id',
    'maintenance',
    'maintenance_id',
    'participant_ids',
    'properties',
    'steps',
  ],
  refused: {
    suite: SUITE_REFUSAL,
    suite_id: SUITE_REFUSAL,
    state: STATE_REFUSAL,
    state_id: STATE_REFUSAL,
  },
} as const;

const BULK_UPDATE_SCHEMA = {
  wrapperKey: 'cases',
  allowed: [
    'case',
    'case_id',
    'title',
    'description',
    'precondition',
    'state',
    'state_id',
    'type',
    'type_id',
    'important_level',
    'important_level_id',
    'maintenance',
    'maintenance_id',
    'properties',
    'steps',
  ],
  refused: { suite: SUITE_REFUSAL, suite_id: SUITE_REFUSAL },
} as const;

async function runCaseBulkCreate(flags: CaseBulkCreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const sharedTypePair = readPair('type', flags.type, flags.typeId);
  const sharedLevelPair = readPair(
    'important-level',
    flags.importantLevel,
    flags.importantLevelId,
  );

  const entries = await readEntryFile(
    flags,
    BULK_CREATE_SCHEMA,
    'pass a JSON array of case entries, or - to read it from stdin. Each entry needs a title; ' +
      'see `pingcode testhub cases bulk-create --help` for the accepted keys',
  );
  checkBulkLimit(entries.length, 'case entries');

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<BulkCreateCaseEntry[]>> => {
    const library = await requireLibraryFlag(attemptCtx, flags);
    const resolutions: ResolveResult[] = [library];

    const sharedType = await resolvePair('testhub-case-type', sharedTypePair, (input) =>
      resolveCaseType(attemptCtx, library.id, input),
    );
    const sharedLevel = await resolvePair(
      'testhub-case-important-level',
      sharedLevelPair,
      (input) => resolveCaseImportantLevel(attemptCtx, input),
    );
    resolutions.push(...present([sharedType, sharedLevel]));

    const rows: BulkCreateCaseEntry[] = [];
    for (const entry of entries) {
      const type = await resolveEntryType(attemptCtx, entry, library.id, resolutions);
      const level = await resolveEntryLevel(attemptCtx, entry, resolutions);
      const maintenance = await resolveEntryUser(attemptCtx, entry, 'maintenance', resolutions);

      const typeId = type ?? sharedType?.id;
      const levelId = level ?? sharedLevel?.id;
      rows.push({
        test_library_id: library.id,
        title: entryString(entry, 'title'),
        ...(typeId === undefined ? {} : { type_id: typeId }),
        ...(levelId === undefined ? {} : { important_level_id: levelId }),
        ...(maintenance === undefined ? {} : { maintenance_id: maintenance }),
        ...participantIds(entry),
        ...optionalText(entry, 'description'),
        ...optionalText(entry, 'precondition'),
        ...propertiesOfEntry(entry),
        ...stepsOfEntry(entry),
      });
    }

    return { resolutions, value: rows };
  };

  const items = await runWrite(ctx, resolve, (attemptCtx, cases) =>
    bulkCreateCases(attemptCtx, { cases }),
  );
  printBulkItems(items, ctx, 'created');
}

async function runCaseBulkUpdate(flags: CaseBulkUpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  // Two lists, deliberately not merged: `--case` is a reference that costs a read
  // (a short_id is legitimate and the write is id-only), `--case-id` is sent
  // untouched. Merging them would silently make `--case-id` pay for a lookup it
  // exists to avoid.
  const refs = (flags.case ?? []).map((value) => value.trim()).filter((value) => value !== '');
  const ids = (flags.caseId ?? []).map((value) => value.trim()).filter((value) => value !== '');
  const named = [...refs, ...ids];
  const usesFile = (flags.file?.trim() ?? '') !== '';

  if (usesFile && named.length > 0) {
    throw new UsageError('--file cannot be combined with --case / --case-id', {
      hint: 'use --file when each case needs its own values, or --case with the shared field flags',
    });
  }

  const statePair = readPair('state', flags.state, flags.stateId);
  const typePair = readPair('type', flags.type, flags.typeId);
  const levelPair = readPair('important-level', flags.importantLevel, flags.importantLevelId);
  const sharedScalars = {
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(flags.precondition === undefined ? {} : { precondition: flags.precondition }),
  };
  const wantsSharedField =
    Object.keys(sharedScalars).length > 0 ||
    statePair !== undefined ||
    typePair !== undefined ||
    levelPair !== undefined;

  if (!usesFile && named.length === 0) {
    throw new UsageError('nothing to update: pass --case <ref> … or --file <path|->', {
      hint: 'with --case you must also pass at least one field flag; with --file each entry carries its own',
    });
  }
  if (!usesFile && !wantsSharedField) {
    throw new UsageError('nothing to update: no field flag was given', {
      hint:
        'pass at least one of --title / --description / --precondition / --state / --state-id / ' +
        '--type / --type-id / --important-level / --important-level-id',
    });
  }
  if (usesFile && wantsSharedField) {
    throw new UsageError('--file carries its own fields, so the shared field flags are refused', {
      hint: 'put the values in the entries, or drop --file and use --case with the shared flags',
    });
  }

  const entries = usesFile
    ? await readEntryFile(
        flags,
        BULK_UPDATE_SCHEMA,
        'pass a JSON array of case entries, or - to read it from stdin. Each entry needs case or ' +
          'case_id; see `pingcode testhub cases bulk-update --help` for the accepted keys',
      )
    : [];
  checkBulkLimit(usesFile ? entries.length : named.length, 'case entries');

  // Case ids first, outside the retry: a `short_id` is rejected by every write, and
  // resolving one costs a read that must not be repeated on a cache-invalidation retry.
  const namedIds = new Map<string, string>();
  if (!usesFile) {
    for (const ref of refs) namedIds.set(ref, (await getCase(ctx, ref)).id);
    for (const id of ids) namedIds.set(id, id);
  }
  for (const entry of entries) {
    const byId = optionalEntryString(entry, 'case_id');
    const byRef = optionalEntryString(entry, 'case');
    if (byId !== undefined && byRef !== undefined) {
      throw new UsageError(`${entry.at} sets both case and case_id`, {
        hint: 'use case for an id or short_id to resolve, or case_id for an id sent unchanged',
      });
    }
    if (byId !== undefined) {
      namedIds.set(entry.at, byId);
      continue;
    }
    if (byRef === undefined) {
      throw new UsageError(`${entry.at} names no case`, {
        hint: 'give the entry a case (id or short_id) or a case_id',
      });
    }
    namedIds.set(entry.at, (await getCase(ctx, byRef)).id);
  }

  const resolve = async (attemptCtx: Ctx): Promise<ResolvedWrite<BulkUpdateCaseEntry[]>> => {
    const flagged = await resolveLibraryFlag(attemptCtx, flags);
    const resolutions: ResolveResult[] = present([flagged]);

    const needsLibrary =
      byName(statePair) ||
      byName(typePair) ||
      entries.some(
        (entry) =>
          isName(entryPair(entry, 'state')) ||
          isName(entryPair(entry, 'type')),
      );
    if (needsLibrary && flagged === undefined) {
      throw new UsageError('--library <name|id> is required to resolve a state or type by name', {
        hint: 'case states and types are library-scoped; pass --library, or use the --*-id forms',
      });
    }
    const libraryId = flagged?.id;

    const sharedState =
      libraryId === undefined
        ? await resolvePair('testhub-case-state', asIdOnly(statePair), () => {
            throw new UsageError('--library is required to resolve a state name');
          })
        : await resolvePair('testhub-case-state', statePair, (input) =>
            withConfigurationScope('case states', () =>
              resolveCaseState(attemptCtx, libraryId, input),
            ),
          );
    const sharedType =
      libraryId === undefined
        ? await resolvePair('testhub-case-type', asIdOnly(typePair), () => {
            throw new UsageError('--library is required to resolve a type name');
          })
        : await resolvePair('testhub-case-type', typePair, (input) =>
            resolveCaseType(attemptCtx, libraryId, input),
          );
    const sharedLevel = await resolvePair(
      'testhub-case-important-level',
      levelPair,
      (input) => resolveCaseImportantLevel(attemptCtx, input),
    );
    resolutions.push(...present([sharedState, sharedType, sharedLevel]));

    const rows: BulkUpdateCaseEntry[] = [];

    if (!usesFile) {
      for (const ref of named) {
        rows.push({
          case_id: namedIds.get(ref) as string,
          ...sharedScalars,
          ...(sharedState === undefined ? {} : { state_id: sharedState.id }),
          ...(sharedType === undefined ? {} : { type_id: sharedType.id }),
          ...(sharedLevel === undefined ? {} : { important_level_id: sharedLevel.id }),
        });
      }
      return { resolutions, value: rows };
    }

    for (const entry of entries) {
      const state =
        libraryId === undefined
          ? idOfEntryPair(entry, 'state')
          : await resolveEntryState(attemptCtx, entry, libraryId, resolutions);
      const type =
        libraryId === undefined
          ? idOfEntryPair(entry, 'type')
          : await resolveEntryType(attemptCtx, entry, libraryId, resolutions);
      const level = await resolveEntryLevel(attemptCtx, entry, resolutions);
      const maintenance = await resolveEntryUser(attemptCtx, entry, 'maintenance', resolutions);

      const row: BulkUpdateCaseEntry = {
        case_id: namedIds.get(entry.at) as string,
        ...optionalText(entry, 'title'),
        ...optionalText(entry, 'description'),
        ...optionalText(entry, 'precondition'),
        ...(state === undefined ? {} : { state_id: state }),
        ...(type === undefined ? {} : { type_id: type }),
        ...(level === undefined ? {} : { important_level_id: level }),
        ...(maintenance === undefined ? {} : { maintenance_id: maintenance }),
        ...propertiesOfEntry(entry),
        ...stepsOfEntry(entry),
      };
      if (Object.keys(row).length === 1) {
        throw new UsageError(`${entry.at} names a case but no field to change`);
      }
      rows.push(row);
    }

    return { resolutions, value: rows };
  };

  const items = await runWrite(ctx, resolve, (attemptCtx, cases) =>
    bulkUpdateCases(attemptCtx, { cases }),
  );
  printBulkItems(items, ctx, 'updated');
}

/**
 * Render a bulk response, and say out loud how many rows failed.
 *
 * The `cases/bulk` halves have not been observed to report a per-element `failure`
 * — a bad field fails the whole request with a 400 — but the `runs/bulk` create
 * half does, so both surfaces read their `state` column rather than the exit code.
 * The exit stays 0 because the request itself succeeded and the result is on stdout;
 * the warning is what makes a partial batch impossible to miss in human mode.
 */
function printBulkItems(items: TestCaseBulkItem[], ctx: Ctx, verb: string): void {
  const mode = modeOf(ctx);
  printCollection(items, CASE_BULK_COLUMNS, mode);
  if (mode.json) return;
  const failed = items.filter((item) => item.state !== undefined && item.state !== 'success');
  if (failed.length > 0) {
    errLine(paint.yellow(`${failed.length} of ${items.length} entries failed — read the STATE column`));
    return;
  }
  errLine(paint.green(`${verb} ${items.length} case(s)`));
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

/**
 * `cases delete` — the only destructive leaf in the module, and it destroys more
 * than its name suggests.
 *
 * The read before the `--yes` gate is what lets the confirmation name the case
 * (design D8.1), and the run count is a *second* read for the same reason: live
 * 2026-08-04 a case delete cascaded to the case's runs, so the number the user needs
 * to see is how many execution records are about to disappear.
 */
async function runCaseDelete(
  target: string,
  flags: { yes?: boolean | undefined },
  command: Command,
): Promise<void> {
  const { ctx } = contextFor(command);
  const existing = await getCase(ctx, requireFlag(target, '<case>'));
  const label = `${existing.identifier ?? existing.short_id ?? existing.id} "${existing.title ?? ''}"`;

  const runs = await searchRuns(
    ctx,
    { filter: mergeFilters([refFilter('case', existing.id)]) },
    { pageIndex: 0, pageSize: 1 },
  );

  if (flags.yes !== true) {
    throw new UsageError(`refusing to delete case ${label} without --yes`, {
      hint:
        `it has ${runs.total} execution record(s) in test plans, and deleting the case deletes ` +
        'them too — verified live, the plan loses the row and the run id stops resolving. The ' +
        'case itself is only soft-deleted (it still appears with --include-deleted) but this API ' +
        'publishes no undelete. Re-run with --yes, or with --yes --dry-run to see the request first',
    });
  }

  const deleted = await deleteCase(ctx, existing.id);
  const mode = modeOf(ctx);
  printCase(deleted, ctx);
  if (!mode.json) {
    errLine(paint.green(`deleted ${deleted.identifier ?? deleted.id}`));
    if (runs.total > 0) {
      errLine(paint.dim(`${runs.total} execution record(s) went with it`));
    }
  }
}

// ---------------------------------------------------------------------------
// history: the latest result of every run of this case
// ---------------------------------------------------------------------------

const CASE_HISTORY_COLUMNS: Column<TestCaseHistoryItem>[] = [
  { header: 'ID', value: (row) => row.id },
  { header: 'WHEN', value: (row) => timestampCell(row.executed_at) },
  { header: 'RESULT', value: (row) => refName(row.executed_status) || (row.status ?? '') },
  { header: 'PLAN', value: (row) => row.plan?.name ?? '', flex: true },
  // `run` is a plain `Ref`, whose extra keys are `unknown` — so the short_id is read
  // through a narrowing helper rather than asserted.
  { header: 'RUN', value: (row) => refShortId(row.run) },
  { header: 'BY', value: (row) => refName(row.executed_by) },
  { header: 'REMARK', value: (row) => row.remark ?? '', flex: true },
];

/**
 * `cases history list` — one row per **run** of the case, carrying that run's latest
 * result (not every attempt: that is `runs history list`).
 *
 * There is deliberately no `get`: the API publishes no
 * `GET /cases/{id}/histories/{history_id}`, and the record a row points at *is* a
 * run history, reachable as `runs history get <run> <id>`.
 */
function registerCaseHistoryCommands(parent: Command): void {
  const group = parent
    .command('history')
    .description('执行历史 the latest result of every run of one case (read-only)');

  group.addHelpText(
    'after',
    '\nOne row per run of this case, showing that run\'s LATEST result — so the row count is the\n' +
      'number of runs, not the number of attempts. For every attempt on one run, use\n' +
      '`testhub runs history list <run>`; each row here names the run it came from.\n' +
      'There is no `history get` here because the API has no per-case history detail path: a row\n' +
      'is a run history record, so read it with `testhub runs history get <run> <id>`.\n' +
      'The endpoint declares the WRITE scope pcp:write:testhub:testcase — almost certainly a doc\n' +
      'bug, but request it alongside the read scope if this 403s.\n',
  );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list the latest result of every run of a case')
        .argument('<case>', 'case id or short_id'),
    ),
    { hidden: true },
  ).action(async (target: string, flags: PagingFlags, command: Command) => {
    const { ctx } = contextFor(command);
    // The histories path is id-only (a short_id answers 404), so the reference is
    // resolved through the case read that does accept one.
    const existing = await getCase(ctx, requireFlag(target, '<case>'));
    const paging = readPaging(flags);

    if (paging.all) {
      const values = await collect(
        iterateCaseHistories(ctx, existing.id, {
          pageSize: paging.pageSize,
          limit: paging.limit,
        }),
      );
      printCollection(values, CASE_HISTORY_COLUMNS, modeOf(ctx), { all: true });
      return;
    }

    const page = await listCaseHistories(ctx, existing.id, {
      pageIndex: paging.pageIndex,
      pageSize: paging.pageSize,
    });
    printPage(page, CASE_HISTORY_COLUMNS, modeOf(ctx));
  });
}

// ---------------------------------------------------------------------------
// entry helpers
// ---------------------------------------------------------------------------

function byName(pair: PairInput | undefined): boolean {
  return pair !== undefined && 'byName' in pair;
}

function isName(pair: { byName: string } | { byId: string } | undefined): boolean {
  return pair !== undefined && 'byName' in pair;
}

/** Keep only the id half of a pair, for the paths where no library is available. */
function asIdOnly(pair: PairInput | undefined): PairInput | undefined {
  return pair !== undefined && 'byId' in pair ? pair : undefined;
}

function idOfEntryPair(entry: RawEntry, field: string): string | undefined {
  const pair = entryPair(entry, field);
  if (pair === undefined) return undefined;
  if ('byId' in pair) return pair.byId;
  throw new UsageError(`${entry.at}.${field} is a name, so --library <name|id> is required`, {
    hint: `pass --library, or use ${field}_id to send an id unchanged`,
  });
}

async function resolveEntryState(
  ctx: Ctx,
  entry: RawEntry,
  libraryId: string,
  resolutions: ResolveResult[],
): Promise<string | undefined> {
  const pair = entryPair(entry, 'state');
  if (pair === undefined) return undefined;
  if ('byId' in pair) return pair.byId;
  const resolved = await withConfigurationScope('case states', () =>
    resolveCaseState(ctx, libraryId, pair.byName),
  );
  resolutions.push(resolved);
  return resolved.id;
}

async function resolveEntryType(
  ctx: Ctx,
  entry: RawEntry,
  libraryId: string,
  resolutions: ResolveResult[],
): Promise<string | undefined> {
  const pair = entryPair(entry, 'type');
  if (pair === undefined) return undefined;
  if ('byId' in pair) return pair.byId;
  const resolved = await resolveCaseType(ctx, libraryId, pair.byName);
  resolutions.push(resolved);
  return resolved.id;
}

async function resolveEntryLevel(
  ctx: Ctx,
  entry: RawEntry,
  resolutions: ResolveResult[],
): Promise<string | undefined> {
  const pair = entryPair(entry, 'important_level');
  if (pair === undefined) return undefined;
  if ('byId' in pair) return pair.byId;
  const resolved = await resolveCaseImportantLevel(ctx, pair.byName);
  resolutions.push(resolved);
  return resolved.id;
}

async function resolveEntryUser(
  ctx: Ctx,
  entry: RawEntry,
  field: string,
  resolutions: ResolveResult[],
): Promise<string | undefined> {
  const pair = entryPair(entry, field);
  if (pair === undefined) return undefined;
  if ('byId' in pair) return pair.byId;
  const resolved = await resolveUser(ctx, pair.byName);
  resolutions.push(resolved);
  return resolved.id;
}

function optionalText(entry: RawEntry, key: string): Record<string, string | undefined> {
  const value = optionalEntryString(entry, key);
  return value === undefined ? {} : { [key]: value };
}

function participantIds(entry: RawEntry): { participant_ids?: string[] } {
  const value = entry.record.participant_ids;
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new UsageError(`${entry.at}.participant_ids must be an array of id strings`);
  }
  return { participant_ids: value as string[] };
}

function propertiesOfEntry(entry: RawEntry): Record<string, unknown> {
  const properties = entryProperties(entry);
  return properties === undefined ? {} : { properties };
}

function stepsOfEntry(entry: RawEntry): Record<string, unknown> {
  const steps = entrySteps(entry);
  return steps === undefined ? {} : { steps };
}

/** A `Ref`'s `short_id`, when the payload carried one; `Ref`'s extra keys are `unknown`. */
function refShortId(ref: { id: string; [key: string]: unknown } | undefined): string {
  if (ref === undefined) return '';
  const shortId = ref.short_id;
  return typeof shortId === 'string' && shortId !== '' ? shortId : ref.id;
}
