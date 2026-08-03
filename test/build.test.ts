import { describe, expect, it } from 'vitest';
import { parseBuildRecord } from '../src/api/parse';
import {
  createBuild,
  deleteBuild,
  getBuild,
  iterateBuilds,
  listBuilds,
  updateBuild,
} from '../src/api/build';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { CATALOG } from '../src/core/catalog';
import { ENDPOINTS } from '../src/core/endpoints';
import { DryRunHalt } from '../src/core/errors';
import { META_KINDS } from '../src/core/metadata';
import { collect } from '../src/core/paginate';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * S1d: the 构建记录 API wrappers, their paths and their error mapping.
 *
 * Injected `fetch`, zero network. Every assertion is either a wire fact (method, path,
 * query, body) or a behaviour observed live on 2026-08-04 and recorded in
 * `core/endpoints.ts` / design D14 — the useful ones here are the *absences*, because
 * they are what a later contributor would "complete":
 *
 *  - **no query parameter on the list.** Five plausible filters were probed live and
 *    every one was silently ignored, so `listBuilds` must not accept one. Asserted, not
 *    just commented, because adding `?identifier=` looks like an obvious improvement.
 *  - **no `replace`/`put` wrapper** (design D8.4), while the catalog still carries the
 *    endpoint so `pingcode api PUT …` reaches it.
 *  - **no name→id resolver kind**, because a build `identifier` is not unique and there
 *    is no filter to look one up with even if it were.
 *
 * The command layer lives in `test/buildCommands.test.ts`.
 */

const NOW = 1_700_000_000_000;

/** Live ids from the S1d smoke, kept as realistic 24-hex shapes. */
const BUILD = '6a70c1eb919cce9794f01acb';
const WORK_ITEM = '6a221c5d22cc7d25d68cafdb';

function ctxFor(responses: Array<() => Response>, options: { dryRun?: boolean } = {}) {
  const fake = createFakeFetch(responses);
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
    useCache: false,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { ctx, fake };
}

function envelope(values: unknown[], page = { page_index: 0, page_size: 100 }): Response {
  return jsonResponse({ ...page, total: values.length, values });
}

/** The create body every test starts from — all seven required fields. */
const CREATE = {
  name: 'cli-smoke unit-test',
  identifier: '9001',
  provider: 'jenkins',
  status: 'success',
  start_at: 1785700000,
  end_at: 1785700038,
  duration: 38,
} as const;

describe('build endpoint paths', () => {
  it('addresses builds at the organisation root, with no parent segment', () => {
    // Design D14: nothing in this family is scoped by a platform, repository or
    // project. If a parent segment ever appears here, every `build` leaf's flag
    // surface is wrong.
    expect(ENDPOINTS.buildRecords).toBe('/v1/build/builds');
    expect(ENDPOINTS.buildRecord(BUILD)).toBe(`/v1/build/builds/${BUILD}`);
  });

  it('percent-encodes the id rather than trusting its shape', () => {
    expect(ENDPOINTS.buildRecord('a/b c')).toBe('/v1/build/builds/a%2Fb%20c');
  });

  it('matches the catalog, so the refined and generic layers agree', () => {
    const paths = new Set(
      CATALOG.filter((entry) => entry.module === 'build').map((entry) => entry.path),
    );
    expect(paths).toEqual(new Set(['/v1/build/builds', '/v1/build/builds/{build_id}']));
  });

  it('is one family of six verbs upstream, five of which are wrapped', () => {
    const methods = CATALOG.filter((entry) => entry.module === 'build')
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    expect(methods).toEqual([
      'DELETE /v1/build/builds/{build_id}',
      'GET /v1/build/builds',
      'GET /v1/build/builds/{build_id}',
      'PATCH /v1/build/builds/{build_id}',
      'POST /v1/build/builds',
      'PUT /v1/build/builds/{build_id}',
    ]);
  });

  it('declares its own scope pair, not scm’s', () => {
    // `devops:build`, not `devops:code`: a token that can write commits cannot write
    // builds. That is the one thing a caller cannot discover by trying, short of a 403.
    const scopes = new Set(
      CATALOG.filter((entry) => entry.module === 'build').flatMap((entry) => entry.scopes),
    );
    expect(scopes).toEqual(new Set(['read:devops:build', 'write:devops:build']));
    for (const entry of CATALOG.filter((e) => e.module === 'build')) {
      expect(entry.tokenType, entry.id).toBe('ENT');
    }
  });
});

