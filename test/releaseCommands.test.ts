import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * S1d: the `release` command group end to end, through the real `buildProgram()` tree
 * with `fetch` replaced at the global boundary and the config directory redirected to a
 * temp dir. No network, no real credentials.
 *
 * What is proven here and cannot be proven at the api layer:
 *  - `--env <name>` really resolves through `core/metadata` before the write, so the
 *    `env_id` that reaches the body came from the environment list rather than from the
 *    user, and `--env` with `--env-id` is refused before anything is sent;
 *  - `--json` keeps **stdout JSON-only**, `--dry-run` sends zero mutating requests;
 *  - an empty patch is exit 2 on both `update` leaves — and on the deploy's, `--env`
 *    alone counts as a patch, because moving a deploy between environments is a real
 *    update;
 *  - the silently-dropped `--work-item` link warns on stderr while the exit code stays 0.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const ENVIRONMENT = '6a70c08d919cce9794f01ac6';
const OTHER_ENVIRONMENT = '6a70c08d919cce9794f01ac4';
const DEPLOY = '6a70c153919cce9794f01aca';
const WORK_ITEM = '6a221c5d22cc7d25d68cafdb';

const environmentBody = (overrides: Record<string, unknown> = {}) => ({
  id: ENVIRONMENT,
  url: `https://open.pingcode.com/v1/release/environments/${ENVIRONMENT}`,
  name: 'cli-smoke-prod',
  html_url: null,
  ...overrides,
});

const oneEnvironment = () => jsonResponse(environmentBody());

const environmentsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 2,
    values: [
      environmentBody({ id: OTHER_ENVIRONMENT, name: 'cli-smoke-staging' }),
      environmentBody(),
    ],
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

const deploysPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 2,
    values: [deployBody(), deployBody({ id: 'd2', release_name: 'cli-smoke 1.0.1' })],
  });

/** The five required create flags of a deploy, as argv (the environment is separate). */
const CREATE_DEPLOY_ARGS = [
  '--status',
  'deployed',
  '--release-name',
  'cli-smoke 1.0.0',
  '--start-at',
  '1785700000',
  '--end-at',
  '1785700200',
  '--duration',
  '200',
];

