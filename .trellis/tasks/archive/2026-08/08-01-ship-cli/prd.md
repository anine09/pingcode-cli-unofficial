# PRD — Ship (product) command surface

## Goal

Extend the existing CLI with the PingCode **Ship** module (产品管理) so an agent can read and
write product requirements (需求 / *idea*) the same way it already handles pjm work items.

Two new command groups:

- `pingcode product` — list / get products
- `pingcode idea` — list / search / get / create / update ideas
- extend `pingcode meta` with the product-scoped lookups an idea write requires

## Context

- Research: `.trellis/tasks/archive/2026-08/08-01-ship-testhub-research/research/ship-api.md`
  (566 lines, ~101 ship endpoints). Referenced below as `S§`.
- The pjm surface already shipped: `.trellis/tasks/archive/2026-08/07-31-pingcode-cli-mvp/`
  (`design.md`, `research/pingcode-api.md`, `research/s8-smoke.md`).
- All shared machinery already exists and is module-agnostic: auth, transport, pagination,
  error mapping, metadata resolution + cache, redaction, `--json` purity, exit codes.
  This task adds `api/` wrappers, commands, metadata kinds and skill rules — nothing else.

## Decisions

| # | Decision |
|---|---|
| D1 | Scope is **product + idea**. Tickets, customers, external users, tags, suite writes and `POST /v1/relations` are out (see Non-Goals) — they are a separate, independently verifiable slice. |
| D2 | The default read path for ideas is **`POST /v1/ship/ideas/search`**, not `GET /v1/ship/ideas`: search is the only ship endpoint with real filtering (S§J). `GET /v1/ship/ideas` is not exposed at all. |
| D3 | `idea list` therefore needs a **second pagination shape** (`payload.page_index` / `payload.page_size` in the body). This is the `searchPaginate` that the pjm MVP deliberately dropped; it now has a real consumer. |
| D4 | Everything idea-scoped is resolved per **product**, not per project: `state_id`, `priority_id`, `suite_id`, `properties.*` and the member candidate set are all `?product_id=` scoped (S§J3). The existing metadata cache key already carries a parent id and a `kind`; reuse it, do not invent a parallel cache. |
| D5 | `--state <name>` on `idea update` requires nothing extra: unlike pjm work items, idea states are scoped to the **product**, which the resolving GET already tells us. No `--type` companion flag is needed. |
| D6 | There is **no idea state-flow endpoint** (S§J3). We can list valid states but cannot pre-validate a transition; a rejected state change must surface the server message plus the product's configured states, exactly like `work-item transition` does. |
| D7 | Ids are never shape-validated (three id shapes exist across this API). `--product`, `--state`, `--priority`, `--suite`, `--assignee` accept a name or an id; `--state-id`-style pass-throughs follow the pjm precedent where a name lookup is impossible. |
| D8 | New scopes required: `pcp:read:ship:product`, `pcp:read:ship:idea`, `pcp:write:ship:idea`, plus whatever ship configuration scope the metadata endpoints declare (confirm against S§J3 during implementation, and against the live API during smoke). |
| D9 | No new dependencies. The transport, error and output contracts are frozen; if ship needs behaviour they do not offer, that is a design change to raise, not a local workaround. |

## Requirements

- **R1** `src/api/ship.ts` — typed wrappers: `listProducts`, `getProduct`, `searchIdeas`,
  `getIdea`, `createIdea`, `updateIdea`, and the product-scoped metadata reads. Response
  parsing normalises the same way `api/parse.ts` already does (0/1 → boolean, singular vs
  plural drift) and does no formatting.
- **R2** `src/core/endpoints.ts` — the ship paths, so `core/metadata.ts` does not depend on `api/`.
- **R3** `src/core/paginate.ts` — a body-paginated variant for `POST …/search`, honouring the
  same `--page` / `--page-size` (max 100) / `--all` / `--limit` flags, the same echoed
  `page_index` mismatch guard, the same `id` de-duplication, and the same best-effort caveat.
- **R4** `src/core/metadata.ts` — resolvers for product, idea state, idea priority, idea suite
  and product member, cached under the existing `(apiBase, clientId, parentId, kind[, scope])`
  key with the existing 24 h TTL and `--no-cache` bypass. Ambiguous names → `UsageError`
  listing the candidates. Unknown-but-plausible ids pass through.
- **R5** `src/cli/commands/product.ts` — `list` (keywords, paging), `get <product>`.
- **R6** `src/cli/commands/idea.ts` — `list` (product, state, priority, assignee, suite,
  keywords, paging), `get <idea>`, `create` (`--product` + `--title` are the only required
  inputs, per S§J), `update` (only the fields passed are sent; empty patch → exit 2).
- **R7** `src/cli/commands/meta.ts` — add `idea-states`, `idea-priorities`, `idea-suites`,
  `idea-properties`, `product-members`, all `--product`-scoped, all emitting the existing
  `{values,count}` JSON shape.
- **R8** `skills/pingcode/SKILL.md` — the ship rules: resolve the product first, ids are
  product-scoped, `search` is the read path, update replaces rather than merges, no
  transition pre-validation, no sorting anywhere, and the new scopes to grant.
- **R9** README: the new command groups, the new scopes, and the ship-specific caveats.
- **R10** Tests in the existing vitest suite, zero network, injected `fetch`: body pagination,
  the new resolvers and their cache keys, command flag validation, `--help` snapshots, and
  the SKILL.md ↔ CLI command-path cross-check must keep passing.

## Acceptance criteria

- **AC1** `npm run typecheck && npm test` green; test count only increases from 260.
- **AC2** `npm run scan:secrets` and `npm run check:commits` stay green; CI stays green on push
  (verified with `gh run view`, not assumed).
