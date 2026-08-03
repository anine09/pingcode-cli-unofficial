import type { Command } from 'commander';
import {
  createPlatform,
  getPlatform,
  iteratePlatforms,
  listPlatforms,
  updatePlatform,
  type PlatformListQuery,
  type UpdatePlatformInput,
} from '../../../api/scm';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { resolvePlatform, type MetaKind, type ResolveResult } from '../../../core/metadata';
import { collect } from '../../../core/paginate';
import type { ScmPlatform } from '../../../types/api';
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
  requireFlag,
  runWrite,
  type PagingFlags,
  type ResolvedWrite,
} from '../common';

/**
 * `pingcode scm platform …` — 托管平台 ([S§3.12.1]), **plus the `--platform`
 * plumbing the rest of the scm group is built on**.
 *
 * A hosting platform is the bootstrap hop of the whole module: a repository, a git
 * identity and (S1b/S1c) a branch, commit ref, pull request or code review are all
 * addressed *under* one, so every other scm command starts by resolving
 * `--platform` here. That is why `resolvePlatformFlag` / `requirePlatformFlag` and
 * the generic `--x` / `--x-id` pair helpers live in this file rather than in
 * `scm/index.ts`: `index.ts` only registers, and importing helpers *from* it would
 * make the group's modules circular. `ticket.ts` importing `present` from `idea.ts`
 * sets the same precedent.
 *
 * **It is not a ship product.** `/v1/scm/products` and `/v1/ship/products` share a
 * URL segment and nothing else, which is exactly why the command is called
 * `platform` and the resolver kind is `scm-platform`.
 *
 * There is no `delete`: the API exposes none for any of the three families S1a
 * covers, so — as in ship — one cannot be added later either. And there is no
 * `replace`: `PUT /v1/scm/products/{id}` exists upstream but is excluded by design
 * (D8.4), because it blanks every field the caller omits. Use `update` (PATCH), or
 * `pingcode api PUT /v1/scm/products/<id>` if a full replacement is genuinely what
 * you want.
 */

// ---------------------------------------------------------------------------
// shared: the --x / --x-id pair, and the platform hop
// ---------------------------------------------------------------------------

export const PLATFORM_HELP = 'hosting platform 托管平台 name or id';

export type PlatformFlags = { platform?: string | undefined; platformId?: string | undefined };

/**
 * Declare a `--x` / `--x-id` pair: the name variant resolves, the id variant is
 * sent verbatim, and the two are mutually exclusive.
 *
 * Same contract as ship's `addShipStateOptions` and testhub's `addPairOptions`.
 * This is the third copy of a ~30-line idea, which is the point at which the reuse
 * guide says to promote it — but the two existing copies live in files other
 * children are editing right now (S3 is splitting `testhub.ts`), so promoting it
 * into `cli/commands/common.ts` today would create a merge point for no functional
 * gain. Kept scm-local and deliberately generic, so S1b/S1c can declare their
 * `--repo` / `--branch` pairs from it without a fourth copy.
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

/** An id the user supplied: no lookup, no shape check, and no cache key to invalidate. */
export function passThrough(kind: MetaKind, id: string): ResolveResult {
  return { kind, input: id, id, name: undefined, fromCache: false, cacheKey: null };
}

