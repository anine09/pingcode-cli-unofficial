# Design — PingCode CLI (TypeScript) + `pingcode` skill

> Requirements: [`prd.md`](./prd.md) · API facts: [`research/pingcode-api.md`](./research/pingcode-api.md)
> Every API claim below traces to the research doc; section refs like *(R§6.2)* point at it.
> Revision 2 — incorporates the pre-implementation architecture review (see §13 for what changed and why).

---

## 1. Decisions summary

| # | Decision | Rationale |
|---|---|---|
| D1 | Node ≥ 20, TypeScript strict, **ESM** | Native `fetch`, no HTTP dep; ESM is the default for new tooling |
| D2 | **`commander`** for arg parsing, **`picocolors`** for color, nothing else at runtime | Minimal dep surface; `commander` gives per-level `--help` (R3.1) for free |
| D3 | **Vitest** for tests; HTTP faked by **injecting a `fetch` implementation**, no `msw`/`nock` | Keeps R5.2 (mocked HTTP) cheap and dependency-free |
| D4 | Grant type is **`client_credentials` only** in MVP | Only flow that works unattended in a CLI: `authorization_code` cannot bind a loopback port per-request (`redirect_uri` is server-registered, no `state` param) *(R§6.5)*. **This knowingly overrides R§6.3**, which suggests authorization-code for interactive use — the cost is that our token is org-wide admin (see D6), and we accept that in MVP rather than ship a flow that needs a pre-registered redirect URI |
| D5 | **Hand-write types for the ~15 MVP endpoints. No vendored spec, no conformance script.** | A path/method/param-name validator cannot catch what actually bites us (response-shape drift, `versions`/`version`, `0/1`-vs-boolean, project-scoped id semantics, workflow rejection), and it *fails* on `page_index`/`page_size`, which are undocumented on GET lists *(R§6.20)* — forcing an allowlist that guts the check. For 15 endpoints, real-API smoke (R5.3) is the honest validator. The `api_data.json` URL stays recorded in the research doc so codegen remains a clean follow-up *(R§5)* |
| D6 | Token/creds in **`~/.pingcode/config.json`, `0600`** (dir `0700`); **no OS keychain in MVP**; secrets from flag/env are **not persisted unless `--save`** | Zero native deps. A client-credentials token carries **org-wide system-admin authority** *(R§6.3)*, so `--save`-only persistence gives vault users a mode where nothing but the token touches disk. Note `0600` is a **no-op on Windows** |
| D7 | **Host is first-class config**; `apiBase` derived from it and overridable. **No `oauthBase`** | Self-hosted puts the API under `<domain>/open` *(R§6.25)*. The token endpoint lives under the **REST root**, not `/oauth2` *(R§1.1, R§1.3)*, and `/oauth2/authorize` is authorization-code only — which D4 excludes — so `oauthBase` has no consumer in MVP |
| D8 | `--dry-run` enforced **in the transport layer** via a thrown **`DryRunHalt`** carrying the request plan | One choke point means no mutating command can forget it (R3.4). A `Promise<T>` cannot honestly represent "did not send"; throwing keeps every call site's happy path free of `undefined as T` |
| D9 | Sorting is **not offered** in MVP | The API has no sort on any business endpoint *(R§6.20)*; client-side sorting of one page would be misleading, and sorting across pages fights the 200 req/min limit |
| D10 | Single **`skills/pingcode/SKILL.md`** in-repo as source of truth + **`npm run skill:install`** (a script, not a subcommand) | R4.6 asks for a repeatable install path. A subcommand would resolve `.opencode/skills/` relative to the *current* directory, so a globally-installed binary would write into whatever folder the user happens to be in |

### 1.1 Explicitly out of MVP

`pingcode doctor` (folded into `auth status --check`) · `work-item search` + `POST /search` paging · a
`skill install` subcommand · vendored `spec/api_data.json` + `scripts/check-spec.ts` ·
`oauthBase` and all authorization-code scaffolding. Rationale per item in D5/D7/D10 and §13.

---

## 2. Boundaries and layout

