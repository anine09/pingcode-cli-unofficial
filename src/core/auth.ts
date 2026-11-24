import type { TokenRecord } from './config';
import type { Ctx } from './context';
import { AuthError } from './errors';
import { redactUrl } from './redact';
import { buildUrl, readResponse, sendRequest } from './wire';

/**
 * Auth (design §4). Two grants share the single token endpoint
 * `GET {apiBase}/v1/auth/token` (all params in the query string, `client_secret`
 * included — research §6.1):
 *
 *   client_credentials  → `client_id`, `client_secret`
 *                         → { access_token, token_type, expires_in }   (no refresh)
 *   authorization_code  → `client_id`, `client_secret`, `code`
 *                         → { access_token, refresh_token, token_type, expires_in }
 *   refresh_token       → `refresh_token`
 *                         → { access_token, token_type, expires_in }  (NO new refresh_token)
 *
 * `acquireToken` is the enterprise (`client_credentials`) acquirer. `acquireUserToken`
 * performs the initial authorization_code exchange (login only), `refreshUserToken`
 * rotates a user token's access token while retaining the stored `refresh_token`
 * (D6). `ensureFreshToken` routes by the active `ctx.auth.mode` (D7); the reactive
 * 401→re-acquire→replay loop in `core/http.ts` is mode-agnostic (D8).
 */

export const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

/** Proactive refresh window (design §4.2). */
export const REFRESH_WINDOW_MS = 120_000;

export const TOKEN_PATH = '/v1/auth/token';

export type TokenResponse = {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  /** Only the `authorization_code` grant returns one (design D1). */
  refresh_token?: unknown;
};

/**
 * `expires_in` is documented as "过期时间" and its example value is an **absolute
 * Unix timestamp** (`1577808000`, already in the past) while the prose says the
 * validity is 30 days (research §6.2). So: never compute `now + expires_in`
 * blindly — normalise, then sanity-clamp.
 *
 * The clamp matters: a freshly issued token that is already (nearly) expired
 * means the server echoed a stale absolute value. Without it, the proactive
 * guard would re-acquire before *every* request — double the traffic, silently.
 */
export function normalizeExpiry(
  expiresIn: unknown,
  nowMs: number,
): { at: number; clamped: boolean } {
  const n = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : Number.NaN;
  let at: number;
  if (Number.isNaN(n)) at = nowMs + THIRTY_DAYS_MS; // missing / non-numeric
  else if (n > 1e9) at = n * 1000; // absolute unix seconds
  else if (n > 0) at = nowMs + n * 1000; // duration in seconds
  else at = nowMs + THIRTY_DAYS_MS; // zero / negative
  if (at <= nowMs + 60_000) return { at: nowMs + THIRTY_DAYS_MS, clamped: true };
  return { at, clamped: false };
}

export function tokenIsFresh(token: TokenRecord | undefined, nowMs: number): boolean {
  if (token === undefined || token.accessToken === '') return false;
  return token.expiresAtMs > nowMs + REFRESH_WINDOW_MS;
}

/**
 * Acquire a brand-new token from the stored `client_id`/`client_secret`.
 * Stores it on the context and persists it via `ctx.persistToken` (which
 * merges only the `token` field — design §3).
 */