describe('release env', () => {
  it('lists environments as a table, with the row count on stderr', async () => {
    const run = await runCli(['release', 'env', 'list'], [environmentsPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('cli-smoke-prod');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('sends no ?name= by default, though the docs call it required', async () => {
    // The whole point of the catalog correction: an unfiltered list is legal (live
    // 2026-08-04) and is what this command does unless asked otherwise.
    const run = await runCli(['release', 'env', 'list', '--json'], [environmentsPage]);
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url ?? '').not.toContain('name=');
    expect(run.stderr).toBe('');
  });

  it('passes --name through as an exact filter when asked', async () => {
    const run = await runCli(
      ['release', 'env', 'list', '--name', 'cli-smoke-prod', '--json'],
      [environmentsPage],
    );
    expect(run.calls[0]?.url).toContain('name=cli-smoke-prod');
  });

  it('resolves a name to an id before the GET', async () => {
    const run = await runCli(
      ['release', 'env', 'get', 'cli-smoke-prod', '--json'],
      [environmentsPage, oneEnvironment],
    );
    expect(run.exit).toBe(0);
    // First call is the candidate list, second the resolved resource.
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`/v1/release/environments/${ENVIRONMENT}`);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: ENVIRONMENT });
  });

  it('reports an unknown name as exit 2, listing the real candidates', async () => {
    const run = await runCli(['release', 'env', 'get', 'production'], [environmentsPage]);
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('cli-smoke-prod');
    expect(run.stderr).toContain('cli-smoke-staging');
  });

  it('creates an environment from a name alone', async () => {
    const run = await runCli(
      ['release', 'env', 'create', '--name', 'cli-smoke-prod', '--json'],
      [oneEnvironment],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toEqual({ name: 'cli-smoke-prod' });
  });

  it('prints the request plan and sends nothing on a dry-run create', async () => {
    const run = await runCli(
      ['release', 'env', 'create', '--name', 'cli-smoke-prod', '--dry-run', '--json'],
      [oneEnvironment],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ dry_run: true });
  });

  it('refuses an empty patch before sending anything', async () => {
    const run = await runCli(['release', 'env', 'update', ENVIRONMENT]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('resolves the reference then patches only what it was given', async () => {
    const run = await runCli(
      ['release', 'env', 'update', 'cli-smoke-prod', '--html-url', 'https://example.invalid/p', '--json'],
      [environmentsPage, () => jsonResponse(environmentBody({ html_url: 'https://example.invalid/p' }))],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.url).toContain(`/v1/release/environments/${ENVIRONMENT}`);
    expect(run.writes[0]?.body).toEqual({ html_url: 'https://example.invalid/p' });
  });

  it('surfaces a duplicate name as exit 7, not as a not-found', async () => {
    const run = await runCli(
      ['release', 'env', 'create', '--name', 'cli-smoke-prod', '--json'],
      [() => jsonResponse({ code: '100105', message: "'cli-smoke-prod'环境已经存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(7);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'api', code: '100105' } });
  });

  it('exits 5 when the environment does not exist (HTTP 400 + 100205)', async () => {
    const run = await runCli(
      ['release', 'env', 'get', ENVIRONMENT, '--json'],
      [() => jsonResponse({ code: '100205', message: "'environment'资源不存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.stderr)).toMatchObject({
      error: { kind: 'not_found', code: '100205', exit: 5 },
    });
  });
});

describe('release deploy list / get', () => {
  it('lists deploys with the environment name in the table', async () => {
    const run = await runCli(['release', 'deploy', 'list'], [deploysPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('cli-smoke 1.0.0');
    expect(run.stdout).toContain('cli-smoke-prod');
    expect(run.stdout).toContain('200s');
  });

  it('resolves --env to an id and sends it as the only filter', async () => {
    const run = await runCli(
      ['release', 'deploy', 'list', '--env', 'cli-smoke-prod', '--json'],
      [environmentsPage, deploysPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.url).toContain(`env_id=${ENVIRONMENT}`);
  });

  it('passes --env-id through with no lookup at all', async () => {
    const run = await runCli(
      ['release', 'deploy', 'list', '--env-id', 'whatever-the-user-typed', '--json'],
      [deploysPage],
    );
    expect(run.exit).toBe(0);
    // One request: an id is never verified, so there is no candidate list to fetch.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain('env_id=whatever-the-user-typed');
  });

  it('refuses --env together with --env-id before sending anything', async () => {
    const run = await runCli([
      'release',
      'deploy',
      'list',
      '--env',
      'cli-smoke-prod',
      '--env-id',
      ENVIRONMENT,
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('mutually exclusive');
  });

  it('lists everything when no environment is given', async () => {
    const run = await runCli(['release', 'deploy', 'list', '--json'], [deploysPage]);
    expect(run.exit).toBe(0);
    expect(run.calls[0]?.url ?? '').not.toContain('env_id=');
  });

  it('passes the positional through as an id, with no lookup', async () => {
    const run = await runCli(['release', 'deploy', 'get', 'not-an-object-id', '--json'], [oneDeploy]);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain('/v1/release/deploys/not-an-object-id');
  });
});

describe('release deploy create', () => {
  it('resolves --env and sends env_id with the five other required fields', async () => {
    const run = await runCli(
      ['release', 'deploy', 'create', '--env', 'cli-smoke-prod', ...CREATE_DEPLOY_ARGS, '--json'],
      [environmentsPage, oneDeploy],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toEqual({
      status: 'deployed',
      release_name: 'cli-smoke 1.0.0',
      start_at: 1785700000,
      end_at: 1785700200,
      duration: 200,
      // The id came from the list, not from the user.
      env_id: ENVIRONMENT,
    });
  });

  it('requires an environment, and says where to find one', async () => {
    const run = await runCli(['release', 'deploy', 'create', ...CREATE_DEPLOY_ARGS]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--env');
    expect(run.stderr).toContain('release env list');
  });

  it('refuses a missing required flag before sending anything', async () => {
    const run = await runCli(['release', 'deploy', 'create', '--env-id', ENVIRONMENT, '--status', 'deployed']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('prints the plan and sends nothing on a dry-run, having really resolved the name', async () => {
    // Design D8.3: reads still run under `--dry-run`, so the plan shows the *resolved*
    // request rather than a guess.
    const run = await runCli(
      [
        'release',
        'deploy',
        'create',
        '--env',
        'cli-smoke-prod',
        ...CREATE_DEPLOY_ARGS,
        '--dry-run',
        '--json',
      ],
      [environmentsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { request: { method: string; body: { env_id: string } } };
    expect(plan.request.method).toBe('POST');
    expect(plan.request.body.env_id).toBe(ENVIRONMENT);
  });

  it('warns when the API silently drops a work-item link, but still exits 0', async () => {
    const run = await runCli(
      [
        'release',
        'deploy',
        'create',
        '--env-id',
        ENVIRONMENT,
        ...CREATE_DEPLOY_ARGS,
        '--work-item',
        'YYHC-10',
        '--work-item',
        'NOSUCH-99999',
        '--json',
      ],
      [
        () =>
          jsonResponse(
            deployBody({ work_items: [{ id: WORK_ITEM, identifier: 'YYHC-10' }] }),
          ),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('NOSUCH-99999');
    expect(JSON.parse(run.stdout)).toMatchObject({ id: DEPLOY });
  });

  it('exits 5 when the named environment does not exist', async () => {
    // `100205` on a **create**: the row the request named really is absent, so exit 5 is
    // precise rather than incidental (same judgement as S1b's `100201` on POST …/refs).
    const run = await runCli(
      ['release', 'deploy', 'create', '--env-id', ENVIRONMENT, ...CREATE_DEPLOY_ARGS, '--json'],
      [() => jsonResponse({ code: '100205', message: "'environment'资源不存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'not_found', code: '100205' } });
  });
});

describe('release deploy update', () => {
  it('sends only the fields it was given', async () => {
    const run = await runCli(
      ['release', 'deploy', 'update', DEPLOY, '--status', 'not_deployed', '--json'],
      [() => jsonResponse(deployBody({ status: 'not_deployed' }))],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.body).toEqual({ status: 'not_deployed' });
  });

  it('rejects --env outright, because the API accepts env_id and then ignores it', async () => {
    // Live 2026-08-04: the PATCH returns 200 and *echoes the new environment*, but a
    // following GET shows the old one. The flag is therefore not registered at all, so
    // commander rejects it as unknown before anything is sent — which is the only honest
    // outcome for an operation the API cannot perform.
    const run = await runCli(['release', 'deploy', 'update', DEPLOY, '--env', 'cli-smoke-staging']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('unknown option');
  });

  it('sends no env_id even when every other field is patched', async () => {
    const run = await runCli(
      [
        'release',
        'deploy',
        'update',
        DEPLOY,
        '--status',
        'deployed',
        '--release-name',
        'cli-smoke 1.0.1',
        '--duration',
        '250',
        '--json',
      ],
      [() => jsonResponse(deployBody())],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      status: 'deployed',
      release_name: 'cli-smoke 1.0.1',
      duration: 250,
    });
    expect(Object.keys(run.writes[0]?.body as object)).not.toContain('env_id');
  });

  it('refuses an empty patch before sending anything', async () => {
    const run = await runCli(['release', 'deploy', 'update', DEPLOY]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
    // …and the hint has to say why `--env` is not one of the options it lists.
    expect(run.stderr).toContain('not patchable');
  });

  it('exits 5 when the deploy does not exist (HTTP 400 + 100204)', async () => {
    const run = await runCli(
      ['release', 'deploy', 'update', DEPLOY, '--status', 'deployed', '--json'],
      [() => jsonResponse({ code: '100204', message: "'deploy'资源不存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'not_found', code: '100204' } });
  });
});
