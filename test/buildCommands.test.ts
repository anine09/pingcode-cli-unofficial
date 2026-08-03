import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * S1d: the `build` command group end to end, through the real `buildProgram()` tree with
 * `fetch` replaced at the global boundary and the config directory redirected to a temp
 * dir. No network, no real credentials.
 *
 * What is proven here and cannot be proven at the api layer:
 *  - `--json` keeps **stdout JSON-only**, with tables and notices on stderr;
 *  - `--dry-run` on a write prints `{"dry_run":true,"request":{…}}` on stdout and sends
 *    **zero** mutating requests — including on `delete`, where the pre-read still runs;
 *  - every flag refusal (an empty patch, a non-numeric `--duration`, a blank
 *    `--work-item`) happens **before** any request goes out;
 *  - `delete` without `--yes` sends nothing, and `--yes false` — which commander used to
 *    swallow as an excess argument (design D12.9) — is rejected rather than obeyed;
 *  - the silently-dropped `--work-item` link produces a stderr warning while the exit
 *    code stays 0.
 */

const harness = createCliHarness({ beforeEach, afterEach });
const runCli = harness.run;

const BUILD = '6a70c1eb919cce9794f01acb';
const WORK_ITEM = '6a221c5d22cc7d25d68cafdb';

const buildBody = (overrides: Record<string, unknown> = {}) => ({
  id: BUILD,
  url: `https://open.pingcode.com/v1/build/builds/${BUILD}`,
  name: 'cli-smoke unit-test',
  identifier: '9001',
  provider: 'jenkins',
  status: 'success',
  start_at: 1785700000,
  end_at: 1785700038,
  duration: 38,
  work_items: [],
  ...overrides,
});

const oneBuild = () => jsonResponse(buildBody());

const buildsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 2,
    values: [buildBody(), buildBody({ id: 'b2', identifier: '9002', status: 'failure' })],
  });

/** The seven required create flags, as argv. */
const CREATE_ARGS = [
  '--name',
  'cli-smoke unit-test',
  '--identifier',
  '9001',
  '--provider',
  'jenkins',
  '--status',
  'success',
  '--start-at',
  '1785700000',
  '--end-at',
  '1785700038',
  '--duration',
  '38',
];

