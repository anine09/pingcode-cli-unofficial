import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * S2b: the nineteen new `project …` leaves end to end, through the real
 * `buildProgram()` tree with `fetch` replaced at the global boundary and the config
 * directory redirected to a temp dir. No network, no real credentials.
 *
 * What is proven here and cannot be proven at the api layer:
 *  - the **transport switch** on `work-item list`: a search-only flag routes the read to
 *    `POST …/search`, and paging plus `--all` behave the same on both transports
 *    (design D16.1 retracts the "search ignores paging" finding this file first pinned);
 *  - `bulk-update` refuses zero and refuses two properties, before any request;
 *  - `bulk-update` **warns when `updates` falls short of the ids sent** — the only signal
 *    the endpoint gives, and the difference between "it worked" and "it silently did
 *    nothing" (`sprint_id`);
 *  - every `--yes` gate names the resource rather than an id, and sends no write without
 *    the flag;
 *  - `--json` keeps **stdout JSON-only**, warnings and tables on stderr;
 *  - `--dry-run` prints the plan and sends **zero** mutating requests while the name
 *    lookups it needs still run.
 *
 * The most valuable assertions are the ones about things the *server* would let through:
 * a bulk property it ignores, and a tag id that belongs to another project.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const PROJECT = '6a1c41781c7734aaad9ec23c';
const ITEM = '6a717840a2f1bc8bb00ec342';
const OTHER = '6a717841a2f1bc8bb00ec34a';
const LINK = '6a7178503e127a186f112409';
const TAG = '6a28fbdc8e6e0432aa7f7b79';
const FOREIGN_TAG = '69491e0d121bc7bcefff0b35';
const HISTORY = '6a717840a2f1bc8bb00ec348';
const USER = 'f5712155d0e54d0b94ffacb1384217f0';
const STATE = '68389e7f33ee52bc5c2584d0';
const RELATION_TYPE = '68389e7f33ee52bc5c258607';

const projectsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: PROJECT, name: 'Mobile App', identifier: 'MOB', type: 'scrum' }],
  });

const usersPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: USER, name: 'wangxiao', display_name: '王小', username: 'wangxiao' }],
  });

const itemBody = (overrides: Record<string, unknown> = {}) => ({
  id: ITEM,
  identifier: 'MOB-219',
  short_id: 'N0g4K1DA',
  title: 'login times out',
  // A slug string, exactly as the live API sends it.
  type: 'task',
  state: { id: STATE, name: '进行中' },
  project: { id: PROJECT, name: 'Mobile App' },
  tags: [],
  participants: [],
  versions: [],
  is_archived: 0,
  is_deleted: 0,
  ...overrides,
});

const itemResponse = () => jsonResponse(itemBody());

const relationTypesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: RELATION_TYPE, name: '关联', category: 'relate', is_system: 1 },
      { id: '68389e7f33ee52bc5c258603', name: '阻塞', category: 'block', is_system: 1 },
    ],
  });

const linkBody = (overrides: Record<string, unknown> = {}) => ({
  id: LINK,
  relation_type: 'relate',
  origin_work_item: { id: ITEM, identifier: 'MOB-219', title: 'login times out' },
  target_work_item: { id: OTHER, identifier: 'MOB-220', title: 'other thing' },
  ...overrides,
});

const tagAttachment = () =>
  jsonResponse({ id: TAG, tag: { id: TAG, name: '前端' }, work_item: { id: ITEM, identifier: 'MOB-219' } });

const tagVocabulary = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 3,
    values: [
      { id: TAG, name: '前端' },
      { id: FOREIGN_TAG, name: '后端' },
      { id: '6a28fbe209dbd0bc097457ee', name: '后端' },
    ],
  });

// ---------------------------------------------------------------------------
// list: the two transports
// ---------------------------------------------------------------------------

