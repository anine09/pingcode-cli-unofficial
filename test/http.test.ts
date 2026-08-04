import { describe, expect, it } from 'vitest';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import type { TokenRecord } from '../src/core/config';
import {
  ApiError,
  AuthError,
  DryRunHalt,
  NotFoundError,
  PermissionError,
  RateLimitError,
  TransportError,
} from '../src/core/errors';
import { MAX_RETRY_WAIT_MS, request } from '../src/core/http';
import { ERROR_CODE_OVERRIDES } from '../src/core/wire';
import { createFakeFetch, createTestContext, emptyResponse, jsonResponse, textResponse } from './helpers/fake';

const NOW = 1_700_000_000_000;
const SECRET = 'super-secret-value-9f3a';

function freshToken(accessToken = 'tok-cached'): TokenRecord {
  return { accessToken, expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW };
}

describe('request: url + headers', () => {
  it('builds the URL, drops nullish params and serialises arrays as CSV', async () => {
    const fake = createFakeFetch(() => jsonResponse({ ok: true }));
    const ctx = createTestContext({ fetch: fake.fetch, token: freshToken(), now: NOW });

    await request(ctx, {
      method: 'GET',
      path: '/v1/pjm/work_items',
      query: {
        project_id: 'p1',
        keywords: undefined,
        state_id: null,
        include_archived: false,
        include_deleted: true,
        page_size: 5,
        include_public_image_token: ['description', 'properties.prop_b'],
        empty: [],
      },
    });

    const url = new URL(fake.urls()[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://open.pingcode.com/v1/pjm/work_items');
    expect(url.searchParams.get('project_id')).toBe('p1');
    expect(url.searchParams.has('keywords')).toBe(false);
    expect(url.searchParams.has('state_id')).toBe(false);
    expect(url.searchParams.has('empty')).toBe(false);
    expect(url.searchParams.get('include_archived')).toBe('false');
    expect(url.searchParams.get('include_deleted')).toBe('true');
    expect(url.searchParams.get('page_size')).toBe('5');
    expect(url.searchParams.get('include_public_image_token')).toBe(
      'description,properties.prop_b',
    );
  });

  it('injects the bearer token and sets JSON content type only on write verbs', async () => {
    const fake = createFakeFetch(() => jsonResponse({ ok: true }));
    const ctx = createTestContext({ fetch: fake.fetch, token: freshToken('tok-1'), now: NOW });

    await request(ctx, { method: 'GET', path: '/v1/pjm/projects' });
    await request(ctx, { method: 'POST', path: '/v1/pjm/work_items', body: { title: 'x' } });

    expect(fake.calls[0]?.headers.Authorization).toBe('Bearer tok-1');
    expect(fake.calls[0]?.headers['Content-Type']).toBeUndefined();
    expect(fake.calls[1]?.headers['Content-Type']).toBe('application/json');
    expect(fake.calls[1]?.body).toEqual({ title: 'x' });
  });

  it('acquires a token when there is none, then uses it', async () => {
    const fake = createFakeFetch([
      () => jsonResponse({ access_token: 'fresh', expires_in: 3600 }),
      () => jsonResponse({ ok: true }),
    ]);
    const ctx = createTestContext({
      fetch: fake.fetch,
      clientId: 'id',
      clientSecret: SECRET,
      now: NOW,
    });

    await request(ctx, { method: 'GET', path: '/v1/pjm/projects' });

    expect(fake.calls).toHaveLength(2);
    expect(fake.urls()[0]).toContain('/v1/auth/token');
    expect(fake.calls[1]?.headers.Authorization).toBe('Bearer fresh');
    // Gate G3: no secret is reachable in any printed output.
    expect(ctx.logLines.join('\n')).not.toContain(SECRET);
  });

  it('skips auth entirely when asked (token endpoint)', async () => {
    const fake = createFakeFetch(() => jsonResponse({ ok: true }));
    const ctx = createTestContext({ fetch: fake.fetch });
    await request(ctx, { method: 'GET', path: '/v1/auth/token', skipAuth: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.headers.Authorization).toBeUndefined();
  });
});

describe('request: dry run (gate G3)', () => {
  it('throws DryRunHalt and sends ZERO requests for a mutating verb', async () => {
    const fake = createFakeFetch(() => {
      throw new Error('a dry run must not send anything');
    });
    const ctx = createTestContext({
      fetch: fake.fetch,
      token: freshToken(),
      now: NOW,
      dryRun: true,
    });

    const error = await request(ctx, {
      method: 'POST',
      path: '/v1/pjm/work_items',
      body: { title: 'hello' },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DryRunHalt);
    expect(fake.calls).toHaveLength(0);
    const halt = error as DryRunHalt;
    expect(halt.plan.method).toBe('POST');
    expect(halt.plan.body).toEqual({ title: 'hello' });
    expect(halt.plan.headers.Authorization).not.toContain('tok-cached');
  });

  it('halts PATCH, PUT and DELETE too', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const fake = createFakeFetch(() => jsonResponse({}));
      const ctx = createTestContext({
        fetch: fake.fetch,
        token: freshToken(),
        now: NOW,
        dryRun: true,
      });
      await expect(request(ctx, { method, path: '/v1/pjm/work_items/1' })).rejects.toBeInstanceOf(
        DryRunHalt,
      );
      expect(fake.calls).toHaveLength(0);
    }
  });

  it('still executes read verbs so names can be resolved to ids', async () => {
    const fake = createFakeFetch(() => jsonResponse({ values: [] }));
    const ctx = createTestContext({
      fetch: fake.fetch,
      token: freshToken(),
      now: NOW,
      dryRun: true,
    });
    await request(ctx, { method: 'GET', path: '/v1/pjm/work_item/types' });
    expect(fake.calls).toHaveLength(1);
  });

  it('redacts the plan URL, so a secret in the query string cannot leak', async () => {
    const fake = createFakeFetch(() => jsonResponse({}));
    const ctx = createTestContext({
      fetch: fake.fetch,
      token: freshToken(),
      now: NOW,
      dryRun: true,
    });
    const error = await request(ctx, {
      method: 'POST',
      path: '/v1/auth/token',
      query: { client_secret: SECRET },
    }).catch((e: unknown) => e);
    expect((error as DryRunHalt).plan.url).not.toContain(SECRET);
  });
});

describe('request: 401 replay (gate G3)', () => {
  it('re-acquires once and replays the original request', async () => {
    const fake = createFakeFetch([
      () => jsonResponse({ message: 'token expired' }, { status: 401 }),
      () => jsonResponse({ access_token: 'tok-2', expires_in: 3600 }),
      () => jsonResponse({ id: 'w1' }),
    ]);
    const ctx = createTestContext({
      fetch: fake.fetch,
      token: freshToken('tok-1'),
      clientId: 'id',
      clientSecret: SECRET,
      now: NOW,
    });

    const result = await request<{ id: string }>(ctx, {
      method: 'GET',
      path: '/v1/pjm/work_items/w1',
    });

    expect(result).toEqual({ id: 'w1' });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]?.headers.Authorization).toBe('Bearer tok-1');
    expect(fake.urls()[1]).toContain('/v1/auth/token');
    expect(fake.calls[2]?.headers.Authorization).toBe('Bearer tok-2');
    expect(fake.urls()[2]).toContain('/v1/pjm/work_items/w1');
  });

  it('a second 401 becomes an AuthError without recursing', async () => {
    const fake = createFakeFetch([
      () => jsonResponse({ message: 'nope' }, { status: 401 }),
      () => jsonResponse({ access_token: 'tok-2', expires_in: 3600 }),
      () => jsonResponse({ code: '100002', message: 'still nope' }, { status: 401 }),
    ]);
    const ctx = createTestContext({
      fetch: fake.fetch,
      token: freshToken('tok-1'),
      clientId: 'id',
      clientSecret: SECRET,
      now: NOW,
    });

    const error = await request(ctx, { method: 'GET', path: '/v1/pjm/projects' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).exitCode).toBe(3);
    // exactly: original → token → replay. No further attempts.
    expect(fake.calls).toHaveLength(3);
  });

  it('does not replay when auth was skipped', async () => {
    const fake = createFakeFetch(() => jsonResponse({ message: 'bad client' }, { status: 401 }));
    const ctx = createTestContext({ fetch: fake.fetch, clientId: 'id', clientSecret: SECRET });
    await expect(
      request(ctx, { method: 'GET', path: '/v1/auth/token', skipAuth: true }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('request: 429 handling', () => {
  it('honours x-pc-retry-after and retries exactly once', async () => {
    const fake = createFakeFetch([
      () =>
        jsonResponse({ code: '100038', message: '请求频率过高' }, {
          status: 429,
          headers: { 'x-pc-retry-after': '7' },
        }),
      () => jsonResponse({ ok: true }),
    ]);
    const ctx = createTestContext({ fetch: fake.fetch, token: freshToken(), now: NOW });

    await request(ctx, { method: 'GET', path: '/v1/pjm/projects' });

    expect(ctx.sleeps).toEqual([7000]);
    expect(fake.calls).toHaveLength(2);
  });

  it('caps the wait at 60s', async () => {
    const fake = createFakeFetch([
      () => jsonResponse({}, { status: 429, headers: { 'x-pc-retry-after': '3600' } }),
      () => jsonResponse({ ok: true }),
    ]);
    const ctx = createTestContext({ fetch: fake.fetch, token: freshToken(), now: NOW });
    await request(ctx, { method: 'GET', path: '/v1/pjm/projects' });
    expect(ctx.sleeps).toEqual([MAX_RETRY_WAIT_MS]);
  });

  it('fails fast when the header is absent', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ code: '100038', message: '请求频率过高' }, { status: 429 }),
    );
    const ctx = createTestContext({ fetch: fake.fetch, token: freshToken(), now: NOW });

    const error = await request(ctx, { method: 'GET', path: '/v1/pjm/projects' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).exitCode).toBe(6);
    expect((error as RateLimitError).code).toBe('100038');
    expect(fake.calls).toHaveLength(1);
    expect(ctx.sleeps).toEqual([]);
  });

  it('gives up after one retry', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ code: '100038' }, { status: 429, headers: { 'x-pc-retry-after': '1' } }),
    );
    const ctx = createTestContext({ fetch: fake.fetch, token: freshToken(), now: NOW });
    const error = await request(ctx, { method: 'GET', path: '/v1/pjm/projects' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(1);
    expect(fake.calls).toHaveLength(2);
  });
});

