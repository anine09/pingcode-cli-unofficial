import { describe, expect, it } from 'vitest';
import {
  REFRESH_WINDOW_MS,
  THIRTY_DAYS_MS,
  acquireToken,
  clearToken,
  ensureFreshToken,
  normalizeExpiry,
  tokenIsFresh,
} from '../src/core/auth';
import type { TokenRecord } from '../src/core/config';
import { AuthError, TransportError } from '../src/core/errors';
import { createFakeFetch, createTestContext, jsonResponse, textResponse } from './helpers/fake';

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z in ms

/**
 * Gate G2: `normalizeExpiry` is the riskiest arithmetic in the project — the doc's
 * own example `expires_in` value is an absolute timestamp that is already in the
 * past, while the prose promises 30 days of validity (research §6.2).
 */
describe('normalizeExpiry (gate G2)', () => {
  it('treats a value > 1e9 as absolute unix seconds', () => {
    const future = Math.floor(NOW / 1000) + 3600; // 1 hour from "now", absolute
    expect(normalizeExpiry(future, NOW)).toEqual({ at: future * 1000, clamped: false });
  });

  it('treats a small value as a duration in seconds', () => {
    expect(normalizeExpiry(3600, NOW)).toEqual({ at: NOW + 3_600_000, clamped: false });
    expect(normalizeExpiry(30 * 24 * 3600, NOW)).toEqual({ at: NOW + THIRTY_DAYS_MS, clamped: false });
  });

  it('clamps the documented past-absolute example to now + 30 days and reports it', () => {
    // 1577808000 = 2020-01-01, i.e. already expired — the value the docs print.
    expect(normalizeExpiry(1_577_808_000, NOW)).toEqual({
      at: NOW + THIRTY_DAYS_MS,
      clamped: true,
    });
  });

  it('clamps anything inside the next 60 seconds', () => {
    const almostNow = Math.floor((NOW + 30_000) / 1000);
    expect(normalizeExpiry(almostNow, NOW)).toEqual({ at: NOW + THIRTY_DAYS_MS, clamped: true });
    expect(normalizeExpiry(45, NOW)).toEqual({ at: NOW + THIRTY_DAYS_MS, clamped: true });
  });

  it('falls back to 30 days for missing, NaN, zero and negative values', () => {
    for (const value of [undefined, null, 'abc', Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(normalizeExpiry(value, NOW)).toEqual({ at: NOW + THIRTY_DAYS_MS, clamped: false });
    }
  });

  it('never returns a relative value — only absolute ms', () => {
    const { at } = normalizeExpiry(3600, NOW);
    expect(at).toBeGreaterThan(NOW);
  });
});

describe('tokenIsFresh (proactive window)', () => {
  const token = (expiresAtMs: number): TokenRecord => ({
    accessToken: 'tok',
    expiresAtMs,
    obtainedAtMs: NOW,
  });

  it('is false inside the 120s window and true just outside it', () => {
    expect(tokenIsFresh(token(NOW + REFRESH_WINDOW_MS - 1), NOW)).toBe(false);
    expect(tokenIsFresh(token(NOW + REFRESH_WINDOW_MS), NOW)).toBe(false);
    expect(tokenIsFresh(token(NOW + REFRESH_WINDOW_MS + 1), NOW)).toBe(true);
  });

  it('is false for a missing or empty token', () => {
    expect(tokenIsFresh(undefined, NOW)).toBe(false);
    expect(tokenIsFresh({ accessToken: '', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW }, NOW)).toBe(
      false,
    );
  });
});

describe('acquireToken', () => {
  it('calls GET {apiBase}/v1/auth/token with the credentials in the query string', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 }),
    );
    const ctx = createTestContext({
      fetch: fake.fetch,
      clientId: 'id-1',
      clientSecret: 'secret-1',
      now: NOW,
    });

    const token = await acquireToken(ctx);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(
      'https://open.pingcode.com/v1/auth/token?grant_type=client_credentials&client_id=id-1&client_secret=secret-1',
    );
    expect(call?.body).toBeUndefined();
    expect(token).toEqual({
      accessToken: 'tok-1',
      expiresAtMs: NOW + 3_600_000,
      obtainedAtMs: NOW,
    });
    expect(ctx.auth.token).toEqual(token);
  });

  it('uses the self-hosted /open api base', async () => {
    const fake = createFakeFetch(() => jsonResponse({ access_token: 'tok', expires_in: 3600 }));
    const ctx = createTestContext({
      fetch: fake.fetch,
      apiBase: 'https://pingcode.acme.com/open',
      clientId: 'id',
      clientSecret: 'sh',
    });
    await acquireToken(ctx);
    expect(fake.urls()[0]).toContain('https://pingcode.acme.com/open/v1/auth/token?');
  });

  it('never logs the client secret (AC3, AC11)', async () => {
    const fake = createFakeFetch(() => jsonResponse({ access_token: 'tok', expires_in: 3600 }));
    const ctx = createTestContext({
      fetch: fake.fetch,
      clientId: 'id',
      clientSecret: 'super-secret-value',
      verbose: true,
    });
    await acquireToken(ctx);
    expect(ctx.logLines.length).toBeGreaterThan(0);
    expect(ctx.logLines.join('\n')).not.toContain('super-secret-value');
    expect(ctx.logLines.join('\n')).toContain('client_secret=***REDACTED***');
  });

  it('persists the normalised token and warns once about a clamped expiry', async () => {
    const saved: TokenRecord[] = [];
    const fake = createFakeFetch(() =>
      jsonResponse({ access_token: 'tok', expires_in: 1_577_808_000 }),
    );
    const ctx = createTestContext({
      fetch: fake.fetch,
      clientId: 'id',
      clientSecret: 'sh',
      now: NOW,
      persistToken: (token) => saved.push(token),
    });

    await acquireToken(ctx);
    await acquireToken(ctx);

    expect(saved).toHaveLength(2);
    expect(saved[0]?.expiresAtMs).toBe(NOW + THIRTY_DAYS_MS);
    const warnings = ctx.logLines.filter((line) => line.includes('30-day validity'));
    expect(warnings).toHaveLength(1);
  });

  it('keeps the scope when the server sends one', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ access_token: 'tok', expires_in: 3600, scope: 'pcp:read:pjm:project' }),
    );
    const ctx = createTestContext({ fetch: fake.fetch, clientId: 'id', clientSecret: 'sh' });
    expect((await acquireToken(ctx)).scope).toBe('pcp:read:pjm:project');
  });

  it('fails with an AuthError when credentials are missing', async () => {
    const fake = createFakeFetch(() => jsonResponse({}));
    const ctx = createTestContext({ fetch: fake.fetch });
    await expect(acquireToken(ctx)).rejects.toBeInstanceOf(AuthError);
    expect(fake.calls).toHaveLength(0);
  });

  it('fails with an AuthError when the response has no access_token', async () => {
    const fake = createFakeFetch(() => jsonResponse({ token_type: 'Bearer' }));
    const ctx = createTestContext({ fetch: fake.fetch, clientId: 'id', clientSecret: 'sh' });
    await expect(acquireToken(ctx)).rejects.toBeInstanceOf(AuthError);
  });

  it('maps a rejected secret (401) to an AuthError, exit 3', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ code: '100001', message: 'invalid client' }, { status: 401 }),
    );
    const ctx = createTestContext({ fetch: fake.fetch, clientId: 'id', clientSecret: 'bad' });
    const error = await acquireToken(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).exitCode).toBe(3);
    expect((error as AuthError).code).toBe('100001');
    expect((error as AuthError).message).not.toContain('secret=bad');
  });

  it('maps a non-JSON body to a TransportError with a redacted snippet', async () => {
    const fake = createFakeFetch(() => textResponse('<html>gateway</html>'));
    const ctx = createTestContext({ fetch: fake.fetch, clientId: 'id', clientSecret: 'sh' });
    const error = await acquireToken(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toContain('gateway');
    expect((error as TransportError).message).not.toContain('client_secret=sh');
  });
});

