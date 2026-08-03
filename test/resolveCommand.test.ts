import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerResolveCommands } from '../src/cli/commands/resolve';
import { addGlobalOptions } from '../src/cli/globals';
import { captureOutput } from '../src/cli/output';
import { HELP_WIDTH } from '../src/cli/program';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { cacheDirPath } from '../src/core/config';
import { exitCodeFor } from '../src/core/errors';
import { RESOLVABLE_KINDS } from '../src/core/metadata';
import { createFakeFetch, jsonResponse, type FakeCall } from './helpers/fake';

/**
 * `pingcode resolve …` end to end, with `fetch` replaced at the global boundary and
 * the config directory redirected to a temp dir. No network, no real credentials.
 *
 * What is proven here and nowhere else (design D4.4):
 *
 *  1. **stdout under `--json` is the `ResolveResult`, verbatim** — same field names
 *     the engine hands the refined commands, because the whole point is
 *     `$(pingcode resolve … --json | jq -r .id)`.
 *  2. **The generated subcommands actually resolve**, each against the endpoint,
 *     query parameter and parent placement its registry row declares — including the
 *     rows where the parent goes in the *path* rather than the query.
 *  3. **`--parent` accepts a name**, resolved through the parent kind's own row, so
 *     an agent never has to look an id up by hand to look another id up.
 *  4. The refusals: a missing `--parent` is exit 2 before any IO, and the two kinds
 *     no name addresses are not registered at all.
 *
 * The resolution *semantics* (id pass-through, exact-name matching, ambiguity,
 * caching, the invalidating retry) belong to `test/metadata.test.ts` and its two
 * siblings, which F4 left byte-identical on purpose. This file only proves the
 * command layer hands them the right arguments.
 */

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-resolve-cmd-'));
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      clientId: 'test-client',
      clientSecret: 'shh',
      token: {
        accessToken: 'tok',
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

/** A root program carrying only the `resolve` group, so this file depends on no other. */
function buildResolveProgram(): Command {
  const program = new Command();
  program
    .name('pingcode')
    .configureHelp({ helpWidth: HELP_WIDTH })
    .showHelpAfterError()
    // Mirrors `buildProgram()`, whose root settings every leaf inherits — a hand-built
    // root without them tests a tree the CLI never runs.
    .allowExcessArguments(false)
    .exitOverride();
  addGlobalOptions(program);
  registerResolveCommands(program);
  return program;
}

type CliRun = { stdout: string; stderr: string; exit: number; calls: FakeCall[] };

async function runCli(argv: string[], responses: Array<() => Response> = []): Promise<CliRun> {
  const fake = createFakeFetch(responses.length === 0 ? [() => jsonResponse({})] : responses);
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
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch as unknown as typeof globalThis.fetch;

  let exit = 0;
  try {
    await buildResolveProgram().parseAsync(['node', 'pingcode', ...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
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

  return { stdout, stderr, exit, calls: fake.calls };
}

const page = (values: unknown[]) => () =>
  jsonResponse({ page_index: 0, page_size: 100, total: values.length, values });

function parseStdout(run: CliRun): Record<string, unknown> {
  expect(run.stdout.trim(), `stdout was not JSON:\n${run.stdout}${run.stderr}`).not.toBe('');
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

function urlOf(run: CliRun, index = 0): URL {
  return new URL(run.calls[index]?.url ?? 'https://x.invalid/');
}

// ---------------------------------------------------------------------------
// the output contract
// ---------------------------------------------------------------------------

describe('--json stdout is the ResolveResult, verbatim (design D4.4)', () => {
  it('resolves a project name and prints exactly the engine\'s own fields', async () => {
    const run = await runCli(
      ['resolve', 'project', '移动端 App', '--json'],
      [page([{ id: '5f2a', name: '移动端 App', identifier: 'APP' }])],
    );

    expect(run.exit).toBe(0);
    // Field names are the contract: `jq -r .id` in a shell substitution is the
    // documented use, so renaming or prettifying any of these breaks callers.
    expect(parseStdout(run)).toEqual({
      kind: 'project',
      input: '移动端 App',
      id: '5f2a',
      name: '移动端 App',
      fromCache: false,
      cacheKey: expect.stringMatching(/^project-[0-9a-f]{32}$/),
    });
    expect(urlOf(run).pathname).toBe('/v1/pjm/projects');
  });

  it('passes an id through untouched, and says so', async () => {
    const run = await runCli(
      ['resolve', 'project', '5f2a', '--json'],
      [page([{ id: '5f2a', name: '移动端 App' }])],
    );
    const result = parseStdout(run);
    expect(result.id).toBe('5f2a');
    expect(result.input).toBe('5f2a');
    expect(result.name).toBe('移动端 App');
  });

  it('prints a human field block without --json, and nothing on stdout but that', async () => {
    const run = await runCli(['resolve', 'project', 'App'], [page([{ id: '5f2a', name: 'App' }])]);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('id');
    expect(run.stdout).toContain('5f2a');
    expect(run.stdout).not.toContain('{');
  });

  it('caches the candidate list, and --no-cache does not', async () => {
    const first = await runCli(
      ['resolve', 'project', 'App', '--json'],
      [page([{ id: '5f2a', name: 'App' }])],
    );
    expect(first.exit).toBe(0);
    expect(readdirSync(cacheDirPath({ PINGCODE_CONFIG_DIR: dir }))).toHaveLength(1);

    const second = await runCli(
      ['resolve', 'project', 'App', '--json', '--no-cache'],
      [page([{ id: '5f2a', name: 'App' }])],
    );
    expect(parseStdout(second).fromCache).toBe(false);
    expect(second.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// the generated surface resolves through the row it was generated from
// ---------------------------------------------------------------------------

describe('each subcommand uses the endpoint and scoping its row declares', () => {
  it('sends the parent as a query parameter when the row names one', async () => {
    const run = await runCli(
      ['resolve', 'ship-idea-state', '已评审', '--parent', 'prod-1', '--json'],
      [page([{ id: 'st-1', name: '已评审' }])],
    );

    expect(run.exit).toBe(0);
    // Exactly one request: `--parent` is an id, taken verbatim, so a lookup an agent
    // already did is never repeated here.
    expect(run.calls).toHaveLength(1);
    const url = urlOf(run);
    expect(url.pathname).toBe('/v1/ship/idea/states');
    expect(url.searchParams.get('product_id')).toBe('prod-1');
    expect(parseStdout(run).kind).toBe('ship-idea-state');
  });

  it('puts the parent in the path when the row builds its path from it', async () => {
    const run = await runCli(
      ['resolve', 'testhub-plan', 'Sprint 4', '--parent', 'lib-1', '--json'],
      [page([{ id: 'plan-1', name: 'Sprint 4', short_id: 'ab12cd34' }])],
    );

    expect(run.exit).toBe(0);
    expect(urlOf(run).pathname).toBe('/v1/testhub/libraries/lib-1/plans');
    expect(urlOf(run).searchParams.get('library_id')).toBeNull();
    expect(parseStdout(run).id).toBe('plan-1');
  });

  it('accepts a plan short_id, because the row registers it as an alias', async () => {
    const run = await runCli(
      ['resolve', 'testhub-plan', 'ab12cd34', '--parent', 'lib-1', '--json'],
      [page([{ id: 'plan-1', name: 'Sprint 4', short_id: 'ab12cd34' }])],
    );
    expect(parseStdout(run).id).toBe('plan-1');
  });

  it('scopes the same kind differently per parent, and says so in the cache key', async () => {
    // ship and testhub ids are per-product/per-library even when they look org-global
    // (ship GOTCHA #26), so two parents must never share a cached candidate list.
    const first = await runCli(
      ['resolve', 'ship-idea-state', '已评审', '--parent', 'prod-1', '--json'],
      [page([{ id: 'st-1', name: '已评审' }])],
    );
    const second = await runCli(
      ['resolve', 'ship-idea-state', '已评审', '--parent', 'prod-2', '--json'],
      [page([{ id: 'st-2', name: '已评审' }])],
    );

    expect(second.calls).toHaveLength(1);
    expect(parseStdout(second).id).toBe('st-2');
    expect(parseStdout(first).cacheKey).not.toBe(parseStdout(second).cacheKey);
  });

  it('takes both references of the one two-key lookup', async () => {
    const run = await runCli(
      ['resolve', 'work_item_state', '进行中', '--parent', 'proj-1', '--type', 'type-7', '--json'],
      [page([{ id: 'state-3', name: '进行中' }])],
    );

    expect(run.exit).toBe(0);
    // `GET /v1/pjm/work_item/states` requires both (research §4).
    const states = urlOf(run);
    expect(states.pathname).toBe('/v1/pjm/work_item/states');
    expect(states.searchParams.get('project_id')).toBe('proj-1');
    expect(states.searchParams.get('work_item_type_id')).toBe('type-7');
    expect(parseStdout(run).id).toBe('state-3');
  });

  it('searches by keywords for the one unbounded set, and passes an id through', async () => {
    const run = await runCli(['resolve', 'user', 'wang', '--json'], [page([])]);
    expect(run.exit).toBe(0);
    expect(urlOf(run).searchParams.get('keywords')).toBe('wang');
    // An empty keyword search is not proof of a typo, so the input is assumed to be an id.
    const result = parseStdout(run);
    expect(result).toMatchObject({ kind: 'user', id: 'wang' });
    // `printJson` drops undefined fields, so an unknown name is an absent key rather
    // than a fabricated one.
    expect(result.name).toBeUndefined();
  });

  it('takes no --parent for the org-level testhub lookup', async () => {
    const run = await runCli(
      ['resolve', 'testhub-case-important-level', '高', '--json'],
      [page([{ id: 'lv-1', name: '高' }])],
    );
    expect(run.exit).toBe(0);
    expect(urlOf(run).pathname).toBe('/v1/testhub/case_important_levels');
    expect(urlOf(run).searchParams.get('library_id')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

describe('refusals happen before any request', () => {
  it('is exit 2 with no IO when a scoped kind is missing --parent', async () => {
    const run = await runCli(['resolve', 'ship-idea-state', '已评审', '--json']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--parent');
  });

  it('is exit 2 with no IO when the two-key lookup is missing --type', async () => {
    const run = await runCli(['resolve', 'work_item_state', '进行中', '--parent', 'proj-1']);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--type');
  });

  it('does not register the kinds no name addresses', async () => {
    for (const kind of ['ship-ticket-state-plan', 'ship-ticket-state-flow']) {
      const run = await runCli(['resolve', kind, 'anything']);
      expect(run.exit, kind).toBe(2);
      expect(run.calls, kind).toHaveLength(0);
    }
  });

  it('reports zero matches with the candidates the token can see', async () => {
    const run = await runCli(
      ['resolve', 'project', 'Nope'],
      [page([{ id: 'a', name: 'Mobile' }, { id: 'b', name: 'Web' }])],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('no project matches "Nope"');
    expect(run.stderr).toContain('Mobile (a)');
  });

  it('refuses an ambiguous name rather than picking one', async () => {
    const run = await runCli(
      ['resolve', 'project', 'Mobile'],
      [page([{ id: 'a', name: 'Mobile' }, { id: 'b', name: 'mobile' }])],
    );
    expect(run.exit).toBe(2);
    expect(run.stderr).toContain('matches 2 projects');
  });
});

// ---------------------------------------------------------------------------
// resolve list
// ---------------------------------------------------------------------------

describe('resolve list is local discovery', () => {
  it('prints every resolvable kind and sends nothing', async () => {
    const run = await runCli(['resolve', 'list', '--json']);
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(0);

    const payload = JSON.parse(run.stdout) as {
      count: number;
      values: { kind: string; parent: string }[];
    };
    expect(payload.count).toBe(RESOLVABLE_KINDS.length);
    expect(payload.values.map((row) => row.kind)).toEqual([...RESOLVABLE_KINDS]);
    // The PARENT column is the flag an agent has to fill in next, so it must be real.
    for (const row of payload.values) {
      if (row.parent !== '') expect(RESOLVABLE_KINDS).toContain(row.parent);
    }
  });

  it('renders a table without --json', async () => {
    const run = await runCli(['resolve', 'list']);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('KIND');
    expect(run.stdout).toContain('ship-idea-state');
    expect(run.stdout).toContain('/v1/testhub/libraries/{parent}/plans');
  });
});
