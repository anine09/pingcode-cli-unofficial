import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode scm review …` end to end, with `fetch` replaced at the global
 * boundary and the config directory redirected to a temp dir. No network, no
 * real credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/scm/review.ts`:
 * `runList` (the `--all` collect branch, the single-page branch, the
 * no-query-param list, paging, the empty-list-on-unknown-pr-id behaviour),
 * `runGet`, `runCreate` (the dry-run gate, required-`--submitted-at`, the
 * optional `--description`/`--html-url`, the `created` verb), `runUpdate`
 * (the empty-patch refusal, the subset PATCH, the `updated` verb), plus
 * `printReview` (json vs human, with and without a trailing verb) and the
 * `prLabel` / column helpers.
 *
 * A review hangs three parents deep (platform → repository → pull request),
 * so every leaf needs a `--pr-id` plus a (platform, repository) pair. Most
 * tests pass `--platform-id` + `--repo-id` verbatim to skip the lookups; a few
 * resolve a name to exercise the resolve callback inside `runCreate`/`runUpdate`.
 */

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const REPO = '685d393c47512a5d5d52aa70';
const PR = '6b10e8b47512a5d5d4e5b77';
const REVIEW_ID = '5b10e8b47512a5d5d4e5b66';

/** A hosting-platform list, for the `--platform <name>` bootstrap hop. */
const platformsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: PLATFORM, name: 'Github', type: 'github' }],
  });

/** A repository list, for the `--repo <name>` resolution hop. */
const reposPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [
      {
        id: REPO,
        name: 'code-interpreter',
        full_name: 'acme/code-interpreter',
        is_private: true,
        is_fork: false,
        owner: { id: 'u1', name: 'acme' },
      },
    ],
  });

/** The embedded code-review body, shared by the single-review and list responses. */
function reviewBody(): Record<string, unknown> {
  return {
    id: REVIEW_ID,
    status: 'approved',
    reviewer: { id: 'u1', name: 'alice' },
    submitted_at: 1730000000,
    description: 'looks good to me',
    html_url: 'https://github.com/acme/code-interpreter/pull/42#review-1',
    url: 'https://github.com/acme/code-interpreter/pull/42#review-1',
    product: { id: PLATFORM, name: 'Github' },
    repository: { id: REPO, name: 'code-interpreter' },
    pull_request: { id: PR, number: 42 },
  };
}

/** A one-page list of code reviews. */
const reviewsPage = () =>
  jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [reviewBody()] });

/** An empty list, as an unknown `--pr-id` reads (HTTP 200, not an error). */
const emptyReviewsPage = () => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] });

/** A single code review, as the detail endpoint returns it. */
const reviewOne = () => jsonResponse(reviewBody());

const harness = createCliHarness({ beforeEach, afterEach });

// ---------------------------------------------------------------------------
// scm review list
// ---------------------------------------------------------------------------

