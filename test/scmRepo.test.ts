import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode scm repo …` end to end, with `fetch` replaced at the global boundary
 * and the config directory redirected to a temp dir. No network, no real
 * credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/scm/repo.ts`:
 * `runList` (the `--all` collect branch, the single-page branch, the `--full-name`
 * filter — the only filter the endpoint honours, paging), `runGet` (name /
 * full_name / id resolution, the ambiguity refusal, the unknown-name refusal,
 * the curated block and its empty-cell fallbacks), `runCreate` / `runUpdate`
 * (the shared `fieldsFrom` field mapping, the `--fork` / `--private` boolean-flag
 * parsing, the empty-patch refusal, the dry-run gate, the `created` / `updated`
 * verbs) and `printRepository` (both the `--json` and human paths, with and
 * without a trailing verb).
 *
 * A 代码仓库 is platform-scoped and resolved **client-side**: `full_name`
 * (`owner/name`) is the unique key, names collide, and the `<repo>` positional is
 * matched against the loaded repository list (id / name / full_name) before any
 * detail request — so an unknown name is an exit-2 "no repo matches" listing the
 * candidates, never a server round-trip. `scm repo` has no `--repo` / `--repo-id`
 * pair: the repository *is* the positional, so every `get` / `update` first loads
 * the platform's repository list.
 */

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const REPO = '685d393c47512a5d5d52aa70';
const REPO2 = '685d393c47512a5d5d52aa71';
const OWNER_ID = '6a10e8b47512a5d5d4e5a01';
const CREATED_AT = 1730000000;

/** A hosting-platform list, for the `--platform <name>` bootstrap hop. */
const platformsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: PLATFORM, name: 'Github', type: 'github' }],
  });

/** A rich repository body, shared by the detail and list responses. */
function repoBody(): Record<string, unknown> {
  return {
    id: REPO,
    url: 'https://github.com/acme/code-interpreter',
    name: 'code-interpreter',
    full_name: 'acme/code-interpreter',
    description: 'The interpreter',
    is_private: true,
    is_fork: false,
    owner: { id: OWNER_ID, name: 'acme' },
    product: { id: PLATFORM, name: 'Github' },
    html_url: 'https://github.com/acme/code-interpreter',
    branches_url: 'https://github.com/acme/code-interpreter/tree/{branch}',
    commits_url: 'https://github.com/acme/code-interpreter/commit/{sha}',
    compare_url: 'https://github.com/acme/code-interpreter/compare/{base}...{head}',
    pulls_url: 'https://github.com/acme/code-interpreter/pull/{number}',
    created_at: CREATED_AT,
  };
}

/** A one-page repository list (one repo), for name / full_name / id resolution. */
const reposPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [repoBody()] });

/** Two repositories sharing the `name` (an ambiguity), different full_names. */
const ambiguousReposPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { ...repoBody(), id: REPO, full_name: 'acme/code-interpreter' },
      { ...repoBody(), id: REPO2, full_name: 'org/code-interpreter' },
    ],
  });

/** A single repository, as the detail endpoint returns it. */
const repoOne = () => jsonResponse(repoBody());

const harness = createCliHarness({ beforeEach, afterEach });

// ---------------------------------------------------------------------------
// scm repo list
// ---------------------------------------------------------------------------

