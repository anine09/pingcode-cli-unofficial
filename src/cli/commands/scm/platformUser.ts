import type { Command } from 'commander';
import {
  createPlatformUser,
  getPlatformUser,
  iteratePlatformUsers,
  listPlatformUsers,
  updatePlatformUser,
  type PlatformUserListQuery,
  type UpdatePlatformUserInput,
} from '../../../api/scm';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { collect } from '../../../core/paginate';
import type { ScmPlatformUser } from '../../../types/api';
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
  runWrite,
  type PagingFlags,
  type ResolvedWrite,
} from '../common';
import {
  addPlatformOptions,
  present,
  requirePlatformFlag,
  type PlatformFlags,
} from './platform';

/**
 * `pingcode scm platform-user …` — 托管平台用户 ([S§3.12.2]).
 *
 * **What this resource is, because the name misleads twice.** It is neither a
 * PingCode member nor a link to one: it is a *git author identity* on one hosting
 * platform, `{name, display_name, html_url, avatar_url}`. Verified live
 * 2026-08-03 — the response carries no `user`, no `user_id` and no `email`, and
 * neither create nor update accepts such a field.
 *
 * **Why it is nonetheless load-bearing.** Attribution in the write-back API is by
 * *name string*: a commit carries `committer_name` and a branch carries
 * `sender_name` ([S§3.12.7]), and those strings are matched against these records.
 * A commit written for a name that has no platform user therefore has nothing to
 * hang an avatar, a display name or a profile link on — which is what "the commit
 * attaches to nobody" means in practice. Creating these rows is a prerequisite for
 * S1b's commit write-back, not optional configuration.
 *
 * **The positional is an id, on purpose.** Ids in this API come in three shapes and
 * are never validated client-side (research §6.8), so `get`/`update` cannot guess
 * whether `steins-tech` is a name or an id. The lookup that *is* available is the
 * server-side exact filter on the list endpoint, so the documented route from a git
 * username to an id is one command:
 *
 * ```bash
 * pingcode scm platform-user list --platform Github --name steins-tech --json
 * ```
 *
 * No `scm-platform-user` resolver kind is registered for the same reason: with a
 * name unique per platform and an exact filter already available, a metadata kind
 * would add a cached list and a second failure mode without making anything
 * reachable that is not reachable now.
 *
 * No `delete` (the API has none) and no `replace`: `PUT …/users/{id}` is excluded by
 * design (D8.4) and reachable only as
 * `pingcode api PUT /v1/scm/products/<platform>/users/<user>`.
 */

const USER_HELP =
  'platform user id — find one with `scm platform-user list --platform <p> --name <git-username>`';

type ListFlags = PagingFlags & PlatformFlags & { name?: string | undefined };

type CreateFlags = PlatformFlags & {
  name: string;
  displayName?: string | undefined;
  htmlUrl?: string | undefined;
  avatarUrl?: string | undefined;
};

type UpdateFlags = PlatformFlags & {
  name?: string | undefined;
  displayName?: string | undefined;
  htmlUrl?: string | undefined;
  avatarUrl?: string | undefined;
};

export const PLATFORM_USER_COLUMNS: Column<ScmPlatformUser>[] = [
  { header: 'ID', value: (user) => user.id },
  { header: 'NAME', value: (user) => user.name ?? '', flex: true },
  { header: 'DISPLAY NAME', value: (user) => user.display_name ?? '' },
  { header: 'PROFILE', value: (user) => user.html_url ?? '', flex: true },
];

export function registerPlatformUserCommands(parent: Command): void {
  const group = parent
    .command('platform-user')
    .description('git author identities 托管平台用户 — what commit attribution matches by name');

  addGlobalOptions(
    addPagingOptions(
      addPlatformOptions(
        group
          .command('list')
          .description('list the git identities known to a platform')
          .option('--name <name>', 'exact (case-insensitive) git username — not a search'),
      ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    addPlatformOptions(
      group.command('get').description('show one git identity').argument('<user>', USER_HELP),
    ),
    { hidden: true },
  ).action(async (target: string, flags: PlatformFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    addPlatformOptions(
      group
        .command('create')
        .description('register a git identity (the username must be unique on the platform)')
        .requiredOption('--name <name>', 'git username — the string commits are attributed by')
        .option('--display-name <text>', 'display name shown in PingCode')
        .option('--html-url <url>', 'profile page on the hosting platform')
        .option('--avatar-url <url>', 'avatar image on the hosting platform'),
    ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    addPlatformOptions(
      group
        .command('update')
        .description('patch a git identity — only the fields you pass are sent')
        .argument('<user>', USER_HELP)
        .option('--name <name>', 'new git username (unique per platform)')
        .option('--display-name <text>', 'new display name')
        .option('--html-url <url>', 'new profile page')
        .option('--avatar-url <url>', 'new avatar image'),
    ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });
}

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const platform = await requirePlatformFlag(ctx, flags);
  const query: PlatformUserListQuery = flags.name === undefined ? {} : { name: flags.name };

  if (paging.all) {
    const values = await collect(
      iteratePlatformUsers(ctx, platform.id, query, {
        pageSize: paging.pageSize,
        limit: paging.limit,
      }),
    );
    printCollection(values, PLATFORM_USER_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listPlatformUsers(ctx, platform.id, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, PLATFORM_USER_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: PlatformFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const platform = await requirePlatformFlag(ctx, flags);
  const userId = requireFlag(target, '<user>');
  printPlatformUser(await getPlatformUser(ctx, platform.id, userId), ctx);
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const name = requireFlag(flags.name, '--name');

  const user = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<string>> => {
      const platform = await requirePlatformFlag(attemptCtx, flags);
      return { resolutions: present([platform]), value: platform.id };
    },
    async (attemptCtx, platformId) =>
      await createPlatformUser(attemptCtx, platformId, {
        name,
        ...(flags.displayName === undefined ? {} : { display_name: flags.displayName }),
        ...(flags.htmlUrl === undefined ? {} : { html_url: flags.htmlUrl }),
        ...(flags.avatarUrl === undefined ? {} : { avatar_url: flags.avatarUrl }),
      }),
  );
  printPlatformUser(user, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const userId = requireFlag(target, '<user>');

  const patch: UpdatePlatformUserInput = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.displayName === undefined ? {} : { display_name: flags.displayName }),
    ...(flags.htmlUrl === undefined ? {} : { html_url: flags.htmlUrl }),
    ...(flags.avatarUrl === undefined ? {} : { avatar_url: flags.avatarUrl }),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint: 'pass at least one of --name / --display-name / --html-url / --avatar-url',
    });
  }

  const user = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<string>> => {
      const platform = await requirePlatformFlag(attemptCtx, flags);
      return { resolutions: present([platform]), value: platform.id };
    },
    async (attemptCtx, platformId) =>
      await updatePlatformUser(attemptCtx, platformId, userId, patch),
  );
  printPlatformUser(user, ctx, 'updated');
}

function printPlatformUser(user: ScmPlatformUser, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    user,
    [
      ['name', user.name ?? ''],
      ['id', user.id],
      ['display name', user.display_name ?? ''],
      ['platform', refName(user.product)],
      ['profile', user.html_url ?? ''],
      ['avatar', user.avatar_url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${user.name ?? user.id}`));
  }
}