describe('project work-item list — transport switch', () => {
  it('stays on the simple GET list when only its own filters are used', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--keywords', 'login'],
      [projectsPage, () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [itemBody()] })],
    );

    expect(run.exit).toBe(0);
    const read = run.calls[1];
    expect(read?.method).toBe('GET');
    expect(read?.url).toContain('/v1/pjm/work_items?');
    expect(read?.url).not.toContain('/search');
  });

  it('switches to POST …/search when a search-only filter appears', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        'Mobile App',
        '--title-contains',
        'login',
        '--unassigned',
      ],
      [projectsPage, () => jsonResponse({ page_index: 0, page_size: 30, total: 6, values: [itemBody()] })],
    );

    expect(run.exit).toBe(0);
    const search = run.calls[1];
    expect(search?.method).toBe('POST');
    expect(search?.url).toContain('/v1/pjm/work_items/search');
    expect(search?.body).toMatchObject({
      mode: 'query',
      payload: {
        filter: {
          'project.id': { in: [PROJECT] },
          title: { contains: 'login' },
          'assignee.id': { exists: false },
        },
      },
    });
  });

  it('uses `type`, not `type.id`, when a type filter travels through search', async () => {
    // `type.id` / `type_id` are both refused with 400 `100043` — the search vocabulary
    // genuinely differs from the query string's.
    const typesPage = () =>
      jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'task', name: '任务' }] });
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        'Mobile App',
        '--type',
        'task',
        '--created-after',
        '2026-08-01',
      ],
      [projectsPage, typesPage, () => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
    );

    expect(run.exit).toBe(0);
    const body = run.calls[2]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter.type).toEqual({ in: ['task'] });
    expect(body.payload.filter['type.id']).toBeUndefined();
  });

  it('collapses a two-sided date window into one `between`, because one operator per field', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        'Mobile App',
        '--created-after',
        '2026-08-01',
        '--created-before',
        '2026-08-31',
      ],
      [projectsPage, () => jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] })],
    );

    const filter = (run.calls[1]?.body as { payload: { filter: Record<string, unknown> } }).payload
      .filter;
    const created = filter.created_at as { between: [number, number] };
    expect(Object.keys(created)).toEqual(['between']);
    // The asymmetric boundary rule: start of the first day, end of the last.
    expect(new Date(created.between[0] * 1000).getHours()).toBe(0);
    expect(new Date(created.between[1] * 1000).getHours()).toBe(23);
  });

  it('walks every page in search mode under --all, and labels the result complete', async () => {
    // The regression test for design D16.1. `POST …/search` pages exactly like the simple
    // list, so `--all` must walk it. An earlier revision refused `--all` here and warned
    // "there is no way to ask for the rest" on every call — both from a probe artifact,
    // not from the API. A refusal of a legal operation is the expensive kind of wrong:
    // nothing could override it.
    const page = (index: number, values: unknown[]) => () =>
      jsonResponse({ page_index: index, page_size: 2, total: 5, values });
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        'Mobile App',
        '--unassigned',
        '--all',
        '--page-size',
        '2',
      ],
      [
        projectsPage,
        page(0, [itemBody({ id: 'a' }), itemBody({ id: 'b' })]),
        page(1, [itemBody({ id: 'c' }), itemBody({ id: 'd' })]),
        page(2, [itemBody({ id: 'e' })]),
      ],
    );

    expect(run.exit).toBe(0);
    const searches = run.calls.filter((call) => call.url.includes('/search'));
    expect(searches).toHaveLength(3);
    // The cursor advances, and it travels inside `payload` — which is exactly where the
    // generic `api` command's own cursor overwrite hid the truth from the original probe.
    expect(searches.map((call) => (call.body as { payload: { page_index: number } }).payload.page_index)).toEqual([0, 1, 2]);
    expect(run.stderr).not.toContain('ignores paging');
  });

  it('still allows --all on the simple list', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--all'],
      [projectsPage, () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [itemBody()] })],
    );
    expect(run.exit).toBe(0);
  });

  it('refuses --unassigned together with --assignee', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        'Mobile App',
        '--unassigned',
        '--assignee',
        'wangxiao',
      ],
      [projectsPage, usersPage],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('keeps stdout JSON-only on the search transport, with a silent stderr', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', PROJECT, '--unassigned', '--json'],
      [projectsPage, () => jsonResponse({ page_index: 0, page_size: 30, total: 2, values: [itemBody()] })],
    );
    const parsed = JSON.parse(run.stdout) as { total: number; values: { type: string }[] };
    expect(parsed.total).toBe(2);
    // The parser correction: `type` survives as the slug it is on the wire.
    expect(parsed.values[0]?.type).toBe('task');
    // Nothing to warn about any more (design D16.1): a successful `--json` read leaves
    // stderr empty, which is the contract every other list already honours.
    expect(run.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// bulk-update
// ---------------------------------------------------------------------------

describe('project work-item bulk-update', () => {
  const IDS = ['--id', ITEM, '--id', OTHER];

  it('sends ids, one property name and one value', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', ...IDS, '--assignee', 'wangxiao'],
      [
        itemResponse,
        () => jsonResponse(itemBody({ id: OTHER, identifier: 'MOB-220' })),
        usersPage,
        () => jsonResponse({ inserts: 0, updates: 2, deletes: 0 }),
      ],
    );

    expect(run.exit).toBe(0);
    const write = run.writes[0];
    expect(write?.method).toBe('PATCH');
    expect(write?.url).toContain('/v1/pjm/work_items');
    expect(write?.body).toEqual({
      ids: [ITEM, OTHER],
      property_name: 'assignee_id',
      property_value: USER,
    });
  });

  it('refuses a call with no property, before any request', async () => {
    const run = await runCli(['project', 'work-item', 'bulk-update', ...IDS], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('no property was given');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses two properties, because the endpoint carries one', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', ...IDS, '--title', 'x', '--description', 'y'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('only one property can be set per call');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses --state <name> without --project, because a batch may span projects', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', ITEM, '--state', '进行中'],
      [itemResponse],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('--state <name> requires --project');
    expect(run.writes).toHaveLength(0);
  });

  it('refuses --property without --value, because a missing value CLEARS the field', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', ITEM, '--property', 'assignee_id'],
      [itemResponse],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('requires --value');
    expect(run.writes).toHaveLength(0);
  });

  it('parses --value as JSON when it is JSON, and as a string when it is not', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'bulk-update',
        '--id',
        ITEM,
        '--property',
        'version_ids',
        '--value',
        '["a","b"]',
      ],
      [itemResponse, () => jsonResponse({ updates: 1 })],
    );
    expect((run.writes[0]?.body as { property_value: unknown }).property_value).toEqual(['a', 'b']);

    const raw = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', ITEM, '--property', 'title', '--value', 'hello'],
      [itemResponse, () => jsonResponse({ updates: 1 })],
    );
    expect((raw.writes[0]?.body as { property_value: unknown }).property_value).toBe('hello');
  });

  it('warns when fewer items were updated than were named — the only signal there is', async () => {
    // Live: `property_name: sprint_id` with a perfectly valid sprint answers 200 with
    // `updates: 0` and changes nothing. Without this warning the CLI would report a
    // silent no-op as a success.
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', ...IDS, '--property', 'sprint_id', '--value', 'sp1'],
      [
        itemResponse,
        () => jsonResponse(itemBody({ id: OTHER })),
        () => jsonResponse({ inserts: 0, updates: 0, deletes: 0 }),
      ],
    );

    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('0 of 2 work item(s) were updated');
    expect(run.stderr).toContain('sprint_id');
  });

  it('says nothing alarming when every item was updated', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', ...IDS, '--title', 'x'],
      [itemResponse, () => jsonResponse(itemBody({ id: OTHER })), () => jsonResponse({ updates: 2 })],
    );
    expect(run.stderr).toContain('updated 2 work item(s)');
    expect(run.stderr).not.toContain('were updated. The API');
  });

  it('sends nothing under --dry-run, but still resolves the ids', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', 'MOB-219', '--title', 'x', '--dry-run', '--json'],
      [
        () => jsonResponse({ page_index: 0, page_size: 10, total: 1, values: [itemBody()] }),
        () => jsonResponse({}),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
    // The identifier really was looked up: a dry run resolves for real.
    expect(run.calls[0]?.url).toContain('identifier=MOB-219');
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('project work-item delete', () => {
  it('refuses without --yes, naming the identifier and the title', async () => {
    const run = await runCli(['project', 'work-item', 'delete', ITEM], [itemResponse]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('MOB-219');
    expect(run.stderr).toContain('login times out');
    expect(run.writes).toHaveLength(0);
  });

  it('deletes with --yes and echoes the deleted item', async () => {
    const run = await runCli(
      ['project', 'work-item', 'delete', ITEM, '--yes'],
      [itemResponse, itemResponse],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.writes[0]?.url).toContain(`/v1/pjm/work_items/${ITEM}`);
    expect(run.stderr).toContain('deleted MOB-219');
  });

  it('cannot be talked out of the gate with a positional `false`', async () => {
    // D12.9: commander used to swallow an excess argument, so `--yes false` deleted.
    // `allowExcessArguments(false)` on the root program is what stops it — asserted here
    // because this is the first pjm delete to inherit that protection.
    const run = await runCli(['project', 'work-item', 'delete', ITEM, '--yes', 'false'], [itemResponse]);
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });

  it('has no --all, so it can never become a bulk delete', async () => {
    const run = await runCli(['project', 'work-item', 'delete', ITEM, '--yes', '--all'], [itemResponse]);
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });

  it('accepts an identifier and a pasted URL, not just an id', async () => {
    const byIdentifier = await runCli(
      ['project', 'work-item', 'delete', 'MOB-219', '--yes'],
      [
        () => jsonResponse({ page_index: 0, page_size: 10, total: 1, values: [itemBody()] }),
        itemResponse,
      ],
    );
    expect(byIdentifier.exit).toBe(0);
    expect(byIdentifier.writes[0]?.url).toContain(`/v1/pjm/work_items/${ITEM}`);
  });
});

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

describe('project work-item link', () => {
  it('resolves the relation type by its category slug and sends the id', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'add', ITEM, '--target', OTHER, '--relation', 'relate'],
      [itemResponse, () => jsonResponse(itemBody({ id: OTHER })), relationTypesPage, () => jsonResponse(linkBody())],
    );

    expect(run.exit).toBe(0);
    const write = run.writes[0];
    expect(write?.url).toContain(`/v1/pjm/work_items/${ITEM}/relations`);
    expect(write?.body).toEqual({ target_work_item_id: OTHER, relation_type: RELATION_TYPE });
  });

  it('resolves it by the localized name too', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'add', ITEM, '--target', OTHER, '--relation', '关联'],
      [itemResponse, () => jsonResponse(itemBody({ id: OTHER })), relationTypesPage, () => jsonResponse(linkBody())],
    );
    expect((run.writes[0]?.body as { relation_type: string }).relation_type).toBe(RELATION_TYPE);
  });

  it('passes --relation-id through without a lookup', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'add', ITEM, '--target', OTHER, '--relation-id', 'raw-id'],
      [itemResponse, () => jsonResponse(itemBody({ id: OTHER })), () => jsonResponse(linkBody())],
    );
    expect((run.writes[0]?.body as { relation_type: string }).relation_type).toBe('raw-id');
    expect(run.calls.every((call) => !call.url.includes('relation_types'))).toBe(true);
  });

  it('refuses an add with no relation type, because the API requires one', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'add', ITEM, '--target', OTHER],
      [itemResponse, () => jsonResponse(itemBody({ id: OTHER }))],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('requires --relation');
    expect(run.writes).toHaveLength(0);
  });

  it('filters the list by relation type', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'list', ITEM, '--relation-id', 'relate'],
      [itemResponse, () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [linkBody()] })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain('relation_type=relate');
    expect(run.stdout).toContain('MOB-220');
  });

  it('refuses a delete without --yes, naming both ends and the inverse edge', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'delete', ITEM, LINK],
      [itemResponse, () => jsonResponse(linkBody())],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('MOB-220');
    expect(run.stderr).toContain('inverse');
    expect(run.writes).toHaveLength(0);
  });

  it('deletes with --yes', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'delete', ITEM, LINK, '--yes'],
      [itemResponse, () => jsonResponse(linkBody()), () => jsonResponse(linkBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.writes[0]?.url).toContain(`/relations/${LINK}`);
  });
});

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

