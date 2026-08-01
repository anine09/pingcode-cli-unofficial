# Design — Ship (product) command surface

Reads: `prd.md` (D1–D9, R1–R10, AC1–AC8). API facts cited as `S§x` refer to
`.trellis/tasks/archive/2026-08/08-01-ship-testhub-research/research/ship-api.md`.
Existing architecture cited as `M§x` refers to the pjm MVP design at
`.trellis/tasks/archive/2026-08/07-31-pingcode-cli-mvp/design.md`.

## 1. Shape of the change

Additive only. No file in `src/core/` changes behaviour except two additions
(`endpoints.ts` gains ship paths, `paginate.ts` gains a body-paginated variant,
`metadata.ts` gains ship resolver kinds). Nothing in `auth.ts`, `http.ts`, `wire.ts`,
`config.ts`, `errors.ts`, `redact.ts` or `output.ts` is touched — if ship appears to need a
change there, stop and raise it.

New files:

```
src/api/ship.ts              typed wrappers + response parsing
src/cli/commands/product.ts  product list|get
src/cli/commands/idea.ts     idea list|get|create|update
test/ship.test.ts            api wrappers + parsing
test/searchPaginate.test.ts  body pagination
```

Modified: `src/core/endpoints.ts`, `src/core/paginate.ts`, `src/core/metadata.ts`,
`src/cli/commands/meta.ts`, `src/cli/program.ts`, `src/types/api.ts`,
`skills/pingcode/SKILL.md`, `README.md`, `test/help.test.ts`, `test/metadata.test.ts`.

Layering is unchanged and still enforced by `test/layering.test.ts`:
`cli → {api, core}`, `api → core`, `core` imports nothing from either.

## 2. Endpoints used

| Purpose | Call |
|---|---|
| product list / name→id | `GET /v1/ship/products` (`keywords`, paging) |
| product detail | `GET /v1/ship/products/{product_id}` (embeds members) |
| idea read (default) | `POST /v1/ship/ideas/search` |
| idea detail | `GET /v1/ship/ideas/{idea_id}` |
| idea create | `POST /v1/ship/ideas` — required: `product_id`, `title` (S§J) |
| idea update | `PATCH /v1/ship/ideas/{idea_id}` |
| states | `GET /v1/ship/idea/states?product_id=` |
| priorities | `GET /v1/ship/idea/priorities?product_id=` |
| suites | `GET /v1/ship/idea/suites?product_id=` |
| properties | `GET /v1/ship/idea/properties?product_id=` |
| member candidates | `GET /v1/ship/products/{product_id}/members` |

`GET /v1/ship/ideas` is deliberately unreachable from the CLI (D2). There is no idea DELETE
and no idea state-flow endpoint (S§J, S§J3).

## 3. Body pagination (`searchPaginate`)

`POST …/search` takes `{mode, payload:{filter, keywords, page_size, page_index, …}}` and
returns the same envelope as the GET lists. So `searchPaginate` mirrors `paginate` exactly,
with one difference: the page cursor goes into `payload`, not the query string.

Shared with `paginate` (do not fork the logic — extract the loop and inject a
`requestPage(pageIndex, pageSize)` closure):

- 0-based `page_index`, default 30, hard cap 100 (client-side `UsageError` above that).
- `--all` walks pages, de-duplicates on `id`, stops on a short page, and respects `--limit`
  (default 500).
- If the envelope echoes a `page_index` different from the one requested, warn on stderr and
  stop iterating (M§5.1). **Q2**: if search turns out not to echo `page_index`, treat a
  missing field as "no signal" and continue — only a *mismatching* value stops the walk.
- Documented as best-effort, not a consistent snapshot: this API has no sorting.

## 4. Filters

`idea list` maps flags to `payload.filter` using the documented operator set (`S§` search DSL):
one operator per field, no `$and`/`$or`, reference fields addressed as `state.id`,
`priority.id`, `assignee.id`, `suite.id`, custom fields as `properties.{key}`. `keywords` is a
sibling of `filter`, not a filter entry. Unsupported flag combinations fail as `UsageError`
(exit 2) before any request goes out.

## 5. Metadata resolution

Reuse `core/metadata.ts` wholesale. New kinds: `ship-product`, `ship-idea-state`,
`ship-idea-priority`, `ship-idea-suite`, `ship-product-member`. Parent id is the
**product id** for everything except `ship-product` itself, whose parent is the org (null).

Rules carried over unchanged from M§6:

