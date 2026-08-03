import type { Command } from 'commander';
import {
  createBranch,
  deleteBranch,
  getBranch,
  iterateBranches,
  listBranches,
  updateBranch,
  type BranchListQuery,
  type CreateBranchInput,
  type UpdateBranchInput,
} from '../../../api/scm';
import type { Ctx } from '../../../core/context';
import { PingcodeError, UsageError } from '../../../core/errors';
import { resolveRepository, type ResolveResult } from '../../../core/metadata';
import { collect } from '../../../core/paginate';
import type { ScmBranch } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  addPagingOptions,
  collectValue,
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
  identifiersOf,
  warnUnlinkedWorkItems,
  workItemIdentifiers,
} from '../_shared/workItems';
import { addPlatformOptions, present, requirePlatformFlag, type PlatformFlags } from './platform';

/**
 * `pingcode scm branch …` — 代码分支 ([S§3.12.4]).
 *
 * **This family is shaped differently from every other one in scm, in exactly one
 * way: it has a `DELETE` and no `PUT`.** The other five (platform, platform-user,
 * repo, PR, review) have the mirror shape. So there is nothing "missing" here to
 * complete: a `replace`/`put` leaf must never be added (design D8.4, asserted in
 * `test/help/scm.test.ts`), and `delete` is not the first of a set — nothing else in
 * scm can grow one.
 *
 * Four upstream behaviours the flags are shaped around, all verified live
 * 2026-08-03 (design D12) rather than read off the docs:
 *
 *  - **`--sender` is an upsert.** An unknown git username is not rejected: the server
 *    creates a 托管平台用户 for it on the spot. scm has no identity `DELETE`, so a
 *    typo leaves a permanent ghost row in the tenant. This is *the* footgun of the
 *    family — and note it does **not** apply to `scm commit create --committer`,
 *    which creates nothing.
 *  - **`--default` is a bare switch, not `true|false`.** `PATCH is_default: false` is
 *    refused by the server (400 `100005`, "值不为true"): on a patch the field is an
 *    *action* — "make this the default" — and it additionally clears the flag on
 *    whichever branch held it, so one call changes two rows. `scm repo` uses
 *    three-state value flags for `--private`/`--fork` because clearing those is a
 *    real operation; clearing this one does not exist in the API, so offering
 *    `--default false` would only manufacture a guaranteed rejection.
 *  - **`--work-item` links silently fail.** An identifier that does not exist is
 *    dropped and the call still returns 200, so the response's `work_items` is the
 *    only evidence. Every write here compares the two and warns on the difference
 *    (see `warnUnlinkedWorkItems`) — the exit code stays 0, because the server did
 *    succeed and `--json` carries the truth.
 *  - **deleting is worse than it looks.** The default branch cannot be deleted at all
 *    (400 `100223`), and deleting any branch **orphans its 提交引用**: afterwards
 *    `scm ref list` for that branch answers HTTP 500 while the refs still read by id,
 *    and refs have no `DELETE`. That is why the `--yes` consequence text is specific
 *    instead of the usual "there is no undo".
 *
 * Branch names are **unique per repository** and `?name=` is an exact,
 * case-insensitive filter that upstream genuinely honours — unlike the repository
 * list's, which it ignores. Those two facts together are why branch references are
 * resolved right here in one request instead of through `core/metadata`; see
 * `resolveBranchRef`.
 */

const BRANCH_HELP = 'branch name or id';

/** The `--work-item` help text, shared by create and update. */
const WORK_ITEM_HELP =
  'work item identifier such as PLM-001, repeatable — an unknown one is silently ignored by the API';

type RepoFlags = PlatformFlags & { repo?: string | undefined; repoId?: string | undefined };

type ListFlags = PagingFlags &
  RepoFlags & { name?: string | undefined; workItemId?: string | undefined };

type CreateFlags = RepoFlags & {
  name: string;
  sender: string;
  default?: boolean | undefined;
  workItem?: string[] | undefined;
};

type UpdateFlags = RepoFlags & {
  default?: boolean | undefined;
  workItem?: string[] | undefined;
};

type DeleteFlags = RepoFlags & { yes?: boolean | undefined };

export const BRANCH_COLUMNS: Column<ScmBranch>[] = [
  { header: 'ID', value: (branch) => branch.id },
  { header: 'NAME', value: (branch) => branch.name ?? '', flex: true },
  { header: 'DEFAULT', value: (branch) => (branch.is_default ? 'yes' : '') },
  { header: 'SENDER', value: (branch) => refName(branch.sender) },
  { header: 'WORK ITEMS', value: (branch) => identifiersOf(branch.work_items).join(' ') },
];

