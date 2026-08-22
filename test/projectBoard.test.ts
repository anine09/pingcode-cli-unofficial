import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * `project board …` — the read-only 看板 leaves (boards, entries, swimlanes),
 * end to end through the real `buildProgram()` tree with `fetch` replaced at the
 * global boundary and the config directory redirected to a temp dir. No network,
 * no real credentials.
 *
 * All three are GET-only (catalog `pjm.projects.boards.*`): there is no
 * create/update/delete and therefore no `--dry-run` gate to assert. The value
 * here is in the things the server would let through silently:
 *  - the two name→id hops (project, then board) really happen, in order;
 *  - the board-scoped children (entries, swimlanes) carry the **resolved** board
 *    id in the path, not the raw `--board` spelling;
 *  - `--board <name>` resolves against the project's board list, and an unknown
 *    or ambiguous name is refused **before** the children are requested;
 *  - `--json` keeps stdout JSON-only, with tables and notices on stderr.
 *
 * Response builders take **no arguments**: the harness feeds each one through
 * the fake fetch, which invokes it as `handler(call, index)`. A parameterised
 * builder would silently bind its first parameter to the `FakeCall` and corrupt
 * the body — variants are written as separate no-arg arrows instead.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const PROJECT = '6a1c41781c7734aaad9ec23c';
const BOARD = '6a712ff4a2f1bc8bb00eba3f';
const OTHER_BOARD = '6a723456a2f1bc8bb00eba3aa';
const ENTRY = '6a8b1234c5d6e7f8a9b0c1d2';
const SWIMLANE = '6a9c2345d6e7f8a9b0c1d2e3';

/** `GET /v1/pjm/projects?` — one project, by name (research §4 has no exact-name filter). */
const projectsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: PROJECT, name: 'Mobile App', identifier: 'MOB', type: 'scrum' }],
  });

/** `GET /v1/pjm/projects/{project_id}/boards` — the boards of one project. */
const boardsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: BOARD, name: 'Main Board', project: { id: PROJECT, name: 'Mobile App' } }],
  });

/** A project with no boards at all. */
const emptyBoardsPage = () => jsonResponse({ page_index: 0, page_size: 100, total: 0, values: [] });

/** Two boards that share a name — to trigger the ambiguity refusal. */
const ambiguousBoardsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: BOARD, name: 'Board', project: { id: PROJECT, name: 'Mobile App' } },
      { id: OTHER_BOARD, name: 'Board', project: { id: PROJECT, name: 'Mobile App' } },
    ],
  });

/** `GET /v1/pjm/projects/{project_id}/boards/{board_id}/entries` — columns of one board. */
const entriesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: ENTRY, name: 'To Do', board: { id: BOARD, name: 'Main Board' } }],
  });

/** `GET /v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes` — swimlanes of one board. */
const swimlanesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: SWIMLANE, name: 'Lane 1', board: { id: BOARD, name: 'Main Board' } }],
  });

// ---------------------------------------------------------------------------
// board list
// ---------------------------------------------------------------------------

