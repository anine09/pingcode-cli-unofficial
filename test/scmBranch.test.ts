import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode scm branch …` end to end, with `fetch` replaced at the global
 * boundary and the config directory redirected to a temp dir. No network, no
 * real credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/scm/branch.ts`:
 *  - `runList` (the `--all` collect branch, the single-page branch, the `--name`
 *    / `--work-item-id` query filters, paging);
 *  - `runGet` (the name→id resolution hop via `resolveBranchRef`, the id
 *    pass-through, the curated field block, the empty-cell fallbacks, exit 5);
 *  - `runCreate` (the required `--name`/`--sender`, the `is_default` only-when-true
 *    body, the `work_item_identifiers` / blank-`--work-item` branches, the dry-run
 *    gate, the `created` verb, the unlinked-work-item warning);
 *  - `runUpdate` (the nothing-to-update guard, the `is_default` action, the
 *    replace-semantics `work_item_identifiers` / `[]` clear, the dry-run gate, the
 *    `updated` verb, the name resolution then PATCH, exit 5);
 *  - `runDelete` (the `--yes` gate naming the branch by both name and id, the
 *    dry-run gate at the transport layer, the `100223` default-branch refusal
 *    re-wrapped with the way out, exit 7);
 *  - `confirmBranchDeletion` / `explainDeleteRefusal` / `printBranch` and the
 *    `BRANCH_COLUMNS` table cells.
 *
 * A 代码分支 is scoped by a (platform, repository) pair, so every leaf needs that
 * pair resolved first. Most tests pass `--platform-id` + `--repo-id` verbatim to
 * skip the lookups; a few resolve a name to exercise the resolver hop. Branch
 * references are resolved *inside* `branch.ts` in one filtered `listBranches`
 * request (`resolveBranchRef`), not through `core/metadata`, so get/update/delete
 * each pay one extra list request when the target is a name.
 */

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const REPO = '685d393c47512a5d5d52aa70';
const BRANCH = '6b10e8b47512a5d5d4e5b77';
const BRANCH_NAME = 'feature/PLM-001-login';

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

/** A branch body, shared by the detail, list and create/update responses. */
function branchBody(): Record<string, unknown> {
  return {
    id: BRANCH,
    url: 'https://github.com/acme/code-interpreter/tree/feature/PLM-001-login',
    name: BRANCH_NAME,
    product: { id: PLATFORM, name: 'Github' },
    repository: { id: REPO, name: 'code-interpreter' },
    sender: { id: 'u1', name: 'bot' },
    is_default: false,
    created_at: 1785750479,
    work_items: [{ id: 'w1', identifier: 'PLM-001', title: 'Login' }],
  };
}

/** A one-page list of branches (as `listBranches` returns). */
const branchesPage = () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [branchBody()] });

/** A single branch, as the detail / create / update endpoint returns it. */
const branchOne = () => jsonResponse(branchBody());

/** An empty branch page, so `resolveBranchRef` finds no name match. */
const emptyBranchesPage = () => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] });

const harness = createCliHarness({ beforeEach, afterEach });

// ---------------------------------------------------------------------------
// scm branch list
// ---------------------------------------------------------------------------

