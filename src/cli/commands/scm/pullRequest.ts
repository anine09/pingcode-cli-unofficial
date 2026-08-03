import type { Command } from 'commander';
import {
  createPullRequest,
  getPullRequest,
  iteratePullRequests,
  listPullRequests,
  updatePullRequest,
  type CreatePullRequestInput,
  type PullRequestListQuery,
  type UpdatePullRequestInput,
} from '../../../api/scm';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { collect } from '../../../core/paginate';
import type { ScmPullRequest } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  addPagingOptions,
  collectValue,
  contextFor,
  modeOf,
  parseNumberFlag,
  parseTimestampFlag,
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
  addRepoOptions,
  identifiersOf,
  oneLine,
  requireRepoScope,
  warnUnlinkedWorkItems,
  workItemIdentifiers,
  type RepoScope,
} from './branch';

/**
 * `pingcode scm pr …` — 拉取请求 ([S§3.12.5]).
 *
 * The CI write-back record of a pull request: PingCode does not read your hosting
 * platform, so a pipeline (or a webhook relay) tells it a PR exists, which branches it
 * spans and which work items it touches.
 *
 * Four things shape the flag surface, three of them upstream:
 *
 *  - **`number` is the only human-readable key, and it is not addressable.** scm has no
 *    `identifier` and no `short_id` anywhere, and the detail path takes the 24-hex id
 *    only. So `pr get|update` take an **id** and `pr list --number 42` is how you find
 *    it. The alternative — accepting either in the positional — would mean deciding
 *    client-side whether the string "looks like a number", and shape-guessing an
 *    identifier is exactly what `quality-guidelines.md` forbids (ids here come in three
 *    shapes). `scm ref --branch-id` made the same call for the same reason.
 *  - **`PATCH` requires `status`**, uniquely in scm. A caller who only wants to fix a
 *    title cannot express that in one request, so `update` re-reads the pull request and
 *    re-emits its current status. That is a read-modify-write in the command layer, not
 *    a silent default — the same contract testhub's `runs patch` settled on for its
 *    mandatory `status_id` ([TH§7]). Pass `--status` and the extra read is skipped.
 *  - **`--work-item` links can fail silently.** An identifier that does not exist is
 *    dropped and the call still returns 200, so the response's `work_items` array is the
 *    only evidence. Both writes compare it against what was asked for and warn
 *    (`warnUnlinkedWorkItems`); the exit code stays 0 because the server did succeed.
 *  - **the branch flags take ids, not names.** `--source-branch-id` / `--target-branch-id`
 *    are passed straight through, as `scm ref --branch-id` is: the callers of this family
 *    are pipelines that already hold the id from `scm branch create`, and a name lookup
 *    would cost a request per call to save a paste. A caller holding only a name runs
 *    `scm branch get <name> --json` first.
 *
 * There is **no `delete`** — upstream offers none for this family, as for every scm
 * family but 代码分支 — and **no `replace`**: `PUT …/pull_requests/{id}` exists upstream
 * but is excluded by design (D8.4), and it is the sharpest example of why, because it
 * promotes `source_branch_id` to *required* where `POST` leaves it optional. Use
 * `pingcode api PUT …` if a full replacement is genuinely what you want.
 */

const PR_HELP = 'pull request id (find it with `scm pr list --number <n> --json`)';

/** The four documented `status` values, quoted in `--help` rather than enforced. */
const PR_STATUSES = 'open | closed | merged | abandoned';

const WORK_ITEM_HELP =
  'work item identifier such as PLM-001, repeatable — an unknown one is silently ignored by the API';

type RepoFlags = Parameters<typeof requireRepoScope>[1];

type ListFlags = PagingFlags &
  RepoFlags & { number?: string | undefined; workItemId?: string | undefined };

/** The six `*_count` fields plus the three merge fields, shared by create and update. */
type StatFlags = {
  mergedAt?: string | undefined;
  mergedCommitSha?: string | undefined;
  mergedBy?: string | undefined;
  commentsCount?: string | undefined;
  reviewCommentsCount?: string | undefined;
  commitsCount?: string | undefined;
  additionsCount?: string | undefined;
  deletionsCount?: string | undefined;
  changedFilesCount?: string | undefined;
};

