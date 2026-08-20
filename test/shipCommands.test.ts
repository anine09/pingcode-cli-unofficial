import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureOutput } from '../src/cli/output';
import { buildProgram } from '../src/cli/program';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { CommanderError } from 'commander';
import { DryRunHalt, exitCodeFor } from '../src/core/errors';
import { createFakeFetch, jsonResponse, type FakeCall } from './helpers/fake';

/**
 * Gate G3: the ship command layer end to end, with `fetch` replaced at the
 * global boundary and the config directory redirected to a temp dir. No network,
 * no real credentials.
 *
 * What is actually being proven here, and cannot be proven at the api layer:
 *  - `--json` keeps **stdout JSON-only** for every new command, with warnings,
 *    tables and notices on stderr;
 *  - `--dry-run` on a write prints `{"dry_run":true,"request":{…}}` on stdout and
 *    sends **zero** mutating requests;
 *  - flag validation (empty patch, mutually exclusive state flags, malformed
 *    `--set`) fails before any request goes out.
 */

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-ship-cmd-'));
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      clientId: 'test-client',
      clientSecret: 'test-secret',
      token: {
        accessToken: 'test-token',
        expiresAtMs: Date.now() + THIRTY_DAYS_MS,
        obtainedAtMs: Date.now(),
      },
    }),
    { mode: 0o600 },
  );
  previousConfigDir = process.env.PINGCODE_CONFIG_DIR;
  process.env.PINGCODE_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.PINGCODE_CONFIG_DIR;
  else process.env.PINGCODE_CONFIG_DIR = previousConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

type CliRun = {
  stdout: string;
  stderr: string;
  exit: number;
  calls: FakeCall[];
  /** Only the requests that would change server state. */
  writes: FakeCall[];
};

/** Run one `pingcode …` invocation exactly as `bin/pingcode.ts` does. */
async function runCli(argv: string[], responses: Array<() => Response>): Promise<CliRun> {
  const fake = createFakeFetch(responses);
  let stdout = '';
  let stderr = '';

  const restoreOutput = captureOutput(
    (chunk) => {
      stdout += chunk;
    },
    (chunk) => {
      stderr += chunk;
    },
  );
  // `core/logger.ts` writes straight to process.stderr, bypassing captureOutput.
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch as unknown as typeof globalThis.fetch;

  let exit = 0;
  try {
    const program = buildProgram();
    await program.parseAsync(['node', 'pingcode', ...argv]);
  } catch (error) {
    if (error instanceof DryRunHalt) {
      const { printDryRun } = await import('../src/cli/output');
      printDryRun(error.plan, { json: argv.includes('--json') });
      exit = 0;
    } else if (error instanceof CommanderError) {
      exit = error.exitCode === 0 ? 0 : 2;
    } else {
      const { printError } = await import('../src/cli/output');
      printError(error, { json: argv.includes('--json') });
      exit = exitCodeFor(error);
    }
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realStderrWrite;
    restoreOutput();
  }

  const writes = fake.calls.filter((call) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(call.method));
  return { stdout, stderr, exit, calls: fake.calls, writes };
}

/** A write is a POST that is not one of the two read-only `…/search` endpoints. */
function mutations(run: CliRun): FakeCall[] {
  return run.writes.filter((call) => !call.url.includes('/search'));
}

const productsPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'prod-1', identifier: 'SLC', name: 'Sales Cloud', is_archived: 0 }],
  });

const statesPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'st-review', name: '待评审' },
      { id: 'st-doing', name: '开发中' },
    ],
  });

const membersPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 1,
    values: [{ id: 'u1', type: 'user', user: { id: 'u1', display_name: '张三', username: 'zhangsan' } }],
  });

const ideasPage = () =>
  jsonResponse({
    page_index: 0,
    page_size: 30,
    total: 1,
    values: [
      {
        id: 'i1',
        identifier: 'SLC-1',
        title: 'single sign-on',
        state: { id: 'st-review', name: '待评审' },
        created_at: 1730000000,
        is_archived: 0,
      },
    ],
  });

function parseStdout(run: CliRun): unknown {
  expect(run.stdout.trim(), `stdout was not pure JSON:\n${run.stdout}`).not.toBe('');
  return JSON.parse(run.stdout) as unknown;
}

describe('product commands', () => {
  it('list --json emits the raw page envelope on stdout only', async () => {
    const run = await runCli(['product', 'list', '--json'], [productsPage]);
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toMatchObject({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [{ id: 'prod-1', identifier: 'SLC' }],
    });
    expect(new URL(run.calls[0]?.url ?? '').pathname).toBe('/v1/ship/products');
  });

  it('renders a table on stdout and the row count on stderr in human mode', async () => {
    const run = await runCli(['product', 'list'], [productsPage]);
    expect(run.stdout).toContain('IDENTIFIER');
    expect(run.stdout).toContain('Sales Cloud');
    expect(run.stderr).toContain('row(s)');
    // the count annotation must never contaminate stdout
    expect(run.stdout).not.toContain('row(s)');
  });

  it('get resolves an identifier to an id before fetching', async () => {
    const run = await runCli(
      ['product', 'get', 'SLC', '--json'],
      [productsPage, () => jsonResponse({ id: 'prod-1', name: 'Sales Cloud', is_archived: 0 })],
    );
    expect((parseStdout(run) as { id: string }).id).toBe('prod-1');
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe('/v1/ship/products/prod-1');
  });
});