// ---------------------------------------------------------------------------
// the repository hop, shared with ref.ts
// ---------------------------------------------------------------------------

/**
 * `--repo` / `--repo-id`, declared here and reused by `ref.ts` — both families are
 * addressed under a (platform, repository) pair, and duplicating the pair helper
 * would be the fourth copy of a thing S1a already kept to one.
 */
export function addRepoOptions(command: Command): Command {
  return addPlatformOptions(command)
    .option('--repo <name|full_name|id>', 'repository name, full_name (owner/name) or id')
    .option('--repo-id <id>', 'repository id, sent unchanged with no lookup');
}

export type RepoScope = { platformId: string; repositoryId: string };

/**
 * Resolve the (platform, repository) pair every branch and ref command needs.
 *
 * Returns the resolutions as well as the ids so a write can hand them to `runWrite`
 * for the invalidate-and-retry-once path — a repository id resolved from a cached
 * list is exactly the kind of id that goes stale.
 */
export async function requireRepoScope(
  ctx: Ctx,
  flags: RepoFlags,
): Promise<{ scope: RepoScope; resolutions: ResolveResult[] }> {
  const platform = await requirePlatformFlag(ctx, flags);

  const byId = flags.repoId?.trim() ?? '';
  const byName = flags.repo?.trim() ?? '';
  if (byId !== '' && byName !== '') {
    throw new UsageError('--repo and --repo-id are mutually exclusive', {
      hint: 'use --repo <name|full_name> to resolve by name, or --repo-id <id> to send an id unchanged',
    });
  }
  if (byId === '' && byName === '') {
    throw new UsageError('--repo <name|full_name|id> is required', {
      hint:
        'branches and commit refs live inside a repository — list them with ' +
        '`pingcode scm repo list --platform <platform>`',
    });
  }

  if (byId !== '') {
    // Pass-through: no lookup, no shape check, and no cache key to invalidate.
    return {
      scope: { platformId: platform.id, repositoryId: byId },
      resolutions: present([platform]),
    };
  }

  const repo = await resolveRepository(ctx, platform.id, byName);
  return {
    scope: { platformId: platform.id, repositoryId: repo.id },
    resolutions: present([platform, repo]),
  };
}

// ---------------------------------------------------------------------------
// branch reference resolution — deliberately not a metadata kind
// ---------------------------------------------------------------------------

/**
 * Turn a branch name or id into an id, in **one request and with no cache**.
 *
 * This is not in `core/metadata/registry.ts`, and that is a considered decision
 * (design D12.7), for three reasons in order of weight:
 *
 *  1. **The registry cannot express it.** `ResolverSpec.path` has exactly one parent
 *     id slot; a branch is scoped by platform *and* repository. Adding it would mean
 *     changing F4's shared resolution engine, which is outside this child's write
 *     scope and too much surgery for one kind.
 *  2. **Caching would be actively wrong here.** A branch list is the one collection
 *     in scm that changes on every CI push. Under a 24 h TTL, a branch deleted and
 *     recreated under the same name would resolve to a dead id — a cache that
 *     produces wrong answers is worse than no cache.
 *  3. **It is not needed.** `?name=` is exact and case-insensitive upstream, and
 *     branch names are unique per repository (a duplicate create is 400 `100217`), so
 *     one filtered request is the complete answer and **there is no ambiguity case**
 *     to report. Repositories need a whole-list client-side scan precisely because
 *     they *do* collide.
 *
 * A miss is not an error: the input is passed through as an id, unvalidated, and the
 * server answers `100201` → exit 5 if it is not one. That keeps the "ids pass
 * through untouched" rule intact for the three id shapes this API uses.
 *
 * The **matched row** is returned, not just its id, so a caller that needs a field of
 * it (`delete` needs the name and `is_default` for its confirmation) gets them from
 * the request that was already made rather than paying for a second one.
 */
async function resolveBranchRef(
  ctx: Ctx,
  scope: RepoScope,
  input: string,
): Promise<{ id: string; branch: ScmBranch | undefined }> {
  const reference = requireFlag(input, '<branch>');
  const page = await listBranches(
    ctx,
    scope.platformId,
    scope.repositoryId,
    { name: reference },
    { pageSize: 2 },
  );
  const match = page.values[0];
  if (match !== undefined) return { id: match.id, branch: match };
  return { id: reference, branch: undefined };
}

// ---------------------------------------------------------------------------
// work item link verification
// ---------------------------------------------------------------------------