type CreateFlags = RepoFlags &
  StatFlags & {
    title: string;
    number: string;
    creator: string;
    targetBranchId: string;
    status: string;
    sourceBranchId?: string | undefined;
    description?: string | undefined;
    workItem?: string[] | undefined;
  };

type UpdateFlags = RepoFlags &
  StatFlags & {
    status?: string | undefined;
    title?: string | undefined;
    creator?: string | undefined;
    description?: string | undefined;
    sourceBranchId?: string | undefined;
    targetBranchId?: string | undefined;
    workItem?: string[] | undefined;
  };

export const PULL_REQUEST_COLUMNS: Column<ScmPullRequest>[] = [
  { header: 'NUMBER', value: (pr) => (pr.number === undefined ? '' : String(pr.number)) },
  { header: 'TITLE', value: (pr) => oneLine(pr.title), flex: true },
  { header: 'STATUS', value: (pr) => pr.status ?? '' },
  { header: 'AUTHOR', value: (pr) => refName(pr.author) },
  { header: 'TARGET', value: (pr) => refName(pr.target_branch) },
  { header: 'WORK ITEMS', value: (pr) => identifiersOf(pr.work_items).join(' ') },
];

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** The statistics flags, identical on create and update, declared once. */
function addStatOptions(command: Command): Command {
  return command
    .option('--merged-at <when>', 'merge time: unix seconds or a date — required by the API when --status merged')
    .option('--merged-commit-sha <sha>', 'the merge commit SHA — required by the API when --status merged')
    .option('--merged-by <git-username>', 'who merged it — required by the API when --status merged')
    .option('--comments-count <n>', 'number of comments on the pull request')
    .option('--review-comments-count <n>', 'number of code-review comments')
    .option('--commits-count <n>', 'number of commits')
    .option('--additions-count <n>', 'number of added files')
    .option('--deletions-count <n>', 'number of deleted files')
    .option('--changed-files-count <n>', 'number of changed files');
}