describe('build normalisation', () => {
  it('keeps the flat fields, defaults work_items and preserves unknown ones', () => {
    const build = parseBuildRecord({
      id: BUILD,
      url: 'https://open.pingcode.com/v1/build/builds/x',
      name: 'cli-smoke unit-test',
      identifier: '9001',
      provider: 'jenkins',
      status: 'success',
      start_at: 1785700000,
      end_at: 1785700038,
      duration: 38,
      job_url: null,
      result_overview: '',
      future_field: 'kept',
    });

    expect(build).toMatchObject({ id: BUILD, identifier: '9001', duration: 38 });
    // `null` and `''` are both normalised away by the shared parse layer (design
    // §14.5) — live, a build that was created without them carries `job_url: null`
    // and `result_overview: ''`, so both spellings really do occur.
    expect(build.job_url).toBeUndefined();
    expect(build.result_overview).toBeUndefined();
    expect(build.future_field).toBe('kept');
    // Never `undefined`: call sites render the identifiers without a null check.
    expect(build.work_items).toEqual([]);
  });

  it('keeps a linked work item’s identifier, which is what writes are keyed on', () => {
    const build = parseBuildRecord({
      id: BUILD,
      work_items: [{ id: WORK_ITEM, identifier: 'YYHC-10', title: 'a story', type: 'epic' }],
    });
    expect(build.work_items[0]?.identifier).toBe('YYHC-10');
    expect(build.work_items[0]?.id).toBe(WORK_ITEM);
  });

  it('does not turn a missing duration into 0', () => {
    // "not reported" and "zero seconds" are different answers, and all three numbers
    // are caller-supplied, so inventing one would be inventing data.
    const build = parseBuildRecord({ id: BUILD });
    expect(build.duration).toBeUndefined();
    expect(build.start_at).toBeUndefined();
  });
});