- Name lookup is `keywords`-then-exact-name, case-insensitive, must be unique; ambiguity is a
  `UsageError` listing candidates.
- Ids pass through untouched — no shape validation, ever (three id shapes exist; users are
  32-hex, some ids are slugs).
- Cache key `(apiBase, clientId, parentId, kind[, scope])`, 24 h TTL, `--no-cache` bypass,
  cleared by `auth login` / `auth logout`.
- Writes that used a cached id are wrapped in `withCacheInvalidation`: on rejection, drop the
  key, resolve again, retry once, then report with the "try `--no-cache`" hint.

Suites are a tree (`type` ∈ `product` | `module`, S§D). The resolver flattens it and matches on
name; if two nodes in different branches share a name, that is an ambiguity error listing both
paths, not a silent pick.

## 6. Idea references

`idea get|update <idea>` accepts, in this order: a raw id, an `identifier` (via search on the
identifier field if the DSL allows it, otherwise `UsageError` telling the user to pass an id),
or a pasted `html_url` (extract the trailing id segment). Update resolves to a real id with one
GET before it PATCHes, exactly as `work-item update` does.

## 7. State changes

`idea update --state <name>` resolves the name against the product's states and PATCHes
`state_id`. There is no flow endpoint (D6), so there is no pre-validation: if the server
rejects the transition, print its message on stderr plus the product's configured states, and
exit with the mapped code. `--state-id <id>` skips the lookup entirely.

## 8. Update semantics

Only fields the user passed are sent. Arrays and `properties` **replace**, they do not merge —
stated in `--help`, README and SKILL.md. An empty patch is a `UsageError` (exit 2) raised in
the command layer, before `updateIdea` is reached. No field-clearing support in this slice.

## 9. Output

Identical contracts to the pjm surface (M§7.2, M§7.3):

- Human mode: a width-aware table. `idea list` columns: identifier, title, state, priority,
  assignee, suite. `product list`: identifier, name, state, owner.
- `--json`: stdout is JSON only, but **not byte-faithful to the wire**: `api/parse.ts` normalises
  `null` and `""` to `undefined`, so those keys are absent from the output (§14.5). An absent key
  means null, empty, or genuinely missing, and consumers must not distinguish them.
  Single page → the raw envelope shape
  `{page_index,page_size,total,values}`; `--all` → `{values,count,all:true}`; small config
  reads (`meta idea-*`, `meta product-members`) → `{values,count}`.
- Timestamps stay raw unix seconds under `--json`, localised only in human mode.
- Errors, dry-run plans, warnings: stderr in human mode; dry-run under `--json` goes to stdout
  as `{"dry_run":true,"request":{…}}`.

## 10. Types

Hand-written in `src/types/api.ts` for the ~11 endpoints above, snake_case with an index
signature so unknown fields — including custom `properties` — survive into `--json` untouched.
(Unknown fields survive; `null` and `""` do not, see §9 and §14.5.) Normalisation
(0/1 → boolean, singular/plural drift) happens once, in `api/parse.ts`. Do not generate types
from `api_data.json` in this slice — that remains a follow-up.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Search does not echo `page_index` (Q2) | Missing ⇒ no signal, continue; mismatch ⇒ stop. Settled live in AC5. |
| Metadata endpoints need an unlisted scope (Q1) | Confirm in `ship-api.md`, then live; a 403 must surface as exit 4 with the scope named in the message. |
| Suite name collisions across branches | Ambiguity error listing full paths. |
| `properties` merge semantics undocumented | Replace-only, documented; no partial property writes offered. |
| Ship returns a field shape that differs from the docs | AC7: write the finding back into the research file and this design, then handle it in the parse layer. |
| Rate limit (200/min) during name resolution | 24 h cache and one lookup per parent; smoke stays well under. |

## 12. Rollback

One commit per slice (see `implement.md`); every commit leaves `typecheck` and `test` green.
The only external side effect is the idea created during AC5, which is deleted or clearly
marked as a test artifact at the end — note that ship exposes **no idea DELETE**, so it can
only be marked, and the smoke plan must say so up front.

---

## §13 Revision 2 — ticket support

Supersedes §1's file list and §2's endpoint table where they omit tickets. Approved at the review
gate. Architecture is unchanged: tickets reuse the search-based read path, the body-pagination walk,
the product-scoped resolver cache, and the shared command plumbing.

### §13.1 Additional endpoints

