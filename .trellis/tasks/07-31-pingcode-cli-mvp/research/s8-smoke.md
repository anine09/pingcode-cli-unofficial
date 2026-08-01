# S8 — real-API smoke run (live PingCode cloud)

**Date:** 2026-07-31 → 2026-08-01 (local) · **Deployment:** public cloud `https://open.pingcode.com`
(no `--host`) · **Binary under test:** `node dist/bin/pingcode.js` from `npm run build`
**Org:** 9 projects visible · **Smoke target project:** `RDD` — 技术部门运营事务
(`aaaaaaaaaaaaaaaaaaaaaaaa`, type `kanban`) · read-only comparison project: `SHOU02` (scrum).

No secret value appears in this file. `client_id` is shown only in its masked form (`aBcD…wXyZ`).
Credentials were already persisted by the user with `--save`; no credential was printed, copied
outside `~/.pingcode/`, or written to the repo at any point.

## Created artifact (needs a delete decision)

| field | value |
|---|---|
| identifier | **RDD-26** |
| id | `bbbbbbbbbbbbbbbbbbbbbbbb` |
| short_id | `Ab3XyZ9q` |
| title | `[CLI smoke] 2026-07-31 23:37:40 pingcode-cli S8 smoke test (updated, safe to delete)` |
| url | https://example-tenant.pingcode.com/pjm/workitems/Ab3XyZ9q |
| state now | 进行中 (`cccccccccccccccccccccccc`) |

Exactly **one** work item was created. No pre-existing item was modified or deleted.
RDD-26 was written to three times in total (create, `transition --state-id`, `update --title`).

## Step-by-step results

| # | command (prefix `node dist/bin/pingcode.js`) | exit | verdict |
|---|---|---|---|
| 1 | `auth login … --save` (run by the user before this session) | 0 | ✅ credentials + token persisted |
| 2 | `auth status` / `auth status --check --json` | 0 | ✅ masked `client_id`, `client_secret_present:true`, live call `GET /v1/pjm/projects?page_size=1` ok, `projects_total:9`; no secret, no token in output |
| 3 | `ls -l ~/.pingcode/config.json` | — | ✅ `-rw-------` (0600), dir `drwx------` (0700), `cache/*.json` also 0600 with hashed filenames and **no** secret/token substrings |
| 4 | `project list --json` | 0 | ✅ 9 real projects, stdout pure JSON, **stderr 0 bytes** |
| 5 | `meta types --project RDD` → `meta states --project RDD --type task` | 0 | ✅ types are bare slugs (`epic/feature/story/task/bug/issue`); states `打开/进行中/已完成/关闭` with 24-hex ids; `meta priorities` 5 rows; `meta sprints RDD` **empty** (kanban — expected, research §6.14); `meta sprints SHOU02` 7 sprints; `meta users` 20 users with 32-hex ids |
| 6 | `work-item list --project RDD --page-size 5 --json` (+ paging matrix) | 0 | ✅ see G5-1 below — paging is real |
| 7 | `work-item get` with `id` / `short_id` / `identifier RDD-1` / pasted `html_url` | 0 | ✅ all four forms resolve to the same item |
| 8 | `work-item create … --dry-run --json` | 0 | ✅ stdout is exactly `{"dry_run":true,"request":{method,url,headers,body}}`, `Authorization: ***REDACTED***`, stderr empty; follow-up `--all` list still shows **25** items and zero `[CLI smoke]` titles → **nothing was sent** |
| 9 | `work-item create --project RDD --type task --title "[CLI smoke] …"` | 0 | ✅ created RDD-26, initial state 打开 |
| 10a | `work-item update RDD-26` (empty patch) | **2** | ✅ `nothing to update: no updatable field was given` |
| 10b | `work-item update RDD-26 --state 进行中` | **2** | ⚠️ **finding F1** — refused: “`--state <name>` requires `--type`” |
| 10c | `work-item transition RDD-26 --state 进行中` | **2** | ⚠️ same as F1 |
| 10d | `work-item transition RDD-26 --state-id cccccccccccccccccccccccc` | 0 | ✅ state → 进行中 |
| 10e | `work-item update RDD-26 --title …` | 0 | ✅ title replaced |
| 11a | `work-item get 000000000000000000000000` | **7** | ⚠️ **finding F2** — server answers **HTTP 400** `code 100317` 工作项资源不存在, so the 404→exit 5 branch never fires |
| 11a2 | `work-item get RDD-99999` | **5** | ✅ client-side identifier miss → `NotFoundError` |
| 11b | `work-item create --project RDD --type task` (no `--title`) | **2** | ✅ commander usage error + help |
| 11b2 | `work-item list` (no `--project`) | **2** | ✅ |
| 11b3 | `work-item list --project NOPE-NOT-A-PROJECT` | **2** | ✅ unresolvable name lists all candidates |
| 11c | `work-item transition RDD-26 --state-id 000000000000000000000000` | **7** | ⚠️ rejected with HTTP 400 `code 100303` `'state'资源不存在`; the design §7.1 “candidate states” hint did **not** print (**finding F1**, same root cause) |
| 11d | `project get 000000000000000000000000` | **2** | ℹ️ project refs resolve client-side against the project list, so an unknown-but-well-formed id is a usage error, not exit 5 |
| 11f | `auth login --client-id FAKE… --client-secret FAKE…` (no `--save`) | **7** | ⚠️ **finding F3** — server answers **HTTP 400** `code 100024` `'client_id'或'client_secret'错误`, so the 401→exit 3 branch never fires. Stored config verified byte-identical afterwards; the fake secret was redacted in the message |
| 12 | corrupt `token.accessToken` in place, then `project list --json --verbose` | 0 | ✅ trace shows `← 401` → `401 — re-acquiring the token once and replaying the request` → token call → `← 200` → replay `← 200`; stdout still pure JSON (`total=9`); a new token was persisted. **An invalid bearer token does return 401**, so the reactive re-auth path is live |
| 13 | `auth login --verbose` | 0 | ✅ `client_secret=***REDACTED***` in both request and response trace lines; the raw secret (and every 8-char run of it) is absent from stdout+stderr; the access token is absent; config still 0600 |
| — | `--json` purity sweep over **19** commands (auth/project/meta/work-item, incl. `--all`, `--no-cache`, `--keywords`, `--type`, `--state`, `--state-id`, `--assignee`) | all 0 | ✅ every stdout parsed as JSON, every stderr was **0 bytes** |
| — | `npm run typecheck && npm test` | 0 | ✅ 13 files / **200 tests** pass; no source file was modified in S8 |

