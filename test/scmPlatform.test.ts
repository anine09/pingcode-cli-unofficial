import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `pingcode scm platform …` end to end, with `fetch` replaced at the global
 * boundary and the config directory redirected to a temp dir. No network, no real
 * credentials. Builds the real tree via `createCliHarness` (which calls
 * `buildProgram()`), so root-level commander settings are those the binary runs.
 *
 * Focus is function/branch coverage of `src/cli/commands/scm/platform.ts`:
 * `runList` (the `--all` collect branch, the single-page branch, the `--name`
 * query branch, paging), `runGet` (resolution by id and by name, the unknown-name
 * refusal, the server-side absence), `runCreate` (the optional-field subset, the
 * dry-run gate, the `created` verb), `runUpdate` (the empty-patch refusal, the
 * partial patch, the dry-run gate, the `updated` verb), and `printPlatform` (both
 * the `--json` and human paths, with and without a trailing verb, and the
 * empty-field drop).
 *
 * A 托管平台 is the bootstrap hop of the whole scm module, so every other scm
 * command starts by resolving `--platform` here — but the `platform` group itself
 * is the *only* scm group that needs no parent: `list`/`get`/`create`/`update`
 * address `/v1/scm/products` directly. `get`/`update` still resolve their
 * `<platform>` positional through the metadata engine, which loads the whole
 * platform list (page_size 100) and matches by id or by exact (case-insensitive)
 * name.
 */

const PLATFORM = '68393e8b47512a5d5d4e5b55';
const PLATFORM2 = '785d393c47512a5d5d52aa71';

/** A hosting-platform list — both the `list` result and the resolver's whole-list hop. */
const platformsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [
      {
        id: PLATFORM,
        name: 'Github',
        type: 'github',
        url: 'https://github.com',
        description: 'the hub',
      },
    ],
  });

/** A single hosting platform, as the detail / create / update endpoints return it. */
const platformOne = () =>
  jsonResponse({
    id: PLATFORM,
    name: 'Github',
    type: 'github',
    url: 'https://github.com',
    description: 'the hub',
  });

/** A first, full page for the `--all` walk (page_size 1). */
const onePlatformPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 1,
    total: 2,
    values: [{ id: PLATFORM, name: 'Github', type: 'github' }],
  });

/** A second, distinct page for the `--all` walk's second page. */
const secondPlatformPage = () =>
  jsonResponse({
    page_index: 1,
    page_size: 1,
    total: 2,
    values: [{ id: PLATFORM2, name: 'Gitlab', type: 'gitlab' }],
  });

/** A platform with only an id — every curated field is absent, to exercise the
 *  nullish-coalescing fallbacks and the empty-value drop in `printFields`. */
const sparsePlatform = () => jsonResponse({ id: PLATFORM });

const harness = createCliHarness({ beforeEach, afterEach });

// ---------------------------------------------------------------------------
// scm platform list
// ---------------------------------------------------------------------------

