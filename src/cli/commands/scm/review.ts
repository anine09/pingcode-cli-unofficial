import type { Command } from 'commander';
import {
  createReview,
  getReview,
  iterateReviews,
  listReviews,
  updateReview,
  type CreateReviewInput,
  type UpdateReviewInput,
} from '../../../api/scm';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { collect } from '../../../core/paginate';
import type { Ref, ScmCodeReview } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  addPagingOptions,
  contextFor,
  modeOf,
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
import { addRepoOptions, oneLine, requireRepoScope, type RepoScope } from './branch';

/**
 * `pingcode scm review …` — 代码评审 ([S§3.12.6]): one review event on one pull
 * request — someone approved it, commented on it, or asked for changes.
 *
 * ⚠️ **This is not `/v1/reviews`.** Two unrelated resources share the word "review" in
 * this API:
 *
 *  - **代码评审 (here).** Four endpoints, nested under
 *    `…/pull_requests/{id}/reviews`, part of the DevOps write-back surface, addressed
 *    by (platform, repository, pull request). Fields: `reviewer`, `status`,
 *    `description`, `submitted_at`, `html_url`.
 *  - **评审 (`/v1/reviews`, 8 endpoints, generic layer only).** A polymorphic review
 *    *object* addressed by `principal_type` + `pilot_id`, with review contents hanging
 *    off it, used by the 需求 / 用例 review flows. Reach it with `pingcode api GET
 *    /v1/reviews …`.
 *
 * They share no id space, no field set and no parent. A `scm review` id is meaningless
 * to `/v1/reviews` and vice versa, so nothing here imports from the crosscutting layer
 * and nothing there knows about these four endpoints.
 *
 * Three shape facts the flags encode, all upstream:
 *
 *  - **every leaf requires `--pr-id`.** A review is addressed three parents deep
 *    (platform → repository → pull request), and there is **no repository-wide or
 *    organisation-wide review list**: reviews are enumerated one pull request at a
 *    time, exactly as commit refs are enumerated one branch at a time. Listing "all
 *    reviews" is not an operation this API offers, and looping over pull requests
 *    client-side would be N requests against a 200/min limit for a result set the API
 *    never promises.
 *  - **`--pr-id` takes an id, not a number.** The pull request path segment is the
 *    24-hex id; the number is only a list filter. Find the id with
 *    `scm pr list --number <n> --json`. Same trade as `scm ref --branch-id`.
 *  - **`--submitted-at` is required on create.** A review has no server-assigned
 *    timestamp at all — no `created_at`, no `updated_at` — so the caller replaying a
 *    review event owns the time outright. On `update` it is optional, like everything
 *    else: unlike `scm pr update`, this PATCH has no mandatory field (verified live).
 *
 * ⚠️ **`--reviewer` upserts.** A git username the platform does not know is **created**
 * as a platform user, so a typo leaves a permanent ghost identity — platform users have
 * no DELETE anywhere in scm. Confirmed live (design D13.1 item 3), and the same hazard
 * as `scm branch create --sender` and `scm pr create --creator`.
 *
 * ⚠️ **A wrong `--pr-id` reads as "no reviews", not as an error.** `GET
 * …/pull_requests/{unknown}/reviews` answers **HTTP 200 with an empty list** rather than
 * the `100208` it returns on the detail paths — the pull request is the one scm parent
 * whose absence a child *list* does not report (a missing platform or repository does
 * yield `100200`/`100202`). So an empty `review list` means "either no reviews, or that
 * pull request does not exist"; confirm the id with `scm pr get <id>` if it matters.
 * `review get` and `review create` are unaffected: both surface a missing pull request
 * as exit 5.
 *
 * There is **no `delete`** (upstream offers none, as everywhere in scm but 代码分支) and
 * **no `replace`**: `PUT …/reviews/{id}` exists upstream and is excluded by design
 * (D8.4). A full replacement is `pingcode api PUT …`.
 */