describe('build list / get', () => {
  it('lists builds as a table on stdout with the row count on stderr', async () => {
    const run = await runCli(['build', 'list'], [buildsPage]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('cli-smoke unit-test');
    expect(run.stdout).toContain('jenkins');
    // The duration column carries its unit, because a bare number is ambiguous.
    expect(run.stdout).toContain('38s');
    expect(run.stderr).toContain('2 row(s)');
  });

  it('keeps stdout to JSON alone under --json', async () => {
    const run = await runCli(['build', 'list', '--json'], [buildsPage]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    const parsed = JSON.parse(run.stdout) as { total: number; values: { identifier: string }[] };
    expect(parsed.total).toBe(2);
    expect(parsed.values[0]?.identifier).toBe('9001');
  });

  it('sends no filter parameter, only paging', async () => {
    const run = await runCli(['build', 'list', '--page', '1', '--page-size', '2'], [buildsPage]);
    const url = run.calls[0]?.url ?? '';
    expect(url).toContain('page_index=1');
    expect(url).toContain('page_size=2');
    // Nothing else can reach the query string: the wrapper has no slot for one.
    expect(url).not.toContain('identifier=');
    expect(url).not.toContain('status=');
  });

  it('walks pages under --all and reports the collected shape', async () => {
    const run = await runCli(
      ['build', 'list', '--all', '--page-size', '1', '--json'],
      [
        () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [buildBody()] }),
        () =>
          jsonResponse({
            page_index: 1,
            page_size: 1,
            total: 2,
            values: [buildBody({ id: 'b2' })],
          }),
        () => jsonResponse({ page_index: 2, page_size: 1, total: 2, values: [] }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ count: 2, all: true });
  });

  it('passes the positional through as an id, with no lookup and no shape check', async () => {
    const run = await runCli(['build', 'get', 'not-an-object-id', '--json'], [oneBuild]);
    expect(run.exit).toBe(0);
    // One request: there is no list to resolve a name against, so nothing precedes it.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.url).toContain('/v1/build/builds/not-an-object-id');
  });

  it('prints a curated field block in human mode', async () => {
    const run = await runCli(['build', 'get', BUILD], [oneBuild]);
    expect(run.stdout).toContain('cli-smoke unit-test');
    expect(run.stdout).toContain('number');
    expect(run.stdout).toContain('duration');
  });
});

describe('build create', () => {
  it('sends the seven required fields and nothing else', async () => {
    const run = await runCli(['build', 'create', ...CREATE_ARGS, '--json'], [oneBuild]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toEqual({
      name: 'cli-smoke unit-test',
      identifier: '9001',
      provider: 'jenkins',
      status: 'success',
      start_at: 1785700000,
      end_at: 1785700038,
      duration: 38,
    });
  });

  it('accepts a date string for the timestamps and sends unix seconds', async () => {
    const run = await runCli(
      [
        'build',
        'create',
        ...CREATE_ARGS.slice(0, 8),
        '--start-at',
        '2026-08-04T09:00:00Z',
        '--end-at',
        '2026-08-04T09:00:38Z',
        '--duration',
        '38',
        '--json',
      ],
      [oneBuild],
    );
    expect(run.exit).toBe(0);
    const body = run.writes[0]?.body as { start_at: number; end_at: number };
    // Seconds, not milliseconds — the server rejects ms outright (400 `100004`).
    expect(body.start_at).toBe(1785834000);
    expect(body.end_at).toBe(1785834038);
    expect(String(body.start_at)).toHaveLength(10);
  });

  it('refuses a non-numeric --duration before sending anything', async () => {
    const run = await runCli([
      'build',
      'create',
      ...CREATE_ARGS.slice(0, 12),
      '--duration',
      'ages',
    ]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--duration');
  });

  it('refuses a missing required flag before sending anything', async () => {
    const run = await runCli(['build', 'create', '--name', 'x']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('refuses a blank --work-item before sending anything', async () => {
    const run = await runCli(['build', 'create', ...CREATE_ARGS, '--work-item', '  ']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--work-item');
  });

  it('prints the request plan and sends nothing on a dry-run create', async () => {
    const run = await runCli(['build', 'create', ...CREATE_ARGS, '--dry-run', '--json'], [oneBuild]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
  });

  it('warns when the API silently drops a work-item link, but still exits 0', async () => {
    // Live 2026-08-04: `["YYHC-10","NOSUCH-99999"]` returned 200 with only the first
    // linked. The status code cannot say so; the response body can, and this is where the
    // two are compared.
    const run = await runCli(
      [
        'build',
        'create',
        ...CREATE_ARGS,
        '--work-item',
        'YYHC-10',
        '--work-item',
        'NOSUCH-99999',
        '--json',
      ],
      [
        () =>
          jsonResponse(
            buildBody({
              work_items: [{ id: WORK_ITEM, identifier: 'YYHC-10', title: 'a story' }],
            }),
          ),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('NOSUCH-99999');
    expect(run.stderr).toContain('silently ignored');
    // …and the authoritative answer is still on stdout, alone.
    expect(JSON.parse(run.stdout)).toMatchObject({ id: BUILD });
  });
});

describe('build update', () => {
  it('sends only the fields it was given', async () => {
    const run = await runCli(
      ['build', 'update', BUILD, '--status', 'failure', '--json'],
      [() => jsonResponse(buildBody({ status: 'failure' }))],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.body).toEqual({ status: 'failure' });
  });

  it('refuses an empty patch before sending anything', async () => {
    const run = await runCli(['build', 'update', BUILD]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('replaces the work-item links rather than merging them', async () => {
    const run = await runCli(
      ['build', 'update', BUILD, '--work-item', 'YYHC-10', '--json'],
      [() => jsonResponse(buildBody({ work_items: [{ id: WORK_ITEM, identifier: 'YYHC-10' }] }))],
    );
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({ work_item_identifiers: ['YYHC-10'] });
  });
});

describe('build delete', () => {
  it('reads the build first and refuses without --yes, sending no DELETE', async () => {
    const run = await runCli(['build', 'delete', BUILD], [oneBuild]);
    expect(run.exit).toBe(2);
    // The read happened — that is what lets the refusal name the record…
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('GET');
    // …and no write did.
    expect(run.writes).toHaveLength(0);
    expect(run.stderr).toContain('#9001');
    expect(run.stderr).toContain('cli-smoke unit-test');
  });

  it('rejects `--yes false` rather than treating it as confirmation', async () => {
    // Design D12.9: commander used to drop `false` as an excess positional and honour the
    // bare switch, so a user asking *not* to confirm got a deletion. `buildProgram()` sets
    // `allowExcessArguments(false)` at the root and every leaf inherits it — this asserts
    // the inherited behaviour on a leaf that did not exist when that fix landed, and that
    // **zero** requests go out.
    const run = await runCli(['build', 'delete', BUILD, '--yes', 'false'], [oneBuild]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('too many arguments');
  });

  it('deletes with --yes and echoes what went', async () => {
    const run = await runCli(['build', 'delete', BUILD, '--yes'], [oneBuild, oneBuild]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('DELETE');
    expect(run.writes[0]?.url).toContain(`/v1/build/builds/${BUILD}`);
    expect(run.stderr).toContain('deleted');
  });

  it('sends no DELETE under --dry-run, while the pre-read still runs', async () => {
    const run = await runCli(['build', 'delete', BUILD, '--yes', '--dry-run', '--json'], [oneBuild]);
    expect(run.exit).toBe(0);
    expect(run.writes).toHaveLength(0);
    expect(run.calls).toHaveLength(1);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { method: string } };
    expect(plan.request.method).toBe('DELETE');
  });

  it('has no --all, so a bulk deletion cannot be spelled', async () => {
    const run = await runCli(['build', 'delete', BUILD, '--yes', '--all'], [oneBuild]);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('build error mapping through the command layer', () => {
  it('exits 5 when the build does not exist (HTTP 400 + 100203)', async () => {
    const run = await runCli(
      ['build', 'get', BUILD, '--json'],
      [() => jsonResponse({ code: '100203', message: "'build'资源不存在" }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.stderr)).toMatchObject({
      error: { kind: 'not_found', code: '100203', exit: 5 },
    });
  });

  it('exits 7 on a rejected enum value, which is not an absence', async () => {
    const run = await runCli(
      ['build', 'create', ...CREATE_ARGS.slice(0, 4), '--provider', 'github-actions', '--status', 'success', '--start-at', '1785700000', '--end-at', '1785700038', '--duration', '38', '--json'],
      [
        () =>
          jsonResponse(
            { code: '100003', message: "'provider'不是有效的字符串(不是有效的枚举值)" },
            { status: 400 },
          ),
      ],
    );
    expect(run.exit).toBe(7);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { kind: 'api', code: '100003' } });
  });
});