describe('ensureFreshToken', () => {
  it('reuses a token that is outside the refresh window', async () => {
    const fake = createFakeFetch(() => jsonResponse({ access_token: 'new', expires_in: 3600 }));
    const ctx = createTestContext({
      fetch: fake.fetch,
      clientId: 'id',
      clientSecret: 'sh',
      now: NOW,
      token: { accessToken: 'cached', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    });
    expect(await ensureFreshToken(ctx)).toBe('cached');
    expect(fake.calls).toHaveLength(0);
  });

  it('re-acquires proactively inside the 120s window', async () => {
    const fake = createFakeFetch(() => jsonResponse({ access_token: 'new', expires_in: 3600 }));
    const ctx = createTestContext({
      fetch: fake.fetch,
      clientId: 'id',
      clientSecret: 'sh',
      now: NOW,
      token: { accessToken: 'stale', expiresAtMs: NOW + 60_000, obtainedAtMs: NOW },
    });
    expect(await ensureFreshToken(ctx)).toBe('new');
    expect(fake.calls).toHaveLength(1);
  });

  it('re-acquires when forced, even with a fresh token', async () => {
    const fake = createFakeFetch(() => jsonResponse({ access_token: 'forced', expires_in: 3600 }));
    const ctx = createTestContext({
      fetch: fake.fetch,
      clientId: 'id',
      clientSecret: 'sh',
      now: NOW,
      token: { accessToken: 'cached', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    });
    expect(await ensureFreshToken(ctx, { force: true })).toBe('forced');
    expect(fake.calls).toHaveLength(1);
  });

  it('serialises concurrent callers behind a single in-flight request', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeFetch(async () => {
      await gate;
      return jsonResponse({ access_token: 'one', expires_in: 3600 });
    });
    const ctx = createTestContext({ fetch: fake.fetch, clientId: 'id', clientSecret: 'sh' });

    const all = Promise.all([
      ensureFreshToken(ctx),
      ensureFreshToken(ctx),
      ensureFreshToken(ctx),
      ensureFreshToken(ctx),
    ]);
    release?.();
    expect(await all).toEqual(['one', 'one', 'one', 'one']);
    expect(fake.calls).toHaveLength(1);
  });

  it('clears the in-flight promise so a later failure can be retried', async () => {
    let attempt = 0;
    const fake = createFakeFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ message: 'boom' }, { status: 500 })
        : jsonResponse({ access_token: 'later', expires_in: 3600 });
    });
    const ctx = createTestContext({ fetch: fake.fetch, clientId: 'id', clientSecret: 'sh' });

    await expect(ensureFreshToken(ctx)).rejects.toThrow();
    expect(ctx.auth.inflight).toBeUndefined();
    expect(await ensureFreshToken(ctx)).toBe('later');
    expect(fake.calls).toHaveLength(2);
  });

  it('clearToken forgets everything in memory', () => {
    const ctx = createTestContext({
      token: { accessToken: 'x', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    });
    clearToken(ctx);
    expect(ctx.auth.token).toBeUndefined();
    expect(ctx.auth.inflight).toBeUndefined();
  });
});