```
src/
  bin/pingcode.ts          # shebang entry; build program, run, catch DryRunHalt, map error → exit code
  cli/
    program.ts             # root program, global flags, command registration
    globals.ts             # resolved global options (host, json, dry-run, cache, verbosity, isTTY)
    output.ts              # table/JSON rendering, timestamp + truncation formatting, stdout/stderr discipline
    commands/
      auth.ts              # login | status [--check] | logout
      project.ts           # list | get
      workItem.ts          # list | get | create | update | transition
      meta.ts              # types | states | priorities | sprints | users
  core/
    config.ts              # shape, load/save, 0600, host→apiBase derivation, flag>env>file precedence
    auth.ts                # acquireToken / ensureFreshToken / clearToken / normalizeExpiry
    http.ts                # request(): auth inject, dry-run halt, 401 re-auth, 429 handling, redaction
    errors.ts              # PingcodeError hierarchy + DryRunHalt + exitCodeFor()
    paginate.ts            # paginate() for GET lists
    metadata.ts            # name→id resolution + on-disk cache
  api/
    projects.ts            # /v1/pjm/projects
    workItems.ts           # /v1/pjm/work_items
    meta.ts                # /v1/pjm/work_item/{types,states,priorities}, sprints, /v1/directory/users
  types/
    api.ts                 # envelope + resource types for the MVP surface
scripts/
  install-skill.ts         # copies SKILL.md to install targets
skills/pingcode/SKILL.md   # the single skill (source of truth)
```

**Dependency direction:** `cli → {api, core}`, `api → core`, `core` imports neither.
(`auth`/`config` are legitimately `cli → core` with no `api` layer in between; forcing an
`api/auth.ts` passthrough would be ceremony.) The invariants that matter and are enforced by review:
**`api/` never formats output; `cli/` never builds URLs or reads config files directly.**

---

## 3. Configuration and host derivation

```ts
type Config = {
  host: string;                 // "https://open.pingcode.com" | "https://pingcode.acme.com"
  apiBase?: string;             // explicit override
  clientId?: string;
  clientSecret?: string;
  token?: {
    accessToken: string;
    expiresAtMs: number;        // ALWAYS normalized to absolute ms locally
    obtainedAtMs: number;
    scope?: string;
  };
};
```

`grantType` and `refreshToken` are omitted deliberately: the former is single-valued in MVP (D4), the
latter is never returned by `client_credentials` *(R§1.3)*.

Derivation (`core/config.ts`) — cloud vs self-hosted differ *(R§1.1, R§6.25)*:

| host | apiBase |
|---|---|
| `https://open.pingcode.com` (default) | `https://open.pingcode.com` |
| any other `https://<domain>` | `https://<domain>/open` |

The token endpoint is a normal REST path under this same `apiBase` (§4). Explicit `apiBase` always wins.
Precedence for every value (R1.4):
**CLI flag → env (`PINGCODE_HOST`, `PINGCODE_CLIENT_ID`, `PINGCODE_CLIENT_SECRET`) → config file**.

Storage: `~/.pingcode/config.json` (always via `os.homedir()`, never a literal `~`) written `0600` in a
`0700` dir, via write-temp-then-rename so a crash can't leave a truncated file. On **read**, if the POSIX
mode is looser than `0600` we warn on stderr — a file we wrote can be `chmod`'d later.
`PINGCODE_CONFIG_DIR` overrides the location (used by tests).

**Cross-process safety.** Multiple `pingcode` invocations can run in parallel (an agent will do this).
Atomic rename prevents torn files but not lost updates, so a save **re-reads the file and merges only
the fields it owns** — a token refresh writes back `token` alone, never a whole stale `Config`.

---

## 4. Auth flow

The token request is **`GET` with query parameters under the REST root** — not POST+form, and *not*
under `/oauth2` *(R§1.3, R§1.1; this breaks most OAuth helpers)*:

```
GET {apiBase}/v1/auth/token?grant_type=client_credentials&client_id=…&client_secret=…
→ { access_token, token_type: "Bearer", expires_in }
```

Semantics that shape the design *(R§1.3)*: the token is **not tied to a user**, carries **org-wide
system-administrator** authority, is valid **30 days**, has **no refresh token**, and dies instantly if
the app is deleted or its secret reset.

### 4.1 The `expires_in` hazard

`expires_in` is documented as "过期时间" and its example value is an **absolute Unix timestamp**
(`1577808000` = 2020-01-01, i.e. *already in the past*), while prose says validity is 30 days *(R§6.2)*.
Never compute `now + expires_in`. Normalize, then sanity-clamp:

```ts
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

function normalizeExpiry(expiresIn: unknown, nowMs: number): { at: number; clamped: boolean } {
  const n = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : NaN;
  let at: number;
  if (Number.isNaN(n))  at = nowMs + THIRTY_DAYS_MS;      // missing / non-numeric
  else if (n > 1e9)     at = n * 1000;                    // absolute unix seconds
  else if (n > 0)       at = nowMs + n * 1000;             // duration in seconds
  else                  at = nowMs + THIRTY_DAYS_MS;       // zero / negative
  // A freshly-issued token that is already (nearly) expired means the server echoed a
  // stale absolute value. Without this clamp the proactive guard in §4.2 re-acquires
  // before EVERY request — 2x request count, silent, and never surfaced as an error.
  if (at <= nowMs + 60_000) return { at: nowMs + THIRTY_DAYS_MS, clamped: true };
  return { at, clamped: false };
}
```

`clamped: true` warns once on stderr. Persist only the normalized absolute `expiresAtMs`. This function
is unit-tested against both shapes, the past-timestamp case, and missing/`NaN` — it is the single
riskiest piece of arithmetic in the project (gate G2).

### 4.2 Freshness strategy (R1.5)

Two independent guards, because the expiry metadata is untrustworthy:

1. **Proactive**: if `now + 120s ≥ expiresAtMs`, re-acquire before sending.
2. **Reactive**: on `401`, re-acquire **once** and replay the original request. A second `401`
   becomes `AuthError`. The replay is one-shot per request and never recurses.

Since `client_credentials` yields no refresh token, "refresh" == re-acquire from stored
`client_id`/`client_secret`. If those are absent, the error tells the user to run `pingcode auth login`.
Re-acquisition is serialized behind a single in-flight promise so concurrent calls in *one process*
don't stampede; cross-process races are bounded by the merge-on-save rule in §3. **Open question for
smoke (§10): does a second acquisition invalidate the first token?** The docs are silent; if it rotates,
parallel invocations can 401 each other and we must document that.

### 4.3 Commands

- `pingcode auth login --client-id … --client-secret …` (prompts if a TTY and flags absent; also accepts
  env) → acquires a token, verifies with a **capability we actually need** —
  `GET /v1/pjm/projects?page_size=1` — and persists. Credentials are written only with `--save` (D6).
  Login **clears the metadata cache**, since a different `client_id` sees different data.
  *Why not `GET /v1/myself`:* the org token is not user-bound *(R§1.3)* and `/v1/myself` requires
  `pcp:read:account:personal` *(R§4)*, which a pjm-scoped app may simply not have — so a `/v1/myself`
  failure would fail login on a token that works perfectly. It is reported as a warning at most.
- `pingcode auth status [--check]` → host, `client_id` **masked** (`abcd…wxyz`), token presence, expiry;
  never the secret or full token (R1.3). `--check` adds the one live capability call above.
- `pingcode auth logout` → deletes token and credentials, clears the metadata cache.

---

## 5. Transport layer (`core/http.ts`)

One function owns every outbound call:

```ts
request<T>(opts: {
  method: 'GET'|'POST'|'PATCH'|'PUT'|'DELETE';
  path: string;                  // "/v1/pjm/work_items"
  query?: Record<string, unknown>;
  body?: unknown;
  skipAuth?: boolean;            // token endpoint only
}): Promise<T>                   // mutating call under --dry-run throws DryRunHalt instead
```

Responsibilities, in order:

1. Resolve `apiBase` + build URL; drop `undefined`/`null` query params; serialize arrays as CSV
   (matches `include_public_image_token`, `emails`, `department_ids` conventions).
2. `ensureFreshToken()` → `Authorization: Bearer …`; `Content-Type: application/json` only on write verbs.
3. **Dry-run gate (D8)**: if `--dry-run` and the method is mutating, throw `DryRunHalt` carrying
   `{method, url (redacted), headers (redacted), body}`. `bin/pingcode.ts` catches it, renders, exits `0`.
   Read verbs still execute, so a dry-run `create` can still resolve names to ids and show a real request.
4. Send via the injected `fetch` (injection is what makes D3 work).
5. `429` → if **`x-pc-retry-after`** is present, wait it out (capped at 60s) and retry once; if absent,
   **fail fast** with `RateLimitError` including a computed hint. Retrying blind is pointless: the window
   is per-minute and *"retrying before expiry restarts the same 429"* *(R§2.5, 200 req/min per identity)*.
