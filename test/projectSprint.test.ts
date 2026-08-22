import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `project sprint …` — the write half of the 迭代 surface (get / create / update /
 * bulk-create), end to end through the real `buildProgram()` tree with `fetch`
 * replaced at the global boundary and the config directory redirected to a temp
 * dir. No network, no real credentials.
 *
 * The read-only `list` lives under `project meta sprints` (tested elsewhere), so
 * this group's leaves are exactly the four below. The value here is in the
 * branches a happy-path suite leaves cold:
 *
 *  - every optional create/update field (`--description`, `--status`,
 *    `--category-id`, `--assignee`) really travelling in the body, and the
 *    "nothing to update" / backwards-window refusals firing **before** any request;
 *  - `readStatus`'s valid-return path (an unknown status is covered, a known one
 *    is not) on create, update and a bulk entry;
 *  - `explainKanban`: a `100300` is rewritten with the scrum/hybrid explanation,
 *    but any *other* code passes through untouched — the rethrow branch;
 *  - `storyPointCell` staying blank when the sprint reports neither total;
 *  - `printBulk` dropping a failed entry (no `resource`) from the created set
 *    while keeping its `state` under `--json`;
 *  - a bulk entry resolving its own project (the per-entry `project` branch).
 *
 * Response builders take **no arguments**: the harness feeds each one through
 * the fake fetch as `handler(call, index)`, so a parameterised builder would
 * silently bind its first parameter to the `FakeCall` and corrupt the body —
 * variants are written as separate no-arg arrows instead.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const PROJECT = '6a1c41781c7734aaad9ec23c';
const SPRINT = '6a712ff4a2f1bc8bb00eba3f';
const USER = 'f5712155d0e54d0b94ffacb1384217f0';

/** `GET /v1/pjm/projects?` — one scrum project, by name. */
const projectsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: PROJECT, name: 'Mobile App', identifier: 'MOB', type: 'scrum' }],
  });

/** `GET /v1/directory/users?keywords=` — the sprint owner. */
const usersPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: USER, name: 'wangxiao', display_name: '王小', username: 'wangxiao' }],
  });

/** A sprint as the create/update/detail endpoints return it. */
const sprintBody = (overrides: Record<string, unknown> = {}) => ({
  id: SPRINT,
  url: `https://open.pingcode.com/v1/pjm/projects/${PROJECT}/sprints/${SPRINT}`,
  name: 'Sprint 5',
  status: 'pending',
  start_at: 1788192000,
  end_at: 1790783999,
  assignee: { id: USER, name: 'wangxiao', display_name: '王小' },
  total_story_points: 0,
  completed_story_points: 0,
  started_story_points: 0,
  categories: [],
  ...overrides,
});

/** `GET /v1/pjm/projects/{project_id}/sprints` — the resolver's candidate list. */
const sprintsPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [sprintBody()] });

/** A sprint detail that reports no story-point fields at all (blank cell). */
const sprintWithoutStoryPoints = () => () =>
  jsonResponse(
    sprintBody({
      total_story_points: undefined,
      completed_story_points: undefined,
      started_story_points: undefined,
    }),
  );