describe('scm repo list', () => {
  it('requires --platform before any request', async () => {
    const run = await harness.run(['scm', 'repo', 'list']);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('rejects --platform together with --platform-id', async () => {
    const run = await harness.run([
      'scm',
      'repo',
      'list',
      '--platform',
      'Github',
      '--platform-id',
      PLATFORM,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('lists one page of a platform by id, with the curated columns', async () => {
    const run = await harness.run(['scm', 'repo', 'list', '--platform-id', PLATFORM, '--json'], [
      reposPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.pathname).toBe(`/v1/scm/products/${PLATFORM}/repositories`);
    const parsed = JSON.parse(run.stdout) as { total: number; values: { id: string }[] };
    expect(parsed.total).toBe(1);
    expect(parsed.values[0]?.id).toBe(REPO);
  });

  it('forwards --full-name as the only honoured filter', async () => {
    const run = await harness.run(
      [
        'scm',
        'repo',
        'list',
        '--platform-id',
        PLATFORM,
        '--full-name',
        'acme/code-interpreter',
        '--json',
      ],
      [reposPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('full_name')).toBe('acme/code-interpreter');
  });

  it('omits the filter entirely when --full-name is absent', async () => {
    const run = await harness.run(['scm', 'repo', 'list', '--platform-id', PLATFORM, '--json'], [
      reposPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).not.toContain('full_name=');
  });

  it('forwards paging as page_index / page_size', async () => {
    const run = await harness.run(
      ['scm', 'repo', 'list', '--platform-id', PLATFORM, '--page', '2', '--page-size', '5', '--json'],
      [reposPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  it('walks every repository under --all and renders a collected list', async () => {
    const page1 = () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [repoBody()] });
    const page2 = () =>
      jsonResponse({
        page_index: 1,
        page_size: 1,
        total: 2,
        values: [{ ...repoBody(), id: REPO2, full_name: 'org/code-interpreter' }],
      });
    const run = await harness.run(
      [
        'scm',
        'repo',
        'list',
        '--platform-id',
        PLATFORM,
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
    const parsed = JSON.parse(run.stdout) as { all: boolean; count: number; values: unknown[] };
    expect(parsed.all).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.values).toHaveLength(2);
  });

  it('walks every page in human mode too, with the collected row count on stderr', async () => {
    const page1 = () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [repoBody()] });
    const page2 = () =>
      jsonResponse({
        page_index: 1,
        page_size: 1,
        total: 2,
        values: [{ ...repoBody(), id: REPO2, full_name: 'org/code-interpreter' }],
      });
    const run = await harness.run(
      ['scm', 'repo', 'list', '--platform-id', PLATFORM, '--all', '--page-size', '1', '--limit', '2'],
      [page1, page2],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(REPO);
    expect(run.stdout).toContain(REPO2);
    expect(run.stderr).toContain('2 row(s)');
  });

  it('prints a human-mode table with the curated columns and a row count', async () => {
    const run = await harness.run(['scm', 'repo', 'list', '--platform-id', PLATFORM], [reposPage]);
    expect(run.exit).toBe(0);
    // Curated columns: id, full name, owner, private, fork.
    expect(run.stdout).toContain(REPO);
    expect(run.stdout).toContain('acme/code-interpreter');
    expect(run.stdout).toContain('acme');
    expect(run.stdout).toContain('yes');
    expect(run.stdout).toContain('no');
    expect(run.stderr).toContain('row(s) of');
  });

  it('renders an empty full-name cell rather than "undefined" when a row lacks one', async () => {
    // Covers the `repo.full_name ?? repo.name ?? ''` fallback in REPOSITORY_COLUMNS,
    // and both boolean branches (private false → "no", fork true → "yes") in the
    // list-table columns.
    const sparse = () =>
      jsonResponse({
        page_index: 0,
        page_size: 30,
        total: 1,
        values: [{ id: REPO, is_private: false, is_fork: true }],
      });
    const run = await harness.run(['scm', 'repo', 'list', '--platform-id', PLATFORM], [sparse]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(REPO);
    expect(run.stdout).toContain('yes'); // fork true
    expect(run.stdout).toContain('no'); // private false
    expect(run.stdout).not.toContain('undefined');
  });

  it('resolves --platform by name before listing, loading the platform list once', async () => {
    const run = await harness.run(['scm', 'repo', 'list', '--platform', 'Github', '--json'], [
      platformsPage,
      reposPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
  });
});

// ---------------------------------------------------------------------------
// scm repo get
// ---------------------------------------------------------------------------

describe('scm repo get', () => {
  it('requires --platform before any request', async () => {
    const run = await harness.run(['scm', 'repo', 'get', REPO]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('rejects --platform together with --platform-id', async () => {
    const run = await harness.run([
      'scm',
      'repo',
      'get',
      REPO,
      '--platform',
      'Github',
      '--platform-id',
      PLATFORM,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('gets one repository by id, resolving it against the loaded list first', async () => {
    const run = await harness.run(
      ['scm', 'repo', 'get', REPO, '--platform-id', PLATFORM, '--json'],
      [reposPage, repoOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: REPO, full_name: 'acme/code-interpreter' });
  });

  it('resolves the <repo> positional by name before the detail GET', async () => {
    const run = await harness.run(
      ['scm', 'repo', 'get', 'code-interpreter', '--platform-id', PLATFORM, '--json'],
      [reposPage, repoOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}`);
  });

  it('resolves the <repo> positional by full_name (owner/name) alias', async () => {
    const run = await harness.run(
      ['scm', 'repo', 'get', 'acme/code-interpreter', '--platform-id', PLATFORM, '--json'],
      [reposPage, repoOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/repositories/${REPO}`);
  });

  it('refuses an ambiguous name, listing the candidate ids, and sends no detail GET', async () => {
    const run = await harness.run(
      ['scm', 'repo', 'get', 'code-interpreter', '--platform-id', PLATFORM, '--json'],
      [ambiguousReposPage],
    );
    expect(run.exit).toBe(2);
    // Only the repository list was loaded; the ambiguity is caught before the GET.
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('matches 2 repos');
    expect(run.stderr).toContain(REPO);
    expect(run.stderr).toContain(REPO2);
  });

  it('refuses an unknown name with the candidate list, sending no detail GET', async () => {
    const run = await harness.run(
      ['scm', 'repo', 'get', 'ghost', '--platform-id', PLATFORM],
      [reposPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    // An error goes to stderr in both modes; stdout stays empty.
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no repo matches');
    expect(run.stderr).toContain('ghost');
    // The hint lists the visible candidates, so the refusal is actionable.
    expect(run.stderr).toContain('available:');
    expect(run.stderr).toContain(REPO);
  });

  it('surfaces a server-side absence as exit 5 once the id resolved', async () => {
    // The id is in the loaded list (so client-side resolution succeeds), but the
    // detail GET answers 400 100202 → mapped to not_found.
    const run = await harness.run(
      ['scm', 'repo', 'get', REPO, '--platform-id', PLATFORM, '--json'],
      [reposPage, () => jsonResponse({ code: '100202', message: 'repository 不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });

  it('resolves --platform by name before resolving the repository', async () => {
    const run = await harness.run(['scm', 'repo', 'get', REPO, '--platform', 'Github', '--json'], [
      platformsPage,
      reposPage,
      repoOne,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.calls[2]?.url).toContain(`/repositories/${REPO}`);
  });

  it('renders the curated field block in human mode, with no trailing verb', async () => {
    const run = await harness.run(['scm', 'repo', 'get', REPO, '--platform-id', PLATFORM], [
      reposPage,
      repoOne,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('acme/code-interpreter');
    expect(run.stdout).toContain(REPO);
    expect(run.stdout).toContain('Github');
    expect(run.stdout).toContain('acme');
    expect(run.stdout).toContain('yes');
    expect(run.stdout).toContain('no');
    expect(run.stdout).toContain('The interpreter');
    // A plain get prints no "created"/"updated" notice.
    expect(run.stderr).toBe('');
  });

  it('drops the empty reference and text cells instead of printing them blank', async () => {
    // The detail row omits full_name / name / owner / product / html_url / description,
    // so those lines are dropped (only id / private / fork / created remain).
    const sparse = () => jsonResponse({ id: REPO, is_private: false, is_fork: true, created_at: CREATED_AT });
    const run = await harness.run(['scm', 'repo', 'get', REPO, '--platform-id', PLATFORM], [
      reposPage,
      sparse,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(REPO);
    expect(run.stdout).toContain('no'); // private false
    expect(run.stdout).toContain('yes'); // fork true
    expect(run.stdout).not.toContain('full name');
    expect(run.stdout).not.toContain('owner');
    expect(run.stdout).not.toContain('page');
    expect(run.stdout).not.toContain('description');
  });
});

// ---------------------------------------------------------------------------
// scm repo create
// ---------------------------------------------------------------------------

describe('scm repo create', () => {
  const baseArgs = [
    'scm',
    'repo',
    'create',
    '--platform-id',
    PLATFORM,
    '--name',
    'code-interpreter',
    '--full-name',
    'acme/code-interpreter',
  ];

  it('requires --name and --full-name (requiredOptions)', async () => {
    const run = await harness.run(['scm', 'repo', 'create', '--platform-id', PLATFORM]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('requires --platform (action-level) before the POST', async () => {
    const run = await harness.run([
      'scm',
      'repo',
      'create',
      '--name',
      'code-interpreter',
      '--full-name',
      'acme/code-interpreter',
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('POSTs only the required fields when no optional flag is given', async () => {
    const run = await harness.run([...baseArgs, '--json'], [repoOne]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories`);
    expect(run.writes[0]?.body).toEqual({
      name: 'code-interpreter',
      full_name: 'acme/code-interpreter',
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ id: REPO });
  });

  it('maps every optional field flag into the snake_case body', async () => {
    const run = await harness.run(
      [
        ...baseArgs,
        '--description',
        'The interpreter',
        '--owner-name',
        'acme',
        '--private',
        'true',
        '--fork',
        'false',
        '--html-url',
        'https://github.com/acme/code-interpreter',
        '--branches-url',
        'https://github.com/acme/code-interpreter/tree/{branch}',
        '--commits-url',
        'https://github.com/acme/code-interpreter/commit/{sha}',
        '--compare-url',
        'https://github.com/acme/code-interpreter/compare/{base}...{head}',
        '--pulls-url',
        'https://github.com/acme/code-interpreter/pull/{number}',
        '--json',
      ],
      [repoOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      name: 'code-interpreter',
      full_name: 'acme/code-interpreter',
      description: 'The interpreter',
      owner_name: 'acme',
      is_private: true,
      is_fork: false,
      html_url: 'https://github.com/acme/code-interpreter',
      branches_url: 'https://github.com/acme/code-interpreter/tree/{branch}',
      commits_url: 'https://github.com/acme/code-interpreter/commit/{sha}',
      compare_url: 'https://github.com/acme/code-interpreter/compare/{base}...{head}',
      pulls_url: 'https://github.com/acme/code-interpreter/pull/{number}',
    });
  });

  it('parses --fork as a three-state boolean, leaving an omitted --private alone', async () => {
    // `--fork yes` → is_fork true; --private absent → is_private not sent.
    const run = await harness.run([...baseArgs, '--fork', 'yes', '--json'], [repoOne]);
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toMatchObject({ is_fork: true });
    expect(run.writes[0]?.body).not.toHaveProperty('is_private');
  });

  it('refuses an unrecognised --private value before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs, '--private', 'maybe', '--json'], [repoOne]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--private expects true|false');
  });

  it('refuses an unrecognised --fork value before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs, '--fork', 'sure', '--json'], [repoOne]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--fork expects true|false');
  });

  it('prints the plan and sends nothing on a dry-run create with ids (no reads)', async () => {
    const run = await harness.run([...baseArgs, '--dry-run', '--json'], [repoOne]);
    expect(run.exit).toBe(0);
    // A dry-run create with --platform-id resolves nothing and sends zero requests.
    expect(run.calls).toEqual([]);
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain(`/v1/scm/products/${PLATFORM}/repositories`);
    expect(plan.request.body).toEqual({
      name: 'code-interpreter',
      full_name: 'acme/code-interpreter',
    });
  });

  it('still resolves --platform by name on a dry-run, so the read fires but no write is sent', async () => {
    const run = await harness.run(
      [
        'scm',
        'repo',
        'create',
        '--platform',
        'Github',
        '--name',
        'code-interpreter',
        '--full-name',
        'acme/code-interpreter',
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
    const plan = JSON.parse(run.stdout) as { request: { method: string } };
    expect(plan.request.method).toBe('POST');
  });

  it('resolves --platform by name before the POST', async () => {
    const run = await harness.run(
      [
        'scm',
        'repo',
        'create',
        '--platform',
        'Github',
        '--name',
        'code-interpreter',
        '--full-name',
        'acme/code-interpreter',
        '--json',
      ],
      [platformsPage, repoOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.writes[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories`);
  });

  it('announces the created repository by full_name on stderr in human mode', async () => {
    const run = await harness.run([...baseArgs], [repoOne]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created acme/code-interpreter');
  });

  it('falls back to the repository name in the created notice when full_name is absent', async () => {
    // Covers the `repo.name ?? repo.id` fallback in the `${verb} …` notice.
    const run = await harness.run([...baseArgs], [() => jsonResponse({ id: REPO, name: 'code-interpreter' })]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created code-interpreter');
  });

  it('falls back to the repository id in the created notice when both are absent', async () => {
    // Covers the final `repo.id` fallback in the `${verb} …` notice.
    const run = await harness.run([...baseArgs], [() => jsonResponse({ id: REPO })]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created ${REPO}`);
  });
});

// ---------------------------------------------------------------------------
// scm repo update
// ---------------------------------------------------------------------------

describe('scm repo update', () => {
  const baseArgs = ['scm', 'repo', 'update', REPO, '--platform-id', PLATFORM];

  it('refuses an empty patch before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs], [repoOne]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('nothing to update');
  });

  it('PATCHes only the patched fields, resolving the repo by id first', async () => {
    const run = await harness.run(
      [
        ...baseArgs,
        '--name',
        'new-name',
        '--full-name',
        'org/new-name',
        '--description',
        'new desc',
        '--private',
        'false',
        '--json',
      ],
      [reposPage, repoOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}`);
    expect(run.writes[0]?.body).toEqual({
      name: 'new-name',
      full_name: 'org/new-name',
      description: 'new desc',
      is_private: false,
    });
  });

  it('resolves the <repo> positional by name before the PATCH', async () => {
    const run = await harness.run(
      ['scm', 'repo', 'update', 'code-interpreter', '--platform-id', PLATFORM, '--name', 'new-name', '--json'],
      [reposPage, repoOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/repositories?`);
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}`);
  });

  it('resolves the <repo> positional by full_name before the PATCH', async () => {
    const run = await harness.run(
      [
        'scm',
        'repo',
        'update',
        'acme/code-interpreter',
        '--platform-id',
        PLATFORM,
        '--name',
        'new-name',
        '--json',
      ],
      [reposPage, repoOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.url).toContain(`/repositories/${REPO}`);
  });

  it('refuses an ambiguous repo name before the PATCH, sending nothing', async () => {
    const run = await harness.run(
      ['scm', 'repo', 'update', 'code-interpreter', '--platform-id', PLATFORM, '--name', 'new-name', '--json'],
      [ambiguousReposPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toEqual([]);
    expect(run.stderr).toContain('matches 2 repos');
  });

  it('refuses an unrecognised --fork value before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs, '--fork', 'perhaps', '--json'], [repoOne]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--fork expects true|false');
  });

  it('still resolves the repo on a dry-run, so the read fires but no write is sent', async () => {
    const run = await harness.run(
      [
        'scm',
        'repo',
        'update',
        'code-interpreter',
        '--platform-id',
        PLATFORM,
        '--name',
        'new-name',
        '--dry-run',
        '--json',
      ],
      [reposPage],
    );
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
    expect(plan.request.body).toEqual({ name: 'new-name' });
  });

  it('surfaces a server-side absence on the PATCH as exit 5', async () => {
    // The repo resolved by name (not from cache), so a 400 100202 surfaces directly
    // with no cache-invalidation retry.
    const run = await harness.run(
      [...baseArgs, '--name', 'new-name', '--json'],
      [reposPage, () => jsonResponse({ code: '100202', message: 'repository 不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.writes).toHaveLength(1);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });

  it('announces the updated repository by full_name on stderr in human mode', async () => {
    const run = await harness.run([...baseArgs, '--name', 'new-name'], [reposPage, repoOne]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('updated acme/code-interpreter');
  });
});

// ---------------------------------------------------------------------------
// stdout / stderr contract
// ---------------------------------------------------------------------------

describe('scm repo json stdout contract', () => {
  it('keeps stdout JSON-only on list, get, create and update, with notices on stderr', async () => {
    const list = await harness.run(['scm', 'repo', 'list', '--platform-id', PLATFORM, '--json'], [
      reposPage,
    ]);
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const got = await harness.run(
      ['scm', 'repo', 'get', REPO, '--platform-id', PLATFORM, '--json'],
      [reposPage, repoOne],
    );
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();

    const created = await harness.run(
      [
        'scm',
        'repo',
        'create',
        '--platform-id',
        PLATFORM,
        '--name',
        'code-interpreter',
        '--full-name',
        'acme/code-interpreter',
        '--json',
      ],
      [repoOne],
    );
    expect(created.exit).toBe(0);
    // The create notice goes to stderr (human-only path is skipped under --json),
    // so stdout stays JSON-only.
    expect(created.stderr).toBe('');
    expect(() => JSON.parse(created.stdout)).not.toThrow();

    const updated = await harness.run(
      ['scm', 'repo', 'update', REPO, '--platform-id', PLATFORM, '--name', 'new-name', '--json'],
      [reposPage, repoOne],
    );
    expect(updated.exit).toBe(0);
    expect(updated.stderr).toBe('');
    expect(() => JSON.parse(updated.stdout)).not.toThrow();
  });

  it('keeps stdout JSON-only on a human-mode update, the "updated" notice going to stderr', async () => {
    const run = await harness.run([...['scm', 'repo', 'update', REPO, '--platform-id', PLATFORM, '--name', 'new-name']], [
      reposPage,
      repoOne,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(REPO);
    expect(run.stderr).toContain('updated acme/code-interpreter');
    // The curated block is valid on stdout; the notice is the only stderr line.
  });

  it('offers no delete and no replace leaf', async () => {
    for (const verb of ['delete', 'replace']) {
      const run = await harness.run(
        ['scm', 'repo', verb, REPO, '--platform-id', PLATFORM],
        [],
      );
      expect(run.exit, verb).toBe(2);
      expect(run.calls, verb).toEqual([]);
    }
  });
});