describe('project board list', () => {
  it('resolves the project then lists its boards', async () => {
    const run = await runCli(['project', 'board', 'list', '--project', 'Mobile App'], [
      projectsPage,
      boardsPage,
    ]);

    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/boards`);
    expect(run.stdout).toContain('Main Board');
  });

  it('accepts the project id directly and still lists its boards', async () => {
    // An exact-id match short-circuits the name lookup, but the list is still
    // loaded (boards are a bounded set, never passed through), so both requests run.
    const run = await runCli(['project', 'board', 'list', '--project', PROJECT], [
      projectsPage,
      boardsPage,
    ]);

    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/boards`);
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(['project', 'board', 'list', '--project', 'Mobile App', '--json'], [
      projectsPage,
      boardsPage,
    ]);

    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { name: string }[]; count: number };
    expect(parsed.count).toBe(1);
    expect(parsed.values[0]?.name).toBe('Main Board');
  });

  it('renders an empty board list as count 0 under --json', async () => {
    const run = await runCli(['project', 'board', 'list', '--project', 'Mobile App', '--json'], [
      projectsPage,
      emptyBoardsPage,
    ]);

    expect(run.exit).toBe(0);
    const parsed = JSON.parse(run.stdout) as { values: unknown[]; count: number };
    expect(parsed.count).toBe(0);
    expect(parsed.values).toEqual([]);
  });

  it('refuses an unknown project name before listing boards', async () => {
    const run = await runCli(['project', 'board', 'list', '--project', 'Nope'], [projectsPage]);

    expect(run.exit).toBe(2);
    // Only the project lookup ran — no boards request.
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('no project matches');
  });

  it('refuses an empty --project before any request', async () => {
    const run = await runCli(['project', 'board', 'list', '--project', '   '], []);

    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('refuses a missing --project with no request', async () => {
    const run = await runCli(['project', 'board', 'list'], []);

    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// board entries
// ---------------------------------------------------------------------------

describe('project board entries', () => {
  it('resolves project then board, then lists the board entries', async () => {
    const run = await runCli(
      ['project', 'board', 'entries', '--project', 'Mobile App', '--board', 'Main Board'],
      [projectsPage, boardsPage, entriesPage],
    );

    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/boards`);
    // The resolved board id rides in the path, not the raw --board spelling.
    expect(run.calls[2]?.url).toContain(`/v1/pjm/projects/${PROJECT}/boards/${BOARD}/entries`);
    expect(run.stdout).toContain('To Do');
  });

  it('accepts the board id directly and addresses its entries', async () => {
    const run = await runCli(
      ['project', 'board', 'entries', '--project', 'Mobile App', '--board', BOARD],
      [projectsPage, boardsPage, entriesPage],
    );

    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(run.calls[2]?.url).toContain(`/v1/pjm/projects/${PROJECT}/boards/${BOARD}/entries`);
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      ['project', 'board', 'entries', '--project', 'Mobile App', '--board', 'Main Board', '--json'],
      [projectsPage, boardsPage, entriesPage],
    );

    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { name: string }[]; count: number };
    expect(parsed.count).toBe(1);
    expect(parsed.values[0]?.name).toBe('To Do');
  });

  it('refuses an unknown board name before requesting entries', async () => {
    const run = await runCli(
      ['project', 'board', 'entries', '--project', 'Mobile App', '--board', 'Nope'],
      [projectsPage, boardsPage],
    );

    expect(run.exit).toBe(2);
    // Project + board lookup ran; the entries request did not.
    expect(run.calls).toHaveLength(2);
    expect(run.stderr).toContain('no board matches');
    expect(run.stderr).toContain('Main Board');
  });

  it('refuses an ambiguous board name and lists the candidates', async () => {
    const run = await runCli(
      ['project', 'board', 'entries', '--project', 'Mobile App', '--board', 'Board'],
      [projectsPage, ambiguousBoardsPage],
    );

    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(2);
    expect(run.stderr).toContain('matches 2 boards');
  });

  it('refuses an empty --board after resolving the project', async () => {
    const run = await runCli(
      ['project', 'board', 'entries', '--project', 'Mobile App', '--board', ''],
      [projectsPage],
    );

    expect(run.exit).toBe(2);
    // The project resolved, then --board was rejected as empty.
    expect(run.calls).toHaveLength(1);
    expect(run.stderr).toContain('--board is required');
  });

  it('refuses a missing --board with no request', async () => {
    const run = await runCli(['project', 'board', 'entries', '--project', 'Mobile App'], []);

    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// board swimlanes
// ---------------------------------------------------------------------------

describe('project board swimlanes', () => {
  it('resolves project then board, then lists the board swimlanes', async () => {
    const run = await runCli(
      ['project', 'board', 'swimlanes', '--project', 'Mobile App', '--board', 'Main Board'],
      [projectsPage, boardsPage, swimlanesPage],
    );

    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    expect(run.calls[0]?.url).toContain('/v1/pjm/projects?');
    expect(run.calls[1]?.url).toContain(`/v1/pjm/projects/${PROJECT}/boards`);
    expect(run.calls[2]?.url).toContain(
      `/v1/pjm/projects/${PROJECT}/boards/${BOARD}/swimlanes`,
    );
    expect(run.stdout).toContain('Lane 1');
  });

  it('accepts the board id directly and addresses its swimlanes', async () => {
    const run = await runCli(
      ['project', 'board', 'swimlanes', '--project', 'Mobile App', '--board', BOARD],
      [projectsPage, boardsPage, swimlanesPage],
    );

    expect(run.exit).toBe(0);
    expect(run.calls[2]?.url).toContain(`/v1/pjm/projects/${PROJECT}/boards/${BOARD}/swimlanes`);
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(
      [
        'project',
        'board',
        'swimlanes',
        '--project',
        'Mobile App',
        '--board',
        'Main Board',
        '--json',
      ],
      [projectsPage, boardsPage, swimlanesPage],
    );

    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { values: { name: string }[]; count: number };
    expect(parsed.count).toBe(1);
    expect(parsed.values[0]?.name).toBe('Lane 1');
  });

  it('refuses an unknown board name before requesting swimlanes', async () => {
    const run = await runCli(
      ['project', 'board', 'swimlanes', '--project', 'Mobile App', '--board', 'Nope'],
      [projectsPage, boardsPage],
    );

    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(2);
    expect(run.stderr).toContain('no board matches');
  });

  it('refuses a missing --board with no request', async () => {
    const run = await runCli(['project', 'board', 'swimlanes', '--project', 'Mobile App'], []);

    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});
