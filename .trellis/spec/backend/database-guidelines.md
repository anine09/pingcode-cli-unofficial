# Local State & Persistence

> This project has **no database**. What it does have is credential and cache state on the user's
> disk, and that state is security-sensitive — so the same discipline applies.

---

## Overview

There is no ORM, no migrations, no SQL. Persistence is two things under `~/.pingcode/`
(relocatable via `PINGCODE_CONFIG_DIR`), both owned exclusively by `src/core/config.ts` and
`src/core/metadata.ts`:

| Path | Contents | Written by |
|---|---|---|
| `~/.pingcode/config.json` | `host`, `clientId`, `clientSecret` (only with `--save`), the active token slot + its `kind`, `authMode`, `oauthRedirectUri` | `core/config.ts` |
| `~/.pingcode/cache/<sha256>.json` | resolved metadata lists (types, states, priorities, sprints, users, projects) | `core/metadata.ts` |

Nothing else in the codebase may read or write these files. `cli/` is forbidden from importing
`node:fs` at all (enforced by `test/layering.test.ts`).

---

## Dual-auth storage contract (two grants, two slots)

The CLI holds **two coexisting token kinds** via two grants on the same token endpoint
`GET {apiBase}/v1/auth/token` (all params in the query string):

| Grant | `kind` | Stored in | `refresh_token`? | Authority |
|---|---|---|---|---|
| `client_credentials` | `enterprise` | `token` | no | system-admin, all resources, **not user-bound** (the bot "Ping") |
| `authorization_code` | `user` | `userToken` | **yes** | bound to the authorizing human, that user's own permissions |

**Config shape** (`src/core/config.ts`):

```ts
type TokenRecord = {
  accessToken: string;
  expiresAtMs: number;   // always absolute ms (never raw expires_in)
  obtainedAtMs: number;
  scope?: string;
  kind?: 'enterprise' | 'user';   // absent => coerced to 'enterprise' (legacy compat)
  refreshToken?: string;           // present only for user tokens
};
type UserTokenRecord = TokenRecord & { kind: 'user'; refreshToken: string };
type Config = {
  host?; apiBase?;
  clientId?; clientSecret?;         // ENTERPRISE app creds (client_credentials)
  userClientId?; userClientSecret?; // USER app creds (authorization_code) — a SEPARATE app
  oauthRedirectUri?: string;        // registered loopback callback for the browser channel
  token?: TokenRecord;              // ENTERPRISE slot (legacy field name kept)
  userToken?: UserTokenRecord;      // USER slot
  authMode?: 'enterprise' | 'user'; // which slot is active
};
```

### Rules (executable, test-covered)

1. **Active-mode inference (`resolveSettings`, when `authMode` is absent):** `userToken`
   present → `user`; else `token` present → `enterprise`; else neither → `user` (the default
   for brand-new setups). An explicit `authMode` always wins. A **legacy config** with only
   an enterprise token (no `authMode`) infers `enterprise` — it is never flipped to `user` on
   upgrade.
2. **`kind` defaults to `enterprise`.** `coerceToken` must stamp a missing `kind` to
   `'enterprise'`, so a legacy `token` record keeps working and `UserTokenRecord` (which
   requires `kind:'user'` + `refreshToken`) never matches it. `coerceUserToken` rejects a
   `userToken` whose `kind !== 'user'` or that lacks a `refreshToken`.
3. **`coerceConfig` must coerce every known key.** It drops unknown keys; the NEW keys
   (`userToken`, `authMode`, `oauthRedirectUri`, `kind`, `refreshToken`) are known and MUST be
   coerced or they vanish on the next save (silent data loss).
4. **Mode-aware `persistToken`.** The single hook routes by `token.kind`: `kind==='user'`
   writes `{ userToken, authMode:'user' }`; otherwise `{ token, authMode:'enterprise' }`. Every
   token persistence stamps `authMode`.
5. **Refresh rotation retains the `refresh_token`.** `grant_type=refresh_token` returns a new
   `access_token` but **no** new `refresh_token` — keep the stored one. Enterprise tokens have
   no refresh: "refresh" = re-acquire via `client_credentials`.
6. **`ensureFreshToken` is mode-aware** but keeps a single in-flight serialization per active
   token. In user mode, the reactive 401→re-acquire path must NOT clear `ctx.auth.token` (the
   `refresh_token` lives on it) — only clear `inflight`. Enterprise force-refresh clears both.
7. **Credentials are per-mode, not shared.** The two grants can use **two separate apps**:
   enterprise reads/writes `clientId`/`clientSecret` (env `PINGCODE_CLIENT_ID`/`PINGCODE_CLIENT_SECRET`);
   user mode reads/writes `userClientId`/`userClientSecret` (env `PINGCODE_USER_CLIENT_ID`/
   `PINGCODE_USER_CLIENT_SECRET`). `buildContext` routes the ACTIVE credentials (`ctx.credentials`)
   by the effective mode: user mode → `override ?? userClientId ?? clientId` (falls back to the
   enterprise app for a single-app setup); enterprise → `override ?? clientId`. This is what lets
   a user login with a new app **without clobbering** the stored enterprise app.
8. **Login routes persistence to the mode's slot.** `finishLogin` writes the app credential to
   `userClientId`/`userClientSecret` in user mode, `clientId`/`clientSecret` in enterprise. Gate
   (mirrors the enterprise rule): a credential already equal to the file's slot value is not
   rewritten (file source); one from a flag/env persists only with `--save`. The enterprise
   fallback (no user app configured) is **not** written to the user slot.

