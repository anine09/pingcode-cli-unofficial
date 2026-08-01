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
      ['idea', 'list', '--product', 'SLC', '--json'],
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
    const run = await runCli(['idea', 'list', '--product', 'SLC', '--json'], [productsPage, ideasPage]);
    const payload = parseStdout(run) as { values: Array<{ created_at: number }> };
    expect(payload.values[0]?.created_at).toBe(1730000000);
  });

  it('--all switches the envelope to {values,count,all}', async () => {
    const run = await runCli(
      ['idea', 'list', '--product', 'SLC', '--all', '--json'],
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
      ['idea', 'list', '--product', 'SLC', '--suite', '登录', '--json'],
      [productsPage, suitesPage, ideasPage],
    );
    expect(run.stderr).toContain('undocumented');
    expect(() => parseStdout(run)).not.toThrow();
  });

  it('rejects --state together with --state-id before any request is sent', async () => {
    const run = await runCli(
      ['idea', 'list', '--product', 'SLC', '--state', 'x', '--state-id', 'y', '--json'],
      [productsPage],
    );
    expect(run.exit).toBe(2);
    expect(JSON.parse(run.stderr) as { error: { kind: string } }).toMatchObject({
      error: { kind: 'usage', exit: 2 },
    });
    expect(run.stdout).toBe('');
  });

  it('rejects a page size above the API cap', async () => {
    const run = await runCli(['idea', 'list', '--product', 'SLC', '--page-size', '101'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

describe('idea create', () => {
  const created = () =>
    jsonResponse({ id: 'i-new', identifier: 'SLC-2', title: '[CLI smoke] x', is_archived: 0 }, { status: 201 });

  it('sends product_id and title only, when nothing else was given', async () => {
    const run = await runCli(
      ['idea', 'create', '--product', 'SLC', '--title', 'hello', '--json'],
      [productsPage, created],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.body).toEqual({ product_id: 'prod-1', title: 'hello' });
    expect((parseStdout(run) as { id: string }).id).toBe('i-new');
  });

  it('--dry-run prints the plan on stdout and sends zero writes (Gate G3)', async () => {
    const run = await runCli(
      ['idea', 'create', '--product', 'SLC', '--title', 'hello', '--dry-run', '--json'],
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
      ['idea', 'create', '--product', 'SLC', '--title', 'hello', '--assignee', 'zhangsan', '--dry-run', '--json'],
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
      ['idea', 'create', '--product', 'SLC', '--title', 'hello', '--set', '需求类型=opt-1', '--dry-run', '--json'],
      [productsPage, propertiesPage],
    );
    const plan = parseStdout(run) as { request: { body: { properties: Record<string, unknown> } } };
    expect(plan.request.body.properties).toEqual({ backlog_type: 'opt-1' });
  });

  it('rejects a malformed --set before sending anything', async () => {
    const run = await runCli(
      ['idea', 'create', '--product', 'SLC', '--title', 'hello', '--set', 'oops', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('key=value');
  });

  it('requires --title', async () => {
    const run = await runCli(['idea', 'create', '--product', 'SLC', '--json'], []);
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
    const run = await runCli(['idea', 'update', 'i1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('nothing to update');
  });

  it('sends only the fields passed', async () => {
    const run = await runCli(
      ['idea', 'update', 'i1', '--title', 'new title', '--json'],
      [ideaDetail, () => jsonResponse({ id: 'i1', title: 'new title', is_archived: 0 })],
    );
    expect(run.exit).toBe(0);
    expect(mutations(run)).toHaveLength(1);
    expect(mutations(run)[0]?.method).toBe('PATCH');
    expect(mutations(run)[0]?.body).toEqual({ title: 'new title' });
  });

  it('resolves --state against the product of the idea itself, with no --type anywhere', async () => {
    const run = await runCli(
      ['idea', 'update', 'SLC-1', '--state', '开发中', '--dry-run', '--json'],
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
      ['idea', 'update', 'i1', '--state-id', 'st-anything', '--dry-run', '--json'],
      [ideaDetail],
    );
    const plan = parseStdout(run) as { request: { body: unknown } };
    expect(plan.request.body).toEqual({ state_id: 'st-anything' });
    // one GET for the idea, nothing else
    expect(run.calls).toHaveLength(1);
  });

  it('prints the product states on stderr when the server rejects a state change', async () => {
    const run = await runCli(
      ['idea', 'update', 'i1', '--state-id', 'bogus', '--json'],
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

describe('meta lookups', () => {
  const cases: Array<[string, string]> = [
    ['idea-states', '/v1/ship/idea/states'],
    ['idea-priorities', '/v1/ship/idea/priorities'],
    ['idea-suites', '/v1/ship/idea/suites'],
    ['idea-properties', '/v1/ship/idea/properties'],
    ['product-members', '/v1/ship/products/prod-1/members'],
    ['ticket-states', '/v1/ship/ticket/states'],
    ['ticket-priorities', '/v1/ship/ticket/priorities'],
    ['ticket-types', '/v1/ship/ticket/types'],
    ['ticket-channels', '/v1/ship/ticket/channels'],
    ['ticket-properties', '/v1/ship/ticket/properties'],
  ];

  for (const [name, expectedPath] of cases) {
    it(`meta ${name} is product-scoped and emits {values,count}`, async () => {
      const run = await runCli(
        ['meta', name, '--product', 'SLC', '--json'],
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
    const run = await runCli(['meta', 'idea-states', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});
