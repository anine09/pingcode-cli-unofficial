import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { cacheDirPath } from '../src/core/config';
import { ApiError, UsageError } from '../src/core/errors';
import {
  CACHE_TTL_MS,
  cacheKeyFor,
  resolveCaseImportantLevel,
  resolveCaseState,
  resolveCaseType,
  resolveRunStatus,
  resolveTestLibrary,
  resolveTestPlan,
  resolveTestPlanType,
  resolveTestSuite,
  RetryWouldBeIdentical,
  SUITE_PATH_SEPARATOR,
  withCacheInvalidation,
} from '../src/core/metadata';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S3 / Gate G1: the testhub resolvers.
 *
 * Three invariants are asserted directly rather than implied:
 *  - **no id shape is ever validated** — 24-hex ids, 8-char `short_id`s and bare
 *    slugs all pass through untouched;
 *  - **the library is the parent scope**, so every library-scoped kind keys its
 *    cache by `library_id` — except `testhub-case-important-level`, which is
 *    genuinely org-level ([th#40]), and `testhub-library`, which is the bootstrap
 *    hop and has no parent at all;
 *  - **the suite tree joins on a `parent` reference object**, not a `parent_id`
 *    scalar. Reading the wrong field would produce a forest of roots and make
 *    cross-branch ambiguity undetectable.
 */

const NOW = 1_700_000_000_000;

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-testhub-meta-'));
  env = { PINGCODE_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function page(values: unknown[], pageIndex = 0): unknown {
  return { page_index: pageIndex, page_size: 100, total: values.length, values };
}

function ctxFor(
  responses: Array<() => Response>,
  options: { useCache?: boolean; now?: number } = {},
) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: options.now ?? NOW,
    env,
    clientId: 'client-1',
    clientSecret: 'shh',
    ...(options.useCache === undefined ? {} : { useCache: options.useCache }),
  });
  return { ctx, fake };
}

const BASE = { apiBase: 'https://open.pingcode.com', clientId: 'client-1' } as const;

const LIBRARY_SCOPED = [
  'testhub-suite',
  'testhub-case-state',
  'testhub-case-type',
  'testhub-run-status',
  'testhub-plan',
  'testhub-plan-type',
] as const;

describe('cache keys (Gate G1)', () => {
  it('keys every library-scoped kind by the library id', () => {
    for (const kind of LIBRARY_SCOPED) {
      const a = cacheKeyFor({ ...BASE, parentId: 'lib-a', kind });
      const b = cacheKeyFor({ ...BASE, parentId: 'lib-b', kind });
      expect(a, kind).not.toBe(b);
    }
  });

  it('never lets two kinds share a key under the same library', () => {
    const keys = LIBRARY_SCOPED.map((kind) => cacheKeyFor({ ...BASE, parentId: 'lib-a', kind }));
    expect(new Set(keys).size).toBe(LIBRARY_SCOPED.length);
  });

  it('omits the library from testhub-case-important-level — it is org-level ([th#40])', () => {
    // Two libraries must land on the *same* key: the endpoint takes no
    // library_id, so keying per library would shard one identical list.
    const noParent = cacheKeyFor({ ...BASE, kind: 'testhub-case-important-level' });
    const viaLibraryA = cacheKeyFor({
      ...BASE,
      parentId: undefined,
      kind: 'testhub-case-important-level',
    });
    expect(viaLibraryA).toBe(noParent);

    // And it must not collide with a library-scoped kind that happens to have no parent.
    expect(noParent).not.toBe(cacheKeyFor({ ...BASE, kind: 'testhub-case-state' }));
    expect(noParent.startsWith('testhub-case-important-level-')).toBe(true);
  });

  it('gives testhub-library no parent — it is the bootstrap hop', () => {
    const key = cacheKeyFor({ ...BASE, kind: 'testhub-library' });
    expect(key.startsWith('testhub-library-')).toBe(true);
    expect(key).not.toBe(cacheKeyFor({ ...BASE, parentId: 'lib-a', kind: 'testhub-library' }));
  });

  it('never collides with a ship kind under the same parent id', () => {
    const testhub = cacheKeyFor({ ...BASE, parentId: 'x', kind: 'testhub-suite' });
    const ship = cacheKeyFor({ ...BASE, parentId: 'x', kind: 'ship-idea-suite' });
    expect(testhub).not.toBe(ship);
  });

  it('still separates two client ids and two hosts', () => {
    const one = cacheKeyFor({ ...BASE, parentId: 'lib-a', kind: 'testhub-case-state' });
    const other = cacheKeyFor({
      ...BASE,
      clientId: 'client-2',
      parentId: 'lib-a',
      kind: 'testhub-case-state',
    });
    const host = cacheKeyFor({
      apiBase: 'https://pingcode.example.com/open',
      clientId: 'client-1',
      parentId: 'lib-a',
      kind: 'testhub-case-state',
    });
    expect(new Set([one, other, host]).size).toBe(3);
  });
});