6. `401` → the one-shot re-auth replay from §4.2.
7. **Any `2xx` is success** — never branch on 200 vs 201 *(R§2.3)*. Non-2xx → parse `{code, message}` —
   note **`code` is a string** *(R§2.4)* — into a typed error. Only `100000` and `100038` are documented,
   so mapping is **status-first, code-second**; unknown codes surface verbatim rather than being swallowed.
8. Parse JSON; on unparseable body raise `TransportError` carrying a truncated snippet.

### 5.0 Redaction (security-critical)

The token call carries the **org-admin secret in the URL query string**, not a header *(R§6.1)*. So
redaction is not a header concern: **every path that can print a URL** — `--verbose` logging, the
dry-run plan, `TransportError` snippets, and any error carrying a request URL — routes through one
`redactUrl()` that masks `client_secret` and `code` query params. Header redaction (`Authorization`)
stays too. A test asserts no secret and no full token appears in verbose or error output (AC3, AC11).

### 5.1 Pagination (`core/paginate.ts`)

Every list endpoint returns the same envelope *(R§2.2)*:

```json
{ "page_size": 30, "page_index": 0, "total": 100, "values": [] }
```

`page_index` is **0-based**, default size 30, **max 100**, offset-only, and the envelope **echoes back
the requested `page_index`**.

- `paginate<T>(path, query)` → `AsyncIterable<T>` for `GET` lists. No `POST /search` variant in MVP (D5/§1.1).
- Walk rules, all of which exist because there is **no sort guarantee** *(R§6.20)* so offset paging over
  mutating data can duplicate and skip rows:
  - **dedupe by `id`** while walking;
  - stop when `values.length < page_size`;
  - **bail immediately if the echoed `page_index` ≠ requested** — that is a precise signal that GET-list
    paging is being ignored, so no heuristic is needed;
  - `--all` is documented as **best-effort, not a consistent snapshot**.
- CLI surface: `--page`, `--page-size` (validated 1–100), and `--all` with a `--limit` safety cap
  (default 500) so `--all` can't silently burn the rate budget (R3.5).

### 5.2 Errors → exit codes (R3.3)

| Exit | Error | Trigger |
|---|---|---|
| 0 | — | success (incl. a rendered dry-run plan) |
| 1 | `UnexpectedError` | unhandled/internal |
| 2 | `UsageError` | bad flags, missing required input, unresolvable/ambiguous name, empty patch |
| 3 | `AuthError` | no/invalid credentials, `401` after re-auth |
| 4 | `PermissionError` | `403` / scope denied |
| 5 | `NotFoundError` | `404` |
| 6 | `RateLimitError` | `429` |
| 7 | `ApiError` | other non-2xx with `{code, message}` |
| 8 | `TransportError` | DNS/TCP/TLS/timeout/unparseable body |

`commander`'s own usage failures are routed to exit **2** via `exitOverride`, and `-v` is *not* bound
(it would collide with `--version`/`--verbose` expectations).

`PermissionError` messages carry a scope hint. For generic endpoints the required scope is inherited
from `principal_type` *(R§6.17)*, which produces confusing server errors — the message says so explicitly.

---

## 6. Metadata resolution and cache (`core/metadata.ts`)

Most `*_id` values are **project-scoped** *(R§6.13)*, and the rate limit is only 200/min, so
name→id resolution is centralized and cached.

Resolvers: project, work-item type, state, priority, user, sprint. Rules:

- **Ids pass through untouched.** Id shapes are *not* uniform — 24-hex for most resources,
  **32-hex for users**, and **string slugs** (`epic`, `story`, `bug`, …) for system work-item types
  *(R§6.8)*. So a resolver must never validate "looks like an ObjectId": it tries exact-id first,
  then name resolution.
- **Name resolution is spelled out, because `keywords` is fuzzy** and `GET /v1/pjm/projects` has no
  exact-name filter *(R§4)*: query by `keywords`, then filter to **case-insensitive exact `name`
  equality**, then require **exactly one** match. Ambiguous or zero → `UsageError` listing candidates.
  Never silently pick the first.
