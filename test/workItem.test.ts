import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { typeIdOf, typeLabelOf } from '../src/cli/commands/workItem';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `project work-item …` end to end, through the real `buildProgram()` tree with
 * `fetch` replaced at the global boundary and the config directory redirected to a
 * temp dir. No network, no real credentials (design D3).
 *
 * These tests prove things the `api` layer alone cannot:
 *  - `--json` keeps **stdout JSON-only**, with tables and notices on stderr;
 *  - `--dry-run` on a write prints `{"dry_run":true,"request":{…}}` on stdout and sends
 *    **zero** mutating requests, while the name lookups it needs still run;
 *  - every flag refusal — an empty patch, `--type` alone, `--sprint`+`--clear-sprint`,
 *    a missing `--relation`, two bulk properties, `--unassigned`+`--assignee`, a bad
 *    date, an unknown type/state — happens **before** (or without) a mutating request;
 *  - the `delete` / `link delete` / `tag delete` gates read first and refuse without
 *    `--yes`, naming the resource rather than an id;
 *  - the name→id hops (project → type → state, project → board → entry, …) really
 *    happen, in order, and only the fields given are sent (arrays replace wholesale).
 *
 * Responses are no-arg constructors consumed in order (the last repeats), exactly as
 * `test/pjmPlanningCommands.test.ts` does. Each resolution list is a single short page
 * so the fetch count per invocation is deterministic.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const PROJECT = '6a1c41781c7734aaad9ec23c';
const TYPE = '5f1234567890abcdef123456';
const TYPE2 = '5f1234567890abcdef123457';
const STATE = '6b1234567890abcdef123456';
const STATE2 = '6b1234567890abcdef123457';
const PRIORITY = '6c1234567890abcdef123456';
const USER = 'f5712155d0e54d0b94ffacb1384217f0';
const SPRINT = '6a712ff4a2f1bc8bb00eba3f';
const VERSION = '6a712f293e127a186f111f51';
const BOARD = '6d1234567890abcdef123456';
const ENTRY = '6e1234567890abcdef123456';
const SWIMLANE = '6f1234567890abcdef123456';
const WI = '6a9876543210fedcba123456';
const WI2 = '6b9876543210fedcba123456';
const LINK = '6c9876543210fedcba123456';
const TAG = '6d9876543210fedcba123456';
const TAG2 = '6d9876543210fedcba123457';
const HISTORY = '6e9876543210fedcba123456';
const RELATION = '6f9876543210fedcba123456';

/** A short, single-page envelope (page_size 100 so the walk stops on one fetch). */
function page(values: unknown[], pageIndex = 0, total?: number): Response {
  return jsonResponse({
    page_index: pageIndex,
    page_size: 100,
    total: total ?? values.length,
    values,
  });
}
const emptyPage = () => page([]);

const projectBody = (over: Record<string, unknown> = {}) => ({
  id: PROJECT,
  name: 'Mobile App',
  identifier: 'MOB',
  type: 'scrum',
  ...over,
});
const typeBody = (over: Record<string, unknown> = {}) => ({
  id: TYPE,
  name: 'task',
  description: '任务',
  ...over,
});
const stateBody = (over: Record<string, unknown> = {}) => ({
  id: STATE,
  name: '进行中',
  type: 'task',
  ...over,
});
const priorityBody = (over: Record<string, unknown> = {}) => ({
  id: PRIORITY,
  name: '中',
  color: '#ff0',
  ...over,
});
const userBody = (over: Record<string, unknown> = {}) => ({
  id: USER,
  name: '王小',
  display_name: '王小',
  username: 'wangxiao',
  email: 'wx@x.com',
  ...over,
});
const sprintBody = (over: Record<string, unknown> = {}) => ({
  id: SPRINT,
  name: 'Sprint 5',
  status: 'pending',
  start_at: 1788192000,
  end_at: 1790783999,
  ...over,
});
const versionBody = (over: Record<string, unknown> = {}) => ({
  id: VERSION,
  name: '1.4.0',
  ...over,
});
const boardBody = (over: Record<string, unknown> = {}) => ({
  id: BOARD,
  name: '看板',
  project: { id: PROJECT, name: 'Mobile App' },
  ...over,
});
const entryBody = (over: Record<string, unknown> = {}) => ({
  id: ENTRY,
  name: '待处理',
  board: { id: BOARD },
  ...over,
});
const swimlaneBody = (over: Record<string, unknown> = {}) => ({
  id: SWIMLANE,
  name: '默认泳道',
  board: { id: BOARD },
  ...over,
});
const relationTypeBody = (over: Record<string, unknown> = {}) => ({
  id: RELATION,
  name: '关联',
  category: 'relate',
  is_system: 1,
  ...over,
});
const tagVocabBody = (over: Record<string, unknown> = {}) => ({
  id: TAG,
  name: 'P0',
  ...over,
});

