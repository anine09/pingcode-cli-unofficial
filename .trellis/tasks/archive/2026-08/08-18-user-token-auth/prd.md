# User-token (authorization_code) auth mode

## Goal

Let `pingcode` authenticate **as the current human user** via the OAuth2
**authorization-code** flow, so that writes (create work item, add comment, change
state, …) are attributed to that person in PingCode instead of the application bot
"Ping". This user-token mode (用户令牌) **coexists** with the existing
`client_credentials` enterprise token (企业令牌); the operator picks the mode at
login, and the **default is the user token**.

Today every operation shows up under the bot because the CLI only holds an
enterprise token, which PingCode documents as "不区分用户身份" (not tied to any user).

## Background & source of truth

### The two PingCode identities (official, REST API v1.3.0)

> 本次开放的 REST API，支持两类使用者：**企业身份**和**个人身份**。
> 企业身份需要通过 Client Credentials 的方式获取身份令牌，使用者可以查看和操作**所有**已开放的资源。
> 个人身份需要通过 Authorization Code 的方式获取身份令牌，使用者**只能查看和操作自己有权限的**已开放的资源。

- **企业令牌 (enterprise / app token)** — `grant_type=client_credentials`, only
  `client_id`+`client_secret`. Not user-bound, system-admin level, sees **all**
  resources, **no refresh_token**, valid 30 days. → current CLI behavior (bot "Ping").
- **用户令牌 (user token)** — `grant_type=authorization_code`, bound to the
  authorizing human, subject to **that user's own permissions**, **returns a
  `refresh_token`**. → operations attributed to the real user. **This is the new mode.**

### External API contract (official Apifox spec, `https://pingcode.apifox.cn`)

Token endpoint is `GET {apiBase}/v1/auth/token` (all params in the query string,
`client_secret` included — non-standard but documented):

| grant | params | response |
|---|---|---|
| `client_credentials` (企业令牌) | `client_id`, `client_secret` | `access_token`, `token_type`, `expires_in` |
| `authorization_code` (用户令牌) | `client_id`, `client_secret`, `code` | `access_token`, `refresh_token`, `token_type`, `expires_in` |
| `refresh_token` (刷新) | `refresh_token` | `access_token`, `token_type`, `expires_in` (**no new refresh_token**) |

- Authorize page: `{host}/oauth2/authorize?response_type=code&client_id=…`.
  **Requires an authenticated browser session** (login cookie) — there is no
  anonymous `transaction_id`. So the CLI cannot obtain the `code` headlessly.
- Final redirect: `{redirect_uri}?code={code}&domain={domain}` — `redirect_uri` is
  **configured server-side** in PingCode 凭据管理 (credential management), not sent
  as a request param.
- Identify the user: `GET /v1/myself` (USER-only endpoint).
- Refresh lifetime / user-token lifetime are **not documented** (the sample
  `expires_in` `1577808000` is a placeholder). Measure empirically; the existing
  `normalizeExpiry` clamp handles placeholder values.

Cited: enterprise `api-101722138`, user `api-101722142`, refresh `api-101722143`,
authorize `api-101722140`, authorized `api-101822141`, signin `api-101722139`,
folder `https://pingcode.apifox.cn/folder-20092472`, blog
`http://blog.pingcode.com/rest-api-v1-3-0-agile/`.

### Current code (the thing being extended)

Single-mode, enterprise-only, fully mapped by reconnaissance
(`src/core/{auth,config,context}.ts`, `src/cli/{globals,commands/auth}.ts`,
`src/core/http.ts`, `src/cli/commands/api.ts`):

- `Config` holds **one** `token?: TokenRecord`; `TokenRecord` has no `kind`/`refresh_token`.
- `AuthSession` = one `token` + one `inflight` + `clampWarned`.
- `acquireToken` hardcodes `grant_type=client_credentials`.
- `ensureFreshToken` "refreshes" by re-acquiring from credentials (no real refresh).
- `persistToken` merges only `{token}`.
- `refuseUserTokenEndpoint` **unconditionally refuses** all 7 USER-only endpoints
  ("this CLI only holds an 企业令牌").
- The catalog already documents the `authorization_code` and `refresh_token` grants
  (token exchange), but the authorize page is excluded by design (D2.8).
- `verifyAccess` = `listProjects(pageSize:1).total` (an org-token capability).

## Requirements

**R1 — Coexistence.** The enterprise-token and user-token mechanisms coexist. Both
can be logged in and stored; switching modes does not invalidate the other token.