export async function resolvePairInput(
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

export function addPlatformOptions(command: Command): Command {
  return addPairOptions(command, 'platform', PLATFORM_HELP);
}

export async function resolvePlatformFlag(
  ctx: Ctx,
  flags: PlatformFlags,
): Promise<ResolveResult | undefined> {
  return await resolvePairInput(
    'scm-platform',
    readPair('platform', flags.platform, flags.platformId),
    (input) => resolvePlatform(ctx, input),
  );
}

/** Every platform-scoped scm command starts here: no platform id, no lookups at all. */
export async function requirePlatformFlag(
  ctx: Ctx,
  flags: PlatformFlags,
): Promise<ResolveResult> {
  const platform = await resolvePlatformFlag(ctx, flags);
  if (platform === undefined) {
    throw new UsageError('--platform <name|id> is required', {
      hint:
        'repositories and git identities are addressed under a hosting platform, so nothing in ' +
        'scm is reachable without one. List them with `pingcode scm platform list`',
    });
  }
  return platform;
}

// ---------------------------------------------------------------------------
// platform leaves
// ---------------------------------------------------------------------------

/** The nine documented `type` values, quoted in `--help` rather than enforced. */
const PLATFORM_TYPES = 'github | gitlab | bitbucket | coding.net | gogs | git | svn | gerrit | other';

type ListFlags = PagingFlags & { name?: string | undefined };

type CreateFlags = { name: string; type: string; description?: string | undefined };

type UpdateFlags = {
  name?: string | undefined;
  type?: string | undefined;
  description?: string | undefined;
};

export const PLATFORM_COLUMNS: Column<ScmPlatform>[] = [
  { header: 'ID', value: (platform) => platform.id },
  { header: 'NAME', value: (platform) => platform.name ?? '', flex: true },
  { header: 'TYPE', value: (platform) => platform.type ?? '' },
  { header: 'DESCRIPTION', value: (platform) => platform.description ?? '', flex: true },
];

export function registerPlatformCommands(parent: Command): void {
  const group = parent
    .command('platform')
    .description('hosting platforms 托管平台 — the parent of every other scm resource');

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list hosting platforms')
        .option(
          '--name <name>',
          'exact (case-insensitive) platform name — this filter is not a search',
        ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one hosting platform')
      .argument('<platform>', PLATFORM_HELP),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    await runGet(target, command);
  });

  addGlobalOptions(
    group
      .command('create')
      .description('register a hosting platform (the name must be unique in the organisation)')
      .requiredOption('--name <name>', 'platform name, unique per organisation')
      .requiredOption('--type <type>', `platform type, one of: ${PLATFORM_TYPES}`)
      .option('--description <text>', 'description'),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    group
      .command('update')
      .description('patch a hosting platform — only the fields you pass are sent')
      .argument('<platform>', PLATFORM_HELP)
      .option('--name <name>', 'new name, unique per organisation')
      .option('--type <type>', `new type, one of: ${PLATFORM_TYPES}`)
      .option('--description <text>', 'new description (replaces the old one)'),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });
}

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const query: PlatformListQuery = flags.name === undefined ? {} : { name: flags.name };

  if (paging.all) {
    const values = await collect(
      iteratePlatforms(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, PLATFORM_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listPlatforms(ctx, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, PLATFORM_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const platform = await resolvePlatform(ctx, requireFlag(target, '<platform>'));
  printPlatform(await getPlatform(ctx, platform.id), ctx);
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const name = requireFlag(flags.name, '--name');
  const type = requireFlag(flags.type, '--type');

  // Nothing to resolve: a platform has no parent and `type` is a literal enum value,
  // deliberately not validated here — a value the server later accepts must not be
  // refused by a CLI that shipped before it.
  const platform = await createPlatform(ctx, {
    name,
    type,
    ...(flags.description === undefined ? {} : { description: flags.description }),
  });
  printPlatform(platform, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const patch: UpdatePlatformInput = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.type === undefined ? {} : { type: flags.type }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint: 'pass at least one of --name / --type / --description',
    });
  }

  const platform = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<string>> => {
      const resolved = await resolvePlatform(attemptCtx, requireFlag(target, '<platform>'));
      return { resolutions: [resolved], value: resolved.id };
    },
    async (attemptCtx, platformId) => await updatePlatform(attemptCtx, platformId, patch),
  );
  printPlatform(platform, ctx, 'updated');
}

export function printPlatform(platform: ScmPlatform, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    platform,
    [
      ['name', platform.name ?? ''],
      ['id', platform.id],
      ['type', platform.type ?? ''],
      ['url', platform.url ?? ''],
      ['description', platform.description ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${platform.name ?? platform.id}`));
  }
}