describe('scm branch list', () => {
  it('requires --platform before any request', async () => {
    const run = await harness.run(['scm', 'branch', 'list', '--repo-id', REPO]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('requires --repo once a platform is given', async () => {
    const run = await harness.run(['scm', 'branch', 'list', '--platform-id', PLATFORM]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--repo <name|full_name|id> is required');
  });

  it('rejects --repo together with --repo-id', async () => {
    const run = await harness.run([
      'scm',
      'branch',
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
      'branch',
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

  it('lists one repository\u2019s branches with the exact --name filter', async () => {
    const run = await harness.run(
      ['scm', 'branch', 'list', '--platform-id', PLATFORM, '--repo-id', REPO, '--name', BRANCH_NAME, '--json'],
      [branchesPage],
    );
    expect(run.exit).toBe(0);
    // Exactly one request: the list, with no preceding platform/repo resolution.
    expect(run.calls).toHaveLength(1);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.pathname).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/branches`,
    );
    expect(url.searchParams.get('name')).toBe(BRANCH_NAME);
    const parsed = JSON.parse(run.stdout) as { total: number; values: { id: string }[] };
    expect(parsed.total).toBe(1);
    expect(parsed.values[0]?.id).toBe(BRANCH);
  });

  it('forwards --work-item-id as a work_item_id query', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--work-item-id',
        'w1',
        '--json',
      ],
      [branchesPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('work_item_id')).toBe('w1');
    // No `name` filter when `--name` is absent.
    expect(url.searchParams.has('name')).toBe(false);
  });

  it('forwards paging as page_index / page_size', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
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
      [branchesPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  it('walks every branch under --all and renders a collected list', async () => {
    const page1 = () =>
      jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [branchBody()] });
    const page2 = () =>
      jsonResponse({
        page_index: 1,
        page_size: 1,
        total: 2,
        values: [{ ...branchBody(), id: 'branch-2' }],
      });
    const run = await harness.run(
      [
        'scm',
        'branch',
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

  it('prints a human-mode table with the curated columns and a row count', async () => {
    const run = await harness.run(
      ['scm', 'branch', 'list', '--platform-id', PLATFORM, '--repo-id', REPO],
      [branchesPage],
    );
    expect(run.exit).toBe(0);
    // Curated columns: ID, NAME, DEFAULT, SENDER, WORK ITEMS.
    expect(run.stdout).toContain(BRANCH);
    expect(run.stdout).toContain(BRANCH_NAME);
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('PLM-001');
    expect(run.stderr).toContain('row(s)');
  });

  it('drops empty cells instead of printing them', async () => {
    // name '' / sender absent / work_items empty / default false → those cells drop.
    const body = { id: BRANCH, is_default: false, work_items: [] };
    const run = await harness.run(
      ['scm', 'branch', 'list', '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [body] })],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(BRANCH);
    // empty name / sender / work-items cells are dropped, so neither shows.
    expect(run.stdout).not.toContain('PLM-001');
    // The default cell for a non-default branch is '' and is dropped too.
    expect(run.stdout).not.toContain('yes');
  });

  it('resolves --platform by name before listing, loading the platform list once', async () => {
    const run = await harness.run(
      ['scm', 'branch', 'list', '--platform', 'Github', '--repo-id', REPO, '--json'],
      [platformsPage, branchesPage],
    );
    expect(run.exit).toBe(0);
    // First call loads the platform candidates; second is the branch list under the id.
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/branches?`);
  });

  it('resolves --repo by name before listing', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--json',
      ],
      [reposPage, branchesPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/branches?`);
  });
});

// ---------------------------------------------------------------------------
// scm branch get
// ---------------------------------------------------------------------------

describe('scm branch get', () => {
  it('gets one branch by id — resolution misses, then GETs the id', async () => {
    const run = await harness.run(
      ['scm', 'branch', 'get', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    // resolveBranchRef lists with name=<id> (no match), then getBranch reads the id.
    expect(run.calls).toHaveLength(2);
    expect(new URL(run.calls[0]?.url ?? 'https://x.invalid').searchParams.get('name')).toBe(BRANCH);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: BRANCH });
  });

  it('resolves a branch name to its id, then GETs the resolved id', async () => {
    // The list page matches the name → resolution returns the row's id, so the
    // second request GETs /branches/<resolved id>, not the name.
    const run = await harness.run(
      ['scm', 'branch', 'get', BRANCH_NAME, '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [branchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(new URL(run.calls[0]?.url ?? 'https://x.invalid').searchParams.get('name')).toBe(
      BRANCH_NAME,
    );
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
    expect(run.calls[1]?.url).not.toContain(BRANCH_NAME);
  });

  it('passes a slug positional through untouched when it matches nothing', async () => {
    const run = await harness.run(
      ['scm', 'branch', 'get', 'release/1.4', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[0]?.url ?? 'https://x.invalid').searchParams.get('name')).toBe('release/1.4');
    // No match → the slug is sent as the id, percent-encoded, on the detail GET.
    expect(run.calls[1]?.url).toContain('/branches/release%2F1.4');
  });

  it('renders the curated field block in human mode, with no trailing verb', async () => {
    const run = await harness.run(
      ['scm', 'branch', 'get', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(BRANCH_NAME);
    expect(run.stdout).toContain(BRANCH);
    expect(run.stdout).toContain('Github');
    expect(run.stdout).toContain('code-interpreter');
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('PLM-001');
    // A plain get prints no "created"/"got" notice.
    expect(run.stderr).not.toContain('created');
  });

  it('drops empty sender / work-items / url cells instead of printing them', async () => {
    // Covers the `refName(undefined) → ''` and `?? ''` fallbacks in printBranch.
    const body = { id: BRANCH, name: BRANCH_NAME, is_default: true };
    const run = await harness.run(
      ['scm', 'branch', 'get', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => emptyBranchesPage(), () => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(BRANCH_NAME);
    // sender / work items / url / created are all empty → their lines are dropped.
    expect(run.stdout).not.toContain('sender');
    expect(run.stdout).not.toContain('work items');
    expect(run.stdout).not.toContain('url');
    expect(run.stdout).not.toContain('created');
    // is_default true renders 'yes'.
    expect(run.stdout).toContain('yes');
  });

  it('surfaces an unknown branch as exit 5 under --json', async () => {
    // Resolution misses (empty list), then the detail GET answers 400 + 100201.
    const run = await harness.run(
      ['scm', 'branch', 'get', 'ghost', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [emptyBranchesPage, () => jsonResponse({ code: '100201', message: '资源不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number; code: string } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5, code: '100201' });
  });

  it('resolves --repo by name before the GET', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'get',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--json',
      ],
      [reposPage, emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/branches?`);
    expect(run.calls[2]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
  });
});

// ---------------------------------------------------------------------------
// scm branch create
// ---------------------------------------------------------------------------

describe('scm branch create', () => {
  it('requires --name and --sender (requiredOptions)', async () => {
    const run = await harness.run([
      'scm',
      'branch',
      'create',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('POSTs the required name + sender_name and nothing else', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
        '--json',
      ],
      [branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/branches`);
    // is_default is omitted when not asked for (the server defaults it).
    expect(run.writes[0]?.body).toEqual({ name: BRANCH_NAME, sender_name: 'bot' });
    expect(JSON.parse(run.stdout)).toMatchObject({ id: BRANCH });
  });

  it('sends is_default only when --default is given (it is an action, not a value)', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
        '--default',
        '--json',
      ],
      [branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ name: BRANCH_NAME, sender_name: 'bot', is_default: true });
  });

  it('forwards --work-item as work_item_identifiers (repeatable)', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
        '--work-item',
        'PLM-001',
        '--work-item',
        'PLM-002',
        '--json',
      ],
      [branchOne],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as { work_item_identifiers: string[] };
    expect(body.work_item_identifiers).toEqual(['PLM-001', 'PLM-002']);
  });

  it('rejects a blank --work-item identifier before the request', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
        '--work-item',
        '  ',
        '--json',
      ],
      [branchOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--work-item must not be empty');
  });

  it('prints the plan and sends nothing on a dry-run create', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
        '--dry-run',
        '--json',
      ],
      [branchOne],
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
    expect(plan.request.url).toContain(`/repositories/${REPO}/branches`);
    expect(plan.request.body).toEqual({ name: BRANCH_NAME, sender_name: 'bot' });
  });

  it('announces the created branch by name on stderr in human mode', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
      ],
      [branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created ${BRANCH_NAME}`);
  });

  it('warns on stderr when a requested work item was silently not linked', async () => {
    // The response echoes only PLM-001; NOSUCH-99999 was accepted-and-ignored.
    const body = { ...branchBody(), work_items: [{ id: 'w1', identifier: 'PLM-001' }] };
    const run = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
        '--work-item',
        'PLM-001',
        '--work-item',
        'NOSUCH-99999',
      ],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('NOSUCH-99999');
    expect(run.stderr).toContain('silently ignored');
  });

  it('resolves --repo by name before the POST', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
        '--json',
      ],
      [reposPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/branches`);
  });
});

// ---------------------------------------------------------------------------
// scm branch update
// ---------------------------------------------------------------------------

describe('scm branch update', () => {
  it('requires the <branch> argument', async () => {
    const run = await harness.run([
      'scm',
      'branch',
      'update',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
      '--default',
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('refuses with nothing-to-update when no patchable field is given', async () => {
    const run = await harness.run([
      'scm',
      'branch',
      'update',
      BRANCH,
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
      '--json',
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('nothing to update');
  });

  it('rejects a blank --work-item before the nothing-to-update check', async () => {
    const run = await harness.run([
      'scm',
      'branch',
      'update',
      BRANCH,
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
      '--work-item',
      '  ',
      '--json',
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--work-item must not be empty');
  });

  it('PATCHes is_default: true as the make-default action', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'update',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--default',
        '--json',
      ],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
    expect(run.writes[0]?.body).toEqual({ is_default: true });
  });

  it('replaces the work-item link set, sending the identifiers verbatim', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'update',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--work-item',
        'PLM-003',
        '--json',
      ],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ work_item_identifiers: ['PLM-003'] });
  });

  it('sends both patchable fields together when --default and --work-item are given', async () => {
    // The patch object can carry both keys at once; this asserts neither is dropped.
    const run = await harness.run(
      [
        'scm',
        'branch',
        'update',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--default',
        '--work-item',
        'PLM-003',
        '--json',
      ],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ is_default: true, work_item_identifiers: ['PLM-003'] });
  });

  it('resolves a branch name before PATCHing the resolved id', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'update',
        BRANCH_NAME,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--default',
        '--json',
      ],
      [branchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    // Name resolution (list) then the PATCH to the resolved id, never the name.
    expect(run.calls).toHaveLength(2);
    expect(new URL(run.calls[0]?.url ?? 'https://x.invalid').searchParams.get('name')).toBe(BRANCH_NAME);
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
    expect(run.writes[0]?.url).not.toContain(BRANCH_NAME);
  });

  it('prints the plan and sends nothing on a dry-run update', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'update',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--default',
        '--dry-run',
        '--json',
      ],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    // The resolution read runs, but the PATCH is halted at the transport layer.
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
    expect(plan.request.body).toEqual({ is_default: true });
  });

  it('announces the updated branch by name on stderr in human mode', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'update',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--default',
      ],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`updated ${BRANCH_NAME}`);
  });

  it('surfaces an unknown branch on the PATCH as exit 5', async () => {
    // Resolution misses, then the PATCH answers 400 + 100201.
    const run = await harness.run(
      [
        'scm',
        'branch',
        'update',
        'ghost',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--default',
        '--json',
      ],
      [
        emptyBranchesPage,
        () => jsonResponse({ code: '100201', message: '资源不存在' }, { status: 400 }),
      ],
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
        'branch',
        'update',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--default',
        '--json',
      ],
      [reposPage, emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
  });
});

// ---------------------------------------------------------------------------
// scm branch delete
// ---------------------------------------------------------------------------

describe('scm branch delete', () => {
  it('refuses without --yes, naming the resolved branch', async () => {
    // A name resolves to a row, so the refusal names the branch (not the id).
    const run = await harness.run(
      ['scm', 'branch', 'delete', BRANCH_NAME, '--platform-id', PLATFORM, '--repo-id', REPO],
      [branchesPage],
    );
    expect(run.exit).toBe(2);
    // Only the name-resolution list ran; no GET-by-id and certainly no DELETE.
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toEqual([]);
    expect(run.stderr).toContain(`refusing to delete the branch "${BRANCH_NAME}" without --yes`);
  });

  it('names the branch read back by id when the target is an id, still refusing', async () => {
    // An id does not match a name, so the branch is read back and named in the refusal.
    const run = await harness.run(
      ['scm', 'branch', 'delete', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(2);
    // Name-resolution list (miss) + read-by-id, then the gate fires before the DELETE.
    expect(run.calls).toHaveLength(2);
    expect(run.writes).toEqual([]);
    expect(run.stderr).toContain(`refusing to delete the branch "${BRANCH_NAME}" without --yes`);
  });

  it('adds the default-branch hint to the refusal when the branch is the default', async () => {
    // The name resolves to a default branch, so confirmBranchDeletion appends the
    // "make another branch the default" guidance to the refusal hint.
    const run = await harness.run(
      ['scm', 'branch', 'delete', BRANCH_NAME, '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => jsonResponse({ ...branchBody(), id: BRANCH, name: BRANCH_NAME, is_default: true, work_items: [] })],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toEqual([]);
    expect(run.stderr).toContain(`refusing to delete the branch "${BRANCH_NAME}" without --yes`);
    expect(run.stderr).toContain("this is the repository");
  });

  it('deletes by name with --yes, using the resolved id', async () => {
    const deleted = { ...branchBody(), name: BRANCH_NAME };
    const run = await harness.run(
      ['scm', 'branch', 'delete', BRANCH_NAME, '--platform-id', PLATFORM, '--repo-id', REPO, '--yes'],
      [branchesPage, () => jsonResponse(deleted)],
    );
    expect(run.exit).toBe(0);
    // Name resolution (list) then the DELETE to the resolved id.
    expect(run.calls).toHaveLength(2);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
    expect(run.stderr).toContain(`deleted ${BRANCH_NAME}`);
  });

  it('deletes by id with --yes, reading the name back first', async () => {
    const run = await harness.run(
      ['scm', 'branch', 'delete', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO, '--yes'],
      [emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    // Miss on the name list, a read-by-id for the name, then the DELETE.
    expect(run.calls).toHaveLength(3);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
    expect(run.stderr).toContain(`deleted ${BRANCH_NAME}`);
  });

  it('falls back to the id in the deleted notice when the branch has no name', async () => {
    const body = { ...branchBody(), name: undefined };
    const run = await harness.run(
      ['scm', 'branch', 'delete', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO, '--yes'],
      [emptyBranchesPage, () => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    // printBranch's `branch.name ?? branch.id` fallback for the notice.
    expect(run.stderr).toContain(`deleted ${BRANCH}`);
  });

  it('sends the DELETE plan and nothing else on a dry-run delete by name', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'delete',
        BRANCH_NAME,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--yes',
        '--dry-run',
        '--json',
      ],
      [branchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    // The name-resolution read runs, but the DELETE is halted at the transport layer.
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('DELETE');
    expect(plan.request.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
  });

  it('still refuses without --yes even under --dry-run — the gate fires before the plan', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'delete',
        BRANCH_NAME,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--dry-run',
        '--json',
      ],
      [branchesPage, branchOne],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toEqual([]);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('without --yes');
  });

  it('re-wraps the 100223 default-branch refusal with the way out, on exit 7', async () => {
    // The DELETE is refused by the server (100223); explainDeleteRefusal appends the
    // recovery step to the message while keeping the code/status/exit.
    const run = await harness.run(
      ['scm', 'branch', 'delete', BRANCH_NAME, '--platform-id', PLATFORM, '--repo-id', REPO, '--yes', '--json'],
      [
        branchesPage,
        () => jsonResponse({ code: '100223', message: '默认分支不能被删除' }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(7);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as {
      error: { kind: string; exit: number; code: string; message: string };
    };
    expect(error.error).toMatchObject({ kind: 'api', exit: 7, code: '100223' });
    expect(error.error.message).toContain(`"${BRANCH_NAME}" is the repository's default branch`);
    expect(error.error.message).toContain('make another branch the default first');
  });

  it('resolves --repo by name before deleting', async () => {
    const run = await harness.run(
      [
        'scm',
        'branch',
        'delete',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--yes',
        '--json',
      ],
      [reposPage, emptyBranchesPage, branchOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/branches/${BRANCH}`);
  });
});

// ---------------------------------------------------------------------------
// stdout / stderr contract
// ---------------------------------------------------------------------------

describe('scm branch json stdout contract', () => {
  it('keeps stdout JSON-only on list, get, create and update, with notices on stderr', async () => {
    const list = await harness.run(
      ['scm', 'branch', 'list', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [branchesPage],
    );
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const got = await harness.run(
      ['scm', 'branch', 'get', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [emptyBranchesPage, branchOne],
    );
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();

    const created = await harness.run(
      [
        'scm',
        'branch',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--name',
        BRANCH_NAME,
        '--sender',
        'bot',
        '--json',
      ],
      [branchOne],
    );
    expect(created.exit).toBe(0);
    // The create notice goes to stderr (human-only), so stdout stays JSON-only.
    expect(created.stderr).toBe('');
    expect(() => JSON.parse(created.stdout)).not.toThrow();

    const updated = await harness.run(
      [
        'scm',
        'branch',
        'update',
        BRANCH,
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--default',
        '--json',
      ],
      [emptyBranchesPage, branchOne],
    );
    expect(updated.exit).toBe(0);
    expect(updated.stderr).toBe('');
    expect(() => JSON.parse(updated.stdout)).not.toThrow();

    const deleted = await harness.run(
      ['scm', 'branch', 'delete', BRANCH, '--platform-id', PLATFORM, '--repo-id', REPO, '--yes', '--json'],
      [emptyBranchesPage, branchOne],
    );
    expect(deleted.exit).toBe(0);
    expect(deleted.stderr).toBe('');
    expect(() => JSON.parse(deleted.stdout)).not.toThrow();
  });
});
