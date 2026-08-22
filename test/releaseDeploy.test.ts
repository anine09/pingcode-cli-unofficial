import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * Targeted tests for `src/cli/commands/release/deploy.ts` branches that the
 * existing `releaseCommands.test.ts` does not reach.
 *
 * Coverage gap before this file (2026-08-22):
 *   Stmts 94.89 % ｜ Branch 77.19 % ｜ Funcs 100 % ｜ Lines 94.89 %
 *
 * Uncovered:
 *   - `runList` with `--all` (paging.all true → collect + printCollection)
 *   - `printDeploy` in **human mode** (non-JSON) with `verb` (created / updated)
 *   - `printDeploy` `??` fallbacks when the deploy lacks `status`, `url`, etc.
 *   - `runCreate` / `runUpdate` with `--release-url` (the false branch of
 *     `flags.releaseUrl === undefined`)
 *   - `runUpdate` with `--work-item` (the false branch of `identifiers === undefined`)
 *   - `runUpdate` under `--dry-run`
 *
 * Every test runs through the real `buildProgram()` tree with an injected fake
 * fetch (zero network). Response builders mirror `releaseCommands.test.ts`.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const ENVIRONMENT = '6a70c08d919cce9794f01ac6';
const DEPLOY = '6a70c153919cce9794f01aca';
const WORK_ITEM = '6a221c5d22cc7d25d68cafdb';

// ---------------------------------------------------------------------------
// response builders (mirrored from releaseCommands.test.ts)
// ---------------------------------------------------------------------------

const environmentBody = (overrides: Record<string, unknown> = {}) => ({
  id: ENVIRONMENT,
  url: `https://open.pingcode.com/v1/release/environments/${ENVIRONMENT}`,
  name: 'cli-smoke-prod',
  html_url: null,
  ...overrides,
});

const environmentsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 1,
    values: [environmentBody()],
  });

const deployBody = (overrides: Record<string, unknown> = {}) => ({
  id: DEPLOY,
  url: `https://open.pingcode.com/v1/release/deploys/${DEPLOY}`,
  status: 'deployed',
  release_name: 'cli-smoke 1.0.0',
  environment: { id: ENVIRONMENT, name: 'cli-smoke-prod' },
  release_url: null,
  start_at: 1785700000,
  end_at: 1785700200,
  duration: 200,
  work_items: [],
  ...overrides,
});

const oneDeploy = () => jsonResponse(deployBody());

/** The five required create flags (the environment is separate). */
const CREATE_DEPLOY_ARGS = [
  '--status', 'deployed',
  '--release-name', 'cli-smoke 1.0.0',
  '--start-at', '1785700000',
  '--end-at', '1785700200',
  '--duration', '200',
];

// ---------------------------------------------------------------------------
// list --all  (covers paging.all true, printCollection, ?? fallbacks in columns)
// ---------------------------------------------------------------------------

