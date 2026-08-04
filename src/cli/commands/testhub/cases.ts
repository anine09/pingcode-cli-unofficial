import type { Command } from 'commander';
import {
  createCase,
  getCase,
  iterateCases,
  searchCases,
  updateCase,
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
} from '../../../core/metadata';
import { collect, type SearchPayload } from '../../../core/paginate';
import type { TestCase } from '../../../types/api';
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
} from './libraries';

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
 * Ship points at `product meta {idea,ticket}-properties`; testhub has no property
 * lookup leaf in this milestone (`GET /v1/testhub/case/properties` is outside the
 * endpoint set), so pointing anywhere would name a command that does not exist.
 * The honest answer is: read the keys off a case you already have.
 */
export const SET_HINT =
  'pass --set <key>=<value>. testhub has no property-lookup command in this milestone: read the ' +
  'keys off an existing case with `pingcode testhub cases get <case> --json`';

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