describe('request: response mapping', () => {
  const ctxWith = (response: () => Response) =>
    createTestContext({
      fetch: createFakeFetch(response).fetch,
      token: freshToken(),
      now: NOW,
    });

  it('treats 201 as success, like every other 2xx', async () => {
    const result = await request<{ id: string }>(
      ctxWith(() => jsonResponse({ id: 'new' }, { status: 201 })),
      { method: 'POST', path: '/v1/pjm/work_items', body: { title: 'x' } },
    );
    expect(result).toEqual({ id: 'new' });
  });

  it('treats an empty 204 body as undefined', async () => {
    const result = await request(ctxWith(() => emptyResponse(204)), {
      method: 'DELETE',
      path: '/v1/pjm/work_items/1',
    });
    expect(result).toBeUndefined();
  });

  it('maps 403 to a PermissionError carrying a scope hint', async () => {
    const error = await request(
      ctxWith(() => jsonResponse({ code: '100039', message: 'no scope' }, { status: 403 })),
      { method: 'GET', path: '/v1/pjm/projects' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).exitCode).toBe(4);
    expect((error as PermissionError).hint).toContain('principal_type');
  });

  it('maps 404 to a NotFoundError', async () => {
    const error = await request(
      ctxWith(() => jsonResponse({ message: 'not found' }, { status: 404 })),
      { method: 'GET', path: '/v1/pjm/work_items/nope' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(5);
  });

  it('surfaces an unknown code verbatim as an ApiError', async () => {
    const error = await request(
      ctxWith(() => jsonResponse({ code: '987654', message: '未知错误' }, { status: 400 })),
      { method: 'POST', path: '/v1/pjm/work_items', body: {} },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).exitCode).toBe(7);
    expect((error as ApiError).code).toBe('987654');
    expect((error as ApiError).message).toContain('未知错误');
    expect((error as ApiError).status).toBe(400);
  });

  it('accepts a numeric code defensively', async () => {
    const error = await request(
      ctxWith(() => jsonResponse({ code: 100000, message: 'boom' }, { status: 500 })),
      { method: 'GET', path: '/v1/pjm/projects' },
    ).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('100000');
  });

  it('raises a TransportError with a snippet for an unparseable body', async () => {
    const error = await request(
      ctxWith(() => textResponse('<html><body>502 Bad Gateway</body></html>')),
      { method: 'GET', path: '/v1/pjm/projects' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).exitCode).toBe(8);
    expect((error as TransportError).message).toContain('502 Bad Gateway');
  });

  it('raises a TransportError when fetch itself fails', async () => {
    const ctx = createTestContext({
      fetch: createFakeFetch(() => {
        throw new TypeError('fetch failed');
      }).fetch,
      token: freshToken(),
      now: NOW,
    });
    const error = await request(ctx, { method: 'GET', path: '/v1/pjm/projects' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toContain('fetch failed');
  });

  it('never leaks a secret into an error message (gate G3)', async () => {
    const ctx = createTestContext({
      fetch: createFakeFetch(() => textResponse('boom', { status: 500 })).fetch,
      token: freshToken(),
      now: NOW,
      verbose: true,
    });
    const error = await request(ctx, {
      method: 'GET',
      path: '/v1/auth/token',
      query: { client_secret: SECRET },
    }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(SECRET);
    expect(ctx.logLines.join('\n')).not.toContain(SECRET);
  });
});

/**
 * The live API answers HTTP 400 where REST convention uses 401/404, which made
 * exits 3 and 5 unreachable (research/s8-smoke.md F2/F3). A small code allowlist
 * overrides the status; everything else keeps status-first behaviour.
 */
describe('request: code-aware overrides (S8b, F2/F3)', () => {
  const ctxWith = (response: () => Response) =>
    createTestContext({
      fetch: createFakeFetch(response).fetch,
      token: freshToken(),
      now: NOW,
    });

  it('maps 400 + 100024 (bad client id/secret) to AuthError, exit 3', async () => {
    const error = await request(
      ctxWith(() =>
        jsonResponse({ code: '100024', message: "'client_id'或'client_secret'错误" }, { status: 400 }),
      ),
      { method: 'GET', path: '/v1/auth/token', skipAuth: true },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).exitCode).toBe(3);
    expect((error as AuthError).code).toBe('100024');
    expect((error as AuthError).status).toBe(400);
    expect((error as AuthError).message).toContain("'client_id'或'client_secret'错误");
  });

  it('maps 400 + 100317 (work item does not exist) to NotFoundError, exit 5', async () => {
    const error = await request(
      ctxWith(() => jsonResponse({ code: '100317', message: '工作项资源不存在' }, { status: 400 })),
      { method: 'GET', path: '/v1/pjm/work_items/000000000000000000000000' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(5);
    expect((error as NotFoundError).code).toBe('100317');
  });

  it("maps 400 + 100303 ('state' does not exist) to NotFoundError, exit 5", async () => {
    const error = await request(
      ctxWith(() => jsonResponse({ code: '100303', message: "'state'资源不存在" }, { status: 400 })),
      { method: 'PATCH', path: '/v1/pjm/work_items/abc', body: { state_id: 'nope' } },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(5);
    expect((error as NotFoundError).code).toBe('100303');
  });

  it('leaves codes outside the allowlist on the status-first mapping', async () => {
    const error = await request(
      ctxWith(() => jsonResponse({ code: '100318', message: '别的错误' }, { status: 400 })),
      { method: 'GET', path: '/v1/pjm/work_items/abc' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).exitCode).toBe(7);
    expect((error as ApiError).code).toBe('100318');
  });

  it('matches on the code only, never on the message text', async () => {
    // Same Chinese wording, unlisted code ⇒ still exit 7.
    const error = await request(
      ctxWith(() => jsonResponse({ code: '999999', message: '工作项资源不存在' }, { status: 400 })),
      { method: 'GET', path: '/v1/pjm/work_items/abc' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    // …and a listed code overrides even a status that would map elsewhere.
    const overridden = await request(
      ctxWith(() => jsonResponse({ code: '100317', message: 'whatever' }, { status: 500 })),
      { method: 'GET', path: '/v1/pjm/work_items/abc' },
    ).catch((e: unknown) => e);
    expect(overridden).toBeInstanceOf(NotFoundError);
  });

  it('exposes the table so the mapping stays reviewable in one place', () => {
    expect(ERROR_CODE_OVERRIDES).toEqual({
      '100024': 'auth',
      '100317': 'not_found',
      '100303': 'not_found',
      '100725': 'not_found',
      '100711': 'not_found',
      '100601': 'not_found',
      '100603': 'not_found',
      '100600': 'not_found',
      // F5: the four cross-object families, plus the wiki page a principal_type=page
      // call names (08-02-full-api-coverage F5 smoke).
      '100045': 'not_found',
      '100051': 'not_found',
      '100077': 'not_found',
      '100801': 'not_found',
      '100903': 'not_found',
      // S1a: the three scm 托管平台 families, each naming the resource that is absent
      // (08-02-full-api-coverage S1a smoke, 2026-08-03). Behaviour is asserted through
      // the wrappers in `test/scm.test.ts`.
      '100200': 'not_found',
      '100202': 'not_found',
      '100209': 'not_found',
      // S1b: 代码分支 / 提交 / 提交引用, same shape again — one stable "this record is
      // absent" code per resource, consistent across verbs (S1b smoke, 2026-08-03,
      // design D12.8). `100201` was observed on GET, PATCH, DELETE *and* on a
      // POST …/refs whose meta_id names no branch; `100206` on GET by id and by SHA.
      // Behaviour is asserted through the wrappers in `test/scm.test.ts`.
      '100201': 'not_found',
      '100206': 'not_found',
      '100207': 'not_found',
      // S1c: 拉取请求 / 代码评审, completing the module (S1c smoke, 2026-08-03, design
      // D13.1 item 5). `100208` was observed on GET, PATCH *and* on a POST of a review
      // under an unknown pull request; `100222` on GET and PATCH, including a real
      // review id addressed under the wrong pull request.
      // Behaviour is asserted through the wrappers in `test/scm.test.ts`.
      '100208': 'not_found',
      '100222': 'not_found',
      // S1d: 构建记录 / 环境 / 部署, the last three DevOps families (S1d smoke,
      // 2026-08-04, design D14.4). `100203` was observed on GET, PATCH **and DELETE**
      // (the only delete in the area); `100204` on GET/PATCH; `100205` on GET/PATCH and
      // on a POST /v1/release/deploys whose `env_id` names no environment.
      // Behaviour is asserted through the wrappers in `test/build.test.ts` and
      // `test/release.test.ts`.
      '100203': 'not_found',
      '100204': 'not_found',
      '100205': 'not_found',
      // S2a: 迭代 / 发布 (S2a smoke, 2026-08-04, design D15.8). `100308` was observed on
      // GET and PATCH — the only two verbs the sprint path has, since there is no
      // sprint delete; `100304` on GET, PATCH **and DELETE**. Both are project-scoped
      // children whose *parent's* absence answers a different code (`100300`), which is
      // deliberately absent from this table: a kanban project — one that plainly exists
      // — also answers `100300` when asked for a sprint.
      // Behaviour is asserted through the wrappers in `test/pjmPlanning.test.ts`.
      '100308': 'not_found',
      '100304': 'not_found',
      // S2b: 工作项关联 / 流转记录 / 项目成员 (S2b smoke, 2026-08-04, design D16). All
      // three are **composite-key** absences — the addressed row exists only as a pair,
      // so a wrong id and a mismatched pair are the same failure. `100351` was observed
      // on GET and DELETE of a link, for an unknown id, for a link id belonging to
      // another work item (the two directions of one link have different ids), and for
      // one already deleted; `1003108` on GET of an unknown transition history — note
      // the seven digits; `100405` on GET and DELETE of a membership, for an unknown id
      // *and* for a real organisation user who is not in the project.
      // Behaviour is asserted through the wrappers in `test/pjmWorkItemWrites.test.ts`.
      //
      // Two codes from the same smoke are deliberately absent, for opposite reasons:
      // `100354` (`'tag'资源不存在`) is `100300`'s mistake again — it names a tag the
      // user can see, because the tag vocabulary is org-wide while the write is
      // project-scoped — and `100357` (`工作项不包含此标签`) *is* a genuine pair absence
      // but its DELETE counterpart answers HTTP 500, so mapping it would split one
      // mistake across two exit codes.
      '100351': 'not_found',
      '1003108': 'not_found',
      '100405': 'not_found',
      // S3: 测试计划 / 执行历史 (S3 smoke, 2026-08-04, design §D17). `100602` was observed
      // on GET **and PATCH** of a plan, for an unknown 24-hex id, an unknown
      // short_id-shaped id, and a real plan addressed under the wrong library — the
      // library segment is validated there, so all three are "no plan at this address".
      // `100642` on GET of an unknown history under a valid run.
      // Behaviour is asserted through the wrappers in `test/testhub.test.ts`.
      //
      // Four codes from the same smoke are deliberately absent, and two of them are
      // instructive: `100619` (`执行用例不存在`) really does mean "no such run" on
      // `GET /runs/{unknown}/histories`, but the same code rejects a whole `runs/bulk`
      // batch, so exit 5 would imply the valid entries landed; and `100643`
      // (`执行历史和测试用例不匹配`) is the mirror image of `100222` above — the vendor
      // calls the mismatched pair a mismatch rather than an absence, and the CLI reports
      // what the API says. `100016` is another batch-level refusal and `100605` a
      // uniqueness conflict.
      '100602': 'not_found',
      '100642': 'not_found',
      // S4: 需求流转记录 (S4 smoke, 2026-08-05, design §D18). `100740` was observed on
      // GET /v1/ship/ideas/{idea}/transition_histories/{history} for an unknown history
      // id **and** for a real history id addressed under a different idea — both
      // segments are enforced there, so both are "no record at this address". It is the
      // fourth transition-history code here after pjm's `1003108` and testhub's
      // `100642`.
      // Behaviour is asserted through the wrappers in `test/ship.test.ts`.
      //
      // Two codes from the same smoke are deliberately absent. `100721`
      // (`产品排期不存在`) reads like an obvious row — it is a per-resource absence on
      // `products/{p}/plans/{unknown}` — but the tenant holds **zero** 需求排期 rows, so
      // the case that disqualified `100354` and `100300` (a row that exists, addressed
      // under the wrong parent) could not be tested, and the same code answers an idea
      // PATCH with an unknown `plan_id`, which is exactly where that confusion would
      // live. `100701` (`产品不存在或无权访问`) is ship's `100300`: a *parent* code shared
      // by the whole product-scoped surface.
      '100740': 'not_found',
    });
  });

  // F5 smoke, 2026-08-03: each generic family has its own 400 not-found code, and one
  // of them (100049) deliberately stays on exit 7 because it is a refused argument
  // rather than a missing row.
  it.each([
    ['100045', '/v1/attachments/000000000000000000000000', '附件不存在'],
    ['100051', '/v1/comments/000000000000000000000000', '评论资源不存在或无权访问'],
    ['100077', '/v1/activities/000000000000000000000000', '活动记录不存在'],
    ['100801', '/v1/relations/000000000000000000000000', '关联关系不存在'],
    ['100903', '/v1/comments', '页面不存在或无权访问'],
  ])('maps cross-object code %s (HTTP 400) to NotFoundError, i.e. exit 5', async (code, path, message) => {
    const error = await request(
      ctxWith(() => jsonResponse({ code, message }, { status: 400 })),
      { method: 'GET', path },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(5);
  });

  it('leaves 100049 on exit 7: an unsupported principal_type is not an absence', async () => {
    const error = await request(
      ctxWith(() =>
        jsonResponse({ code: '100049', message: "不支持的'principal_type'" }, { status: 400 }),
      ),
      { method: 'GET', path: '/v1/relations' },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).exitCode).toBe(7);
  });

  // S7b / research/s7-smoke.md F1: ship answers 400 for a missing record, with
  // one code per resource. Without these rows the same mistake exited 5 on pjm
  // and 7 on ship.
  it.each([
    ['100725', '/v1/ship/ideas/000000000000000000000000', '需求不存在或无权访问'],
    ['100711', '/v1/ship/tickets/000000000000000000000000', '工单不存在或无权访问'],
  ])('maps ship code %s (HTTP 400) to NotFoundError, i.e. exit 5', async (code, path, message) => {
    const error = await request(
      ctxWith(() => jsonResponse({ code, message }, { status: 400 })),
      { method: 'GET', path },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).exitCode).toBe(5);
    expect((error as NotFoundError).code).toBe(code);
  });

  // The state codes stay on exit 7 on purpose: live they also fire for a state
  // that exists but is unreachable under the plan (s7-smoke.md F5).
  it.each(['100719', '100702'])('leaves ship state code %s classified as an api error', async (code) => {
    const error = await request(
      ctxWith(() => jsonResponse({ code, message: '状态不存在' }, { status: 400 })),
      { method: 'PATCH', path: '/v1/ship/tickets/t1', body: { state_id: 'x' } },
    ).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect((error as ApiError).exitCode).toBe(7);
  });

  // S6 / 08-02-testhub-module: testhub answers 400 for a missing record with one
  // code per resource, exactly as pjm and ship do.
  // S8 / 08-02-testhub-bootstrap-leaves added the last one, observed live
  // 2026-08-02: 100600 on five distinct library-scoped endpoints given a bogus
  // library id — same 1006xx family and wording as the two above.
  it.each([
    ['100601', '/v1/testhub/cases/000000000000000000000000', '测试用例不存在或无权限访问'],
    ['100603', '/v1/testhub/runs/000000000000000000000000', '执行用例不存在或无权限访问'],
    [
      '100600',
      '/v1/testhub/libraries/000000000000000000000000/plans',
      '测试库不存在或无权限访问',
    ],
  ])(
    'maps testhub code %s (HTTP 400) to NotFoundError, i.e. exit 5',
    async (code, path, message) => {
      const error = await request(
        ctxWith(() => jsonResponse({ code, message }, { status: 400 })),
        { method: 'GET', path },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).exitCode).toBe(5);
      expect((error as NotFoundError).code).toBe(code);
    },
  );

  // A malformed id and an unknown short_id return the same code as a well-formed
  // but absent one — that stability is what makes keying on the code safe.
  it.each(['not-an-id', 'ZZZZZZZZ', '000000000000000000000000'])(
    'maps testhub 100601 to exit 5 for the id shape %s',
    async (id) => {
      const error = await request(
        ctxWith(() =>
          jsonResponse({ code: '100601', message: '测试用例不存在或无权限访问' }, { status: 400 }),
        ),
        { method: 'GET', path: `/v1/testhub/cases/${id}` },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).exitCode).toBe(5);
    },
  );

  // Codes the S6 smoke saw but deliberately left unmapped: batch rejection,
  // input validation and a genuine 500 are not "this resource is missing".
  it.each([
    ['100649', 400, '测试用例状态不存在'],
    ['100619', 400, '执行用例不存在'],
    ['100039', 400, 'inserts[0].case_id 必须是一个 ObjectId'],
    ['100043', 400, "'properties[smoke_a]'不存在"],
    ['100044', 400, "'properties[test_type]'值不在options中"],
    ['100008', 400, "'start_at'是必填字段"],
    ['100000', 500, '内部服务错误'],
  ])('leaves testhub code %s classified as an api error (exit 7)', async (code, status, message) => {
    const error = await request(
      ctxWith(() => jsonResponse({ code, message }, { status })),
      { method: 'POST', path: '/v1/testhub/cases' },
    ).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect((error as ApiError).exitCode).toBe(7);
    expect((error as ApiError).code).toBe(code);
  });
});
