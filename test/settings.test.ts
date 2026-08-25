import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `settings users` end to end, through the real `buildProgram()` tree with
 * `fetch` replaced at the global boundary and the config directory redirected to
 * a temp dir. No network, no real credentials.
 *
 * `settings` is a single-leaf group (`settings users`), so every branch of
 * `src/cli/commands/settings.ts` lives in that one action: the `--all` vs single-page
 * split, the conditional `--keywords` query field, the `--json` vs table render, and
 * the paging flags. This suite hits each one and asserts the outbound request rather
 * than the response body.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const UID_FULL = 'a0417f68e846aae315c85d24643678a9';
const UID_NAME_ONLY = 'b1528c79f957bbf426d96e35754789ab';
const UID_BARE = 'c2639d80a068cc00537ea746868910bc';

/** A directory user carrying every rendered column. */
const userFull = {
  id: UID_FULL,
  name: '张三本名',
  display_name: '张三',
  username: 'zhangsan',
  email: 'zs@example.com',
  is_deleted: 0,
};

/** A user with no `display_name`, so the NAME column falls back to `name`. */
const userNameOnly = {
  id: UID_NAME_ONLY,
  name: '李四本名',
  username: 'lisi',
  is_deleted: 0,
};

/** A user with neither display name nor name, so the NAME cell is empty. */
const userBare = { id: UID_BARE, username: 'bare', is_deleted: 0 };

function usersPage(values: unknown[], overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    page_index: 0,
    page_size: 30,
    total: values.length,
    values,
    ...overrides,
  });
}