const REVIEW_HELP = 'code review id (from `scm review list --pr-id <id> --json`)';

const PR_ID_HELP =
  'pull request id — an id, not a number (find it with `scm pr list --number <n> --json`)';

/** The three documented `status` values, quoted in `--help` rather than enforced. */
const REVIEW_STATUSES = 'comment | approved | request_changes';

type RepoFlags = Parameters<typeof requireRepoScope>[1];

type PrFlags = RepoFlags & { prId: string };

type ListFlags = PagingFlags & PrFlags;

type CreateFlags = PrFlags & {
  status: string;
  reviewer: string;
  submittedAt: string;
  description?: string | undefined;
  htmlUrl?: string | undefined;
};

type UpdateFlags = PrFlags & {
  status?: string | undefined;
  reviewer?: string | undefined;
  submittedAt?: string | undefined;
  description?: string | undefined;
  htmlUrl?: string | undefined;
};

/** (platform, repository, pull request) — the three parents a review hangs off. */
type ReviewScope = RepoScope & { pullRequestId: string };

export const REVIEW_COLUMNS: Column<ScmCodeReview>[] = [
  { header: 'ID', value: (review) => review.id },
  { header: 'STATUS', value: (review) => review.status ?? '' },
  { header: 'REVIEWER', value: (review) => refName(review.reviewer) },
  { header: 'SUBMITTED', value: (review) => timestampCell(review.submitted_at) },
  { header: 'PR', value: (review) => prLabel(review.pull_request) },
  { header: 'DESCRIPTION', value: (review) => oneLine(review.description), flex: true },
];

/** `#42` when the embedded pull request reports a number, else its id. */
function prLabel(pullRequest: Ref | undefined): string {
  if (pullRequest === undefined) return '';
  const number = pullRequest.number;
  return typeof number === 'number' ? `#${String(number)}` : pullRequest.id;
}

function addPrOptions(command: Command): Command {
  return addRepoOptions(command).requiredOption('--pr-id <id>', PR_ID_HELP);
}

