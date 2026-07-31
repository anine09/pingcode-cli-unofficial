import { ensureFreshToken } from './auth';
import type { Ctx } from './context';
import { DryRunHalt } from './errors';
import { redactHeaders, redactUrl } from './redact';
import {
  buildUrl,
  isMutating,
  readResponse,
  retryAfterFromResponse,
  sendRequest,
  type HttpMethod,
  type WireRequest,
} from './wire';

/**
 * The single choke point for every outbound call (design §5).
 *
 * Responsibilities, in order:
 *  1. build the URL (drop nullish params, CSV arrays);
 *  2. inject `Authorization: Bearer …`; JSON content type only on write verbs;
 *  3. **dry-run gate** — a mutating request throws `DryRunHalt` and is never sent (D8);
 *  4. send via the injected `fetch`;
 *  5. `429` → honour `x-pc-retry-after` (capped, one retry), otherwise fail fast;
 *  6. `401` → re-acquire once and replay, never recursively;
 *  7. any `2xx` is success; non-2xx is mapped status-first, then by `{code}`;
 *  8. parse JSON, or raise `TransportError` with a redacted snippet.
 */

export type RequestOptions = {
  method: HttpMethod;
  /** e.g. `/v1/pjm/work_items` */
  path: string;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  /** Token endpoint only. */
  skipAuth?: boolean | undefined;
};

/** Never sleep longer than this for a 429, however large the header is. */
export const MAX_RETRY_WAIT_MS = 60_000;

export async function request<T>(ctx: Ctx, options: RequestOptions): Promise<T> {
  const method = options.method;
  const mutating = isMutating(method);
  const url = buildUrl(ctx.apiBase, options.path, options.query);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.skipAuth !== true) {
    headers.Authorization = `Bearer ${await ensureFreshToken(ctx)}`;
  }
  if (mutating && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  // 3. Dry run: refuse to send, and hand the plan back as control flow (D8).
  //    Read verbs still execute, so a dry-run `create` can resolve names to ids
  //    and show a real request.
  if (ctx.dryRun && mutating) {
    throw new DryRunHalt({
      method,
      url: redactUrl(url),
      headers: redactHeaders(headers),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  }

  let replayedAuth = false;
  let waitedForRateLimit = false;

  // A bounded loop, not recursion: each remedy can fire at most once.
  for (;;) {
    const wire: WireRequest = {
      method,
      url,
      headers: { ...headers },
      ...(options.body === undefined ? {} : { body: options.body }),
    };
    ctx.logger.debug(`→ ${method} ${redactUrl(url)}`);
    const response = await sendRequest(ctx, wire);
    ctx.logger.debug(`← ${response.status} ${method} ${redactUrl(url)}`);

    if (response.status === 429 && !waitedForRateLimit) {
      const retryAfterSeconds = retryAfterFromResponse(response);
      if (retryAfterSeconds !== undefined) {
        waitedForRateLimit = true;
        const waitMs = Math.min(retryAfterSeconds * 1000, MAX_RETRY_WAIT_MS);
        ctx.logger.warn(
          `rate limited (200 req/min); waiting ${Math.round(waitMs / 1000)}s and retrying once`,
        );
        await ctx.sleep(waitMs);
        continue;
      }
      // No header ⇒ fail fast. Retrying blind is pointless: the window is
      // per-minute and a premature retry just restarts the same 429 (research §2.5).
    }

    if (response.status === 401 && options.skipAuth !== true && !replayedAuth) {
      replayedAuth = true;
      ctx.logger.debug('401 — re-acquiring the token once and replaying the request');
      headers.Authorization = `Bearer ${await ensureFreshToken(ctx, { force: true })}`;
      continue;
    }

    return await readResponse<T>(response, { method, url });
  }
}