describe('build records api', () => {
  it('lists builds with paging and no filter at all', async () => {
    const { ctx, fake } = ctxFor([() => envelope([{ id: BUILD, identifier: '9001' }])]);
    const page = await listBuilds(ctx, { pageIndex: 1, pageSize: 2 });

    const url = fake.urls()[0] ?? '';
    expect(fake.calls[0]?.method).toBe('GET');
    expect(url).toContain('/v1/build/builds?');
    expect(url).toContain('page_index=1');
    expect(url).toContain('page_size=2');
    expect(page.values[0]?.identifier).toBe('9001');
  });

  it('offers no way to send a filter, because upstream honours none', () => {
    // Live 2026-08-04: `?identifier=`, `?name=`, `?status=`, `?provider=` and
    // `?work_item_id=` each returned every row. A wrapper parameter for any of them
    // would promise filtering the server does not do (D11.2), so the *signature* is
    // the enforcement: `listBuilds(ctx, page)` has no query slot.
    expect(listBuilds).toHaveLength(1);
    expect(iterateBuilds).toHaveLength(1);
  });

  it('walks every page of builds', async () => {
    const { ctx } = ctxFor([
      () => envelope([{ id: 'b1' }], { page_index: 0, page_size: 1 }),
      () => envelope([{ id: 'b2' }], { page_index: 1, page_size: 1 }),
      () => envelope([], { page_index: 2, page_size: 1 }),
    ]);
    const values = await collect(iterateBuilds(ctx, { pageSize: 1 }));
    expect(values.map((build) => build.id)).toEqual(['b1', 'b2']);
  });

  it('gets one build by id', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BUILD })]);
    await getBuild(ctx, BUILD);
    expect(fake.urls()[0]).toContain(`/v1/build/builds/${BUILD}`);
  });

  it('creates a build, sending the seven required fields verbatim', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BUILD })]);
    await createBuild(ctx, { ...CREATE, work_item_identifiers: ['YYHC-10'] });

    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.urls()[0]).toContain('/v1/build/builds');
    expect(fake.calls[0]?.body).toEqual({ ...CREATE, work_item_identifiers: ['YYHC-10'] });
  });

  it('omits the optional fields it was not given', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BUILD })]);
    await createBuild(ctx, CREATE);
    expect(fake.calls[0]?.body).toEqual(CREATE);
  });

  it('patches with PATCH, never PUT, and can clear the work-item links', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BUILD })]);
    await updateBuild(ctx, BUILD, { status: 'failure', work_item_identifiers: [] });

    expect(fake.calls[0]?.method).toBe('PATCH');
    // `[]` must survive `compact`, which drops only `undefined`: an empty array is how
    // a caller removes every link (live-verified replace semantics).
    expect(fake.calls[0]?.body).toEqual({ status: 'failure', work_item_identifiers: [] });
  });

  it('deletes a build and returns the record that went', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BUILD, name: 'cli-smoke dup' })]);
    const deleted = await deleteBuild(ctx, BUILD);

    expect(fake.calls[0]?.method).toBe('DELETE');
    expect(fake.urls()[0]).toContain(`/v1/build/builds/${BUILD}`);
    // The command layer echoes the resolved identity in its confirmation, so the
    // response body has to come back rather than being discarded.
    expect(deleted.name).toBe('cli-smoke dup');
  });

  it('sends nothing on a write under --dry-run, while reads still run', async () => {
    const { ctx, fake } = ctxFor([() => jsonResponse({ id: BUILD })], { dryRun: true });
    await expect(createBuild(ctx, CREATE)).rejects.toBeInstanceOf(DryRunHalt);
    await expect(deleteBuild(ctx, BUILD)).rejects.toBeInstanceOf(DryRunHalt);
    expect(fake.calls).toHaveLength(0);

    await getBuild(ctx, BUILD);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('build not-found mapping (exit 5, from HTTP 400)', () => {
  // S1d smoke, 2026-08-04: `100203 'build'资源不存在` on GET, PATCH **and** DELETE with
  // a syntactically valid but nonexistent 24-hex id, and again on the GET after a
  // successful delete. One code, three verbs, one meaning — the judgement that earned
  // scm's six rows their place.
  async function failing(
    code: string,
    message: string,
    call: (ctx: ReturnType<typeof ctxFor>['ctx']) => Promise<unknown>,
  ) {
    const { ctx } = ctxFor([() => jsonResponse({ code, message }, { status: 400 })]);
    return await call(ctx).catch((error: unknown) => error);
  }

  it('maps a missing build on every verb that can name one', async () => {
    for (const call of [
      (ctx: ReturnType<typeof ctxFor>['ctx']) => getBuild(ctx, BUILD),
      (ctx: ReturnType<typeof ctxFor>['ctx']) => updateBuild(ctx, BUILD, { status: 'failure' }),
      (ctx: ReturnType<typeof ctxFor>['ctx']) => deleteBuild(ctx, BUILD),
    ]) {
      expect(await failing('100203', "'build'资源不存在", call)).toMatchObject({
        kind: 'not_found',
        exitCode: 5,
        code: '100203',
      });
    }
  });

  it('leaves the enum and required-field rejections on exit 7', async () => {
    // Neither is an absence. `100008` is additionally **cross-module** (testhub answers
    // it for a missing `start_at` too), so mapping it would pollute every module.
    for (const [code, message] of [
      ['100003', "'provider'不是有效的字符串(不是有效的枚举值)"],
      ['100004', "'start_at'不是有效的数字(数值不是有效的时间戳)"],
      ['100008', "'start_at'是必填字段"],
    ] as const) {
      expect(
        await failing(code, message, (ctx) => createBuild(ctx, { ...CREATE, provider: 'nope' })),
      ).toMatchObject({ kind: 'api', exitCode: 7, code });
    }
  });
});

describe('no PUT and no resolver reach the refined layer', () => {
  it('exposes no replace wrapper, while the catalog keeps the endpoint', async () => {
    const build = (await import('../src/api/build')) as Record<string, unknown>;
    expect(Object.keys(build).filter((name) => /replace|put/i.test(name))).toEqual([]);

    // Excluding a verb from the refined layer is a UX decision, not a capability
    // removal: `pingcode api PUT /v1/build/builds/<id>` must still work.
    const puts = CATALOG.filter((entry) => entry.module === 'build' && entry.method === 'PUT');
    expect(puts.map((entry) => entry.path)).toEqual(['/v1/build/builds/{build_id}']);
  });

  it('adds no metadata kind for build records', () => {
    // A build `identifier` is **not unique** (two `"9001"` rows were accepted live) and
    // the list honours no filter, so there is nothing to resolve a name against — and a
    // 24 h cached list of records that are created on every CI run would be a
    // stale-answer generator. Same call S1b made for branches, only stronger.
    expect(META_KINDS.filter((kind) => kind.startsWith('build'))).toEqual([]);
  });

  it('keeps exactly one delete wrapper, the family’s fifth verb', async () => {
    const build = (await import('../src/api/build')) as Record<string, unknown>;
    expect(Object.keys(build).filter((name) => /^delete/.test(name))).toEqual(['deleteBuild']);
  });
});
