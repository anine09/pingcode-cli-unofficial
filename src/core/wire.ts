import type { Ctx } from './context';
import {
  ApiError,
  AuthError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  TransportError,
  type PingcodeError,
} from './errors';
import { redactSnippet, redactUrl } from './redact';

/**
 * Wire-level primitives shared by `core/http.ts` (general requests) and
 * `core/auth.ts` (the one unauthenticated request, to the token endpoint).
 * Keeping them here means those two modules never import each other.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const MUTATING = new Set<string>(['POST', 'PATCH', 'PUT', 'DELETE']);

export function isMutating(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

export const RETRY_AFTER_HEADER = 'x-pc-retry-after';

/** How much of a bad body we quote back to the user. */
const SNIPPET_LIMIT = 300;

/**
 * Build a request URL. `undefined`/`null` params are dropped and arrays are
 * serialised as CSV, matching the API's own conventions
 * (`include_public_image_token`, `emails`, `department_ids`).
 */
export function buildUrl(
  apiBase: string,
  path: string,
  query?: Record<string, unknown> | undefined,
): string {
  const base = apiBase.replace(/\/+$/, '');
  const relative = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${relative}`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      const serialized = serializeQueryValue(value);
      if (serialized === undefined) continue;
      url.searchParams.set(key, serialized);
    }
  }
  return url.toString();
}

function serializeQueryValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const csv = value
      .filter((item) => item !== undefined && item !== null)
      .map((item) => String(item))
      .join(',');
    return csv === '' ? undefined : csv;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const text = String(value);
  return text === '' ? undefined : text;
}

export type WireRequest = {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

/** Send one request. Anything below the HTTP layer becomes a `TransportError`. */
export async function sendRequest(ctx: Ctx, request: WireRequest): Promise<Response> {
  const init: RequestInit = { method: request.method, headers: request.headers };
  if (request.body !== undefined) init.body = JSON.stringify(request.body);
  try {
    return await ctx.fetch(request.url, init);
  } catch (error) {
    throw new TransportError(
      `${request.method} ${redactUrl(request.url)} failed: ${describe(error)}`,
      { cause: error },
    );
  }
}

export type ResponseContext = { method: string; url: string };

/**
 * Turn a response into `T`.
 *
 * **Any 2xx is success** — never branch on 200 vs 201 (research §2.3). A
 * non-2xx is mapped status-first, then by `{code}`; unknown codes are surfaced
 * verbatim rather than swallowed. An unparseable body is a `TransportError`.
 */
export async function readResponse<T>(res: Response, where: ResponseContext): Promise<T> {
  const text = await readBody(res, where);
  if (res.ok) {
    if (text.trim() === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new TransportError(
        `${where.method} ${redactUrl(where.url)} returned a body that is not JSON: ${snippet(text)}`,
        { status: res.status, cause: error },
      );
    }
  }
  throw errorForResponse(res, text, where);
}

async function readBody(res: Response, where: ResponseContext): Promise<string> {
  try {
    return await res.text();
  } catch (error) {
    throw new TransportError(
      `${where.method} ${redactUrl(where.url)} response body could not be read: ${describe(error)}`,
      { status: res.status, cause: error },
    );
  }
}

export type ApiErrorBody = {
  /** A string of digits, not an int (research §2.4). */
  code?: string | undefined;
  message?: string | undefined;
};

export function parseApiErrorBody(text: string): ApiErrorBody {
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const body: ApiErrorBody = {};
  // `code` is documented as a string; accept a number defensively and stringify.
  if (typeof record.code === 'string' && record.code !== '') body.code = record.code;
  else if (typeof record.code === 'number' && Number.isFinite(record.code)) {
    body.code = String(record.code);
  }
  if (typeof record.message === 'string' && record.message !== '') body.message = record.message;
  return body;
}

export function retryAfterFromResponse(res: Response): number | undefined {
  const raw = res.headers.get(RETRY_AFTER_HEADER);
  if (raw === null) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds;
}

const SCOPE_HINT =
  'the token lacks the required scope. Note that generic endpoints (comments, attachments, ' +
  'participants, relations, activities) inherit their scope from `principal_type`, so the server ' +
  'message can be misleading — check the app\'s scopes in 凭据管理.';

/**
 * Code-aware overrides on top of the status-first default (design §5.2).
 *
 * **Evidence: `research/s8-smoke.md` F2/F3** — these are observed, not guessed.
 * The live cloud API answers HTTP **400** where REST convention would use 401 or
 * 404, which made exits 3 and 5 unreachable for server-side failures:
 *
 * | code | observed on | HTTP | mapped to |
 * |---|---|---|---|
 * | `100024` | `GET /v1/auth/token` with a wrong client id/secret | 400 | `AuthError` (3) |
 * | `100317` | `GET /v1/pjm/work_items/{unknown id}` | 400 | `NotFoundError` (5) |
 * | `100303` | `PATCH` with an unknown `state_id` | 400 | `NotFoundError` (5) |
 *
 * **Evidence: `research/s7-smoke.md` F1** — ship repeats the pattern with its own
 * per-resource codes, so the same mistake had different exits per module until
 * these two rows existed:
 *
 * | code | observed on | HTTP | mapped to |
 * |---|---|---|---|
 * | `100725` | `GET /v1/ship/ideas/{unknown id}` (`需求不存在或无权访问`) | 400 | `NotFoundError` (5) |
 * | `100711` | `GET /v1/ship/tickets/{unknown id}` (`工单不存在或无权访问`) | 400 | `NotFoundError` (5) |
 *
 * **Evidence: `08-02-testhub-module` S6 live smoke (2026-08-02)** — testhub is the
 * third module to repeat the pattern with its own per-resource codes:
 *
 * | code | observed on | HTTP | mapped to |
 * |---|---|---|---|
 * | `100601` | `GET /v1/testhub/cases/{unknown id}` (`测试用例不存在或无权限访问`) | 400 | `NotFoundError` (5) |
 * | `100603` | `GET /v1/testhub/runs/{unknown id}` (`执行用例不存在或无权限访问`) | 400 | `NotFoundError` (5) |
 *
 * Both are stable across a nonexistent 24-hex id, a malformed id and an unknown
 * `short_id`, which is what makes them safe to key on. They also cover the
 * pre-read that `testhub cases update` and `testhub runs patch` perform, so a
 * missing case or run exits 5 on the write paths too.
 *
 * Deliberately **not** here: ship's `100719` / `100702` ("state does not exist"
 * on an idea/ticket PATCH). Live they are also returned for a state that plainly
 * exists but is unreachable under the state plan (`research/s7-smoke.md` F5), so
 * mapping them to `not_found` would tell an agent a state is missing when it is
 * merely forbidden. They stay on exit 7.
 *
 * Deliberately **not** here either, from the same testhub smoke:
 * - `100649` (`测试用例状态不存在` on an unknown `state_id`) — the exact analogue of
 *   ship's `100719`/`100702`, so it gets the same treatment.
 * - `100619` (`执行用例不存在` inside `runs/bulk`) — it rejects the *whole batch*,
 *   so exit 5 would name one missing run while silently implying the valid
 *   entries were applied. They were not. The S8 smoke (2026-08-02) narrowed what
 *   the code *refers* to — it still fires with a valid library and plan id and
 *   only a bogus `deletes[]` entry, so it is about the run, not the plan — but
 *   that does not weaken the argument above: the objection is to what exit 5 would
 *   imply about the rest of the batch, not to which resource is missing.
 * - `100039` / `100043` / `100044` / `100008` (shape, unknown-property, bad
 *   option, missing-required-field) — these are input validation, not absence.
 *   `100039` is also what the cross-object attachment endpoint returns for a code
 *   snippet posted without the `comment_id` the docs call optional (F5 smoke,
 *   2026-08-03) — a malformed request, not a missing row.
 * - `100049` (`不支持的'principal_type'`) — the cross-object families' rejection of a
 *   principal type, or of a `(principal_type, target_type)` pair, or of a *missing*
 *   `target_type` on `GET /v1/relations`: all three arrive under the same code and the
 *   same message naming `principal_type` (F5 smoke, 2026-08-03). It is a refused
 *   argument, so it stays exit 7; `cli/commands/_shared/crosscutting.ts` adds the
 *   explanation the message lacks instead.
 * - `100000` (`内部服务错误`, HTTP 500) — returned for genuinely broken server
 *   states such as a `properties` write against a select- or member-typed key.
 *   It is not a not-found and must keep its 500. `GET /v1/activities` answers an
 *   unrecognised `principal_type` this way too, where its two sibling families answer
 *   `100049` (F5 smoke, 2026-08-03) — which is precisely why the mount points are a
 *   table of measured facts and are never probed at runtime.
 *
 * Matching is on the **`code` string only**: the API is Chinese-only and its
 * message wording is not a contract. Any code outside this table keeps the
 * status-first mapping and still surfaces `code` verbatim, so an unknown failure
 * is never swallowed. Note that an invalid *bearer* token on a resource endpoint
 * does return a real 401, so the 401 branch below is still live.
 */
export const ERROR_CODE_OVERRIDES: Record<string, 'auth' | 'not_found'> = {
  '100024': 'auth',
  '100317': 'not_found',
  '100303': 'not_found',
  // ship's not-found codes: idea, then ticket (research/s7-smoke.md F1).
  '100725': 'not_found',
  '100711': 'not_found',
  // testhub's not-found codes: case, then run (08-02-testhub-module S6 smoke).
  '100601': 'not_found',
  '100603': 'not_found',
  // 08-02-testhub-bootstrap-leaves S8 smoke, 2026-08-02, live tenant:
  //   100600 "测试库不存在或无权限访问" — HTTP 400, observed on five endpoints with a
  //   bogus 24-hex library id: GET /libraries/{id}/plans, /plan_types, /suites,
  //   GET /case/states?library_id=, POST /cases. Same 1006xx family and the same
  //   "不存在或无权限访问" wording as 100601/100603 above, which are already mapped.
  '100600': 'not_found',
  // F5 (08-02-full-api-coverage) cross-object smoke, 2026-08-03, live tenant. The four
  // generic families each have their own resource-not-found code, all HTTP **400**,
  // each observed with a syntactically valid but nonexistent 24-hex id:
  //   100045 "附件不存在"              — GET/DELETE /v1/attachments/{id}
  //   100051 "评论资源不存在或无权访问"  — GET/DELETE /v1/comments/{id}
  //   100077 "活动记录不存在"           — GET /v1/activities/{id}
  //   100801 "关联关系不存在"           — GET /v1/relations/{id}, and again on the second
  //                                     GET after a successful DELETE
  //   100903 "页面不存在或无权访问"      — any family with principal_type=page and an
  //                                     unknown page id (the wiki analogue of 100317)
  // Same "不存在" family, same reason as the rows above: without these, a missing
  // comment exits 7 while a missing work item exits 5, for the same mistake.
  //
  // One caveat worth knowing rather than hiding: 100045 also fires for an attachment
  // that *does* exist when the `comment_id` scope is omitted, because a comment-scoped
  // snippet is simply not addressable without it. Exit 5 is still the honest answer —
  // nothing was found at the address given — and the command layer's help says to pass
  // the scope.
  '100045': 'not_found',
  '100051': 'not_found',
  '100077': 'not_found',
  '100801': 'not_found',
  '100903': 'not_found',
  // S1a (08-02-full-api-coverage) scm smoke, 2026-08-03, live tenant. The three
  // 托管平台 families each name the resource that is absent, all HTTP **400**, each
  // observed with a syntactically valid but nonexistent 24-hex id on **both** `GET`
  // and `PATCH` (so a write path exits 5 too, exactly like testhub's pre-read):
  //   100200 "'product'资源不存在"     — GET/PATCH /v1/scm/products/{id}, and also when the
  //                                    platform in the path of a child list is missing
  //                                    (GET …/{id}/repositories)
  //   100202 "'repository'资源不存在"  — GET/PATCH …/repositories/{id}
  //   100209 "'user'资源不存在"        — GET/PATCH …/users/{id}
  // Note "product" here is a 托管平台, not a ship product — different resource, and
  // ship's own not-found codes (100725/100711) are unrelated rows above.
  //
  // Deliberately **not** mapped, from the same smoke:
  //  - `100002` (`资源路径错误`) — returned with a real HTTP **404** when a path segment
  //    is not an ObjectId (`/v1/scm/products/notanid`). The status-first branch already
  //    makes that exit 5; adding a row would be redundant, not wrong.
  //  - `100003` (`'type'不是有效的字符串(不是有效的枚举值)`) and `100220`
  //    (`'product'已经存在`, a duplicate platform name) — input validation and a
  //    uniqueness conflict. Neither is an absence, and calling a rejected enum value
  //    "not found" would send an agent looking for a missing record.
  '100200': 'not_found',
  '100202': 'not_found',
  '100209': 'not_found',
};

const NOT_FOUND_HINT =
  'check the id/identifier, and remember that archived or deleted rows are hidden unless you ask for them';

export function errorForResponse(
  res: Response,
  text: string,
  where: ResponseContext,
): PingcodeError {
  const body = parseApiErrorBody(text);
  const detail = body.message ?? snippet(text) ?? res.statusText ?? `HTTP ${res.status}`;
  const at = `${where.method} ${redactUrl(where.url)}`;
  const options = { code: body.code, status: res.status };

  // The code allowlist wins over the status, because the status is wrong.
  const override = body.code === undefined ? undefined : ERROR_CODE_OVERRIDES[body.code];
  if (override === 'auth') {
    return new AuthError(`${detail} (HTTP ${res.status} code ${body.code ?? '?'} from ${at})`, {
      ...options,
      hint: 'the credentials were rejected — check the client id/secret (a reset app secret invalidates them immediately), then run `pingcode auth login`',
    });
  }
  if (override === 'not_found') {
    return new NotFoundError(`${detail} (HTTP ${res.status} code ${body.code ?? '?'} from ${at})`, {
      ...options,
      hint: NOT_FOUND_HINT,
    });
  }

  switch (res.status) {
    case 401:
      return new AuthError(`${detail} (401 from ${at})`, {
        ...options,
        hint: 'the access token was rejected — run `pingcode auth login` again, or check that the app secret was not reset',
      });
    case 403:
      return new PermissionError(`${detail} (403 from ${at})`, { ...options, hint: SCOPE_HINT });
    case 404:
      // This API is not observed to return 404 at all (research/s8-smoke.md F2);
      // the branch stays for self-hosted builds and future behaviour.
      return new NotFoundError(`${detail} (404 from ${at})`, { ...options, hint: NOT_FOUND_HINT });
    case 429: {
      const retryAfterSeconds = retryAfterFromResponse(res);
      return new RateLimitError(`${detail} (429 from ${at})`, {
        ...options,
        retryAfterSeconds,
        hint:
          retryAfterSeconds === undefined
            ? 'the rate limit is 200 requests/minute per token; retrying before the window expires just repeats the 429'
            : `retry after ${retryAfterSeconds}s (limit is 200 requests/minute per token)`,
      });
    }
    default:
      return new ApiError(`${detail} (HTTP ${res.status} from ${at})`, options);
  }
}

export function snippet(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const clipped =
    trimmed.length > SNIPPET_LIMIT ? `${trimmed.slice(0, SNIPPET_LIMIT)}…` : trimmed;
  return redactSnippet(redactUrl(clipped));
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== error.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}