describe('scm review list', () => {
  it('requires --platform before any request', async () => {
    const run = await harness.run(['scm', 'review', 'list', '--repo-id', REPO, '--pr-id', PR]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('requires --repo once a platform is given', async () => {
    const run = await harness.run(['scm', 'review', 'list', '--platform-id', PLATFORM, '--pr-id', PR]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--repo <name|full_name|id> is required');
  });

  it('requires --pr-id (a requiredOption) before listing', async () => {
    const run = await harness.run([
      'scm',
      'review',
      'list',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('rejects --repo together with --repo-id', async () => {
    const run = await harness.run([
      'scm',
      'review',
      'list',
      '--platform-id',
      PLATFORM,
      '--repo',
      'code-interpreter',
      '--repo-id',
      REPO,
      '--pr-id',
      PR,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('rejects --platform together with --platform-id', async () => {
    const run = await harness.run([
      'scm',
      'review',
      'list',
      '--platform',
      'Github',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
      '--pr-id',
      PR,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it("lists one pull request's reviews with no query params beyond paging", async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--json',
      ],
      [reviewsPage],
    );
    expect(run.exit).toBe(0);
    // Exactly one request: the review list, with no preceding platform/repo resolution.
    expect(run.calls).toHaveLength(1);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.pathname).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/pull_requests/${PR}/reviews`,
    );
    // The review list honours no filter query parameters at all — only paging.
    expect(url.searchParams.get('page_index')).toBe('0');
    expect(url.searchParams.get('page_size')).toBe('30');
    expect(url.searchParams.get('number')).toBeNull();
    expect(url.searchParams.get('work_item_id')).toBeNull();
    const parsed = JSON.parse(run.stdout) as { total: number; values: { id: string }[] };
    expect(parsed.total).toBe(1);
    expect(parsed.values[0]?.id).toBe(REVIEW_ID);
  });

  it('forwards paging as page_index / page_size', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--page',
        '2',
        '--page-size',
        '5',
        '--json',
      ],
      [reviewsPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  it('walks every review under --all and renders a collected list', async () => {
    const reviewsPage1 = () =>
      jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [reviewBody()] });
    const reviewsPage2 = () =>
      jsonResponse({
        page_index: 1,
        page_size: 1,
        total: 2,
        values: [{ ...reviewBody(), id: 'review-2' }],
      });
    const run = await harness.run(
      [
        'scm',
        'review',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--all',
        '--page-size',
        '1',
        '--limit',
        '2',
        '--json',
      ],
      [reviewsPage1, reviewsPage2],
    );
    expect(run.exit).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      all: boolean;
      count: number;
      values: unknown[];
    };
    expect(parsed.all).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.values).toHaveLength(2);
  });

  it('reads an unknown --pr-id as an empty list, not an error', async () => {
    // The one scm child list that hides a missing parent: a wrong pr-id answers
    // HTTP 200 with zero rows rather than `100208`.
    const run = await harness.run(
      [
        'scm',
        'review',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        '000000000000000000000000',
        '--json',
      ],
      [emptyReviewsPage],
    );
    expect(run.exit).toBe(0);
    const parsed = JSON.parse(run.stdout) as { total: number; values: unknown[] };
    expect(parsed.total).toBe(0);
    expect(parsed.values).toEqual([]);
  });

  it('prints a human-mode table with the page row count on stderr', async () => {
    const run = await harness.run(
      ['scm', 'review', 'list', '--platform-id', PLATFORM, '--repo-id', REPO, '--pr-id', PR],
      [reviewsPage],
    );
    expect(run.exit).toBe(0);
    // Curated columns: id, status, reviewer, submitted, pr, description.
    expect(run.stdout).toContain(REVIEW_ID);
    expect(run.stdout).toContain('approved');
    expect(run.stdout).toContain('alice');
    expect(run.stdout).toContain('#42');
    expect(run.stdout).toContain('looks good to me');
    expect(run.stderr).toContain('row(s) of');
  });

  it('drops empty-string and missing reference fields instead of printing them', async () => {
    const body = {
      id: REVIEW_ID,
      status: '',
      description: '',
      // reviewer, pull_request, product, repository all absent.
    };
    const run = await harness.run(
      ['scm', 'review', 'list', '--platform-id', PLATFORM, '--repo-id', REPO, '--pr-id', PR],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [body] })],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(REVIEW_ID);
    // status '' and reviewer '' are dropped (refName(undefined) → '') — neither
    // 'approved' nor 'alice' appears, and no blank status cell is printed.
    expect(run.stdout).not.toContain('approved');
    expect(run.stdout).not.toContain('alice');
  });

  it('renders the pull request id cell when the embedded pr has no number', async () => {
    // Covers the `typeof number === 'number'` false branch in prLabel → the id.
    const body = { ...reviewBody(), pull_request: { id: PR } };
    const run = await harness.run(
      ['scm', 'review', 'list', '--platform-id', PLATFORM, '--repo-id', REPO, '--pr-id', PR],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [body] })],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(PR);
    expect(run.stdout).not.toContain('#42');
  });

  it('resolves --platform by name before listing, loading the platform list once', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'list',
        '--platform',
        'Github',
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--json',
      ],
      [platformsPage, reviewsPage],
    );
    expect(run.exit).toBe(0);
    // First call loads the platform candidates; second is the review list under the id.
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(
      `/repositories/${REPO}/pull_requests/${PR}/reviews?`,
    );
  });

  it('resolves --repo by name before listing', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--pr-id',
        PR,
        '--json',
      ],
      [reposPage, reviewsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/pull_requests/${PR}/reviews?`);
  });
});

// ---------------------------------------------------------------------------
// scm review get
// ---------------------------------------------------------------------------

describe('scm review get', () => {
  it('gets one review by id', async () => {
    const run = await harness.run(
      ['scm', 'review', 'get', REVIEW_ID, '--platform-id', PLATFORM, '--repo-id', REPO, '--pr-id', PR, '--json'],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain(`/pull_requests/${PR}/reviews/${REVIEW_ID}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: REVIEW_ID });
  });

  it('passes a slug positional through untouched', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'get',
        'review-42',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/reviews/review-42');
  });

  it('renders the curated field block in human mode, with no trailing verb', async () => {
    const run = await harness.run(
      ['scm', 'review', 'get', REVIEW_ID, '--platform-id', PLATFORM, '--repo-id', REPO, '--pr-id', PR],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(REVIEW_ID);
    expect(run.stdout).toContain('approved');
    expect(run.stdout).toContain('alice');
    expect(run.stdout).toContain('#42');
    expect(run.stdout).toContain('Github');
    expect(run.stdout).toContain('code-interpreter');
    expect(run.stdout).toContain('looks good to me');
    // A plain get prints no "created"/"updated" notice.
    expect(run.stderr).not.toContain('created review');
    expect(run.stderr).not.toContain('updated review');
  });

  it('drops the pull-request cell when the embedded pr reference is absent', async () => {
    // Covers prLabel(undefined) → '' and the `pull_request?.id ?? ''` fallback.
    const body = { ...reviewBody(), pull_request: undefined };
    const run = await harness.run(
      ['scm', 'review', 'get', REVIEW_ID, '--platform-id', PLATFORM, '--repo-id', REPO, '--pr-id', PR],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    // The pr label and pr-id lines are dropped (empty), not printed blank.
    expect(run.stdout).not.toContain('pull request');
    expect(run.stdout).toContain('looks good to me');
  });

  it('drops the html-url and url cells when the review carries neither', async () => {
    // Covers the `review.html_url ?? ''` and `review.url ?? ''` fallback branches
    // in printReview — both values absent, so the cells render empty and are dropped.
    const body = { ...reviewBody(), html_url: undefined, url: undefined };
    const run = await harness.run(
      ['scm', 'review', 'get', REVIEW_ID, '--platform-id', PLATFORM, '--repo-id', REPO, '--pr-id', PR],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).not.toContain('html url');
    expect(run.stdout).not.toContain('url');
  });

  it('surfaces an unknown review as exit 5 under --json', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'get',
        'ghost',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--json',
      ],
      [() => jsonResponse({ code: '100222', message: "'review'资源不存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });

  it('resolves --repo by name before the GET', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'get',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--pr-id',
        PR,
        '--json',
      ],
      [reposPage, reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/pull_requests/${PR}/reviews/${REVIEW_ID}`);
  });
});

// ---------------------------------------------------------------------------
// scm review create
// ---------------------------------------------------------------------------

describe('scm review create', () => {
  it('requires --status, --reviewer and --submitted-at (requiredOptions)', async () => {
    const run = await harness.run([
      'scm',
      'review',
      'create',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
      '--pr-id',
      PR,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('POSTs the required body and prints the created review', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        '1730000000',
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain(`/pull_requests/${PR}/reviews`);
    expect(run.writes[0]?.body).toEqual({
      status: 'approved',
      reviewer_name: 'alice',
      submitted_at: 1730000000,
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ id: REVIEW_ID });
  });

  it('includes --description and --html-url in the body when given', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'comment',
        '--reviewer',
        'bob',
        '--submitted-at',
        '1730000000',
        '--description',
        'nit: rename this',
        '--html-url',
        'https://example.com/review/9',
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      status: 'comment',
      reviewer_name: 'bob',
      submitted_at: 1730000000,
      description: 'nit: rename this',
      html_url: 'https://example.com/review/9',
    });
  });

  it('accepts --submitted-at as a date string and sends unix seconds', async () => {
    // Covers the Date.parse branch of parseTimestampFlag.
    const when = '2026-08-03T09:00:00Z';
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        when,
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect((run.writes[0]?.body as { submitted_at: number }).submitted_at).toBe(
      Math.floor(Date.parse(when) / 1000),
    );
  });

  it('rejects an empty --submitted-at before any request (requireFlag guards first)', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        '',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('is required');
  });

  it('rejects a non-date --submitted-at before any request', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        'not-a-date',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('is not a date');
  });

  it('prints the plan and sends nothing on a dry-run create', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        '1730000000',
        '--dry-run',
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    // A dry-run create resolves nothing here and sends zero mutating requests.
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain(`/pull_requests/${PR}/reviews`);
    expect(plan.request.body).toEqual({
      status: 'approved',
      reviewer_name: 'alice',
      submitted_at: 1730000000,
    });
  });

  it('announces the created review by status on stderr in human mode', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        '1730000000',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created review approved');
  });

  it('falls back to the review id in the created notice when status is absent', async () => {
    // Covers the `review.status ?? review.id` fallback in printReview.
    const body = { ...reviewBody(), status: undefined };
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        '1730000000',
      ],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created review ${REVIEW_ID}`);
  });

  it('surfaces a missing pull request on create as exit 5', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        '000000000000000000000000',
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        '1730000000',
        '--json',
      ],
      [() => jsonResponse({ code: '100208', message: "'pull request'资源不存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number; code: string } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5, code: '100208' });
  });

  it('resolves --repo by name before the POST', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        '1730000000',
        '--json',
      ],
      [reposPage, reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.writes[0]?.url).toContain(`/pull_requests/${PR}/reviews`);
  });
});

// ---------------------------------------------------------------------------
// scm review update
// ---------------------------------------------------------------------------

describe('scm review update', () => {
  it('refuses an empty patch before any request', async () => {
    const run = await harness.run([
      'scm',
      'review',
      'update',
      REVIEW_ID,
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
      '--pr-id',
      PR,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('nothing to update');
  });

  it('PATCHes only the given subset and prints the updated review', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'request_changes',
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/pull_requests/${PR}/reviews/${REVIEW_ID}`);
    expect(run.writes[0]?.body).toEqual({ status: 'request_changes' });
    expect(JSON.parse(run.stdout)).toMatchObject({ id: REVIEW_ID });
  });

  it('PATCHes every updatable field when all are given', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'carol',
        '--submitted-at',
        '1730000001',
        '--description',
        'addressed the comments',
        '--html-url',
        'https://example.com/review/9',
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      status: 'approved',
      reviewer_name: 'carol',
      submitted_at: 1730000001,
      description: 'addressed the comments',
      html_url: 'https://example.com/review/9',
    });
  });

  it('accepts --submitted-at as a date string on update', async () => {
    const when = '2026-08-03T09:00:00Z';
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--submitted-at',
        when,
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect((run.writes[0]?.body as { submitted_at: number }).submitted_at).toBe(
      Math.floor(Date.parse(when) / 1000),
    );
  });

  it('rejects a non-date --submitted-at on update before any request', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--submitted-at',
        'garbage',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('is not a date');
  });

  it('rejects an empty --submitted-at on update before any request', async () => {
    // Covers the `trimmed === ''` branch of parseTimestampFlag — reachable here
    // because update's --submitted-at is optional (no requireFlag guard).
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--submitted-at',
        '',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('must not be empty');
  });

  it('prints the plan and sends nothing on a dry-run update', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--dry-run',
        '--json',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.url).toContain(`/pull_requests/${PR}/reviews/${REVIEW_ID}`);
    expect(plan.request.body).toEqual({ status: 'approved' });
  });

  it('announces the updated review by status on stderr in human mode', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
      ],
      [reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('updated review approved');
  });

  it('surfaces an unknown review on update as exit 5', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        'ghost',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--json',
      ],
      [() => jsonResponse({ code: '100222', message: "'review'资源不存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });

  it('resolves --repo by name before the PATCH', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--json',
      ],
      [reposPage, reviewOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.writes[0]?.url).toContain(`/pull_requests/${PR}/reviews/${REVIEW_ID}`);
  });
});

