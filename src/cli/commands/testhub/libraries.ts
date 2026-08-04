import type { Command } from 'commander';
import {
  createLibrary,
  getLibrary,
  iterateLibraries,
  listLibraries,
  type CreateLibraryInput,
  type LibraryListQuery,
} from '../../../api/testhub';
import type { Ctx } from '../../../core/context';
import { PermissionError, UsageError } from '../../../core/errors';
import {
  resolveTestLibrary,
  type MetaKind,
  type ResolveResult,
} from '../../../core/metadata';
import { collect } from '../../../core/paginate';
import type { TestLibrary } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  addPagingOptions,
  contextFor,
  modeOf,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refName,
  requireFlag,
  timestampCell,
  type PagingFlags,
} from '../common';

/**
 * `pingcode testhub libraries …` — the entry point of the module, and the home of
 * the machinery every other file in this directory imports.
 *
 * The same shape `scm/platform.ts` has: the bootstrap resource owns the flag-pair
 * helpers and the parent hop, because every sibling needs them and nothing else
 * does. That is why `readPair` / `resolvePair` / `requireLibraryFlag` /
 * `withConfigurationScope` are exported from here rather than from a fourth
 * "shared" file (design D6.5 asked for five resource files, not six).
 */

// ---------------------------------------------------------------------------
// scopes and shared help text
// ---------------------------------------------------------------------------

export const CONFIGURATION_SCOPE = 'pcp:read:testhub:configuration';

export const LIBRARY_HELP = 'test library name, identifier such as LIB, or id';

export const SHORT_ID_WRITE_CAVEAT =
  'a short_id is accepted on reads but rejected by every write, so this is resolved to a real id first';

// ---------------------------------------------------------------------------
// flag pairs: --x resolves by name, --x-id is sent verbatim (design §6)
// ---------------------------------------------------------------------------

export type LibraryFlags = { library?: string | undefined; libraryId?: string | undefined };

/**
 * Declare a `--x` / `--x-id` pair.
 *
 * Same contract as ship's `addShipStateOptions`, generalised because testhub has
 * seven of these rather than one: the name variant triggers a lookup, the id
 * variant is passed through untouched, and no id is ever shape-validated —
 * testhub ids are 24-hex, `short_id`s are 8-char base62 and users are 32-hex.
 */
export function addPairOptions(command: Command, flag: string, description: string): Command {
  return command
    .option(`--${flag} <name|id>`, description)
    .option(`--${flag}-id <id>`, `${description} (an id, sent unchanged with no lookup)`);
}

export type PairInput = { byId: string } | { byName: string };

/** Reject `--x` together with `--x-id` before anything is sent (exit 2). */
export function readPair(
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

export function passThrough(kind: MetaKind, id: string): ResolveResult {
  // No lookup, no shape check, and no cache key — so nothing to invalidate later.
  return { kind, input: id, id, name: undefined, fromCache: false, cacheKey: null };
}

export async function resolvePair(
  kind: MetaKind,
  pair: PairInput | undefined,
  resolve: (input: string) => Promise<ResolveResult>,
): Promise<ResolveResult | undefined> {
  if (pair === undefined) return undefined;
  if ('byId' in pair) return passThrough(kind, pair.byId);
  return await resolve(pair.byName);
}

export function present(resolutions: (ResolveResult | undefined)[]): ResolveResult[] {
  return resolutions.filter((resolution): resolution is ResolveResult => resolution !== undefined);
}

// ---------------------------------------------------------------------------
// the library hop
// ---------------------------------------------------------------------------

export async function resolveLibraryFlag(
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
export async function requireLibraryFlag(ctx: Ctx, flags: LibraryFlags): Promise<ResolveResult> {
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
export async function withConfigurationScope<T>(what: string, run: () => Promise<T>): Promise<T> {
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
// small helpers
// ---------------------------------------------------------------------------

export function refId(ref: { id: string } | undefined): string | undefined {
  const id = ref?.id;
  return id === undefined || id === '' ? undefined : id;
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
export function registerLibraryCommands(parent: Command): void {
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