describe('scm platform list', () => {
  it('sends the list with default paging and no name filter when omitted', async () => {
    const run = await harness.run(['scm', 'platform', 'list', '--json'], [platformsPage]);
    expect(run.exit).toBe(0);
    // Exactly one request: the list, with no platform resolution (a platform has no parent).
    expect(run.calls).toHaveLength(1);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.pathname).toBe('/v1/scm/products');
    expect(url.searchParams.get('page_index')).toBe('0');
    expect(url.searchParams.get('page_size')).toBe('30');
    expect(url.searchParams.has('name')).toBe(false);
    const parsed = JSON.parse(run.stdout) as { total: number };
    expect(parsed.total).toBe(1);
  });

  it('attaches the exact --name filter to the list query', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'list', '--name', 'Github', '--json'],
      [platformsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain('name=Github');
  });

  it('forwards paging as page_index / page_size', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'list', '--page', '2', '--page-size', '5', '--json'],
      [platformsPage],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[0]?.url ?? 'https://x.invalid');
    expect(url.searchParams.get('page_index')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('5');
  });

  it('walks every platform under --all and renders a collected list', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform',
        'list',
        '--all',
        '--page-size',
        '1',
        '--limit',
        '2',
        '--json',
      ],
      [onePlatformPage, secondPlatformPage],
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
    const run = await harness.run(['scm', 'platform', 'list'], [platformsPage]);
    expect(run.exit).toBe(0);
    // Curated columns: id, name, type, description.
    expect(run.stdout).toContain(PLATFORM);
    expect(run.stdout).toContain('Github');
    expect(run.stdout).toContain('github');
    expect(run.stdout).toContain('the hub');
    expect(run.stderr).toContain('row(s)');
  });

  it('renders a platform row with absent name/type/description as empty cells', async () => {
    // Covers the `platform.name ?? ''` / `type ?? ''` / `description ?? ''` null
    // branches in the list columns: a row with only an id renders, empty cells
    // dropped from nothing to show.
    const run = await harness.run(
      ['scm', 'platform', 'list'],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [{ id: PLATFORM }] })],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(PLATFORM);
    expect(run.stderr).toContain('row(s)');
  });

  it('renders an empty list without a row-count notice', async () => {
    // Covers the `page.values.length > 0` guard in printPage: zero rows ⇒ no notice.
    const run = await harness.run(
      ['scm', 'platform', 'list', '--json'],
      [() => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
    );
    expect(run.exit).toBe(0);
    const parsed = JSON.parse(run.stdout) as { total: number; values: unknown[] };
    expect(parsed.total).toBe(0);
    expect(parsed.values).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scm platform get
// ---------------------------------------------------------------------------

describe('scm platform get', () => {
  it('gets one platform by id, resolving via the loaded list', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'get', PLATFORM, '--json'],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    // First call loads the platform candidates (the resolver's whole-list hop);
    // second is the detail GET under the resolved id.
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toBe(`https://open.pingcode.com/v1/scm/products/${PLATFORM}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: PLATFORM, name: 'Github' });
  });

  it('resolves by name (case-insensitive) before the GET', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'get', 'github', '--json'],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.calls[1]?.url).toContain(`/v1/scm/products/${PLATFORM}`);
  });

  it('refuses an unknown name with the candidate list, sending no detail GET', async () => {
    // Human mode so the hint (the visible candidate list) is rendered on stderr.
    const run = await harness.run(
      ['scm', 'platform', 'get', 'ghost'],
      [platformsPage],
    );
    expect(run.exit).toBe(2);
    // Only the platform list was loaded; the refusal is caught before the GET.
    expect(run.calls).toHaveLength(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no hosting platform matches');
    expect(run.stderr).toContain('ghost');
    // The hint lists the visible candidates, so the refusal is actionable.
    expect(run.stderr).toContain('available:');
    expect(run.stderr).toContain(PLATFORM);
  });

  it('surfaces a server-side absence as exit 5 once the id resolved', async () => {
    // The id is in the loaded list (so client-side resolution succeeds), but the
    // detail GET answers 400 100200 → mapped to not_found.
    const run = await harness.run(
      ['scm', 'platform', 'get', PLATFORM, '--json'],
      [platformsPage, () => jsonResponse({ code: '100200', message: '资源不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });

  it('renders the curated field block in human mode, with no trailing verb', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'get', PLATFORM],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('Github');
    expect(run.stdout).toContain(PLATFORM);
    expect(run.stdout).toContain('github');
    expect(run.stdout).toContain('https://github.com');
    expect(run.stdout).toContain('the hub');
    // A plain get prints no "created"/"got" notice.
    expect(run.stderr).not.toContain('created');
  });

  it('drops the absent curated fields instead of printing them blank', async () => {
    // Covers the `platform.name ?? ''` / `printFields` empty-value drop: name,
    // type, url and description are all absent, so only the id line is shown.
    const run = await harness.run(
      ['scm', 'platform', 'get', PLATFORM],
      [platformsPage, sparsePlatform],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(PLATFORM);
    expect(run.stdout).not.toContain('https://github.com');
    expect(run.stdout).not.toContain('the hub');
  });
});

// ---------------------------------------------------------------------------
// scm platform create
// ---------------------------------------------------------------------------

describe('scm platform create', () => {
  it('requires --name (a requiredOption)', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'create', '--type', 'github'],
      [platformOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('requires --type (a requiredOption)', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'create', '--name', 'Github'],
      [platformOne],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it('POSTs name + type only when no optional field was given', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'create', '--name', 'Github', '--type', 'github', '--json'],
      [() => jsonResponse({ id: PLATFORM, name: 'Github', type: 'github' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain('/v1/scm/products');
    expect(run.writes[0]?.body).toEqual({ name: 'Github', type: 'github' });
  });

  it('includes the optional --description when it is passed', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform',
        'create',
        '--name',
        'Github',
        '--type',
        'github',
        '--description',
        'the hub',
        '--json',
      ],
      [() => jsonResponse({ id: PLATFORM, name: 'Github', type: 'github', description: 'the hub' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      name: 'Github',
      type: 'github',
      description: 'the hub',
    });
  });

  it('prints the plan and sends nothing on a dry-run create', async () => {
    const run = await harness.run(
      [
        'scm',
        'platform',
        'create',
        '--name',
        'Github',
        '--type',
        'github',
        '--description',
        'the hub',
        '--dry-run',
        '--json',
      ],
      [() => jsonResponse({ id: PLATFORM })],
    );
    expect(run.exit).toBe(0);
    // A platform has no parent, so a dry-run create resolves nothing and sends
    // zero requests.
    expect(run.writes).toEqual([]);
    expect(run.calls).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/scm/products');
    expect(plan.request.body).toEqual({
      name: 'Github',
      type: 'github',
      description: 'the hub',
    });
  });

  it('announces the created platform by name on stderr in human mode', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'create', '--name', 'Github', '--type', 'github'],
      [platformOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created Github');
  });

  it('falls back to the id in the created notice when the name is absent', async () => {
    // Covers the `platform.name ?? platform.id` fallback in the verb notice.
    const run = await harness.run(
      ['scm', 'platform', 'create', '--name', 'Github', '--type', 'github'],
      [() => jsonResponse({ id: PLATFORM, type: 'github' })],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created ${PLATFORM}`);
  });
});

// ---------------------------------------------------------------------------
// scm platform update
// ---------------------------------------------------------------------------

describe('scm platform update', () => {
  const baseArgs = ['scm', 'platform', 'update', PLATFORM];

  it('refuses an empty patch before any request (exit 2)', async () => {
    const run = await harness.run([...baseArgs], [platformOne]);
    expect(run.exit).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain('nothing to update');
    expect(run.stderr).toContain('--name');
  });

  it('PATCHes only the patched fields, resolving the platform by id first', async () => {
    const run = await harness.run(
      [
        ...baseArgs,
        '--name',
        'renamed',
        '--description',
        'new desc',
        '--json',
      ],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    // First call loads the platform candidates; second is the PATCH under the id.
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/v1/scm/products/${PLATFORM}`);
    expect(run.writes[0]?.body).toEqual({ name: 'renamed', description: 'new desc' });
  });

  it('sends a single-field patch when only --type is given', async () => {
    const run = await harness.run(
      [...baseArgs, '--type', 'gitlab', '--json'],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ type: 'gitlab' });
  });

  it('resolves the <platform> positional by name before the PATCH', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'update', 'github', '--name', 'renamed', '--json'],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/scm/products?');
    expect(run.writes[0]?.url).toContain(`/v1/scm/products/${PLATFORM}`);
  });

  it('refuses an unknown platform name before the PATCH, sending nothing', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'update', 'ghost', '--name', 'renamed', '--json'],
      [platformsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toEqual([]);
    expect(run.stderr).toContain('no hosting platform matches');
  });

  it('still resolves the platform on a dry-run, so the read fires but no write is sent', async () => {
    const run = await harness.run(
      [...baseArgs, '--name', 'renamed', '--dry-run', '--json'],
      [platformsPage],
    );
    expect(run.exit).toBe(0);
    // The platform list is a read, so it is still sent under --dry-run; the PATCH is gated.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.writes).toEqual([]);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.body).toEqual({ name: 'renamed' });
  });

  it('surfaces a server-side absence on the PATCH as exit 5', async () => {
    // The platform resolved by id (not from cache), so a 400 100200 surfaces
    // directly with no cache-invalidation retry.
    const run = await harness.run(
      [...baseArgs, '--name', 'renamed', '--json'],
      [
        platformsPage,
        () => jsonResponse({ code: '100200', message: '资源不存在' }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(5);
    expect(run.writes).toHaveLength(1);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { error: { kind: string; exit: number } };
    expect(error.error).toMatchObject({ kind: 'not_found', exit: 5 });
  });

  it('announces the updated platform by name on stderr in human mode', async () => {
    const run = await harness.run(
      [...baseArgs, '--name', 'renamed'],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('updated Github');
  });
});

// ---------------------------------------------------------------------------
// stdout / stderr contract
// ---------------------------------------------------------------------------

describe('scm platform json stdout contract', () => {
  it('keeps stdout JSON-only on list, get and create, with notices on stderr', async () => {
    const list = await harness.run(
      ['scm', 'platform', 'list', '--json'],
      [platformsPage],
    );
    expect(list.exit).toBe(0);
    expect(list.stderr).toBe('');
    expect(() => JSON.parse(list.stdout)).not.toThrow();

    const got = await harness.run(
      ['scm', 'platform', 'get', PLATFORM, '--json'],
      [platformsPage, platformOne],
    );
    expect(got.exit).toBe(0);
    expect(got.stderr).toBe('');
    expect(() => JSON.parse(got.stdout)).not.toThrow();

    const created = await harness.run(
      ['scm', 'platform', 'create', '--name', 'Github', '--type', 'github', '--json'],
      [() => jsonResponse({ id: PLATFORM, name: 'Github', type: 'github' })],
    );
    expect(created.exit).toBe(0);
    expect(created.stderr).toBe('');
    expect(() => JSON.parse(created.stdout)).not.toThrow();
  });

  it('keeps stdout JSON-only on update, with the notice suppressed', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'update', PLATFORM, '--name', 'renamed', '--json'],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(() => JSON.parse(run.stdout)).not.toThrow();
  });

  it('puts the result block on stdout and the verb notice on stderr in human mode', async () => {
    const run = await harness.run(
      ['scm', 'platform', 'update', PLATFORM, '--name', 'renamed'],
      [platformsPage, platformOne],
    );
    expect(run.exit).toBe(0);
    // Human mode: the result block on stdout, the "updated" notice on stderr.
    expect(run.stdout).toContain('Github');
    expect(run.stderr).toContain('updated Github');
  });
});
