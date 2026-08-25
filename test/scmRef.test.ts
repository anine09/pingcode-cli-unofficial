import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode scm ref …` end to end, with `fetch` replaced at the global boundary
 * and the config directory redirected to a temp dir. No network, no real
 * credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/scm/ref.ts`:
 * `runList` (the `--all` collect branch, the single-page branch, the required
 * `meta_type`/`meta_id` query, paging), `runGet`, `runCreate` (the dry-run gate,
 * the `created` verb), and `printRef` (both the `--json` and human paths, with
 * and without a trailing verb) plus the `refField` / `shortSha` column helpers.
 *
 * A 提交引用 joins a commit (org-level) to a branch (repository-scoped), so every
 * leaf needs a (platform, repository) pair resolved first. Most tests pass
 * `--platform-id` + `--repo-id` verbatim to skip the lookups; a few resolve a
 * name to exercise the resolve callback inside `runCreate`.
 */

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const REPO = '685d393c47512a5d5d52aa70';
const BRANCH = '6b10e8b47512a5d5d4e5b77';
const REF_ID = '5b10e8b47512a5d5d4e5b66';
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

/** The embedded commit-ref body, shared by the single-ref and list responses. */
function refBody(): Record<string, unknown> {
  return {
    id: REF_ID,
    url: 'https://github.com/acme/code-interpreter/refs/1',
    product: { id: PLATFORM, name: 'Github' },
    repository: { id: REPO, name: 'code-interpreter' },
    commit: {
      id: 'c1',
      sha: SHA,
      message: 'feat: add login',
      committer_name: 'bot',
      committed_at: 1730000000,
    },
    meta: { id: BRANCH, name: 'main', type: 'branch' },
  };
}

/** A one-page list of commit refs. */
const refsPage = () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [refBody()] });

/** A single commit ref, as the detail endpoint returns it. */
const refOne = () => jsonResponse(refBody());

const harness = createCliHarness({ beforeEach, afterEach });

// ---------------------------------------------------------------------------
// scm ref list
// ---------------------------------------------------------------------------

