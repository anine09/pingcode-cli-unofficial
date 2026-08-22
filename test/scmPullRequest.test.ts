import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode scm pr …` end to end, with `fetch` replaced at the global boundary
 * and the config directory redirected to a temp dir. No network, no real
 * credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/scm/pullRequest.ts`:
 * `runList` (the `--all` collect branch, the single-page branch, the `--number`
 * and `--work-item-id` query filters, paging), `runGet`, `runCreate` (the
 * optional-field subset, `statFields`, the dry-run gate, the `created` verb),
 * `runUpdate` (the empty-patch refusal, the mandatory-`status` read-back when
 * `--status` is omitted, the statusless-row refusal, the dry-run gate, the
 * `updated` verb), and `printPullRequest` (both the `--json` and human paths,
 * with and without a trailing verb) plus `countCell` and `statFields`.
 *
 * A 拉取请求 is repository-scoped, so every leaf needs a (platform, repository)
 * pair resolved first. Most tests pass `--platform-id` + `--repo-id` verbatim
 * to skip the lookups and keep the request count deterministic; create / get /
 * list additionally resolve a name to exercise the resolver. `update` resolves
 * names via `--repo-id` only, because it calls `requireRepoScope` twice (once
 * before the status read, once inside `runWrite`'s resolve callback) and a name
 * hop there would depend on the on-disk cache timing.
 */

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const REPO = '685d393c47512a5d5d52aa70';
const PR = '6a70a5f1919cce9794f01c3f';
const BRANCH = '6b10e8b47512a5d5d4e5b77';
const SRC_BRANCH = '6c10e8b47512a5d5d4e5b88';
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

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

/** A rich pull request body, shared by the detail and create responses. */
function prBody(): Record<string, unknown> {
  return {
    id: PR,
    url: 'https://github.com/acme/code-interpreter/pull/42',
    number: 42,
    title: 'feat: add login',
    status: 'open',
    description: 'Adds the login flow',
    product: { id: PLATFORM, name: 'Github' },
    repository: { id: REPO, name: 'code-interpreter' },
    author: { id: 'u1', name: 'bot' },
    source_branch: { id: SRC_BRANCH, name: 'feature/login' },
    target_branch: { id: BRANCH, name: 'main' },
    created_at: 1730000000,
    merged_at: 1735000000,
    merged_commit_sha: SHA,
    merged_by: { id: 'u2', name: 'merger' },
    comments_count: 3,
    review_comments_count: 1,
    commits_count: 5,
    additions_count: 120,
    deletions_count: 30,
    changed_files_count: 8,
    work_items: [{ id: 'w1', identifier: 'PLM-001' }],
  };
}

/** A one-page list of pull requests. */
const prsPage = () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [prBody()] });

/** A single pull request, as the detail endpoint returns it. */
const prOne = () => jsonResponse(prBody());

const harness = createCliHarness({ beforeEach, afterEach });

// ---------------------------------------------------------------------------
// scm pr list
// ---------------------------------------------------------------------------

