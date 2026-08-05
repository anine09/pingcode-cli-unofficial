import type { Command } from 'commander';
import {
  createRepository,
  getRepository,
  iterateRepositories,
  listRepositories,
  updateRepository,
  type CreateRepositoryInput,
  type RepositoryListQuery,
  type UpdateRepositoryInput,
} from '../../../api/scm';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { resolveRepository } from '../../../core/metadata';
import { collect } from '../../../core/paginate';
import type { ScmRepository } from '../../../types/api';
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
  timestampCell,
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
 * `pingcode scm repo …` — 代码仓库 ([S§3.12.3]).
 *
 * Three things a caller has to know, all of them upstream facts:
 *
 *  - **`full_name` (`owner/name`) is the unique key**, not `name`: a fork and its
 *    upstream, or two orgs' `.github`, collide freely inside one platform. It is
 *    also the *only* filter the list endpoint honours — `?name=` is silently
 *    ignored and returns everything (live 2026-08-03), which is why the list flag
 *    is `--full-name`. The `<repo>` positional accepts a name, a `full_name` or an
 *    id, resolved client-side, and a colliding name is an ambiguity error listing
 *    the candidates rather than a silent pick of the first.
 *  - **`owner_name` is a string, and it is an upsert**: the write takes a git
 *    username and the server turns it into the `owner` reference — creating a
 *    platform user on the spot if that name is unknown. Verified live 2026-08-03:
 *    `--owner-name no-such-git-user` returned 200 with a brand-new owner id, and the
 *    identity then showed up in `scm platform-user list`. So a typo here does not
 *    fail, it silently manufactures a ghost identity that no endpoint can delete.
 *  - **The four `*_url` templates are stored verbatim**, placeholders and all
 *    (`{branch}`, `{sha}`, `{base}...{head}`, `{number}`). PingCode substitutes
 *    them when it renders a link; the CLI never interpolates them, so `--commits-url
 *    'https://github.com/o/r/commit/{sha}'` is exactly right — quote it, or the
 *    shell may eat the braces.
 *
 * No `delete` (the API has none) and no `replace`: `PUT …/repositories/{id}` is
 * excluded by design (D8.4) and reachable only as
 * `pingcode api PUT /v1/scm/products/<platform>/repositories/<repo>`.
 */

const REPO_HELP = 'repository name, full_name (owner/name) or id';

/**
 * `--fork` / `--private` take a value rather than being bare switches.
 *
 * A bare `--private` could only ever set the flag *true*, and `is_private` is a
 * field an update legitimately needs to clear — a repository that goes public is
 * not an exotic case. `commander`'s `--no-private` negation would instead default
 * the field to `true` when the flag is absent, which would silently send
 * `is_private: true` on every create that did not mention it. A three-state value
 * flag (absent / `true` / `false`) is the only shape that both writes are honest
 * about.
 */
const BOOLEAN_HELP = 'true|false';

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off']);

function parseBooleanFlag(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_WORDS.has(normalized)) return true;
  if (FALSE_WORDS.has(normalized)) return false;
  throw new UsageError(`${flag} expects ${BOOLEAN_HELP}, got "${value}"`, {
    hint: `pass ${flag} true or ${flag} false — omit the flag to leave the field alone`,
  });
}

type ListFlags = PagingFlags & PlatformFlags & { fullName?: string | undefined };

/** The fields create and update share; `name` / `full_name` differ in requiredness. */
type RepoFieldFlags = {
  description?: string | undefined;
  fork?: string | undefined;
  private?: string | undefined;
  ownerName?: string | undefined;
  htmlUrl?: string | undefined;
  branchesUrl?: string | undefined;
  commitsUrl?: string | undefined;
  compareUrl?: string | undefined;
  pullsUrl?: string | undefined;
};

type CreateFlags = PlatformFlags & RepoFieldFlags & { name: string; fullName: string };

type UpdateFlags = PlatformFlags &
  RepoFieldFlags & { name?: string | undefined; fullName?: string | undefined };

export const REPOSITORY_COLUMNS: Column<ScmRepository>[] = [
  { header: 'ID', value: (repo) => repo.id },
  { header: 'FULL NAME', value: (repo) => repo.full_name ?? repo.name ?? '', flex: true },
  { header: 'OWNER', value: (repo) => refName(repo.owner) },
  { header: 'PRIVATE', value: (repo) => (repo.is_private ? 'yes' : 'no') },
  { header: 'FORK', value: (repo) => (repo.is_fork ? 'yes' : 'no') },
];

/** The optional field flags, declared once for `create` and `update`. */
function addRepoFieldOptions(command: Command): Command {
  return command
    .option('--description <text>', 'description (replaces the old one)')
    .option(
      '--owner-name <name>',
      'owner git username — an unknown name is CREATED as a platform user, not rejected',
    )
    .option('--private <bool>', `is the repository private (${BOOLEAN_HELP})`)
    .option('--fork <bool>', `is the repository a fork (${BOOLEAN_HELP})`)
    .option('--html-url <url>', 'repository page on the hosting platform')
    .option('--branches-url <url>', 'branch link template, using {branch}')
    .option('--commits-url <url>', 'commit link template, using {sha}')
    .option('--compare-url <url>', 'compare link template, using {base} and {head}')
    .option('--pulls-url <url>', 'pull request link template, using {number}');
}

