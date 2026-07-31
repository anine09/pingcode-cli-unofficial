import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { cacheDirPath } from '../src/core/config';
import { ApiError, NotFoundError, UsageError } from '../src/core/errors';
import {
  CACHE_TTL_MS,
  cacheKeyFor,
  clearMetadataCache,
  parseWorkItemRef,
  resolveProject,
  resolveSprint,
  resolveUser,
  resolveWorkItem,
  resolveWorkItemPriority,
  resolveWorkItemState,
  resolveWorkItemType,
  withCacheInvalidation,
} from '../src/core/metadata';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

const NOW = 1_700_000_000_000;

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-meta-'));
  env = { PINGCODE_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Envelope = { page_index?: number; page_size?: number; total?: number; values: unknown[] };

function page(values: unknown[], pageIndex = 0): Envelope {
  return { page_index: pageIndex, page_size: 100, total: values.length, values };
}

function ctxFor(
  responses: Array<() => Response>,
  options: { useCache?: boolean; now?: number; clientId?: string } = {},
) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: options.now ?? NOW,
    env,
    clientId: options.clientId ?? 'client-1',
    clientSecret: 'shh',
    ...(options.useCache === undefined ? {} : { useCache: options.useCache }),
  });
  return { ctx, fake };
}

describe('id pass-through (research §6.8)', () => {
  it('passes a 24-hex project id through untouched', async () => {
    const id = '5eb623f6a70571487ea47000';
    const { ctx } = ctxFor([() => jsonResponse(page([{ id, name: 'Acme' }]))]);
    const resolved = await resolveProject(ctx, id);
    expect(resolved.id).toBe(id);
    expect(resolved.name).toBe('Acme');
  });

  it('passes a slug work-item-type id through untouched', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'story', name: '用户故事' }, { id: 'bug', name: '缺陷' }])),
    ]);
    expect((await resolveWorkItemType(ctx, 'p1', 'story')).id).toBe('story');
  });

  it('passes a 32-hex user id through untouched', async () => {
    const id = 'a0417f68e846aae315c85d24643678a9';
    const { ctx } = ctxFor([() => jsonResponse(page([{ id, name: '张三' }]))]);
    expect((await resolveUser(ctx, id)).id).toBe(id);
  });

  it('assumes an id when a keyword search finds nothing (unbounded set)', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([]))]);
    const resolved = await resolveUser(ctx, 'a0417f68e846aae315c85d24643678a9');
    expect(resolved.id).toBe('a0417f68e846aae315c85d24643678a9');
    expect(resolved.fromCache).toBe(false);
  });
});

describe('name resolution', () => {
  it('prefers exact case-insensitive name equality over fuzzy keyword hits', async () => {
    const { ctx } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'p1', name: 'Acme' },
            { id: 'p2', name: 'Acme Mobile' },
            { id: 'p3', name: 'Acme Web' },
          ]),
        ),
    ]);
    const resolved = await resolveProject(ctx, 'acme');
    expect(resolved.id).toBe('p1');
  });

  it('refuses to pick between ambiguous names and lists the candidates', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'p1', name: 'Acme' }, { id: 'p2', name: 'ACME' }])),
    ]);
    const error = await resolveProject(ctx, 'Acme').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    expect((error as UsageError).message).toContain('p1');
    expect((error as UsageError).message).toContain('p2');
  });

  it('lists what is available when nothing matches', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 'p1', name: 'Acme' }]))]);
    const error = await resolveProject(ctx, 'Nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).hint).toContain('Acme');
  });

  it('rejects an empty input', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([]))]);
    await expect(resolveProject(ctx, '   ')).rejects.toBeInstanceOf(UsageError);
  });

  it('matches users by username, email or display name', async () => {
    const { ctx } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'u1', name: '张三', username: 'zhangsan', email: 'zhangsan@acme.com' },
          ]),
        ),
    ]);
    expect((await resolveUser(ctx, 'zhangsan@acme.com')).id).toBe('u1');
  });

  it('resolves priorities and sprints the same way', async () => {
    const priorities = ctxFor([() => jsonResponse(page([{ id: 'pr1', name: '高' }]))]);
    expect((await resolveWorkItemPriority(priorities.ctx, 'p1', '高')).id).toBe('pr1');

    const sprints = ctxFor([() => jsonResponse(page([{ id: 'sp1', name: 'Sprint 1' }]))]);
    const resolved = await resolveSprint(sprints.ctx, 'p1', 'sprint 1');
    expect(resolved.id).toBe('sp1');
    expect(new URL(sprints.fake.urls()[0] ?? '').pathname).toBe('/v1/pjm/projects/p1/sprints');
  });
});

