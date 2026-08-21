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
import { resolveWorkItemType, type ResolveResult } from '../src/core/metadata';
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

function typesPage(): Response {
  return jsonResponse({
    page_index: 0,
    page_size: 100,
    total: 2,
    values: [
      { id: 'task', name: '任务' },
      { id: 'bug', name: '缺陷' },
    ],
  });
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

  it('re-resolves and re-sends exactly once when the refreshed id is different', async () => {
    const { ctx } = ctxFor([statesPage]);
    const resolveCalls: boolean[] = [];
    const sent: unknown[] = [];

    await expect(
      runWrite(
        ctx,
        async (attemptCtx) => {
          resolveCalls.push(attemptCtx.useCache);
          // The genuine stale-cache case: bypassing the cache finds another id.
          const id = attemptCtx.useCache ? 'stale-id' : 'fresh-id';
          return { resolutions: [{ ...cachedResolution, id }], value: { state_id: id } };
        },
        async (_ctx, value) => {
          sent.push(value);
          throw new ApiError('参数错误', { code: '100000', status: 400 });
        },
      ),
    ).rejects.toBeInstanceOf(ApiError);

    // first pass with the cache, second pass with it bypassed
    expect(resolveCalls).toEqual([true, false]);
    expect(sent).toEqual([{ state_id: 'stale-id' }, { state_id: 'fresh-id' }]);
  });

  // S7b: the id-diff gate. The API conflates "your id is stale" with "that value
  // is refused here" (research/s7-smoke.md F5), so the retry is decided by
  // whether re-resolution changed anything — never by the error's code.
  it('re-resolves but does NOT re-send when the refreshed ids are identical', async () => {
    const { ctx } = ctxFor([statesPage]);
    const resolveCalls: boolean[] = [];
    let sends = 0;

    const failure = await runWrite(
      ctx,
      async (attemptCtx) => {
        resolveCalls.push(attemptCtx.useCache);
        return { resolutions: [cachedResolution], value: { state_id: 'stale-id' } };
      },
      async () => {
        sends += 1;
        throw new ApiError('工单状态不存在', { code: '100702', status: 400 });
      },
    ).catch((error: unknown) => error);

    expect(resolveCalls).toEqual([true, false]);
    // exactly one mutating request left the process
    expect(sends).toBe(1);
    // …and the original failure is reported verbatim, not annotated with a
    // retry that never happened
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe('工单状态不存在');
    expect((failure as ApiError).code).toBe('100702');
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

describe('--type on update / transition (S8b, F1)', () => {
  const program = buildProgram();

  function leaf(name: string): Command {
    const parent = program.commands.find((command) => command.name() === 'project');
    if (parent === undefined) throw new Error('project group missing');
    const group = parent.commands.find((command) => command.name() === 'work-item');
    if (group === undefined) throw new Error('project work-item group missing');
    const found = group.commands.find((command) => command.name() === name);
    if (found === undefined) throw new Error(`project work-item ${name} missing`);
    return found;
  }

  it('exists on update and transition, and says it does not modify the type', () => {
    for (const name of ['update', 'transition']) {
      const option = leaf(name).options.find((candidate) => candidate.long === '--type');
      expect(option, name).toBeDefined();
      expect(option?.description).toContain('--state <name>');
      expect(option?.description).toContain('candidate states');
      expect(option?.description).toContain('does NOT modify the type');
    }
  });

  it('keeps --type off the list of fields that make a patch non-empty', () => {
    // `update <ref> --type task` alone is still an empty patch: --type is never sent.
    const hintFlags = leaf('update')
      .options.filter((option) => option.long !== undefined)
      .map((option) => option.long);
    expect(hintFlags).toContain('--type');
    expect(hintFlags).toContain('--state-id');
  });

  it('resolves a state name against a --type-resolved type, as update does', async () => {
    // update/transition run exactly this pair: type name → type id → state name.
    const { ctx, fake } = ctxFor([typesPage, statesPage]);
    const type = await resolveWorkItemType(ctx, 'p1', 'task');
    expect(type.id).toBe('task');
    const state = await resolveStateFlags(ctx, { state: 'In Progress' }, {
      projectId: 'p1',
      typeId: type.id,
    });
    expect(state?.id).toBe('st-doing');
    expect(fake.urls()[0]).toContain('/v1/pjm/work_item/types?project_id=p1');
    expect(fake.urls()[1]).toContain('work_item_type_id=task');
  });

  it('names only flags that exist when --type is missing', async () => {
    const { ctx } = ctxFor([statesPage]);
    const error = await resolveStateFlags(ctx, { state: 'Done' }, { projectId: 'p1' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UsageError);
    const hint = (error as UsageError).hint ?? '';
    expect(hint).toContain('--type <name|id>');
    expect(hint).toContain('--state-id <id>');
    // the old wording blamed the payload's missing `type`, which is not actionable
    expect(hint).not.toContain('did not report a type');
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
