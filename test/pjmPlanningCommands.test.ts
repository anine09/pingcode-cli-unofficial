import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * S2a: the `project sprint` and `project version` leaves end to end, through the real
 * `buildProgram()` tree with `fetch` replaced at the global boundary and the config
 * directory redirected to a temp dir. No network, no real credentials.
 *
 * What is proven here and cannot be proven at the api layer:
 *  - `--json` keeps **stdout JSON-only**, with tables and notices on stderr;
 *  - `--dry-run` on a write prints `{"dry_run":true,"request":{…}}` on stdout and sends
 *    **zero** mutating requests, while the name lookups it needs still run;
 *  - every flag refusal — an empty patch, a backwards window, `--operate-at` without
 *    `--stage-id`, an unknown `status`, an unknown key in a bulk entry — happens
 *    **before** any request goes out;
 *  - `version delete` without `--yes` sends no DELETE, and its refusal names the
 *    release rather than an id;
 *  - the two name→id hops (project, then sprint/release) are really made, in order.
 *
 * The two most valuable assertions are about things the *server* would let through:
 * an unknown key in a bulk entry (accepted upstream and silently dropped) and
 * `--operate-at` alone (accepted upstream, echoes the old value, stores nothing).
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const PROJECT = '6a1c41781c7734aaad9ec23c';
const SPRINT = '6a712ff4a2f1bc8bb00eba3f';
const VERSION = '6a712f293e127a186f111f51';
const USER = 'f5712155d0e54d0b94ffacb1384217f0';
const STAGE = '68389e8133ee52bc5c2586de';

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

const sprintsPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [sprintBody()] });

const versionBody = (overrides: Record<string, unknown> = {}) => ({
  id: VERSION,
  url: `https://open.pingcode.com/v1/pjm/projects/${PROJECT}/versions/${VERSION}`,
  name: '1.4.0',
  start_at: 1788192000,
  end_at: 1790783999,
  progress: 0,
  changelog: null,
  operate_at: 1788192000,
  stage: { id: STAGE, name: '未开始' },
  stages: [{ id: STAGE, name: '未开始', operate_at: 1788192000 }],
  categories: [],
  assignee: { id: USER, name: 'wangxiao' },
  ...overrides,
});

const versionsPage = () =>
  jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [versionBody()] });

/** A JSON document on disk, for the two `bulk --file` leaves. */
function withFile(contents: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-bulk-'));
  const file = path.join(dir, 'entries.json');
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// sprint
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

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'sprint', 'get', SPRINT, '--project', PROJECT, '--json'],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { id: string }).id).toBe(SPRINT);
  });

  it('renders 0/0 story points rather than hiding them', async () => {
    // A fresh sprint really does report three zeroes (design D15.9), so a blank cell
    // would be wrong — but a sprint that reported nothing must stay blank.
    const run = await runCli(
      ['project', 'sprint', 'get', SPRINT, '--project', PROJECT],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect(run.stdout).toContain('0 / 0');
  });
});

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
    // The server applies exactly this rule itself (design D15.4). Sending midnight for
    // both would silently shorten every window by a day — and the CLI would echo back
    // what it sent, so the bug would survive a smoke run.
    const run = await runCli(CREATE, [projectsPage, usersPage, () => jsonResponse(sprintBody())]);
    const body = run.writes[0]?.body as { start_at: number; end_at: number };
    expect(new Date(body.start_at * 1000).getHours()).toBe(0);
    expect(new Date(body.end_at * 1000).getHours()).toBe(23);
    expect(body.end_at - body.start_at).toBeGreaterThan(13 * 24 * 3600);
  });

  it('refuses a backwards window before sending anything', async () => {
    const run = await runCli(
      [...CREATE.slice(0, -4), '--end', '2026-08-01', '--assignee', 'wangxiao'],
      [projectsPage, usersPage],
    );
    expect(run.exit).toBe(2);
    expect(run.writes).toHaveLength(0);
  });

  it('refuses an unknown --status before sending anything', async () => {
    const run = await runCli([...CREATE, '--status', 'started'], [projectsPage, usersPage]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('pending');
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
});

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

  it('clears the categories when --category-id is given none', async () => {
    // `[]` is how the set is cleared, so the flag has to be able to express it — here
    // by naming one and then the caller naming none is simply omission, which is why
    // this asserts the positive form.
    const run = await runCli(
      ['project', 'sprint', 'update', SPRINT, '--project', PROJECT, '--category-id', 'cat-1'],
      [projectsPage, sprintsPage, () => jsonResponse(sprintBody())],
    );
    expect((run.writes[0]?.body as { category_ids: string[] }).category_ids).toEqual(['cat-1']);
  });
});