| Purpose | Method + path | Notes |
|---|---|---|
| Search tickets | `POST /v1/ship/tickets/search` | Same envelope and DSL shape as ideas; default read path |
| Get one ticket | `GET /v1/ship/tickets/{ticket_id}` | Accepts id; identifier resolved via search |
| Create ticket | `POST /v1/ship/tickets` | Required: `product_id`, `title`, **`type_id`** |
| Update ticket | `PATCH /v1/ship/tickets/{ticket_id}` | Only fields passed are sent; arrays replace |
| Ticket states | `GET /v1/ship/ticket/states?product_id=` | Product-scoped |
| Ticket priorities | `GET /v1/ship/ticket/priorities?product_id=` | Product-scoped |
| Ticket types | `GET /v1/ship/ticket/types?product_id=` | Required for create |
| Ticket channels | `GET /v1/ship/ticket/channels?product_id=` | Product-scoped |
| Ticket properties | `GET /v1/ship/ticket/properties?product_id=` | Needed to write `properties` |
| Ticket state flows | `GET /v1/ship/ticket_state_plans/{plan_id}/ticket_state_flows` | Legal transitions |

There is **no ticket DELETE** (S§K), exactly as with ideas: smoke artifacts can only be marked.

### §13.2 Transitions: advisory, not pre-validated (tickets)

*Rewritten in S7b; supersedes the original §13.2 step list and all of §13.2a, which specified a
local refusal. Evidence: `research/s7-smoke.md` F5.*

`ticket transition <ref> --state <name|id>` sends the PATCH. The only thing refused locally is a
move to the state the ticket is already in — judgeable from the ticket alone, tenant-independent,
exit 2.

The state plan is still read, but only on paths where the answer is a nicety:

1. **On a server refusal**, `explainStateRejection` appends to the error's `message`: the product's
   configured states, the current state, and — if a plan can be found — the states reachable from
   it. The reachable set goes in the **`message`**, never the `hint`, because `--json` errors are
   `{kind,message,code,exit}` and drop the hint; an agent told "no" must still be able to learn
   "then what".
2. **On `--dry-run`**, the reachable set is printed to stderr before the request plan. The user
   explicitly asked what would happen, cost is irrelevant, and nothing can be refused.

Plan discovery is unchanged as a *procedure* and unchanged in its failure mode — read
`state_plan` / `ticket_state_plan` / `state_plan_id` off the ticket opportunistically (the wire
carries none of them, §14.4), else scan every `GET /v1/ship/ticket_state_plans` and match the
embedded `product.id`, else fall back to the **single `product: null` org-default plan**. Any
obstacle — no product, no plan, no flows, a 403 on the `pcp:read:ship:configuration` scope the flow
read needs — simply yields no suggestion. Nothing throws, nothing blocks.

Why the refusal had to go, in the order the arguments settled it:

- **It prevents nothing.** The server refuses atomically; the ticket is unchanged either way. The
  entire benefit was one saved round-trip and exit 2 instead of the server's code.
- **It can be wrong in the one direction that matters.** A mis-identified plan produces a *false*
  refusal, and there is no escape hatch: `--state-id` skipped the name lookup but not the plan
  check, and `--no-cache` cannot fix a plan that was never the right plan. An agent told a legal
  move is impossible stops.
- **Its cost is permanent**: an O(all plans) scan plus a flow read on every transition, on the
  happy path, depending on a scope (`pcp:read:ship:configuration`) that is *optional* everywhere
  else.
- **It made identical input exit differently on different tenants** — 2 where a product-scoped plan
  exists, 7 where only the org default does.
- **It dragged in a stale-cache hazard class of its own**: a cached flow list could invent an
  illegal transition, which is why the code had grown a cache-bypassed re-read before every
  refusal. Advisory output needs none of that.

Note how the GOTCHA #23 contradiction dissolves. The docs say to skip `product: null` plans, and
that rule is right for *authoritative* use — of which there is now none. For *advisory* use a
guessed plan yields a slightly-wrong suggestion inside an already-failing message, which is
harmless. `ship-api.md` §10 records the same conclusion.

### §13.2b Corrections to this design found while implementing

- **§9 is wrong about `product list` columns.** It specifies `identifier, name, state, owner`, but a
  ship product has neither a `state` nor an `owner` field (`ship-api.md` §3.1). The implemented
  columns are `identifier, name, visibility, id`.