/**
 * The work-item link contract — `identifiersOf` / `oneLine` / `warnUnlinkedWorkItems` /
 * `workItemIdentifiers` — **re-exported, not defined here any more.**
 *
 * S1b put them in this file and S1c kept them here, deliberately: scm was the only
 * consumer, `branch.ts` was already the group's shared module, and promoting them into
 * `cli/commands/common.ts` would have made a merge point out of a file every parallel
 * child edits (design D13.6). S1d changed the input to that decision rather than the
 * reasoning: `build` and `release` carry the identical field pair with the identical
 * silent-drop behaviour (verified live 2026-08-04), and a build record importing from
 * `scm/branch.ts` would imply a relationship to code branches that does not exist.
 *
 * So the implementation moved to `_shared/workItems.ts` — beside `_shared/crosscutting.ts`,
 * which already owns command code belonging to no single group — and this re-export keeps
 * `commit.ts`, `ref.ts`, `pullRequest.ts` and `review.ts` importing from where they always
 * did. One implementation, no import churn in files this child does not own.
 */
export {
  identifiersOf,
  oneLine,
  warnUnlinkedWorkItems,
  workItemIdentifiers,
} from '../_shared/workItems';

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerBranchCommands(parent: Command): void {
  const group = parent
    .command('branch')
    .description('code branches 代码分支 — the one scm family with a delete and no replace');

  addGlobalOptions(
    addPagingOptions(
      addRepoOptions(
        group
          .command('list')
          .description('list the branches of a repository')
          .option(
            '--name <name>',
            'exact (case-insensitive) branch name — a real filter here, unlike on repo list',
          )
          .option('--work-item-id <id>', 'only branches linked to this work item id'),
      ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    addRepoOptions(
      group.command('get').description('show one branch').argument('<branch>', BRANCH_HELP),
    ),
    { hidden: true },
  ).action(async (target: string, flags: RepoFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    addRepoOptions(
      group
        .command('create')
        .description('record a branch (the name must be unique in the repository)')
        .requiredOption('--name <name>', 'branch name, e.g. feature/PLM-001-login')
        .requiredOption(
          '--sender <git-username>',
          'branch creator git username — an UNKNOWN name is CREATED as a platform user, ' +
            'and platform users cannot be deleted',
        )
        .option(
          '--default',
          'make this the default branch (clears the flag on the branch that holds it)',
        )
        .option('--work-item <identifier>', WORK_ITEM_HELP, collectValue),
    ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    addRepoOptions(
      group
        .command('update')
        .description('patch a branch — only the fields you pass are sent')
        .argument('<branch>', BRANCH_HELP)
        .option(
          '--default',
          'make this the default branch — there is no --default false: the API refuses it',
        )
        .option('--work-item <identifier>', `${WORK_ITEM_HELP}; REPLACES the existing links`, collectValue),
    ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });

  // No `addPagingOptions` here, so `--all` is rejected by commander as an unknown
  // option (design D8.2) — asserted in `test/help/scm.test.ts`.
  addGlobalOptions(
    addRepoOptions(
      group
        .command('delete')
        .description('delete a branch — irreversible, and it orphans the branch\u2019s commit refs')
        .argument('<branch>', BRANCH_HELP)
        .option('--yes', 'confirm the deletion — required, and there is no undo on this API'),
    ),
    { hidden: true },
  ).action(async (target: string, flags: DeleteFlags, command: Command) => {
    await runDelete(target, flags, command);
  });
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const { scope } = await requireRepoScope(ctx, flags);
  const query: BranchListQuery = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.workItemId === undefined ? {} : { work_item_id: flags.workItemId }),
  };

  if (paging.all) {
    const values = await collect(
      iterateBranches(ctx, scope.platformId, scope.repositoryId, query, {
        pageSize: paging.pageSize,
        limit: paging.limit,
      }),
    );
    printCollection(values, BRANCH_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listBranches(ctx, scope.platformId, scope.repositoryId, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, BRANCH_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: RepoFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const { scope } = await requireRepoScope(ctx, flags);
  const branch = await resolveBranchRef(ctx, scope, target);
  printBranch(await getBranch(ctx, scope.platformId, scope.repositoryId, branch.id), ctx);
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);
  const input: CreateBranchInput = {
    name: requireFlag(flags.name, '--name'),
    sender_name: requireFlag(flags.sender, '--sender'),
    // `is_default` is only sent when asked for: the server already defaults it to
    // false, except in an empty repository where the first branch becomes the default
    // whatever we send.
    ...(flags.default === true ? { is_default: true } : {}),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };

  const branch = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<RepoScope>> => {
      const { scope, resolutions } = await requireRepoScope(attemptCtx, flags);
      return { resolutions, value: scope };
    },
    async (attemptCtx, scope) =>
      await createBranch(attemptCtx, scope.platformId, scope.repositoryId, input),
  );
  warnUnlinkedWorkItems(ctx, identifiers, branch.work_items);
  printBranch(branch, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);

  const patch: UpdateBranchInput = {
    ...(flags.default === true ? { is_default: true } : {}),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'a branch has only two patchable fields: pass --default to make it the default, ' +
        'or --work-item <identifier> (repeatable) to replace its work item links',
    });
  }

  const branch = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<RepoScope & { branchId: string }>> => {
      const { scope, resolutions } = await requireRepoScope(attemptCtx, flags);
      const resolved = await resolveBranchRef(attemptCtx, scope, target);
      return { resolutions, value: { ...scope, branchId: resolved.id } };
    },
    async (attemptCtx, value) =>
      await updateBranch(attemptCtx, value.platformId, value.repositoryId, value.branchId, patch),
  );
  warnUnlinkedWorkItems(ctx, identifiers, branch.work_items);
  printBranch(branch, ctx, 'updated');
}

