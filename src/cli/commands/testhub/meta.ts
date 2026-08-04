import { Option, type Command } from 'commander';
import {
  caseStates,
  caseTypes,
  importantLevels,
  iterateSuites,
  planTypes,
  runStatuses,
} from '../../../api/testhub';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { SUITE_PATH_SEPARATOR } from '../../../core/metadata';
import { collect } from '../../../core/paginate';
import type {
  TestCaseImportantLevel,
  TestCaseState,
  TestCaseType,
  TestPlanType,
  TestRunStatus,
  TestSuite,
} from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { type Column } from '../../output';
import { contextFor, modeOf, printCollection, refName } from '../common';
import {
  addPairOptions,
  CONFIGURATION_SCOPE,
  LIBRARY_HELP,
  refId,
  requireLibraryFlag,
  withConfigurationScope,
  type LibraryFlags,
} from './libraries';

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

/**
 * `pingcode testhub meta …` — the ids a testhub write cannot be built without.
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
export function registerTesthubMetaCommands(parent: Command): void {
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