// ---------------------------------------------------------------------------
// stdout / stderr contract
// ---------------------------------------------------------------------------

describe('scm review json stdout contract', () => {
  it('keeps stdout JSON-only on list, get, create and update, with notices on stderr in human mode', async () => {
    const list = await harness.run(
      [
        'scm',
        'review',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--json',
      ],
      [reviewsPage],
    );
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const got = await harness.run(
      [
        'scm',
        'review',
        'get',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--json',
      ],
      [reviewOne],
    );
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();

    const created = await harness.run(
      [
        'scm',
        'review',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--reviewer',
        'alice',
        '--submitted-at',
        '1730000000',
        '--json',
      ],
      [reviewOne],
    );
    expect(created.exit).toBe(0);
    expect(created.stderr).toBe('');
    expect(() => JSON.parse(created.stdout)).not.toThrow();

    const updated = await harness.run(
      [
        'scm',
        'review',
        'update',
        REVIEW_ID,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--status',
        'approved',
        '--json',
      ],
      [reviewOne],
    );
    expect(updated.exit).toBe(0);
    expect(updated.stderr).toBe('');
    expect(() => JSON.parse(updated.stdout)).not.toThrow();
  });

  it('writes the error JSON to stderr and leaves stdout empty on a failed get', async () => {
    const run = await harness.run(
      [
        'scm',
        'review',
        'get',
        'ghost',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--pr-id',
        PR,
        '--json',
      ],
      [() => jsonResponse({ code: '100222', message: 'does not exist' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; message: string; exit: number } };
    expect(error.error.kind).toBe('not_found');
    expect(error.error.exit).toBe(5);
  });
});