export function registerPullRequestCommands(parent: Command): void {
  const group = parent
    .command('pr')
    .description('pull requests 拉取请求 — write-back records; there is no delete, so they are permanent');

  addGlobalOptions(
    addPagingOptions(
      addRepoOptions(
        group
          .command('list')
          .description('list the pull requests of a repository')
          .option('--number <n>', 'exact pull request number, unique within the repository')
          .option('--work-item-id <id>', 'only pull requests linked to this work item id (an id, not PLM-001)'),
      ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    addRepoOptions(
      group.command('get').description('show one pull request').argument('<pull-request>', PR_HELP),
    ),
    { hidden: true },
  ).action(async (target: string, flags: RepoFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    addStatOptions(
      addRepoOptions(
        group
          .command('create')
          .description('record a pull request (the number must be unique in the repository)')
          .requiredOption('--title <text>', 'pull request title')
          .requiredOption('--number <n>', 'pull request number, unique within the repository')
          .requiredOption(
            '--creator <git-username>',
            'author git username — create the identity first with `scm platform-user create`',
          )
          .requiredOption(
            '--target-branch-id <id>',
            'target branch id, from `scm branch list --json` — an id, not a name',
          )
          .requiredOption('--status <status>', `pull request status, one of: ${PR_STATUSES}`)
          .option('--source-branch-id <id>', 'source branch id — optional here, unlike on the API\u2019s PUT')
          .option('--description <text>', 'description')
          .option('--work-item <identifier>', WORK_ITEM_HELP, collectValue),
      ),
    ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    addStatOptions(
      addRepoOptions(
        group
          .command('update')
          .description('patch a pull request — only the fields you pass are sent, plus its status')
          .argument('<pull-request>', PR_HELP)
          .option(
            '--status <status>',
            `new status, one of: ${PR_STATUSES} — omit it and the CURRENT status is read back ` +
              'and re-sent, because the API requires this field on every patch',
          )
          .option('--title <text>', 'new title')
          .option('--creator <git-username>', 'new author git username')
          .option('--description <text>', 'new description (replaces the old one)')
          .option('--source-branch-id <id>', 'new source branch id')
          .option('--target-branch-id <id>', 'new target branch id')
          .option('--work-item <identifier>', `${WORK_ITEM_HELP}; REPLACES the existing links`, collectValue),
      ),
    ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const { scope } = await requireRepoScope(ctx, flags);
  const number = parseNumberFlag(flags.number, '--number');
  const query: PullRequestListQuery = {
    ...(number === undefined ? {} : { number }),
    ...(flags.workItemId === undefined ? {} : { work_item_id: flags.workItemId }),
  };

  if (paging.all) {
    const values = await collect(
      iteratePullRequests(ctx, scope.platformId, scope.repositoryId, query, {
        pageSize: paging.pageSize,
        limit: paging.limit,
      }),
    );
    printCollection(values, PULL_REQUEST_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listPullRequests(ctx, scope.platformId, scope.repositoryId, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, PULL_REQUEST_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: RepoFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const { scope } = await requireRepoScope(ctx, flags);
  printPullRequest(
    await getPullRequest(
      ctx,
      scope.platformId,
      scope.repositoryId,
      requireFlag(target, '<pull-request>'),
    ),
    ctx,
  );
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);
  const number = parseNumberFlag(requireFlag(flags.number, '--number'), '--number');
  if (number === undefined) throw new UsageError('--number is required');

  const input: CreatePullRequestInput = {
    title: requireFlag(flags.title, '--title'),
    number,
    creator_name: requireFlag(flags.creator, '--creator'),
    target_branch_id: requireFlag(flags.targetBranchId, '--target-branch-id'),
    status: requireFlag(flags.status, '--status'),
    ...(flags.sourceBranchId === undefined ? {} : { source_branch_id: flags.sourceBranchId }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...statFields(flags),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };

  const pullRequest = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<RepoScope>> => {
      const { scope, resolutions } = await requireRepoScope(attemptCtx, flags);
      return { resolutions, value: scope };
    },
    async (attemptCtx, scope) =>
      await createPullRequest(attemptCtx, scope.platformId, scope.repositoryId, input),
  );
  warnUnlinkedWorkItems(ctx, identifiers, pullRequest.work_items);
  printPullRequest(pullRequest, ctx, 'created');
}

/**
 * `PATCH` needs `status` whether or not the caller wants to change it, so an omitted
 * `--status` is answered with the pull request's **current** status rather than a
 * guess: one extra `GET`, and the value that reaches the wire is the one already
 * stored. A pull request that reports no status at all (which the API's own required
 * field makes impossible on create, but which a future shape change could produce) is
 * a `UsageError` naming the flag, not a request with a missing field.
 */
async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);
  const pullRequestId = requireFlag(target, '<pull-request>');

  const fields: Omit<UpdatePullRequestInput, 'status'> = {
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(flags.creator === undefined ? {} : { creator_name: flags.creator }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(flags.sourceBranchId === undefined ? {} : { source_branch_id: flags.sourceBranchId }),
    ...(flags.targetBranchId === undefined ? {} : { target_branch_id: flags.targetBranchId }),
    ...statFields(flags),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };
  if (Object.keys(fields).length === 0 && flags.status === undefined) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --status / --title / --creator / --description / ' +
        '--source-branch-id / --target-branch-id / --work-item / the --*-count flags',
    });
  }

  const { scope } = await requireRepoScope(ctx, flags);
  const status =
    flags.status ??
    (await getPullRequest(ctx, scope.platformId, scope.repositoryId, pullRequestId)).status;
  if (status === undefined) {
    throw new UsageError(
      `the pull request ${pullRequestId} reported no status to inherit, so --status is required`,
      {
        hint: `PATCH requires status on every patch; pass one of: ${PR_STATUSES}`,
      },
    );
  }

  const patch: UpdatePullRequestInput = { status, ...fields };

  const pullRequest = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<RepoScope>> => {
      const resolved = await requireRepoScope(attemptCtx, flags);
      return { resolutions: resolved.resolutions, value: resolved.scope };
    },
    async (attemptCtx, resolvedScope) =>
      await updatePullRequest(
        attemptCtx,
        resolvedScope.platformId,
        resolvedScope.repositoryId,
        pullRequestId,
        patch,
      ),
  );
  warnUnlinkedWorkItems(ctx, identifiers, pullRequest.work_items);
  printPullRequest(pullRequest, ctx, 'updated');
}

/**
 * The merge trio and the six counts, parsed once for both writes.
 *
 * The counts are caller-supplied statistics — nothing server-side recomputes them —
 * so a non-numeric value is a `UsageError` before the request, and an omitted one is
 * omitted rather than sent as `0`: "no comments" and "not reported" are different
 * facts and only the caller knows which it means.
 *
 * The return type names the nine fields explicitly instead of being a
 * `Partial<UpdatePullRequestInput>`: a `Partial` spread would widen the *required*
 * fields of whatever it is spread into (`title` would become `string | undefined`),
 * which is a real bug the compiler catches only because `exactOptionalPropertyTypes`
 * is on.
 */
type StatBody = Pick<
  UpdatePullRequestInput,
  | 'merged_at'
  | 'merged_commit_sha'
  | 'merged_by_name'
  | 'comments_count'
  | 'review_comments_count'
  | 'commits_count'
  | 'additions_count'
  | 'deletions_count'
  | 'changed_files_count'
>;

function statFields(flags: StatFlags): StatBody {
  const mergedAt = parseTimestampFlag(flags.mergedAt, '--merged-at');
  const counts = {
    comments_count: parseNumberFlag(flags.commentsCount, '--comments-count'),
    review_comments_count: parseNumberFlag(flags.reviewCommentsCount, '--review-comments-count'),
    commits_count: parseNumberFlag(flags.commitsCount, '--commits-count'),
    additions_count: parseNumberFlag(flags.additionsCount, '--additions-count'),
    deletions_count: parseNumberFlag(flags.deletionsCount, '--deletions-count'),
    changed_files_count: parseNumberFlag(flags.changedFilesCount, '--changed-files-count'),
  };
  return {
    ...(mergedAt === undefined ? {} : { merged_at: mergedAt }),
    ...(flags.mergedCommitSha === undefined ? {} : { merged_commit_sha: flags.mergedCommitSha }),
    ...(flags.mergedBy === undefined ? {} : { merged_by_name: flags.mergedBy }),
    ...Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== undefined)),
  };
}

function printPullRequest(pullRequest: ScmPullRequest, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    pullRequest,
    [
      ['number', pullRequest.number === undefined ? '' : String(pullRequest.number)],
      ['id', pullRequest.id],
      ['title', oneLine(pullRequest.title)],
      ['status', pullRequest.status ?? ''],
      ['platform', refName(pullRequest.product)],
      ['repository', refName(pullRequest.repository)],
      ['author', refName(pullRequest.author)],
      ['source branch', refName(pullRequest.source_branch)],
      ['target branch', refName(pullRequest.target_branch)],
      ['description', oneLine(pullRequest.description)],
      ['created', timestampCell(pullRequest.created_at)],
      ['merged', timestampCell(pullRequest.merged_at)],
      ['merge commit', pullRequest.merged_commit_sha ?? ''],
      ['merged by', refName(pullRequest.merged_by)],
      ['comments', countCell(pullRequest.comments_count)],
      ['review comments', countCell(pullRequest.review_comments_count)],
      ['commits', countCell(pullRequest.commits_count)],
      ['additions', countCell(pullRequest.additions_count)],
      ['deletions', countCell(pullRequest.deletions_count)],
      ['changed files', countCell(pullRequest.changed_files_count)],
      ['work items', identifiersOf(pullRequest.work_items).join(', ')],
      ['url', pullRequest.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    const label =
      pullRequest.number === undefined ? pullRequest.id : `#${String(pullRequest.number)}`;
    errLine(paint.green(`${verb} pull request ${label}`));
  }
}

/** An absent count is blank, never `0`: the API does not report one it was not given. */
function countCell(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}