describe('library resolution (the bootstrap hop)', () => {
  it('resolves a library by name', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse(page([{ id: 'lib-1', identifier: 'LIB', name: '核心回归库' }])),
    ]);
    expect((await resolveTestLibrary(ctx, '核心回归库')).id).toBe('lib-1');
    expect(new URL(fake.urls()[0] ?? '').pathname).toBe('/v1/testhub/libraries');
  });

  it('resolves a library by its identifier, which the API cannot search on ([th#12])', async () => {
    // `keywords` matches the name only, so the identifier is an alias matched
    // client-side over the full list — same as ship products.
    const { ctx, fake } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'lib-1', identifier: 'LIB', name: '核心回归库' },
            { id: 'lib-2', identifier: 'API', name: '接口库' },
          ]),
        ),
    ]);
    expect((await resolveTestLibrary(ctx, 'LIB')).id).toBe('lib-1');
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('keywords')).toBeNull();
  });

  it('is case-insensitive on the name', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 'lib-1', name: 'Core Regression' }]))]);
    expect((await resolveTestLibrary(ctx, 'core regression')).id).toBe('lib-1');
  });

  it('refuses to guess between two libraries with the same name', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'lib-1', name: 'Core' }, { id: 'lib-2', name: 'core' }])),
    ]);
    const error = await resolveTestLibrary(ctx, 'Core').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    expect((error as UsageError).message).toContain('lib-1');
    expect((error as UsageError).message).toContain('lib-2');
  });

  it('sends no library_id of its own — there is no parent to scope by', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'lib-1', name: 'Core' }]))]);
    await resolveTestLibrary(ctx, 'Core');
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('library_id')).toBeNull();
  });
});

