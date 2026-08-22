import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness, type CliRun } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * Coverage for `src/cli/commands/testhub/cases.ts` — `testhub cases …`, the
 * module's centre of gravity (list/get/create/update/delete/history/bulk-*).
 *
 * This suite drives the **real** tree through `createCliHarness` (`buildProgram()`),
 * so every assertion is against the root the binary actually runs. No network: the
 * harness swaps in a fake `fetch`, and each test runs in its own temp config dir, so
 * the metadata cache is empty per test and never contaminates a sibling.
 *
 * What is exercised here beyond the shared `testhubCommands` suite:
 *  - every `--x` / `--x-id` pair on `list`/`update` (the `passThrough` half that
 *    skips every lookup, and the name half that resolves against the library);
 *  - the `--include-*` and `--include-image-token` list filters the server performs;
 *  - `get` by id and by short_id, and the human-mode field block;
 *  - `create`'s `--set` → `properties`, its suite/type/level resolution and human notice;
 *  - `update`'s empty-patch refusal, the own-library resolution and `--library` override;
 *  - `delete`'s no-`--yes` refusal (naming the run count), the cascade delete and `--dry-run`;
 *  - `cases history list` (id-only resolution, paging and `--all`);
 *  - bulk-create/update entry resolution: `maintenance` by name (`resolveEntryUser`),
 *    `participant_ids` (valid and the array-shape refusal), shared vs per-entry
 *    `type`/`important_level`, and every `--file`/`--case` exclusivity refusal.
 */

// The harness owns a temp config dir per test via these hooks.
const h = createCliHarness({ beforeEach, afterEach });

// The bulk-* leaves read their entries from JSON files, which live in their own dir.
let fileDir: string;
beforeEach(() => {
  fileDir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-cases-'));
});
afterEach(() => {
  rmSync(fileDir, { recursive: true, force: true });
});

function pathOf(call: { url: string } | undefined): string {
  return new URL(call?.url ?? 'https://x.invalid/').pathname;
}

/** Only the writes that change server state — `run.writes` also counts the read `POST …/search`. */
function mutations(run: CliRun): typeof run.writes {
  return run.writes.filter((call) => !call.url.includes('/search'));
}

function parseStdout(run: CliRun): unknown {
  expect(run.stdout.trim(), `stdout was not pure JSON:\n${run.stdout}`).not.toBe('');
  return JSON.parse(run.stdout) as unknown;
}