## Gate G5 — the three documentation blanks, settled

### G5-1 · `page_index` / `page_size` on `GET` list endpoints: **real and fully honoured**

Observed on `GET /v1/pjm/work_items?project_id=RDD…` (`total` = 25 throughout):

| requested | echoed `page_index` | echoed `page_size` | `values.length` | first row |
|---|---|---|---|---|
| `--page 0 --page-size 5` | 0 | 5 | 5 | RDD-1 |
| `--page 1 --page-size 5` | 1 | 5 | 5 | RDD-6 |
| `--page 0 --page-size 1` | 0 | 1 | 1 | RDD-1 |
| `--page 1 --page-size 1` | 1 | 1 | 1 | RDD-2 |
| `--page 2 --page-size 1` | 2 | 1 | 1 | RDD-3 |
| `--page 0 --page-size 30` | 0 | 30 | 25 | RDD-1 |
| `--page 100 --page-size 5` | 100 | 5 | 0 | — |

**Conclusion:** `page_size` truly limits the row count, `page_index` is 0-based and truly offsets,
the server echoes both back unchanged, `total` is the unfiltered-by-page count, and a page past the
end returns an empty `values` (not an error). Pages did not overlap and ordering was stable by
identifier across calls. `--all` walked 3 pages of size 10 and returned all 25 rows deduped;
`--all --page-size 3 --limit 7` stopped at exactly 7. `--page-size 500` is rejected client-side
(exit 2) before any request. Server-side filters (`--type`, `--state-id`, `--assignee`) change
`total` correctly (25 → 19 / 2 / 5), so filtering and paging compose.
→ **No revision of `--all` / `--page` behaviour or of research §2.2 / §6.20 is needed**; the
undocumented-but-global claim is confirmed on `GET` endpoints.

### G5-2 · `expires_in` is an **absolute unix-seconds timestamp**, not a duration

`GET /v1/auth/token?grant_type=client_credentials` returns exactly three keys —
`access_token` (36-char string), `token_type: "Bearer"`, `expires_in` — with **no `scope`** and
**no `refresh_token`** (hence `auth status --json` shows `token_scope: null`).