export function registerRepoCommands(parent: Command): void {
  const group = parent
    .command('repo')
    .description('code repositories 代码仓库 — full_name (owner/name) is the unique key');

  addGlobalOptions(
    addPagingOptions(
      addPlatformOptions(
        group
          .command('list')
          .description('list the repositories of a platform')
          .option(
            '--full-name <owner/name>',
            'exact full_name filter — the only filter this endpoint honours (?name= is ignored)',
          ),
      ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    addPlatformOptions(
      group.command('get').description('show one repository').argument('<repo>', REPO_HELP),
    ),
    { hidden: true },
  ).action(async (target: string, flags: PlatformFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    addRepoFieldOptions(
      addPlatformOptions(
        group
          .command('create')
          .description(
            'register a repository — PERMANENT: there is no repository delete. full_name must be ' +
              'unique on the platform, and a mistyped --owner-name mints a permanent identity too',
          )
          .requiredOption('--name <name>', 'repository name, e.g. pingcode-cli')
          .requiredOption('--full-name <owner/name>', 'unique full name, e.g. acme/pingcode-cli'),
      ),
    ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    addRepoFieldOptions(
      addPlatformOptions(
        group
          .command('update')
          .description('patch a repository — only the fields you pass are sent')
          .argument('<repo>', REPO_HELP)
          .option('--name <name>', 'new repository name')
          .option('--full-name <owner/name>', 'new full name (unique per platform)'),
      ),
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
  const query: RepositoryListQuery =
    flags.fullName === undefined ? {} : { full_name: flags.fullName };

  if (paging.all) {
    const values = await collect(
      iterateRepositories(ctx, platform.id, query, {
        pageSize: paging.pageSize,
        limit: paging.limit,
      }),
    );
    printCollection(values, REPOSITORY_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listRepositories(ctx, platform.id, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, REPOSITORY_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: PlatformFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const platform = await requirePlatformFlag(ctx, flags);
  const repo = await resolveRepository(ctx, platform.id, requireFlag(target, '<repo>'));
  printRepository(await getRepository(ctx, platform.id, repo.id), ctx);
}

/**
 * The optional body fields, shared by create and update. Validation happens here.
 *
 * The return type excludes `name` / `full_name` on purpose: they are required on
 * create and optional on update, so letting them through here would make the
 * spread in `runCreate` widen them back to optional.
 */
function fieldsFrom(flags: RepoFieldFlags): Omit<UpdateRepositoryInput, 'name' | 'full_name'> {
  const isFork = parseBooleanFlag(flags.fork, '--fork');
  const isPrivate = parseBooleanFlag(flags.private, '--private');
  return {
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(flags.ownerName === undefined ? {} : { owner_name: flags.ownerName }),
    ...(isFork === undefined ? {} : { is_fork: isFork }),
    ...(isPrivate === undefined ? {} : { is_private: isPrivate }),
    ...(flags.htmlUrl === undefined ? {} : { html_url: flags.htmlUrl }),
    ...(flags.branchesUrl === undefined ? {} : { branches_url: flags.branchesUrl }),
    ...(flags.commitsUrl === undefined ? {} : { commits_url: flags.commitsUrl }),
    ...(flags.compareUrl === undefined ? {} : { compare_url: flags.compareUrl }),
    ...(flags.pullsUrl === undefined ? {} : { pulls_url: flags.pullsUrl }),
  };
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const input: CreateRepositoryInput = {
    name: requireFlag(flags.name, '--name'),
    full_name: requireFlag(flags.fullName, '--full-name'),
    ...fieldsFrom(flags),
  };

  const repo = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<string>> => {
      const platform = await requirePlatformFlag(attemptCtx, flags);
      return { resolutions: present([platform]), value: platform.id };
    },
    async (attemptCtx, platformId) => await createRepository(attemptCtx, platformId, input),
  );
  printRepository(repo, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const patch: UpdateRepositoryInput = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.fullName === undefined ? {} : { full_name: flags.fullName }),
    ...fieldsFrom(flags),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --name / --full-name / --description / --owner-name / --private / ' +
        '--fork / --html-url / --branches-url / --commits-url / --compare-url / --pulls-url',
    });
  }

  const repo = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<{ platformId: string; repoId: string }>> => {
      const platform = await requirePlatformFlag(attemptCtx, flags);
      const resolved = await resolveRepository(
        attemptCtx,
        platform.id,
        requireFlag(target, '<repo>'),
      );
      return {
        resolutions: present([platform, resolved]),
        value: { platformId: platform.id, repoId: resolved.id },
      };
    },
    async (attemptCtx, value) =>
      await updateRepository(attemptCtx, value.platformId, value.repoId, patch),
  );
  printRepository(repo, ctx, 'updated');
}

function printRepository(repo: ScmRepository, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    repo,
    [
      ['full name', repo.full_name ?? ''],
      ['name', repo.name ?? ''],
      ['id', repo.id],
      ['platform', refName(repo.product)],
      ['owner', refName(repo.owner)],
      ['private', repo.is_private ? 'yes' : 'no'],
      ['fork', repo.is_fork ? 'yes' : 'no'],
      ['created', timestampCell(repo.created_at)],
      ['page', repo.html_url ?? ''],
      ['description', repo.description ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${repo.full_name ?? repo.name ?? repo.id}`));
  }
}