- **§6's URL rule cannot work for ship.** A pasted `html_url` ends in the `short_id`, and
  `ship-api.md` §25 is explicit that **no ship endpoint accepts `short_id` or `identifier` as a
  lookup key**. The trailing segment is therefore passed through as an id and allowed to fail
  honestly; identifiers such as `SLC-1` go through `POST …/search` plus a client-side exact match.
- **`POST …/search` collides with the dry-run gate.** The gate keys off the HTTP verb, so a search
  would print a request plan instead of listing. Bypassed for those two paths only, in
  `core/paginate.ts` — `core/http.ts` was not touched.


### §13.3 Metadata kinds

Adds `ship-ticket-state`, `ship-ticket-priority`, `ship-ticket-type`, `ship-ticket-channel`,
`ship-ticket-property` — all parented by product id, same TTL, same `withCacheInvalidation` wrapping
on writes, same never-validate-id-shape rule. `ship-ticket-state-flow` is **not** cached under a
product parent: it is keyed by plan id.

### §13.4 Output

`ticket` human table columns: identifier / title / state / priority / assignee / channel.
`--json` shapes identical to idea (single page = raw envelope, `--all` = `{values,count,all:true}`).

### §13.5 New files

`src/cli/commands/ticket.ts` and `test/ticket.test.ts` join the §1 list.

---

## §14 Live findings from S7 that this design got wrong

Evidence: `research/s7-smoke.md` (2026-08-01, public cloud, one product, all ship scopes granted).
Nothing in `src/` was changed in S7 — each item below is either a doc correction or a decision the
orchestrator has to take. Research corrections went into `ship-api.md` §10 in the same commit.

### §14.1 Settled: Q2 — search **does** echo `page_index` (§3, §11)

`POST /v1/ship/ideas/search` and `POST /v1/ship/tickets/search` return
`{page_index, page_size, total, values}` with the requested index echoed as an own property, and
paging is real (disjoint row sets). §3's "missing ⇒ no signal, continue" defence is therefore never
exercised on this deployment. Keep it — it costs nothing and the docs still do not promise the field
— but the risk row in §11 can be closed.

### §14.2 §5's suite tree cannot be built from the endpoint we use

`GET /v1/ship/idea/suites?product_id=` returns `{id, url, name, type}` — **no `parent`**. So
`loadSuites`' path construction collapses to the bare name, and the cross-branch ambiguity error is
unreachable through this endpoint. Name resolution itself works (verified on 13 real suites, 1
`product` root + 12 `module`). The alternative `GET /v1/ship/products/{id}/suites` might carry
`parent`, but it is `configuration`-scoped. **No code change made**: the flattening is inert, not
wrong, and becomes correct the moment `parent` appears. §5's last paragraph should be read as
conditional.

### §14.3 The plan lookup can never succeed on a default org — **resolved in S7b: advisory, accepted**

The finding: `GET /v1/ship/ticket_state_plans` returned **one** row, `{id, url, product: null}`.
The original §13.2a step 2 skipped `product: null` rows, so no plan was ever matched, every
transition took the warn-and-proceed path, and a server refusal additionally cost a second PATCH
because `withCacheInvalidation` misread it as a stale id. The org-default plan *is* the effective
plan: its flows are readable (`200`) and its 4 edges match what the server enforces.

**Decision (architecture review, S7b): local pre-validation is removed; the flow read becomes
advisory.** The reasoning is recorded in the rewritten §13.2. In short — a local check prevents no
damage because the server refuses atomically, so its entire value was one round-trip and a nicer
exit code, against a permanent cost (a scan plus a flow read on every transition, an optional scope
on the happy path, a stale-cache hazard class, tenant-dependent exit codes) and one intolerable
failure mode: a false refusal of a legal move, with no flag to override it.

What changed in the code:

- `verifyTicketTransition` → `checkNoOpTransition`: the "already in state X" branch survives, the
  plan-based refusal and its cache-bypassed re-read do not.
- `findTicketStatePlanId` falls back to the lone `product: null` plan. Safe precisely because the
  output is advisory.
- `explainStateRejection` (the failure path) now appends the reachable set to the error `message`;
  `--dry-run` previews it on stderr.
- The double-PATCH is fixed independently and generally — see §14.3a.

**AC9 was rewritten** to match: an illegal transition must leave the ticket unchanged, exit
non-zero, and name the reachable states in the `--json` error `message`. That is observable, and it
is falsifiable on this org — the old wording was neither.

### §14.3a Settled negative: the double write cannot be fixed by classifying the error