- **State resolution needs a type.** `GET /v1/pjm/work_item/states` requires **both** `project_id`
  **and** `work_item_type_id` *(R§4)*. Therefore: `--state <name>` on `work-item list` **requires
  `--type`** (a `UsageError` says so if omitted); `--state <id>` needs no type. `create` already
  requires `--type`; `update`/`transition` read the type off the work item (§7.1).
- Cache: `~/.pingcode/cache/…` JSON keyed by **`(apiBase, clientId, projectId, kind)`** — visibility
  depends on the app's scopes, so two `client_id`s against one host must not share a cache. **TTL 24h**,
  `--no-cache` bypasses, `auth login` *and* `auth logout` clear it.
- **Invalidate-on-rejection.** If a write fails validation on an id that came *from cache*, drop that
  cache key and retry once. If it fails again, the message names the culprit:
  `resolved "Done" → <id> from cache; try --no-cache`. Without this, a reconfigured project produces a
  dead-end "your input is invalid" with no hint that a cache is involved.

`work_items` accepts **`id` or `short_id`** on `GET` *(R§6.9)*, so the work-item argument also accepts a
pasted `html_url` (we extract the `short_id`) **and an `identifier` like `SCR-5`** — the form humans and
agents actually see (R2.2) — resolved via `GET /v1/pjm/work_items?identifier=…`. `PATCH`/`DELETE` document
only `id`, so mutating commands resolve to a real `id` with one `GET` first.

---

## 7. Command surface (MVP)

```
pingcode auth login|status [--check]|logout
pingcode project list [--keywords] [--type scrum|kanban|waterfall|hybrid] [--include-archived]
pingcode project get <project>
pingcode work-item list   --project <name|id> [--type] [--state] [--assignee] [--sprint]
                          [--keywords] [--page] [--page-size] [--all] [--limit]
pingcode work-item get <id|short_id|identifier|url>
pingcode work-item create --project <p> --type <t> --title <s> [--description] [--assignee]
                          [--state] [--priority] [--parent] [--sprint] [--start-at] [--end-at]
pingcode work-item update <id> [--title] [--description] [--assignee] [--state] [--priority] [--end-at] …
pingcode work-item transition <id> --state <name|id>
pingcode meta types|states|priorities|sprints --project <p>   |   pingcode meta users [--keywords]
```

Global flags: `--host`, `--json`, `--dry-run`, `--no-cache`, `--verbose`, `--version`, `--help`.

`pingcode meta` stays in MVP even though it is "lookup" rather than "work items": an agent **cannot
construct a valid `create`** without discovering project-scoped `type_id`/`state_id` *(R§6.13)*, so it
is load-bearing for R4, not scope creep.

### 7.1 State transitions

State changes are **workflow-validated**: a `state_id` must belong to the type's state scheme *and*
have a legal transition from the current state *(R§6.12)*. MVP behaviour:

1. `GET` the work item → `project.id` + `type.id` + current `state`.
2. Resolve the target state via `GET /v1/pjm/work_item/states?project_id=…&work_item_type_id=…`.
3. `PATCH` `{state_id}`.
4. On rejection, print the server message **plus** the candidate states for that type, so the user
   sees why. Pre-validating against `work_item_state_flows` is a documented follow-up, not MVP.

`transition` is `update --state` with better errors; they share one code path.

### 7.2 Update semantics (data-loss guard)

The API replaces arrays wholesale rather than merging — documented for test-case `steps[]` *(R§6.16)* and
almost certainly true of `version_ids[]`, `participant_ids[]`, `properties{}`. So MVP commits to:

- only fields **explicitly provided** on the command line are sent;
- **no field clearing** in MVP (no way to set a field to empty) — a future `--clear-<field>` is explicit;
- a `PATCH` with zero fields is a **`UsageError` (exit 2)**, not a no-op round-trip;
- for arrays and `properties`, help text and SKILL.md state plainly that the value **replaces**, not merges.

### 7.3 Output discipline (R3.2)

- Human mode: aligned table of a curated column set (`identifier`, `title`, `type`, `state`,
  `assignee`, `end_at`), timestamps rendered local, long titles truncated.
- **TTY awareness**: color is disabled when `!process.stdout.isTTY` or `NO_COLOR` is set; truncation
  uses terminal width when a TTY, otherwise a fixed 120 columns. Piping does **not** auto-imply
  `--json` (too surprising) — it only drops decoration.