Observed payload (values that are not secret): `expires_in` = `1788105520` (`int`) while the call
was made at epoch `1785513519`. That is `> 1e9`, i.e. an **absolute epoch** ≈ 2026-08-30 23:58:40,
exactly 30 days out; read as a duration it would be 20 695 days, which is absurd.
The CLI's `normalizeExpiry` absolute branch (`n > 1e9 → at = n * 1000`) is therefore the branch that
fires in production: a subsequent CLI login stored `expiresAtMs = 1788105626000`, i.e. the server's
value verbatim, with `expiresAtMs − obtainedAtMs = 2 591 999 s` (30.0000 days).

**The clamp did not fire.** `auth login --verbose` produced no `expired or unusable` warning, and
`token_expires_at` is ~30 days in the future. (Note for the future: a *missing/zero* `expires_in`
would also land on “now + 30 d” with no warning, so the warning's absence alone is not proof — the
raw payload above is.) Keep both `normalizeExpiry` branches, but the commentary should now say
“cloud returns an **absolute** unix-seconds `expires_in`; the duration branch is defensive”.

### G5-3 · A second `client_credentials` acquisition **does not** invalidate the first

Procedure (all probes were raw `GET /v1/pjm/projects?page_size=1` with an explicit
`Authorization: Bearer …`, so no CLI re-auth could mask a 401; no token was printed or copied to
disk):

1. probe stored token `T_old` → **HTTP 200**
2. acquire `T_new1` → HTTP 200, `T_new1 != T_old`
3. probe `T_old` again, immediately after → **HTTP 200**
4. probe `T_new1` → **HTTP 200**

**Conclusion:** tokens issued by repeated `client_credentials` calls **coexist**; issuing a new one
does not rotate/revoke the previous one. Parallel CLI invocations therefore cannot 401 each other,
and `SKILL.md` needs no rotation caveat. (Verified only for two coexisting tokens acquired seconds
apart, and only for the immediate window — a per-app token cap or later expiry-side revocation was
not probed.) The user's session was left holding a freshly issued, verified-valid token
(`token_expires_at = 1788105626`, `auth status --check` → ok), so nothing was left broken.

## Findings that need a decision (no code was changed — see “not fixed here”)

**F1 — the live API never returns a work item's *type*, which disables every name-form state
change.** `GET /v1/pjm/work_items` and the single-item read both omit `type` entirely (the parser
spreads the raw record, and the key is simply absent; confirmed on RDD-1 and RDD-26). Consequences:
- `work-item update --state <name>` and `work-item transition --state <name>` always fail with
  exit 2 and the hint “this work item did not report a type … pass `--state-id <id>`” — and that
  hint names a `--type` flag those two commands **do not have**.
- `explainStates()` (design §7.1 “print the candidate states on rejection”) returns early because
  `locator.typeId` is undefined, so step 11c printed no candidates.
- `work-item list --state <name> --type task` is unaffected (the type comes from the flag) and works.
Smallest repairs, both of which touch documented design surface: (a) add `--type <name|id>` to
`update`/`transition` purely for state-name resolution, or (b) infer the type by finding the project
type whose state list contains the item's *current* `state.id`. Not done here — see below.

**F2 — missing resources come back as HTTP 400, not 404.** `GET /v1/pjm/work_items/<unknown 24-hex>`
→ `400` + `code 100317` 工作项资源不存在 → mapped to `ApiError` **exit 7**; `PATCH` with an unknown
`state_id` → `400` + `code 100303`. Design §5.2's status-first table maps only 404 → exit 5, so
**exit 5 is unreachable for server-side not-founds** (it only fires for client-side identifier
misses). AC8's “nonexistent id → exit 5” is therefore not met as designed.

**F3 — bad credentials come back as HTTP 400, not 401.** The token endpoint answers `400` +
`code 100024` `'client_id'或'client_secret'错误` → `ApiError` **exit 7**, so AC8's “bad secret →
exit 3” is not met either. Note the contrast with finding in step 12: an **invalid bearer token on a
resource endpoint does return 401**, so only the *token* endpoint deviates. A code-aware refinement
of `errorForResponse` (400 + `100024` → `AuthError`; 400 + `100317`/`100303`-style “资源不存在”
codes → `NotFoundError`) would satisfy AC8 while keeping the status-first default.

