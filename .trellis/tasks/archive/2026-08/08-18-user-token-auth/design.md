# Design — user-token (authorization_code) auth mode

Implements `.trellis/tasks/08-18-user-token-auth/prd.md`. Decisions are numbered **D1…**.
File references are to current `main`.

---

## 1. Storage model — two slots, one active mode

**D1.** Extend the on-disk `Config` with three new keys; keep the existing `token`
field as the **enterprise** slot (backward compatible — R6):

```ts
type Config = {
  host?; apiBase?;
  clientId?; clientSecret?;                 // app creds, shared by BOTH grants (same registration)
  oauthRedirectUri?: string;                 // NEW — registered loopback callback, e.g. http://127.0.0.1:8732/callback
  token?: TokenRecord;                        // ENTERPRISE slot (existing)
  userToken?: UserTokenRecord;                // NEW — USER slot (access + refresh)
  authMode?: 'enterprise' | 'user';           // NEW — which slot is active
};
```

- `UserTokenRecord` = `TokenRecord & { kind: 'user'; refreshToken: string }`.
- `TokenRecord` gains an explicit `kind: 'enterprise' | 'user'` (R10) and optional
  `refreshToken?` (only user tokens set it). Both are coerced defensively; a legacy
  `token` with no `kind` coerces to `kind: 'enterprise'` (R6).
- The app's `client_id`/`client_secret` serve **both** grants — the authorization-code
  exchange also takes `client_id`+`client_secret`+`code` (`api-101722142`). No second
  credential set is needed.

**D2 — active-mode inference (backward compat).** `resolveSettings` derives the active
mode when `authMode` is absent:
- `userToken` present → `user`
- else `token` present → `enterprise` (legacy, R6 — never flipped on upgrade)
- else neither → `user` (the requested default for brand-new setups, R2)

**D3 — merge & coercion.** `coerceConfig`/`coerceToken` must accept the new keys
(today they **drop unknown keys** → silent data loss). `ConfigPatch` already covers
`keyof Config`, so the new keys are patchable for free. `saveConfig`'s re-read+merge is
reused unchanged.

## 2. Context — track the active kind

**D4.** `AuthSession` gains the active mode; `Ctx` gains the loopback callback info
needed by the authorize step:

```ts
type AuthSession = {
  mode: 'enterprise' | 'user';     // NEW — drives gating + refresh routing
  token?: TokenRecord;
  inflight?: Promise<TokenRecord>;
  clampWarned: boolean;
};

type Ctx = {
  ...
  credentials: { clientId?; clientSecret? };
  oauth: { redirectUri?: string };  // NEW — parsed callback host/port for the loopback
  auth: AuthSession;
  persistToken?: (token: TokenRecord) => void;  // signature kept
};
```

`buildContext` (`src/cli/globals.ts`) loads the active slot's token into `ctx.auth.token`
and stamps `ctx.auth.mode` from `settings.authMode`. `ctx.oauth.redirectUri` =
`settings.oauthRedirectUri`.

**D5 — mode-aware `persistToken`.** The existing hook signature `(token) => void` is
kept, but its implementation routes by `token.kind`:

```ts
persistToken: (token) => {
  const mode = token.kind;                       // 'enterprise' | 'user'
  const slot = mode === 'user' ? { userToken: token } : { token };
  saveConfig({ ...slot, authMode: mode }, env);  // stamp the active mode on every write
}
```

This means a user-token refresh that rotates the access token writes `userToken` + keeps
`authMode='user'`, and never touches the enterprise `token` slot (R1).

## 3. Token acquisition — split by grant

**D6.** `src/core/auth.ts` keeps `client_credentials` as-is and adds two acquirers:

```ts
// exchange the operator-supplied code → user token (R3, R4)
async function acquireUserToken(ctx, code: string): Promise<TokenRecord> {
  // GET {apiBase}/v1/auth/token?grant_type=authorization_code&client_id=…&client_secret=…&code=…
  // → { access_token, refresh_token, token_type, expires_in }
  // returns TokenRecord { kind:'user', accessToken, refreshToken, expiresAtMs, obtainedAtMs, scope? }
}

// refresh a user token (R5)
async function refreshUserToken(ctx, refreshToken: string): Promise<TokenRecord> {
  // GET {apiBase}/v1/auth/token?grant_type=refresh_token&refresh_token=…
  // → { access_token, token_type, expires_in }   (NO new refresh_token)
  // returns TokenRecord { kind:'user', accessToken, refreshToken: <SAME refreshToken>, expiresAtMs, … }
}
```