- `--json`: **stdout carries only JSON** — the resource/array plus paging info. Timestamps stay raw
  unix seconds so agents parse deterministically; conversion happens only at the human boundary
  *(R§7)*. All logs and warnings go to **stderr**.
- **Dry-run is a result, not a log.** In `--json` mode a dry-run prints
  `{"dry_run":true,"request":{…}}` to **stdout** and exits `0` — otherwise the one mode agents are told
  to use (R4.4) would emit nothing at all on stdout. In human mode the plan goes to stderr.
- Errors in `--json` mode: `{"error":{"kind","message","code?","exit"}}` on **stderr**, keeping the
  stdout-is-pure-JSON contract intact even on failure.

---

## 8. Type strategy (D5)

Types for the ~15 MVP endpoints are hand-written in `types/api.ts` from the research doc's endpoint
table (R§4) and field list (R§4.2), reviewed once against the docs, and then validated **for real** by
the smoke run in §10. There is no vendored spec and no conformance script — see D5 for why that check
would have been theatre.

Known doc inconsistencies to code defensively around: list responses use **`versions` (array)** while
single-GET shows **`version` (object)** *(R§4.2)*; `is_archived`/`is_deleted` are **numbers 0/1**, not
booleans *(R§6.10)*. Both are normalized **once**, in the parse helpers, never at call sites.
All timestamps are 10-digit unix **seconds** *(R§2)*.

Full `api_data.json → TS` codegen (URL recorded in R§5) stays a follow-up.

---

## 9. The skill (R4)