const workItemBody = (over: Record<string, unknown> = {}) => ({
  id: WI,
  identifier: 'SCR-5',
  short_id: 'SCR-5',
  title: 'Fix login bug',
  type: 'task',
  state: { id: STATE, name: '进行中' },
  priority: { id: PRIORITY, name: '中' },
  assignee: { id: USER, name: '王小' },
  project: { id: PROJECT, name: 'Mobile App' },
  sprint: { id: SPRINT, name: 'Sprint 5' },
  versions: [{ id: VERSION, name: '1.4.0' }],
  tags: [{ id: TAG, name: 'P0' }],
  start_at: 1788192000,
  end_at: 1790783999,
  created_at: 1780000000,
  updated_at: 1785000000,
  html_url: 'https://pingcode.com/p/SCR-5',
  description: 'details',
  ...over,
});
const workItem2Body = (over: Record<string, unknown> = {}) =>
  workItemBody({ id: WI2, identifier: 'SCR-6', short_id: 'SCR-6', title: 'Other item', ...over });
/** A work item whose locator reports no project (so a tag NAME cannot be resolved). */
const workItemNoProjectBody = (over: Record<string, unknown> = {}) => {
  const body = workItemBody(over);
  delete (body as Record<string, unknown>).project;
  return body;
};
/** A work item with no id (so delete cannot resolve it to a real id). */
const workItemNoIdBody = (over: Record<string, unknown> = {}) => {
  const body = workItemBody(over);
  delete (body as Record<string, unknown>).id;
  return body;
};

/** A work item whose locator reports no type (so candidate states cannot be listed). */
const workItemNoTypeBody = (over: Record<string, unknown> = {}) => {
  const body = workItemBody(over);
  delete (body as Record<string, unknown>).type;
  return body;
};

const linkBody = (over: Record<string, unknown> = {}) => ({
  id: LINK,
  relation_type: 'relate',
  origin_work_item: { id: WI, identifier: 'SCR-5', title: 'Fix login bug' },
  target_work_item: { id: WI2, identifier: 'SCR-6', title: 'Other item' },
  ...over,
});
const tagAttachmentBody = (over: Record<string, unknown> = {}) => ({
  id: TAG,
  tag: { id: TAG, name: 'P0' },
  work_item: { id: WI, identifier: 'SCR-5' },
  ...over,
});
const historyBody = (over: Record<string, unknown> = {}) => ({
  id: HISTORY,
  from_state: null,
  to_state: { id: STATE, name: '进行中' },
  created_by: { id: USER, name: '王小' },
  created_at: 1780000000,
  work_item: { id: WI },
  ...over,
});
const bulkResultBody = (over: Record<string, unknown> = {}) => ({
  inserts: 0,
  updates: 1,
  deletes: 0,
  ...over,
});

// response constructors (no-arg, consumed in order)
const projectsPage = () => page([projectBody()]);
const typesPage = () => page([typeBody()]);
const twoTypesPage = () =>
  page([typeBody({ id: TYPE, name: 'task' }), typeBody({ id: TYPE2, name: 'bug' })]);
const statesPage = () => page([stateBody()]);
const bugStatesPage = () => page([stateBody({ id: STATE2, name: '进行中' })]);
const prioritiesPage = () => page([priorityBody()]);
const usersPage = () => page([userBody()]);
const memberBody = (over: Record<string, unknown> = {}) => ({
  id: USER,
  type: 'user',
  user: { id: USER, name: 'wangxiao', display_name: '王小' },
  role: { id: 'r', name: '普通成员' },
  ...over,
});
const memberPage = () => jsonResponse(memberBody());
const notFound = () => jsonResponse({ code: '100404', message: 'not found' }, { status: 404 });
const sprintsPage = () => page([sprintBody()]);
const versionsPage = () => page([versionBody()]);
const boardsPage = () => page([boardBody()]);
const entriesPage = () => page([entryBody()]);
const swimlanesPage = () => page([swimlaneBody()]);
const tagsVocabPage = () => page([tagVocabBody()]);
const twoTagsPage = () => page([tagVocabBody({ id: TAG, name: 'P0' }), tagVocabBody({ id: TAG2, name: 'P0' })]);
const relationTypesPage = () => page([relationTypeBody()]);
const workItemsPage = () => page([workItemBody()]);
const twoWorkItemsPage = () => page([workItemBody(), workItem2Body()]);
const workItemPage = () => jsonResponse(workItemBody());
const workItem2Page = () => jsonResponse(workItem2Body());
const linkPage = () => jsonResponse(linkBody());
const tagAttachPage = () => jsonResponse(tagAttachmentBody());
const historyPage = () => jsonResponse(historyBody());
const bulkResultPage = () => jsonResponse(bulkResultBody());
const linksPage = () => page([linkBody()]);
const historiesPage = () => page([historyBody()]);
const badRequest = (code = '100999', message = '拒绝') => jsonResponse({ code, message }, { status: 400 });

// ---------------------------------------------------------------------------
// exported helpers
// ---------------------------------------------------------------------------