export async function acquireToken(ctx: Ctx): Promise<TokenRecord> {
  const { clientId, clientSecret } = ctx.credentials;
  if (clientId === undefined || clientSecret === undefined) {
    throw new AuthError('no PingCode credentials available', {
      hint: 'run `pingcode auth login --client-id <id> --client-secret <secret>`, or set PINGCODE_CLIENT_ID / PINGCODE_CLIENT_SECRET',
    });
  }

  const url = buildUrl(ctx.apiBase, TOKEN_PATH, {
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  // Every printing path is redacted: the secret travels in the query string.
  ctx.logger.debug(`→ GET ${redactUrl(url)}`);

  const response = await sendRequest(ctx, {
    method: 'GET',
    url,
    headers: { Accept: 'application/json' },
  });
  ctx.logger.debug(`← ${response.status} ${redactUrl(url)}`);

  const payload = await readResponse<TokenResponse | undefined>(response, {
    method: 'GET',
    url,
  });

  const accessToken =
    payload !== undefined && typeof payload.access_token === 'string' ? payload.access_token : '';
  if (accessToken === '') {
    throw new AuthError('the token endpoint did not return an access_token', {
      hint: 'verify the client id/secret and that the app uses the Client Credentials grant',
    });
  }

  const obtainedAtMs = ctx.now();
  const { at, clamped } = normalizeExpiry(payload?.expires_in, obtainedAtMs);
  if (clamped && !ctx.auth.clampWarned) {
    ctx.auth.clampWarned = true;
    ctx.logger.warn(
      `the token endpoint reported expires_in=${String(payload?.expires_in)}, which is already ` +
        'expired or unusable; assuming the documented 30-day validity',
    );
  }

  const token: TokenRecord = { accessToken, expiresAtMs: at, obtainedAtMs };
  if (typeof payload?.scope === 'string' && payload.scope !== '') token.scope = payload.scope;

  ctx.auth.token = token;
  ctx.persistToken?.(token);
  return token;
}

/** Shared: GET the token endpoint and read its JSON body. */
async function callTokenEndpoint(
  ctx: Ctx,
  query: Record<string, unknown>,
): Promise<TokenResponse | undefined> {
  const url = buildUrl(ctx.apiBase, TOKEN_PATH, query);
  // The URL now also carries `code` (authorize) and/or `refresh_token`; redactUrl
  // masks `client_secret` + `code` (design §5.0, R9).
  ctx.logger.debug(`→ GET ${redactUrl(url)}`);
  const response = await sendRequest(ctx, {
    method: 'GET',
    url,
    headers: { Accept: 'application/json' },
  });
  ctx.logger.debug(`← ${response.status} ${redactUrl(url)}`);
  return await readResponse<TokenResponse | undefined>(response, { method: 'GET', url });
}

/** Shared: build a `TokenRecord` from a token-endpoint payload + a known refresh token. */
function tokenFromResponse(
  ctx: Ctx,
  payload: TokenResponse | undefined,
  refreshToken: string,
  missingAccessHint: string,
): TokenRecord {
  const accessToken =
    payload !== undefined && typeof payload.access_token === 'string' ? payload.access_token : '';
  if (accessToken === '') {
    throw new AuthError('the token endpoint did not return an access_token', { hint: missingAccessHint });
  }
  const obtainedAtMs = ctx.now();
  const { at, clamped } = normalizeExpiry(payload?.expires_in, obtainedAtMs);
  if (clamped && !ctx.auth.clampWarned) {
    ctx.auth.clampWarned = true;
    ctx.logger.warn(
      `the token endpoint reported expires_in=${String(payload?.expires_in)}, which is already ` +
        'expired or unusable; assuming the documented 30-day validity',
    );
  }
  const token: TokenRecord = { kind: 'user', accessToken, refreshToken, expiresAtMs: at, obtainedAtMs };
  if (typeof payload?.scope === 'string' && payload.scope !== '') token.scope = payload.scope;
  return token;
}

/**
 * Exchange an operator-supplied authorization `code` for a user token (D6, R3/R4).
 * Login only — `ensureFreshToken` never calls this; it only ever refreshes.
 */
export async function acquireUserToken(ctx: Ctx, code: string): Promise<TokenRecord> {
  const { clientId, clientSecret } = ctx.credentials;
  if (clientId === undefined || clientSecret === undefined) {
    throw new AuthError('no PingCode credentials available', {
      hint: 'run `pingcode auth login --client-id <id> --client-secret <secret>`, or set PINGCODE_CLIENT_ID / PINGCODE_CLIENT_SECRET',
    });
  }

  const payload = await callTokenEndpoint(ctx, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  const refreshToken =
    payload !== undefined && typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
  if (refreshToken === '') {
    throw new AuthError('the authorization_code exchange did not return a refresh_token', {
      hint: 'a user token requires a refresh_token; verify the grant and re-run `pingcode auth login`',
    });
  }

  const token = tokenFromResponse(
    ctx,
    payload,
    refreshToken,
    'verify the authorization code and that the app uses the Authorization Code grant',
  );
  ctx.auth.token = token;
  ctx.persistToken?.(token);
  return token;
}

/**
 * Refresh a user token (D6, R5). `grant_type=refresh_token` returns a new
 * `access_token` but **no** new `refresh_token`, so the stored one is retained.
 */
export async function refreshUserToken(ctx: Ctx, refreshToken: string): Promise<TokenRecord> {
  const payload = await callTokenEndpoint(ctx, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const token = tokenFromResponse(
    ctx,
    payload,
    refreshToken,
    'the refresh token may have been revoked; run `pingcode auth login`',
  );
  ctx.auth.token = token;
  ctx.persistToken?.(token);
  return token;
}

/** Hint shared by every "the PAT did not work" error path. */
export const PAT_HINT =
  'personal access tokens cannot be renewed by this CLI: check that it is not expired or revoked, ' +
  'that its scopes cover this endpoint, or create a new token in PingCode personal settings and run ' +
  '`pingcode auth login --mode pat --token <token>` (or set PINGCODE_TOKEN)';

/**
 * Install a personal access token (Design: PAT support).
 *
 * A PAT is minted in PingCode personal settings and pasted in; the CLI never
 * exchanges or refreshes it, so it is stored as-is with `expiresAtMs: 0`
 * (validity is server-side and unknown here) and flagged `unrefreshable`. The
 * `Bearer ` prefix is stripped so both `Bearer <token>` and a bare token work.
 */
export function setPersonalAccessToken(
  ctx: Ctx,
  raw: string,
  options: { persist?: boolean } = {},
): TokenRecord {
  const accessToken = raw.trim().replace(/^Bearer\s+/i, '').trim();
  if (accessToken === '') {
    throw new AuthError('the personal access token is empty', { hint: PAT_HINT });
  }
  const now = ctx.now();
  const token: TokenRecord = {
    accessToken,
    expiresAtMs: 0,
    obtainedAtMs: now,
    kind: 'pat',
    unrefreshable: true,
  };
  ctx.auth.token = token;
  ctx.auth.mode = 'pat';
  // `persist: false` lets the caller verify the token first, so a token that
  // PingCode rejects with 401 never overwrites a working slot on disk.
  if (options.persist !== false) ctx.persistToken?.(token);
  return token;
}

/**
 * A PAT itself, when one is stored for `pat` mode.
 *
 * Deliberately bypasses the freshness guard: `expiresAtMs` is unknown for a
 * PAT, and a proactive "refresh" is impossible anyway. `force` means the
 * previous request came back `401`, i.e. the token was rejected — retrying it
 * would fail identically, so this is where the actionable error is raised.
 */
function personalAccessToken(ctx: Ctx, force: boolean): string {
  const accessToken = ctx.auth.token?.accessToken ?? '';
  if (accessToken === '') {
    throw new AuthError('no personal access token configured', { hint: PAT_HINT });
  }
  if (force) {
    throw new AuthError('PingCode rejected the personal access token (401)', { hint: PAT_HINT });
  }
  return accessToken;
}

/**
 * Return a usable access token, acquiring one if needed.
 *
 * Two independent guards, because the expiry metadata is untrustworthy
 * (design §4.2):
 *  1. proactive — re-acquire when `now + 120s ≥ expiresAtMs`;
 *  2. reactive — `core/http.ts` calls this with `{force: true}` after a single
 *     `401`, and replays the request once. It never recurses.
 *
 * `pat` mode short-circuits both: a personal access token is pasted in by the
 * operator and cannot be minted or refreshed here, so it is returned as-is and a
 * rejection surfaces as an actionable `AuthError` instead of a retry.
 *
 * Re-acquisition is serialised behind one in-flight promise so concurrent calls
 * in a single process cannot stampede the token endpoint.
 */
export async function ensureFreshToken(
  ctx: Ctx,
  options: { force?: boolean } = {},
): Promise<string> {
  const force = options.force === true;
  if (ctx.auth.mode === 'pat') return personalAccessToken(ctx, force);
  if (force) {
    ctx.auth.inflight = undefined;
    // Enterprise re-acquires from the stored credentials, so the stale token can
    // be dropped. User mode refreshes from the `refresh_token` that lives *on*
    // the token record — clearing it here would orphan that credential and break
    // the reactive 401→refresh path (AC5). Preserve it for user mode.
    if (ctx.auth.mode !== 'user') ctx.auth.token = undefined;
  }

  if (!force && tokenIsFresh(ctx.auth.token, ctx.now())) {
    return ctx.auth.token?.accessToken ?? '';
  }

  const pending =
    ctx.auth.inflight ??
    (ctx.auth.inflight = acquireForMode(ctx).finally(() => {
      ctx.auth.inflight = undefined;
    }));

  const token = await pending;
  return token.accessToken;
}

/**
 * Acquire a usable token for the active `ctx.auth.mode` (D7): enterprise
 * re-acquires from credentials (`acquireToken`); user mode refreshes from the
 * stored `refresh_token`. A rejected refresh (revoked/expired refresh token →
 * non-2xx `AuthError` from `readResponse`, or a missing access token) is **not**
 * swallowed — it surfaces as an actionable `AuthError` (R5).
 */
async function acquireForMode(ctx: Ctx): Promise<TokenRecord> {
  if (ctx.auth.mode === 'pat') {
    // Unreachable in practice (`ensureFreshToken` short-circuits pat mode); kept
    // so the "no magic token endpoint for a PAT" contract is explicit.
    throw new AuthError('a personal access token cannot be acquired or refreshed', {
      hint: PAT_HINT,
    });
  }
  if (ctx.auth.mode === 'user') {
    const refreshToken = ctx.auth.token?.refreshToken;
    if (refreshToken === undefined) {
      // ensureFreshToken only ever refreshes; the initial code exchange is done
      // by `runLogin` via `acquireUserToken`. No token here is a logic error.
      throw new AuthError('no user token to refresh', { hint: 'run `pingcode auth login`' });
    }
    try {
      return await refreshUserToken(ctx, refreshToken);
    } catch (error) {
      throw new AuthError('user token refresh failed — run `pingcode auth login`', {
        cause: error,
      });
    }
  }
  return await acquireToken(ctx);
}

/** Forget the in-memory token. Persistence is the caller's business. */
export function clearToken(ctx: Ctx): void {
  ctx.auth.token = undefined;
  ctx.auth.inflight = undefined;
}