**Why F1–F3 were not fixed in S8:** each one changes a contract that `design.md` states explicitly
(§7 command surface for F1, §5.2 status-first exit-code table for F2/F3), which the S8 brief flags
as “STOP and report” territory. `npm run typecheck && npm test` are green and untouched.

### Cosmetic nits (no decision needed)

- Error messages that embed the token URL lose their closing `)`: the query-string redaction
  pattern `([?&]client_secret=)[^&#\s]*` eats `SECRET)` when it is applied to an assembled message.
  It over-redacts by one character, so it fails safe.
- `--verbose` prints the **full** `client_id` (`auth status` masks it). `client_id` is not a secret,
  but the asymmetry is worth a line in the README.
- `--json` list shapes are inconsistent: single-page lists emit
  `{page_index,page_size,total,values}`, `--all` emits `{values,count,all}`, most `meta` commands
  emit `{values,count}`, but `meta users` passes the raw envelope through
  (`{page_index,page_size,total,values}`).
- `auth login` with no flags prints “the client id/secret were not written to disk (pass `--save`…)”
  even when they are already stored from an earlier `--save`; true for that invocation, misleading
  in context (`auth status` correctly reports `credentials_stored: true`).

## Recorded API facts worth folding into `research/pingcode-api.md`

- Token payload is `{access_token, token_type:"Bearer", expires_in:<absolute epoch seconds>}` — no
  `scope`, no `refresh_token`; tokens coexist across acquisitions.
- Work-item payloads have **no** `type` field; they do carry `board`/`entry`/`swimlane` on kanban
  projects, `version: null` + `versions: []`, `is_archived`/`is_deleted` as `0/1`, and
  `properties.{entry_status,entry_position,operation_time,…}`.
- System work-item type ids are bare slugs; state/priority ids are 24-hex; user ids are 32-hex.
- Observed error codes: `100024` bad client_id/secret (400), `100317` work item does not exist (400),
  `100303` `'state'` does not exist (400 on PATCH).
- 2xx responses carry **no** rate-limit headers (`Date`, `traceparent`, HSTS, `Server: openresty`
  only), so the 200 req/min budget is invisible until a 429 arrives.
- `page_index`/`page_size` are honoured on `GET` list endpoints (table above).

## Not verified, and why

- **429 / `x-pc-retry-after`**: never triggered. Provoking it means ~200 requests/min against the
  user's production org, which the brief's rate-limit rule discourages; the whole run stayed well
  under the budget (~70 requests). The 429 path remains unit-tested only.
- **403 / exit 4**: the app's token is org-admin-scoped, so no endpoint in the MVP surface denied us.
- **Self-hosted `--host` derivation**: cloud-only credentials; still unit-tested only.
- **Sprint writes / `--sprint`**: RDD is kanban (`sprint_id` inert per research §6.14) and writing to
  the scrum projects was out of scope.
- **Long-horizon token behaviour** (expiry-side revocation, per-app token caps): only the immediate
  two-token window was probed.

---

## S8b resolution (2026-08-01)

The three findings and the four cosmetic nits were decided by the user and implemented in slice S8b.
This section is the record of what each one became; the sections above stay as the raw evidence.

### F1 → `--type <name|id>` added to `work-item update` and `work-item transition`

Option (a) of the two candidates. Option (b) — inferring the type by finding which type's state list
contains the item's current `state.id` — was **rejected**: it costs N extra requests against a
200 req/min budget and is ambiguous when two types share a state id.

- `--type` on `update`/`transition` resolves like `work-item list --type`, and is **never sent**: the
  `PATCH` body has no `type_id` field. Its help text says it exists only to resolve `--state <name>`
  and to list candidate states on rejection. It does **not** count as an updatable field, so
  `update <ref> --type task` alone is still the empty-patch `UsageError`.
- The type is resolved **only when a state name needs it**, so the `--state-id` path still costs
  exactly what it did before.
- `--state <name>` without `--type` stays exit 2, and the message now names flags that exist on that
  command: *pass `--type <name|id>`, or use `--state-id <id>`*. The old wording, which blamed the
  payload's missing `type`, is gone.
- `explainStates()` now fires whenever `--type` was supplied (live: prints all four RDD/task states on
  a rejected `--state-id`). With no `--type` it says so explicitly instead of printing nothing —
  except when the failure is a local `UsageError` that already told the user to pass `--type`.
