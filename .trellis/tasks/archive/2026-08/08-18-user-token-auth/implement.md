# Implement — user-token (authorization_code) auth mode

Executes `prd.md` / `design.md`. Ordered checklist; each step has a validation gate.
Keep exactly one `in_progress` while working. Roll back per Phase 2.3 if a gate fails.

Dependencies: §A is config/context foundation (everything builds on it). §B (acquiring)
and §C (gating) are independent of each other after §A. §D (login UX) depends on §B and §C.
§E (tests) lands with each layer, not at the end.

Legend: `[once]` = skip if the artifact already exists.

---

## A. Foundation — config + context (design D1–D5)

- [ ] **A1.** `src/core/config.ts`: add `kind` to `TokenRecord`
  (`'enterprise' | 'user'`) and optional `refreshToken?`. Add to `Config`:
  `oauthRedirectUri?`, `userToken?: UserTokenRecord`, `authMode?: 'enterprise' | 'user'`.
  Define `UserTokenRecord`.
  - Gate: `npx tsc --noEmit` passes.
- [ ] **A2.** `coerceToken`/`coerceConfig`: coerce the new keys; **default `kind` to
  `'enterprise'` when absent** (R6). Confirm unknown-key dropping no longer eats them.
  - Gate: unit test — a raw object with `userToken`+`authMode` round-trips through
    `loadConfig`/`saveConfig` (tweak `test/globals.test.ts` or add `test/config.test.ts`).
- [ ] **A3.** `resolveSettings`: derive `authMode` via **D2 inference**
  (userToken→user, token→enterprise, neither→user). Surface `oauthRedirectUri` and the
  active token (user or enterprise slot) on `ResolvedSettings`.
  - Gate: unit tests for the three inference branches.
- [ ] **A4.** `src/core/context.ts`: `AuthSession` gains `mode`; `Ctx` gains
  `oauth: { redirectUri? }`. `createContext` defaults `auth.mode` from input.
  - Gate: `npx tsc --noEmit` passes; existing `createTestContext` consumers still compile.
- [ ] **A5.** `src/cli/globals.ts` `buildContext`: stamp `ctx.auth.mode` from settings;
  load the **active slot's** token into `ctx.auth.token`; set `ctx.oauth.redirectUri`.
  Make `persistToken` mode-aware (**D5**): route by `token.kind` to the right config slot
  and stamp `authMode`.
  - Gate: `test/globals.test.ts` — `persistToken({kind:'user',…})` writes `userToken`
    (not `token`); enterprise write still writes `token`; `authMode` stamped both ways.

## B. Token acquiring — user grant + refresh (design D6–D8)

- [ ] **B1.** `src/core/auth.ts`: `TokenResponse` gains `refresh_token?`.
- [ ] **B2.** Add `acquireUserToken(ctx, code)` — `grant_type=authorization_code`
  exchange (D6). Returns `TokenRecord { kind:'user', refreshToken, … }`. Redact the URL in
  debug logs (it now also carries `code`).
  - Gate: `test/auth.test.ts` — fake the token endpoint; assert query shape
    (`grant_type=authorization_code&code=…&client_id=…&client_secret=…`), `refresh_token`
    captured, `kind:'user'`, expiry normalized, persisted.
- [ ] **B3.** Add `refreshUserToken(ctx, refreshToken)` — `grant_type=refresh_token`
  (D6). Retains the **same** `refreshToken` (refresh response has none). `normalizeExpiry`
  reused.
  - Gate: `test/auth.test.ts` — assert query, new `access_token`, **same** `refreshToken`,
    `kind:'user'`.
- [ ] **B4.** `ensureFreshToken` mode-aware (**D7**): enterprise→`acquireToken`,
  user→`refreshUserToken` (from `ctx.auth.token.refreshToken`). Single inflight preserved.
  Refresh failure → `AuthError("user token refresh failed", {hint: auth login})`.
  - Gate: `test/auth.test.ts` — user mode refreshes via `refresh_token` (not
    client_credentials); enterprise still re-acquires; refresh failure surfaces `AuthError`;
    inflight serialization holds for user mode.