/**
 * The `--yes` gate (design D8.1), with the branch **name** in the confirmation.
 *
 * The name costs one request — the resolution that turns the reference into an id
 * already returns it, and when the caller passed an id we `GET` the branch to learn
 * it. That is the trade D8.1 prescribes: one request against the one irreversible
 * mistake this command can make, deleting the wrong branch. A confirmation that
 * echoes only the id the user just typed proves nothing.
 */
async function runDelete(target: string, flags: DeleteFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const { scope } = await requireRepoScope(ctx, flags);
  const resolved = await resolveBranchRef(ctx, scope, target);

  // The name lookup already returned the row; only an id reference needs a read, and
  // it needs one anyway — the confirmation must name what is about to go, and whether
  // it is the default branch (which the server refuses to delete at all).
  const branch =
    resolved.branch ?? (await getBranch(ctx, scope.platformId, scope.repositoryId, resolved.id));
  const name = branch.name ?? resolved.id;

  confirmBranchDeletion(flags, name, branch.is_default);

  try {
    const deleted = await deleteBranch(ctx, scope.platformId, scope.repositoryId, resolved.id);
    printBranch(deleted, ctx, 'deleted');
  } catch (error) {
    throw explainDeleteRefusal(error, name);
  }
}

function confirmBranchDeletion(flags: DeleteFlags, name: string, isDefault: boolean): void {
  if (flags.yes === true) return;
  throw new UsageError(`refusing to delete the branch "${name}" without --yes`, {
    hint:
      (isDefault
        ? 'this is the repository\u2019s default branch, and the API refuses to delete it — ' +
          'make another branch the default first (`scm branch update <other> --default`). '
        : '') +
      'deleting a branch cannot be undone, and it does not remove the commit refs pointing at ' +
      'it: those become unreadable as a list (HTTP 500) and refs have no delete at all. ' +
      'Re-run with --yes, or with --yes --dry-run to see the request first',
  });
}

/**
 * `100223` (`默认分支不能被删除`) is a business-rule refusal, so it stays on exit 7
 * rather than entering `ERROR_CODE_OVERRIDES` — the branch plainly exists (design
 * D12.8). What the server does not say is what to do about it, and `core/wire.ts`
 * cannot know: it has no concept of the other branches. So the way out is appended
 * here, in the `message`, not the `hint` — a `--json` error is
 * `{kind,message,code,exit}` and drops the hint, and an agent told "no" has to be
 * able to learn "then what". Same reasoning as ship's `explainStateRejection`.
 */
function explainDeleteRefusal(error: unknown, name: string): unknown {
  if (!(error instanceof PingcodeError) || error.code !== '100223') return error;
  const Ctor = error.constructor as new (
    message: string,
    options?: { code?: string | undefined; status?: number | undefined; hint?: string; cause?: unknown },
  ) => PingcodeError;
  return new Ctor(
    `${error.message} — "${name}" is the repository's default branch; make another branch the ` +
      'default first with `scm branch update <other-branch> --default`, then delete this one',
    {
      code: error.code,
      status: error.status,
      hint: 'a repository always keeps one default branch, so its only branch can never be deleted',
      cause: error,
    },
  );
}

function printBranch(branch: ScmBranch, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    branch,
    [
      ['name', branch.name ?? ''],
      ['id', branch.id],
      ['platform', refName(branch.product)],
      ['repository', refName(branch.repository)],
      ['sender', refName(branch.sender)],
      ['default', branch.is_default ? 'yes' : 'no'],
      ['work items', identifiersOf(branch.work_items).join(', ')],
      ['created', timestampCell(branch.created_at)],
      ['url', branch.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${branch.name ?? branch.id}`));
  }
}