describe('project work-item tag', () => {
  it('resolves an unambiguous tag name against the vocabulary', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', ITEM, '--tag', '前端'],
      [itemResponse, tagVocabulary, tagAttachment],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ tag_id: TAG });
    // The lookup is a live read, not a cached resolver hop.
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_item/tags');
    expect(run.calls[1]?.url).toContain(`project_id=${PROJECT}`);
  });

  it('reports an ambiguous tag name with the candidate ids, because names repeat', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', ITEM, '--tag', '后端'],
      [itemResponse, tagVocabulary],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('matches 2 tags');
    expect(run.stderr).toContain(FOREIGN_TAG);
    expect(run.writes).toHaveLength(0);
  });

  it('lists the known names when the tag is not there at all', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', ITEM, '--tag', 'nope'],
      [itemResponse, tagVocabulary],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('前端');
    expect(run.stderr).toContain('organisation-wide');
  });

  it('passes --tag-id through with no lookup', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', ITEM, '--tag-id', TAG],
      [itemResponse, tagAttachment],
    );
    expect(run.exit).toBe(0);
    expect(run.calls.every((call) => !call.url.includes('/work_item/tags'))).toBe(true);
  });

  it('explains a tag rejected for belonging to another project', async () => {
    // 100354 says `'tag'资源不存在` about a tag the user can see, which is why it is not
    // in ERROR_CODE_OVERRIDES — the explanation has to come from here.
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', ITEM, '--tag-id', FOREIGN_TAG],
      [
        itemResponse,
        () =>
          new Response(JSON.stringify({ code: '100354', message: "'tag'资源不存在" }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ],
    );
    // Exit 7, deliberately: an absence code that is not an absence stays an api error.
    expect(run.exit).toBe(7);
    expect(run.stderr).toContain('belongs to a different project');
  });

  it('refuses a tag removal without --yes and names the tag', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'delete', ITEM, TAG],
      [itemResponse, tagAttachment],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('前端');
    expect(run.writes).toHaveLength(0);
  });

  it('warns in the refusal that a repeated removal is a 500, not a clean error', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'delete', ITEM, TAG],
      [itemResponse, tagAttachment],
    );
    expect(run.stderr).toContain('500');
  });
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