function writeEntries(content: string): string {
  const file = path.join(fileDir, `entries-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, content, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// fixtures — zero-arg factories, so a handler passed to the fake fetch is never
// called with the FakeCall as a defaulted first argument.
// ---------------------------------------------------------------------------

const librariesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [
      {
        id: 'lib-1',
        identifier: 'LIB',
        name: '核心测试库',
        visibility: 'private',
        members: [],
        is_archived: 0,
      },
    ],
  });

const suitesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'su-login', name: '登录', paths: '', parent: null },
      { id: 'su-sms', name: '短信验证码', parent: { id: 'su-login', name: '登录' }, paths: '登录' },
    ],
  });

const caseStatesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'cs-draft', name: '草稿', type: 'pending' },
      { id: 'cs-ready', name: '已评审', type: 'completed' },
    ],
  });

const caseTypesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'ct-func', name: '功能测试' }],
  });

const importantLevelsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'il-high', name: '高', color: '#f00' },
      { id: 'il-low', name: '低', color: '#0f0' },
    ],
  });

const usersPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'user-7', display_name: '张三', username: 'zhangsan' }],
  });

const casesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 1,
    values: [
      {
        id: 'case-1',
        identifier: 'LIB-10',
        short_id: 'c9y3',
        title: '短信验证码登录',
        state: { id: 'cs-draft', name: '草稿' },
        type: { id: 'ct-func', name: '功能测试' },
        important_level: { id: 'il-high', name: '高' },
        maintenance: { id: 'user-7', name: '张三' },
        steps: [],
        created_at: 1730000000,
        is_archived: 0,
      },
    ],
  });

/** The full case resource `get`/`update`/`delete` resolve and return. */
const caseDetail = () =>
  jsonResponse({
    id: 'case-1',
    identifier: 'LIB-10',
    short_id: 'c9y3',
    title: '短信验证码登录',
    library: { id: 'lib-1', name: '核心测试库' },
    suite: { id: 'su-sms', name: '短信验证码' },
    state: { id: 'cs-draft', name: '草稿' },
    type: { id: 'ct-func', name: '功能测试' },
    important_level: { id: 'il-high', name: '高' },
    maintenance: { id: 'user-7', name: '张三' },
    test_type: 'manual',
    precondition: '已注册手机号',
    description: '输入正确验证码后登录',
    steps: [],
    participants: [],
    created_at: 1730000000,
    updated_at: 1730000000,
    html_url: 'https://example.com/case-1',
    is_archived: 0,
    is_deleted: 0,
  });

const caseCreated = () =>
  jsonResponse({ id: 'case-new', identifier: 'LIB-11', title: 'hello', is_archived: 0 });

const caseUpdated = () =>
  jsonResponse({ id: 'case-1', identifier: 'LIB-10', title: 'new', is_archived: 0 });

const caseDeleted = () =>
  jsonResponse({
    id: 'case-1',
    identifier: 'LIB-10',
    title: '短信验证码登录',
    is_deleted: 1,
    is_archived: 0,
  });

/** The bare array both `cases/bulk` halves answer with. */
const caseBulkOk = () =>
  jsonResponse([
    { state: 'success', case: { id: 'case-9', identifier: 'LIB-9', title: 'imported', is_archived: 0 } },
  ]);

/** A bulk response with one failed row, so the warning branch fires. */
const caseBulkPartial = () =>
  jsonResponse([
    {
      state: 'failure',
      case: undefined,
      message: 'title 不能为空',
    },
  ]);

/** The delete command counts runs first — `searchRuns` answers this. */
const runsPage = (total: number) =>
  () =>
    jsonResponse({
      page_index: 0,
      page_size: 1,
      total,
      values: Array.from({ length: Math.min(total, 1) }, () => ({ id: 'run-1' })),
    });

const historyPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 1,
    values: [
      {
        id: 'hist-1',
        executed_at: 1730000000,
        status: 'pass',
        plan: { id: 'plan-1', name: '2026 S1 回归' },
        run: { id: 'run-1', short_id: 'r4m2' },
        executed_by: { id: 'user-7', name: '张三' },
        remark: 'ok',
      },
    ],
  });

// ---------------------------------------------------------------------------
// cases list
// ---------------------------------------------------------------------------

describe('testhub cases list', () => {
  it('reads through POST …/search and never touches GET /v1/testhub/cases', async () => {
    const run = await h.run(['testhub', 'cases', 'list', '--library', 'LIB', '--json'], [
      librariesPage,
      casesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/cases/search');
    expect(run.calls.some((call) => pathOf(call) === '/v1/testhub/cases')).toBe(false);
    expect(parseStdout(run)).toMatchObject({ total: 1 });
  });

  it('requires a library — nothing in testhub is reachable without one', async () => {
    const run = await h.run(['testhub', 'cases', 'list', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });

  it('builds the filter with the documented reference operator for every pair', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'list',
        '--library',
        'LIB',
        '--suite',
        '登录 / 短信验证码',
        '--state',
        '草稿',
        '--type',
        '功能测试',
        '--important-level',
        '高',
        '--keywords',
        '登录',
        '--json',
      ],
      [librariesPage, suitesPage, caseStatesPage, caseTypesPage, importantLevelsPage, casesPage],
    );
    expect(run.exit).toBe(0);
    // the computed `Parent / Child` path resolved the nested module
    expect(run.calls[run.calls.length - 1]?.body).toMatchObject({
      mode: 'query',
      payload: {
        filter: {
          'library.id': { in: ['lib-1'] },
          'suite.id': { in: ['su-sms'] },
          'state.id': { in: ['cs-draft'] },
          'type.id': { in: ['ct-func'] },
          'important_level.id': { in: ['il-high'] },
        },
        keywords: '登录',
      },
    });
  });

  it('passes every --x-id through with no lookup at all', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'list',
        '--library-id',
        'lib-1',
        '--suite-id',
        'su-sms',
        '--state-id',
        'cs-draft',
        '--type-id',
        'ct-func',
        '--important-level-id',
        'il-high',
        '--json',
      ],
      [casesPage],
    );
    expect(run.exit).toBe(0);
    // only the single search POST — every id is sent verbatim
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.body).toMatchObject({
      mode: 'query',
      payload: {
        filter: {
          'library.id': { in: ['lib-1'] },
          'suite.id': { in: ['su-sms'] },
          'state.id': { in: ['cs-draft'] },
          'type.id': { in: ['ct-func'] },
          'important_level.id': { in: ['il-high'] },
        },
      },
    });
  });

  it('refuses --suite together with --suite-id before any request', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--suite', 'a', '--suite-id', 'b', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--suite and --suite-id are mutually exclusive');
  });

  it('resolves importance levels org-wide, with no library_id on the request', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--important-level', '高', '--json'],
      [librariesPage, importantLevelsPage, casesPage],
    );
    const levels = new URL(run.calls[1]?.url ?? '');
    expect(levels.pathname).toBe('/v1/testhub/case_important_levels');
    expect(levels.searchParams.get('library_id')).toBeNull();
  });

  it('forwards the include filters and the rich-text image token the server performs', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'list',
        '--library',
        'LIB',
        '--include-archived',
        '--include-deleted',
        '--include-image-token',
        'description,steps',
        '--keywords',
        '登录',
        '--json',
      ],
      [librariesPage, casesPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.body).toMatchObject({
      mode: 'query',
      payload: {
        include_archived: true,
        include_deleted: true,
        include_public_image_token: 'description,steps',
        keywords: '登录',
      },
    });
  });

  it('omits the include filters and image token when their flags are absent', async () => {
    const run = await h.run(['testhub', 'cases', 'list', '--library', 'LIB', '--json'], [
      librariesPage,
      casesPage,
    ]);
    const payload = (run.calls[1]?.body as { payload: Record<string, unknown> }).payload;
    expect('include_archived' in payload).toBe(false);
    expect('include_deleted' in payload).toBe(false);
    expect('include_public_image_token' in payload).toBe(false);
    expect('keywords' in payload).toBe(false);
  });

  it('--all walks every page and emits {values,count,all}', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--all', '--json'],
      [librariesPage, casesPage],
    );
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toMatchObject({
      count: 1,
      all: true,
      values: [
        expect.objectContaining({
          id: 'case-1',
          identifier: 'LIB-10',
          short_id: 'c9y3',
          title: '短信验证码登录',
          is_archived: false,
        }),
      ],
    });
  });

  it('passes a custom --page-size through to the single-page search body', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--page-size', '5', '--json'],
      [librariesPage, casesPage],
    );
    expect(run.exit).toBe(0);
    // search paging rides in the POST body, not the query string
    expect((run.calls[1]?.body as { payload: { page_size: number } }).payload.page_size).toBe(5);
  });

  it('rejects a page size above the API cap before any request', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'list', '--library', 'LIB', '--page-size', '101', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('renders a table on stdout in human mode, with the page note on stderr', async () => {
    const run = await h.run(['testhub', 'cases', 'list', '--library', 'LIB'], [
      librariesPage,
      casesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('IDENTIFIER');
    expect(run.stdout).toContain('短信验证码登录');
    expect(run.stderr).toContain('page 0');
  });
});

// ---------------------------------------------------------------------------
// cases get
// ---------------------------------------------------------------------------

describe('testhub cases get', () => {
  it('accepts an id and sends it to the id-or-short_id path', async () => {
    const run = await h.run(['testhub', 'cases', 'get', 'case-1', '--json'], [caseDetail]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/case-1');
    expect(parseStdout(run)).toMatchObject({ id: 'case-1', identifier: 'LIB-10' });
  });

  it('accepts a short_id and sends it unchanged (GET is documented for both)', async () => {
    const run = await h.run(['testhub', 'cases', 'get', 'c9y3', '--json'], [caseDetail]);
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/c9y3');
  });

  it('renders the curated field block on stdout in human mode', async () => {
    const run = await h.run(['testhub', 'cases', 'get', 'case-1'], [caseDetail]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('短信验证码登录');
    expect(run.stdout).toContain('identifier');
    expect(run.stdout).toContain('LIB-10');
    expect(run.stdout).toContain('已注册手机号');
  });

  it('requires the <case> argument', async () => {
    const run = await h.run(['testhub', 'cases', 'get', '--json'], []);
    expect(run.exit).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// cases create
// ---------------------------------------------------------------------------

describe('testhub cases create', () => {
  it('sends test_library_id and title only, when nothing else was given', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'create', '--library', 'LIB', '--title', 'hello', '--json'],
      [librariesPage, caseCreated],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.writes).toHaveLength(1);
    // the body field is `test_library_id`, not `library_id`
    expect(run.writes[0]?.body).toEqual({ test_library_id: 'lib-1', title: 'hello' });
    expect(parseStdout(run)).toMatchObject({ id: 'case-new', identifier: 'LIB-11' });
  });

  it('resolves suite, type and importance level and sends their ids', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'create',
        '--library',
        'LIB',
        '--title',
        'hello',
        '--suite',
        '短信验证码',
        '--type',
        '功能测试',
        '--important-level',
        '高',
        '--description',
        'd',
        '--precondition',
        'p',
        '--json',
      ],
      [librariesPage, suitesPage, caseTypesPage, importantLevelsPage, caseCreated],
    );
    expect(run.exit).toBe(0);
    // library (call 0), then suite/type/level resolved against it, then the POST
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/libraries/lib-1/suites');
    expect(pathOf(run.calls[2])).toBe('/v1/testhub/case/types');
    expect(pathOf(run.calls[3])).toBe('/v1/testhub/case_important_levels');
    expect(run.writes).toHaveLength(1);
    expect(pathOf(run.writes[0])).toBe('/v1/testhub/cases');
    expect(run.writes[0]?.body).toEqual({
      test_library_id: 'lib-1',
      title: 'hello',
      suite_id: 'su-sms',
      type_id: 'ct-func',
      important_level_id: 'il-high',
      description: 'd',
      precondition: 'p',
    });
  });

  it('passes --type-id / --suite-id / --important-level-id through with no lookups', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'create',
        '--library',
        'LIB',
        '--title',
        'hello',
        '--suite-id',
        'su-sms',
        '--type-id',
        'ct-func',
        '--important-level-id',
        'il-high',
        '--json',
      ],
      [librariesPage, caseCreated],
    );
    expect(run.exit).toBe(0);
    // only the library was resolved; the three ids are verbatim (the POST is the 2nd call)
    expect(run.calls).toHaveLength(2);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.body).toMatchObject({
      test_library_id: 'lib-1',
      title: 'hello',
      suite_id: 'su-sms',
      type_id: 'ct-func',
      important_level_id: 'il-high',
    });
  });

  it('turns --set key=value into a verbatim properties map', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'create',
        '--library',
        'LIB',
        '--title',
        'hello',
        '--set',
        'risk=opt-1',
        '--set',
        'component=web',
        '--dry-run',
        '--json',
      ],
      [librariesPage],
    );
    const plan = parseStdout(run) as { request: { body: { properties: Record<string, unknown> } } };
    expect(plan.request.body.properties).toEqual({ risk: 'opt-1', component: 'web' });
  });

  it('rejects a malformed --set before any request', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'create', '--library', 'LIB', '--title', 'hello', '--set', 'noequals'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--set');
  });

  it('--dry-run resolves the library but writes nothing', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'create',
        '--library',
        'LIB',
        '--title',
        'hello',
        '--dry-run',
        '--json',
      ],
      [librariesPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(run.writes).toHaveLength(0);
    expect(run.calls).toHaveLength(1);
  });

  it('requires --title', async () => {
    const run = await h.run(['testhub', 'cases', 'create', '--library', 'LIB', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--title');
  });

  it('keeps stdout JSON-only, with the created notice on stderr', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'create', '--library', 'LIB', '--title', 'hello'],
      [librariesPage, caseCreated],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('created LIB-11');
    expect(run.stdout).not.toContain('created LIB-11');
  });
});

// ---------------------------------------------------------------------------
// cases update
// ---------------------------------------------------------------------------

describe('testhub cases update', () => {
  it('is exit 2 with no request when no field was given', async () => {
    const run = await h.run(['testhub', 'cases', 'update', 'case-1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('reads the case first, so a short_id never reaches the PATCH path', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'update', 'c9y3', '--title', 'new', '--json'],
      [caseDetail, caseUpdated],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.method).toBe('GET');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/c9y3');
    expect(run.writes).toHaveLength(1);
    expect(pathOf(run.writes[0])).toBe('/v1/testhub/cases/case-1');
    expect(run.writes[0]?.body).toEqual({ title: 'new' });
  });

  it('resolves --state against the library the case itself reports', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'update', 'case-1', '--state', '已评审', '--json'],
      [caseDetail, caseStatesPage, caseUpdated],
    );
    expect(run.exit).toBe(0);
    const states = new URL(run.calls[1]?.url ?? '');
    expect(states.pathname).toBe('/v1/testhub/case/states');
    expect(states.searchParams.get('library_id')).toBe('lib-1');
    expect(run.writes[0]?.body).toEqual({ state_id: 'cs-ready' });
  });

  it('resolves suite, type and level together against the own library', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'update',
        'case-1',
        '--suite',
        '短信验证码',
        '--type',
        '功能测试',
        '--important-level',
        '高',
        '--json',
      ],
      [caseDetail, suitesPage, caseTypesPage, importantLevelsPage, caseUpdated],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      suite_id: 'su-sms',
      type_id: 'ct-func',
      important_level_id: 'il-high',
    });
  });

  it('passes the four -id flags through with no lookups', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'update',
        'case-1',
        '--suite-id',
        'su-sms',
        '--state-id',
        'cs-ready',
        '--type-id',
        'ct-func',
        '--important-level-id',
        'il-high',
        '--json',
      ],
      [caseDetail, caseUpdated],
    );
    expect(run.exit).toBe(0);
    // the case read plus the PATCH — no reference lookups
    expect(run.calls).toHaveLength(2);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.body).toEqual({
      suite_id: 'su-sms',
      state_id: 'cs-ready',
      type_id: 'ct-func',
      important_level_id: 'il-high',
    });
  });

  it('overrides the resolved library with --library', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'update',
        'case-1',
        '--library',
        'LIB',
        '--state',
        '已评审',
        '--json',
      ],
      [caseDetail, librariesPage, caseStatesPage, caseUpdated],
    );
    expect(run.exit).toBe(0);
    // the case read came first, then the flagged library, then the library-scoped state
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/case-1');
    expect(new URL(run.calls[2]?.url ?? '').searchParams.get('library_id')).toBe('lib-1');
    expect(run.writes[0]?.body).toEqual({ state_id: 'cs-ready' });
  });

  it('refuses to resolve a name against a case that reports no library', async () => {
    const noLibrary = () =>
      jsonResponse({
        id: 'case-1',
        identifier: 'LIB-10',
        steps: [],
        participants: [],
        is_archived: 0,
        is_deleted: 0,
      });
    const run = await h.run(
      ['testhub', 'cases', 'update', 'case-1', '--state', '已评审', '--json'],
      [noLibrary, caseStatesPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('did not report a library');
  });

  it('turns --set into a verbatim properties patch', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'update',
        'case-1',
        '--set',
        'risk=opt-1',
        '--description',
        'nd',
        '--json',
      ],
      [caseDetail, caseUpdated],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ description: 'nd', properties: { risk: 'opt-1' } });
  });

  it('--dry-run reads the case, prints the patch and writes nothing', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'update',
        'case-1',
        '--state-id',
        'cs-ready',
        '--title',
        'new',
        '--dry-run',
        '--json',
      ],
      [caseDetail],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ title: 'new', state_id: 'cs-ready' });
    // the case lookup (a read) still ran; the PATCH did not
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toHaveLength(0);
  });

  it('prints the updated notice on stderr and keeps stdout the resource in human mode', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'update', 'case-1', '--title', 'new'],
      [caseDetail, caseUpdated],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('updated LIB-10');
    expect(run.stdout).toContain('new');
  });
});

// ---------------------------------------------------------------------------
// cases delete
// ---------------------------------------------------------------------------

describe('testhub cases delete', () => {
  it('refuses to delete without --yes, naming the run count', async () => {
    const run = await h.run(['testhub', 'cases', 'delete', 'case-1'], [caseDetail, runsPage(2)]);
    expect(run.exit).toBe(2);
    // the case read plus the runs search (a POST, so it is a write) — but no DELETE
    expect(run.calls).toHaveLength(2);
    expect(mutations(run)).toHaveLength(0);
    // human mode prints the message then the hint, which names the run count
    expect(run.stderr).toContain('refusing to delete case LIB-10');
    expect(run.stderr).toContain('2 execution record(s)');
  });

  it('deletes with --yes and echoes the deleted case', async () => {
    const run = await h.run(['testhub', 'cases', 'delete', 'case-1', '--yes', '--json'], [
      caseDetail,
      runsPage(0),
      caseDeleted,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.calls).toHaveLength(3);
    // only the DELETE is a real mutation; the runs search is a read POST
    expect(mutations(run)).toHaveLength(1);
    expect(pathOf(mutations(run)[0])).toBe('/v1/testhub/cases/case-1');
    expect(mutations(run)[0]?.method).toBe('DELETE');
    expect(parseStdout(run)).toMatchObject({ id: 'case-1', is_deleted: true });
  });

  it('--yes --dry-run counts the runs but sends the delete to nothing', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'delete', 'case-1', '--yes', '--dry-run', '--json'],
      [caseDetail, runsPage(3)],
    );
    expect(run.exit).toBe(0);
    // both reads ran; the DELETE was gated by dry-run
    expect(run.calls).toHaveLength(2);
    expect(mutations(run)).toHaveLength(0);
  });

  it('prints the cascade note on stderr when the case had runs', async () => {
    const run = await h.run(['testhub', 'cases', 'delete', 'case-1', '--yes'], [
      caseDetail,
      runsPage(3),
      caseDeleted,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('deleted LIB-10');
    expect(run.stderr).toContain('3 execution record(s) went with it');
  });

  it('resolves a short_id to a real id before the delete path', async () => {
    const run = await h.run(['testhub', 'cases', 'delete', 'c9y3', '--yes', '--json'], [
      caseDetail,
      runsPage(0),
      caseDeleted,
    ]);
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/c9y3');
    expect(pathOf(mutations(run)[0])).toBe('/v1/testhub/cases/case-1');
  });
});

// ---------------------------------------------------------------------------
// cases history list
// ---------------------------------------------------------------------------

describe('testhub cases history list', () => {
  it('resolves the case to a real id, then reads its id-only histories path', async () => {
    const run = await h.run(['testhub', 'cases', 'history', 'list', 'case-1', '--json'], [
      caseDetail,
      historyPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/case-1');
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/cases/case-1/histories');
    expect(parseStdout(run)).toMatchObject({ total: 1 });
  });

  it('--all walks every history page and emits {values,count,all}', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'history', 'list', 'case-1', '--all', '--json'],
      [caseDetail, historyPage],
    );
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toMatchObject({
      count: 1,
      all: true,
      values: [
        expect.objectContaining({
          id: 'hist-1',
          executed_at: 1730000000,
          status: 'pass',
          run: expect.objectContaining({ id: 'run-1', short_id: 'r4m2' }),
        }),
      ],
    });
  });

  it('renders the history table on stdout in human mode', async () => {
    const run = await h.run(['testhub', 'cases', 'history', 'list', 'case-1'], [
      caseDetail,
      historyPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('RESULT');
    expect(run.stderr).toContain('page 0');
  });

  it('requires the <case> argument', async () => {
    const run = await h.run(['testhub', 'cases', 'history', 'list', '--json'], []);
    expect(run.exit).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// cases bulk-create
// ---------------------------------------------------------------------------

describe('testhub cases bulk-create', () => {
  it('posts one cases array and renders the per-entry state on stdout', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.writes).toHaveLength(1);
    expect(pathOf(run.writes[0])).toBe('/v1/testhub/cases/bulk');
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toEqual({ cases: [{ test_library_id: 'lib-1', title: 'hello' }] });
    const out = parseStdout(run) as { count: number; values: Array<{ state: string }> };
    expect(out.count).toBe(1);
    expect(out.values[0]?.state).toBe('success');
  });

  it('resolves a per-entry maintainer by name (resolveEntryUser byName)', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello', maintenance: 'zhangsan' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [usersPage, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/directory/users');
    expect(new URL(run.calls[0]?.url ?? '').searchParams.get('keywords')).toBe('zhangsan');
    expect(run.writes[0]?.body).toEqual({
      cases: [{ test_library_id: 'lib-1', title: 'hello', maintenance_id: 'user-7' }],
    });
  });

  it('passes maintenance_id through with no user lookup', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello', maintenance_id: 'user-7' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    // only the POST — no library lookup (library-id) and no user lookup (maintenance_id)
    expect(run.calls).toHaveLength(1);
    expect(run.writes[0]?.body).toEqual({
      cases: [{ test_library_id: 'lib-1', title: 'hello', maintenance_id: 'user-7' }],
    });
  });

  it('forwards a valid participant_ids array verbatim', async () => {
    const file = writeEntries(
      JSON.stringify([{ title: 'hello', participant_ids: ['user-7', 'user-8'] }]),
    );
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      cases: [
        {
          test_library_id: 'lib-1',
          title: 'hello',
          participant_ids: ['user-7', 'user-8'],
        },
      ],
    });
  });

  it('refuses a participant_ids that is not an array of strings, before any request', async () => {
    for (const value of ['x', 42, [1, 2], [true]]) {
      const file = writeEntries(JSON.stringify([{ title: 'hello', participant_ids: value }]));
      const run = await h.run(
        ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
        [],
      );
      expect(run.exit, `for ${JSON.stringify(value)}`).toBe(2);
      expect(run.calls, `for ${JSON.stringify(value)}`).toHaveLength(0);
      expect(run.stderr, `for ${JSON.stringify(value)}`).toContain('participant_ids');
    }
  });

  it('applies a shared --type to entries that name none', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--type',
        '功能测试',
        '--file',
        file,
        '--json',
      ],
      [caseTypesPage, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/case/types');
    expect(new URL(run.calls[0]?.url ?? '').searchParams.get('library_id')).toBe('lib-1');
    expect(run.writes[0]?.body).toEqual({
      cases: [{ test_library_id: 'lib-1', title: 'hello', type_id: 'ct-func' }],
    });
  });

  it('prefers a per-entry type_id over the shared --type', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello', type_id: 'ct-other' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--type',
        '功能测试',
        '--file',
        file,
        '--json',
      ],
      [caseTypesPage, caseBulkOk],
    );
    expect(run.writes[0]?.body).toEqual({
      cases: [{ test_library_id: 'lib-1', title: 'hello', type_id: 'ct-other' }],
    });
  });

  it('applies a shared --important-level to entries that name none', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--important-level',
        '高',
        '--file',
        file,
        '--json',
      ],
      [importantLevelsPage, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/case_important_levels');
    expect(run.writes[0]?.body).toEqual({
      cases: [{ test_library_id: 'lib-1', title: 'hello', important_level_id: 'il-high' }],
    });
  });

  it('resolves a per-entry important_level by name (resolveEntryLevel byName)', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello', important_level: '高' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--file',
        file,
        '--json',
      ],
      [importantLevelsPage, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/case_important_levels');
    expect(run.writes[0]?.body).toEqual({
      cases: [{ test_library_id: 'lib-1', title: 'hello', important_level_id: 'il-high' }],
    });
  });

  it('forwards description, precondition, properties and steps per entry', async () => {
    const file = writeEntries(
      JSON.stringify([
        {
          title: 'hello',
          description: 'd',
          precondition: 'p',
          properties: { risk: 'high' },
          steps: [{ description: 'click', expected_value: 'ok' }],
        },
      ]),
    );
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      cases: [
        {
          test_library_id: 'lib-1',
          title: 'hello',
          description: 'd',
          precondition: 'p',
          properties: { risk: 'high' },
          steps: [{ description: 'click', expected_value: 'ok' }],
        },
      ],
    });
  });

  it('--dry-run reads nothing and writes nothing for an id-only library', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--file',
        file,
        '--dry-run',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ cases: [{ test_library_id: 'lib-1', title: 'hello' }] });
  });

  it('resolves the library by name before a dry-run', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-create',
        '--library',
        'LIB',
        '--file',
        file,
        '--dry-run',
        '--json',
      ],
      [librariesPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toHaveLength(0);
  });

  it('is exit 2 with no request when --file is missing', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--file');
  });

  it('is exit 2 with no request when no --library was given', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(['testhub', 'cases', 'bulk-create', '--file', file, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });

  it('refuses suite_id at the entry layer, before any request', async () => {
    const file = writeEntries(JSON.stringify([{ title: 't', suite_id: 'su-1' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('suite_id');
  });

  it('refuses state at the entry layer, before any request', async () => {
    const file = writeEntries(JSON.stringify([{ title: 't', state: '草稿' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('state');
  });

  it('caps the batch at 100 before any request', async () => {
    const file = writeEntries(
      JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ title: `t${index}` }))),
    );
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('101');
    expect(payload.error.message).toContain('100');
  });

  it('prints the result table on stdout and the count on stderr in human mode', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('STATE');
    expect(run.stderr).toContain('created 1 case(s)');
  });

  it('warns on stderr when some entries failed, without changing the exit code', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file],
      [caseBulkPartial],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('1 of 1 entries failed');
  });
});

// ---------------------------------------------------------------------------
// cases bulk-update
// ---------------------------------------------------------------------------

describe('testhub cases bulk-update', () => {
  it('patches each --case with the shared fields and keeps stdout JSON-only', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case',
        'case-1',
        '--case',
        'case-2',
        '--title',
        'new',
        '--json',
      ],
      // two case reads (one per --case) then the PATCH response
      [caseDetail, caseDetail, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.calls).toHaveLength(3);
    expect(mutations(run)).toHaveLength(1);
    expect(pathOf(mutations(run)[0])).toBe('/v1/testhub/cases/bulk');
    expect(mutations(run)[0]?.method).toBe('PATCH');
    // the shared fixture resolves every ref to case-1, proving the loop ran per --case
    expect(mutations(run)[0]?.body).toEqual({
      cases: [
        { case_id: 'case-1', title: 'new' },
        { case_id: 'case-1', title: 'new' },
      ],
    });
  });

  it('resolves a --case given as a short_id to a real id before the PATCH', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case',
        'c9y3',
        '--title',
        'new',
        '--json',
      ],
      [caseDetail, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/cases/c9y3');
    expect(run.writes[0]?.body).toEqual({ cases: [{ case_id: 'case-1', title: 'new' }] });
  });

  it('sends --case-id untouched, with no case read', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case-id',
        'case-1',
        '--title',
        'new',
        '--json',
      ],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    // only the PATCH — no case read (case-id) and no library/state lookup
    expect(run.calls).toHaveLength(1);
    expect(run.writes[0]?.body).toEqual({ cases: [{ case_id: 'case-1', title: 'new' }] });
  });

  it('resolves a shared --state by name against the library', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case',
        'case-1',
        '--state',
        '已评审',
        '--json',
      ],
      [caseDetail, caseStatesPage, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/case/states');
    expect(run.writes[0]?.body).toEqual({ cases: [{ case_id: 'case-1', state_id: 'cs-ready' }] });
  });

  it('resolves a shared --type by name against the library (non-file mode)', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case',
        'case-1',
        '--type',
        '功能测试',
        '--json',
      ],
      [caseDetail, caseTypesPage, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[1])).toBe('/v1/testhub/case/types');
    expect(run.writes[0]?.body).toEqual({ cases: [{ case_id: 'case-1', type_id: 'ct-func' }] });
  });

  it('passes --state-id through with no state lookup', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case',
        'case-1',
        '--state-id',
        'cs-ready',
        '--json',
      ],
      [caseDetail, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    // the case read (a ref) plus the PATCH — no state lookup (state-id)
    expect(run.calls).toHaveLength(2);
    expect(run.writes[0]?.body).toEqual({ cases: [{ case_id: 'case-1', state_id: 'cs-ready' }] });
  });

  it('patches each --file entry with its own fields', async () => {
    const file = writeEntries(
      JSON.stringify([
        { case_id: 'case-1', title: 'a' },
        { case_id: 'case-2', state_id: 'cs-draft' },
      ]),
    );
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      cases: [
        { case_id: 'case-1', title: 'a' },
        { case_id: 'case-2', state_id: 'cs-draft' },
      ],
    });
  });

  it('resolves a per-entry state by name against the library', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', state: '已评审' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [caseStatesPage, caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(pathOf(run.calls[0])).toBe('/v1/testhub/case/states');
    expect(run.writes[0]?.body).toEqual({ cases: [{ case_id: 'case-1', state_id: 'cs-ready' }] });
  });

  it('requires --library when a --file entry resolves a state by name', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', state: '已评审' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });

  it('sends a per-entry type_id with no library lookup (the id-only no-library branch)', async () => {
    // No --library, and the entry names a type_id (not a type name), so the
    // id-only `idOfEntryPair` branch is taken instead of a name resolution.
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', type_id: 'ct-func' }]));
    const run = await h.run(['testhub', 'cases', 'bulk-update', '--file', file, '--json'], [caseBulkOk]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.writes[0]?.body).toEqual({ cases: [{ case_id: 'case-1', type_id: 'ct-func' }] });
  });

  it('refuses --file combined with --case / --case-id', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', title: 'a' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--file',
        file,
        '--case',
        'case-1',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--file cannot be combined');
  });

  it('refuses --file combined with a shared field flag', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', title: 'a' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--file',
        file,
        '--title',
        'shared',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--file carries its own fields');
  });

  it('is exit 2 with no request when neither --case nor --file is given', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('is exit 2 when --case is given with no field flag', async () => {
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--case', 'case-1', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('no field flag');
  });

  it('refuses a --file entry that names a case but no field to change', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('no field to change');
  });

  it('refuses a --file entry that sets both case and case_id', async () => {
    const file = writeEntries(JSON.stringify([{ case: 'c9y3', case_id: 'case-1', title: 't' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('both case and case_id');
  });

  it('refuses a --file entry that names no case', async () => {
    const file = writeEntries(JSON.stringify([{ title: 't' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('names no case');
  });

  it('refuses suite at the entry layer — the API accepts it and lands nothing', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', suite: '登录' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('suite');
  });

  it('--dry-run resolves the case reads but writes nothing for --case', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case',
        'case-1',
        '--title',
        'new',
        '--dry-run',
        '--json',
      ],
      [caseDetail],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ cases: [{ case_id: 'case-1', title: 'new' }] });
  });

  it('prints the updated count on stderr and the table on stdout in human mode', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case-id',
        'case-1',
        '--title',
        'new',
      ],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('STATE');
    expect(run.stderr).toContain('updated 1 case(s)');
  });

  it('warns on stderr when some entries failed', async () => {
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--case-id',
        'case-1',
        '--title',
        'new',
      ],
      [caseBulkPartial],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('1 of 1 entries failed');
  });
});
