import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode scm platform-user …` end to end, with `fetch` replaced at the global
 * boundary and the config directory redirected to a temp dir. No network, no real
 * credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/scm/platformUser.ts`:
 * `runList` (the `--all` collect branch, the `--name` query branch, paging),
 * `runGet`, `runCreate` (the optional-field subset, the dry-run gate, the
 * `created` verb), `runUpdate` (the empty-patch refusal, the partial patch, the
 * `updated` verb), and `printPlatformUser` (both the `--json` and human paths,
 * with and without a trailing verb).
 */

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const USER = '6a706a6d39cbed1cf7126c22';

/** A hosting platform list — the bootstrap hop every platform-user command resolves. */
const platformsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: PLATFORM, name: 'Github', type: 'github' }],
  });

/** One page of git identities (platform users). Zero-arg: the fake fetch calls
 *  handlers as `handler(call, index)`, so a default param would be overridden by
 *  the `FakeCall` and silently yield `total: 0`. */
const usersPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 1,
    values: [{ id: USER, name: 'bot', display_name: 'Bot' }],
  });

/** A single git identity, as the detail/list endpoints return it. */
const user = () =>
  jsonResponse({
    id: USER,
    name: 'bot',
    display_name: 'Bot',
    product: { id: PLATFORM, name: 'Github' },
    html_url: 'https://github.com/bot',
    avatar_url: 'https://github.com/bot.png',
  });

/** A one-row page, for the `--all` multi-page walk (each page is full). */
const oneUserPage = () =>
  jsonResponse({ page_index: 0, page_size: 1, total: 1, values: [{ id: USER, name: 'bot' }] });

/** A second, distinct identity, for the `--all` walk's second page. */
const secondUserPage = () =>
  jsonResponse({ page_index: 1, page_size: 1, total: 2, values: [{ id: 'u2', name: 'ci' }] });

const harness = createCliHarness({ beforeEach, afterEach });

describe('scm platform-user list', () => {
  it('requires --platform, and says why, before any request', async () => {
    const run = await harness.run(['scm', 'platform-user', 'list']);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('--platform <name|id> is required');
  });

  it('rejects --platform together with --platform-id', async () => {
    const run = await harness.run([
      'scm',
      'platform-user',
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

  it('sends --platform-id verbatim with no lookup, and no name filter when omitted', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'list', '--platform-id', PLATFORM, '--json'],
      [usersPage],
    );
    expect(run.exit).toBe(0);
    // Exactly one request: the list, with no preceding platform resolution.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/users?`);
    expect(run.calls[0]?.url).not.toContain('name=');
    const parsed = JSON.parse(run.stdout) as { total: number };
    expect(parsed.total).toBe(1);
  });

  it('attaches the exact --name filter to the list query', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'list', '--platform-id', PLATFORM, '--name', 'bot', '--json'],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain('name=bot');
  });

  it('resolves --platform by name before listing, loading the platform list once', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'list', '--platform', 'Github', '--json'],
      [
        platformsPage,
        () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [{ id: USER }] }),
      ],
    );
    expect(run.exit).toBe(0);
    // First call loads the platform candidates (the resolver's whole-list hop);
    // second is the actual user list under the resolved id.
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(`/v1/scm/products/${PLATFORM}/users?`);
  });

  it('prints a human-mode table with the row count on stderr', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'list', '--platform-id', PLATFORM],
      [usersPage],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('bot');
    expect(run.stderr).toContain('row(s)');
  });

  it('walks every page under --all and renders a collected list', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'list', '--platform-id', PLATFORM, '--all', '--page-size', '1', '--limit', '2', '--json'],
      [oneUserPage, secondUserPage],
    );
    expect(run.exit).toBe(0);
    const parsed = JSON.parse(run.stdout) as { all: boolean; count: number; values: unknown[] };
    expect(parsed.all).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.values).toHaveLength(2);
  });

  it('forwards the paging flags as page_index / page_size', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform-user',
        'list',
        '--platform-id',
        PLATFORM,
        '--page',
        '2',
        '--page-size',
        '5',
        '--json',
      ],
      [usersPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });
});