`skills/pingcode/SKILL.md`, single file, YAML frontmatter (`name: pingcode`, trigger-rich Chinese +
English `description` with explicit anti-triggers for Testhub/Wiki/Ship/org-chart, plus "webhooks are
not manageable via API" *(R§6.24)*). Body order: **auth gate first** (what to do when unauthenticated),
then the command catalog with copy-pasteable invocations, then agent rules — prefer `--json`, run
`--dry-run` before any mutation, confirm before writes, respect the 200/min budget, remember that
`type_id`/`state_id` are project-scoped so always resolve via `pingcode meta …`, and that `update`
**replaces** array/`properties` values (§7.2).

`npm run skill:install` (→ `scripts/install-skill.ts`) copies the file to
`~/.claude/skills/pingcode/SKILL.md` and `.opencode/skills/pingcode/SKILL.md`, refusing to overwrite
without `--force`. Not a CLI subcommand (D10).

R4.5 (skill matches reality) is enforced cheaply: **`--help` output snapshot tests** catch CLI drift
directly, plus a small check that every `pingcode <group> <sub>` **command path** appearing in
`SKILL.md` resolves in the built `commander` tree. Flag-level parsing of the markdown is deliberately
not attempted — the snapshots plus one manual read at the end of the project cover it.

---

## 10. Testing and validation

| Layer | What | How |
|---|---|---|
| Unit | `normalizeExpiry` — duration, absolute, **past-absolute clamp**, missing/`NaN` (gate G2); host derivation cloud vs self-hosted; error→exit mapping; envelope parse; `0/1` and `versions` normalization | pure functions |
| Transport | 401 single re-auth replay (never recursive); 429 honours `x-pc-retry-after` and fails fast without it; dry-run throws and **sends nothing**; `redactUrl` hides `client_secret`/`code` in verbose, dry-run and error paths | injected fake `fetch` |
| Pagination | 0-based indexing, `page_size` cap 100, `--all` respects `--limit`, dedupe by `id`, **bail on echoed `page_index` mismatch** | fake `fetch` |
| Metadata | id pass-through for all three id shapes; `keywords`→exact-name→uniqueness; ambiguous-name `UsageError`; `--state` without `--type` is a `UsageError`; TTL + invalidate-on-rejection | temp `PINGCODE_CONFIG_DIR` |
| Contract | `--help` snapshots; every `SKILL.md` command path exists in the CLI; `--json` dry-run writes the plan to **stdout**; config file mode is `0600` (**skipped on `win32`**) | Vitest |
| Real API | `auth login` → `auth status --check` → `project list` → `work-item list/get` → `create --dry-run` (writes nothing) → `create` → `update --state` → negative paths (3/5/2) | manual, user's credentials (R5.3, AC2/5/6/7) |

Two facts the smoke run must **settle**, because the docs don't:
1. do `page_index`/`page_size` actually work on `GET` list endpoints? *(R§6.20 claims yes, undocumented)*
2. what is the real `expires_in` shape, and does a second token acquisition invalidate the first? (§4.2)

Secrets: `.gitignore` covers `.env*`, `~/.pingcode` is outside the repo anyway, and a test asserts
`auth status` output contains neither the secret nor the full token (AC3, AC11).

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| `expires_in` semantics guessed wrong → constant re-auth or stale-token failures | dual-shape normalization **+ past-timestamp clamp with a warning** + reactive 401 replay means either interpretation still works |
| Org-admin secret leaks via the URL it travels in *(R§6.1)* | single `redactUrl()` on every printing path (§5.0), asserted by test |
| Client-credentials token is org-wide admin, stored in a file | `0600`/`0700`, `--save`-only persistence, loose-mode warning, redaction everywhere, documented in skill + `auth status`; keychain follow-up; Windows caveat stated |
| Undocumented error codes (only 2 of them documented) | status-first mapping, unknown `{code,message}` surfaced verbatim |
| 200 req/min budget blown by `--all` or name resolution | metadata cache (24h) + `--limit` cap + fail-fast 429 |
| Hand-written types drift from the real API | real-API smoke over all 15 endpoints; `api_data.json` URL recorded for a codegen follow-up |
| `--all` returns duplicated/skipped rows (no sort guarantee) | dedupe by `id`, short-page stop, documented best-effort |
| Undocumented `page_index`/`page_size` on GET lists *(R§6.20)* | envelope echoes `page_index` → bail on mismatch; settled during smoke (gate G5) |
| Parallel invocations clobber each other's config | merge-only-owned-fields on save; token-rotation question settled in smoke |
| Stale cache yields ids the server rejects | cache keyed by `clientId` too; invalidate-and-retry-once with a `--no-cache` hint |

## 12. Rollout / rollback

Greenfield with no consumers, so rollback is trivial: the work lands in ordered slices
(scaffold → core → api → commands → skill), each independently revertable, and every slice keeps
`npm run typecheck && npm test` green. `git init` happens in the first slice so revert points exist.
The only external side effects are `~/.pingcode/` and work items created during the smoke run, which
are deleted or clearly marked as test artifacts.

---

## 13. Revision log

**Rev 2** — applied a pre-implementation architecture review. Corrections and cuts:

*Corrections (would have shipped broken):*
1. Token endpoint moved from `{oauthBase}/v1/auth/token` to **`{apiBase}/v1/auth/token`** and `oauthBase`
   deleted — Rev 1 contradicted R§1.3/R§1.1 and would have failed 100% of logins (D7, §4).
2. `request()` no longer claims to return `T` without sending: dry-run **throws `DryRunHalt`** (D8, §5).
3. `--json` dry-run now writes the plan to **stdout**, not stderr (§7.3).
4. `redactUrl()` added — the secret travels in the **query string**, so header-only redaction leaked it (§5.0).
5. `--state <name>` on `work-item list` now **requires `--type`**; it was unresolvable as specified (§6).
6. `normalizeExpiry` gained a **past-timestamp clamp** and `NaN` guard — the doc's own example value is
   in the past, which would have caused silent re-auth on every request (§4.1).
7. Login verification switched from `GET /v1/myself` to a capability call — the org token is not
   user-bound and `account:personal` scope may not be granted (§4.3).
8. Layering rule corrected to `cli → {api, core}` — the Rev 1 rule was unsatisfiable for `auth` (§2).

*Additions:* any-2xx-is-success, 429 fail-fast without the header, `--all` dedupe + `page_index`-echo
bail, explicit update/replace semantics, cache keyed by `clientId` with invalidate-on-rejection,
`--save`-only secret persistence + loose-mode warning, cross-process merge-on-save, TTY/`NO_COLOR`
handling, `identifier` accepted by `work-item get`, `exitOverride` → exit 2.

*Cuts:* `pingcode doctor` (its differentiating feature needs a scope most apps lack → folded into
`auth status --check`) · `work-item search` + `searchPaginate` (a second paging model and a second
filter DSL for near-zero MVP value) · `skill install` subcommand (CWD-relative → npm script) ·
`spec/api_data.json` + `scripts/check-spec.ts` (cannot validate the params we lean on hardest) ·
SKILL.md flag-parsing test (→ `--help` snapshots + command-path check).