describe('idea list', () => {
  it('reads through POST …/search and never touches GET /v1/ship/ideas', async () => {
    const run = await runCli(
      ['product', 'idea', 'list', '--product', 'SLC', '--json'],
      [productsPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    const search = run.calls[1];
    expect(new URL(search?.url ?? '').pathname).toBe('/v1/ship/ideas/search');
    expect(search?.method).toBe('POST');
    expect(run.calls.some((call) => new URL(call.url).pathname === '/v1/ship/ideas')).toBe(false);
  });

  it('builds a product+state+assignee filter with the documented operator', async () => {
    const run = await runCli(
      [
        'product',
        'idea',
        'list',
        '--product',
        'SLC',
        '--state',
        '待评审',
        '--assignee',
        'zhangsan',
        '--keywords',
        'sso',
        '--json',
      ],
      [productsPage, statesPage, membersPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[3]?.body as { mode: string; payload: Record<string, unknown> };
    expect(body.mode).toBe('query');
    expect(body.payload.filter).toEqual({
      'product.id': { in: ['prod-1'] },
      'state.id': { in: ['st-review'] },
      'assignee.id': { in: ['u1'] },
    });
    expect(body.payload.keywords).toBe('sso');
  });

  it('keeps timestamps as raw unix seconds under --json', async () => {
    const run = await runCli(['product', 'idea', 'list', '--product', 'SLC', '--json'], [productsPage, ideasPage]);
    const payload = parseStdout(run) as { values: Array<{ created_at: number }> };
    expect(payload.values[0]?.created_at).toBe(1730000000);
  });

  it('--all switches the envelope to {values,count,all}', async () => {
    const run = await runCli(
      ['product', 'idea', 'list', '--product', 'SLC', '--all', '--json'],
      [productsPage, ideasPage],
    );
    expect(parseStdout(run)).toMatchObject({ count: 1, all: true });
  });

  it('warns on stderr that suite filtering is undocumented, keeping stdout pure', async () => {
    const suitesPage = () =>
      jsonResponse({
        page_index: 0,
        page_size: 100,
        total: 1,
        values: [{ id: 'su1', name: '登录', type: 'module' }],
      });
    const run = await runCli(
      ['product', 'idea', 'list', '--product', 'SLC', '--suite', '登录', '--json'],
      [productsPage, suitesPage, ideasPage],
    );
    expect(run.stderr).toContain('undocumented');
    expect(() => parseStdout(run)).not.toThrow();
  });

  it('rejects --state together with --state-id before any request is sent', async () => {
    const run = await runCli(
      ['product', 'idea', 'list', '--product', 'SLC', '--state', 'x', '--state-id', 'y', '--json'],
      [productsPage],
    );
    expect(run.exit).toBe(2);
    expect(JSON.parse(run.stderr) as { error: { kind: string } }).toMatchObject({
      error: { kind: 'usage', exit: 2 },
    });
    expect(run.stdout).toBe('');
  });

  it('rejects a page size above the API cap', async () => {
    const run = await runCli(['product', 'idea', 'list', '--product', 'SLC', '--page-size', '101'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });

  it('resolves participant and folds text + number filters with their operators', async () => {
    const run = await runCli(
      [
        'product',
        'idea',
        'list',
        '--product',
        'SLC',
        '--participant',
        'zhangsan',
        '--title-contains',
        'single',
        '--description-contains',
        'sso',
        '--score',
        '5',
        '--progress',
        '0.5',
        '--json',
      ],
      [productsPage, membersPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[2]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter).toEqual({
      'product.id': { in: ['prod-1'] },
      'participants.id': { in: ['u1'] },
      title: { contains: 'single' },
      description: { contains: 'sso' },
      score: { eq: 5 },
      progress: { eq: 0.5 },
    });
  });

  it('builds a between window for a two-sided date range', async () => {
    const run = await runCli(
      [
        'product',
        'idea',
        'list',
        '--product',
        'SLC',
        '--created-after',
        '2026-01-01',
        '--created-before',
        '2026-01-31',
        '--json',
      ],
      [productsPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter['product.id']).toEqual({ in: ['prod-1'] });
    const created = body.payload.filter.created_at as { between: number[] };
    expect(Array.isArray(created.between)).toBe(true);
    expect(created.between).toHaveLength(2);
    // 2026-01-01 00:00:00 local → 2026-01-31 23:59:59 local = 30 days + 86399s.
    // Timezone-independent: both endpoints shift by the same offset, so only the
    // elapsed real time (a whole number of days) survives.
    expect(created.between[1]! - created.between[0]!).toBe(30 * 86400 + 86399);
    expect(created.between[0]!).toBeLessThan(created.between[1]!);
  });

  it('uses gte / lte for a one-sided date boundary', async () => {
    const run = await runCli(
      ['product', 'idea', 'list', '--product', 'SLC', '--updated-after', '2026-06-01', '--json'],
      [productsPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    const updated = body.payload.filter.updated_at as { gte: number };
    expect(Object.keys(updated)).toEqual(['gte']);
    expect(updated.gte).toEqual(expect.any(Number));
  });

  it('runs the search under --dry-run too (a read wearing a POST verb)', async () => {
    const run = await runCli(
      ['product', 'idea', 'list', '--product', 'SLC', '--score', '5', '--dry-run', '--json'],
      [productsPage, ideasPage],
    );
    expect(run.exit).toBe(0);
    // the search still executes — dry-run only halts genuine writes
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe('/v1/ship/ideas/search');
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter.score).toEqual({ eq: 5 });
  });
});

describe('idea create', () => {
  const created = () =>
    jsonResponse({ id: 'i-new', identifier: 'SLC-2', title: '[CLI smoke] x', is_archived: 0 }, { status: 201 });

  it('sends product_id and title only, when nothing else was given', async () => {
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'hello', '--json'],
      [productsPage, created],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ product_id: 'prod-1', title: 'hello' });
    expect((parseStdout(run) as { id: string }).id).toBe('i-new');
  });

  it('--dry-run prints the plan on stdout and sends zero writes (Gate G3)', async () => {
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'hello', '--dry-run', '--json'],
      [productsPage],
    );
    expect(run.exit).toBe(0);
    const plan = parseStdout(run) as { dry_run: boolean; request: { method: string; url: string; body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/ship/ideas');
    expect(plan.request.body).toEqual({ product_id: 'prod-1', title: 'hello' });
    // the product lookup still ran — ids are genuinely resolved — but nothing was written
    expect(mutations(run)).toHaveLength(0);
    expect(run.calls).toHaveLength(1);
  });

  it('resolves an assignee against the product members, not the directory', async () => {
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'hello', '--assignee', 'zhangsan', '--dry-run', '--json'],
      [productsPage, membersPage],
    );
    expect(run.calls.some((call) => call.url.includes('/v1/directory/users'))).toBe(false);
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe('/v1/ship/products/prod-1/members');
    const plan = parseStdout(run) as { request: { body: { assignee_id: string } } };
    expect(plan.request.body.assignee_id).toBe('u1');
  });

  it('turns --set key=value into a properties object keyed by property id', async () => {
    const propertiesPage = () =>
      jsonResponse({
        page_index: 0,
        page_size: 100,
        total: 1,
        values: [
          {
            id: 'backlog_type',
            name: '需求类型',
            type: 'select',
            options: [{ _id: 'opt-1', text: '功能需求' }],
          },
        ],
      });
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'hello', '--set', '需求类型=opt-1', '--dry-run', '--json'],
      [productsPage, propertiesPage],
    );
    const plan = parseStdout(run) as { request: { body: { properties: Record<string, unknown> } } };
    expect(plan.request.body.properties).toEqual({ backlog_type: 'opt-1' });
  });

  it('rejects a malformed --set before sending anything', async () => {
    const run = await runCli(
      ['product', 'idea', 'create', '--product', 'SLC', '--title', 'hello', '--set', 'oops', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('key=value');
  });

  it('requires --title', async () => {
    const run = await runCli(['product', 'idea', 'create', '--product', 'SLC', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('idea update', () => {
  const ideaDetail = () =>
    jsonResponse({
      id: 'i1',
      identifier: 'SLC-1',
      title: 'single sign-on',
      product: { id: 'prod-1' },
      state: { id: 'st-review', name: '待评审' },
      is_archived: 0,
    });

  it('is exit 2 with no request when no field was given', async () => {
    const run = await runCli(['product', 'idea', 'update', 'i1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('sends only the fields passed', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--title', 'new title', '--json'],
      [ideaDetail, () => jsonResponse({ id: 'i1', title: 'new title', is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.method).toBe('PATCH');
    expect(mutations(run)[0]?.body).toEqual({ title: 'new title' });
  });

  it('resolves --state against the product of the idea itself, with no --type anywhere', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'SLC-1', '--state', '开发中', '--dry-run', '--json'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 20,
            total: 1,
            values: [{ id: 'i1', identifier: 'SLC-1', product: { id: 'prod-1' } }],
          }),
        statesPage,
      ],
    );
    const plan = parseStdout(run) as { request: { method: string; body: unknown } };
    expect(plan.request.method).toBe('PATCH');
    expect(plan.request.body).toEqual({ state_id: 'st-doing' });
    expect(new URL(run.calls[1]?.url ?? '').searchParams.get('product_id')).toBe('prod-1');
    expect(mutations(run)).toHaveLength(0);
  });

  it('--state-id skips the lookup entirely', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--state-id', 'st-anything', '--dry-run', '--json'],
      [ideaDetail],
    );
    const plan = parseStdout(run) as { request: { body: unknown } };
    expect(plan.request.body).toEqual({ state_id: 'st-anything' });
    // one GET for the idea, nothing else
    expect(run.calls).toHaveLength(1);
  });

  it('prints the product states on stderr when the server rejects a state change', async () => {
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--state-id', 'bogus', '--json'],
      [
        ideaDetail,
        () => jsonResponse({ code: '100303', message: '状态不存在' }, { status: 400 }),
        statesPage,
      ],
    );
    expect(run.exit).toBe(5);
    expect(run.stderr).toContain('待评审');
    expect(run.stderr).toContain('no idea state-flow endpoint');
    expect(run.stdout).toBe('');
  });
});

describe('ticket commands', () => {
  const typesPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [{ id: 'ty-fault', name: '故障' }],
    });

  const ticketDetail = () =>
    jsonResponse({
      id: 't1',
      identifier: 'SLC-7',
      title: 'cannot log in',
      product: { id: 'prod-1' },
      state: { id: 'ts-pending', name: '待处理' },
      channel: 'internal',
      is_archived: 0,
    });

  const usersPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [{ id: 'u-sub', name: 'wangxiao', display_name: '王晓', username: 'wangxiao' }],
    });

  const customersPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [{ id: 'cust-1', name: 'Acme', assignee: { id: 'u1' }, scale: 3 }],
    });

  const solutionsPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [{ id: 'sol-1', name: '重启服务' }],
    });

  const tagsPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [{ id: 'tag-1', name: 'vip', color: '#f00' }],
    });

  const searchPage = () =>
    jsonResponse({ page_index: 0, page_size: 30, total: 0, values: [] });

  it('list reads through POST …/search with a product+type filter', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--type', '故障', '--json'],
      [
        productsPage,
        typesPage,
        () => jsonResponse({ page_index: 0, page_size: 30, total: 1, values: [{ id: 't1', channel: 'internal' }] }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[2]?.url ?? '').pathname).toBe('/v1/ship/tickets/search');
    const body = run.calls[2]?.body as { payload: { filter: unknown } };
    expect(body.payload.filter).toEqual({
      'product.id': { in: ['prod-1'] },
      'type.id': { in: ['ty-fault'] },
    });
  });

  it('renders an internal ticket without choking on the string channel', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC'],
      [
        productsPage,
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 30,
            total: 2,
            values: [
              { id: 't1', identifier: 'SLC-7', title: 'a', channel: 'internal' },
              { id: 't2', identifier: 'SLC-8', title: 'b', channel: { id: 'ch1', name: '邮件' } },
            ],
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('internal');
    expect(run.stdout).toContain('邮件');
  });

  it('resolves the new reference filters with their documented keys', async () => {
    const run = await runCli(
      [
        'product',
        'ticket',
        'list',
        '--product',
        'SLC',
        '--submitted-by',
        'wangxiao',
        '--customer',
        'Acme',
        '--solution',
        '重启服务',
        '--tag',
        'vip',
        '--participant',
        'zhangsan',
        '--json',
      ],
      [productsPage, usersPage, customersPage, solutionsPage, tagsPage, membersPage, searchPage],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[6]?.url ?? '').pathname).toBe('/v1/ship/tickets/search');
    const body = run.calls[6]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter).toEqual({
      'product.id': { in: ['prod-1'] },
      'submitted_by.id': { in: ['u-sub'] },
      'customer.id': { in: ['cust-1'] },
      'solution.id': { in: ['sol-1'] },
      'tags.id': { in: ['tag-1'] },
      'participants.id': { in: ['u1'] },
    });
  });

  it('folds text filters with {contains}', async () => {
    const run = await runCli(
      [
        'product',
        'ticket',
        'list',
        '--product',
        'SLC',
        '--title-contains',
        'login',
        '--description-contains',
        'password',
        '--json',
      ],
      [productsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter).toEqual({
      'product.id': { in: ['prod-1'] },
      title: { contains: 'login' },
      description: { contains: 'password' },
    });
  });

  it('builds a between window for a two-sided date range', async () => {
    const run = await runCli(
      [
        'product',
        'ticket',
        'list',
        '--product',
        'SLC',
        '--submitted-after',
        '2026-01-01',
        '--submitted-before',
        '2026-01-31',
        '--json',
      ],
      [productsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    const submitted = body.payload.filter.submitted_at as { between: number[] };
    expect(Array.isArray(submitted.between)).toBe(true);
    // 2026-01-01 00:00:00 local → 2026-01-31 23:59:59 local = 30 days + 86399s.
    // Timezone-independent: both endpoints shift by the same offset, so only the
    // elapsed real time (a whole number of days) survives.
    expect(submitted.between[1]! - submitted.between[0]!).toBe(30 * 86400 + 86399);
    expect(submitted.between[0]!).toBeLessThan(submitted.between[1]!);
  });

  it('uses gte for a one-sided date boundary', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--updated-after', '2026-06-01', '--json'],
      [productsPage, searchPage],
    );
    expect(run.exit).toBe(0);
    const body = run.calls[1]?.body as { payload: { filter: Record<string, unknown> } };
    const updated = body.payload.filter.updated_at as { gte: number };
    expect(Object.keys(updated)).toEqual(['gte']);
    expect(updated.gte).toEqual(expect.any(Number));
  });

  it('runs the search under --dry-run too (a read wearing a POST verb)', async () => {
    const run = await runCli(
      ['product', 'ticket', 'list', '--product', 'SLC', '--customer', 'Acme', '--dry-run', '--json'],
      [productsPage, customersPage, searchPage],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[2]?.url ?? '').pathname).toBe('/v1/ship/tickets/search');
    const body = run.calls[2]?.body as { payload: { filter: Record<string, unknown> } };
    expect(body.payload.filter['customer.id']).toEqual({ in: ['cust-1'] });
  });

  it('create requires --type and sends it (PRD D12)', async () => {
    const missing = await runCli(
      ['product', 'ticket', 'create', '--product', 'SLC', '--title', 'x', '--json'],
      [],
    );
    expect(missing.exit).toBe(2);
    expect(missing.calls).toHaveLength(0);

    const run = await runCli(
      ['product', 'ticket', 'create', '--product', 'SLC', '--type', '故障', '--title', 'cannot log in', '--dry-run', '--json'],
      [productsPage, typesPage],
    );
    const plan = parseStdout(run) as { request: { method: string; url: string; body: unknown } };
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/ship/tickets');
    expect(plan.request.body).toEqual({
      product_id: 'prod-1',
      title: 'cannot log in',
      type_id: 'ty-fault',
    });
    expect(mutations(run)).toHaveLength(0);
  });

  it('create accepts --channel, which update does not offer (set once)', async () => {
    const channelsPage = () =>
      jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'ch1', name: '邮件' }] });
    const run = await runCli(
      [
        'product',
        'ticket',
        'create',
        '--product',
        'SLC',
        '--type',
        '故障',
        '--title',
        'x',
        '--channel',
        '邮件',
        '--dry-run',
        '--json',
      ],
      [productsPage, typesPage, channelsPage],
    );
    const plan = parseStdout(run) as { request: { body: { channel_id: string } } };
    expect(plan.request.body.channel_id).toBe('ch1');
  });

  it('update with no fields is exit 2 and sends nothing', async () => {
    const run = await runCli(['product', 'ticket', 'update', 't1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('update sends only the fields passed', async () => {
    const run = await runCli(
      ['product', 'ticket', 'update', 't1', '--title', 'renamed', '--json'],
      [ticketDetail, () => jsonResponse({ id: 't1', title: 'renamed', is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.method).toBe('PATCH');
    expect(mutations(run)[0]?.body).toEqual({ title: 'renamed' });
  });

  it('transition without a state flag is exit 2 before any request', async () => {
    const run = await runCli(['product', 'ticket', 'transition', 't1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--state');
  });

  it('get resolves an identifier through ticket search', async () => {
    const run = await runCli(
      ['product', 'ticket', 'get', 'SLC-7', '--json'],
      [
        () =>
          jsonResponse({
            page_index: 0,
            page_size: 20,
            total: 1,
            values: [{ id: 't1', identifier: 'SLC-7' }],
          }),
        ticketDetail,
      ],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[0]?.url ?? '').pathname).toBe('/v1/ship/tickets/search');
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe('/v1/ship/tickets/t1');
    expect((parseStdout(run) as { channel: string }).channel).toBe('internal');
  });
});

describe('ticket transitions are advisory, never refusing (Gate G3b, S7b)', () => {
  const ticketDetail = () =>
    jsonResponse({
      id: 't1',
      identifier: 'SLC-7',
      title: 'cannot log in',
      product: { id: 'prod-1' },
      state: { id: 'ts-pending', name: '待处理' },
      is_archived: 0,
    });

  const ticketStatesPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 3,
      values: [
        { id: 'ts-pending', name: '待处理', type: 'pending' },
        { id: 'ts-doing', name: '处理中', type: 'in_progress' },
        { id: 'ts-closed', name: '已关闭', type: 'closed' },
      ],
    });

  const plansPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 2,
      values: [
        { id: 'plan-org', product: null },
        { id: 'plan-1', product: { id: 'prod-1' } },
      ],
    });

  const flowsPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 100,
      total: 1,
      values: [
        {
          id: 'flow-1',
          form_state: { id: 'ts-pending', name: '待处理' },
          to_state: { id: 'ts-doing', name: '处理中' },
        },
      ],
    });

  const rejectState = () =>
    jsonResponse({ code: '100702', message: '工单状态不存在' }, { status: 400 });

  const errorPayload = (run: CliRun): { kind: string; message: string; exit: number } =>
    (
      JSON.parse(run.stderr.split('\n').filter((line) => line.startsWith('{'))[0] ?? '{}') as {
        error: { kind: string; message: string; exit: number };
      }
    ).error;

  it('sends a legal transition with no plan or flow lookup on the happy path', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '处理中', '--json'],
      [
        ticketDetail,
        ticketStatesPage,
        () => jsonResponse({ id: 't1', state: { id: 'ts-doing', name: '处理中' }, is_archived: 0 }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ state_id: 'ts-doing' });
    // the whole point of S7b: GET ticket → resolve state → PATCH, nothing else
    expect(run.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/ship/tickets/t1',
      '/v1/ship/ticket/states',
      '/v1/ship/tickets/t1',
    ]);
  });

  it('sends an illegal transition and enriches the server refusal with the reachable set', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '已关闭', '--json'],
      [ticketDetail, ticketStatesPage, rejectState, ticketStatesPage, plansPage, flowsPage],
    );
    // the server refuses atomically, so exit is its call, not ours
    expect(run.exit).toBe(7);
    expect(mutations(run)).toHaveLength(1);
    const error = errorPayload(run);
    expect(error.kind).toBe('api');
    // the server's verbatim message survives …
    expect(error.message).toContain('工单状态不存在');
    // … and the enrichment rides in `message`, because --json drops the hint
    expect(error.message).toContain('states configured for this product');
    expect(error.message).toContain('current state: 待处理');
    expect(error.message).toContain('reachable from 待处理: 处理中 (ts-doing)');
    expect(run.stdout).toBe('');
  });

  it('still reports the refusal when the plan cannot be read', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '已关闭', '--json'],
      [
        ticketDetail,
        ticketStatesPage,
        rejectState,
        ticketStatesPage,
        () => jsonResponse({ code: '100001', message: '无权限' }, { status: 403 }),
      ],
    );
    expect(run.exit).toBe(7);
    expect(mutations(run)).toHaveLength(1);
    const error = errorPayload(run);
    expect(error.message).toContain('states configured for this product');
    // no plan, no suggestion — and no crash
    expect(error.message).not.toContain('reachable from');
  });

  it('sends exactly one PATCH when a cached state id is refused (S7b id-diff gate)', async () => {
    // Warm the resolver cache with a successful transition first…
    const warm = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '处理中', '--json'],
      [
        ticketDetail,
        ticketStatesPage,
        () => jsonResponse({ id: 't1', state: { id: 'ts-doing' }, is_archived: 0 }),
      ],
    );
    expect(warm.exit).toBe(0);

    // …so this run resolves 已关闭 from the cache and hits the retry path.
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '已关闭', '--json'],
      [ticketDetail, rejectState, ticketStatesPage, ticketStatesPage, plansPage, flowsPage],
    );
    expect(run.exit).toBe(7);
    expect(run.stderr).toContain('refreshing it and retrying once');
    // re-resolution produced the same id, so the second write was skipped
    expect(mutations(run)).toHaveLength(1);
    expect(errorPayload(run).message).toContain('工单状态不存在');
  });

  it('--state-id goes straight to the PATCH: nothing validates the plan any more', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state-id', 'ts-closed', '--json'],
      [ticketDetail, () => jsonResponse({ id: 't1', state: { id: 'ts-closed' }, is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ state_id: 'ts-closed' });
  });

  it('refuses a no-op transition to the current state — the one local refusal left', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state-id', 'ts-pending', '--json'],
      [ticketDetail],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('already in state');
    expect(mutations(run)).toHaveLength(0);
  });

  it('--dry-run previews the reachable states on stderr and writes nothing', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state', '已关闭', '--json', '--dry-run'],
      [ticketDetail, plansPage, flowsPage, ticketStatesPage],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(0);
    expect(run.stderr).toContain('reachable from 待处理: 处理中 (ts-doing)');
    expect(run.stderr).not.toContain('could not read the state plan');
    const plan = parseStdout(run) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ state_id: 'ts-closed' });
  });

  it('--dry-run distinguishes "the plan says nowhere" from "I could not read the plan"', async () => {
    // A closed ticket in a plan with no outgoing edge is a definite answer.
    const closedTicket = () =>
      jsonResponse({
        id: 't1',
        identifier: 'SLC-7',
        product: { id: 'prod-1' },
        state: { id: 'ts-closed', name: '已关闭' },
        is_archived: 0,
      });
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state-id', 'ts-doing', '--json', '--dry-run'],
      [closedTicket, plansPage, flowsPage],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('no transition out of 已关闭');
    expect(run.stderr).not.toContain('could not read the state plan');
    expect(mutations(run)).toHaveLength(0);
  });

  it('--dry-run says so plainly when the plan is unreadable, and still shows the plan', async () => {
    const run = await runCli(
      ['product', 'ticket', 'transition', 't1', '--state-id', 'ts-closed', '--json', '--dry-run'],
      [ticketDetail, () => jsonResponse({ code: '100001', message: '无权限' }, { status: 403 })],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('pcp:read:ship:configuration');
    expect((parseStdout(run) as { dry_run: boolean }).dry_run).toBe(true);
  });

  it('treats ticket update --state exactly like transition', async () => {
    const run = await runCli(
      ['product', 'ticket', 'update', 't1', '--state', '已关闭', '--json'],
      [ticketDetail, ticketStatesPage, rejectState, ticketStatesPage, plansPage, flowsPage],
    );
    expect(run.exit).toBe(7);
    expect(mutations(run)).toHaveLength(1);
    expect(errorPayload(run).message).toContain('reachable from');
  });

  it('leaves idea update --state unenriched by any flow read: ship has no idea flow endpoint', async () => {
    // The surviving asymmetry: ideas cannot even be explained from a plan.
    const run = await runCli(
      ['product', 'idea', 'update', 'i1', '--state-id', 'st-anything', '--json'],
      [
        () => jsonResponse({ id: 'i1', product: { id: 'prod-1' }, state: { id: 'st-old' }, is_archived: 0 }),
        () => jsonResponse({ id: 'i1', is_archived: 0 }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(run.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/ship/ideas/i1',
      '/v1/ship/ideas/i1',
    ]);
    expect(mutations(run)).toHaveLength(1);
  });
});

describe('product meta lookups', () => {
  const cases: Array<[string, string]> = [
    ['idea-states', '/v1/ship/idea/states'],
    ['idea-priorities', '/v1/ship/idea/priorities'],
    ['idea-suites', '/v1/ship/idea/suites'],
    ['idea-properties', '/v1/ship/idea/properties'],
    ['members', '/v1/ship/products/prod-1/members'],
    ['ticket-states', '/v1/ship/ticket/states'],
    ['ticket-priorities', '/v1/ship/ticket/priorities'],
    ['ticket-types', '/v1/ship/ticket/types'],
    ['ticket-channels', '/v1/ship/ticket/channels'],
    ['ticket-properties', '/v1/ship/ticket/properties'],
    ['ticket-customers', '/v1/ship/products/prod-1/customers'],
    ['ticket-solutions', '/v1/ship/ticket/solutions'],
    ['ticket-tags', '/v1/ship/ticket/tags'],
  ];

  for (const [name, expectedPath] of cases) {
    it(`product meta ${name} is product-scoped and emits {values,count}`, async () => {
      const run = await runCli(
        ['product', 'meta', name, '--product', 'SLC', '--json'],
        [productsPage, () => jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'x', name: 'X' }] })],
      );
      expect(run.exit).toBe(0);
      const url = new URL(run.calls[1]?.url ?? '');
      expect(url.pathname).toBe(expectedPath);
      if (!expectedPath.includes('/products/')) {
        expect(url.searchParams.get('product_id')).toBe('prod-1');
      }
      const expected = name.endsWith('-properties')
        ? { id: 'x', name: 'X', options: [] }
        : { id: 'x', name: 'X' };
      expect(parseStdout(run)).toEqual({ values: [expected], count: 1 });
    });
  }

  it('requires --product', async () => {
    const run = await runCli(['product', 'meta', 'idea-states', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

/**
 * S4 — the 需求排期 and 需求流转记录 leaves, end to end through commander.
 *
 * The command-layer facts that the api layer cannot prove: `--product` is resolved
 * before the schedule path is built, a history reference is resolved to a 24-hex id
 * first (because the sub-collection rejects `short_id`/`identifier` upstream), and
 * every one of the five new leaves keeps stdout JSON-only while sending zero writes.
 */
describe('product plan (需求排期, S4)', () => {
  const plansPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 30,
      total: 1,
      values: [
        {
          id: 'plan-1',
          name: '2026 Q3',
          assignee: { id: 'u1', name: 'luoxiutao' },
          start_at: 1780243027,
          end_at: 1780620720,
        },
      ],
    });

  it('list resolves --product first and emits the raw envelope on stdout only', async () => {
    const run = await runCli(
      ['product', 'plan', 'list', '--product', 'SLC', '--json'],
      [productsPage, plansPage],
    );
    expect(run.exit).toBe(0);
    expect(parseStdout(run)).toMatchObject({ total: 1, values: [{ id: 'plan-1' }] });
    expect(run.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/ship/products',
      '/v1/ship/products/prod-1/plans',
    ]);
    expect(run.stderr).toBe('');
    expect(mutations(run)).toHaveLength(0);
  });

  it('list renders the window in human mode and counts rows on stderr', async () => {
    const run = await runCli(['product', 'plan', 'list', '--product', 'SLC'], [productsPage, plansPage]);
    expect(run.stdout).toContain('2026 Q3');
    expect(run.stdout).toContain('START');
    expect(run.stderr).toContain('row(s)');
    expect(run.stdout).not.toContain('row(s)');
  });

  it('list --all walks pages and reports {values,count,all}', async () => {
    const run = await runCli(
      ['product', 'plan', 'list', '--product', 'SLC', '--all', '--page-size', '1', '--json'],
      [
        productsPage,
        () => jsonResponse({ page_index: 0, page_size: 1, total: 2, values: [{ id: 'plan-1' }] }),
        () => jsonResponse({ page_index: 1, page_size: 1, total: 2, values: [{ id: 'plan-2' }] }),
        () => jsonResponse({ page_index: 2, page_size: 1, total: 2, values: [] }),
      ],
    );
    expect(parseStdout(run)).toMatchObject({ count: 2, all: true });
  });

  it('get puts the plan under the resolved product', async () => {
    const run = await runCli(
      ['product', 'plan', 'get', 'plan-1', '--product', 'SLC', '--json'],
      [productsPage, () => jsonResponse({ id: 'plan-1', name: '2026 Q3' })],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe('/v1/ship/products/prod-1/plans/plan-1');
  });

  it('requires --product on both leaves, before any request', async () => {
    for (const argv of [
      ['product', 'plan', 'list', '--json'],
      ['product', 'plan', 'get', 'plan-1', '--json'],
    ]) {
      const run = await runCli(argv, []);
      expect(run.exit, argv.join(' ')).toBe(2);
      expect(run.calls, argv.join(' ')).toHaveLength(0);
    }
  });

  it('has no create/update/delete leaf: every write verb is HTTP 405 upstream', () => {
    const program = buildProgram();
    const plan = program.commands
      .find((group) => group.name() === 'product')
      ?.commands.find((group) => group.name() === 'plan');
    expect(plan?.commands.map((leaf) => leaf.name()).sort()).toEqual(['get', 'list']);
  });
});

describe('product idea history (流转记录, S4)', () => {
  /**
   * `SLC-1` matches `IDENTIFIER_RE`, so `resolveShipRef` resolves it through search —
   * the two-request path. A dash-containing product prefix (`PD-YYHC-1`) misses that
   * regex and takes the one-request direct GET instead; both were exercised live and
   * both end up handing a 24-hex id to the sub-collection, which is the only form the
   * endpoint accepts.
   */
  const ideaByIdentifier = () =>
    jsonResponse({
      page_index: 0,
      page_size: 20,
      total: 1,
      values: [{ id: 'i1', identifier: 'SLC-1', product: { id: 'prod-1' }, is_archived: 0 }],
    });

  const historyPage = () =>
    jsonResponse({
      page_index: 0,
      page_size: 30,
      total: 2,
      values: [
        {
          id: 'h1',
          idea: { id: 'i1', identifier: 'SLC-1', title: 'single sign-on' },
          from_state: null,
          to_state: { id: 'st-1', name: '待排期' },
          created_by: { id: 'u1', name: 'luoxiutao' },
          created_at: 1780243027,
        },
        {
          id: 'h2',
          idea: { id: 'i1', identifier: 'SLC-1', title: 'single sign-on' },
          from_state: { id: 'st-1', name: '待排期' },
          to_state: { id: 'st-2', name: '已计划' },
          created_by: { id: 'u1', name: 'luoxiutao' },
          created_at: 1780274023,
        },
      ],
    });

  it('resolves the reference to a 24-hex id before the sub-collection call', async () => {
    const run = await runCli(
      ['product', 'idea', 'history', 'list', 'SLC-1', '--json'],
      [ideaByIdentifier, historyPage],
    );
    expect(run.exit).toBe(0);
    expect(run.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/ship/ideas/search',
      // …the sub-collection is addressed by id, never by the identifier that was typed:
      // upstream answers a real HTTP 404 for anything but the id.
      '/v1/ship/ideas/i1/transition_histories',
    ]);
    expect(run.stderr).toBe('');
  });

  it('prints (new) for the creation row rather than an empty FROM cell', async () => {
    const run = await runCli(['product', 'idea', 'history', 'list', 'SLC-1'], [ideaByIdentifier, historyPage]);
    expect(run.stdout).toContain('(new)');
    expect(run.stdout).toContain('已计划');
  });

  it('get shows one row and labels the parent by identifier, not by raw id', async () => {
    const run = await runCli(
      ['product', 'idea', 'history', 'get', 'SLC-1', 'h2'],
      [
        ideaByIdentifier,
        () =>
          jsonResponse({
            id: 'h2',
            idea: { id: 'i1', identifier: 'SLC-1', title: 'single sign-on' },
            from_state: { id: 'st-1', name: '待排期' },
            to_state: { id: 'st-2', name: '已计划' },
          }),
      ],
    );
    expect(run.exit).toBe(0);
    expect(new URL(run.calls[1]?.url ?? '').pathname).toBe(
      '/v1/ship/ideas/i1/transition_histories/h2',
    );
    expect(run.stdout).toContain('SLC-1');
    expect(run.stdout).not.toMatch(/requirement\s+i1/);
  });

  it('reports a mismatched (idea, history) pair as not_found, i.e. exit 5', async () => {
    const run = await runCli(
      ['product', 'idea', 'history', 'get', 'SLC-1', 'h-of-another-idea', '--json'],
      [ideaByIdentifier, () => jsonResponse({ code: '100740', message: '需求流转记录不存在' }, { status: 400 })],
    );
    expect(run.exit).toBe(5);
    expect(run.stdout).toBe('');
  });

  it('offers no filter flag, because the endpoint ignores the ones it accepts', async () => {
    const run = await runCli(
      ['product', 'idea', 'history', 'list', 'SLC-1', '--keywords', 'x', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('product meta idea-plans (S4)', () => {
  it('hits the singular idea lookup with ?product_id= and emits {values,count}', async () => {
    const run = await runCli(
      ['product', 'meta', 'idea-plans', '--product', 'SLC', '--json'],
      [productsPage, () => jsonResponse({ page_index: 0, page_size: 100, total: 1, values: [{ id: 'plan-1', name: '2026 Q3' }] })],
    );
    expect(run.exit).toBe(0);
    const url = new URL(run.calls[1]?.url ?? '');
    expect(url.pathname).toBe('/v1/ship/idea/plans');
    expect(url.searchParams.get('product_id')).toBe('prod-1');
    expect(parseStdout(run)).toEqual({ values: [{ id: 'plan-1', name: '2026 Q3' }], count: 1 });
  });
});