describe('typeIdOf / typeLabelOf', () => {
  it('reads the slug string or the ref id', () => {
    expect(typeIdOf('task')).toBe('task');
    expect(typeIdOf('')).toBeUndefined();
    expect(typeIdOf({ id: TYPE, name: '任务' })).toBe(TYPE);
    expect(typeIdOf(undefined)).toBeUndefined();
  });

  it('labels a slug verbatim and a ref by its name', () => {
    expect(typeLabelOf('task')).toBe('task');
    expect(typeLabelOf({ id: TYPE, name: '任务' })).toBe('任务');
    // a ref with no name falls back to its id
    expect(typeLabelOf({ id: TYPE })).toBe(TYPE);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('project work-item list', () => {
  it('resolves the project then lists on the REST endpoint', async () => {
    const run = await runCli(['project', 'work-item', 'list', '--project', 'Mobile App'], [
      projectsPage,
      workItemsPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_items?');
    expect(run.calls[1]?.url).toContain(`project_id=${PROJECT}`);
    expect(run.stdout).toContain('SCR-5');
    expect(run.stderr).toContain('1 row(s)');
  });

  it('accepts a project id directly without a name lookup miss', async () => {
    const run = await runCli(['project', 'work-item', 'list', '--project', PROJECT, '--json'], [
      projectsPage,
      workItemsPage,
    ]);
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { total: number };
    expect(parsed.total).toBe(1);
  });

  it('keeps stdout JSON-only under --json', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', PROJECT, '--json'],
      [projectsPage, workItemsPage],
    );
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { identifier: string }[] };
    expect(parsed.values[0]?.identifier).toBe('SCR-5');
  });

  it('walks pages under --all', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', PROJECT, '--all', '--json'],
      [projectsPage, twoWorkItemsPage],
    );
    const parsed = JSON.parse(run.stdout) as { count: number; all: boolean };
    expect(parsed).toMatchObject({ count: 2, all: true });
  });

  it('resolves --type then --state <name> together', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--type', 'task', '--state', '进行中'],
      [projectsPage, typesPage, statesPage, workItemsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[2]?.url).toContain('/v1/pjm/work_item/states?');
    expect(run.calls[2]?.url).toContain(`work_item_type_id=${TYPE}`);
    expect(run.calls[3]?.url).toContain(`state_id=${STATE}`);
  });

  it('resolves --state <name> across all types when --type is omitted', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--state', '进行中'],
      [projectsPage, typesPage, statesPage, workItemsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_item/types?');
    expect(run.calls[3]?.url).toContain(`state_id=${STATE}`);
  });

  it('forces the search endpoint when the state name matches several types', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--state', '进行中', '--json'],
      [projectsPage, twoTypesPage, statesPage, bugStatesPage, () => page([workItemBody()])],
    );
    expect(run.exit).toBe(0);
    // the last request is a POST to the search endpoint
    const last = run.calls[run.calls.length - 1];
    expect(last?.method).toBe('POST');
    expect(last?.url).toContain('/v1/pjm/work_items/search');
    const body = last?.body as { payload: { filter: { 'state.id': { in: string[] } } } };
    expect(body.payload.filter['state.id'].in).toEqual([STATE, STATE2]);
  });

  it('passes --state-id through with no lookup and no --type', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', PROJECT, '--state-id', STATE],
      [projectsPage, workItemsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`state_id=${STATE}`);
  });

  it('resolves each reference filter by name', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        'Mobile App',
        '--assignee',
        'wangxiao',
        '--sprint',
        'Sprint 5',
        '--priority',
        '中',
        '--release',
        '1.4.0',
        '--tag',
        'P0',
        '--parent',
        WI2,
        '--created-by',
        'wangxiao',
        '--participant',
        'wangxiao',
      ],
      [
        projectsPage,
        usersPage,
        sprintsPage,
        workItem2Page,
        prioritiesPage,
        versionsPage,
        tagsVocabPage,
        usersPage,
        usersPage,
        workItemsPage,
      ],
    );
    expect(run.exit).toBe(0);
    const url = run.calls[run.calls.length - 1]?.url ?? '';
    expect(url).toContain(`assignee_id=${USER}`);
    expect(url).toContain(`sprint_id=${SPRINT}`);
    expect(url).toContain(`priority_id=${PRIORITY}`);
    expect(url).toContain(`version_id=${VERSION}`);
    expect(url).toContain(`tag_id=${TAG}`);
    expect(url).toContain(`parent_id=${WI2}`);
    expect(url).toContain(`created_by=${USER}`);
    expect(url).toContain(`participant_id=${USER}`);
  });

  it('resolves --board / --entry / --swimlane against the project boards', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        'Mobile App',
        '--board',
        '看板',
        '--entry',
        '待处理',
        '--swimlane',
        '默认泳道',
      ],
      [projectsPage, boardsPage, boardsPage, entriesPage, boardsPage, swimlanesPage, workItemsPage],
    );
    expect(run.exit).toBe(0);
    const url = run.calls[run.calls.length - 1]?.url ?? '';
    expect(url).toContain(`board_id=${BOARD}`);
    expect(url).toContain(`entry_id=${ENTRY}`);
    expect(url).toContain(`swimlane_id=${SWIMLANE}`);
  });

  it('sends REST-only filters untouched (identifier, bug-type, phase, keywords)', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        PROJECT,
        '--identifier',
        'SCR-5',
        '--bug-type',
        'bugtype-1',
        '--phase',
        'phase-1',
        '--keywords',
        'login',
      ],
      [projectsPage, workItemsPage],
    );
    expect(run.exit).toBe(0);
    const url = run.calls[1]?.url ?? '';
    expect(url).toContain('identifier=SCR-5');
    expect(url).toContain('bug_type_id=bugtype-1');
    expect(url).toContain('phase_id=phase-1');
    expect(url).toContain('keywords=login');
  });

  it('switches to the search endpoint for a search-only flag', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', PROJECT, '--title-contains', 'login', '--json'],
      [projectsPage, () => page([workItemBody()])],
    );
    expect(run.exit).toBe(0);
    const last = run.calls[run.calls.length - 1];
    expect(last?.method).toBe('POST');
    expect(last?.url).toContain('/v1/pjm/work_items/search');
    const body = last?.body as { payload: { filter: { title: { contains: string } } } };
    expect(body.payload.filter.title).toEqual({ contains: 'login' });
  });

  it('builds a between window and a one-sided range in the search filter', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'list',
        '--project',
        PROJECT,
        '--created-after',
        '2026-08-01',
        '--created-before',
        '2026-08-31',
        '--start-after',
        '2026-09-01',
        '--story-points',
        '5',
        '--description-contains',
        'bug',
      ],
      [projectsPage, () => page([workItemBody()])],
    );
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    const filter = body.payload.filter;
    const created = filter['created_at'] as { between: [number, number] };
    expect(Array.isArray(created.between)).toBe(true);
    expect(created.between[1]).toBeGreaterThan(created.between[0]);
    expect(filter['start_at']).toHaveProperty('gte');
    expect(filter['story_points']).toEqual({ eq: 5 });
    expect(filter['description']).toEqual({ contains: 'bug' });
  });

  it('refuses --unassigned together with --assignee before sending', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--unassigned', '--assignee', 'wangxiao'],
      [projectsPage, usersPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('sets assignee.id exists:false for --unassigned on the search endpoint', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', PROJECT, '--unassigned', '--json'],
      [projectsPage, () => page([workItemBody()])],
    );
    const body = run.calls[1]?.body as { payload: { filter: { 'assignee.id': { exists: boolean } } } };
    expect(body.payload.filter['assignee.id']).toEqual({ exists: false });
  });

  it('refuses an unknown --type before any list request', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--type', 'NoSuchType'],
      [projectsPage, typesPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('work item type');
  });

  it('refuses an unknown --state before any list request', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--type', 'task', '--state', 'Nope'],
      [projectsPage, typesPage, statesPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });

  it('refuses an invalid search date before any list request', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', PROJECT, '--created-after', 'notadate'],
      [projectsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('--created-after');
  });

  it('refuses a non-numeric --story-points', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', PROJECT, '--story-points', 'abc'],
      [projectsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });

  it('reports no state named across all types', async () => {
    const run = await runCli(
      ['project', 'work-item', 'list', '--project', 'Mobile App', '--state', 'Nope'],
      [projectsPage, typesPage, statesPage],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('no state named');
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('project work-item get', () => {
  it('reads one work item by id', async () => {
    const run = await runCli(['project', 'work-item', 'get', WI], [workItemPage]);
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain(`/v1/pjm/work_items/${WI}`);
    expect(run.stdout).toContain('SCR-5');
    expect(run.stdout).toContain('Fix login bug');
  });

  it('looks up an identifier through the list endpoint', async () => {
    const run = await runCli(['project', 'work-item', 'get', 'SCR-5', '--json'], [workItemsPage]);
    expect(run.stderr).toBe('');
    expect(run.calls[0]?.url).toContain('identifier=SCR-5');
    expect((JSON.parse(run.stdout) as { identifier: string }).identifier).toBe('SCR-5');
  });

  it('reports not found for an unknown identifier', async () => {
    const run = await runCli(['project', 'work-item', 'get', 'UNKNOWN-9'], [emptyPage]);
    expect(run.exit).toBe(5);
    expect(run.stderr).toContain('no work item has identifier');
  });

  it('refuses an ambiguous identifier', async () => {
    const run = await runCli(['project', 'work-item', 'get', 'DUP-1'], [twoWorkItemsPage]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('matched 2 work items');
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('project work-item create', () => {
  const CREATE = [
    'project',
    'work-item',
    'create',
    '--project',
    'Mobile App',
    '--type',
    'task',
    '--title',
    'New item',
  ];

  it('resolves project and type, then posts the required fields', async () => {
    const run = await runCli(CREATE, [projectsPage, typesPage, workItemPage]);
    expect(run.exit).toBe(0);
    const write = run.writes[0];
    expect(write?.method).toBe('POST');
    expect(write?.url).toContain('/v1/pjm/work_items');
    expect(write?.body).toMatchObject({ project_id: PROJECT, type_id: TYPE, title: 'New item' });
    expect(run.stderr).toContain('created SCR-5');
  });

  it('omits unset optional fields from the body', async () => {
    const run = await runCli(CREATE, [projectsPage, typesPage, workItemPage]);
    expect(Object.keys(run.writes[0]?.body as object).sort()).toEqual([
      'project_id',
      'title',
      'type_id',
    ]);
  });

  it('resolves the optional references and sends only the given fields', async () => {
    const run = await runCli(
      [
        ...CREATE,
        '--description',
        'd',
        '--state',
        '进行中',
        '--priority',
        '中',
        '--assignee',
        'wangxiao',
        '--sprint',
        'Sprint 5',
        '--board',
        '看板',
        '--story-points',
        '3',
        '--start-at',
        '2026-09-01',
        '--end-at',
        '2026-09-30',
      ],
      [projectsPage, typesPage, statesPage, prioritiesPage, usersPage, memberPage, sprintsPage, boardsPage, workItemPage],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      description: 'd',
      state_id: STATE,
      priority_id: PRIORITY,
      assignee_id: USER,
      sprint_id: SPRINT,
      board_id: BOARD,
      story_points: 3,
    });
    expect(body).toHaveProperty('start_at');
    expect(body).toHaveProperty('end_at');
  });

  it('keeps stdout JSON-only under --json', async () => {
    const run = await runCli([...CREATE, '--json'], [projectsPage, typesPage, workItemPage]);
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { id: string }).id).toBe(WI);
  });

  it('refuses a missing --title before any request', async () => {
    const run = await runCli(
      ['project', 'work-item', 'create', '--project', 'Mobile App', '--type', 'task'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('refuses a missing --type before any request', async () => {
    const run = await runCli(
      ['project', 'work-item', 'create', '--project', 'Mobile App', '--title', 'X'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('prints a plan and sends nothing under --dry-run, while reads still run', async () => {
    const run = await runCli([...CREATE, '--dry-run', '--json'], [projectsPage, typesPage]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(run.calls.length).toBeGreaterThan(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
  });
});

// ---------------------------------------------------------------------------
// update / transition
// ---------------------------------------------------------------------------

describe('project work-item update', () => {
  it('sends only the scalar fields given', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--title', 'Renamed', '--story-points', '8'],
      [workItemPage, workItemPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.body).toMatchObject({ title: 'Renamed', story_points: 8 });
    expect(Object.keys(run.writes[0]?.body as object).sort()).toEqual(['story_points', 'title']);
  });

  it('resolves --state <name> using the item-reported type when --type is omitted', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--state', '进行中'],
      [workItemPage, statesPage, workItemPage],
    );
    expect(run.exit).toBe(0);
    // the state lookup used the slug the item reported as its type
    expect(run.calls[1]?.url).toContain('work_item_type_id=task');
    expect(run.writes[0]?.body).toMatchObject({ state_id: STATE });
  });

  it('resolves --state <name> with an explicit --type', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--state', '进行中', '--type', 'task'],
      [workItemPage, typesPage, statesPage, workItemPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_item/types?');
    expect(run.writes[0]?.body).toMatchObject({ state_id: STATE });
  });

  it('passes --state-id through with no lookup', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--state-id', STATE],
      [workItemPage, workItemPage],
    );
    expect(run.calls).toHaveLength(2);
    expect(run.writes[0]?.body).toMatchObject({ state_id: STATE });
  });

  it('resolves --release and sends the whole version_ids list', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--release', '1.4.0'],
      [workItemPage, versionsPage, workItemPage],
    );
    expect((run.writes[0]?.body as { version_ids: string[] }).version_ids).toEqual([VERSION]);
  });

  it('sends sprint_id: "" for --clear-sprint with no project resolution', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--clear-sprint'],
      [workItemPage, workItemPage],
    );
    expect(run.calls).toHaveLength(2);
    expect(run.writes[0]?.body).toMatchObject({ sprint_id: '' });
  });

  it('resolves --sprint into sprint_id', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--sprint', 'Sprint 5'],
      [workItemPage, sprintsPage, workItemPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ sprint_id: SPRINT });
  });

  it('resolves --assignee / --priority / --parent / --board / --entry / --swimlane', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'update',
        WI,
        '--assignee',
        'wangxiao',
        '--priority',
        '中',
        '--parent',
        WI2,
        '--board',
        '看板',
        '--entry',
        '待处理',
        '--swimlane',
        '默认泳道',
      ],
      [
        workItemPage,
        prioritiesPage,
        usersPage,
        memberPage,
        workItem2Page,
        boardsPage,
        boardsPage,
        entriesPage,
        boardsPage,
        swimlanesPage,
        workItemPage,
      ],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      assignee_id: USER,
      priority_id: PRIORITY,
      parent_id: WI2,
      board_id: BOARD,
      entry_id: ENTRY,
      swimlane_id: SWIMLANE,
    });
  });

  it('refuses a name reference when the work item reports no project', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--assignee', 'wangxiao'],
      [() => jsonResponse(workItemNoProjectBody())],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('did not report a project');
  });

  it('rejects an empty assignee before resolving it', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--assignee', ''],
      [workItemPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('cannot clear');
  });

  it('refuses --type alone with an explanation', async () => {
    const run = await runCli(['project', 'work-item', 'update', WI, '--type', 'task'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('does not modify the work item type');
  });

  it('refuses an empty patch before any request', async () => {
    const run = await runCli(['project', 'work-item', 'update', WI], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('refuses --sprint and --clear-sprint together', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--sprint', 'Sprint 5', '--clear-sprint'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('keeps stdout JSON-only under --json', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--title', 'X', '--json'],
      [workItemPage, workItemPage],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { title: string }).title).toBe('Fix login bug');
  });

  it('lists candidate states when a state change is rejected by the server', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--state', '进行中', '--type', 'task', '--json'],
      [workItemPage, typesPage, statesPage, () => badRequest('100999', '流转失败'), statesPage],
    );
    expect(run.exit).toBe(7);
    // the candidate states are warned on stderr, then the error is rendered
    expect(run.stderr).toContain('states configured for this');
    expect(run.stderr).toContain('"exit":7');
  });

  it('warns that candidate states cannot be listed when the item reports no type', async () => {
    // `--state-id` needs no type, so the state resolves even though the item carries
    // none — but a server rejection then cannot be annotated with candidates.
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--state-id', STATE, '--json'],
      [() => jsonResponse(workItemNoTypeBody()), () => badRequest('100999', '流转失败')],
    );
    expect(run.exit).toBe(7);
    expect(run.stderr).toContain('does not report a work item');
  });

  it('prints a plan and sends nothing under --dry-run, while reads still run', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--state', '进行中', '--type', 'task', '--dry-run', '--json'],
      [workItemPage, typesPage, statesPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(run.calls.length).toBeGreaterThan(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
  });
});

