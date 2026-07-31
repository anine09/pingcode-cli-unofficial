import type { TokenRecord } from './config';
import type { Ctx } from './context';
import { AuthError } from './errors';
import { redactUrl } from './redact';
import { buildUrl, readResponse, sendRequest } from './wire';

/**
 * Auth (design §4). MVP uses **`client_credentials` only** (D4).
 *
 * The token request is a **GET with query parameters under the REST root** —
 * not POST + form, and *not* under `/oauth2` (research §1.1, §1.3):
 *
 *   GET {apiBase}/v1/auth/token?grant_type=client_credentials&client_id=…&client_secret=…
 *   → { access_token, token_type: "Bearer", expires_in }
 *
 * The resulting token is not tied to a user, carries **org-wide
 * system-administrator** authority, is valid 30 days, and has **no refresh
 * token** — "refresh" therefore means "re-acquire from the stored credentials".
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

/**
 * Return a usable access token, acquiring one if needed.
 *
 * Two independent guards, because the expiry metadata is untrustworthy
 * (design §4.2):
 *  1. proactive — re-acquire when `now + 120s ≥ expiresAtMs`;
 *  2. reactive — `core/http.ts` calls this with `{force: true}` after a single
 *     `401`, and replays the request once. It never recurses.
 *
 * Re-acquisition is serialised behind one in-flight promise so concurrent calls
 * in a single process cannot stampede the token endpoint.
 */
export async function ensureFreshToken(
  ctx: Ctx,
  options: { force?: boolean } = {},
): Promise<string> {
  const force = options.force === true;
  if (force) ctx.auth.token = undefined;

  if (!force && tokenIsFresh(ctx.auth.token, ctx.now())) {
    return ctx.auth.token?.accessToken ?? '';
  }

  const pending =
    ctx.auth.inflight ??
    (ctx.auth.inflight = acquireToken(ctx).finally(() => {
      ctx.auth.inflight = undefined;
    }));

  const token = await pending;
  return token.accessToken;
}

/** Forget the in-memory token. Persistence is the caller's business. */
export function clearToken(ctx: Ctx): void {
  ctx.auth.token = undefined;
  ctx.auth.inflight = undefined;
}