describe('library-scoped config lookups send ?library_id= on the SINGULAR segment', () => {
  const cases = [
    ['case state', resolveCaseState, '/v1/testhub/case/states'],
    ['case type', resolveCaseType, '/v1/testhub/case/types'],
    ['run status', resolveRunStatus, '/v1/testhub/run/statuses'],
  ] as const;

  for (const [label, resolve, expected] of cases) {
    it(`${label} → ${expected}`, async () => {
      const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'x1', name: '通过' }]))]);
      expect((await resolve(ctx, 'lib-1', '通过')).id).toBe('x1');
      const url = new URL(fake.urls()[0] ?? '');
      expect(url.pathname).toBe(expected);
      expect(url.searchParams.get('library_id')).toBe('lib-1');
      // The plural resource paths must never be reached by a lookup.
      expect(url.pathname).not.toContain('/cases/');
      expect(url.pathname).not.toContain('/runs/');
    });
  }

  it('caches per library, so two libraries never share a candidate list', async () => {
    const first = ctxFor([() => jsonResponse(page([{ id: 'st-a', name: '待评审' }]))]);
    expect((await resolveCaseState(first.ctx, 'lib-a', '待评审')).id).toBe('st-a');

    // A different library must miss the cache and fetch again.
    const second = ctxFor([() => jsonResponse(page([{ id: 'st-b', name: '待评审' }]))]);
    const resolved = await resolveCaseState(second.ctx, 'lib-b', '待评审');
    expect(resolved.id).toBe('st-b');
    expect(resolved.fromCache).toBe(false);
    expect(second.fake.calls).toHaveLength(1);

    // The same library hits it.
    const third = ctxFor([() => jsonResponse(page([{ id: 'st-a', name: '待评审' }]))]);
    expect((await resolveCaseState(third.ctx, 'lib-a', '待评审')).fromCache).toBe(true);
    expect(third.fake.calls).toHaveLength(0);
    expect(readdirSync(cacheDirPath(env)).length).toBe(2);
  });

  it('re-fetches once the 24h TTL has passed', async () => {
    const seed = ctxFor([() => jsonResponse(page([{ id: 'st-a', name: '待评审' }]))]);
    await resolveCaseState(seed.ctx, 'lib-a', '待评审');

    // One millisecond inside the window is still a hit.
    const inside = ctxFor([() => jsonResponse(page([{ id: 'st-a', name: '待评审' }]))], {
      now: NOW + CACHE_TTL_MS,
    });
    expect((await resolveCaseState(inside.ctx, 'lib-a', '待评审')).fromCache).toBe(true);
    expect(inside.fake.calls).toHaveLength(0);

    const outside = ctxFor([() => jsonResponse(page([{ id: 'st-a', name: '待评审' }]))], {
      now: NOW + CACHE_TTL_MS + 1,
    });
    expect((await resolveCaseState(outside.ctx, 'lib-a', '待评审')).fromCache).toBe(false);
    expect(outside.fake.calls).toHaveLength(1);
  });

  it('--no-cache bypasses both the read and the write', async () => {
    const { ctx, fake } = ctxFor(
      [
        () => jsonResponse(page([{ id: 'st-a', name: '待评审' }])),
        () => jsonResponse(page([{ id: 'st-a', name: '待评审' }])),
      ],
      { useCache: false },
    );
    await resolveCaseState(ctx, 'lib-a', '待评审');
    await resolveCaseState(ctx, 'lib-a', '待评审');
    expect(fake.calls).toHaveLength(2);
    expect(() => readdirSync(cacheDirPath(env))).toThrow();
  });

  it('names the configuration scope when a state or status lookup finds nothing (GOTCHA #2)', async () => {
    // A bare 403 does not explain that `case/states` and `run/statuses` need a
    // different scope from their sibling `case/types`.
    const states = ctxFor([() => jsonResponse(page([{ id: 'st1', name: '待评审' }]))]);
    const stateError = await resolveCaseState(states.ctx, 'lib-1', 'Nope').catch(
      (caught: unknown) => caught,
    );
    expect((stateError as UsageError).hint).toContain('pcp:read:testhub:configuration');
    // the candidate list stays the actionable half of the message
    expect((stateError as UsageError).hint).toContain('待评审');

    const statuses = ctxFor([() => jsonResponse(page([{ id: 'rs1', name: '通过' }]))]);
    const statusError = await resolveRunStatus(statuses.ctx, 'lib-1', 'Nope').catch(
      (caught: unknown) => caught,
    );
    expect((statusError as UsageError).hint).toContain('pcp:read:testhub:configuration');
    expect((statusError as UsageError).hint).toContain('localized name');
  });

  it('resolves a run status by its localized name — there is no slug to match (GOTCHA #5)', async () => {
    const { ctx } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'rs-pass', name: '通过' },
            { id: 'rs-block', name: '受阻' },
            { id: 'rs-not-start', name: '未测' },
            { id: 'rs-custom', name: '待复测', is_system: 0 },
          ]),
        ),
    ]);
    expect((await resolveRunStatus(ctx, 'lib-1', '通过')).id).toBe('rs-pass');
    // A tenant-defined status is in no documented table and must still resolve.
    const custom = ctxFor([
      () => jsonResponse(page([{ id: 'rs-custom', name: '待复测', is_system: 0 }])),
    ]);
    expect((await resolveRunStatus(custom.ctx, 'lib-2', '待复测')).id).toBe('rs-custom');
  });
});

describe('important levels are org-level', () => {
  it('sends no library_id and hits the underscored plural path ([th#40])', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'il-p0', name: 'P0' }]))]);
    expect((await resolveCaseImportantLevel(ctx, 'P0')).id).toBe('il-p0');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/case_important_levels');
    expect(url.searchParams.get('library_id')).toBeNull();
  });

  it('shares one cache entry across libraries, unlike every other lookup', async () => {
    const seed = ctxFor([() => jsonResponse(page([{ id: 'il-p0', name: 'P0' }]))]);
    await resolveCaseImportantLevel(seed.ctx, 'P0');
    expect(readdirSync(cacheDirPath(env)).length).toBe(1);

    // No library is involved, so a second call anywhere is a cache hit.
    const again = ctxFor([() => jsonResponse(page([{ id: 'il-p0', name: 'P0' }]))]);
    expect((await resolveCaseImportantLevel(again.ctx, 'P0')).fromCache).toBe(true);
    expect(again.fake.calls).toHaveLength(0);
    expect(readdirSync(cacheDirPath(env)).length).toBe(1);
  });

  it('explains that there is no per-library variant when nothing matches', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 'il-p0', name: 'P0' }]))]);
    const error = await resolveCaseImportantLevel(ctx, 'P9').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).hint).toContain('organisation-wide');
    expect((error as UsageError).hint).toContain('P0');
  });
});