describe('scm platform-user get', () => {
  it('resolves --platform by name, then GETs the identity verbatim', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'get', USER, '--platform', 'Github', '--json'],
      [platformsPage, user],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`/v1/scm/products/${PLATFORM}/users/${USER}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: USER, name: 'bot' });
  });

  it('passes the <user> positional through untouched with --platform-id (no lookup)', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'get', 'steins-tech', '--platform-id', PLATFORM, '--json'],
      [() => jsonResponse({ id: 'steins-tech', name: 'steins-tech' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain(`/users/steins-tech`);
  });

  it('renders the curated field block in human mode, including the platform ref', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'get', USER, '--platform-id', PLATFORM],
      [user],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('bot');
    expect(run.stdout).toContain('Github');
    // The avatar is a documented field and is shown when present.
    expect(run.stdout).toContain('https://github.com/bot.png');
    // No trailing verb for a plain get.
    expect(run.stderr).not.toContain('created');
  });

  it('surfaces an unknown identity as exit 5 under --json', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'get', 'ghost', '--platform-id', PLATFORM, '--json'],
      [() => jsonResponse({ code: '100317', message: '资源不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });
});

describe('scm platform-user create', () => {
  it('requires --name (a requiredOption)', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'create', '--platform-id', PLATFORM],
      [user],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('sends only name when no optional field was given', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'create', '--platform-id', PLATFORM, '--name', 'bot', '--json'],
      [() => jsonResponse({ id: USER, name: 'bot' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toEqual({ name: 'bot' });
  });

  it('includes only the optional fields that were passed', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform-user',
        'create',
        '--platform-id',
        PLATFORM,
        '--name',
        'bot',
        '--display-name',
        'Bot',
        '--avatar-url',
        'https://github.com/bot.png',
        '--json',
      ],
      [() => jsonResponse({ id: USER, name: 'bot' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      name: 'bot',
      display_name: 'Bot',
      avatar_url: 'https://github.com/bot.png',
    });
  });

  it('resolves --platform by name before the POST', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'create', '--platform', 'Github', '--name', 'bot', '--json'],
      [platformsPage, () => jsonResponse({ id: USER, name: 'bot' })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.writes[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/users`);
  });

  it('prints the plan and sends nothing on a dry-run create', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform-user',
        'create',
        '--platform-id',
        PLATFORM,
        '--name',
        'bot',
        '--display-name',
        'Bot',
        '--dry-run',
        '--json',
      ],
      [() => jsonResponse({ id: USER })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain(`/v1/scm/products/${PLATFORM}/users`);
    expect(plan.request.body).toEqual({ name: 'bot', display_name: 'Bot' });
  });

  it('announces the created identity by name on stderr in human mode', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'create', '--platform-id', PLATFORM, '--name', 'bot'],
      [() => jsonResponse({ id: USER, name: 'bot', display_name: 'Bot' })],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created bot');
  });
});

describe('scm platform-user update', () => {
  it('refuses an empty patch before any request (exit 2)', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'update', USER, '--platform-id', PLATFORM],
      [platformsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('nothing to update');
    expect(run.stderr).toContain('--display-name');
  });

  it('sends only the patched fields', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform-user',
        'update',
        USER,
        '--platform-id',
        PLATFORM,
        '--name',
        'renamed',
        '--html-url',
        'https://github.com/renamed',
        '--json',
      ],
      [() => jsonResponse({ id: USER, name: 'renamed' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/users/${USER}`);
    expect(run.writes[0]?.body).toEqual({
      name: 'renamed',
      html_url: 'https://github.com/renamed',
    });
  });

  it('resolves --platform by name before the PATCH', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform-user',
        'update',
        USER,
        '--platform',
        'Github',
        '--display-name',
        'Bot',
        '--json',
      ],
      [platformsPage, () => jsonResponse({ id: USER, name: 'bot' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.url).toContain(`/v1/scm/products/${PLATFORM}/users/${USER}`);
  });

  it('prints the plan and sends nothing on a dry-run update', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform-user',
        'update',
        USER,
        '--platform-id',
        PLATFORM,
        '--name',
        'renamed',
        '--dry-run',
        '--json',
      ],
      [() => jsonResponse({ id: USER })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.body).toEqual({ name: 'renamed' });
  });

  it('announces the updated identity by name on stderr in human mode', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'update', USER, '--platform-id', PLATFORM, '--name', 'renamed'],
      [() => jsonResponse({ id: USER, name: 'renamed' })],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('updated renamed');
  });
});

describe('scm platform-user json stdout contract', () => {
  it('keeps stdout JSON-only on list, create and get, with notices on stderr', async () => {
    const list = await harness.run(
      ['scm', 'platform-user', 'list', '--platform-id', PLATFORM, '--json'],
      [usersPage],
    );
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const created = await harness.run(
      ['scm', 'platform-user', 'create', '--platform-id', PLATFORM, '--name', 'bot', '--json'],
      [() => jsonResponse({ id: USER, name: 'bot' })],
    );
    expect(created.exit).toBe(0);
    expect(created.stderr).toBe('');
    expect(() => JSON.parse(created.stdout)).not.toThrow();

    const got = await harness.run(
      ['scm', 'platform-user', 'get', USER, '--platform-id', PLATFORM, '--json'],
      [user],
    );
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();
  });

  it('keeps stdout JSON-only on update, the human-mode verb going to stderr', async () => {
    const run = await harness.run(
      ['scm', 'platform-user', 'update', USER, '--platform-id', PLATFORM, '--name', 'renamed'],
      [() => jsonResponse({ id: USER, name: 'renamed' })],
    );
    expect(run.exit).toBe(0);
    // human mode: the result block on stdout, the "updated" notice on stderr.
    expect(run.stdout).toContain('renamed');
    expect(run.stderr).toContain('updated renamed');
  });
});