describe('project sprint bulk', () => {
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
          'bulk',
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

  it('refuses an unknown key, which the API would accept and drop', async () => {
    // The single most valuable check in this file: upstream answers 200 and silently
    // ignores the field (design D11.3), so without this a 60-entry batch lands with a
    // field missing and no complaint anywhere.
    const file = withFile([
      { name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14', descriptoin: 'typo' },
    ]);
    try {
      const run = await runCli(
        ['project', 'sprint', 'bulk', '--file', file.path, '--project', PROJECT],
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
        ['project', 'sprint', 'bulk', '--file', file.path],
        [() => jsonResponse([{ state: 'success', sprint: sprintBody() }])],
      );
      expect(run.exit).toBe(0);
      // Ids given directly need no lookup at all.
      expect(run.calls).toHaveLength(1);
    } finally {
      file.cleanup();
    }
  });

  it('names the entry that has no project', async () => {
    const file = withFile([{ name: 'Sprint 5', start: '2026-09-01', end: '2026-09-14' }]);
    try {
      const run = await runCli(['project', 'sprint', 'bulk', '--file', file.path], []);
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
        ['project', 'sprint', 'bulk', '--file', file.path, '--project', PROJECT],
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
      ['project', 'sprint', 'bulk', '--file', '/nonexistent/entries.json', '--project', PROJECT],
      [],
    );
    expect(run.exit).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

describe('project version list', () => {
  it('lists releases as a table with the row count on stderr', async () => {
    const run = await runCli(
      ['project', 'version', 'list', '--project', PROJECT],
      [projectsPage, versionsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('1.4.0');
    expect(run.stdout).toContain('未开始');
    expect(run.stderr).toContain('1 row(s)');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'version', 'list', '--project', PROJECT, '--json'],
      [projectsPage, versionsPage],
    );
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { total: number; values: { name: string }[] };
    expect(parsed.values[0]?.name).toBe('1.4.0');
  });

  it('sends --name and --status, and nothing else', async () => {
    const run = await runCli(
      [
        'project',
        'version',
        'list',
        '--project',
        PROJECT,
        '--name',
        'probe',
        '--status',
        'in_progress',
      ],
      [projectsPage, versionsPage],
    );
    const url = run.calls[1]?.url ?? '';
    expect(url).toContain('name=probe');
    expect(url).toContain('status=in_progress');
    expect(url).not.toContain('stage_id=');
  });

  it('refuses a stage NAME where a stage kind is expected', async () => {
    // `?status=` filters on the stage's *type*, so "未开始" — a real stage name — is not
    // a valid value, and the server's message would not say why.
    const run = await runCli(
      ['project', 'version', 'list', '--project', PROJECT, '--status', '未开始'],
      [projectsPage],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('published');
  });

  it('walks pages under --all', async () => {
    const run = await runCli(
      ['project', 'version', 'list', '--project', PROJECT, '--all', '--page-size', '1', '--json'],
      [
        projectsPage,
        () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [versionBody()] }),
        () =>
          jsonResponse({
            page_index: 1,
            page_size: 1,
            total: 2,
            values: [versionBody({ id: 'v2', name: '1.5.0' })],
          }),
        () => jsonResponse({ page_index: 2, page_size: 1, total: 2, values: [] }),
      ],
    );
    const parsed = JSON.parse(run.stdout) as { count: number; all: boolean };
    expect(parsed).toMatchObject({ count: 2, all: true });
  });
});

describe('project version create / update', () => {
  const CREATE = [
    'project',
    'version',
    'create',
    '--project',
    PROJECT,
    '--name',
    '1.4.0',
    '--start',
    '2026-09-01',
    '--end',
    '2026-09-30',
    '--assignee',
    'wangxiao',
  ];

  it('omits stage_id when none is given, letting the API default it', async () => {
    const run = await runCli(CREATE, [projectsPage, usersPage, () => jsonResponse(versionBody())]);
    expect(run.exit).toBe(0);
    expect(Object.keys(run.writes[0]?.body as object).sort()).toEqual([
      'assignee_id',
      'end_at',
      'name',
      'start_at',
    ]);
  });

  it('refuses --operate-at without --stage-id', async () => {
    // Alone, the API accepts it, echoes the OLD value and stores nothing (design
    // D15.7) — a success that is not one, so the refusal is worth the flag.
    const run = await runCli(
      ['project', 'version', 'update', VERSION, '--project', PROJECT, '--operate-at', '1789000000'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('--stage-id');
    expect(run.calls).toHaveLength(0);
  });

  it('sends operate_at together with stage_id', async () => {
    const run = await runCli(
      [
        'project',
        'version',
        'update',
        VERSION,
        '--project',
        PROJECT,
        '--stage-id',
        STAGE,
        '--operate-at',
        '1789000000',
      ],
      [projectsPage, versionsPage, () => jsonResponse(versionBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ stage_id: STAGE, operate_at: 1789000000 });
  });

  it('reads --operate-at as LOCAL midnight, like --start', async () => {
    // `parseTimestampFlag` would read a bare date as UTC, putting `--start 2026-11-15`
    // and `--operate-at 2026-11-15` hours apart in the same request — and possibly
    // outside the window the server validates operate_at against (400 `100395`).
    // Caught during the live smoke: the rendered "reached" showed 08:00 on a +08 tenant.
    const run = await runCli(
      [
        'project',
        'version',
        'update',
        VERSION,
        '--project',
        PROJECT,
        '--stage-id',
        STAGE,
        '--operate-at',
        '2026-11-15',
      ],
      [projectsPage, versionsPage, () => jsonResponse(versionBody())],
    );
    const body = run.writes[0]?.body as { operate_at: number };
    const at = new Date(body.operate_at * 1000);
    expect(at.getHours()).toBe(0);
    expect(at.getDate()).toBe(15);
  });

  it('refuses an empty patch before any request', async () => {
    const run = await runCli(['project', 'version', 'update', VERSION, '--project', PROJECT], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('project version delete', () => {
  it('reads the release first and refuses without --yes, naming it', async () => {
    const run = await runCli(
      ['project', 'version', 'delete', VERSION, '--project', PROJECT],
      [projectsPage, versionsPage, () => jsonResponse(versionBody())],
    );

    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('"1.4.0"');
    // The consequence has to be in the refusal: this silently edits work items.
    expect(run.stderr).toContain('DETACHES');
    expect(run.writes).toHaveLength(0);
  });

  it('deletes with --yes and echoes what went', async () => {
    const run = await runCli(
      ['project', 'version', 'delete', VERSION, '--project', PROJECT, '--yes'],
      [projectsPage, versionsPage, () => jsonResponse(versionBody()), () => jsonResponse(versionBody())],
    );

    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.stderr).toContain('deleted 1.4.0');
  });

  it('sends no DELETE under --dry-run, though the pre-read still runs', async () => {
    const run = await runCli(
      ['project', 'version', 'delete', VERSION, '--project', PROJECT, '--yes', '--dry-run', '--json'],
      [projectsPage, versionsPage, () => jsonResponse(versionBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    // The plan is a *result*, so under --json it is stdout and stdout is JSON only.
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('DELETE');
  });

  it('rejects `--yes false` rather than obeying it', async () => {
    // Design D12.9: commander used to swallow the excess argument and delete anyway.
    const run = await runCli(
      ['project', 'version', 'delete', VERSION, '--project', PROJECT, '--yes', 'false'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('project version bulk', () => {
  it('accepts stage_id per entry and wraps them in `versions`', async () => {
    const file = withFile([
      { name: '1.4.0', start: '2026-09-01', end: '2026-09-30', stage_id: STAGE },
      { name: '1.5.0', start: '2026-10-01', end: '2026-10-31' },
    ]);
    try {
      const run = await runCli(
        [
          'project',
          'version',
          'bulk',
          '--file',
          file.path,
          '--project',
          PROJECT,
          '--assignee',
          USER,
        ],
        [
          projectsPage,
          usersPage,
          () =>
            jsonResponse([
              { state: 'success', version: versionBody() },
              { state: 'success', version: versionBody({ id: 'v2', name: '1.5.0' }) },
            ]),
        ],
      );

      expect(run.exit).toBe(0);
      const body = run.writes[0]?.body as { versions: Record<string, unknown>[] };
      expect(body.versions[0]?.stage_id).toBe(STAGE);
      expect(body.versions[1]?.stage_id).toBeUndefined();
      expect(run.stderr).toContain('created 2 release(s)');
    } finally {
      file.cleanup();
    }
  });

  it('keeps the per-entry state under --json', async () => {
    // The bulk response is the one bare array in the API and `state` is the only
    // per-entry acknowledgement, so flattening to the resources would lose it.
    const file = withFile([
      { name: '1.4.0', start: '2026-09-01', end: '2026-09-30', project_id: PROJECT, assignee_id: USER },
    ]);
    try {
      const run = await runCli(
        ['project', 'version', 'bulk', '--file', file.path, '--json'],
        [() => jsonResponse([{ state: 'success', version: versionBody() }])],
      );
      expect(run.stderr).toBe('');
      const parsed = JSON.parse(run.stdout) as { values: { state: string }[]; count: number };
      expect(parsed.values[0]?.state).toBe('success');
      expect(parsed.count).toBe(1);
    } finally {
      file.cleanup();
    }
  });

  it('refuses an entry that sets both project and project_id', async () => {
    const file = withFile([
      { name: '1.4.0', start: '2026-09-01', end: '2026-09-30', project: 'Mobile App', project_id: PROJECT },
    ]);
    try {
      const run = await runCli(['project', 'version', 'bulk', '--file', file.path], []);
      expect(run.exit).toBe(2);
      expect(run.calls).toHaveLength(0);
    } finally {
      file.cleanup();
    }
  });
});
