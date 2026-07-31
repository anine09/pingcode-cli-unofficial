import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseNumberFlag,
  parseTimestampFlag,
  readPaging,
  requireFlag,
  resolveStateFlags,
  runWrite,
} from '../src/cli/commands/common';
import { addGlobalOptions, readGlobalOptions } from '../src/cli/globals';
import { buildProgram } from '../src/cli/program';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import type { Ctx } from '../src/core/context';
import { ApiError, UsageError } from '../src/core/errors';
import type { ResolveResult } from '../src/core/metadata';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * Behaviour of the S7 command layer that does not need a live API: the
 * `--state` / `--state-id` split (design §6, resolved inconsistency), flag
 * parsing, `--all`/paging validation, the resolve-again-on-retry write path, and
 * global flags appearing after a subcommand.
 */

const NOW = 1_700_000_000_000;

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-cmd-'));
  env = { PINGCODE_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctxFor(responses: Array<() => Response>): {
  ctx: Ctx;
  fake: ReturnType<typeof createFakeFetch>;
} {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
    env,
    clientId: 'client-1',
    clientSecret: 'shh',
  });
  return { ctx, fake };
}

function statesPage(): Response {
  return jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'st-todo', name: 'To Do' },
      { id: 'st-doing', name: 'In Progress' },
    ],
  });
}

describe('--state vs --state-id (design §6)', () => {
  it('resolves a name when the type is known', async () => {
    const { ctx, fake } = ctxFor([statesPage]);
    const resolved = await resolveStateFlags(ctx, { state: 'In Progress' }, {
      projectId: 'p1',
      typeId: 'task',
    });
    expect(resolved?.id).toBe('st-doing');
    expect(fake.urls()[0]).toContain('work_item_type_id=task');
  });

  it('is a UsageError when a name has no type to resolve against', async () => {
    const { ctx, fake } = ctxFor([statesPage]);
    const error = await resolveStateFlags(ctx, { state: 'In Progress' }, { projectId: 'p1' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain('--state <name> requires --type');
    // the hint must name the escape hatch, or the user is stuck
    expect((error as UsageError).hint).toContain('--state-id');
    expect(fake.calls).toHaveLength(0);
  });

  it('passes --state-id through with no lookup and no type', async () => {
    const { ctx, fake } = ctxFor([statesPage]);
    const resolved = await resolveStateFlags(ctx, { stateId: 'st-doing' }, { projectId: 'p1' });
    expect(resolved?.id).toBe('st-doing');
    expect(resolved?.cacheKey).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects --state together with --state-id', async () => {
    const { ctx } = ctxFor([statesPage]);
    await expect(
      resolveStateFlags(ctx, { state: 'Done', stateId: 'st-doing' }, { projectId: 'p1' }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('returns nothing when neither flag was given', async () => {
    const { ctx } = ctxFor([statesPage]);
    expect(await resolveStateFlags(ctx, {}, { projectId: 'p1' })).toBeUndefined();
  });
});

describe('flag parsing', () => {
  it('accepts unix seconds and dates for timestamps', () => {
    expect(parseTimestampFlag('1730000000', '--end-at')).toBe(1730000000);
    expect(parseTimestampFlag('2026-01-31', '--end-at')).toBe(Date.parse('2026-01-31') / 1000);
    expect(parseTimestampFlag(undefined, '--end-at')).toBeUndefined();
    expect(() => parseTimestampFlag('yesterday', '--end-at')).toThrow(UsageError);
  });

  it('validates numbers and required values', () => {
    expect(parseNumberFlag('3.5', '--story-points')).toBe(3.5);
    expect(() => parseNumberFlag('lots', '--story-points')).toThrow(UsageError);
    expect(requireFlag(' SCR-5 ', '<work-item>')).toBe('SCR-5');
    expect(() => requireFlag('  ', '<work-item>')).toThrow(UsageError);
  });

  it('validates paging flags against the API caps', () => {
    expect(readPaging({})).toEqual({ pageIndex: 0, pageSize: 30, all: false, limit: 500 });
    expect(readPaging({ page: '2', pageSize: '100', all: true, limit: '10' })).toEqual({
      pageIndex: 2,
      pageSize: 100,
      all: true,
      limit: 10,
    });
    expect(() => readPaging({ pageSize: '101' })).toThrow(UsageError);
    expect(() => readPaging({ page: '-1' })).toThrow(UsageError);
    expect(() => readPaging({ limit: '0' })).toThrow(UsageError);
  });
});

describe('runWrite (design §6 invalidate-on-rejection)', () => {
  const cachedResolution: ResolveResult = {
    kind: 'work_item_state',
    input: 'Done',
    id: 'stale-id',
    name: 'Done',
    fromCache: true,
    cacheKey: 'work_item_state-abc',
  };

  it('re-resolves and re-sends exactly once when a cached id is rejected', async () => {
    const { ctx } = ctxFor([statesPage]);
    const resolveCalls: boolean[] = [];
    let sends = 0;

    await expect(
      runWrite(
        ctx,
        async (attemptCtx) => {
          resolveCalls.push(attemptCtx.useCache);
          return { resolutions: [cachedResolution], value: { state_id: 'stale-id' } };
        },
        async () => {
          sends += 1;
          throw new ApiError('参数错误', { code: '100000', status: 400 });
        },
      ),
    ).rejects.toBeInstanceOf(ApiError);

    // first pass with the cache, second pass with it bypassed
    expect(resolveCalls).toEqual([true, false]);
    expect(sends).toBe(2);
  });

  it('does not retry when nothing came from the cache', async () => {
    const { ctx } = ctxFor([statesPage]);
    let sends = 0;
    await expect(
      runWrite(
        ctx,
        async () => ({ resolutions: [{ ...cachedResolution, fromCache: false }], value: 1 }),
        async () => {
          sends += 1;
          throw new ApiError('nope');
        },
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(sends).toBe(1);
  });

  it('returns the value on the happy path without re-resolving', async () => {
    const { ctx } = ctxFor([statesPage]);
    let resolves = 0;
    const result = await runWrite(
      ctx,
      async () => {
        resolves += 1;
        return { resolutions: [], value: 'input' };
      },
      async (_ctx, value) => `sent:${value}`,
    );
    expect(result).toBe('sent:input');
    expect(resolves).toBe(1);
  });
});

describe('global flags after the subcommand', () => {
  function parseAt(argv: string[]): ReturnType<typeof readGlobalOptions> {
    const program = buildProgram();
    const probe = addGlobalOptions(new Command('probe'), { hidden: true });
    let captured: ReturnType<typeof readGlobalOptions> | undefined;
    probe.action(() => {
      captured = readGlobalOptions(probe);
    });
    program.addCommand(probe);
    program.parse(['node', 'pingcode', ...argv]);
    if (captured === undefined) throw new Error('action did not run');
    return captured;
  }

  it('reads flags typed after the subcommand', () => {
    expect(parseAt(['probe', '--json', '--dry-run', '--no-cache', '--verbose', '--host', 'https://x.example.com'])).toEqual({
      host: 'https://x.example.com',
      json: true,
      dryRun: true,
      useCache: false,
      verbose: true,
    });
  });

  it('still reads flags typed before the subcommand', () => {
    expect(parseAt(['--json', 'probe'])).toMatchObject({ json: true, useCache: true });
  });

  it('lets the innermost explicit value win over the root default', () => {
    expect(parseAt(['probe'])).toMatchObject({ json: false, useCache: true, dryRun: false });
  });
});