describe('release deploy list --all', () => {
  it('walks every page with --all in human mode, rendering missing fields as empty', async () => {
    const run = await runCli(
      ['release', 'deploy', 'list', '--all', '--page-size', '1'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 1,
            total: 1,
            values: [deployBody({ status: undefined, duration: undefined })],
          }),
        () =>
          jsonResponse({
            page_index: 1,
            page_size: 1,
            total: 1,
            values: [],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    // Two pages fetched, one row collected.
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]?.url).toContain('/v1/release/deploys');
    expect(run.calls[1]?.url).toContain('page_index=1');
    // Human mode prints the row count on stderr.
    expect(run.stderr).toContain('1 row(s)');
  });

  it('walks every page with --all --json and reports the collected count', async () => {
    const run = await runCli(
      ['release', 'deploy', 'list', '--all', '--page-size', '1', '--json'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 1,
            total: 2,
            values: [deployBody()],
          }),
        () =>
          jsonResponse({
            page_index: 1,
            page_size: 1,
            total: 2,
            values: [deployBody({ id: 'd2', release_name: 'cli-smoke 1.0.1' })],
          }),
        () =>
          jsonResponse({
            page_index: 2,
            page_size: 1,
            total: 2,
            values: [],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(3);
    const result = JSON.parse(run.stdout) as { values: unknown[]; count: number; all: boolean };
    expect(result.all).toBe(true);
    expect(result.count).toBe(2);
    expect(result.values).toHaveLength(2);
    // --json keeps stderr empty.
    expect(run.stderr).toBe('');
  });

  it('respects --limit when walking pages', async () => {
    const run = await runCli(
      ['release', 'deploy', 'list', '--all', '--limit', '1', '--json'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 30,
            total: 5,
            values: [deployBody(), deployBody({ id: 'd2' }), deployBody({ id: 'd3' })],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    const result = JSON.parse(run.stdout) as { values: unknown[]; count: number };
    expect(result.count).toBe(1);
    expect(result.values).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// list in human mode (non-JSON) — covers printPage + column ?? fallbacks
// ---------------------------------------------------------------------------

describe('release deploy list (human mode)', () => {
  it('renders a table with the row count on stderr', async () => {
    const run = await runCli(
      ['release', 'deploy', 'list'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 30,
            total: 2,
            values: [deployBody(), deployBody({ id: 'd2', release_name: 'cli-smoke 1.0.1' })],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('cli-smoke 1.0.0');
    expect(run.stdout).toContain('cli-smoke-prod');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('renders missing status and duration as empty cells', async () => {
    // Deploys without `status` or `duration` exercise the `?? ''` and
    // `duration === undefined ? '' : …` fallbacks in DEPLOY_COLUMNS.
    const run = await runCli(
      ['release', 'deploy', 'list'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 30,
            total: 1,
            values: [{ id: DEPLOY, release_name: 'bare', work_items: [] }],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('bare');
  });
});

// ---------------------------------------------------------------------------
// get in human mode — covers printDeploy ?? fallbacks, || fallback, && branch
// ---------------------------------------------------------------------------

describe('release deploy get (human mode, minimal deploy)', () => {
  it('renders a deploy with only an id, covering every ?? fallback', async () => {
    // A deploy with only `id` triggers every `?? ''` and `durationCell(undefined)`
    // in printDeploy, plus the `oneLine(undefined) || deploy.id` fallback.
    const run = await runCli(
      ['release', 'deploy', 'get', DEPLOY],
      [() => jsonResponse({ id: DEPLOY })],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain(DEPLOY);
    // No "created"/"updated" line — verb is undefined for get.
  });

  it('renders a deploy with a release_name but no environment, covering the || and refName fallbacks', async () => {
    const run = await runCli(
      ['release', 'deploy', 'get', DEPLOY],
      [() => jsonResponse({ id: DEPLOY, status: 'deployed', release_name: '1.0.0' })],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('1.0.0');
    expect(run.stdout).toContain(DEPLOY);
  });
});

// ---------------------------------------------------------------------------
// create with --release-url in human mode
// ---------------------------------------------------------------------------

describe('release deploy create (--release-url, human mode)', () => {
  it('sends release_url in the body and prints the created message to stderr', async () => {
    const run = await runCli(
      [
        'release', 'deploy', 'create',
        '--env-id', ENVIRONMENT,
        ...CREATE_DEPLOY_ARGS,
        '--release-url', 'https://example.invalid/r',
      ],
      [oneDeploy],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toMatchObject({ release_url: 'https://example.invalid/r' });
    // Human mode: "created" message goes to stderr.
    expect(run.stderr).toContain('created');
    expect(run.stderr).toContain('cli-smoke 1.0.0');
    expect(run.stderr).toContain('cli-smoke-prod');
  });

  it('falls back to the deploy id when release_name and environment are absent', async () => {
    // Exercises the `oneLine(undefined) || deploy.id` and `refName(undefined) === ''`
    // branches in printDeploy's verb block.
    const run = await runCli(
      [
        'release', 'deploy', 'create',
        '--env-id', ENVIRONMENT,
        ...CREATE_DEPLOY_ARGS,
      ],
      [() => jsonResponse({ id: DEPLOY, status: 'deployed' })],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.stderr).toContain('created');
    // The label falls back to the id when release_name is absent.
    expect(run.stderr).toContain(DEPLOY);
  });

  it('sends release_url and work_item_identifiers together', async () => {
    const run = await runCli(
      [
        'release', 'deploy', 'create',
        '--env-id', ENVIRONMENT,
        ...CREATE_DEPLOY_ARGS,
        '--release-url', 'https://example.invalid/r',
        '--work-item', 'YYHC-10',
        '--json',
      ],
      [
        () =>
          jsonResponse(
            deployBody({
              release_url: 'https://example.invalid/r',
              work_items: [{ id: WORK_ITEM, identifier: 'YYHC-10' }],
            }),
          ),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toMatchObject({
      release_url: 'https://example.invalid/r',
      work_item_identifiers: ['YYHC-10'],
    });
    expect(run.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// update with --release-url and --work-item in human mode
// ---------------------------------------------------------------------------

describe('release deploy update (--release-url, --work-item, human mode)', () => {
  it('sends release_url and work_item_identifiers, and prints the updated message', async () => {
    const run = await runCli(
      [
        'release', 'deploy', 'update', DEPLOY,
        '--release-url', 'https://example.invalid/r2',
        '--work-item', 'YYHC-10',
      ],
      [() => jsonResponse(deployBody({ work_items: [{ id: WORK_ITEM, identifier: 'YYHC-10' }] }))],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.body).toEqual({
      release_url: 'https://example.invalid/r2',
      work_item_identifiers: ['YYHC-10'],
    });
    // Human mode: "updated" message goes to stderr.
    expect(run.stderr).toContain('updated');
    expect(run.stderr).toContain('cli-smoke-prod');
  });

  it('sends work_item_identifiers alone in the patch', async () => {
    const run = await runCli(
      [
        'release', 'deploy', 'update', DEPLOY,
        '--work-item', 'PLM-001',
        '--work-item', 'PLM-002',
        '--json',
      ],
      [
        () =>
          jsonResponse(
            deployBody({
              work_items: [
                { id: 'w1', identifier: 'PLM-001' },
                { id: 'w2', identifier: 'PLM-002' },
              ],
            }),
          ),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ work_item_identifiers: ['PLM-001', 'PLM-002'] });
    expect(run.stderr).toBe('');
  });

  it('warns on unlinked work items during update, exit stays 0', async () => {
    const run = await runCli(
      [
        'release', 'deploy', 'update', DEPLOY,
        '--work-item', 'NOSUCH-99999',
        '--json',
      ],
      [() => jsonResponse(deployBody({ work_items: [] }))],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('NOSUCH-99999');
  });
});

// ---------------------------------------------------------------------------
// update --dry-run
// ---------------------------------------------------------------------------

describe('release deploy update --dry-run', () => {
  it('prints the plan and sends nothing', async () => {
    const run = await runCli(
      ['release', 'deploy', 'update', DEPLOY, '--status', 'not_deployed', '--dry-run', '--json'],
      [],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(run.calls).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('PATCH');
  });

  it('prints the plan in human mode too', async () => {
    const run = await runCli(
      ['release', 'deploy', 'update', DEPLOY, '--status', 'not_deployed', '--dry-run'],
      [],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// list with --env resolution in human mode
// ---------------------------------------------------------------------------

describe('release deploy list --env (human mode)', () => {
  it('resolves --env to an id and renders the table', async () => {
    const run = await runCli(
      ['release', 'deploy', 'list', '--env', 'cli-smoke-prod'],
      [environmentsPage, () => jsonResponse({
        page_index: 0,
        page_size: 30,
        total: 1,
        values: [deployBody()],
      })],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`env_id=${ENVIRONMENT}`);
    expect(run.stdout).toContain('cli-smoke 1.0.0');
  });
});
