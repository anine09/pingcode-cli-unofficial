# S7 — ship live-API smoke run (real PingCode cloud)

**Date:** 2026-08-01 (local) · **Deployment:** public cloud `https://open.pingcode.com` (no `--host`)
**Binary under test:** `node dist/bin/pingcode.js` from `npm run build` (commit `aff5e07`)
**Org:** 3 ship products visible · **Smoke target product:** `PD-YYHC` (user-approved for writes)
· read-only comparison products: `PD-SHOU01`, `PD-SHOU02` (never written to).

### Redaction policy for this file

No secret value appears here. No token, no `client_secret`, no `client_id` (not even masked).
Tenant-identifiable values are replaced by stable placeholders:

| placeholder | what it stands for |
|---|---|
| `aaaaaaaaaaaaaaaaaaaaaaaa` | the smoke product id (24-hex) |
| `bbbbbbbbbbbbbbbbbbbbbbbb` | the created idea's id |
| `cccccccccccccccccccccccc` | the created ticket's id |
| `eeeeeeeeeeeeeeeeeeeeeeee` | the org-default ticket state-plan id |
| `<state:名称>` | a real 24-hex state id, referenced by its stock name |
| `<member-N>`, `<suite-N>` | product members / requirement modules |
| `example-tenant.pingcode.com` | the tenant's web host as it appears in `html_url` |
| `<short-id>` | an 8-char base62 `short_id` |

Product/idea/ticket *identifiers* (`PD-YYHC`, `PD-YYHC-73`, `PD-YYHC-T19`) are kept, because the
user needs them to delete the artifacts by hand. Priority ids (`5cb9466afda1ce4ca009000x`) and
property slugs / option ids are kept: they are org-independent constants already published in
`ship-api.md`.

## Created artifacts — permanent, must be deleted by hand

