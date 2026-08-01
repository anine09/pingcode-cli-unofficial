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
- `--json`: stdout is JSON only. Single page → the raw envelope shape
  `{page_index,page_size,total,values}`; `--all` → `{values,count,all:true}`; small config
  reads (`meta idea-*`, `meta product-members`) → `{values,count}`.
- Timestamps stay raw unix seconds under `--json`, localised only in human mode.
- Errors, dry-run plans, warnings: stderr in human mode; dry-run under `--json` goes to stdout
  as `{"dry_run":true,"request":{…}}`.

## 10. Types

Hand-written in `src/types/api.ts` for the ~11 endpoints above, snake_case with an index
signature so `--json` stays faithful and custom `properties` survive. Normalisation
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

### §13.2 Transition pre-validation (tickets only)

`ticket transition <ref> --state <name|id>`:

1. GET the ticket → learn `product_id`, current `state`, and the state plan reference.
2. Resolve the target state name against `ticket/states?product_id=` (id passes through untouched).
3. Read `ticket_state_flows` for the plan and check the current → target edge exists.
   - Not in the flow → `UsageError` (exit 2) naming the reachable states.
   - Flows unavailable (404/403/undocumented plan shape) → **do not block**: warn on stderr and let
     the server decide. Losing the ability to move a ticket because a lookup failed is worse than a
     server-side rejection.
4. PATCH `state_id`. A server rejection is printed verbatim plus the configured states.

If the ticket response does not actually carry a state-plan reference, that is a research
contradiction: record it in `research/ship-api.md` and fall back to step 3's warn-and-continue path.
Do not invent a plan id.

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