describe('state resolution needs a type (design §6)', () => {
  it('is a UsageError (exit 2) when --type is missing', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse(page([]))]);
    const error = await resolveWorkItemState(ctx, { projectId: 'p1', input: 'Done' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    expect((error as UsageError).message).toContain('--type');
    expect(fake.calls).toHaveLength(0);
  });

  it('can pass a value straight through when the caller insists it is an id', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse(page([]))]);
    const resolved = await resolveWorkItemState(ctx, {
      projectId: 'p1',
      input: 'abc123',
      assumeIdWhenTypeUnknown: true,
    });
    expect(resolved.id).toBe('abc123');
    expect(fake.calls).toHaveLength(0);
  });

  it('queries project_id + work_item_type_id when a type is known', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse(page([{ id: 's1', name: '已完成' }, { id: 's2', name: '进行中' }])),
    ]);
    const resolved = await resolveWorkItemState(ctx, {
      projectId: 'p1',
      typeId: 'story',
      input: '已完成',
    });
    expect(resolved.id).toBe('s1');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/pjm/work_item/states');
    expect(url.searchParams.get('work_item_type_id')).toBe('story');
  });
});

describe('cache behaviour (design §6)', () => {
  it('reuses a cached candidate list on the second call', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'p1', name: 'Acme' }]))]);
    const first = await resolveProject(ctx, 'Acme');
    const second = await resolveProject(ctx, 'Acme');
    expect(fake.calls).toHaveLength(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(readdirSync(cacheDirPath(env)).length).toBe(1);
  });

  it('keys the cache by client id, so two apps never share it', async () => {
    const keyA = cacheKeyFor({ apiBase: 'https://open.pingcode.com', clientId: 'a', kind: 'project' });
    const keyB = cacheKeyFor({ apiBase: 'https://open.pingcode.com', clientId: 'b', kind: 'project' });
    const keyOtherHost = cacheKeyFor({
      apiBase: 'https://pingcode.acme.com/open',
      clientId: 'a',
      kind: 'project',
    });
    expect(new Set([keyA, keyB, keyOtherHost]).size).toBe(3);
  });

  it('keys states by type, so two types never share a state list', async () => {
    const base = { apiBase: 'https://open.pingcode.com', clientId: 'a', projectId: 'p1', kind: 'work_item_state' } as const;
    expect(cacheKeyFor({ ...base, scope: 'story' })).not.toBe(cacheKeyFor({ ...base, scope: 'bug' }));
  });

  it('re-fetches once the 24h TTL has passed', async () => {
    const first = ctxFor([() => jsonResponse(page([{ id: 'p1', name: 'Acme' }]))]);
    await resolveProject(first.ctx, 'Acme');

    const later = ctxFor([() => jsonResponse(page([{ id: 'p1', name: 'Acme' }]))], {
      now: NOW + CACHE_TTL_MS + 1,
    });
    const resolved = await resolveProject(later.ctx, 'Acme');
    expect(resolved.fromCache).toBe(false);
    expect(later.fake.calls).toHaveLength(1);
  });

  it('--no-cache bypasses reads and writes', async () => {
    const { ctx, fake } = ctxFor(
      [
        () => jsonResponse(page([{ id: 'p1', name: 'Acme' }])),
        () => jsonResponse(page([{ id: 'p1', name: 'Acme' }])),
      ],
      { useCache: false },
    );
    await resolveProject(ctx, 'Acme');
    await resolveProject(ctx, 'Acme');
    expect(fake.calls).toHaveLength(2);
    expect(() => readdirSync(cacheDirPath(env))).toThrow();
  });

  it('refreshes a stale cache when the cached list no longer contains the name', async () => {
    const seed = ctxFor([() => jsonResponse(page([{ id: 'p1', name: 'Old' }]))]);
    await resolveProject(seed.ctx, 'Old');

    const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'p2', name: 'New' }]))]);
    const resolved = await resolveProject(ctx, 'New');
    expect(resolved.id).toBe('p2');
    expect(fake.calls).toHaveLength(1);
  });

  it('clearMetadataCache removes everything', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 'p1', name: 'Acme' }]))]);
    await resolveProject(ctx, 'Acme');
    clearMetadataCache(ctx);
    expect(() => readdirSync(cacheDirPath(env))).toThrow();
  });

  it('survives an unreadable cache file', async () => {
    mkdirSync(cacheDirPath(env), { recursive: true });
    const key = cacheKeyFor({
      apiBase: 'https://open.pingcode.com',
      clientId: 'client-1',
      kind: 'project',
    });
    writeFileSync(path.join(cacheDirPath(env), `${key}.json`), 'not json');
    const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'p1', name: 'Acme' }]))]);
    expect((await resolveProject(ctx, 'Acme')).id).toBe('p1');
    expect(fake.calls).toHaveLength(1);
  });
});