### Logout semantics

- **default** — clears the **active** slot + `authMode` (clearing `authMode` is required: with
  it still pointing at an emptied slot, `resolveSettings` would hide the surviving slot). The
  other slot + app credentials survive for instant switch-back.
- **`--all`** — wipes both slots + `authMode` + app credentials; `host` is kept.

> **Gotcha — don't conflate the two identities.** An enterprise token is NOT a user token. The
> 7 USER-only endpoints are refused while an enterprise token is held and allowed when a user
> token is held (`refuseUserTokenEndpoint` gates on `ctx.auth.mode`). Verification differs too:
> enterprise verifies via `GET /v1/pjm/projects`; user mode verifies via `GET /v1/myself`.

> **Gotcha — the credential names an APP, not a USER.** `client_id` identifies which app is
> requesting, never which human. In the authorization-code flow the **user is whoever logs in at
> `{host}/oauth2/authorize` and consents** — the resulting `code` (and thus the user token) is
> bound to that logged-in identity. This is why the paste channel works for a self-serve user:
> they log in as themselves, copy the `code`, and `/v1/myself` returns them. Do not expect the
> backend credential to "point at" a user — it cannot.

> **Gotcha — `redirect_uri` registration is MANDATORY (even for the paste channel).** Without a
> `redirect_uri` registered in 凭据管理 for the app, `{host}/oauth2/authorize` returns
> "应用未配置'redirect_uri'" and no `code` is ever produced. Register a loopback address
> (`http://127.0.0.1:8732/callback`); for paste the user just copies `code` off the (failed)
> redirect in the address bar — no listener required. The authorize error message is the symptom
> to recognize (live-verified 2026-08-18).

---

## Write Patterns

**Permissions.** Directory `0700`, files `0600`, applied on create *and* re-asserted with `chmod`
on every write (a pre-existing directory may have been created loosely). Skipped on `win32`, where
POSIX modes are meaningless. On read, a file looser than `0600` produces a `warn` on stderr rather
than a silent acceptance.

**Atomic writes.** Write to a temp file in the same directory at `0600`, then `renameSync` over the
target. Never truncate-then-write: a crash mid-write would leave the user with no credentials and no
token.

**Merge only the fields you own.** `saveConfig(patch)` re-reads the file, merges the patch, and
writes the union. Two concurrent CLI invocations are normal (an agent may run several), and a blind
whole-file write would drop a token another process had just persisted.

**Secrets are opt-in.** The `client_secret` is persisted **only** when the user passes `--save`, and
`shouldPersistSecret()` also refuses to write a secret that came from the environment. A token
acquired without `--save` is still cached — that is the useful half — but the secret is not.

**Deletes are explicit.** `auth logout` removes the config file *and* the whole cache directory.
`auth login` clears the cache too, because a new set of credentials may see a different set of
projects.

---

## Cache Keying and Invalidation

The cache key is a `sha256` over **`(apiBase, clientId, projectId, kind)`**, truncated to 32 hex
chars and used as the filename. All four components matter:

- `apiBase` — cloud and self-hosted are different universes.
- `clientId` — **two apps against the same host must never share a cache**, because they may have
  different scopes and therefore different visibility. Leaking one app's project list to another is a
  correctness *and* a confidentiality bug.
- `projectId` + `kind` — ids are project-scoped; a state name means a different id per project.

Hashing also means the filename never reveals a project name.

Freshness rules:

- **TTL 24 h**, checked against `ctx.now()` (injected, so it is testable without timers).
- `--no-cache` bypasses reads and writes for that invocation.
- **Invalidate-and-retry-once:** if a write is rejected on an id that came from the cache, that entry
  is dropped and the operation retried exactly once; the error message then names the cache and
  suggests `--no-cache`. Never retry more than once — a genuinely wrong id would loop.
- A cache that cannot be written is a **performance** problem, never a failure: catch and continue.

---

## Naming Conventions

- Config keys are `camelCase` (`clientId`, `expiresAtMs`) — this is our file, not the API's wire
  format. Wire `snake_case` stops at `api/parse.ts`.
- Absolute instants are stored as `…Ms` (epoch milliseconds) internally, even though the API speaks
  unix **seconds**. The conversion happens once, in `normalizeExpiry`.
- Cache filenames are opaque hashes; never encode a human-readable key into a path.

---

## Common Mistakes

- **Whole-file overwrite** instead of merge-on-save — silently discards a concurrently written token.
- **Trusting the directory mode** because you created it with `mode:` — an existing directory keeps
  its old mode; `chmod` explicitly.
- **Persisting the secret by default.** `--save` is a deliberate, informed choice by the user.
- **Dropping the `clientId` from the cache key**, which lets two apps with different scopes poison
  each other's lookups.
- **Treating a cache write failure as fatal.**
- **Reading `~/.pingcode/` from a command.** Go through `core/config.ts`; the layering test will
  catch you.
- **Validating the shape of a cached id.** Ids may be 24-hex, 32-hex, or a bare slug (`task`, `story`,
  `bug`) — they pass through untouched.
- **Running a script that executes CLI leaves without redirecting `PINGCODE_CONFIG_DIR` first.** A
  probe that enumerated the command tree ran `auth logout` against a developer's real store and
  deleted the credentials *and* the cache; only the human could restore them. See
  [Live Verification](./live-verification.md).