The obvious repair for the retried PATCH was to stop treating a rejection as a stale id when it
looks like a refusal. **This is impossible on this API and should not be attempted again.** Ship
returns `100702` / `工单状态不存在` both for a state id that does not exist *and* for a state that
exists but is unreachable under the plan (`s7-smoke.md` F5). The vendor code is the same, the
message is the same, and the message is Chinese prose that is not a contract. No allowlist can
discriminate them.

The axis that does work is **id identity**, not error semantics: invalidate, re-resolve, and if
every resolved id came back identical, the retry would send a byte-identical body — so rethrow the
original error and send nothing. Implemented in `runWrite` (`cli/commands/common.ts`), which is the
only layer that can see both passes' resolutions; `withCacheInvalidation` learns nothing about
errors and only gains a `RetryWouldBeIdentical` signal to obey. This fixes pjm as well as ship.

**Invariant, now stated in `.trellis/spec/backend/error-handling.md`: the CLI never sends the same
mutating body twice in one invocation.**

### §14.4 §13.2b's `html_url` claim is wrong — short_id and identifier both resolve

`GET /v1/ship/{ideas,tickets}/{…}` accepts the 24-hex `id`, the 8-char `short_id` (the trailing
segment of a pasted `html_url`) **and** the human `identifier`, all returning `200`. So the "passed
through as an id and allowed to fail honestly" wording in §13.2b describes a failure that does not
happen. `core/metadata.ts`'s `IDENTIFIER_RE` also does not match dash-containing product prefixes
(`PD-YYHC-73`), which quietly routes such references down the direct-GET path — one request instead
of two, and it works. **Deliberately not "fixed"**: broadening the regex would trade a working
1-request path for a 2-request one. Both paths are exercised and correct.

### §14.5 §9/§10's "`--json` stays faithful" was too strong — claim fixed in S7b, code deferred

`api/parse.ts` normalises `null` **and `""`** to `undefined`, and `JSON.stringify` drops those keys.
So the wire's `plan_at: null`, `score: null`, `product.description: ""`, `ticket.solution: null`
simply vanish from `--json`. It is inherited pjm-wide behaviour, not something ship introduced.

**S7b fixes the claim, not the code.** §9 and §10 above, README and SKILL.md no longer promise
fidelity; SKILL.md instead tells the agent the rule it must code against: *an absent key means null
or empty; the CLI does not distinguish them — read keys defensively.*

The two halves should **not** be lumped together, as this section originally did:

- `null` → absent is **defensible**. Almost every consumer treats a null field and a missing field
  the same way, and dropping it keeps the output small.
- `""` → absent is a **genuine bug**. An empty string is a value a user deliberately set; erasing a
  cleared description is losing information, not tidying it.

The real fix — preserve `null` and `""`, reserve `undefined` for genuinely-missing — is a
**breaking output change**, wants its own commit, and is a 1.0 blocker: it is far cheaper now than
once anything parses this output. Recorded in README's follow-up list.

### §14.6 Exit 5 was unreachable for server-side not-founds — **fixed in S7b, two table rows**

Ship answers `400` + a vendor code for a missing record, never `404`: `100725` for an idea,
`100711` for a ticket (probed in S7b; tickets do *not* share the idea code). This is the pjm smoke's
finding F2, reconfirmed.

The repair is the documented maintenance path for `ERROR_CODE_OVERRIDES`
(`.trellis/spec/backend/error-handling.md`: extend the table given a recorded observation in
`research/`, cited in the comment), not a contract change — `core/errors.ts` and the exit table are
untouched. It also removes a real cross-module inconsistency: pjm already mapped `100317` (unknown
work item) to exit 5, so the identical mistake exited 5 on pjm and 7 on ship.

**Deliberately not mapped: `100719` / `100702`.** Under §13.2's advisory model those codes will
usually mean "that transition is not allowed", not "that state does not exist" — see §14.3a. Saying
`not_found` about a state the user can see in `meta ticket-states` would be worse than saying
nothing. They stay on exit 7.

### §14.7 Q1 — the ten metadata lookups are *not* behind a configuration scope

The `idea/*` and `ticket/*` product-scoped lookups declare the plain `pcp:read:ship:{idea,ticket}`
read scopes, unlike Testhub's equivalents; only `ticket_state_plans` / `ticket_state_flows` are
`pcp:read:ship:configuration`. So `pcp:read:ship:configuration` belongs in the docs as **optional,
improves `ticket transition`**, not as required. Sufficiency could not be tested: all scopes were
granted and the token response carries no `scope` field, so no 403 is reachable.