async function requireReviewScope(
  ctx: Ctx,
  flags: PrFlags,
): Promise<{ scope: ReviewScope; resolutions: Awaited<ReturnType<typeof requireRepoScope>>['resolutions'] }> {
  const { scope, resolutions } = await requireRepoScope(ctx, flags);
  return {
    scope: { ...scope, pullRequestId: requireFlag(flags.prId, '--pr-id') },
    resolutions,
  };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerReviewCommands(parent: Command): void {
  const group = parent
    .command('review')
    .description(
      'code reviews 代码评审 on ONE pull request — not the /v1/reviews object; no delete exists',
    );

  addGlobalOptions(
    addPagingOptions(
      addPrOptions(
        group
          .command('list')
          .description(
            'list the code reviews of ONE pull request — the API offers no repository-wide list; ' +
              'an unknown --pr-id reads as an empty list, not an error',
          ),
      ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    addPrOptions(
      group.command('get').description('show one code review').argument('<review>', REVIEW_HELP),
    ),
    { hidden: true },
  ).action(async (target: string, flags: PrFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    addPrOptions(
      group
        .command('create')
        .description('record a code review on a pull request')
        .requiredOption('--status <status>', `review status, one of: ${REVIEW_STATUSES}`)
        .requiredOption(
          '--reviewer <git-username>',
          'reviewer git username — an UNKNOWN name is CREATED as a platform user, and ' +
            'platform users cannot be deleted',
        )
        .requiredOption(
          '--submitted-at <when>',
          'when the review was submitted: unix seconds or a date like 2026-08-03T09:00:00Z ' +
            '(required — a review carries no server-side timestamp)',
        )
        .option('--description <text>', 'the review body')
        .option('--html-url <url>', 'link back to the review on the hosting platform'),
    ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    addPrOptions(
      group
        .command('update')
        .description('patch a code review — only the fields you pass are sent')
        .argument('<review>', REVIEW_HELP)
        .option('--status <status>', `new status, one of: ${REVIEW_STATUSES}`)
        .option(
          '--reviewer <git-username>',
          'new reviewer git username — an UNKNOWN name is CREATED as a platform user',
        )
        .option('--submitted-at <when>', 'new submission time: unix seconds or a date')
        .option('--description <text>', 'new review body (replaces the old one)')
        .option('--html-url <url>', 'new link back to the hosting platform'),
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
  const { scope } = await requireReviewScope(ctx, flags);

  if (paging.all) {
    const values = await collect(
      iterateReviews(ctx, scope.platformId, scope.repositoryId, scope.pullRequestId, {
        pageSize: paging.pageSize,
        limit: paging.limit,
      }),
    );
    printCollection(values, REVIEW_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listReviews(
    ctx,
    scope.platformId,
    scope.repositoryId,
    scope.pullRequestId,
    { pageIndex: paging.pageIndex, pageSize: paging.pageSize },
  );
  printPage(page, REVIEW_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: PrFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const { scope } = await requireReviewScope(ctx, flags);
  printReview(
    await getReview(
      ctx,
      scope.platformId,
      scope.repositoryId,
      scope.pullRequestId,
      requireFlag(target, '<review>'),
    ),
    ctx,
  );
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const submittedAt = parseTimestampFlag(
    requireFlag(flags.submittedAt, '--submitted-at'),
    '--submitted-at',
  );
  if (submittedAt === undefined) throw new UsageError('--submitted-at is required');

  const input: CreateReviewInput = {
    status: requireFlag(flags.status, '--status'),
    reviewer_name: requireFlag(flags.reviewer, '--reviewer'),
    submitted_at: submittedAt,
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(flags.htmlUrl === undefined ? {} : { html_url: flags.htmlUrl }),
  };

  const review = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<ReviewScope>> => {
      const resolved = await requireReviewScope(attemptCtx, flags);
      return { resolutions: resolved.resolutions, value: resolved.scope };
    },
    async (attemptCtx, scope) =>
      await createReview(
        attemptCtx,
        scope.platformId,
        scope.repositoryId,
        scope.pullRequestId,
        input,
      ),
  );
  printReview(review, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const reviewId = requireFlag(target, '<review>');
  const submittedAt = parseTimestampFlag(flags.submittedAt, '--submitted-at');

  const patch: UpdateReviewInput = {
    ...(flags.status === undefined ? {} : { status: flags.status }),
    ...(flags.reviewer === undefined ? {} : { reviewer_name: flags.reviewer }),
    ...(submittedAt === undefined ? {} : { submitted_at: submittedAt }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(flags.htmlUrl === undefined ? {} : { html_url: flags.htmlUrl }),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --status / --reviewer / --submitted-at / --description / --html-url',
    });
  }

  const review = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<ReviewScope>> => {
      const resolved = await requireReviewScope(attemptCtx, flags);
      return { resolutions: resolved.resolutions, value: resolved.scope };
    },
    async (attemptCtx, scope) =>
      await updateReview(
        attemptCtx,
        scope.platformId,
        scope.repositoryId,
        scope.pullRequestId,
        reviewId,
        patch,
      ),
  );
  printReview(review, ctx, 'updated');
}

function printReview(review: ScmCodeReview, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    review,
    [
      ['id', review.id],
      ['status', review.status ?? ''],
      ['reviewer', refName(review.reviewer)],
      ['submitted', timestampCell(review.submitted_at)],
      ['pull request', prLabel(review.pull_request)],
      ['pull request id', review.pull_request?.id ?? ''],
      ['platform', refName(review.product)],
      ['repository', refName(review.repository)],
      ['description', oneLine(review.description)],
      ['html url', review.html_url ?? ''],
      ['url', review.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} review ${review.status ?? review.id}`));
  }
}