Both reuse `buildUrl`, `sendRequest(skipAuth)`, `readResponse<TokenResponse>`, and
`normalizeExpiry` (unchanged — the placeholder-clamp already covers the undocumented
user-token `expires_in`). `TokenResponse` gains `refresh_token?: unknown`.

**D7 — `ensureFreshToken` becomes mode-aware** (single inflight preserved, per active
token):

```ts
async function ensureFreshToken(ctx, { force } = {}) {
  const mode = ctx.auth.mode;
  if (force) { ctx.auth.token = undefined; ctx.auth.inflight = undefined; }
  if (!force && tokenIsFresh(ctx.auth.token, ctx.now())) return ctx.auth.token!.accessToken;

  const acquire = mode === 'user' ? refreshAcquirer(ctx) : acquireEnterprise(ctx);
  const pending = ctx.auth.inflight ?? (ctx.auth.inflight = acquire.finally(() => { ctx.auth.inflight = undefined; }));
  return (await pending).accessToken;
}
```

- `enterprise` → existing `acquireToken(ctx)` (re-acquire from credentials).
- `user` → `refreshUserToken(ctx, ctx.auth.token!.refreshToken!)` when a refresh token
  exists; if there is no token/refresh yet (fresh login), the caller (`runLogin`) supplies
  the code path via `acquireUserToken` instead — `ensureFreshToken` only ever *refreshes*,
  never performs the initial code exchange.
- Refresh failure (refresh token rejected → `AuthError` `100034`, or any non-2xx) is
  **not** swallowed: it surfaces as `AuthError("user token refresh failed", { hint: "run
  \`pingcode auth login\`" })` (R5). The reactive 401 path in `http.ts` already calls
  `ensureFreshToken({force:true})` once and replays — this works for both modes unchanged.

**D8 — the 401 replay loop still holds.** `http.ts` is untouched: Bearer injection and the
single 401→force-reacquire→replay are mode-agnostic once D7 routes correctly.

## 4. Gating USER-only endpoints on the held kind

**D9.** `refuseUserTokenEndpoint` (`src/cli/commands/api.ts:512`) consults the active kind
instead of refusing unconditionally:

```ts
function refuseUserTokenEndpoint(ctx, candidates) {
  if (!candidates.every(e => e.tokenType === 'USER')) return;   // not a USER-only call
  if (ctx.auth.mode === 'user') return;                         // a user token CAN do it (R7)
  throw new UsageError("… requires a 用户令牌; the active token is an 企业令牌", { hint });
}
```

Requires threading `ctx` into `runVerb` (it already builds `ctx` at api.ts:247). The 61
ENT-only endpoints stay usable by both (enterprise = admin; user = if permitted). Update
`AUTHORIZE_HINT` and the "NOT reachable" copy in `tokenLine`/`warningsFor` to reflect that
user-token mode now exists.

## 5. Login command — mode picker + two authorize channels

**D10.** `auth login` gains `--mode enterprise|user` (default `user`, R2). Interactive mode
prompt (stderr, TTY-only, `--json` disables) pre-selects `user`:

```
auth mode [user]:
  user        authorization_code — acts as you (default)
  enterprise  client_credentials — app/admin identity
```

**D11 — enterprise path** is unchanged: `clearToken` → `acquireToken` (client_credentials)
→ `verifyAccess` (listProjects) → persist `token` + `authMode='enterprise'`.

**D12 — user path** (new):

1. Ensure app `client_id`/`client_secret` (prompt if missing, same as today).
2. Ask the authorization channel:
   ```
   authorize via [browser]:
     browser  open the authorize URL, you log in + consent, CLI catches the redirect
     paste    print the authorize URL, you paste the code you generated
   ```
3. Build the authorize URL: `{oauthRoot}/authorize?response_type=code&client_id={clientId}`,
   where `oauthRoot(host)` = origin + `/oauth2` (**live-verify** for self-hosted; the
   authorize page is excluded from the catalog by D2.8). Print it (redacted of secrets —
   it carries only `client_id`) to stderr.
4. Obtain `code`:
   - **browser** → `await captureCodeFromLoopback(ctx)` (D13).
   - **paste** → `promptVisible('authorization code: ', json)` (stderr).