/** A JSON document on disk, for the `bulk-create --file` leaf. */
function withFile(contents: unknown): { path: string; cleanup: () => void } {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingcode-bulk-'));
  const file = path.join(dir, 'entries.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { path: file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('project sprint get', () => {
  it('resolves the project then the sprint, then reads the sprint', async () => {
    const run = await runCli(
      ['project', 'sprint', 'get', 'Sprint 5', '--project', 'Mobile App'],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );

    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/sprints`);
    expect(run.calls[2]?.url).toContain(`/v1/pjm/projects/${PROJECT}/sprints/${SPRINT}`);
    expect(run.stdout).toContain('Sprint 5');
  });

  it('accepts the sprint id directly and still loads the list to confirm it', async () => {
    const run = await runCli(
      ['project', 'sprint', 'get', SPRINT, '--project', PROJECT],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    // An id still goes through the project's sprint list (the only enumerator).
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/sprints`);
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'sprint', 'get', SPRINT, '--project', PROJECT, '--json'],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { id: string }).id).toBe(SPRINT);
  });

  it('leaves the story-point cell blank when the sprint reports neither total', async () => {
    // storyPointCell returns '' only when BOTH totals are absent; a fresh sprint's
    // 0/0 is the other branch, already covered above.
    const run = await runCli(
      ['project', 'sprint', 'get', SPRINT, '--project', PROJECT],
      [projectsPage, sprintsPage, sprintWithoutStoryPoints()],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).not.toContain('0 / 0');
    expect(run.stdout).not.toContain('story points');
  });

  it('renders 0/0 story points for a fresh sprint', async () => {
    const run = await runCli(
      ['project', 'sprint', 'get', SPRINT, '--project', PROJECT],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.stdout).toContain('0 / 0');
  });

  it('blanks the absent name/status/url cells and shows a partial story-point ratio', async () => {
    // printSprint's `?? ''` true-branches (name/status/url absent) and storyPointCell's
    // `?? 0` true-branches (one total present, the other absent) — a sparse sprint.
    const sparse = () => () =>
      jsonResponse({
        id: SPRINT,
        start_at: 1788192000,
        end_at: 1790783999,
        assignee: { id: USER },
        total_story_points: 5,
        categories: [],
      });
    const run = await runCli(
      ['project', 'sprint', 'get', SPRINT, '--project', PROJECT],
      [projectsPage, sprintsPage, sparse()],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('0 / 5');
    // The absent fields are dropped from the human block, not printed as "undefined".
    expect(run.stdout).not.toContain('undefined');
  });

  it('shows a ratio when only the completed total is present', async () => {
    // storyPointCell's `total ?? 0` true-branch: the other total is the one absent.
    const completedOnly = () => () =>
      jsonResponse({
        id: SPRINT,
        start_at: 1788192000,
        end_at: 1790783999,
        assignee: { id: USER },
        completed_story_points: 3,
        categories: [],
      });
    const run = await runCli(
      ['project', 'sprint', 'get', SPRINT, '--project', PROJECT],
      [projectsPage, sprintsPage, completedOnly()],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('3 / 0');
  });

  it('refuses an unknown sprint name before reading it', async () => {
    const run = await runCli(
      ['project', 'sprint', 'get', 'Nope', '--project', 'Mobile App'],
      [projectsPage, sprintsPage],
    );
    expect(run.exit).toBe(2);
    // Project + sprint lookup ran; the sprint detail did not.
    expect(run.calls).toHaveLength(2);
    expect(run.stderr).toContain('no sprint matches');
  });

  it('refuses an unknown project name before resolving the sprint', async () => {
    const run = await runCli(['project', 'sprint', 'get', 'Sprint 5', '--project', 'Nope'], [
      projectsPage,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('no project matches');
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('project sprint create', () => {
  const CREATE = [
    'project',
    'sprint',
    'create',
    '--project',
    'Mobile App',
    '--name',
    'Sprint 5',
    '--start',
    '2026-09-01',
    '--end',
    '2026-09-14',
    '--assignee',
    'wangxiao',
  ];

  it('resolves both names and sends the four required fields', async () => {
    const run = await runCli(CREATE, [projectsPage, usersPage, () => jsonResponse(sprintBody())]);
    expect(run.exit).toBe(0);
    const write = run.writes[0];
    expect(write?.method).toBe('POST');
    expect(write?.url).toContain(`/v1/pjm/projects/${PROJECT}/sprints`);
    expect(write?.body).toMatchObject({ name: 'Sprint 5', assignee_id: USER });
  });

  it('maps --start to 00:00:00 and --end to 23:59:59 of their dates', async () => {
    const run = await runCli(CREATE, [projectsPage, usersPage, () => jsonResponse(sprintBody())]);
    const body = run.writes[0]?.body as { start_at: number; end_at: number };
    expect(new Date(body.start_at * 1000).getHours()).toBe(0);
    expect(new Date(body.end_at * 1000).getHours()).toBe(23);
    expect(body.end_at - body.start_at).toBeGreaterThan(13 * 24 * 3600);
  });

  it('falls back to the sprint id in the created notice when the name is absent', async () => {
    // printSprint's `verb` line uses `sprint.name ?? sprint.id`; a nameless response
    // (not a real-world case, but the branch must exist) prints the id instead.
    const run = await runCli(CREATE, [
      projectsPage,
      usersPage,
      () => jsonResponse(sprintBody({ name: undefined })),
    ]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(`created ${SPRINT}`);
  });

  it('sends --description only when given', async () => {
    const run = await runCli(
      [...CREATE, '--description', 'kick off the mobile sprint'],
      [projectsPage, usersPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect((run.writes[0]?.body as { description: string }).description).toBe(
      'kick off the mobile sprint',
    );
  });

  it('omits description when absent', async () => {
    const run = await runCli(CREATE, [projectsPage, usersPage, () => jsonResponse(sprintBody())]);
    expect((run.writes[0]?.body as Record<string, unknown>).description).toBeUndefined();
  });

  it('sends a valid --status through readStatus', async () => {
    // The unknown-status branch is covered elsewhere; this is the valid-return
    // path, which also stamps `status` onto the body.
    const run = await runCli(
      [...CREATE, '--status', 'in_progress'],
      [projectsPage, usersPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect((run.writes[0]?.body as { status: string }).status).toBe('in_progress');
  });

  it('replaces the category set with --category-id (repeatable)', async () => {
    const run = await runCli(
      [...CREATE, '--category-id', 'cat-1', '--category-id', 'cat-2'],
      [projectsPage, usersPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect((run.writes[0]?.body as { category_ids: string[] }).category_ids).toEqual([
      'cat-1',
      'cat-2',
    ]);
  });

  it('sends every optional field together', async () => {
    const run = await runCli(
      [
        ...CREATE,
        '--description',
        'full optionals',
        '--status',
        'completed',
        '--category-id',
        'cat-9',
      ],
      [projectsPage, usersPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toMatchObject({
      description: 'full optionals',
      status: 'completed',
      category_ids: ['cat-9'],
    });
  });

  it('refuses a backwards window before sending anything', async () => {
    const run = await runCli(
      [...CREATE.slice(0, -4), '--end', '2026-08-01', '--assignee', 'wangxiao'],
      [projectsPage, usersPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
    // No name resolution ran either — the window is judged from the input alone.
    expect(run.calls).toHaveLength(0);
  });

  it('refuses an unknown --status before sending anything', async () => {
    const run = await runCli([...CREATE, '--status', 'started'], [projectsPage, usersPage]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('pending');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses a malformed --start before any request', async () => {
    const run = await runCli(
      [...CREATE.slice(0, -4), '--start', '2026-9-1', '--assignee', 'wangxiao'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('prints a request plan and sends nothing under --dry-run', async () => {
    const run = await runCli([...CREATE, '--dry-run', '--json'], [projectsPage, usersPage]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    // The reads a dry run needs still happen — that is what makes it a useful probe.
    expect(run.calls.length).toBeGreaterThan(0);
  });

  it('explains the kanban case when the API blames the project', async () => {
    // `100300 'project'资源不存在` is returned for a kanban project too, and is
    // deliberately not mapped to exit 5 (design D15.8). The explanation goes on the
    // **message**, because --json errors drop the hint.
    const run = await runCli(
      [...CREATE, '--json'],
      [
        projectsPage,
        usersPage,
        () => jsonResponse({ code: '100300', message: "'project'资源不存在" }, { status: 400 }),
      ],
    );
    expect(run.exit).toBe(7);
    const error = JSON.parse(run.stderr) as { error: { message: string; exit: number } };
    expect(error.error.message).toContain('scrum/hybrid');
    expect(error.error.exit).toBe(7);
  });

  it('passes a non-kanban error through explainKanban untouched', async () => {
    // explainKanban only rewrites 100300; a duplicate-name 100390 must reach the
    // caller verbatim (exit 7, no scrum/hybrid rewrite) — the rethrow branch.
    const run = await runCli(
      [...CREATE, '--json'],
      [
        projectsPage,
        usersPage,
        () =>
          jsonResponse(
            { code: '100390', message: "'sprint'资源名称已存在" },
            { status: 400 },
          ),
      ],
    );
    expect(run.exit).toBe(7);
    const error = JSON.parse(run.stderr) as { error: { message: string; kind: string } };
    expect(error.error.kind).toBe('api');
    expect(error.error.message).not.toContain('scrum/hybrid');
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('project sprint update', () => {
  it('refuses an empty patch before any request', async () => {
    const run = await runCli(['project', 'sprint', 'update', SPRINT, '--project', PROJECT], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('sends only the fields given, and both window ends together', async () => {
    const run = await runCli(
      [
        'project',
        'sprint',
        'update',
        SPRINT,
        '--project',
        PROJECT,
        '--start',
        '2026-10-01',
        '--end',
        '2026-10-31',
      ],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['end_at', 'start_at']);
  });

  it('sends a single window end without re-checking the other', async () => {
    // Only --start: the `start && end` guard is skipped, so no stored-end lookup.
    const run = await runCli(
      ['project', 'sprint', 'update', SPRINT, '--project', PROJECT, '--start', '2026-10-01'],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect(Object.keys(run.writes[0]?.body as object).sort()).toEqual(['start_at']);
  });

  it('refuses a backwards window when both ends are given', async () => {
    const run = await runCli(
      [
        'project',
        'sprint',
        'update',
        SPRINT,
        '--project',
        PROJECT,
        '--start',
        '2026-10-31',
        '--end',
        '2026-10-01',
      ],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('before');
  });

  it('patches --name alone', async () => {
    const run = await runCli(
      ['project', 'sprint', 'update', SPRINT, '--project', PROJECT, '--name', 'Sprint 5b'],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ name: 'Sprint 5b' });
  });

  it('patches --description alone', async () => {
    const run = await runCli(
      [
        'project',
        'sprint',
        'update',
        SPRINT,
        '--project',
        PROJECT,
        '--description',
        'replanned',
      ],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ description: 'replanned' });
  });

  it('patches a valid --status through readStatus', async () => {
    const run = await runCli(
      ['project', 'sprint', 'update', SPRINT, '--project', PROJECT, '--status', 'completed'],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ status: 'completed' });
  });

  it('resolves --assignee by name and sends only assignee_id', async () => {
    // --assignee is the one field that is never in patchBase, so it exercises the
    // dedicated `flags.assignee !== undefined` branch (an extra user resolution
    // and an extra resolution pushed for cache-invalidation).
    const run = await runCli(
      ['project', 'sprint', 'update', SPRINT, '--project', PROJECT, '--assignee', 'wangxiao'],
      [projectsPage, sprintsPage, usersPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ assignee_id: USER });
    expect(run.calls).toHaveLength(4);
  });

  it('patches --name and --assignee together', async () => {
    const run = await runCli(
      [
        'project',
        'sprint',
        'update',
        SPRINT,
        '--project',
        PROJECT,
        '--name',
        'Sprint 5c',
        '--assignee',
        'wangxiao',
      ],
      [projectsPage, sprintsPage, usersPage, () => jsonResponse(sprintBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ name: 'Sprint 5c', assignee_id: USER });
  });

  it('replaces the category set with --category-id', async () => {
    const run = await runCli(
      [
        'project',
        'sprint',
        'update',
        SPRINT,
        '--project',
        PROJECT,
        '--category-id',
        'cat-1',
      ],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect((run.writes[0]?.body as { category_ids: string[] }).category_ids).toEqual(['cat-1']);
  });

  it('prints a request plan and sends nothing under --dry-run', async () => {
    const run = await runCli(
      [
        'project',
        'sprint',
        'update',
        SPRINT,
        '--project',
        PROJECT,
        '--name',
        'Sprint 5b',
        '--dry-run',
        '--json',
      ],
      [projectsPage, sprintsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'sprint', 'update', SPRINT, '--project', PROJECT, '--name', 'Sprint 5b', '--json'],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { id: string }).id).toBe(SPRINT);
  });
});

// ---------------------------------------------------------------------------
// bulk-create
// ---------------------------------------------------------------------------

describe('project sprint bulk-create', () => {
  it('resolves the shared flags once and stamps every entry', async () => {
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14' },
      { name: 'Sprint 6', start: '2026-09-15', end: '2026-09-28' },
    ]);
    try {
      const run = await runCli(
        [
          'project',
          'sprint',
          'bulk-create',
          '--file',
          file.path,
          '--project',
          'Mobile App',
          '--assignee',
          'wangxiao',
        ],
        [
          projectsPage,
          usersPage,
          () =>
            jsonResponse([
              { state: 'success', sprint: sprintBody() },
              { state: 'success', sprint: sprintBody({ id: 's2', name: 'Sprint 6' }) },
            ]),
        ],
      );

      expect(run.exit).toBe(0);
      const body = run.writes[0]?.body as { sprints: Record<string, unknown>[] };
      expect(body.sprints).toHaveLength(2);
      expect(body.sprints.every((entry) => entry.project_id === PROJECT)).toBe(true);
      expect(body.sprints.every((entry) => entry.assignee_id === USER)).toBe(true);
      // Two name lookups for the whole batch, not two per entry.
      expect(run.calls.filter((call) => call.url.includes('/v1/pjm/projects?'))).toHaveLength(1);
      expect(run.stderr).toContain('cannot be deleted');
    } finally {
      file.cleanup();
    }
  });

  it('renders blank name/status cells for a nameless created sprint (human table)', async () => {
    // printBulk runs SPRINT_COLUMNS only in human mode; a nameless/statusless
    // resource exercises the `?? ''` true-branches of the NAME and STATUS columns.
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', project_id: PROJECT, assignee_id: USER },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path],
        [() => jsonResponse([{ state: 'success', sprint: sprintBody({ name: undefined, status: undefined }) }])],
      );
      expect(run.exit).toBe(0);
      expect(run.stderr).toContain('created 1 sprint');
    } finally {
      file.cleanup();
    }
  });

  it('stamps a per-entry description and status onto the body', async () => {
    const file = withFile([
      {
        name: 'Sprint 5',
        start: '2026-09-01',
        end: '2026-09-14',
        description: 'plan',
        status: 'in_progress',
        project_id: PROJECT,
        assignee_id: USER,
      },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path],
        [() => jsonResponse([{ state: 'success', sprint: sprintBody() }])],
      );
      expect(run.exit).toBe(0);
      const entry = (run.writes[0]?.body as { sprints: Record<string, unknown>[] }).sprints[0];
      expect(entry?.description).toBe('plan');
      expect(entry?.status).toBe('in_progress');
    } finally {
      file.cleanup();
    }
  });

  it('replaces the per-entry category set', async () => {
    const file = withFile([
      {
        name: 'Sprint 5',
        start: '2026-09-01',
        end: '2026-09-14',
        categories: ['cat-1'],
        project_id: PROJECT,
        assignee_id: USER,
      },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path],
        [() => jsonResponse([{ state: 'success', sprint: sprintBody() }])],
      );
      expect(run.exit).toBe(0);
      const entry = (run.writes[0]?.body as { sprints: Record<string, unknown>[] }).sprints[0];
      expect(entry?.category_ids).toEqual(['cat-1']);
    } finally {
      file.cleanup();
    }
  });

  it('resolves a per-entry project name, not just the shared --project', async () => {
    // The entry names its own project, so resolveBulkEntry takes the
    // `entry.project !== undefined` branch and resolves it once.
    const file = withFile([
      {
        name: 'Sprint 5',
        start: '2026-09-01',
        end: '2026-09-14',
        project: 'Mobile App',
        assignee_id: USER,
      },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path],
        [projectsPage, () => jsonResponse([{ state: 'success', sprint: sprintBody() }])],
      );
      expect(run.exit).toBe(0);
      expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
      const entry = (run.writes[0]?.body as { sprints: Record<string, unknown>[] }).sprints[0];
      expect(entry?.project_id).toBe(PROJECT);
    } finally {
      file.cleanup();
    }
  });

  it('passes a per-entry project_id through with no lookup', async () => {
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', project_id: PROJECT, assignee_id: USER },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path],
        [() => jsonResponse([{ state: 'success', sprint: sprintBody() }])],
      );
      expect(run.exit).toBe(0);
      // Ids given directly need no lookup at all.
      expect(run.calls).toHaveLength(1);
    } finally {
      file.cleanup();
    }
  });

  it('refuses a backwards window inside an entry before sending', async () => {
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-14', end: '2026-09-01', project_id: PROJECT, assignee_id: USER },
    ]);
    try {
      const run = await runCli(['project', 'sprint', 'bulk-create', '--file', file.path], []);
      expect(run.exit).toBe(2);
      expect(run.stderr).toContain('entry 0');
      expect(run.calls).toHaveLength(0);
    } finally {
      file.cleanup();
    }
  });

  it('refuses an unknown status inside an entry', async () => {
    const file = withFile([
      {
        name: 'Sprint 5',
        start: '2026-09-01',
        end: '2026-09-14',
        status: 'started',
        project_id: PROJECT,
        assignee_id: USER,
      },
    ]);
    try {
      const run = await runCli(['project', 'sprint', 'bulk-create', '--file', file.path], []);
      expect(run.exit).toBe(2);
      expect(run.stderr).toContain('pending');
      expect(run.calls).toHaveLength(0);
    } finally {
      file.cleanup();
    }
  });

  it('refuses an unknown key, which the API would accept and drop', async () => {
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', descriptoin: 'typo' },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path, '--project', PROJECT],
        [],
      );
      expect(run.exit).toBe(2);
      expect(run.stderr).toContain('descriptoin');
      expect(run.calls).toHaveLength(0);
    } finally {
      file.cleanup();
    }
  });

  it('accepts the wire’s own {"sprints": […]} wrapper', async () => {
    const file = withFile({
      sprints: [
        { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', assignee_id: USER, project_id: PROJECT },
      ],
    });
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path],
        [() => jsonResponse([{ state: 'success', sprint: sprintBody() }])],
      );
      expect(run.exit).toBe(0);
      expect(run.calls).toHaveLength(1);
    } finally {
      file.cleanup();
    }
  });

  it('names the entry that has no project', async () => {
    const file = withFile([{ name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14' }]);
    try {
      const run = await runCli(['project', 'sprint', 'bulk-create', '--file', file.path], []);
      expect(run.exit).toBe(2);
      expect(run.stderr).toContain('entry 0');
    } finally {
      file.cleanup();
    }
  });

  it('refuses an empty array without asking the server', async () => {
    const file = withFile([]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path, '--project', PROJECT],
        [],
      );
      expect(run.exit).toBe(2);
      expect(run.calls).toHaveLength(0);
    } finally {
      file.cleanup();
    }
  });

  it('reports a missing file as a usage error, not a crash', async () => {
    const run = await runCli(
      ['project', 'sprint', 'bulk-create', '--file', '/nonexistent/entries.json', '--project', PROJECT],
      [],
    );
    expect(run.exit).toBe(2);
  });

  it('drops a failed entry from the created count but keeps its state under --json', async () => {
    // printBulk's `result.resource === undefined` branch: a failure row contributes
    // nothing to `created` (human count) yet its `state` survives in the bare array
    // under --json.
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', project_id: PROJECT, assignee_id: USER },
      { name: 'Sprint 6', start: '2026-09-15', end: '2026-09-28', project_id: PROJECT, assignee_id: USER },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path],
        [
          () =>
            jsonResponse([
              { state: 'success', sprint: sprintBody() },
              { state: 'failure', message: 'dup' },
            ]),
        ],
      );
      expect(run.exit).toBe(0);
      expect(run.stderr).toContain('created 1 sprint');
    } finally {
      file.cleanup();
    }
  });

  it('keeps per-entry state on stdout under --json', async () => {
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', project_id: PROJECT, assignee_id: USER },
      { name: 'Sprint 6', start: '2026-09-15', end: '2026-09-28', project_id: PROJECT, assignee_id: USER },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path, '--json'],
        [
          () =>
            jsonResponse([
              { state: 'success', sprint: sprintBody() },
              { state: 'failure', message: 'dup' },
            ]),
        ],
      );
      expect(run.stderr).toBe('');
      const parsed = JSON.parse(run.stdout) as { values: { state: string }[]; count: number };
      expect(parsed.count).toBe(2);
      expect(parsed.values[1]?.state).toBe('failure');
    } finally {
      file.cleanup();
    }
  });

  it('explains the kanban case when the bulk write blames the project', async () => {
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', project_id: PROJECT, assignee_id: USER },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path, '--json'],
        [() => jsonResponse({ code: '100300', message: "'project'资源不存在" }, { status: 400 })],
      );
      expect(run.exit).toBe(7);
      const error = JSON.parse(run.stderr) as { error: { message: string } };
      expect(error.error.message).toContain('scrum/hybrid');
    } finally {
      file.cleanup();
    }
  });

  it('passes a non-kanban bulk error through untouched', async () => {
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', project_id: PROJECT, assignee_id: USER },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk-create', '--file', file.path, '--json'],
        [
          () =>
            jsonResponse(
              { code: '100390', message: "'sprint'资源名称已存在" },
              { status: 400 },
            ),
        ],
      );
      expect(run.exit).toBe(7);
      const error = JSON.parse(run.stderr) as { error: { message: string; kind: string } };
      expect(error.error.kind).toBe('api');
      expect(error.error.message).not.toContain('scrum/hybrid');
    } finally {
      file.cleanup();
    }
  });
});