describe('project work-item transition', () => {
  it('requires --state or --state-id', async () => {
    const run = await runCli(['project', 'work-item', 'transition', WI], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('requires --state');
  });

  it('moves the item to a state through the single update path', async () => {
    const run = await runCli(
      ['project', 'work-item', 'transition', WI, '--state', '进行中', '--type', 'task'],
      [workItemPage, typesPage, statesPage, workItemPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.body).toMatchObject({ state_id: STATE });
  });
});

// ---------------------------------------------------------------------------
// bulk-update
// ---------------------------------------------------------------------------

describe('project work-item bulk-update', () => {
  it('sets one title on one id', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--title', 'Same'],
      [workItemPage, bulkResultPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toMatchObject({ ids: [WI], property_name: 'title', property_value: 'Same' });
    expect(run.stderr).toContain('updated 1 work item');
  });

  it('resolves --assignee by name', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--assignee', 'wangxiao', '--project', 'Mobile App'],
      [workItemPage, projectsPage, usersPage, memberPage, bulkResultPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ property_name: 'assignee_id', property_value: USER });
  });

  it('passes --assignee-id through with no lookup', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--assignee-id', USER, '--project', 'Mobile App'],
      [workItemPage, projectsPage, memberPage, bulkResultPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ property_name: 'assignee_id', property_value: USER });
  });

  it('resolves --state by name with --project and --type', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'bulk-update',
        '--id',
        WI,
        '--state',
        '进行中',
        '--project',
        'Mobile App',
        '--type',
        'task',
      ],
      [workItemPage, projectsPage, typesPage, statesPage, bulkResultPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ property_name: 'state_id', property_value: STATE });
  });

  it('refuses --state <name> without --project', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--state', '进行中'],
      [workItemPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('requires --project');
  });

  it('passes --state-id through with no lookup', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--state-id', STATE],
      [workItemPage, bulkResultPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ property_name: 'state_id', property_value: STATE });
  });

  it('resolves --priority by name with --project', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--priority', '中', '--project', 'Mobile App'],
      [workItemPage, projectsPage, prioritiesPage, bulkResultPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ property_name: 'priority_id', property_value: PRIORITY });
  });

  it('passes --priority-id through with no lookup', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--priority-id', PRIORITY],
      [workItemPage, bulkResultPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ property_name: 'priority_id', property_value: PRIORITY });
  });

  it('refuses --priority <name> without --project', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--priority', '中'],
      [workItemPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('requires --project');
  });

  it('sends an empty description (a legitimate value, not a clear)', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--description', ''],
      [workItemPage, bulkResultPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ property_name: 'description', property_value: '' });
  });

  it('parses --value as JSON when it parses, else raw string', async () => {
    const jsonRun = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--property', 'severity', '--value', '{"a":1}'],
      [workItemPage, bulkResultPage],
    );
    expect(jsonRun.writes[0]?.body).toMatchObject({ property_name: 'severity', property_value: { a: 1 } });

    const rawRun = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--property', 'severity', '--value', 'hello'],
      [workItemPage, bulkResultPage],
    );
    expect(rawRun.writes[0]?.body).toMatchObject({ property_name: 'severity', property_value: 'hello' });
  });

  it('refuses --property without --value', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--property', 'severity'],
      [workItemPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('requires --value');
  });

  it('refuses no property', async () => {
    const run = await runCli(['project', 'work-item', 'bulk-update', '--id', WI], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('no property was given');
  });

  it('refuses two properties', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--title', 'X', '--description', 'Y'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('only one property');
  });

  it('requires --id at least once', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--title', 'X'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('resolves every --id to a real id, one read each', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--id', WI2, '--title', 'Same'],
      [workItemPage, workItem2Page, bulkResultPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ ids: [WI, WI2] });
  });

  it('warns when fewer than requested were updated', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--title', 'Same', '--json'],
      [workItemPage, () => jsonResponse(bulkResultBody({ updates: 0 }))],
    );
    expect(run.stderr).toContain('0 of 1 work item');
  });

  it('notes that --property is not validated when it is under-applied', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--property', 'severity', '--value', '5'],
      [workItemPage, () => jsonResponse(bulkResultBody({ updates: 0 }))],
    );
    expect(run.stderr).toContain('not validated');
  });

  it('keeps stdout JSON-only under --json', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--title', 'Same', '--json'],
      [workItemPage, bulkResultPage],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { updates: number }).updates).toBe(1);
  });

  it('prints a plan and sends nothing under --dry-run, while reads still run', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--title', 'Same', '--dry-run', '--json'],
      [workItemPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(run.calls.length).toBeGreaterThan(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
  });

  // ─── non-member assignee blocked ──────────────────────────────────────────

  it('blocks --assignee on create when the user is not a project member', async () => {
    const run = await runCli(
      ['project', 'work-item', 'create', '--project', 'Mobile App', '--type', 'task', '--title', 'T', '--assignee', 'wangxiao'],
      [projectsPage, typesPage, usersPage, notFound],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('not a member');
    expect(run.stderr).toContain('cannot see the card');
  });

  it('blocks --assignee on update when the user is not a project member', async () => {
    const run = await runCli(
      ['project', 'work-item', 'update', WI, '--assignee', 'wangxiao'],
      [workItemPage, usersPage, notFound],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('not a member');
  });

  it('blocks --assignee on bulk-update when the user is not a project member', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--assignee', 'wangxiao', '--project', 'Mobile App'],
      [workItemPage, projectsPage, usersPage, notFound],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('not a member');
  });

  it('blocks --assignee-id on bulk-update when the user is not a project member', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--assignee-id', USER, '--project', 'Mobile App'],
      [workItemPage, projectsPage, notFound],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('not a member');
  });

  it('requires --project for --assignee on bulk-update to verify membership', async () => {
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--assignee', 'wangxiao'],
      [workItemPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('requires --project');
  });

  it('rejects items from other projects when --assignee and --project are set', async () => {
    const otherProjectItem = () => jsonResponse(workItemBody({ project: { id: '6a9999999999999999999999', name: 'Other' } }));
    const run = await runCli(
      ['project', 'work-item', 'bulk-update', '--id', WI, '--assignee', 'wangxiao', '--project', 'Mobile App'],
      [otherProjectItem, projectsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('must belong to the --project');
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('project work-item delete', () => {
  it('reads first and refuses without --yes, naming the item', async () => {
    const run = await runCli(['project', 'work-item', 'delete', WI], [workItemPage]);
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('SCR-5');
    expect(run.stderr).toContain('Fix login bug');
  });

  it('deletes with --yes', async () => {
    const run = await runCli(
      ['project', 'work-item', 'delete', WI, '--yes'],
      [workItemPage, workItemPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.writes[0]?.url).toContain(`/v1/pjm/work_items/${WI}`);
    expect(run.stderr).toContain('deleted SCR-5');
  });

  it('deletes an identifier reference', async () => {
    const run = await runCli(
      ['project', 'work-item', 'delete', 'SCR-5', '--yes'],
      [workItemsPage, workItemPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('DELETE');
  });

  it('reports not found when the work item has no id', async () => {
    const run = await runCli(
      ['project', 'work-item', 'delete', WI, '--yes'],
      [() => jsonResponse(workItemNoIdBody())],
    );
    expect(run.exit).toBe(5);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('could not resolve');
  });

  it('sends no DELETE under --dry-run, though the pre-read still runs', async () => {
    const run = await runCli(
      ['project', 'work-item', 'delete', WI, '--yes', '--dry-run', '--json'],
      [workItemPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(run.calls.length).toBeGreaterThan(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('DELETE');
  });

  it('rejects --yes false rather than obeying it', async () => {
    const run = await runCli(
      ['project', 'work-item', 'delete', WI, '--yes', 'false'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

describe('project work-item link list', () => {
  it('lists the links of a work item', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'list', WI],
      [workItemPage, linksPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/work_items/${WI}/relations`);
    expect(run.stdout).toContain('SCR-6');
  });

  it('filters by --relation name (resolved via the vocabulary)', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'list', WI, '--relation', 'relate'],
      [workItemPage, relationTypesPage, linksPage],
    );
    expect(run.calls[2]?.url).toContain(`relation_type=${RELATION}`);
  });

  it('filters by --relation-id with no lookup', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'list', WI, '--relation-id', RELATION],
      [workItemPage, linksPage],
    );
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`relation_type=${RELATION}`);
  });

  it('refuses --relation and --relation-id together', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'list', WI, '--relation', 'relate', '--relation-id', RELATION],
      [workItemPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });

  it('walks all links under --all', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'list', WI, '--all', '--json'],
      [workItemPage, () => page([linkBody(), linkBody({ id: 'l2' })])],
    );
    const parsed = JSON.parse(run.stdout) as { count: number; all: boolean };
    expect(parsed).toMatchObject({ count: 2, all: true });
  });

  it('keeps stdout JSON-only under --json', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'list', WI, '--json'],
      [workItemPage, linksPage],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { values: unknown[] }).values).toHaveLength(1);
  });
});

describe('project work-item link get', () => {
  it('reads one link', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'get', WI, LINK],
      [workItemPage, linkPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/work_items/${WI}/relations/${LINK}`);
    expect(run.stdout).toContain('relate');
  });
});

describe('project work-item link add', () => {
  it('links two work items with a relation name', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'add', WI, '--target', WI2, '--relation', 'relate'],
      [workItemPage, workItem2Page, relationTypesPage, linkPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain(`/v1/pjm/work_items/${WI}/relations`);
    expect(run.writes[0]?.body).toMatchObject({ target_work_item_id: WI2, relation_type: RELATION });
    expect(run.stderr).toContain('linked SCR-6');
  });

  it('links with --relation-id and skips the vocabulary lookup', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'add', WI, '--target', WI2, '--relation-id', RELATION],
      [workItemPage, workItem2Page, linkPage],
    );
    expect(run.calls).toHaveLength(3);
    expect(run.writes[0]?.body).toMatchObject({ relation_type: RELATION });
  });

  it('requires --relation or --relation-id', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'add', WI, '--target', WI2],
      [workItemPage, workItem2Page],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('requires --relation');
  });

  it('refuses --relation and --relation-id together', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'link',
        'add',
        WI,
        '--target',
        WI2,
        '--relation',
        'relate',
        '--relation-id',
        RELATION,
      ],
      [workItemPage, workItem2Page],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });

  it('prints a plan and sends nothing under --dry-run, while reads still run', async () => {
    const run = await runCli(
      [
        'project',
        'work-item',
        'link',
        'add',
        WI,
        '--target',
        WI2,
        '--relation-id',
        RELATION,
        '--dry-run',
        '--json',
      ],
      [workItemPage, workItem2Page],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(run.calls.length).toBeGreaterThan(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
  });
});

describe('project work-item link delete', () => {
  it('reads first and refuses without --yes, naming both ends', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'delete', WI, LINK],
      [workItemPage, linkPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('SCR-5');
    expect(run.stderr).toContain('SCR-6');
  });

  it('deletes with --yes (both directions)', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'delete', WI, LINK, '--yes'],
      [workItemPage, linkPage, linkPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.stderr).toContain('unlinked SCR-6');
  });

  it('sends no DELETE under --dry-run, though the pre-read still runs', async () => {
    const run = await runCli(
      ['project', 'work-item', 'link', 'delete', WI, LINK, '--yes', '--dry-run', '--json'],
      [workItemPage, linkPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('DELETE');
  });
});

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

describe('project work-item tag add', () => {
  it('adds a tag by id', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', WI, '--tag-id', TAG],
      [workItemPage, tagAttachPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain(`/v1/pjm/work_items/${WI}/tags`);
    expect(run.writes[0]?.body).toMatchObject({ tag_id: TAG });
    expect(run.stderr).toContain('tagged P0');
  });

  it('resolves a tag by name against the vocabulary', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', WI, '--tag', 'P0'],
      [workItemPage, tagsVocabPage, tagAttachPage],
    );
    expect(run.writes[0]?.body).toMatchObject({ tag_id: TAG });
  });

  it('requires --tag or --tag-id', async () => {
    const run = await runCli(['project', 'work-item', 'tag', 'add', WI], [workItemPage]);
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('requires --tag');
  });

  it('refuses --tag and --tag-id together', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', WI, '--tag', 'P0', '--tag-id', TAG],
      [workItemPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });

  it('refuses an unknown tag name, listing the known ones', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', WI, '--tag', 'Nope'],
      [workItemPage, tagsVocabPage],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('no tag matches');
  });

  it('refuses an ambiguous tag name', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', WI, '--tag', 'P0'],
      [workItemPage, twoTagsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('matches 2 tags');
  });

  it('refuses a tag name when the work item reports no project', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', WI, '--tag', 'P0'],
      [() => jsonResponse(workItemNoProjectBody())],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('did not report a project');
  });

  it('explains a foreign-project tag (100354) and still exits 7', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', WI, '--tag-id', TAG],
      [workItemPage, () => badRequest('100354', "'tag'资源不存在")],
    );
    expect(run.exit).toBe(7);
    expect(run.stderr).toContain('different project');
  });

  it('keeps stdout JSON-only under --json', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'add', WI, '--tag-id', TAG, '--json'],
      [workItemPage, tagAttachPage],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { id: string }).id).toBe(TAG);
  });
});