5. `token = await acquireUserToken(ctx, code)` (D6); `clearToken` first, then persist
   `userToken` + `authMode='user'` (D5).
6. `verifyAccess` swaps to `GET /v1/myself` for user mode (returns the user, proves the
   token and gives the displayed identity). Add `api/meta.ts` `getMyself(ctx)` (or a small
   `api/account.ts`).
7. Print JSON / field block (mode, masked client id, user display name from `/v1/myself`,
   token expiry).

**D13 — loopback code capture (browser channel).** New helper, e.g.
`src/cli/commands/oauth.ts`:

```ts
async function captureCodeFromLoopback(ctx, { timeoutMs = 120_000 }): Promise<{ code: string; domain?: string }> {
  // parse port from ctx.oauth.redirectUri (default 127.0.0.1:8732)
  // http.createServer → listen on that port
  // on GET: parse URL for `code`; if present, respond 200 "you can close this tab",
  //   resolve { code, domain }, server.close()
  // on timeout → reject AuthError("authorization timed out", { hint: re-run, or use --channel paste })
}
```

- Best-effort open the authorize URL in the default browser; **always** print it so a
  remote/headless operator can open it manually. If the port is busy → actionable error
  naming the configured `oauthRedirectUri`.
- Catches exactly one request then shuts down; no persistent listener.
- Constraint surfaced in PRD: the browser and the CLI must be on the **same machine**
  (loopback). The paste channel is the remote-safe fallback (R3).

**D14 — `auth status` / `auth logout`.** `status` reports `authMode`, the active token's
`kind`, masked client id, and `userToken.refreshToken` presence (R8/AC8). `logout`
clears the **active** slot by default; `logout --all` clears both slots + `authMode`
(R9/AC9). Both keep `host`.

## 6. Errors & exit codes

Reuse the existing hierarchy unchanged:
- Missing/invalid `code`, code-exchange failure → `AuthError` (exit 3), hint → `auth login`.
- Refresh failure → `AuthError` (exit 3), hint → `auth login` (R5).
- USER-only endpoint refused under enterprise → `UsageError` (exit 2) with the updated hint.
- Loopback timeout / port busy → `AuthError` / `UsageError` respectively.

No new error kinds.

## 7. Config file evolution (on-disk)

Before:
```json
{ "host": "…", "clientId": "…", "clientSecret": "…",
  "token": { "accessToken": "…", "expiresAtMs": …, "obtainedAtMs": …, "scope": "…" } }
```
After (user mode active):
```json
{ "host": "…", "clientId": "…", "clientSecret": "…",
  "oauthRedirectUri": "http://127.0.0.1:8732/callback",
  "authMode": "user",
  "token": { "accessToken": "…", "expiresAtMs": …, "obtainedAtMs": …, "kind": "enterprise", "scope": "…" },
  "userToken": { "accessToken": "…", "refreshToken": "…", "expiresAtMs": …, "obtainedAtAtMs": …,
                 "kind": "user", "scope": "…" } }
```
`coerceConfig` tolerates a legacy file (no `authMode`, no `kind`) via D2.

## 8. Risks & mitigations

- **R-a 权限收窄 (user token narrower than admin).** Real, per the API contract.
  Mitigation: switchable back to enterprise by re-login (R8); document the trade-off in
  `auth login` help and the skill doc.
- **R-b Loopback requires same-machine browser.** Mitigation: paste channel always
  available; print the URL regardless.
- **R-c `oauthRoot` / token lifetimes undocumented.** Mitigation: live-verify and record
  per the Live Verification / Catalog Drift guides; `normalizeExpiry` clamp is the safety net.
- **R-d Refresh returns no new refresh_token.** Handled in D6 (retain the stored one).
- **R-e `coerceConfig` currently drops unknown keys.** Fixed in D3 — without it, the new
  fields would silently vanish on the next save.

## 9. Rollout / rollback

- Rollout: additive — new config keys, new acquirers, login branches. Enterprise path is
  byte-for-byte unchanged (D11). Legacy configs infer enterprise (D2).
- Rollback: the new keys are ignored by the old code (`coerceConfig` would drop them, but
  the old `token` slot still works). Reverting the binary restores pure enterprise behavior;
  the persisted `userToken`/`authMode` are inert to old code.
