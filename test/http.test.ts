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