describe('project work-item tag get', () => {
  it('reads one tag of a work item', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'get', WI, TAG],
      [workItemPage, tagAttachPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/work_items/${WI}/tags/${TAG}`);
    expect(run.stdout).toContain('P0');
  });
});

describe('project work-item tag delete', () => {
  it('reads first and refuses without --yes', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'delete', WI, TAG],
      [workItemPage, tagAttachPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('without --yes');
  });

  it('deletes with --yes', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'delete', WI, TAG, '--yes'],
      [workItemPage, tagAttachPage, tagAttachPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.stderr).toContain('untagged P0');
  });

  it('sends no DELETE under --dry-run, though the pre-read still runs', async () => {
    const run = await runCli(
      ['project', 'work-item', 'tag', 'delete', WI, TAG, '--yes', '--dry-run', '--json'],
      [workItemPage, tagAttachPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('DELETE');
  });
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

describe('project work-item history list', () => {
  it('lists the state changes of a work item', async () => {
    const run = await runCli(
      ['project', 'work-item', 'history', 'list', WI],
      [workItemPage, historiesPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/work_items/${WI}/transition_histories`);
    expect(run.stdout).toContain('(new)');
  });

  it('walks all history under --all', async () => {
    const run = await runCli(
      ['project', 'work-item', 'history', 'list', WI, '--all', '--json'],
      [workItemPage, () => page([historyBody(), historyBody({ id: 'h2' })])],
    );
    const parsed = JSON.parse(run.stdout) as { count: number; all: boolean };
    expect(parsed).toMatchObject({ count: 2, all: true });
  });

  it('keeps stdout JSON-only under --json', async () => {
    const run = await runCli(
      ['project', 'work-item', 'history', 'list', WI, '--json'],
      [workItemPage, historiesPage],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { values: unknown[] }).values).toHaveLength(1);
  });
});

describe('project work-item history get', () => {
  it('reads one state change', async () => {
    const run = await runCli(
      ['project', 'work-item', 'history', 'get', WI, HISTORY],
      [workItemPage, historyPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/work_items/${WI}/transition_histories/${HISTORY}`);
    expect(run.stdout).toContain('进行中');
  });
});
