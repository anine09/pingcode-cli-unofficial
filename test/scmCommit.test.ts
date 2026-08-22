import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode scm commit …` end to end, with `fetch` replaced at the global
 * boundary and the config directory redirected to a temp dir. No network, no
 * real credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/scm/commit.ts`:
 * `runList` (the `--all` collect branch, the single-page branch, the optional
 * `--sha` / `--work-item-id` query filters, paging), `runGet` (the verbatim
 * id-or-SHA pass-through, the curated field block, the empty-cell fallbacks),
 * `runCreate` (the dry-run gate, the required file arrays defaulted to `[]`,
 * the optional `--tree-id` and `--work-item` fields, the `created` verb, the
 * unlinked-work-item warning) and `printCommit` (both `--json` and human paths,
 * with and without a trailing verb) plus the `shortSha` / `oneLine` /
 * `identifiersOf` cell helpers.
 *
 * A 提交 is the one scm resource that is **not** platform-scoped: its three
 * leaves take no `--platform` and resolve nothing. Every leaf here is therefore
 * a single request with no resolution hop.
 */

const COMMIT_ID = '6a10e8b47512a5d5d4e5c01';
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

/** A commit body, shared by the single-commit and list responses. */
function commitBody(): Record<string, unknown> {
  return {
    id: COMMIT_ID,
    url: 'https://github.com/acme/code-interpreter/commits/1',
    sha: SHA,
    message: 'feat: add login\nwith a second line',
    committer_name: 'bot',
    committed_at: 1730000000,
    tree_id: 'tree123',
    files_added: ['a.ts'],
    files_removed: ['b.ts'],
    files_modified: ['c.ts'],
    file_changed_count: 3,
    work_items: [{ id: 'w1', identifier: 'PLM-001', name: 'Login' }],
  };
}

/** A one-page list of commits. */
const commitsPage = () =>
  jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [commitBody()] });

/** A single commit, as the detail endpoint returns it. */
const commitOne = () => jsonResponse(commitBody());

const harness = createCliHarness({ beforeEach, afterEach });

// ---------------------------------------------------------------------------
// scm commit list
// ---------------------------------------------------------------------------

describe('scm commit list', () => {
  it('lists commits with no platform/repo query — the endpoint is org-level', async () => {
    const run = await harness.run(['scm', 'commit', 'list', '--json'], [commitsPage]);
    expect(run.exit).toBe(0);
    // Exactly one request, against the org-level commits path with no product id.
    expect(run.calls).toHaveLength(1);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.pathname).toBe('/v1/scm/commits');
    expect(url.searchParams.get('product_id')).toBeNull();
    expect(url.searchParams.get('repository_id')).toBeNull();
    const parsed = JSON.parse(run.stdout) as { total: number; values: { id: string }[] };
    expect(parsed.total).toBe(1);
    expect(parsed.values[0]?.id).toBe(COMMIT_ID);
  });

  it('forwards --sha as an exact full-SHA query', async () => {
    const run = await harness.run(
      ['scm', 'commit', 'list', '--sha', SHA, '--json'],
      [commitsPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('sha')).toBe(SHA);
  });

  it('forwards --work-item-id as a work_item_id query', async () => {
    const run = await harness.run(
      ['scm', 'commit', 'list', '--work-item-id', COMMIT_ID, '--json'],
      [commitsPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('work_item_id')).toBe(COMMIT_ID);
  });

  it('omits filters entirely when neither is given', async () => {
    const run = await harness.run(['scm', 'commit', 'list', '--json'], [commitsPage]);
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.has('sha')).toBe(false);
    expect(url.searchParams.has('work_item_id')).toBe(false);
  });

  it('forwards paging as page_index / page_size', async () => {
    const run = await harness.run(
      ['scm', 'commit', 'list', '--page', '2', '--page-size', '5', '--json'],
      [commitsPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  it('walks every commit under --all and renders a collected list', async () => {
    const page1 = () =>
      jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [commitBody()] });
    const page2 = () =>
      jsonResponse({
        page_index: 1,
        page_size: 1,
        total: 2,
        values: [{ ...commitBody(), id: 'commit-2' }],
      });
    const run = await harness.run(
      ['scm', 'commit', 'list', '--all', '--page-size', '1', '--limit', '2', '--json'],
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
    const run = await harness.run(['scm', 'commit', 'list'], [commitsPage]);
    expect(run.exit).toBe(0);
    // Curated columns: short sha, message, committer, committed, files, work items.
    expect(run.stdout).toContain(SHA.slice(0, 7));
    expect(run.stdout).toContain('feat: add login with a second line');
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('PLM-001');
    expect(run.stderr).toContain('row(s)');
  });

  it('drops empty and missing cells instead of printing them', async () => {
    const body = {
      id: COMMIT_ID,
      sha: '',
      message: '',
      files_added: [],
      files_removed: [],
      files_modified: [],
      work_items: [],
    };
    const run = await harness.run(
      ['scm', 'commit', 'list'],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [body] })],
    );
    expect(run.exit).toBe(0);
    // The list table has no id column; empty sha/message/committer/committed/work-items
    // cells are dropped, leaving only the files-count cell (file_changed_count defaults
    // to '0' here). So the sha and work-item identifiers do not appear.
    expect(run.stdout).not.toContain(SHA.slice(0, 7));
    expect(run.stdout).not.toContain('PLM-001');
    expect(run.stdout).toContain('FILES');
  });
});