**R2 — Login chooses the mode; default is user token.** `auth login` lets the operator
choose `enterprise` (client_credentials) or `user` (authorization_code). When no prior
choice exists, the **default is the user token**.

**R3 — Two authorization channels for the user token.** Obtaining the user token
supports **both**:
- **Browser authorization**: open `{host}/oauth2/authorize?response_type=code&client_id=…`,
  the operator logs in + consents in the browser, and the CLI catches the redirect
  `{redirect_uri}?code=…&domain=…` on a short-lived local loopback listener.
- **Manual code paste**: print the authorize URL to stderr and prompt the operator to
  paste the `code` they obtained (the operator can generate it in the background).

**R4 — Operations attributed to the user.** When the user token is active, REST writes
execute as that human user and appear under their name in PingCode (per the official
"个人身份" statement). ✅ confirmed feasible by the API contract.

**R5 — User-token refresh.** The user token is refreshed with `grant_type=refresh_token`
(real rotation: new `access_token`; the stored `refresh_token` is retained because the
refresh response returns no new one). A failed/expired refresh surfaces an actionable
`auth login` error.

**R6 — Enterprise flow unchanged (backward compatibility).** Existing configs with only
an enterprise token keep working exactly as today. Legacy configs (no `authMode` field)
that already hold an enterprise token infer `enterprise` mode — they are **not** flipped
to user token on upgrade.

**R7 — USER-only endpoints reachable with a user token.** The 7 USER-only endpoints
(currently hard-refused) become usable when a user token is active; they stay refused
when only an enterprise token is held.

**R8 — Switchable.** The operator can switch between modes by re-running `auth login`
and choosing the other mode (both slots are persisted, so switching is fast).

**R9 — Credential security.** All existing contracts hold: config file `0600`/dir
`0700`, every printable URL redacted (`client_secret` travels in the query string),
no secret logged. The **manual** flow never stores the operator's password; the CLI
only ever holds `client_secret` (the app secret) and, for user tokens, a `code`/tokens.

**R10 — Token-type is tracked, not opaque.** The held token carries an explicit
`kind` (`enterprise` | `user`) so R7 gating and refresh routing are deterministic
rather than guessed.

## Acceptance criteria

- AC1: `auth login` (interactive, no flags) prompts for the mode and **pre-selects
  `user`**; choosing `user` completes a browser OR manual-code authorization and ends
  with a verified, persisted user token.
- AC2: `auth login --mode enterprise` (or equivalent) behaves exactly as today's
  client_credentials login.
- AC3: With a user token active, `refuseUserTokenEndpoint` **allows** the 7 USER-only
  endpoints; with an enterprise token active it still refuses them.
- AC4: A user-token write is attributed to the authenticating user in PingCode
  (verified live against a real user token on `/v1/myself` + one write read-back).
- AC5: User-token refresh: forcing expiry triggers a `grant_type=refresh_token` call
  that yields a fresh `access_token`; an invalid refresh token yields an `AuthError`
  pointing at `auth login`.
- AC6: A legacy config (enterprise token, no `authMode`) loads as `enterprise` mode
  with no behavior change; a brand-new config with no token defaults to `user`.
- AC7: The browser flow's loopback listener is bound to a configurable port (default
  `8732`); the registered `redirect_uri` matches it; the `code` is captured and the
  server shuts down.
- AC8: `auth status` reports the active mode, masked identifiers, token kind, and
  refresh-token presence for the user slot.
- AC9: `auth logout` clears the active slot (and, with an explicit all-mode flag, both).

## Constraints

- Layering invariant unchanged: `core` imports neither `cli` nor `api`
  (`test/layering.test.ts` stays green).
- `--json` means stdout is JSON only; all prompts, the authorize URL, and loopback
  lifecycle logs go to **stderr**.
- No network in unit tests — the authorize `code`, token exchange, and refresh are all
  exercised via the injected `fetch` (`test/helpers/fake.ts`).
- API facts come from the official Apifox spec above; live-verify the oauth root and
  token/refresh lifetimes, and record any docs-vs-live disagreement per the
  [Live Verification](./live-verification.md) and [Catalog Drift](./catalog-drift.md) guides.

## Out of scope

- Per-command runtime `--auth-mode` override (re-login covers switching in this task).
- Storing the operator's login password (the "simulated silent authorization" signin
  path is explicitly rejected — R9).
- PKCE, `state` validation, or rotating `refresh_token` (the API returns none on refresh).
- Changing the 61 ENT-only / 7 USER-only endpoint classification (catalog is generated,
  untouched here).