- Docs: `design.md` §7 / §7.1, `SKILL.md` rules 2 and 6 plus the agent workflow, `--help` snapshots for
  `work-item update` and (new) `work-item transition`.

### F2/F3 → status-first **plus** a `code` override table in `core/wire.ts`

`ERROR_CODE_OVERRIDES` maps the observed codes onto the exits AC8 requires:

| code | HTTP | → | exit |
|---|---|---|---|
| `100024` | 400 | `AuthError` | 3 |
| `100317` | 400 | `NotFoundError` | 5 |
| `100303` | 400 | `NotFoundError` | 5 |

Matching is on the **`code` string only** — the Chinese message text is never pattern-matched, since
the API is CN-only and wording is not a contract. Codes outside the table keep the status-first
mapping and still surface `code` verbatim. The table lives in one place with a comment citing this
file as the evidence. `design.md` §5.2 documents it beneath the exit-code table and records that
**404 is effectively never returned** by this API (the branch stays for self-hosted/future builds),
while an invalid *bearer* token on a resource endpoint does still return a real 401.

### Cosmetic nits — all four fixed

1. `redactUrl` now matches the value lazily and hands back a trailing run of `)`, `"`, `'`, `,`, so an
   embedded URL keeps its closing paren. Deliberately **not** a narrowed character class: a secret
   containing one of those characters is still redacted in full (only a *trailing* run is restored),
   so it still fails safe. Regression tests cover both properties.
2. `meta users --json` now emits `{values,count}` like every other `meta` lookup (`--page`/`--page-size`
   still shape the request). All three shapes are documented in `SKILL.md`: single-page list →
   `{page_index,page_size,total,values}`; `--all` → `{values,count,all}`; `meta …` → `{values,count}`.
3. `auth login` prints the "not written to disk (pass `--save`)" note only when the credentials are not
   already stored, and `credentials_stored` in `--json` reflects the same truth.
4. `README.md` records that `--verbose` prints the full `client_id` while `auth status` masks it, and
   that `client_id` is an identifier rather than a secret.

### Docs updated with the S8 facts

- `research/pingcode-api.md`: §4.2 corrected — **work-item payloads carry no `type` field at all**
  (the earlier revision listed one); new GOTCHAS 27–32 cover the type absence, the token payload
  (absolute `expires_in`, no `scope`, no `refresh_token`, coexisting tokens), the 400-instead-of-401/404
  behaviour with the three observed codes, the absence of rate-limit headers on 2xx, and the confirmed
  `page_index`/`page_size` support on GET lists.
- `design.md` §4.1: production returns an **absolute** `expires_in`; the duration branch and the clamp
  stay as defensive code.

### Live re-verification of the changed paths (RDD-26 reused, nothing created)

| check | result |
|---|---|
| `transition RDD-26 --type task --state 已完成` (`--no-cache`) | **0** — state moved |
| `transition RDD-26 --type task --state 进行中` | **0** — moved back, RDD-26 left exactly as found |
| `transition RDD-26 --state 已完成` (no `--type`) | **2** — message names `--type` / `--state-id`, no duplicate warning |
| `transition RDD-26 --type task --state-id 000…000` | **5** — plus all four candidate states on stderr |
| `transition RDD-26 --state-id 000…000` (no `--type`) | **5** — plus the explicit "cannot list candidates" note |
| `work-item get 000000000000000000000000` | **5** (was 7); `--json` → stdout 0 bytes, `{"error":{…,"exit":5,"code":"100317"}}` on stderr |
| `auth login --client-id FAKE --client-secret FAKE` (no `--save`) | **3** (was 7); config sha256 **byte-identical**, mode still `600`, fake secret redacted, 0 occurrences in output |
| `meta users --keywords a --page-size 3 --json` | `{count,values}`, stdout pure JSON, **stderr 0 bytes** |
| `meta users --all --limit 5 --json` | `{all,count,values}`, stderr 0 bytes |
| `--verbose auth status --check` | no secret, and no 8-char substring of it, anywhere in stdout+stderr |
| `npm run typecheck && npm test` | 13 files / **213 tests** green |

**RDD-26 still exists and is back in state 进行中** — deletion is deferred to S9 by the user's
instruction. Nothing in the "Not verified" list above became verifiable: 429 and 403 were not
provoked (deliberately), and self-hosted derivation and sprint writes remain unit-tested only.