describe('suite tree', () => {
  // Joined by `parent` **reference objects**. A `parent_id` scalar would make
  // every node a root and every path a bare name.
  //
  // `paths` mirrors the live shape verified 2026-08-02: the *parent* chain,
  // excluding the node itself, `''` at a root — never the node's own path.
  const tree = [
    { id: 'su-login', name: '登录', paths: '', parent: null },
    { id: 'su-login-sms', name: '短信验证码', parent: { id: 'su-login' }, paths: '登录' },
    { id: 'su-pay', name: '支付', paths: '', parent: null },
    { id: 'su-pay-sms', name: '短信验证码', parent: { id: 'su-pay' }, paths: '支付' },
  ];

  it('lists suites under the library, not on a singular config segment', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'su-login', name: '登录' }]))]);
    expect((await resolveTestSuite(ctx, 'lib-1', '登录')).id).toBe('su-login');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/libraries/lib-1/suites');
    // Resolution must see the whole tree to detect a collision at all.
    expect(url.searchParams.get('parent_id')).toBeNull();
  });

  it('flattens a parent-ref tree into computed paths (the forest-of-roots case)', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page(tree))]);
    // '支付' is unambiguous, and resolving it proves the tree loaded at all.
    expect((await resolveTestSuite(ctx, 'lib-1', '支付')).id).toBe('su-pay');

    // The computed path is typeable, which is only possible if `parent.id` was read.
    const byPath = ctxFor([() => jsonResponse(page(tree))]);
    expect(
      (await resolveTestSuite(byPath.ctx, 'lib-2', `登录${SUITE_PATH_SEPARATOR}短信验证码`)).id,
    ).toBe('su-login-sms');
  });

  it('never registers the server `paths` as an alias — a child must not claim its parent name', async () => {
    // The exact two-node tree observed live: root `登录` with `paths: ''`, child
    // `短信验证码` with `paths: '登录'`. Registering `paths` verbatim aliased the
    // child to `登录` and turned an unambiguous root name into an exit-2
    // "ambiguous suite name".
    const live = [
      { id: '6a6ef9018359e0328fce7c16', name: '登录', paths: '', parent: null },
      {
        id: '6a6ef90111c48dd2a042368f',
        name: '短信验证码',
        paths: '登录',
        parent: { id: '6a6ef9018359e0328fce7c16', name: '登录', paths: '' },
      },
    ];

    const { ctx } = ctxFor([() => jsonResponse(page(live))]);
    const resolved = await resolveTestSuite(ctx, 'lib-1', '登录');
    expect(resolved.id).toBe('6a6ef9018359e0328fce7c16');

    // …and the child is still reachable by its own computed full path.
    const byPath = ctxFor([() => jsonResponse(page(live))]);
    expect(
      (await resolveTestSuite(byPath.ctx, 'lib-2', `登录${SUITE_PATH_SEPARATOR}短信验证码`)).id,
    ).toBe('6a6ef90111c48dd2a042368f');
  });

  it('a root suite with an empty `paths` resolves by its bare name', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'su-login', name: '登录', paths: '', parent: null }])),
    ]);
    expect((await resolveTestSuite(ctx, 'lib-1', '登录')).id).toBe('su-login');
  });

  it('errors with both full paths when a name collides across branches', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page(tree))]);
    const error = await resolveTestSuite(ctx, 'lib-1', '短信验证码').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UsageError);
    const message = (error as UsageError).message;
    expect(message).toContain(`登录${SUITE_PATH_SEPARATOR}短信验证码`);
    expect(message).toContain(`支付${SUITE_PATH_SEPARATOR}短信验证码`);
    expect(message).toContain('su-login-sms');
    expect(message).toContain('su-pay-sms');
    // never a silent pick
    expect((error as UsageError).exitCode).toBe(2);
  });

  it('survives a cyclic parent chain rather than hanging', async () => {
    const { ctx } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'a', name: 'A', parent: { id: 'b' } },
            { id: 'b', name: 'B', parent: { id: 'a' } },
          ]),
        ),
    ]);
    expect((await resolveTestSuite(ctx, 'lib-1', 'A')).id).toBe('a');
  });

  it('ignores a suite `type` field — testhub suites have no discriminator', async () => {
    // Ship suites carry `type` ∈ product|module; [th#9] documents none here, so a
    // stray value must not change resolution.
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'su1', name: '登录', type: 'whatever' }])),
    ]);
    expect((await resolveTestSuite(ctx, 'lib-1', '登录')).id).toBe('su1');
  });
});