describe('invalidate-and-retry-once', () => {
  const cachedResolution = {
    kind: 'work_item_state' as const,
    input: 'Done',
    id: 's-old',
    name: 'Done',
    fromCache: true,
    cacheKey: 'work_item_state-abc',
  };

  it('retries exactly once with the cache bypassed', async () => {
    const { ctx } = ctxFor([() => jsonResponse({})]);
    const seen: boolean[] = [];
    let attempts = 0;

    const result = await withCacheInvalidation(ctx, [cachedResolution], async (attemptCtx) => {
      seen.push(attemptCtx.useCache);
      attempts += 1;
      if (attempts === 1) throw new ApiError('invalid state_id', { status: 400, code: '100010' });
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(seen).toEqual([true, false]);
    expect(ctx.logLines.join('\n')).toContain('metadata cache');
  });

  it('names the culprit when the retry also fails', async () => {
    const { ctx } = ctxFor([() => jsonResponse({})]);
    let attempts = 0;
    const error = await withCacheInvalidation(ctx, [cachedResolution], async () => {
      attempts += 1;
      throw new ApiError('invalid state_id', { status: 400, code: '100010' });
    }).catch((e: unknown) => e);

    expect(attempts).toBe(2);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('resolved "Done" → s-old from cache');
    expect((error as ApiError).hint).toContain('--no-cache');
    expect((error as ApiError).code).toBe('100010');
  });

  it('does not retry when no id came from cache', async () => {
    const { ctx } = ctxFor([() => jsonResponse({})]);
    let attempts = 0;
    await expect(
      withCacheInvalidation(ctx, [{ ...cachedResolution, fromCache: false }], async () => {
        attempts += 1;
        throw new ApiError('nope', { status: 400 });
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(attempts).toBe(1);
  });

  it('does not retry a usage error', async () => {
    const { ctx } = ctxFor([() => jsonResponse({})]);
    let attempts = 0;
    await expect(
      withCacheInvalidation(ctx, [cachedResolution], async () => {
        attempts += 1;
        throw new UsageError('empty patch');
      }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(attempts).toBe(1);
  });
});

describe('work item references', () => {
  it('accepts ids, short ids, identifiers and pasted URLs', () => {
    expect(parseWorkItemRef('5eb623f6a70571487ea47000')).toEqual({
      kind: 'id_or_short_id',
      value: '5eb623f6a70571487ea47000',
    });
    expect(parseWorkItemRef('1bAqLmTG')).toEqual({ kind: 'id_or_short_id', value: '1bAqLmTG' });
    expect(parseWorkItemRef('SCR-5')).toEqual({ kind: 'identifier', value: 'SCR-5' });
    expect(parseWorkItemRef(' scr-12 ')).toEqual({ kind: 'identifier', value: 'scr-12' });
    expect(parseWorkItemRef('https://acme.pingcode.com/pjm/workitems/1bAqLmTG')).toEqual({
      kind: 'id_or_short_id',
      value: '1bAqLmTG',
    });
    expect(
      parseWorkItemRef('https://acme.pingcode.com/pjm/workitems/1bAqLmTG?tab=detail#c1'),
    ).toEqual({ kind: 'id_or_short_id', value: '1bAqLmTG' });
    expect(parseWorkItemRef('https://acme.pingcode.com/pjm/workitems/SCR-5')).toEqual({
      kind: 'identifier',
      value: 'SCR-5',
    });
    expect(() => parseWorkItemRef('  ')).toThrow(UsageError);
    expect(() => parseWorkItemRef('https://acme.pingcode.com')).toThrow(UsageError);
  });

  it('resolves a short id with one GET and reports project/type/state', async () => {
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse({
          id: 'w-real',
          short_id: '1bAqLmTG',
          identifier: 'SCR-5',
          title: 'hello',
          project: { id: 'p1', name: 'Acme' },
          type: { id: 'story', name: '用户故事' },
          state: { id: 's1', name: '进行中' },
        }),
    ]);
    const locator = await resolveWorkItem(ctx, '1bAqLmTG');
    expect(locator).toEqual({
      id: 'w-real',
      identifier: 'SCR-5',
      shortId: '1bAqLmTG',
      title: 'hello',
      projectId: 'p1',
      typeId: 'story',
      stateId: 's1',
      stateName: '进行中',
    });
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/pjm/work_items/1bAqLmTG');
  });

  it('resolves an identifier through ?identifier=', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse(page([{ id: 'w-real', identifier: 'SCR-5' }])),
    ]);
    const locator = await resolveWorkItem(ctx, 'SCR-5');
    expect(locator.id).toBe('w-real');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/pjm/work_items');
    expect(url.searchParams.get('identifier')).toBe('SCR-5');
  });

  it('is a NotFoundError when an identifier matches nothing', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([]))]);
    const error = await resolveWorkItem(ctx, 'SCR-999').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(5);
  });

  it('is a UsageError when an identifier is ambiguous', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'w1' }, { id: 'w2' }])),
    ]);
    await expect(resolveWorkItem(ctx, 'SCR-5')).rejects.toBeInstanceOf(UsageError);
  });
});