describe('settings users — single page', () => {
  it('renders the member table on stdout with the row count on stderr', async () => {
    const run = await runCli(['settings', 'users'], [() => usersPage([userFull])]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('张三');
    expect(run.stdout).toContain('zhangsan');
    expect(run.stdout).toContain('zs@example.com');
    // The row-count footnote is a table side note, so it belongs on stderr.
    expect(run.stderr).toContain('1 row(s)');
    // The 32-hex id passes through untouched (research §6.8).
    const url = run.calls[0]?.url ?? '';
    expect(url).toContain('/v1/directory/users');
  });

  it('falls back from display_name to name, and to empty, in the NAME column', async () => {
    // `userNameOnly` has no display_name → `name`; `userBare` has neither → ''.
    const run = await runCli(
      ['settings', 'users'],
      [() => usersPage([userNameOnly, userBare])],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('李四本名');
    // The bare user still renders a row with a blank name cell — the table is not dropped.
    expect(run.stdout).toContain('bare');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('keeps stdout to JSON alone under --json, with the {values,count} shape', async () => {
    const run = await runCli(['settings', 'users', '--json'], [() => usersPage([userFull])]);
    expect(run.exit).toBe(0);
    // stdout purity: no row-count footnote leaks onto stdout.
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as {
      values: { id: string }[];
      count: number;
      all?: boolean;
    };
    expect(parsed.count).toBe(1);
    expect(parsed.values[0]?.id).toBe(UID_FULL);
    // The single-page path is not an `--all` walk, so it never advertises `all`.
    expect(parsed.all).toBeUndefined();
  });

  it('renders "no results" on stderr when the directory answers with an empty page', async () => {
    const run = await runCli(['settings', 'users'], [() => usersPage([])]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no results');
  });

  it('renders an empty collection under --json without a crash', async () => {
    const run = await runCli(['settings', 'users', '--json'], [() => usersPage([])]);
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ values: [], count: 0 });
  });
});

describe('settings users — filters and paging', () => {
  it('sends --keywords as the fuzzy-search query parameter', async () => {
    const run = await runCli(
      ['settings', 'users', '--keywords', 'zhang', '--json'],
      [() => usersPage([userFull])],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/directory/users');
    expect(url.searchParams.get('keywords')).toBe('zhang');
  });

  it('omits keywords from the query when the flag is not given', async () => {
    const run = await runCli(['settings', 'users', '--json'], [() => usersPage([userFull])]);
    const url = new URL(run.calls[0]?.url ?? '');
    expect(url.searchParams.has('keywords')).toBe(false);
  });

  it('passes --page and --page-size through to the request', async () => {
    const run = await runCli(
      ['settings', 'users', '--page', '2', '--page-size', '5', '--json'],
      [() => usersPage([userFull], { page_index: 2, page_size: 5, total: 6 })],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? '');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
    // Only one request: this is the single-page path, not an --all walk.
    expect(run.calls).toHaveLength(1);
  });

  it('refuses a page-size above the API cap before any request goes out', async () => {
    const run = await runCli(['settings', 'users', '--page-size', '101', '--json']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--page-size');
  });

  it('refuses a negative --page before any request goes out', async () => {
    const run = await runCli(['settings', 'users', '--page', '-1', '--json']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--page');
  });
});

describe('settings users --all', () => {
  it('walks every page and reports the collected {count,all:true} shape', async () => {
    const run = await runCli(
      ['settings', 'users', '--all', '--page-size', '2', '--json'],
      [
        () => usersPage([userFull, userNameOnly], { page_index: 0, page_size: 2, total: 3 }),
        () => usersPage([userBare], { page_index: 1, page_size: 2, total: 3 }),
        // short page → the walk stops.
        () => usersPage([], { page_index: 2, page_size: 2, total: 3 }),
      ],
    );
    expect(run.exit).toBe(0);
    // Page 0 (2 rows, full) then page 1 (1 row, short) — the short page ends the walk.
    expect(run.calls).toHaveLength(2);
    const parsed = JSON.parse(run.stdout) as { count: number; all: boolean };
    expect(parsed).toMatchObject({ count: 3, all: true });
  });

  it('stops at --limit even when more pages remain', async () => {
    const run = await runCli(
      ['settings', 'users', '--all', '--page-size', '2', '--limit', '2', '--json'],
      [
        () => usersPage([userFull, userNameOnly], { page_index: 0, page_size: 2, total: 5 }),
        // Never requested: --limit of 2 is already satisfied by page 0.
        () => usersPage([userBare], { page_index: 1, page_size: 2, total: 5 }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    const parsed = JSON.parse(run.stdout) as { count: number; all: boolean };
    expect(parsed).toMatchObject({ count: 2, all: true });
  });

  it('dedupes rows that repeat across pages under --all', async () => {
    // Offset paging over unsorted, mutating data can repeat a row (research §6.20);
    // the walk dedupes on id, so the count stays honest.
    const run = await runCli(
      ['settings', 'users', '--all', '--page-size', '2', '--json'],
      [
        () => usersPage([userFull, userBare], { page_index: 0, page_size: 2, total: 3 }),
        // userFull repeats here; only userBare from page 0 plus userBare again are dupes.
        () => usersPage([userFull, userBare], { page_index: 1, page_size: 2, total: 3 }),
        () => usersPage([], { page_index: 2, page_size: 2, total: 3 }),
      ],
    );
    expect(run.exit).toBe(0);
    const parsed = JSON.parse(run.stdout) as { count: number; all: boolean };
    expect(parsed.count).toBe(2);
  });
});

describe('settings users — error mapping through the command layer', () => {
  it('maps an unmapped API error to exit 7 and keeps stdout empty', async () => {
    // No directory-users code is in ERROR_CODE_OVERRIDES, so an unknown code stays
    // a generic ApiError rather than being silently relabelled.
    const run = await runCli(
      ['settings', 'users', '--json'],
      [() => jsonResponse({ code: '999999', message: '未知错误' }, { status: 400 })],
    );
    expect(run.exit).toBe(7);
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.stderr)).toMatchObject({
      error: { kind: 'api', code: '999999', exit: 7 },
    });
  });
});
