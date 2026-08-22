import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * The core `project` group end to end: `list / get / create / update / progress`
 * and the `project meta …` lookups, through the real `buildProgram()` tree with
 * `fetch` replaced at the global boundary and the config directory redirected to a
 * temp dir. No network, no real credentials.
 *
 * The sub-groups (`project work-item`, `project sprint`, `project version`,
 * `project board`, `project member`) are exercised in their own suites
 * (`pjmWorkItemCommands`, `pjmPlanningCommands`, `projectBoardCommands`,
 * `projectMemberCommands`) — this file owns only the group's own verbs and its
 * `meta` lookups.
 *
 * What is proven here and cannot be proven at the api layer:
 *  - `--json` keeps **stdout JSON-only**, with tables and notices on stderr;
 *  - `--dry-run` on a write prints the request plan and sends **zero** mutating
 *    requests, while the name lookups it needs still run;
 *  - every flag refusal — an unknown `--type`, a bad `--start-at`, an empty
 *    update patch, a missing `--project` — happens **before** any request goes out;
 *  - the two name→id hops (`resolveProject`, then `resolveUser` / `resolveWorkItemType`)
 *    are really made, in order;
 *  - an unresolvable project name is exit 2 with the real candidates listed;
 *  - the project-not-found code `100300` is **not** mapped to exit 5 (it conflates
 *    "no such project" with "kanban has no iteration module"), so it stays exit 7.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const PROJECT = '6a1c41781c7734aaad9ec23c';
const PROJECT2 = '6a2c41781c7734aaad9ec23d';
const USER = 'f5712155d0e54d0b94ffacb1384217f0';
const USER2 = 'a1b2c3d4e5f647a8b9c0d1e2f3a4b5c6';

const projectBody = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT,
  url: `https://open.pingcode.com/v1/pjm/projects/${PROJECT}`,
  html_url: 'https://open.pingcode.com/pjm/projects/MOB',
  name: 'Mobile App',
  identifier: 'MOB',
  type: 'scrum',
  visibility: 'private',
  is_archived: 0,
  state: { id: 's1', name: '进行中' },
  assignee: { id: USER, name: 'wangxiao', display_name: '王小' },
  start_at: 1785700000,
  end_at: 1785800000,
  description: 'a mobile app',
  created_at: 1785700000,
  updated_at: 1785800000,
  ...overrides,
});

const projectsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [projectBody()],
  });

const oneProject = () => jsonResponse(projectBody());

const usersPage = (overrides: Record<string, unknown> = {}) =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [
      {
        id: USER,
        name: 'wangxiao',
        display_name: '王小',
        username: 'wangxiao',
        email: 'wx@example.com',
        ...overrides,
      },
    ],
  });

const usersPage2 = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: USER2, name: 'lisi', username: 'lisi', email: 'ls@example.com' }],
  });

const progressBody = () =>
  jsonResponse({
    work_item: { total: 10, pending_count: 3, in_progress_count: 4, completed_count: 3 },
  });

const typesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'story', name: '用户故事', description: 'a story' },
      { id: 'task', name: '任务', description: 'a task' },
    ],
  });

const statesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'state-open', name: '打开', type: 'pending' },
      { id: 'state-progress', name: '进行中', type: 'in_progress' },
    ],
  });

const prioritiesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'pri-high', name: '高' },
      { id: 'pri-mid', name: '中' },
    ],
  });

const sprintsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [
      {
        id: 'sp1',
        name: 'Sprint 1',
        status: 'pending',
        start_at: 1788192000,
        end_at: 1790783999,
      },
    ],
  });

const relationTypesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'rel-1', name: '关联', category: 'relate', is_system: 1 },
      { id: 'rel-2', name: '阻塞', category: 'block', is_system: 1 },
    ],
  });

const tagsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'tag-1', name: '前端', color: '#00ff00' },
      { id: 'tag-2', name: '后端', color: '#0000ff' },
    ],
  });

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('project list', () => {
  it('lists projects as a table with the row count on stderr', async () => {
    const run = await runCli(['project', 'list'], [projectsPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('Mobile App');
    expect(run.stdout).toContain('MOB');
    expect(run.stdout).toContain('scrum');
    expect(run.stderr).toContain('1 row(s)');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(['project', 'list', '--json'], [projectsPage]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { total: number; values: { identifier: string }[] };
    expect(parsed.total).toBe(1);
    expect(parsed.values[0]?.identifier).toBe('MOB');
  });

  it('sends only paging when no filter is given', async () => {
    const run = await runCli(['project', 'list'], [projectsPage]);
    const url = run.calls[0]?.url ?? '';
    expect(url).toContain('page_index=0');
    expect(url).toContain('page_size=30');
    expect(url).not.toContain('keywords=');
    expect(url).not.toContain('type=');
    expect(url).not.toContain('include_archived=');
  });

  it('passes keywords, type and include_archived as query params', async () => {
    const run = await runCli(
      ['project', 'list', '--keywords', 'mobile', '--type', 'scrum', '--include-archived'],
      [projectsPage],
    );
    const url = run.calls[0]?.url ?? '';
    expect(url).toContain('keywords=mobile');
    expect(url).toContain('type=scrum');
    expect(url).toContain('include_archived=true');
  });

  it('honours --page / --page-size', async () => {
    const run = await runCli(['project', 'list', '--page', '1', '--page-size', '2'], [projectsPage]);
    const url = run.calls[0]?.url ?? '';
    expect(url).toContain('page_index=1');
    expect(url).toContain('page_size=2');
  });

  it('walks pages under --all and reports the collected shape', async () => {
    const run = await runCli(
      ['project', 'list', '--all', '--page-size', '1', '--json'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 1,
            total: 2,
            values: [projectBody({ id: PROJECT, identifier: 'MOB' })],
          }),
        () =>
          jsonResponse({
            page_index: 1,
            page_size: 1,
            total: 2,
            values: [projectBody({ id: PROJECT2, identifier: 'WEB' })],
          }),
        () => jsonResponse({ page_index: 2, page_size: 1, total: 2, values: [] }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ count: 2, all: true });
  });

  it('refuses a --page-size over 100 before sending anything', async () => {
    const run = await runCli(['project', 'list', '--page-size', '101'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--page-size');
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('project get', () => {
  it('resolves the project by name, then reads it', async () => {
    const run = await runCli(['project', 'get', 'Mobile App'], [projectsPage, oneProject]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    // The resolution loads the whole list first…
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    // …then the real id is read.
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}`);
    expect(run.calls[1]?.url).not.toContain('?');
    expect(run.stdout).toContain('Mobile App');
  });

  it('passes a bare id through (still resolved against the list) and reads it', async () => {
    const run = await runCli(['project', 'get', PROJECT], [projectsPage, oneProject]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}`);
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(['project', 'get', 'Mobile App', '--json'], [projectsPage, oneProject]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { id: string }).id).toBe(PROJECT);
  });

  it('sends include_archived only with --include-archived', async () => {
    const run = await runCli(
      ['project', 'get', PROJECT, '--include-archived'],
      [projectsPage, oneProject],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain('include_archived=true');
  });

  it('omits include_archived by default', async () => {
    const run = await runCli(['project', 'get', PROJECT], [projectsPage, oneProject]);
    expect(run.calls[1]?.url).not.toContain('include_archived');
  });

  it('prints a curated field block in human mode', async () => {
    const run = await runCli(['project', 'get', PROJECT], [projectsPage, oneProject]);
    expect(run.stdout).toContain('name');
    expect(run.stdout).toContain('Mobile App');
    expect(run.stdout).toContain('identifier');
    expect(run.stdout).toContain('MOB');
  });

  it('exits 2 and lists candidates when the name does not resolve', async () => {
    const run = await runCli(['project', 'get', 'NOSUCH'], [projectsPage]);
    expect(run.exit).toBe(2);
    // Only the resolution list was fetched — the get never ran.
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('no project matches');
    expect(run.stderr).toContain('Mobile App');
  });

  it('exits 7 on 100300, which is deliberately not mapped to not_found', async () => {
    // 100300 conflates "no such project" with "kanban has no iteration module", so it
    // stays ApiError (exit 7) — see core/wire.ts and the endpoints note.
    const run = await runCli(
      ['project', 'get', PROJECT, '--json'],
      [
        projectsPage,
        () => jsonResponse({ code: '100300', message: "'project'资源不存在" }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(7);
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'api', code: '100300', exit: 7 } });
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('project create', () => {
  const CREATE = [
    'project',
    'create',
    '--name',
    'Mobile App',
    '--identifier',
    'MOB',
    '--type',
    'scrum',
  ];

  it('sends the three required fields and nothing else', async () => {
    const run = await runCli(CREATE, [oneProject]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.url).toContain('/v1/pjm/projects');
    expect(run.writes[0]?.body).toEqual({ type: 'scrum', name: 'Mobile App', identifier: 'MOB' });
  });

  it('includes every optional field it was given', async () => {
    const run = await runCli(
      [
        ...CREATE,
        '--description',
        'a mobile app',
        '--visibility',
        'public',
        '--process-id',
        'proc-1',
        '--start-at',
        '1785700000',
        '--end-at',
        '1785800000',
      ],
      [oneProject],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      type: 'scrum',
      name: 'Mobile App',
      identifier: 'MOB',
      description: 'a mobile app',
      visibility: 'public',
      process_id: 'proc-1',
      start_at: 1785700000,
      end_at: 1785800000,
    });
  });

  it('sends timestamps as unix seconds, never milliseconds', async () => {
    const run = await runCli(
      [...CREATE, '--start-at', '1785700000', '--end-at', '1785800000'],
      [oneProject],
    );
    const body = run.writes[0]?.body as { start_at: number; end_at: number };
    expect(body.start_at).toBe(1785700000);
    expect(body.end_at).toBe(1785800000);
    expect(String(body.start_at)).toHaveLength(10);
  });

  it('parses a date string into unix seconds for the timestamps', async () => {
    const run = await runCli(
      [
        ...CREATE,
        '--start-at',
        '2026-08-04T09:00:00Z',
        '--end-at',
        '2026-08-04T10:00:00Z',
      ],
      [oneProject],
    );
    const body = run.writes[0]?.body as { start_at: number; end_at: number };
    expect(String(body.start_at)).toHaveLength(10);
    expect(body.end_at - body.start_at).toBe(3600);
  });

  it('resolves the assignee by name and sends assignee_id', async () => {
    const run = await runCli([...CREATE, '--assignee', 'wangxiao'], [usersPage, oneProject]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('/v1/directory/users?');
    expect(run.calls[0]?.url).toContain('keywords=wangxiao');
    expect((run.writes[0]?.body as { assignee_id: string }).assignee_id).toBe(USER);
  });

  it('resolves every --member and sends the members array', async () => {
    const run = await runCli(
      [...CREATE, '--member', 'wangxiao', '--member', 'lisi'],
      [usersPage, usersPage2, oneProject],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(run.writes[0]?.method).toBe('POST');
    expect((run.writes[0]?.body as { members: { id: string; type: string }[] }).members).toEqual([
      { id: USER, type: 'user' },
      { id: USER2, type: 'user' },
    ]);
  });

  it('refuses an unknown --type before any request', async () => {
    const run = await runCli([...CREATE.slice(0, 6), '--type', 'waterfallish'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('unknown project type');
    expect(run.stderr).toContain('scrum');
  });

  it('refuses a bad --start-at before any request', async () => {
    const run = await runCli([...CREATE, '--start-at', 'not-a-date'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--start-at');
  });

  it('refuses a missing required flag before any request', async () => {
    const run = await runCli(['project', 'create', '--name', 'x', '--type', 'scrum'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('refuses an unresolvable assignee after the lookup, sending nothing', async () => {
    const run = await runCli([...CREATE, '--assignee', 'Nobody'], [usersPage]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('no user matches');
  });

  it('prints the request plan and sends nothing on a dry-run', async () => {
    const run = await runCli([...CREATE, '--dry-run', '--json'], [oneProject]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.body).toEqual({ type: 'scrum', name: 'Mobile App', identifier: 'MOB' });
  });

  it('still resolves the assignee on a dry-run, but sends nothing', async () => {
    const run = await runCli([...CREATE, '--assignee', 'wangxiao', '--dry-run', '--json'],
      [usersPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    // The read a dry run needs still happened.
    expect(run.calls).toHaveLength(1);
    const plan = JSON.parse(run.stdout) as { request: { body: { assignee_id: string } } };
    expect(plan.request.body.assignee_id).toBe(USER);
  });

  it('prints the dry-run plan on stderr in human mode, keeping stdout empty', async () => {
    const run = await runCli([...CREATE, '--dry-run'], [oneProject]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('dry run');
    expect(run.stderr).toContain('POST');
  });

  it('exits 7 on a duplicate identifier (100336), which is not an absence', async () => {
    const run = await runCli(
      [...CREATE, '--json'],
      [() => jsonResponse({ code: '100336', message: "'project'标识已经存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(7);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'api', code: '100336', exit: 7 } });
  });

  it('echoes the created project and logs the verb in human mode', async () => {
    const run = await runCli(CREATE, [oneProject]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('Mobile App');
    expect(run.stdout).toContain('MOB');
    expect(run.stderr).toContain('created MOB');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli([...CREATE, '--json'], [oneProject]);
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { identifier: string }).identifier).toBe('MOB');
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('project update', () => {
  it('sends only the fields it was given', async () => {
    const run = await runCli(
      ['project', 'update', PROJECT, '--name', 'Renamed'],
      [projectsPage, oneProject],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/v1/pjm/projects/${PROJECT}`);
    expect(run.writes[0]?.body).toEqual({ name: 'Renamed' });
  });

  it('sends several patchable fields together', async () => {
    const run = await runCli(
      [
        'project',
        'update',
        PROJECT,
        '--name',
        'Renamed',
        '--identifier',
        'WEB',
        '--description',
        'new desc',
        '--state-id',
        'state-9',
        '--start-at',
        '1785700000',
        '--end-at',
        '1785800000',
      ],
      [projectsPage, oneProject],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      name: 'Renamed',
      identifier: 'WEB',
      description: 'new desc',
      state_id: 'state-9',
      start_at: 1785700000,
      end_at: 1785800000,
    });
  });

  it('resolves the project then the assignee, and sends assignee_id', async () => {
    const run = await runCli(
      ['project', 'update', PROJECT, '--assignee', 'wangxiao'],
      [projectsPage, usersPage, oneProject],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain('keywords=wangxiao');
    expect(run.writes[0]?.body).toEqual({ assignee_id: USER });
  });

  it('resolves a project name to an id before patching', async () => {
    const run = await runCli(
      ['project', 'update', 'Mobile App', '--name', 'Renamed'],
      [projectsPage, oneProject],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.writes[0]?.url).toContain(`/v1/pjm/projects/${PROJECT}`);
  });

  it('refuses an empty patch before any request', async () => {
    const run = await runCli(['project', 'update', PROJECT], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('refuses a bad --start-at before any request', async () => {
    const run = await runCli(
      ['project', 'update', PROJECT, '--name', 'x', '--start-at', 'yesterday'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--start-at');
  });

  it('refuses an unresolvable project before sending the patch', async () => {
    const run = await runCli(['project', 'update', 'NOSUCH', '--name', 'x'], [projectsPage]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('no project matches');
  });

  it('prints the plan and sends nothing on a dry-run', async () => {
    const run = await runCli(
      ['project', 'update', PROJECT, '--name', 'Renamed', '--dry-run', '--json'],
      [projectsPage, oneProject],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    // The project resolution still ran.
    expect(run.calls).toHaveLength(1);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
  });

  it('exits 7 on a 100300 from the PATCH', async () => {
    const run = await runCli(
      ['project', 'update', PROJECT, '--name', 'Renamed', '--json'],
      [
        projectsPage,
        () => jsonResponse({ code: '100300', message: "'project'资源不存在" }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(7);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'api', code: '100300', exit: 7 } });
  });

  it('echoes the patched project and logs the verb in human mode', async () => {
    const run = await runCli(['project', 'update', PROJECT, '--name', 'Renamed'], [
      projectsPage,
      oneProject,
    ]);
    expect(run.exit).toBe(0);
    // The PATCH response is the resource as the server stored it (still "Mobile App"
    // here); the sent patch was asserted separately above.
    expect(run.stdout).toContain('Mobile App');
    expect(run.stderr).toContain('updated MOB');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'update', PROJECT, '--name', 'Renamed', '--json'],
      [projectsPage, oneProject],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { name: string }).name).toBe('Mobile App');
  });
});

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

describe('project progress', () => {
  it('resolves the project then reads the progress block', async () => {
    const run = await runCli(['project', 'progress', 'Mobile App'], [projectsPage, progressBody]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/progress`);
    // The progress endpoint is not a list, so no paging params ride along.
    expect(run.calls[1]?.url).not.toContain('page_index=');
  });

  it('prints the three work-item counts in human mode', async () => {
    const run = await runCli(['project', 'progress', PROJECT], [projectsPage, progressBody]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('work items');
    expect(run.stdout).toContain('10');
    expect(run.stdout).toContain('open');
    expect(run.stdout).toContain('3');
    expect(run.stdout).toContain('in progress');
    expect(run.stdout).toContain('4');
    expect(run.stdout).toContain('completed');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(['project', 'progress', PROJECT, '--json'], [
      projectsPage,
      progressBody,
    ]);
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { work_item: { total: number } };
    expect(parsed.work_item.total).toBe(10);
  });

  it('exits 2 when the project name does not resolve', async () => {
    const run = await runCli(['project', 'progress', 'NOSUCH'], [projectsPage]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('no project matches');
  });

  it('exits 7 on a 100300 from the progress endpoint', async () => {
    const run = await runCli(
      ['project', 'progress', PROJECT, '--json'],
      [
        projectsPage,
        () => jsonResponse({ code: '100300', message: "'project'资源不存在" }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(7);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'api', code: '100300', exit: 7 } });
  });
});

// ---------------------------------------------------------------------------
// meta types
// ---------------------------------------------------------------------------

describe('project meta types', () => {
  it('resolves the project then lists its work-item types', async () => {
    const run = await runCli(['project', 'meta', 'types', '--project', 'Mobile App'], [
      projectsPage,
      typesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_item/types?');
    expect(run.calls[1]?.url).toContain(`project_id=${PROJECT}`);
    expect(run.stdout).toContain('用户故事');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(['project', 'meta', 'types', '--project', PROJECT, '--json'], [
      projectsPage,
      typesPage,
    ]);
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { id: string }[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.values[0]?.id).toBe('story');
  });

  it('refuses a missing --project before any request', async () => {
    const run = await runCli(['project', 'meta', 'types'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('exits 2 when the project name does not resolve', async () => {
    const run = await runCli(['project', 'meta', 'types', '--project', 'NOSUCH'], [projectsPage]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('no project matches');
  });
});

// ---------------------------------------------------------------------------
// meta states
// ---------------------------------------------------------------------------

describe('project meta states', () => {
  it('resolves project then type, then lists the (project, type) states', async () => {
    const run = await runCli(
      ['project', 'meta', 'states', '--project', 'Mobile App', '--type', '用户故事'],
      [projectsPage, typesPage, statesPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_item/types?');
    expect(run.calls[2]?.url).toContain('/v1/pjm/work_item/states?');
    expect(run.calls[2]?.url).toContain(`project_id=${PROJECT}`);
    expect(run.calls[2]?.url).toContain('work_item_type_id=story');
    expect(run.stdout).toContain('打开');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'meta', 'states', '--project', PROJECT, '--type', 'story', '--json'],
      [projectsPage, typesPage, statesPage],
    );
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { id: string }[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.values[0]?.id).toBe('state-open');
  });

  it('resolves a type id without a second lookup', async () => {
    const run = await runCli(
      ['project', 'meta', 'states', '--project', PROJECT, '--type', 'story'],
      [projectsPage, typesPage, statesPage],
    );
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_item/types?');
    // The resolved type id is what the states query carries.
    expect(run.calls[2]?.url).toContain('work_item_type_id=story');
  });

  it('refuses a missing --type before any request', async () => {
    const run = await runCli(['project', 'meta', 'states', '--project', PROJECT], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('refuses a missing --project before any request', async () => {
    const run = await runCli(['project', 'meta', 'states', '--type', 'story'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('exits 2 when the type name does not resolve', async () => {
    const run = await runCli(
      ['project', 'meta', 'states', '--project', PROJECT, '--type', 'NOSUCH'],
      [projectsPage, typesPage],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(2);
    expect(run.stderr).toContain('no work item type matches');
  });
});

// ---------------------------------------------------------------------------
// meta priorities
// ---------------------------------------------------------------------------

describe('project meta priorities', () => {
  it('resolves the project then lists its priorities', async () => {
    const run = await runCli(['project', 'meta', 'priorities', '--project', 'Mobile App'], [
      projectsPage,
      prioritiesPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_item/priorities?');
    expect(run.calls[1]?.url).toContain(`project_id=${PROJECT}`);
    expect(run.stdout).toContain('高');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'meta', 'priorities', '--project', PROJECT, '--json'],
      [projectsPage, prioritiesPage],
    );
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { name: string }[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.values[0]?.name).toBe('高');
  });

  it('refuses a missing --project before any request', async () => {
    const run = await runCli(['project', 'meta', 'priorities'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// meta sprints
// ---------------------------------------------------------------------------

describe('project meta sprints', () => {
  it('resolves the project then lists its sprints', async () => {
    const run = await runCli(['project', 'meta', 'sprints', '--project', 'Mobile App'], [
      projectsPage,
      sprintsPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/sprints`);
    expect(run.calls[1]?.url).not.toContain('status=');
    expect(run.stdout).toContain('Sprint 1');
  });

  it('passes --status as a query param', async () => {
    const run = await runCli(
      ['project', 'meta', 'sprints', '--project', PROJECT, '--status', 'pending'],
      [projectsPage, sprintsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls[1]?.url).toContain('status=pending');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'meta', 'sprints', '--project', PROJECT, '--json'],
      [projectsPage, sprintsPage],
    );
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { name: string }[]; count: number };
    expect(parsed.count).toBe(1);
    expect(parsed.values[0]?.name).toBe('Sprint 1');
  });

  it('exits 7 on a bad --status the server enum-rejects (100003)', async () => {
    // `meta sprints` casts --status verbatim (no client-side enum check), so an
    // unknown value reaches the server and comes back as a plain ApiError.
    const run = await runCli(
      ['project', 'meta', 'sprints', '--project', PROJECT, '--status', 'bogus', '--json'],
      [
        projectsPage,
        () =>
          jsonResponse(
            { code: '100003', message: "'status'不是有效的枚举值" },
            { status: 400 },
          ),
      ],
    );
    expect(run.exit).toBe(7);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'api', code: '100003', exit: 7 } });
  });

  it('refuses a missing --project before any request', async () => {
    const run = await runCli(['project', 'meta', 'sprints'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// meta relation-types
// ---------------------------------------------------------------------------

describe('project meta relation-types', () => {
  it('lists the relation types with no parameters at all', async () => {
    const run = await runCli(['project', 'meta', 'relation-types'], [relationTypesPage]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain('/v1/pjm/work_item/relation_types');
    expect(run.calls[0]?.url).not.toContain('project_id=');
    expect(run.stdout).toContain('关联');
    expect(run.stdout).toContain('relate');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(['project', 'meta', 'relation-types', '--json'], [relationTypesPage]);
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { category: string }[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.values[0]?.category).toBe('relate');
    // is_system arrives as 0/1 and is normalised to a boolean exactly once.
    expect((parsed.values[0] as unknown as { is_system: unknown }).is_system).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// meta tags
// ---------------------------------------------------------------------------

describe('project meta tags', () => {
  it('resolves the project then lists the (org-wide) tag vocabulary', async () => {
    const run = await runCli(['project', 'meta', 'tags', '--project', 'Mobile App'], [
      projectsPage,
      tagsPage,
    ]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain('/v1/pjm/work_item/tags?');
    expect(run.calls[1]?.url).toContain(`project_id=${PROJECT}`);
    expect(run.stdout).toContain('前端');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('passes --name as a substring filter', async () => {
    const run = await runCli(
      ['project', 'meta', 'tags', '--project', PROJECT, '--name', 'front'],
      [projectsPage, tagsPage],
    );
    expect(run.calls[1]?.url).toContain('name=front');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'meta', 'tags', '--project', PROJECT, '--json'],
      [projectsPage, tagsPage],
    );
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { name: string }[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.values[0]?.name).toBe('前端');
  });

  it('refuses a missing --project before any request', async () => {
    const run = await runCli(['project', 'meta', 'tags'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('exits 2 when the project name does not resolve', async () => {
    const run = await runCli(['project', 'meta', 'tags', '--project', 'NOSUCH'], [projectsPage]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('no project matches');
  });
});
