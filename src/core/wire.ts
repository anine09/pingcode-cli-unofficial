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
 * **`100303` re-verified 2026-08-05 (G3 closeout) against the standard the ship and
 * testhub rows below are held to**, because its only prior evidence was an MVP-era
 * probe with an all-zeros `state_id` and nobody had checked whether pjm repeats
 * ship's conflation. It does **not**: pjm emits a *separate* code for a state that
 * exists but is unreachable, so `100303` really does mean "no such state".
 * Probed on a scratch `[CLI smoke]` story in a scrum project whose story state plan
 * (`68389e7f33ee52bc5c2584d6`) has `关闭 → {打开, 挂起}` as its only outgoing edges:
 *
 * | attempted from `关闭` | HTTP | code | message |
 * |---|---|---|---|
 * | → `已完成`, in the scheme, **not** adjacent | 400 | `100379` | `工作项状态不能流转到当前状态` |
 * | → an unused-but-syntactically-valid 24-hex id | 400 | `100303` | `'state'资源不存在` |
 * | → `新提交`, a real state of a *different* type's scheme | 400 | `100303` | `'state'资源不存在` |
 * | → `notanid` | 400 | `100003` | `'state_id'不是有效的字符串(不是有效的id)` |
 *
 * Both `project work-item transition` and `project work-item update --state` produce
 * the identical pairs, so the split is the server's, not a command-layer artefact.
 * Row 3 is why the row survives rather than merely being defensible: a state outside
 * the addressed type's scheme genuinely is absent at the address given — `project meta
 * states --type story` does not list it — so exit 5 is the honest answer, and the
 * reachability case that would have made exit 5 a lie has its own code (`100379`,
 * left on exit 7 with the state-flow codes below).
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
 * pre-read that `testhub cases update` and `testhub runs update` perform, so a
 * missing case or run exits 5 on the write paths too.
 *
 * Deliberately **not** here: ship's `100719` / `100702` ("state does not exist"
 * on an idea/ticket PATCH). Live they are also returned for a state that plainly
 * exists but is unreachable under the state plan (`research/s7-smoke.md` F5), so
 * mapping them to `not_found` would tell an agent a state is missing when it is
 * merely forbidden. They stay on exit 7.
 *
 * Deliberately **not** here either, and for the mirror-image reason: pjm's
 * `100379` (`工作项状态不能流转到当前状态`, G3 closeout probe above). It is *only* the
 * unreachable-transition case — pjm never uses it for an absent state — which is
 * exactly why `100303` above is safe. It is a refused transition, not an absence,
 * so exit 7 is right; `explainStates` in `cli/commands/workItem.ts` supplies the
 * configured states and the "you also need a legal workflow transition" sentence
 * that the server message omits.
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
  // S1b (08-02-full-api-coverage) scm smoke, 2026-08-03, live tenant — the same three
  // facts as S1a, for 代码分支 / 提交 / 提交引用 (design D12.8). All HTTP **400**:
  //   100201 "'branch'资源不存在"     — GET/PATCH/**DELETE** …/branches/{unknown 24-hex},
  //                                    and also on POST …/refs when `meta_id` names no
  //                                    branch. Four verbs, one code, one meaning.
  //   100206 "'commit'资源不存在"     — GET /v1/scm/commits/{unknown} for **both** an
  //                                    unknown 24-hex id and an unknown full 40-hex
  //                                    SHA, and on POST …/refs when `sha` names no
  //                                    commit.
  //   100207 "'reference'资源不存在"  — GET …/refs/{unknown 24-hex}
  // On the two `POST …/refs` paths exit 5 is precise rather than incidental: the row
  // the request *named* genuinely does not exist, which is a different failure from
  // "the create was rejected".
  //
  // Deliberately **not** mapped, from the same smoke:
  //  - `100217` / `100214` / `100215` (`'branch'|'commit'|'ref'已经存在`) — uniqueness
  //    conflicts, judged exactly as S1a judged `100220`.
  //  - `100005` (`'is_default'不是有效的布尔值(值不为true)`) — input validation: PATCH
  //    accepts only `true`, and the CLI's `--default` switch cannot even express the
  //    rejected call.
  //  - `100223` (`默认分支不能被删除`) — a **business-rule refusal**, not an absence:
  //    the branch exists and the user can see it in `scm branch list`. Calling that
  //    `not_found` would send an agent hunting for a row it is looking at, the same
  //    reasoning that keeps ship's `100719`/`100702` on exit 7. `scm branch delete`
  //    appends the actionable explanation instead.
  //  - `100000` (`内部服务错误`) — a genuine HTTP **500**, seen when listing the refs of
  //    an already-deleted branch (D12.5). A server fault must keep its 500.
  '100201': 'not_found',
  '100206': 'not_found',
  '100207': 'not_found',
  // S1c (08-02-full-api-coverage) scm smoke, 2026-08-03, live tenant — 拉取请求 /
  // 代码评审, closing the module (design D13.1 item 5). Both HTTP **400**:
  //   100208 "'pull request'资源不存在" — GET and PATCH
  //     …/repositories/{repo}/pull_requests/{unknown 24-hex}, and again on
  //     POST …/pull_requests/{unknown}/reviews, where the pull request the path
  //     *names* is the thing that is absent. Three verbs, one code, one meaning.
  //   100222 "'review'资源不存在"      — GET and PATCH
  //     …/pull_requests/{pr}/reviews/{unknown 24-hex}, and also for a review id that
  //     exists but hangs off a *different* pull request — the review really is not at
  //     the address given, so exit 5 is precise there too.
  // Same shape as the six scm rows above and the reason they were admitted: one stable
  // per-resource "this record is absent" code, identical across verbs. Without these a
  // missing pull request exited 7 while a missing branch exited 5, for the same mistake
  // (the inconsistency design D13.4 recorded while the credentials were unavailable).
  //
  // Deliberately **not** mapped, from the same smoke:
  //  - `100224` (`源分支是必填字段`) and `100008` (`'status'是必填字段`) — missing required
  //    body fields on POST/PATCH. Input validation, not absence.
  //  - `100212` (`请提供'merged_at'，'merged_commit_sha'，'merged_by_name'值`) — the
  //    conditional the docs describe, enforced server-side when `status` is `merged`.
  //  - `100211` (`源分支和目标分支不能相同`) — a business-rule refusal: both branches
  //    exist. Judged exactly as `100223` (默认分支不能被删除) was.
  //  - `100003` (`'source_branch_id'不是有效的字符串(值不能为空)`) — input validation.
  // Note also that a *missing* pull request is reported only on the review **detail**
  // paths: `GET …/pull_requests/{unknown}/reviews` answers **HTTP 200 with an empty
  // list** instead of `100208`, so no override can make that case exit 5 (documented in
  // `scm/review.ts` and modules/scm.md rather than papered over here).
  '100208': 'not_found',
  '100222': 'not_found',
  // S1d (08-02-full-api-coverage) build + release smoke, 2026-08-04, live tenant
  // (design D14.4). The last three DevOps families, and the same shape a fourth time —
  // one stable per-resource code, HTTP **400**, identical across every verb that can
  // name a missing row:
  //   100203 "'build'资源不存在"        — GET, PATCH **and DELETE**
  //     /v1/build/builds/{unknown 24-hex}, and again on the GET that follows a
  //     successful delete. Three verbs, one code. This is the only family in the area
  //     whose delete path can report an absence at all, since it is the only one with
  //     a delete.
  //   100204 "'deploy'资源不存在"       — GET and PATCH /v1/release/deploys/{unknown}
  //   100205 "'environment'资源不存在"  — GET and PATCH
  //     /v1/release/environments/{unknown}, and on **POST /v1/release/deploys** when
  //     `env_id` names no environment. As with S1b's `100201` on `POST …/refs`, exit 5
  //     is precise rather than incidental there: the row the request *named* does not
  //     exist, which is a different failure from "the create was rejected".
  // Without these rows a missing build exited 7 while a missing branch exited 5, for
  // the same mistake — the inconsistency S1a..S1c already closed for scm.
  //
  // Deliberately **not** mapped, from the same smoke:
  //  - `100105` (`'<name>'环境已经存在`) — a uniqueness conflict on the environment name,
  //    judged exactly as `100220`/`100217`/`100214`/`100215` were.
  //  - `100106` (`'environment'正在使用，不能被删除`) — a **business-rule refusal**: the
  //    environment plainly exists, and the server is protecting the deploys that
  //    reference it. Same judgement as `100223` (默认分支不能被删除). Note this refusal is
  //    good news, not a limitation — it is why the release families cannot be orphaned
  //    the way a branch's commit refs can (D12.5).
  //  - `100003` (`'env_id'不是有效的字符串(不是有效的id)`, `'status'/'provider'不是有效的枚举值`,
  //    `'html_url'不是URL格式`), `100004` (`'start_at'…数值不是有效的时间戳`, returned for `0`
  //    and for milliseconds-instead-of-seconds) and `100006`
  //    (`'work_item_identifiers[0]'…值不能为空`) — all input validation.
  //  - `100008` (`'start_at'是必填字段`) — the **cross-module** missing-required-field
  //    code (testhub answers it for `'start_at'` too, S1c saw it for `'status'`).
  //    Mapping it would pollute every module with a wrong `not_found`.
  '100203': 'not_found',
  '100204': 'not_found',
  '100205': 'not_found',
  // S2a (08-02-full-api-coverage) pjm planning smoke, 2026-08-04, live tenant
  // (design D15.8). 迭代 and 发布, the same shape a fifth time — one stable
  // per-resource code, HTTP **400**, identical across every verb that can name a
  // missing row:
  //   100308 "'Iteration'资源不存在"  — GET and PATCH
  //     /v1/pjm/projects/{project}/sprints/{unknown 24-hex}. Two verbs, one code, and
  //     that is *all* the verbs there are: the sprint path has no DELETE at all.
  //     (Note the resource name is the English "Iteration" while every other code in
  //     this family names it in lower case — wording is not a contract, which is why
  //     only the code is matched.)
  //   100304 "'version'资源不存在"    — GET, PATCH **and DELETE**
  //     …/versions/{unknown 24-hex}. Three verbs, one code.
  // Without these a missing sprint exited 7 while a missing work item exited 5
  // (`100317`, already mapped) — the same mistake, in the same module.
  //
  // Deliberately **not** mapped, from the same smoke. The first row is the important
  // one, and it is the reason this list is not just boilerplate:
  //  - `100300` (`'project'资源不存在`) — returned both for a project id that does not
  //    exist **and** for a real project that simply has no 迭代 module:
  //    `POST /v1/pjm/projects/{a kanban project}/sprints` answers `100300` while
  //    `GET …/sprints` on the same project answers 200 with zero rows. So the code
  //    conflates "no such project" with "sprints are not available here", and exit 5
  //    would tell an agent to go looking for a project it can see in `project list`.
  //    Same judgement as ship's `100719`/`100702` and scm's `100223`. `project sprint
  //    create` explains the kanban case in its own error hint instead.
  //  - `100309` (`'project'不匹配`) and `1003107` (`发布与项目不匹配`, note the seven
  //    digits) — the sprint/version *pairing* checks. Both records exist; only the
  //    (project, child) pair is wrong, which is a mismatch rather than an absence.
  //    `1003107` is also the only one of the five version verbs that performs the
  //    check at all (D15.6).
  //  - `100343` (`'Iteration'已经存在`) and `100337` (`'version'已经存在`) — uniqueness
  //    conflicts on the name, judged exactly as `100220`/`100105` were.
  //  - `100390` (`'sprint.1''sprint'资源名称已存在`) and `100001`
  //    (`versions[1]:version named … had existed`, and also
  //    `versions[0].project_id不存在`) — the two bulk endpoints' rejections. `100001`
  //    is doubly disqualified: it carries a *missing parent* and a *name conflict*
  //    under one code, and both refuse the **whole batch**, so exit 5 would name one
  //    entry while implying the others landed — the reasoning that kept testhub's
  //    `100619` on exit 7.
  //  - `100042` (`开始时间必须小于结束时间`) and `100395`
  //    (`输入的'operate_at'必须在开始和发布时间之间`) — cross-field validation, like
  //    S1d's `100102`/`100041`.
  //  - `100003` (`'status'不是有效的枚举值`) and `100039` (`versions[1].name 是必填字段`,
  //    `versions 数组的长度必须大于等于 1`) — input validation. `100039` is the bulk
  //    twin of the cross-module `100008` and is refused for the same reason.
  //  - `100000` (`内部服务错误`) — a genuine HTTP **500**, returned when two entries of
  //    one bulk batch share a name. A server fault must keep its 500.
  '100308': 'not_found',
  '100304': 'not_found',
  // S2b (08-02-full-api-coverage) pjm work-item smoke, 2026-08-04, live tenant
  // (design D16). Three codes, all HTTP **400**, and all three are *composite-key*
  // absences — the row exists only as a pair, and the pair is what the URL addresses:
  //   100351 "工作项或工作项关联不存在" — GET **and DELETE**
  //     /v1/pjm/work_items/{item}/relations/{relation_id}, for an unknown relation id,
  //     for a relation id that belongs to a **different** work item, and for one that
  //     was just deleted. Three causes, one code, and every one of them means "there
  //     is no link at the address given". (The two directions of a link have different
  //     ids, so addressing one through the other end's item is the common mistake.)
  //   1003108 "工作项流转记录不存在" — GET
  //     …/work_items/{item}/transition_histories/{unknown}. Note the **seven** digits,
  //     like 发布's `1003107`. One verb, one meaning; nothing else answers it.
  //   100405 "成员不在项目中" — GET **and DELETE**
  //     …/projects/{project}/members/{member_id}, for an unknown id *and* for a real
  //     organisation user who simply is not in this project. The membership is the
  //     resource, so its absence is a not-found however the id was wrong.
  // Admitted for the reason every row above was: without them a missing link exited 7
  // while a missing work item exited 5 (`100317`), for the same mistake in the same
  // module. The precedent for the pair-shaped ones is S1c's `100222`, which was
  // admitted precisely because "a review id that exists but hangs off a different pull
  // request really is not at the address given".
  //
  // Deliberately **not** mapped, from the same smoke — five of them, and the first is
  // the one worth reading:
  //  - `100354` (`'tag'资源不存在`) on POST …/work_items/{id}/tags. **This is `100300`
  //    all over again** (S2a's most valuable veto): the tag it calls missing is one the
  //    user is looking at, because `GET /v1/pjm/work_item/tags?project_id=` returns the
  //    whole organisation's tags regardless of the project asked for, while the write
  //    accepts only the ones belonging to the work item's own project. Live: all 23
  //    listed tags were refused for a work item in one project and 8 of the 23 were
  //    accepted for a work item in another (re-measured exhaustively 2026-08-04 —
  //    design D16.3 corrects an earlier "two of them"). Exit 5 would send an agent
  //    hunting for a row `project meta tags` had just printed. The command layer
  //    explains the real cause instead.
  //  - `100357` (`工作项不包含此标签`) on GET …/tags/{tag_id}. This one is genuinely an
  //    absence of the pair, and it *would* qualify on the `100405` reasoning. It stays
  //    on 7, but the original reason was **wrong** and is corrected here (design D16.2).
  //    The claim was "the matching DELETE answers HTTP 500 for the same situation, so a
  //    mapping would make the same mistake exit 5 on a read and 7 on a write". Both
  //    halves were re-measured live 2026-08-04: the raw DELETE does answer 500
  //    `100000` on a repeat, but `project work-item tag delete` **reads the tag before
  //    the --yes gate**, so the refined leaf never reaches the DELETE — it reports the
  //    same 400 `100357` the read does. The two refined paths therefore already agree,
  //    and mapping would make both exit 5 consistently.
  //    What is left is a genuine judgement call rather than a defect, so it is being
  //    left alone rather than decided inside a cleanup commit: mapping it would split
  //    the refined leaves (exit 5) from `pingcode api DELETE` (exit 7, HTTP 500), which
  //    is the same split the old comment feared, only relocated. Revisit deliberately.
  //  - `100350` (`工作项关联已经存在`) and `100352` (`'tag'资源已经存在`) and `100407`
  //    (`成员已经在项目中`) — uniqueness conflicts, judged exactly as `100220` /
  //    `100343` / `100105` were.
  //  - `100043` (`不支持使用过滤条件 filter.X`), `100044`
  //    (`过滤条件 filter.X 缺少有效的操作符` / `不支持操作符: in`), `100335`
  //    (`'project'标识的格式不正确`), `100336` (`'project'标识已经存在`), `100001`
  //    (`'relation_type'格式不正确`) and `100039` (`member.type 必须是一个枚举值`) — input
  //    validation. The first two are *useful* input validation: `100043` names the
  //    offending filter path, which is how the search vocabulary in `endpoints.ts` was
  //    enumerated rather than guessed.
  //  - `100300` (`'project'资源不存在`) — reaffirmed **not** mapped. S2b met it three
  //    more times (an unknown project on `…/progress`, on
  //    `work_item/tags?project_id=` and on `PATCH /projects/{id}`) where it really does
  //    mean "no such project", but S2a proved it also fires for a project that plainly
  //    exists (a kanban project refusing a sprint create), and one code cannot be two
  //    answers.
  '100351': 'not_found',
  '1003108': 'not_found',
  '100405': 'not_found',
  // S3 (08-02-full-api-coverage) testhub smoke, 2026-08-04, live tenant (design §D17).
  // Two rows, both HTTP **400**, both the same shape every row above was admitted for —
  // one stable per-resource "this record is absent" code:
  //   100602 "测试计划不存在或无权限访问" — GET **and PATCH**
  //     /v1/testhub/libraries/{library}/plans/{plan}. Stable across all three ways of
  //     being wrong: an unknown 24-hex plan id, an unknown short_id-shaped id, and a
  //     **real plan addressed under the wrong library** (the library segment is
  //     genuinely validated here, unlike some pjm paths). A malformed id answers a real
  //     HTTP 404 instead, which the status branch already maps. Same 1006xx family and
  //     the same "不存在或无权限访问" wording as 100600/100601/100603, already mapped.
  //   100642 "执行历史不存在" — GET
  //     /v1/testhub/runs/{run}/histories/{history}, for a well-formed but unknown
  //     history id under a valid run. Nothing else answers it.
  // Without these, `testhub plans get`/`update` on a missing plan exited 7 while
  // `cases get` on a missing case exited 5 — the same mistake in the same module.
  //
  // Deliberately **not** mapped, from the same smoke — six of them, and the first two
  // are the ones worth reading:
  //  - `100619` (`执行用例不存在`) — it *does* mean "no such run" on
  //    `GET /runs/{unknown}/histories`, and it would have been an obvious row. But it is
  //    also what a `runs/bulk` batch answers when one entry names an unknown run, where
  //    it rejects the **whole batch**: exit 5 would then name one run while implying the
  //    valid entries landed, which they did not. One code cannot be two answers — the
  //    judgement that already kept `100300` and ship's `100719`/`100702` on exit 7.
  //  - `100643` (`执行历史和测试用例不匹配`) — a history id that exists but hangs off a
  //    **different** run. Note this is the mirror image of S1c's `100222`, which *was*
  //    admitted for exactly this situation: there the vendor reported the pair as absent,
  //    here it reports it as a mismatch, and the CLI follows what the API says rather
  //    than normalising the two. (The vendor's wording even says 测试用例 on a run path.)
  //  - `100016` (`存在无效run_id`) — the atomic pre-flight refusal of `PATCH /runs/bulk`.
  //    Batch-level, so the same reasoning as `100619`.
  //  - `100605` (`创建执行用例失败`) — adding a case the plan already contains. A
  //    uniqueness conflict, judged as `100220`/`100343`/`100105` were.
  //  - `100039` (`cases 数组的长度必须小于等于 100`, `updates[50].run_id 必须是一个 ObjectId`)
  //    and `100008` (`'run[0].status_id'是必填字段`) — input validation, and `100008` is
  //    the **cross-module** required-field code that must never be mapped anywhere.
  //  - `100000` (`内部服务错误`) — a genuine HTTP **500**, returned when a built-in field
  //    key is pushed through the `properties` map. A server fault keeps its 500.
  '100602': 'not_found',
  '100642': 'not_found',
  // S4 (08-02-full-api-coverage) ship 需求排期 + 流转记录 smoke, 2026-08-05, live tenant
  // (design §D18). **One** row, and it is the fourth transition-history code in this
  // table after pjm's `1003108` and testhub's `100642`:
  //   100740 "需求流转记录不存在" — GET
  //     /v1/ship/ideas/{idea}/transition_histories/{history}, for a well-formed but
  //     unknown history id **and** for a real history id addressed under a *different*
  //     idea. The idea segment is genuinely enforced here, so both are "no record at
  //     the address given" — the `100351`/`100222` reasoning, not the `100643` one
  //     (this vendor code says 不存在, it does not claim a mismatch). A malformed id
  //     answers a real HTTP 404 `100002`, which the status branch already maps, and an
  //     unknown *parent* idea answers `100725`, mapped since S7b.
  //
  // Deliberately **not** mapped, from the same smoke:
  //  - `100721` (`产品排期不存在`) — the honest gap of this child. It reads like an
  //    obvious row: GET /v1/ship/products/{p}/plans/{unknown} answers it, and so does
  //    `PATCH /v1/ship/ideas/{id}` with an unknown `plan_id`, always meaning "no such
  //    排期". But the case that disqualified `100354` and `100300` — a row that plainly
  //    exists, addressed under the wrong parent — is **unobservable in this tenant**,
  //    which holds zero 排期 rows in all three products, and the write path above is
  //    exactly where a user would hand over a schedule id from another product. Mapping
  //    it would be asserting unambiguity that was not measured. It stays on exit 7 until
  //    a tenant with ≥1 排期 in two products can settle it; `product plan get` says so
  //    in its own help.
  //  - `100701` (`产品不存在或无权访问`) — ship's `100300`. It is the *parent* absence
  //    code shared by the whole product-scoped surface (both new lists answer it), so
  //    admitting it would silently re-map ten existing `product meta` leaves from a
  //    5-endpoint child, and pjm's twin proved a parent code can also mean "this module
  //    is not available here" — a distinction this tenant cannot test either.
  //  - `100008` (`'product_id'是必填字段`) — the **cross-module** required-field code,
  //    refused here for the fourth time.
  //  - `100003` (`'product_id'不是有效的字符串(不是有效的id)`) and `100009`
  //    (`'page_size'的取值范围是1到100`) — input validation. `100009` is a *new* code and
  //    a welcome one: it proves the server enforces the same page-size cap the CLI
  //    already refuses client-side.
  '100740': 'not_found',
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