- **AC3** `--json` stdout stays JSON-only for every new command; errors stay
  `{"error":{kind,message,code?,exit}}` on stderr; timestamps stay raw unix seconds.
- **AC4** `idea create --dry-run --json` prints `{"dry_run":true,"request":{…}}` on stdout and
  provably sends zero writes.
- **AC5** Live smoke against the real org: `product list`, `product get`, the five new `meta`
  commands, `idea list` (including a filtered query and a `--page-size 2` paging check that
  confirms body pagination is honoured), `idea get`, `idea create`, `idea update` including a
  state change, and a rejected state change showing the server message plus candidates.
- **AC6** Exit codes hold on the ship surface: bad input → 2, not found → 5, bad credentials → 3.
- **AC7** Any live finding that contradicts `ship-api.md` is written back into that research
  file (and `design.md`) rather than silently coded around.
- **AC8** Zero new dependencies, `package-lock.json` unchanged, no credentials or
  tenant-identifiable values in any file or commit message.

## Non-Goals

- Tickets (工单), customers (客户), external users, product tags, suite/member writes,
  product create/update — a later slice.
- `POST /v1/relations` (the ship ↔ pjm bridge). High value, but it is a third object model
  (`principal_type` addressing) and deserves its own task.
- Testhub. Already researched; separate task.
- Sorting (the API has none), bulk operations, deletion (ship exposes no idea DELETE).

## Open questions

- **Q1** Which exact scope do the `/v1/ship/idea/{states,priorities,suites,properties}`
  endpoints declare? Testhub's equivalents sit under a separate `configuration` scope; if
  ship does the same, the required scope list in R8/R9 grows. Settle from `ship-api.md`
  during implementation and confirm live during AC5.
- **Q2** Does `POST /v1/ship/ideas/search` echo `page_index` in its envelope the way the GET
  list endpoints do? The mismatch guard depends on it. Settle during AC5.

---

## Revision 2 — tickets are in scope

Approved by the user at the planning review gate: *"批准，但把 ticket 也加进来"*. This section
supersedes D1 and any earlier statement that excludes tickets. Everything else in this PRD stands.

### D10 — ticket (工单) joins product and idea

The command surface gains a third group, `pingcode ticket`, with the same shape as `pingcode idea`:
`list` (via search), `get`, `create`, `update`, `transition`. Tickets are a first-class Ship object
(S§K, 5 endpoints) and share the product-scoped metadata pattern, so the marginal cost over idea is
mostly command-layer surface, not new architecture.

### D11 — tickets CAN publish their legal transitions, ideas cannot — and the CLI only *explains* with them

Unlike idea, ticket exposes `GET /v1/ship/ticket_state_plans/{plan_id}/ticket_state_flows`
(S§K2/K3), and live that endpoint returns real, enforced edges. The CLI reads them to **explain** a
rejection — the error `message` names the states reachable from the current one — and to answer
`ticket transition --dry-run`. It does **not** refuse a transition locally.

*Amended in S7b after the live run (`research/s7-smoke.md` F5; design §13.2, §14.3).* Local
refusal was implemented, then removed: the server refuses atomically with no state change, so
pre-validation prevents no damage and saves only a round-trip, while a mis-identified state plan
would refuse a **legal** move with no escape hatch (`--state-id` cannot skip a plan check,
`--no-cache` cannot fix a wrong plan). Telling an agent "you cannot get there from here" when it
can is far more expensive than one wasted request. The one surviving local refusal is a no-op move
to the ticket's current state, which is tenant-independent and needs no API knowledge.

The asymmetry is still real and still belongs in SKILL.md, but it is now about explanation:
`idea update --state` can be told only which states exist, `ticket transition` can also be told
which are reachable.

### D12 — `type_id` is mandatory on ticket create

`POST /v1/ship/tickets` requires `type_id` (S§K), unlike idea which needs only `product_id` +
`title`. `ticket create` therefore requires `--type`, and `pingcode meta ticket-types --product <p>`
is a load-bearing lookup, not a convenience.

### R11 — ticket API wrappers

`src/api/ship.ts` gains `searchTickets`, `getTicket`, `createTicket`, `updateTicket`, and the ticket
metadata reads. `GET /v1/ship/tickets` stays unexposed for the same reason as ideas: only the search
endpoint filters.

### R12 — ticket metadata resolvers

Five new metadata kinds beyond the idea set: `ship-ticket-state`, `ship-ticket-priority`,
`ship-ticket-type`, `ship-ticket-channel`, `ship-ticket-property`. All are product-scoped
(`?product_id=`). `ticket-solution` and `ticket-tag` are out of MVP scope.

### R13 — ticket command group

`src/cli/commands/ticket.ts`, registered in `cli/program.ts`, reusing `cli/commands/common.ts`
exactly as idea does. `meta` gains the five ticket lookups.

### AC9 — ticket acceptance

- `ticket create --product <p> --type <t> --title '[CLI smoke] …'` creates a real ticket and prints
  its identifier; `--dry-run --json` before it sends zero writes.
- An illegal `ticket transition` leaves the ticket unchanged, exits non-zero, and the `--json`
  error `message` names the states reachable from the current one — proven live.
  *(Amended in S7b. The original wording demanded exit 2 from a local refusal. Two lessons: an AC
  must specify an **observable outcome**, not an exit code — the outcome that matters is "unchanged
  ticket, an error that says what to do instead", which the server delivers. And an AC must be
  falsifiable in **your** environment: the original was contingent on the org having a
  product-scoped state plan, which a default org does not, so it could not have been proven here
  no matter how correct the code was.)*
- `ticket update` with no fields exits 2, same as idea.
- SKILL.md states the idea-vs-ticket transition asymmetry.