- [ ] **B5.** Confirm `src/core/http.ts` needs **no change** (D8): Bearer injection and the
  401→force-reacquire→replay once loop are mode-agnostic.
  - Gate: `test/http.test.ts` 401-replay test still green; add a user-mode 401 replay case
    if cheap.

## C. Gating USER-only endpoints on held kind (design D9)

- [ ] **C1.** Thread `ctx` into `runVerb` (`src/cli/commands/api.ts`); update
  `refuseUserTokenEndpoint(ctx, candidates)` to allow USER-only when `ctx.auth.mode==='user'`
  and refuse when `enterprise`.
  - Gate: unit/command test — with a user-token context, a USER-only endpoint no longer
    throws; with enterprise context it still throws `UsageError` (exit 2).
- [ ] **C2.** Update `AUTHORIZE_HINT` and the `tokenLine`/`warningsFor` "NOT reachable" copy
  to reflect that user-token mode exists.
  - Gate: `test/help.test.ts` / api-list snapshot updated intentionally (read the diff).

## D. Login UX — mode picker + two authorize channels (design D10–D14)

- [ ] **D1.** `src/api/meta.ts` (or new `src/api/account.ts`): add `getMyself(ctx)` →
  `GET /v1/myself`, returning the user (name/username/id). Add a `parseMyself`/type.
  - Gate: `npx tsc --noEmit`; unit test with fake fetch.
- [ ] **D2.** `src/cli/commands/oauth.ts` (new): `buildAuthorizeUrl(host, clientId)` and
  `captureCodeFromLoopback(ctx, opts)` (D13) — bind to `ctx.oauth.redirectUri` port
  (default `127.0.0.1:8732`), catch one `?code=` GET, respond, close; timeout → actionable
  error. Print + best-effort-open the authorize URL.
  - Gate: unit test with a fake `http.createServer` seam or a spawned listener; assert
    `code`/`domain` parsed, one-shot shutdown, timeout error, port-busy error.
- [ ] **D3.** `src/cli/commands/auth.ts` `runLogin`: add `--mode` (default `user`), the mode
  prompt (D10), the channel prompt (browser/paste, D12 step 4), the authorize URL, and the
  two code-acquisition branches. Enterprise branch byte-for-byte unchanged (D11).
  - Gate: `test/auth` command-level tests (fake fetch) for: user+browser (loopback stub),
    user+paste (code prompt), enterprise (unchanged).
- [ ] **D4.** User-mode verification via `getMyself` (D12 step 6); enterprise via
  `listProjects` (unchanged). Print mode + user name.
  - Gate: login JSON output includes `mode`, `kind`, and (user) `user`.
- [ ] **D5.** `runStatus`: report `authMode`, active `kind`, `userToken.refreshToken`
  presence. `runLogout`: clear active slot; add `--all` to clear both (D14).
  - Gate: status/logout tests for each mode + `--all`.

## E. Cross-cutting

- [ ] **E1.** `test/layering.test.ts` green (no `core ← cli/api` import added).
- [ ] **E2.** Full suite: `npm test` (or the repo's test command) green; no snapshot churn
  beyond the intentional api-list/help updates in C2.
- [ ] **E3.** Lint/type/format per the repo's `package.json` scripts.
- [ ] **E4.** **Live verification** (probe isolation — never real credentials in tests): run
  `auth login --mode user` + paste channel against a real user token; confirm `/v1/myself`
  returns the user and one write read-back is attributed to that user (AC4). Live-verify
  `oauthRoot` for cloud + (if available) self-hosted, and record the user-token/refresh
  lifetimes (R-c). Write findings to `research/` per the guides.

---

## Review gates

- After §A: config/context foundation reviewed before building acquirers on it.
- After §C: gating + login UX reviewed together (D reads both).
- Before §E4 live run: operator confirms the registered `redirect_uri` matches the CLI port.

## Rollback points

- §A is additive and isolated; revert the config/context commit if inference or coercion
  breaks legacy load.
- §D login is the riskiest UX; the enterprise branch is untouched, so a user-mode failure
  never breaks the existing flow.