// ---------------------------------------------------------------------------
// scm commit get
// ---------------------------------------------------------------------------

describe('scm commit get', () => {
  it('gets one commit by id', async () => {
    const run = await harness.run(['scm', 'commit', 'get', COMMIT_ID, '--json'], [commitOne]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain(`/v1/scm/commits/${COMMIT_ID}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: COMMIT_ID });
  });

  it('passes a full 40-hex SHA through verbatim, untouched', async () => {
    const run = await harness.run(['scm', 'commit', 'get', SHA, '--json'], [commitOne]);
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/scm/commits/${SHA}`);
  });

  it('renders the curated field block in human mode, with no trailing verb', async () => {
    const run = await harness.run(['scm', 'commit', 'get', COMMIT_ID], [commitOne]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(SHA.slice(0, 7));
    expect(run.stdout).toContain('feat: add login with a second line');
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('a.ts');
    expect(run.stdout).toContain('PLM-001');
    // A plain get prints no "created"/"got" notice.
    expect(run.stderr).not.toContain('created');
  });

  it('drops the sha line when the commit has no sha', async () => {
    // Covers the `commit.sha ?? ''` fallback in printCommit: sha is ''.
    const body = { ...commitBody(), sha: undefined };
    const run = await harness.run(
      ['scm', 'commit', 'get', COMMIT_ID],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('feat: add login');
    // shortSha(undefined) → '' → the sha line is dropped, not printed blank.
    expect(run.stdout).not.toContain(SHA.slice(0, 7));
  });

  it('drops the url line when the commit has no url', async () => {
    // Covers the `commit.url ?? ''` fallback: url is absent → the line is dropped.
    const body = { ...commitBody(), url: undefined };
    const run = await harness.run(
      ['scm', 'commit', 'get', COMMIT_ID],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(COMMIT_ID);
    expect(run.stdout).not.toContain('url');
  });

  it('surfaces an unknown commit as exit 5 under --json', async () => {
    const run = await harness.run(
      ['scm', 'commit', 'get', 'ghost', '--json'],
      [() => jsonResponse({ code: '100317', message: '资源不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });
});

// ---------------------------------------------------------------------------
// scm commit create
// ---------------------------------------------------------------------------

describe('scm commit create', () => {
  it('requires --sha, --message, --committer and --committed-at (requiredOptions)', async () => {
    const run = await harness.run(['scm', 'commit', 'create', '--sha', SHA]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('POSTs the full body, defaulting all three file arrays to []', async () => {
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
        '--json',
      ],
      [commitOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain('/v1/scm/commits');
    expect(run.writes[0]?.body).toEqual({
      sha: SHA,
      message: 'feat: add login',
      committer_name: 'bot',
      committed_at: 1730000000,
      files_added: [],
      files_removed: [],
      files_modified: [],
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ id: COMMIT_ID });
  });

  it('accepts a date string for --committed-at and converts it to unix seconds', async () => {
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '2026-08-03T09:00:00Z',
        '--json',
      ],
      [commitOne],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as { committed_at: number };
    // 2026-08-03T09:00:00Z → 1785747600 (a fixed instant, server-side is unix seconds).
    expect(body.committed_at).toBe(1785747600);
  });

  it('includes --tree-id when given', async () => {
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
        '--tree-id',
        'tree123',
        '--json',
      ],
      [commitOne],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as { tree_id: string };
    expect(body.tree_id).toBe('tree123');
  });

  it('forwards the file arrays and work-item identifiers when given', async () => {
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
        '--added',
        'a.ts',
        '--removed',
        'b.ts',
        '--modified',
        'c.ts',
        '--work-item',
        'PLM-001',
        '--json',
      ],
      [commitOne],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as {
      files_added: string[];
      files_removed: string[];
      files_modified: string[];
      work_item_identifiers: string[];
    };
    expect(body.files_added).toEqual(['a.ts']);
    expect(body.files_removed).toEqual(['b.ts']);
    expect(body.files_modified).toEqual(['c.ts']);
    expect(body.work_item_identifiers).toEqual(['PLM-001']);
  });

  it('rejects a blank --work-item identifier before the request', async () => {
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
        '--work-item',
        '  ',
        '--json',
      ],
      [commitOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--work-item must not be empty');
  });

  it('rejects a non-date --committed-at before the request', async () => {
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        'not-a-date',
        '--json',
      ],
      [commitOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--committed-at is not a date');
  });

  it('prints the plan and sends nothing on a dry-run create', async () => {
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
        '--dry-run',
        '--json',
      ],
      [commitOne],
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
    expect(plan.request.url).toContain('/v1/scm/commits');
    expect(plan.request.body).toEqual({
      sha: SHA,
      message: 'feat: add login',
      committer_name: 'bot',
      committed_at: 1730000000,
      files_added: [],
      files_removed: [],
      files_modified: [],
    });
  });

  it('announces the created commit by short sha on stderr in human mode', async () => {
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
      ],
      [commitOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created ${SHA.slice(0, 7)}`);
  });

  it('falls back to the commit id in the created notice when there is no sha', async () => {
    // Covers the `shortSha(commit.sha) || commit.id` fallback in printCommit.
    const body = { ...commitBody(), sha: undefined };
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
      ],
      [() => jsonResponse(body)],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created ${COMMIT_ID}`);
  });

  it('warns on stderr when a requested work item was silently not linked', async () => {
    // The response echoes only PLM-001; NOSUCH-99999 was accepted-and-ignored.
    const body = {
      ...commitBody(),
      work_items: [{ id: 'w1', identifier: 'PLM-001' }],
    };
    const run = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
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
});

// ---------------------------------------------------------------------------
// stdout / stderr contract
// ---------------------------------------------------------------------------

describe('scm commit json stdout contract', () => {
  it('keeps stdout JSON-only on list, get and create, with notices on stderr', async () => {
    const list = await harness.run(['scm', 'commit', 'list', '--json'], [commitsPage]);
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const got = await harness.run(['scm', 'commit', 'get', COMMIT_ID, '--json'], [commitOne]);
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();

    const created = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
        '--json',
      ],
      [commitOne],
    );
    expect(created.exit).toBe(0);
    // The create notice goes to stderr (human-only path is skipped under --json),
    // so stdout stays JSON-only.
    expect(created.stderr).toBe('');
    expect(() => JSON.parse(created.stdout)).not.toThrow();
  });

  it('keeps stdout JSON-only even when the unlinked-work-item warning fires', async () => {
    const body = { ...commitBody(), work_items: [] };
    const created = await harness.run(
      [
        'scm',
        'commit',
        'create',
        '--sha',
        SHA,
        '--message',
        'feat: add login',
        '--committer',
        'bot',
        '--committed-at',
        '1730000000',
        '--work-item',
        'NOSUCH-99999',
        '--json',
      ],
      [() => jsonResponse(body)],
    );
    expect(created.exit).toBe(0);
    // The warning is a log (stderr); stdout is the resource JSON, still parseable.
    expect(created.stderr).toContain('NOSUCH-99999');
    expect(() => JSON.parse(created.stdout)).not.toThrow();
  });
});