describe('scm ref list', () => {
  it('requires --platform before any request', async () => {
    const run = await harness.run([
      'scm',
      'ref',
      'list',
      '--branch-id',
      BRANCH,
      '--repo-id',
      REPO,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('requires --repo once a platform is given', async () => {
    const run = await harness.run([
      'scm',
      'ref',
      'list',
      '--platform-id',
      PLATFORM,
      '--branch-id',
      BRANCH,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--repo <name|full_name|id> is required');
  });

  it('rejects --repo together with --repo-id', async () => {
    const run = await harness.run([
      'scm',
      'ref',
      'list',
      '--platform-id',
      PLATFORM,
      '--repo',
      'code-interpreter',
      '--repo-id',
      REPO,
      '--branch-id',
      BRANCH,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('rejects --platform together with --platform-id', async () => {
    const run = await harness.run([
      'scm',
      'ref',
      'list',
      '--platform',
      'Github',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
      '--branch-id',
      BRANCH,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('requires --branch-id (a requiredOption) before listing', async () => {
    const run = await harness.run([
      'scm',
      'ref',
      'list',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it("lists one branch's refs with meta_type=branch and the given meta_id", async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--branch-id',
        BRANCH,
        '--json',
      ],
      [refsPage],
    );
    expect(run.exit).toBe(0);
    // Exactly one request: the list, with no preceding platform/repo resolution.
    expect(run.calls).toHaveLength(1);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.pathname).toBe(
      `/v1/scm/products/${PLATFORM}/repositories/${REPO}/refs`,
    );
    expect(url.searchParams.get('meta_type')).toBe('branch');
    expect(url.searchParams.get('meta_id')).toBe(BRANCH);
    const parsed = JSON.parse(run.stdout) as { total: number; values: { id: string }[] };
    expect(parsed.total).toBe(1);
    expect(parsed.values[0]?.id).toBe(REF_ID);
  });

  it('forwards paging as page_index / page_size', async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--branch-id',
        BRANCH,
        '--page',
        '2',
        '--page-size',
        '5',
        '--json',
      ],
      [refsPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  it('walks every ref under --all and renders a collected list', async () => {
    const refsPage1 = () =>
      jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [refBody()] });
    const refsPage2 = () =>
      jsonResponse({
        page_index: 1,
        page_size: 1,
        total: 2,
        values: [{ ...refBody(), id: 'ref-2' }],
      });
    const run = await harness.run(
      [
        'scm',
        'ref',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--branch-id',
        BRANCH,
        '--all',
        '--page-size',
        '1',
        '--limit',
        '2',
        '--json',
      ],
      [refsPage1, refsPage2],
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

  it('prints a human-mode table with the row count on stderr', async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--branch-id',
        BRANCH,
      ],
      [refsPage],
    );
    expect(run.exit).toBe(0);
    // Curated columns: id, short sha, message, branch, type.
    expect(run.stdout).toContain(REF_ID);
    expect(run.stdout).toContain(SHA.slice(0, 7));
    expect(run.stdout).toContain('feat: add login');
    expect(run.stdout).toContain('main');
    expect(run.stdout).toContain('branch');
    expect(run.stderr).toContain('row(s)');
  });

  it('drops empty-string and missing reference fields instead of printing them', async () => {
    const body = {
      id: REF_ID,
      commit: { id: 'c1', sha: '', message: '' },
      meta: { id: BRANCH, name: 'main', type: '' },
    };
    const run = await harness.run(
      [
        'scm',
        'ref',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--branch-id',
        BRANCH,
      ],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [body] })],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(REF_ID);
    expect(run.stdout).toContain('main');
    // sha '' and type '' are dropped from the row, so neither a blank nor 'branch' shows.
    expect(run.stdout).not.toContain(SHA.slice(0, 7));
    expect(run.stdout).not.toContain('branch');
  });

  it('resolves --platform by name before listing, loading the platform list once', async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'list',
        '--platform',
        'Github',
        '--repo-id',
        REPO,
        '--branch-id',
        BRANCH,
        '--json',
      ],
      [platformsPage, refsPage],
    );
    expect(run.exit).toBe(0);
    // First call loads the platform candidates; second is the ref list under the id.
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/refs?`);
  });

  it('resolves --repo by name before listing', async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--branch-id',
        BRANCH,
        '--json',
      ],
      [reposPage, refsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/refs?`);
  });
});

// ---------------------------------------------------------------------------
// scm ref get
// ---------------------------------------------------------------------------

describe('scm ref get', () => {
  it('gets one ref by id', async () => {
    const run = await harness.run(
      ['scm', 'ref', 'get', REF_ID, '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [refOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain(`/repositories/${REPO}/refs/${REF_ID}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: REF_ID });
  });

  it('passes a slug positional through untouched', async () => {
    const run = await harness.run(
      ['scm', 'ref', 'get', 'main-ref', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [refOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/refs/main-ref');
  });

  it('renders the curated field block in human mode, with no trailing verb', async () => {
    const run = await harness.run(
      ['scm', 'ref', 'get', REF_ID, '--platform-id', PLATFORM, '--repo-id', REPO],
      [refOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(REF_ID);
    expect(run.stdout).toContain(SHA.slice(0, 7));
    expect(run.stdout).toContain('feat: add login');
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('main');
    // A plain get prints no "created"/"got" notice.
    expect(run.stderr).not.toContain('created');
  });

  it('renders an empty sha cell when the embedded commit has none', async () => {
    const body = {
      id: REF_ID,
      commit: { id: 'c1', message: 'no sha here' },
      meta: { id: BRANCH, name: 'main' },
    };
    const run = await harness.run(
      ['scm', 'ref', 'get', REF_ID, '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('no sha here');
    // shortSha(undefined) → '' → the sha line is dropped, not printed blank.
    expect(run.stdout).not.toContain(SHA.slice(0, 7));
  });

  it('drops the branch-id cell when the meta reference is absent', async () => {
    // Covers the `ref.meta?.id ?? ''` fallback in printRef: meta is undefined.
    const body = {
      id: REF_ID,
      commit: { id: 'c1', sha: SHA, message: 'feat: add login' },
    };
    const run = await harness.run(
      ['scm', 'ref', 'get', REF_ID, '--platform-id', PLATFORM, '--repo-id', REPO],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    // commit fields still render; branch + branch id are dropped (meta absent).
    expect(run.stdout).toContain(SHA.slice(0, 7));
    expect(run.stdout).toContain('feat: add login');
    expect(run.stdout).not.toContain('branch id');
  });

  it('surfaces an unknown ref as exit 5 under --json', async () => {
    const run = await harness.run(
      ['scm', 'ref', 'get', 'ghost', '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [() => jsonResponse({ code: '100317', message: '资源不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });

  it('resolves --repo by name before the GET', async () => {
    const run = await harness.run(
      ['scm', 'ref', 'get', REF_ID, '--platform-id', PLATFORM, '--repo', 'code-interpreter', '--json'],
      [reposPage, refOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}/refs/${REF_ID}`);
  });
});

// ---------------------------------------------------------------------------
// scm ref create
// ---------------------------------------------------------------------------

describe('scm ref create', () => {
  it('requires --sha and --branch-id (requiredOptions)', async () => {
    const run = await harness.run([
      'scm',
      'ref',
      'create',
      '--platform-id',
      PLATFORM,
      '--repo-id',
      REPO,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('POSTs sha + meta_type=branch + meta_id and prints the created ref', async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--sha',
        SHA,
        '--branch-id',
        BRANCH,
        '--json',
      ],
      [refOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/refs`);
    expect(run.writes[0]?.body).toEqual({
      sha: SHA,
      meta_type: 'branch',
      meta_id: BRANCH,
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ id: REF_ID });
  });

  it('prints the plan and sends nothing on a dry-run create', async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--sha',
        SHA,
        '--branch-id',
        BRANCH,
        '--dry-run',
        '--json',
      ],
      [refOne],
    );
    expect(run.exit).toBe(0);
    // Read verbs still run, but a dry-run create resolves nothing here and sends
    // zero mutating requests.
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain(`/repositories/${REPO}/refs`);
    expect(plan.request.body).toEqual({
      sha: SHA,
      meta_type: 'branch',
      meta_id: BRANCH,
    });
  });

  it('announces the created ref by short sha and branch on stderr in human mode', async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--sha',
        SHA,
        '--branch-id',
        BRANCH,
      ],
      [refOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created ref ${SHA.slice(0, 7)} → main`);
  });

  it('falls back to the ref id in the created notice when the commit has no sha', async () => {
    // Covers the `sha || ref.id` fallback in printRef (sha is '').
    const body = {
      id: REF_ID,
      commit: { id: 'c1', message: 'feat: add login' },
      meta: { id: BRANCH, name: 'main' },
    };
    const run = await harness.run(
      [
        'scm',
        'ref',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--sha',
        SHA,
        '--branch-id',
        BRANCH,
      ],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created ref ${REF_ID} → main`);
  });

  it('resolves --repo by name before the POST', async () => {
    const run = await harness.run(
      [
        'scm',
        'ref',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo',
        'code-interpreter',
        '--sha',
        SHA,
        '--branch-id',
        BRANCH,
        '--json',
      ],
      [reposPage, refOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}/refs`);
  });
});

// ---------------------------------------------------------------------------
// stdout / stderr contract
// ---------------------------------------------------------------------------

describe('scm ref json stdout contract', () => {
  it('keeps stdout JSON-only on list, get and create, with notices on stderr', async () => {
    const list = await harness.run(
      [
        'scm',
        'ref',
        'list',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--branch-id',
        BRANCH,
        '--json',
      ],
      [refsPage],
    );
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const got = await harness.run(
      ['scm', 'ref', 'get', REF_ID, '--platform-id', PLATFORM, '--repo-id', REPO, '--json'],
      [refOne],
    );
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();

    const created = await harness.run(
      [
        'scm',
        'ref',
        'create',
        '--platform-id',
        PLATFORM,
        '--repo-id',
        REPO,
        '--sha',
        SHA,
        '--branch-id',
        BRANCH,
        '--json',
      ],
      [refOne],
    );
    expect(created.exit).toBe(0);
    expect(created.stderr).toBe('');
    expect(() => JSON.parse(created.stdout)).not.toThrow();
  });

  it('keeps stdout JSON-only on update… there is none: a ref is permanent, so no update/delete leaves exist', async () => {
    // `scm ref` exposes only list / get / create (there is no update and no delete —
    // a ref is permanent). An unknown leaf is refused by commander, exit 2, with
    // nothing sent.
    const run = await harness.run(
      ['scm', 'ref', 'update', REF_ID, '--platform-id', PLATFORM, '--repo-id', REPO],
      [refOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });
});