Ship exposes **no DELETE** for products, ideas or tickets (`S§`GOTCHA #17), so the CLI cannot
remove these. Exactly **one idea** and **one ticket** were created; both are titled with a
`[CLI smoke]` prefix and a timestamp, and both were left in a **closed** state.

| | idea | ticket |
|---|---|---|
| identifier | **PD-YYHC-73** | **PD-YYHC-T19** |
| id | `bbbbbbbbbbbbbbbbbbbbbbbb` | `cccccccccccccccccccccccc` |
| title | `[CLI smoke] pingcode-cli S7 live smoke 20260801T231937 (title updated)` | `[CLI smoke] pingcode-cli S7 live smoke 20260801T231937` |
| type | — | 技术支持 |
| priority | P3 | P3 |
| suite | `<suite-4>` | — |
| final state | **已关闭** (`closed`) | **已关闭** (`closed`) |
| url | `https://example-tenant.pingcode.com/ship/ideas/<short-id>` | `https://example-tenant.pingcode.com/ship/tickets/<short-id>` |

Write count: the idea was written 5× (create, `--title`, `--state 已计划`, `--state-id 进行中`,
`--state 已关闭`) plus 1 rejected PATCH; the ticket 4× (create, 2 transitions, 1 closing
transition) plus 2 rejected PATCHes (see F5). **No pre-existing product, idea or ticket was
modified.** A closing sweep (`idea list --keywords "CLI smoke"` / `ticket list --keywords
"CLI smoke"`) returns `total: 1` for each — nothing else was created.

## Step-by-step results

Command prefix `node dist/bin/pingcode.js`. "stderr 0" means the stderr stream was literally
0 bytes.

| # | command | exit | verdict |
|---|---|---|---|
| 1 | `auth status --check --json` | 0 | ✅ token fresh; live check `GET /v1/pjm/projects?page_size=1` ok. `token_scope: null` — **the token response carries no scope list**, which is why G5-2 cannot be answered by observation |
| 2 | `product list --json` | 0 | ✅ 3 products, envelope `{page_index,page_size,total,values}`, stdout pure JSON, stderr 0 |
| 2b | `product list` (human) | 0 | ✅ table `IDENTIFIER/NAME/VISIBILITY/ID` (design §13.2b columns), footer on stderr |
| 3 | `product get PD-YYHC --json` / human | 0 | ✅ 7 members embedded, `scope_type: organization`, `visibility: private` |
| 4 | `meta idea-states\|idea-priorities\|idea-suites\|idea-properties\|product-members --product PD-YYHC --json --no-cache` | 0 ×5 | ✅ 5 / 5 / 13 / 7 / 7 rows; all `{values,count}`; stderr 0 on all five |
| 5 | `idea list --product PD-YYHC --json --page-size 2 --page 0` and `--page 1` | 0, 0 | ✅ **G5-1**: disjoint row sets (PD-YYHC-1,2 then PD-YYHC-3,4), `total` 46 stable, echoed `page_index` 0 then 1 |
| 6 | `idea list … --state 已完成 --page-size 3 --json` | 0 | ✅ filter honoured: `total` 46 → 13, every row's state is 已完成 |
| 7 | `idea list … --suite <suite-4> --page-size 3 --json` | 0 | ✅ **13 rows, all in that module** → idea `suite.id` **is** filterable (`S§`9.5 said undetermined). The CLI's own caveat warning still prints on stderr (correct, conservative) |
| 8 | `idea get PD-YYHC-1 --json` | 0 | ✅ resolves by identifier |
| 9 | `idea list … --all --page-size 100 --json` | 0 | ✅ `{values,count:46,all:true}`; walk stopped on the short page; no `page_index` mismatch warning |
| 10 | `idea create … --dry-run --json` | 0 | ✅ stdout exactly `{"dry_run":true,"request":{method,url,headers,body}}`, `Authorization: ***REDACTED***`, stderr 0 |
| 11 | `idea list … --keywords "CLI smoke" --json` (after 10) | 0 | ✅ `total: 0` → the dry run **sent zero writes** (AC4) |
| 12 | `idea create --product PD-YYHC --title "[CLI smoke] …" --priority P3 --suite <suite-4> --json` | 0 | ✅ created **PD-YYHC-73**, initial state 待排期 |
| 13 | `idea update PD-YYHC-73 --title … --json` | 0 | ✅ title replaced |
| 14 | `idea update PD-YYHC-73 --state 已计划 --json` | 0 | ✅ name → id via the product-scoped state list; state 待排期 → 已计划 |
| 15 | `idea update PD-YYHC-73 --state-id <state:进行中> --json` | 0 | ✅ state → 进行中 |
| 16 | `idea update PD-YYHC-73 --state-id 000000000000000000000000` | **7** | ✅ server message verbatim (`需求状态不存在`, code `100719`) **plus** all 5 configured states and the current state on stderr — design §7's rejection path works. Exit is 7, not 5 (see F1) |
| 17a | `idea update … --state 已完成 --dry-run --no-cache` (wire-probed) | 0 | ✅ requests: resolving `GET /v1/ship/ideas/{ref}` **+ `GET /v1/ship/idea/states`** |
| 17b | `idea update … --state-id <state:已完成> --dry-run --no-cache` (wire-probed) | 0 | ✅ requests: resolving GET **only** → `--state-id` provably **skips the name lookup** |
| 18 | `idea get PD-YYHC-1 --json` (wire-probed) | 0 | ✅ see F2 — the wire record carries 4 fields the CLI's `--json` drops |
| 19 | `idea get <pasted html_url>` and `idea get <24-hex id>` | 0, 0 | ✅ both resolve to PD-YYHC-73 → see **F3** (short_id works as a lookup key) |
| 20 | `idea update PD-YYHC-73` (empty patch), also `--json` | **2**, **2** | ✅ `nothing to update…`; under `--json` stdout is 0 bytes and the error is `{"error":{kind:"usage",…,"exit":2}}` on stderr |
| 21 | `idea get 000000000000000000000000 --json` | **7** | ⚠️ **F1** — HTTP 400 + code `100725` (`需求不存在或无权访问`), not 404, so exit 5 never fires |
| 21b | `idea get ZZZ-99999 --json` | **5** | ✅ client-side identifier miss → `not_found`, exit 5 |
| 21c | `product get no-such-product-xyz --json` | **2** | ✅ unresolvable name → usage error, as in pjm |
| 22 | `product list --json` and `idea list --json` with fake `PINGCODE_CLIENT_ID/SECRET` and an isolated `PINGCODE_CONFIG_DIR` | **3**, **3** | ✅ `kind:"auth"`, exit 3, `client_secret=***REDACTED***` in the message; the real `~/.pingcode/config.json` was untouched |
| 23 | `meta ticket-states\|ticket-priorities\|ticket-types\|ticket-channels\|ticket-properties --product PD-YYHC --json --no-cache` | 0 ×5 | ✅ 5 / 5 / 3 / 1 / 7 rows; stderr 0 on all five |
| 24 | `ticket list --product PD-YYHC --json --page-size 2` (+ `--page 1`, wire-probed) | 0 | ✅ `total: 14`, envelope echoes `page_index` 0 then 1 |
| 25 | `ticket get PD-YYHC-T1 --json` (wire-probed) | 0 | ✅ `channel` is the bare string `"internal"` (`S§`GOTCHA #3 confirmed live); **no state-plan field** (F4) |
| 26 | `ticket create … --dry-run --json` | 0 | ✅ dry-run plan only, `type_id` resolved from `--type 技术支持` |
| 27 | `ticket list … --keywords "CLI smoke" --json` (after 26) | 0 | ✅ `total: 0` → zero writes |
| 28 | `ticket create --product PD-YYHC --type 技术支持 --title "[CLI smoke] …" --priority P3 --json` | 0 | ✅ created **PD-YYHC-T19**, state 待处理, `channel: "internal"` |
| 29 | `ticket transition PD-YYHC-T19 --state 处理中 --dry-run --json --no-cache` (wire-probed) | 0 | ⚠️ requests: ticket GET → `ticket/states` → `ticket_state_plans`; **no plan matched** → warn-and-proceed (F5) |
| 30 | `ticket transition PD-YYHC-T19 --state 处理中 --json` (legal edge) | 0 | ✅ 待处理 → 处理中, with the F5 warning on stderr |
| 31 | `ticket transition PD-YYHC-T19 --state 已完成 --json` (**illegal** edge) | **7** | ⚠️ **F5** — refused by the *server* (HTTP 400 code `100702`), not locally with exit 2; and the cache-invalidation retry sent the doomed PATCH twice |
| 32 | `ticket update PD-YYHC-T19 --json` (empty patch) | **2** | ✅ same message as idea |
| 33 | `ticket transition PD-YYHC-T19 --state 没有这个状态 --json` | **2** | ✅ `no ticket state matches "…"` before any request |
| 34 | `idea list … --page-size 500` | **2** | ✅ `--page-size must be an integer between 1 and 100` (client-side cap) |
| 35 | `ticket transition PD-YYHC-T19 --state 已关闭 --json` | 0 | ✅ legal edge 处理中 → 已关闭; artifact left closed |
| 36 | `idea update PD-YYHC-73 --state 已关闭 --json` | 0 | ✅ artifact left closed |
| 37 | `idea get PD-YYHC-73 --verbose` | 0 | ✅ trace is `→/← GET …` only; the stored secret's exact value is **absent** from stdout+stderr, and the literal token `client_secret` never appears |
| 38–40 | `ticket list` / `meta idea-states` / `idea list` in **human** mode | 0 ×3 | ✅ ticket columns identifier/title/state/priority/assignee/**channel** (design §13.4); paging footer on stderr |
| 41–43 | final `idea get`, `ticket get`, and both `--keywords "CLI smoke"` sweeps | 0 ×4 | ✅ exactly one idea and one ticket carry the smoke marker |
| — | `--json` purity sweep over **44** JSON invocations | — | ✅ every stdout parsed as JSON; stderr was 0 bytes on every read command; the only non-empty stderrs are deliberate warnings (suite caveat, state-plan caveat) and errors |

No `429` was observed at any point, so no `x-pc-retry-after` value could be recorded. The whole
run is well under the 200 req/min ceiling (≈120 ship requests across ~50 invocations, spread over
~25 minutes).

### How the wire evidence was captured

Steps marked "wire-probed" were run through a throwaway harness in a temp directory that wrapped
`globalThis.fetch`, then imported `dist/bin/pingcode.js` unchanged. It logged, for `/v1/ship/`
traffic only, the response status and body (never headers, never the token exchange). This was
necessary because the CLI's `--json` is not byte-faithful to the wire (F2) and `--verbose` prints
no bodies. The harness lives outside the repo and is **not** committed; every conclusion below is
reproducible by re-running the same 20-line wrapper.

## Gate G5 — the three blanks, settled

### G5-1 · Does `POST /v1/ship/ideas/search` echo `page_index`? **Yes — and it is honoured.**

Observation (raw wire body, `--page-size 2`, `total: 46` throughout):

```
POST /v1/ship/ideas/search   → keys ["page_index","page_size","total","values"]
  request page_index 0  → body.page_index 0, rows PD-YYHC-1, PD-YYHC-2
  request page_index 1  → body.page_index 1, rows PD-YYHC-3, PD-YYHC-4
hasOwnProperty("page_index") === true in both cases
```

The CLI's own `--json` could not have settled this: `normalizeEnvelope` falls back to the
*requested* index when the field is missing, so a printed `page_index: 1` is ambiguous. The raw
body was therefore inspected directly, and the field is genuinely present.

**Conclusion:** PRD **Q2 is answered — search behaves exactly like the GET lists**. The design §3
mismatch guard is live and meaningful; the "missing ⇒ no signal, continue" defence is dead code on
this deployment but costs nothing and stays. `POST /v1/ship/tickets/search` echoes it too
(verified the same way at `--page 1`). Row sets are disjoint across pages, so offset paging on the
search endpoints is real, not a stub.

### G5-2 · Which scope do the ship metadata endpoints require? **Unverifiable with this token.**

What was observed: all ten product-scoped metadata reads (`idea/{states,priorities,suites,
properties}`, `products/{id}/members`, `ticket/{states,priorities,types,channels,properties}`)
returned **HTTP 200**, as did `GET /v1/ship/ticket_state_plans` and
`GET /v1/ship/ticket_state_plans/{plan}/ticket_state_flows` — the two *configuration*-looking
endpoints in the surface.

Why this settles nothing about minimisation:

1. The user granted **every** ship scope, so no 403 can be provoked. A 200 proves "the union of
   granted scopes is sufficient", never "this endpoint needs scope X".
2. `GET /v1/auth/token` returns **no `scope` field** at all (`auth status --json` →
   `token_scope: null`), so the CLI cannot even enumerate what it holds.
3. There is therefore no experiment available short of registering a second app with a reduced
   scope set — out of scope for this slice.

What the docs declare per endpoint (`S§`J3, `S§`K3, `S§`M, GOTCHA #29), which is the only evidence
that exists:

| endpoint | declared scope |
|---|---|
| `GET /v1/ship/idea/{states,priorities,suites,properties,plans}?product_id=` | `pcp:read:ship:idea` |
| `GET /v1/ship/ticket/{states,priorities,types,channels,properties,tags,solutions}?product_id=` | `pcp:read:ship:ticket` |
| `GET /v1/ship/products/{id}/members` | `pcp:read:ship:product` |
| `GET /v1/ship/ticket_state_plans[/{plan}/ticket_state_flows]` | **`pcp:read:ship:configuration`** |
| `GET /v1/ship/products/{id}/{tags,channels}` (the alternate route to the same data) | `pcp:read:ship:configuration` |

**Conclusion:** PRD **Q1's fear does not apply to the ten product-scoped lookups** — ship declares
them under the plain `idea`/`ticket`/`product` read scopes, *unlike* Testhub. It **does** apply to
transition pre-validation: `ticket_state_plans` and `ticket_state_flows` are `configuration`-scoped,
so `pingcode ticket transition` needs `pcp:read:ship:configuration` to pre-validate at all. That is
precisely why design §13.2 step 3 must warn-and-proceed rather than block, and README/SKILL.md
should list `pcp:read:ship:configuration` as **optional — improves `ticket transition`**, not
required. Not verified live that it is *sufficient* on its own; only that it is not *missing* here.

### G5-3 · Do the live response fields match `ship-api.md`? **Yes for all three resources — the drift is in the CLI, not the API.**

Compared field-by-field against the raw wire bodies, not the CLI's `--json`.

**Product** (`GET /v1/ship/products` row and `GET /v1/ship/products/{id}`) — 16 keys, identical on
both endpoints and identical to `S§`3.1:
`id url visibility name identifier scope_type scope_id color description members created_at
created_by updated_at updated_by is_archived is_deleted`. `scope_id` is `null` (org-scoped
product), `description` is `""`. `is_archived`/`is_deleted` are real JSON booleans here, not `0/1`.
Embedded member = `{id, url, type, user}` with **no `role`** — exactly as `S§`3.1 says for the
embedded form, while the dedicated `…/members` endpoint does return `role` (and `product`).
**No discrepancy.**

**Idea** (`GET /v1/ship/ideas/{id}` and each `POST …/search` row) — 27 keys, same set on both:
`id url identifier title short_id html_url product suite assignee state priority plan_at real_at
progress plan description properties participants score completed_at completed_by created_at
created_by updated_at updated_by is_archived is_deleted`. That is `S§`3.2 exactly, minus
`public_image_token` (conditional on the request parameter). `plan_at`, `real_at`, `plan` and
`score` are present as `null` when unset — so `score` **is** returned, contradicting nothing but
worth stating since it has no write parameter. `state` ref = `{id,url,name,type}` with idea state
`type` ∈ `pending|in_progress|completed|closed` — this **settles `S§`9.2**: ideas use the *same*
4-value enum as tickets. `suite` ref = `{id,url,name,type:"module"}`. `properties` values for
select types are option `_id`s (`backlog_type` → `5cb7e763fda1ce4ca0010002`), confirming
GOTCHA #5. **No discrepancy.**

**Ticket** (`GET /v1/ship/tickets/{id}`) — 29 keys: `S§`3.3 exactly, minus `public_image_token`.
`channel` is the bare string `"internal"`, confirming GOTCHA #3's shape hazard on the wire.
`solution` and `estimated_at` are `null`. **No discrepancy** — and, importantly, **no state-plan
reference of any spelling** (F4).

Where the docs *were* wrong is not the three work objects but the **metadata list rows** and one
GOTCHA; those corrections are written into `ship-api.md` §10 and summarised as F3/F6/F7 below.

## Findings

### F1 · Not-found is HTTP 400 on ship too, so exit 5 is unreachable for server-side misses

`GET /v1/ship/ideas/<unknown 24-hex>` → `400` + code `100725`; an illegal `state_id` → `400` +
`100719` (idea) / `100702` (ticket). The status-first mapper only turns `404` into exit 5, so these
land on exit 7 (`api`). Exit 5 still fires for *client-side* identifier misses (`idea get
ZZZ-99999`). This is the **same finding F2 as the pjm smoke** (`s8-smoke.md`), now confirmed on
ship: the API essentially never returns 404.

**No fix attempted.** Changing it means either editing the status→exit mapping in
`core/errors.ts` / `core/http.ts` (frozen for this task) or teaching the api layer to translate
vendor codes into `NotFoundError`, which changes the error contract. That is an orchestrator/design
call, not a smoke-run patch.

### F2 · `--json` is not byte-faithful to the wire: `null` and `""` fields disappear

`api/parse.ts` spreads the raw record and then overwrites the known keys with normalised values;
`asString`/`asNumber`/`parseRef` return `undefined` for `null` **and for `""`**, and
`JSON.stringify` drops `undefined`. Consequences observed live:

| wire | `--json` |
|---|---|
| idea `plan_at:null, real_at:null, plan:null, score:null` | those four keys are absent |
| product `scope_id:null, description:""` | both keys are absent |
| ticket `solution:null, estimated_at:null` | both keys are absent |

Nothing is *falsified* — an absent key and a `null` key mean the same thing to almost every
consumer — but design §10's claim that the index signature keeps `--json` "faithful to the API" is
too strong, and an agent diffing our output against the vendor docs will think fields are missing
(as this smoke run initially did). This is **pre-existing, module-agnostic behaviour** inherited
from the pjm surface, not something ship introduced.

**No fix attempted:** it would change the `--json` payload of every existing command.

### F3 · `GET /v1/ship/ideas|tickets/{…}` accepts `id`, `short_id` **and** `identifier`

GOTCHA #25 states that "no endpoint accepts `short_id` or `identifier` as a lookup key". Live, all
three of these returned `200` with the same record:

```
GET /v1/ship/ideas/bbbbbbbbbbbbbbbbbbbbbbbb   → 200   (24-hex id)
GET /v1/ship/ideas/<short-id>                 → 200   (8-char base62, from the pasted html_url)
GET /v1/ship/ideas/PD-YYHC-73                 → 200   (human identifier)
GET /v1/ship/tickets/PD-YYHC-T1               → 200
```

This is the exact same "id **or** `short_id`" tolerance the pjm work-item GET has (`§6.9` of the
pjm research), extended to the identifier as well. Design §13.2b's assertion that a pasted
`html_url` "is allowed to fail honestly" is therefore wrong — it succeeds.

Side effect worth knowing: `IDENTIFIER_RE` in `core/metadata.ts` is `/^[A-Za-z][A-Za-z0-9_]*-\d+$/`,
which does **not** match `PD-YYHC-73` (the product identifier itself contains a `-`). Such
references skip the search path and go straight to `GET …/ideas/PD-YYHC-73` — which works, and in
one request instead of two. Both routes are exercised above (step 8/19 vs 21b) and both behave
correctly, so **no code change was made**: broadening the regex would replace a working 1-request
path with a 2-request one. Documented here so nobody "fixes" it blindly.

### F4 · Confirmed live: a ticket carries no state-plan reference (GOTCHA #33)

The raw `GET /v1/ship/tickets/{id}` body has 29 keys and **none** of `state_plan`,
`ticket_state_plan`, `state_plan_id`; `state` is `{id,url,name,type,color}`. GOTCHA #33 was written
from a doc re-read and explicitly asked to be settled live — it is now settled: the wire is **not**
richer than `S§`3.3. Design §13.2a's opportunistic read of the three spellings can never hit, and
the fallback scan is the only route.

### F5 · Transition pre-validation is dead on this tenant, because the only state plan is the org default

Live data:

```
GET /v1/ship/ticket_state_plans                     → total 1
  values[0] = { id: "eeeeeeeeeeeeeeeeeeeeeeee", url: …, product: null }

GET /v1/ship/ticket_state_plans/eeee…/ticket_state_flows  → 200, total 4
  待处理 → 处理中 | 处理中 → 已计划 | 已计划 → 已完成 | 处理中 → 已关闭
  row keys: { id, url, state_plan, form_state, to_state }
```

Three things follow:

1. **The flows endpoint is reachable and returns genuinely usable data** — this is the G5 ticket
   sub-question, answered yes.
2. **`form_state` (the typo) is real on the wire.** `S§`9.3 listed this as undeterminable;
   it is now determined. `from_state` does **not** appear. Accepting both keys was the right call.
3. **But the CLI never gets there.** Design §13.2a step 2 says to "skip the `product: null`
   org-default rows and match the embedded `product.id`". Here the *only* plan is that
   `product: null` row, so the matcher finds nothing, and every transition takes the §13.2 step-3
   escape hatch: `warning: no ticket state plan could be matched to this product, so the transition
   cannot be checked locally; sending it and letting the server decide`.

Observable consequences:

- A **legal** transition succeeds (step 30, 35) — with a spurious warning.
- An **illegal** transition (处理中 → 已完成, absent from the flow list) is refused by the
  **server**: HTTP 400, code `100702`, message `工单状态不存在` — misleading, since the state exists
  and it is the *edge* that does not. The CLI then prints all five configured states plus the
  current one, which is the useful part. Exit is **7**, not the exit 2 AC9 asks for.
- Because the local check was skipped, `withCacheInvalidation` reads the rejection as a stale
  cached id: it drops the cache, re-resolves and **retries the doomed PATCH once**. Two write
  attempts per illegal transition, both correctly rejected, no state change — but noisy, and it
  burns rate budget.

So **AC9's "refuses an illegal target state locally with exit 2, proven against the real API"
cannot be met as designed on this tenant**, even though the data needed to do it is one request
away. The obvious repair — *if no product-scoped plan matches but exactly one `product: null`
plan exists, treat that org-default plan as the product's plan* — contradicts design §13.2a step 2
and GOTCHA #23 as written, so it is **a design change and was deliberately not implemented in S7**.
Recorded in `design.md` §14 for the orchestrator to accept or reject. Local refusal remains covered
by the S5b unit tests; it is only the *live* proof that is missing.

### F6 · Product-scoped metadata lists are leaner than the single-GET shapes

`S§`3.6 documents each metadata resource from its `GET …/{id}` record. The product-scoped list
endpoints return strictly fewer fields:

| endpoint | live row | `S§`3.6 single-GET |
|---|---|---|
| `GET /v1/ship/idea/suites?product_id=` | `{id, url, name, type}` | `{id, url, product, name, type, parent}` |
| `GET /v1/ship/ticket/channels?product_id=` | `{id, url, name}` | `{id, url, name, product, description}` |
| `GET /v1/ship/ticket/types?product_id=` | `{id, url, name}` | `{id, url, name, is_system}` (already noted in `S§`3.6) |
| `GET /v1/ship/idea/{states,priorities}?product_id=` | `{id,url,name,type}` / `{id,url,name}` | + `color` on states |
| `GET /v1/ship/idea/properties?product_id=` | `{id, url, name, type, options}` | + `is_removable, is_name_editable, is_options_editable` |

This generalises GOTCHA #12 (`plans`, `ticket_types`) to **every** product-scoped metadata list.

The consequence that matters: **`suites` has no `parent`**, so the requirement-module tree cannot
be reconstructed from the endpoint the CLI uses. `core/metadata.ts`'s `loadSuites` reads
`record.parent`, finds nothing, and every candidate's `path` collapses to its own `name`. The live
product has 13 suites — 1 `type: "product"` root and 12 `type: "module"` — all with unique names,
so **name resolution works** (step 7 resolved a module name and filtered correctly). But the
cross-branch ambiguity error of design §5 and the `"Parent / Child"` path alias are **unreachable
via this endpoint**; they would need `GET /v1/ship/products/{id}/suites` (the alternate route,
`configuration`-scoped) to carry `parent`. No code change: the flattening is inert, not wrong, and
it is correct as written the moment a `parent` appears.

### F7 · The property `type` enum has an undocumented `system` value

`GET /v1/ship/idea/properties?product_id=` returns `plan_at` and `real_at` with `type: "system"`;
the ticket view adds `estimated_at` and `tag_ids` with the same. `system` is not one of the 13
documented types (`text…link`, `S§`L). Live idea property view: `priority(select)`,
`plan_at(system)`, `real_at(system)`, `rate(progress)`, `backlog_from(select)`,
`backlog_type(select)`, `description(textarea)` — note the id `rate` for a `progress`-typed field,
and that the documented system property `identifier` is **absent** here while `priority` and
`description` show up as properties despite also being first-class fields. Ids are slugs
throughout, confirming GOTCHA #4. Harmless for the CLI (`--set` only needs the id), but a codegen
reading the enum would reject real data.

### F8 · Also settled in passing

- **Idea `suite.id` is filterable** (step 7) — `S§`9.5 listed it as undetermined. `plan.id`,
  `plan_at`, `real_at` remain untested.
- **Idea state `type` enum = the ticket enum** (`pending|in_progress|completed|closed`) — `S§`9.2
  settled.
- **Priorities are shared between ideas and tickets**, id for id (`5cb9466afda1ce4ca0090001`…`5`
  = P4…P0 in both views) — GOTCHA #26's suspicion confirmed for this org; still fetched per
  product, per `S§`5.
- **The one channel in this product is named after the product itself** and its `url` points at
  `/v1/ship/products/{pid}/channels/{cid}`, i.e. the real path, not the phantom
  `/v1/ship/channels/{id}` of GOTCHA #3's example.
- **No 429 in ~120 requests**, so `x-pc-retry-after` remains unobserved (`S§`9.12 open).

## What this run does not prove

- **Scope minimisation** (G5-2) — impossible with an all-scopes token and a scope-less token
  response.
- **Local exit-2 refusal of an illegal ticket transition** (AC9) — blocked by F5; needs either the
  design change or a tenant with a product-scoped state plan.
- **Product write paths** — out of scope by design (`product` has no create/update/delete in the
  CLI), so nothing here exercises `POST /v1/ship/products`.
- **Read-only products** `PD-SHOU01` / `PD-SHOU02` were never written to, so cross-product cache
  isolation (`S§`9.7) was not exercised beyond `product list`.
- **`properties` writes** (`--set`) were not exercised against a real select-typed property, so
  GOTCHA #6 (out-of-view key rejected vs silently dropped) is still open.
- **Rate-limit behaviour**, deliberately not provoked.