describe('plans', () => {
  it('lists plans under the library, with the id in the path not the query ([th#59])', async () => {
    const { ctx, fake } = ctxFor([
      () => jsonResponse(page([{ id: 'p1', name: 'Sprint 3 回归', short_id: 'zz99' }])),
    ]);
    expect((await resolveTestPlan(ctx, 'lib-1', 'Sprint 3 回归')).id).toBe('p1');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/libraries/lib-1/plans');
    expect(url.searchParams.get('library_id')).toBeNull();
  });

  it('resolves a plan short_id to a real id — writes cannot take a short_id (GOTCHA #19)', async () => {
    const { ctx } = ctxFor([
      () => jsonResponse(page([{ id: 'p1', name: 'Sprint 3 回归', short_id: 'zz99' }])),
    ]);
    const resolved = await resolveTestPlan(ctx, 'lib-1', 'zz99');
    expect(resolved.id).toBe('p1');
    expect(resolved.name).toBe('Sprint 3 回归');
  });
});

describe('plan types', () => {
  const types = () =>
    jsonResponse(
      page([
        { id: 'pt-plain', name: '普通测试' },
        { id: 'pt-sprint', name: '迭代测试' },
        { id: 'pt-release', name: '发布测试' },
      ]),
    );

  it('resolves a plan type by its exact name', async () => {
    const { ctx } = ctxFor([types]);
    const resolved = await resolveTestPlanType(ctx, 'lib-1', '普通测试');
    expect(resolved.id).toBe('pt-plain');
    expect(resolved.kind).toBe('testhub-plan-type');
  });

  it('is addressed under the library, with the id in the path not the query ([th#60])', async () => {
    const { ctx, fake } = ctxFor([types]);
    await resolveTestPlanType(ctx, 'lib-1', '普通测试');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/testhub/libraries/lib-1/plan_types');
    // The `?library_id=` shape belongs to the singular-segment config views.
    expect(url.searchParams.get('library_id')).toBeNull();
  });

  it('is case-insensitive and passes an id through untouched', async () => {
    const upper = ctxFor([() => jsonResponse(page([{ id: 'pt-plain', name: 'Plain Test' }]))]);
    expect((await resolveTestPlanType(upper.ctx, 'lib-1', 'plain test')).id).toBe('pt-plain');

    const byId = ctxFor([types]);
    const resolved = await resolveTestPlanType(byId.ctx, 'lib-1', 'pt-release');
    expect(resolved.id).toBe('pt-release');
    expect(resolved.name).toBe('发布测试');
  });

  it('names `testhub meta plan-types` when nothing matches, and lists the candidates', async () => {
    const { ctx } = ctxFor([types]);
    const error = await resolveTestPlanType(ctx, 'lib-1', 'Nope').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    expect((error as UsageError).hint).toContain('testhub meta plan-types');
    expect((error as UsageError).hint).toContain('普通测试');
  });

  it('carries no configuration-scope hint — plan types are testplan scope', async () => {
    // `case/states` and `run/statuses` need pcp:read:testhub:configuration; this
    // endpoint does not, and a borrowed hint would misdirect a 403 investigation.
    const { ctx } = ctxFor([types]);
    const error = await resolveTestPlanType(ctx, 'lib-1', 'Nope').catch(
      (caught: unknown) => caught,
    );
    expect((error as UsageError).hint).not.toContain('configuration');
  });

  it('refuses to guess between two types with the same name', async () => {
    const { ctx } = ctxFor([
      () =>
        jsonResponse(
          page([
            { id: 'pt-a', name: '回归测试' },
            { id: 'pt-b', name: '回归测试' },
          ]),
        ),
    ]);
    const error = await resolveTestPlanType(ctx, 'lib-1', '回归测试').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain('2 plan types');
    expect((error as UsageError).hint).toContain('pass the id');
  });

  it('rejects an empty input before any request goes out', async () => {
    const { ctx, fake } = ctxFor([types]);
    const error = await resolveTestPlanType(ctx, 'lib-1', '  ').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect(fake.calls).toHaveLength(0);
  });

  it('caches per library, so two libraries never share a candidate list', async () => {
    const first = ctxFor([types]);
    expect((await resolveTestPlanType(first.ctx, 'lib-a', '普通测试')).id).toBe('pt-plain');

    const second = ctxFor([() => jsonResponse(page([{ id: 'pt-other', name: '普通测试' }]))]);
    const resolved = await resolveTestPlanType(second.ctx, 'lib-b', '普通测试');
    expect(resolved.id).toBe('pt-other');
    expect(resolved.fromCache).toBe(false);

    const third = ctxFor([types]);
    expect((await resolveTestPlanType(third.ctx, 'lib-a', '普通测试')).fromCache).toBe(true);
    expect(third.fake.calls).toHaveLength(0);
  });

  it('re-fetches once the 24h TTL has passed', async () => {
    const seed = ctxFor([types]);
    await resolveTestPlanType(seed.ctx, 'lib-a', '普通测试');

    const inside = ctxFor([types], { now: NOW + CACHE_TTL_MS });
    expect((await resolveTestPlanType(inside.ctx, 'lib-a', '普通测试')).fromCache).toBe(true);
    expect(inside.fake.calls).toHaveLength(0);

    const outside = ctxFor([types], { now: NOW + CACHE_TTL_MS + 1 });
    expect((await resolveTestPlanType(outside.ctx, 'lib-a', '普通测试')).fromCache).toBe(false);
    expect(outside.fake.calls).toHaveLength(1);
  });

  it('--no-cache bypasses both the read and the write', async () => {
    const { ctx, fake } = ctxFor([types, types], { useCache: false });
    await resolveTestPlanType(ctx, 'lib-a', '普通测试');
    await resolveTestPlanType(ctx, 'lib-a', '普通测试');
    expect(fake.calls).toHaveLength(2);
    expect(() => readdirSync(cacheDirPath(env))).toThrow();
  });

  it('drops the key and re-resolves once when the server rejects a cached type id', async () => {
    const seed = ctxFor([() => jsonResponse(page([{ id: 'pt-old', name: '普通测试' }]))]);
    await resolveTestPlanType(seed.ctx, 'lib-1', '普通测试');

    const { ctx, fake } = ctxFor([() => jsonResponse(page([{ id: 'pt-new', name: '普通测试' }]))]);
    const first = await resolveTestPlanType(ctx, 'lib-1', '普通测试');
    expect(first.fromCache).toBe(true);
    expect(first.id).toBe('pt-old');
    expect(fake.calls).toHaveLength(0);

    let attempts = 0;
    const ids: string[] = [];
    const result = await withCacheInvalidation(ctx, [first], async (attemptCtx) => {
      attempts += 1;
      const again = await resolveTestPlanType(attemptCtx, 'lib-1', '普通测试');
      ids.push(again.id);
      if (again.id === 'pt-old') throw new ApiError('plan type does not exist', { code: '100000' });
      return again.id;
    });

    expect(attempts).toBe(2);
    expect(result).toBe('pt-new');
    expect(ids).toEqual(['pt-old', 'pt-new']);
  });

  it('says the cache was not the cause when re-resolution produces the same ids', async () => {
    // The S7 case: a rejection that names no cached value — a duplicate plan
    // name (100618 live), a run id the user mistyped (100619) — still reaches
    // the retry, because nothing in a `{code, message}` body says which field
    // was refused. The retry is harmless (RetryWouldBeIdentical blocks the
    // second send), but the warning must not leave "your cache is stale" as the
    // user's last word when the ids came back identical.
    const seed = ctxFor([types]);
    await resolveTestPlanType(seed.ctx, 'lib-1', '普通测试');

    const { ctx, fake } = ctxFor([types]);
    const first = await resolveTestPlanType(ctx, 'lib-1', '普通测试');
    expect(first.fromCache).toBe(true);

    const rejection = new ApiError('同名测试计划已存在', { code: '100618' });
    let sends = 0;
    const error = await withCacheInvalidation(ctx, [first], async (attemptCtx) => {
      const again = await resolveTestPlanType(attemptCtx, 'lib-1', '普通测试');
      if (again.id === first.id && sends > 0) throw new RetryWouldBeIdentical();
      sends += 1;
      throw rejection;
    }).catch((caught: unknown) => caught);

    // The original rejection survives untouched — no cache annotation on it.
    expect(error).toBe(rejection);
    expect((error as ApiError).code).toBe('100618');
    expect((error as ApiError).message).toBe('同名测试计划已存在');

    const logged = ctx.logLines.join('\n');
    expect(logged).toContain('refreshing it and retrying once');
    expect(logged).toContain('the metadata cache was not the cause');
    // and it did not claim the server rejected a cached id
    expect(logged).not.toContain('rejected an id that came from');
    // one send only: the retry never re-issued the write
    expect(sends).toBe(1);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it('exposes no kind discriminator to resolve on (testhub §10.7)', async () => {
    // Only id/url/name/library exist, so "which type needs a sprint_id?" is
    // unanswerable here by design — the server refusal is the answer.
    const { ctx } = ctxFor([types]);
    const resolved = await resolveTestPlanType(ctx, 'lib-1', '迭代测试');
    expect(resolved.id).toBe('pt-sprint');
    expect(resolved.name).toBe('迭代测试');
  });
});

describe('no id shape is ever validated (Gate G1)', () => {
  it('passes 24-hex, 8-char short_id and bare-slug ids through untouched', async () => {
    const hex24 = '5cb9466afda1ce4ca0090005';
    const states = ctxFor([() => jsonResponse(page([{ id: hex24, name: '待评审' }]))]);
    expect((await resolveCaseState(states.ctx, 'lib-1', hex24)).id).toBe(hex24);

    const slug = ctxFor([() => jsonResponse(page([{ id: 'pending', name: '待评审' }]))]);
    expect((await resolveCaseState(slug.ctx, 'lib-2', 'pending')).id).toBe('pending');

    const short = ctxFor([() => jsonResponse(page([{ id: 'ab12cd34', name: '登录' }]))]);
    expect((await resolveTestSuite(short.ctx, 'lib-3', 'ab12cd34')).id).toBe('ab12cd34');

    const upper = ctxFor([() => jsonResponse(page([{ id: 'LIB', identifier: 'LIB' }]))]);
    expect((await resolveTestLibrary(upper.ctx, 'LIB')).id).toBe('LIB');
  });

  it('reports an unmatched value as exit 2 and still lists the candidates', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 'ty1', name: '功能测试' }]))]);
    const error = await resolveCaseType(ctx, 'lib-1', 'Nope').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    expect((error as UsageError).hint).toContain('功能测试');
  });

  it('rejects an empty input before any request goes out', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse(page([]))]);
    const error = await resolveCaseType(ctx, 'lib-1', '   ').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('stale-cache recovery composes with withCacheInvalidation (Gate G1)', () => {
  it('reports a cache key on every testhub resolution, so a write can invalidate it', async () => {
    const { ctx } = ctxFor([() => jsonResponse(page([{ id: 'rs1', name: '通过' }]))]);
    const resolved = await resolveRunStatus(ctx, 'lib-1', '通过');
    // `runWrite` -> `withCacheInvalidation` only retries resolutions that carry a
    // key and came from cache; a null key here would silently disable recovery.
    expect(resolved.cacheKey).not.toBeNull();
    expect(resolved.kind).toBe('testhub-run-status');
  });

  it('drops the key and re-resolves once when the server rejects a cached id', async () => {
    // Warm the cache.
    const seed = ctxFor([() => jsonResponse(page([{ id: 'rs-old', name: '通过' }]))]);
    await resolveRunStatus(seed.ctx, 'lib-1', '通过');

    const { ctx, fake } = ctxFor([
      // the refreshed lookup on the second pass
      () => jsonResponse(page([{ id: 'rs-new', name: '通过' }])),
    ]);
    const first = await resolveRunStatus(ctx, 'lib-1', '通过');
    expect(first.fromCache).toBe(true);
    expect(first.id).toBe('rs-old');
    expect(fake.calls).toHaveLength(0);

    let attempts = 0;
    const ids: string[] = [];
    const result = await withCacheInvalidation(ctx, [first], async (attemptCtx) => {
      attempts += 1;
      const again = await resolveRunStatus(attemptCtx, 'lib-1', '通过');
      ids.push(again.id);
      if (again.id === 'rs-old') throw new ApiError('status does not exist', { code: '100000' });
      return again.id;
    });

    expect(attempts).toBe(2);
    expect(result).toBe('rs-new');
    expect(ids).toEqual(['rs-old', 'rs-new']);
  });
});