describe('project work-item history', () => {
  it('lists state changes and shows the creation row as (new)', async () => {
    const run = await runCli(
      ['project', 'work-item', 'history', 'list', ITEM],
      [
        itemResponse,
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 30,
            total: 1,
            values: [
              {
                id: HISTORY,
                from_state: null,
                to_state: { id: 's1', name: '打开' },
                created_by: { id: USER, name: 'Ping' },
                created_at: 1785821248,
              },
            ],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain('/transition_histories');
    expect(run.stdout).toContain('(new)');
    expect(run.stdout).toContain('打开');
  });

  it('gets one row', async () => {
    const run = await runCli(
      ['project', 'work-item', 'history', 'get', ITEM, HISTORY],
      [
        itemResponse,
        () =>
          jsonResponse({
            id: HISTORY,
            from_state: { id: 's1', name: '打开' },
            to_state: { id: 's2', name: '进行中' },
            created_at: 1785821248,
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/transition_histories/${HISTORY}`);
    expect(run.stdout).toContain('进行中');
  });
});

// ---------------------------------------------------------------------------
// project create / update / progress
// ---------------------------------------------------------------------------

describe('project create', () => {
  const CREATE = [
    'project',
    'create',
    '--name',
    '[CLI] New',
    '--identifier',
    'NEW',
    '--type',
    'scrum',
  ];

  it('sends the three required fields', async () => {
    const run = await runCli(CREATE, [
      () => jsonResponse({ id: PROJECT, name: '[CLI] New', identifier: 'NEW', type: 'scrum' }),
    ]);
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toEqual({ type: 'scrum', name: '[CLI] New', identifier: 'NEW' });
  });

  it('refuses an unknown --type locally, because the server names no alternatives', async () => {
    const run = await runCli(
      ['project', 'create', '--name', 'x', '--identifier', 'X', '--type', 'agile'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('scrum');
    expect(run.calls).toHaveLength(0);
  });

  it('resolves --assignee and --member to user ids', async () => {
    const run = await runCli(
      [...CREATE, '--assignee', 'wangxiao', '--member', 'wangxiao'],
      [usersPage, usersPage, () => jsonResponse({ id: PROJECT })],
    );
    expect(run.writes[0]?.body).toMatchObject({
      assignee_id: USER,
      members: [{ id: USER, type: 'user' }],
    });
  });

  it('sends nothing under --dry-run — this create cannot be undone', async () => {
    const run = await runCli([...CREATE, '--dry-run', '--json'], []);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect((JSON.parse(run.stdout) as { dry_run: boolean }).dry_run).toBe(true);
  });
});

describe('project update', () => {
  it('refuses an empty patch before any request', async () => {
    const run = await runCli(['project', 'update', PROJECT], []);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('nothing to update');
    expect(run.calls).toHaveLength(0);
  });

  it('patches only what it was given, after resolving the project name', async () => {
    const run = await runCli(
      ['project', 'update', 'Mobile App', '--name', 'Renamed'],
      [projectsPage, () => jsonResponse({ id: PROJECT, name: 'Renamed', identifier: 'MOB' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/v1/pjm/projects/${PROJECT}`);
    expect(run.writes[0]?.body).toEqual({ name: 'Renamed' });
  });

  it('offers no --visibility or --archive, because both are silently dropped upstream', async () => {
    const rejected = await runCli(['project', 'update', PROJECT, '--visibility', 'public'], []);
    expect(rejected.exit).toBe(2);
    const archived = await runCli(['project', 'update', PROJECT, '--archive'], []);
    expect(archived.exit).toBe(2);
  });
});

describe('project progress', () => {
  it('prints the four counts from the bare object', async () => {
    const run = await runCli(
      ['project', 'progress', 'Mobile App'],
      [
        projectsPage,
        () =>
          jsonResponse({
            work_item: { total: 183, pending_count: 52, in_progress_count: 12, completed_count: 119 },
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/progress`);
    expect(run.calls[1]?.url).not.toContain('page_index');
    expect(run.stdout).toContain('183');
    expect(run.stdout).toContain('119');
  });

  it('keeps stdout to the raw object under --json', async () => {
    const run = await runCli(
      ['project', 'progress', PROJECT, '--json'],
      [projectsPage, () => jsonResponse({ work_item: { total: 2 } })],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { work_item: { total: number } }).work_item.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

describe('project member', () => {
  const memberRow = {
    id: USER,
    type: 'user',
    user: { id: USER, name: 'wangxiao', display_name: '王小' },
    role: { id: '100000000000000000000003', name: '只读成员' },
    project: { id: PROJECT, name: 'Mobile App' },
  };

  it('lists members, showing the display name and the role', async () => {
    const run = await runCli(
      ['project', 'member', 'list', '--project', 'Mobile App'],
      [projectsPage, () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [memberRow] })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/members`);
    expect(run.stdout).toContain('王小');
    expect(run.stdout).toContain('只读成员');
  });

  it('gets one membership by the user reference, not a membership id', async () => {
    const run = await runCli(
      ['project', 'member', 'get', 'wangxiao', '--project', PROJECT],
      [projectsPage, usersPage, () => jsonResponse(memberRow)],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[2]?.url).toContain(`/members/${USER}`);
  });

  it('adds a user with the {member, role_id} body', async () => {
    const run = await runCli(
      [
        'project',
        'member',
        'add',
        '--project',
        PROJECT,
        '--user',
        'wangxiao',
        '--role-id',
        '100000000000000000000003',
      ],
      [projectsPage, usersPage, () => jsonResponse(memberRow)],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      member: { id: USER, type: 'user' },
      role_id: '100000000000000000000003',
    });
  });

  it('omits role_id so the API can default it', async () => {
    const run = await runCli(
      ['project', 'member', 'add', '--project', PROJECT, '--user', 'wangxiao'],
      [projectsPage, usersPage, () => jsonResponse(memberRow)],
    );
    expect(run.writes[0]?.body).toEqual({ member: { id: USER, type: 'user' } });
  });

  it('adds a team with --group-id, and refuses both principals at once', async () => {
    const run = await runCli(
      ['project', 'member', 'add', '--project', PROJECT, '--group-id', 'g1'],
      [projectsPage, () => jsonResponse({ id: 'g1', type: 'user_group' })],
    );
    expect(run.writes[0]?.body).toEqual({ member: { id: 'g1', type: 'user_group' } });

    const both = await runCli(
      ['project', 'member', 'add', '--project', PROJECT, '--user', 'x', '--group-id', 'g1'],
      [],
    );
    expect(both.exit).toBe(2);
    expect(both.stderr).toContain('mutually exclusive');
    expect(both.calls).toHaveLength(0);
  });

  it('requires one of --user / --group-id', async () => {
    const run = await runCli(['project', 'member', 'add', '--project', PROJECT], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('has no remove leaf — the generic layer owns that endpoint', async () => {
    const run = await runCli(['project', 'member', 'remove', '--project', PROJECT, '--user', 'x'], []);
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the two meta leaves
// ---------------------------------------------------------------------------

describe('project meta relation-types', () => {
  it('reads the org-level vocabulary with no project parameter', async () => {
    const run = await runCli(['project', 'meta', 'relation-types'], [relationTypesPage]);
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/pjm/work_item/relation_types');
    expect(run.calls[0]?.url).not.toContain('project_id');
    // CATEGORY is the column that matters, because the ids are per-tenant.
    expect(run.stdout).toContain('relate');
    expect(run.stdout).toContain('关联');
  });
});

describe('project meta tags', () => {
  it('sends the required project_id and the substring filter', async () => {
    const run = await runCli(
      ['project', 'meta', 'tags', '--project', 'Mobile App', '--name', '前'],
      [projectsPage, tagVocabulary],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`project_id=${PROJECT}`);
    expect(run.calls[1]?.url).toContain('name=');
    expect(run.stdout).toContain('前端');
  });
});