describe('scm pr list', () => {
  it('requires --platform before any request', async () => {
    const run = await harness.run(['scm', 'pr', 'list', '--repo-id', REPO]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('requires --repo once a platform is given', async () => {
    const run = await harness.run(['scm', 'pr', 'list', '--platform-id', PLATFORM]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--repo <name|full_name|id> is required');
  });

  it('rejects --repo together with --repo-id', async () => {
    const run = await harness.run([
      'scm',
      'pr',
      'list',
      '--platform-id',
      PLATFORM,
      '--repo',
      'code-interpreter',
      '--repo-id',
      REPO,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('rejects --platform together with --platform-id', async () => {
    const run = await harness.run([
      'scm',
      'pr',
      'list',
      '--platform',
      'Github',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('sends --number and --work-item-id as query filters, and nothing else', async () => {
    const run = await harness.run(
      [
        'scm',
        'pr',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--number',
        '42',
        '--work-item-id',
        'w1',
        '--json',
      ],
      [prsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.pathname).toBe(`/v1/scm/products/${PLATFORM}/repositories/${REPO}/pull_requests`);
    expect(url.searchParams.get('number')).toBe('42');
    expect(url.searchParams.get('work_item_id')).toBe('w1');
  });

  it('omits both filters when neither flag was given', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'list', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [prsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).not.toContain('number=');
    expect(run.calls[0]?.url).not.toContain('work_item_id=');
  });

  it('refuses a non-numeric --number before any request (exit 2)', async () => {
    const run = await harness.run(
      [
        'scm',
        'pr',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--number',
        'forty-two',
        '--json',
      ],
      [prsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--number');
  });

  it('forwards paging as page_index / page_size', async () => {
    const run = await harness.run(
      [
        'scm',
        'pr',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--page',
        '2',
        '--page-size',
        '5',
        '--json',
      ],
      [prsPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  it('walks every pull request under --all and renders a collected list', async () => {
    const page1 = () =>
      jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [prBody()] });
    const page2 = () =>
      jsonResponse({
        page_index: 1,
        page_size: 1,
        total: 2,
        values: [{ ...prBody(), id: 'pr-2', number: 43 }],
      });
    const run = await harness.run(
      [
        'scm',
        'pr',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--all',
        '--page-size',
        '1',
        '--limit',
        '2',
        '--json',
      ],
      [page1, page2],
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

  it('prints a human-mode table with the curated PR columns and the row count on stderr', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'list', '--platform-id', PLATFORM, '--repo-id', REPO],
      [prsPage],
    );
    expect(run.exit).toBe(0);
    // Curated columns: number, title, status, author, target, work items.
    expect(run.stdout).toContain('42');
    expect(run.stdout).toContain('feat: add login');
    expect(run.stdout).toContain('open');
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('main');
    expect(run.stdout).toContain('PLM-001');
    expect(run.stderr).toContain('row(s)');
  });

  it('walks every page in human mode too, with the collected row count on stderr', async () => {
    const page1 = () =>
      jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [prBody()] });
    const page2 = () =>
      jsonResponse({
        page_index: 1,
        page_size: 1,
        total: 2,
        values: [{ ...prBody(), id: 'pr-2', number: 43 }],
      });
    const run = await harness.run(
      [
        'scm',
        'pr',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--all',
        '--page-size',
        '1',
        '--limit',
        '2',
      ],
      [page1, page2],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('42');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('renders blank number and status cells when a list row carries neither', async () => {
    // Covers the `pr.number === undefined ? ''` and `pr.status ?? ''` fallbacks in
    // PULL_REQUEST_COLUMNS: a row with no number and no status prints empty cells
    // rather than "0" or "undefined".
    const row = {
      id: PR,
      title: 'feat: add login',
      author: { id: 'u1', name: 'bot' },
      target_branch: { id: BRANCH, name: 'main' },
      work_items: [{ id: 'w1', identifier: 'PLM-001' }],
    };
    const run = await harness.run(
      ['scm', 'pr', 'list', '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [row] })],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('feat: add login');
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('main');
    expect(run.stdout).toContain('PLM-001');
    // No number was present, so "42" never appears.
    expect(run.stdout).not.toContain('42');
    expect(run.stderr).toContain('row(s)');
  });

  it('resolves --platform by name before listing, loading the platform list once', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'list', '--platform', 'Github', '--repo-id', REPO, '--json'],
      [platformsPage, prsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/pull_requests?`);
  });

  it('resolves --repo by name before listing', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'list', '--platform-id', PLATFORM, '--repo', 'code-interpreter', '--json'],
      [reposPage, prsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/pull_requests?`);
  });
});

// ---------------------------------------------------------------------------
// scm pr get
// ---------------------------------------------------------------------------

describe('scm pr get', () => {
  it('gets one pull request by id', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'get', PR, '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [prOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain(`/repositories/${REPO}/pull_requests/${PR}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: PR, number: 42 });
  });

  it('passes a slug positional through untouched', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'get', 'pr-slug', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [() => jsonResponse({ id: 'pr-slug', number: 7 })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/pull_requests/pr-slug');
  });

  it('resolves --repo by name before the GET', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'get', PR, '--platform-id', PLATFORM, '--repo', 'code-interpreter', '--json'],
      [reposPage, prOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/pull_requests/${PR}`);
  });

  it('renders the curated field block in human mode, with no trailing verb', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'get', PR, '--platform-id', PLATFORM, '--repo-id', REPO],
      [prOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('42');
    expect(run.stdout).toContain(PR);
    expect(run.stdout).toContain('feat: add login');
    expect(run.stdout).toContain('open');
    expect(run.stdout).toContain('Github');
    expect(run.stdout).toContain('code-interpreter');
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('feature/login');
    expect(run.stdout).toContain('main');
    expect(run.stdout).toContain('PLM-001');
    expect(run.stdout).toContain(SHA);
    // A plain get prints no "created"/"got" notice.
    expect(run.stderr).toBe('');
  });

  it('drops the count cells when the pull request carries none (countCell undefined branch)', async () => {
    // A body that omits every `*_count` and the merge trio renders those labels
    // blank, so they are dropped from the block rather than printed as "0".
    const body = {
      id: PR,
      number: 42,
      title: 'feat: add login',
      status: 'open',
      product: { id: PLATFORM, name: 'Github' },
      repository: { id: REPO, name: 'code-interpreter' },
      author: { id: 'u1', name: 'bot' },
      target_branch: { id: BRANCH, name: 'main' },
      work_items: [],
    };
    const run = await harness.run(
      ['scm', 'pr', 'get', PR, '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('feat: add login');
    // No counts and no merge fields → those labels are dropped, not shown blank.
    expect(run.stdout).not.toContain('comments');
    expect(run.stdout).not.toContain('merge commit');
    expect(run.stdout).not.toContain('merged by');
  });

  it('surfaces an unknown pull request as exit 5 under --json', async () => {
    const run = await harness.run(
      ['scm', 'pr', 'get', 'ghost', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [() => jsonResponse({ code: '100317', message: '资源不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });
});

// ---------------------------------------------------------------------------
// scm pr create
// ---------------------------------------------------------------------------

describe('scm pr create', () => {
  const baseArgs = [
    'scm',
    'pr',
    'create',
    '--platform-id',
    PLATFORM,
    '--repo-id',
    REPO,
    '--title',
    'feat: login',
    '--number',
    '42',
    '--creator',
    'bot',
    '--target-branch-id',
    BRANCH,
    '--source-branch-id',
    SRC_BRANCH,
    '--status',
    'open',
  ];

  it('requires the required options (commander, exit 2)', async () => {
    const run = await harness.run(['scm', 'pr', 'create', '--platform-id', PLATFORM, '--repo-id', REPO]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('POSTs the documented fields and prints the created pull request', async () => {
    const run = await harness.run([...baseArgs, '--json'], [() => jsonResponse(prBody())]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/pull_requests`);
    expect(run.writes[0]?.body).toEqual({
      title: 'feat: login',
      number: 42,
      creator_name: 'bot',
      target_branch_id: BRANCH,
      source_branch_id: SRC_BRANCH,
      status: 'open',
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ id: PR, number: 42 });
  });

  it('includes --description and the --work-item identifiers when given', async () => {
    const run = await harness.run(
      [...baseArgs, '--description', 'Adds the login flow', '--work-item', 'PLM-001', '--json'],
      [() => jsonResponse(prBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      title: 'feat: login',
      number: 42,
      creator_name: 'bot',
      target_branch_id: BRANCH,
      source_branch_id: SRC_BRANCH,
      status: 'open',
      description: 'Adds the login flow',
      work_item_identifiers: ['PLM-001'],
    });
  });

  it('parses the merge trio and all six counts into numbers and unix seconds', async () => {
    const run = await harness.run(
      [
        ...baseArgs,
        '--status',
        'merged',
        '--merged-at',
        '1730000000',
        '--merged-commit-sha',
        SHA,
        '--merged-by',
        'merger',
        '--comments-count',
        '3',
        '--review-comments-count',
        '1',
        '--commits-count',
        '5',
        '--additions-count',
        '120',
        '--deletions-count',
        '30',
        '--changed-files-count',
        '8',
        '--json',
      ],
      [() => jsonResponse(prBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      title: 'feat: login',
      number: 42,
      creator_name: 'bot',
      target_branch_id: BRANCH,
      source_branch_id: SRC_BRANCH,
      status: 'merged',
      merged_at: 1730000000,
      merged_commit_sha: SHA,
      merged_by_name: 'merger',
      comments_count: 3,
      review_comments_count: 1,
      commits_count: 5,
      additions_count: 120,
      deletions_count: 30,
      changed_files_count: 8,
    });
  });

  it('sends zero as a value, not as an omission', async () => {
    const run = await harness.run([...baseArgs, '--comments-count', '0', '--json'], [
      () => jsonResponse(prBody()),
    ]);
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toMatchObject({ comments_count: 0 });
  });

  it('refuses a non-numeric count before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs, '--comments-count', 'abc', '--json'], [prOne]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--comments-count');
  });

  it('refuses a non-numeric --number before any request (exit 2)', async () => {
    const run = await harness.run(
      [
        'scm',
        'pr',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--title',
        't',
        '--number',
        'abc',
        '--creator',
        'bot',
        '--target-branch-id',
        BRANCH,
        '--source-branch-id',
        SRC_BRANCH,
        '--status',
        'open',
        '--json',
      ],
      [prOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--number');
  });

  it('refuses a non-date --merged-at before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs, '--merged-at', 'yesterday', '--json'], [prOne]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--merged-at');
  });

  it('refuses a blank --work-item before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs, '--work-item', '', '--status', 'open', '--json'], [
      prOne,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--work-item');
  });

  it('resolves --platform by name before the POST', async () => {
    const run = await harness.run(
      [
        'scm',
        'pr',
        'create',
        '--platform',
        'Github',
        '--repo-id',
        REPO,
        '--title',
        'feat: login',
        '--number',
        '42',
        '--creator',
        'bot',
        '--target-branch-id',
        BRANCH,
        '--source-branch-id',
        SRC_BRANCH,
        '--status',
        'open',
        '--json',
      ],
      [platformsPage, () => jsonResponse(prBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.writes[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories/${REPO}/pull_requests`);
  });

  it('resolves --repo by name before the POST', async () => {
    const run = await harness.run(
      [
        'scm',
        'pr',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--title',
        'feat: login',
        '--number',
        '42',
        '--creator',
        'bot',
        '--target-branch-id',
        BRANCH,
        '--source-branch-id',
        SRC_BRANCH,
        '--status',
        'open',
        '--json',
      ],
      [reposPage, () => jsonResponse(prBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/pull_requests`);
  });

  it('resolves --platform by name on a dry-run, so reads still fire but no write is sent', async () => {
    const run = await harness.run(
      [
        'scm',
        'pr',
        'create',
        '--platform',
        'Github',
        '--repo-id',
        REPO,
        '--title',
        'feat: login',
        '--number',
        '42',
        '--creator',
        'bot',
        '--target-branch-id',
        BRANCH,
        '--source-branch-id',
        SRC_BRANCH,
        '--status',
        'open',
        '--dry-run',
        '--json',
      ],
      [platformsPage],
    );
    expect(run.exit).toBe(0);
    // The platform list is a read, so it is still sent under --dry-run; the POST is gated.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain(`/repositories/${REPO}/pull_requests`);
    expect(plan.request.body).toEqual({
      title: 'feat: login',
      number: 42,
      creator_name: 'bot',
      target_branch_id: BRANCH,
      source_branch_id: SRC_BRANCH,
      status: 'open',
    });
  });

  it('prints the plan and sends nothing on a dry-run create with ids (no reads)', async () => {
    const run = await harness.run([...baseArgs, '--dry-run', '--json'], [
      () => jsonResponse(prBody()),
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as { request: { method: string } };
    expect(plan.request.method).toBe('POST');
  });

  it('announces the created pull request by number on stderr in human mode', async () => {
    const run = await harness.run([...baseArgs], [() => jsonResponse(prBody())]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created pull request #42');
  });

  it('falls back to the id in the created notice when the row reports no number', async () => {
    const run = await harness.run([...baseArgs], [() => jsonResponse({ id: PR })]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created pull request ${PR}`);
  });

  it('warns when the API silently dropped a work-item link, and still exits 0', async () => {
    const run = await harness.run(
      [
        ...baseArgs,
        '--work-item',
        'YYHC-10',
        '--work-item',
        'NOSUCH-99999',
        '--json',
      ],
      [() => jsonResponse({ id: PR, number: 42, work_items: [{ id: 'w1', identifier: 'YYHC-10' }] })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toMatchObject({ work_item_identifiers: ['YYHC-10', 'NOSUCH-99999'] });
    expect(run.stderr).toContain('NOSUCH-99999');
    expect(run.stderr).not.toContain('YYHC-10');
    JSON.parse(run.stdout);
  });

  it('says nothing when every requested work item came back linked', async () => {
    const run = await harness.run([...baseArgs, '--work-item', 'PLM-001', '--json'], [
      () => jsonResponse({ id: PR, number: 42, work_items: [{ id: 'w1', identifier: 'PLM-001' }] }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// scm pr update
// ---------------------------------------------------------------------------

describe('scm pr update', () => {
  const baseArgs = [
    'scm',
    'pr',
    'update',
    PR,
    '--platform-id',
    PLATFORM,
    '--repo-id',
    REPO,
  ];

  it('refuses an empty patch before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs], [() => jsonResponse({ id: PR, status: 'open' })]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('nothing to update');
    expect(run.stderr).toContain('--status');
  });

  it('reads the current status back when --status is omitted, then PATCHes with it', async () => {
    const run = await harness.run([...baseArgs, '--title', 'feat: renamed', '--json'], [
      () => jsonResponse({ id: PR, number: 42, status: 'open' }),
      () => jsonResponse({ id: PR, number: 42, status: 'open', title: 'feat: renamed' }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/pull_requests/${PR}`);
    expect(run.writes[0]?.body).toEqual({ status: 'open', title: 'feat: renamed' });
  });

  it('skips the status read when --status was given, so the patch is one request', async () => {
    const run = await harness.run([...baseArgs, '--status', 'merged', '--json'], [
      () => jsonResponse({ id: PR, status: 'merged' }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.writes[0]?.body).toEqual({ status: 'merged' });
  });

  it('sends only the patched fields alongside the inherited status', async () => {
    const run = await harness.run(
      [
        ...baseArgs,
        '--status',
        'open',
        '--creator',
        'newbot',
        '--description',
        'new desc',
        '--source-branch-id',
        SRC_BRANCH,
        '--target-branch-id',
        BRANCH,
        '--json',
      ],
      [() => jsonResponse({ id: PR, status: 'open' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      status: 'open',
      creator_name: 'newbot',
      description: 'new desc',
      source_branch_id: SRC_BRANCH,
      target_branch_id: BRANCH,
    });
  });

  it('replaces the work-item links and warns when one was silently dropped', async () => {
    // The hint text itself quotes "PLM-001", so the requested identifiers must not
    // be PLM-001 or the `not.toContain` check would match the hint, not the links.
    const run = await harness.run(
      [...baseArgs, '--status', 'open', '--work-item', 'YYHC-10', '--work-item', 'NOSUCH-99999', '--json'],
      [
        () =>
          jsonResponse({
            id: PR,
            status: 'open',
            work_items: [{ id: 'w1', identifier: 'YYHC-10' }],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toMatchObject({
      work_item_identifiers: ['YYHC-10', 'NOSUCH-99999'],
    });
    expect(run.stderr).toContain('NOSUCH-99999');
    expect(run.stderr).not.toContain('YYHC-10');
  });

  it('says nothing when every requested work item came back linked', async () => {
    const run = await harness.run([...baseArgs, '--status', 'open', '--work-item', 'PLM-001', '--json'], [
      () => jsonResponse({ id: PR, status: 'open', work_items: [{ id: 'w1', identifier: 'PLM-001' }] }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('refuses a blank --work-item before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs, '--status', 'open', '--work-item', '', '--json'], [
      () => jsonResponse({ id: PR, status: 'open' }),
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--work-item');
  });

  it('says so rather than sending a statusless patch when the row reports no status', async () => {
    // The status read (a GET) still happens; the refusal is raised only after it.
    const run = await harness.run([...baseArgs, '--title', 't', '--json'], [
      () => jsonResponse({ id: PR, number: 42 }),
    ]);
    expect(run.exit).toBe(2);
    expect(run.writes).toEqual([]);
    expect(run.calls).toHaveLength(1);
    const error = JSON.parse(run.stderr) as { error: { kind: string; message: string } };
    expect(error.error.kind).toBe('usage');
    expect(error.error.message).toContain('--status is required');
  });

  it('still reads the status on a dry-run without --status, but sends no write', async () => {
    // A GET is a read, so the status read-back still executes; only the PATCH is gated.
    const run = await harness.run([...baseArgs, '--title', 'renamed', '--dry-run', '--json'], [
      () => jsonResponse({ id: PR, number: 42, status: 'open' }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.body).toEqual({ status: 'open', title: 'renamed' });
  });

  it('sends nothing on a dry-run update with --status given (no read, no write)', async () => {
    const run = await harness.run([...baseArgs, '--status', 'merged', '--dry-run', '--json'], [
      () => jsonResponse({ id: PR, status: 'merged' }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as { request: { method: string; body: unknown } };
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.body).toEqual({ status: 'merged' });
  });

  it('announces the updated pull request by number on stderr in human mode', async () => {
    const run = await harness.run([...baseArgs, '--status', 'merged'], [
      () => jsonResponse({ id: PR, number: 42, status: 'merged' }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('updated pull request #42');
  });

  it('offers no delete and no replace leaf', async () => {
    for (const verb of ['delete', 'replace']) {
      const run = await harness.run(
        ['scm', 'pr', verb, PR, '--platform-id', PLATFORM, '--repo-id', REPO],
        [],
      );
      expect(run.exit, verb).toBe(2);
      expect(run.calls, verb).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// stdout / stderr contract
// ---------------------------------------------------------------------------

describe('scm pr json stdout contract', () => {
  it('keeps stdout JSON-only on list, get and create, with notices on stderr', async () => {
    const list = await harness.run(
      ['scm', 'pr', 'list', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [prsPage],
    );
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const got = await harness.run(
      ['scm', 'pr', 'get', PR, '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [prOne],
    );
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();

    const created = await harness.run([...createBaseArgs(true)], [() => jsonResponse(prBody())]);
    expect(created.exit).toBe(0);
    expect(created.stderr).toBe('');
    expect(() => JSON.parse(created.stdout)).not.toThrow();
  });

  it('keeps stdout JSON-only on update, the human-mode verb going to stderr', async () => {
    const jsonRun = await harness.run(
      ['scm', 'pr', 'update', PR, '--platform-id', PLATFORM, '--repo-id', REPO, '--status', 'merged', '--json'],
      [() => jsonResponse({ id: PR, status: 'merged' })],
    );
    expect(jsonRun.exit).toBe(0);
    expect(jsonRun.stderr).toBe('');
    expect(() => JSON.parse(jsonRun.stdout)).not.toThrow();

    const humanRun = await harness.run(
      ['scm', 'pr', 'update', PR, '--platform-id', PLATFORM, '--repo-id', REPO, '--status', 'merged'],
      [() => jsonResponse({ id: PR, number: 42, status: 'merged' })],
    );
    expect(humanRun.exit).toBe(0);
    // human mode: the result block on stdout, the "updated" notice on stderr.
    expect(humanRun.stdout).toContain('merged');
    expect(humanRun.stderr).toContain('updated pull request #42');
  });
});

/** The `pr create` argv with the documented fields; `json` toggles `--json`. */
function createBaseArgs(json: boolean): string[] {
  return [
    'scm',
    'pr',
    'create',
    '--platform-id',
    PLATFORM,
    '--repo-id',
    REPO,
    '--title',
    'feat: login',
    '--number',
    '42',
    '--creator',
    'bot',
    '--target-branch-id',
    BRANCH,
    '--source-branch-id',
    SRC_BRANCH,
    '--status',
    'open',
    ...(json ? ['--json'] : []),
  ];
}
