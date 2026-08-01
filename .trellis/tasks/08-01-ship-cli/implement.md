# Implementation plan — Ship (product) command surface

Read `prd.md` then `design.md` first. Slice order is a dependency order, not a suggestion.

## Ground rules

- Every slice ends with `npm run typecheck && npm test` green and one commit
  (Conventional Commits — `check:commits` enforces it in CI).
- Do not touch `auth.ts`, `http.ts`, `wire.ts`, `config.ts`, `errors.ts`, `redact.ts`,
  `output.ts`. If ship seems to need a change in any of them, **stop and report**.
- Zero new dependencies. `package-lock.json` must stay byte-identical.
- When the live API contradicts `ship-api.md`, update the research file and `design.md`
  in the same commit as the code — never code around it silently (AC7).
- Never commit credentials or tenant-identifiable values; `scan:secrets` runs in CI.

## Slices

### S1 — endpoints + types
`src/core/endpoints.ts`: the 11 ship paths from design §2.
`src/types/api.ts`: `ShipProduct`, `ShipIdea`, `ShipIdeaState`, `ShipIdeaPriority`,
`ShipIdeaSuite`, `ShipProductMember` — snake_case, index signature, optional fields optional.
No behaviour yet. Tests: none beyond typecheck.

### S2 — body pagination
Extract the shared page-walk out of `paginate()` and add `searchPaginate()` (design §3).
`paginate()`'s observable behaviour must not change — the existing `test/paginate.test.ts`
passes unmodified, or the refactor is wrong.
Tests (`test/searchPaginate.test.ts`): cursor lands in `payload`; 0-based index; cap 100 →
`UsageError`; `--all` de-dupes on `id`; short page stops; echoed mismatch warns and stops;
**missing** `page_index` in the envelope does *not* stop the walk (Q2 defence).
**Gate G1**: both pagination suites green, `paginate.test.ts` untouched.

### S3 — API wrappers
`src/api/ship.ts` per design §2, with parsing routed through `api/parse.ts`. Wrappers take
`Ctx`, build no URLs by hand outside `endpoints.ts`, and format nothing.
Tests (`test/ship.test.ts`): injected `fetch`; assert method, path, query and body for each
wrapper; assert 0/1 → boolean and singular/plural normalisation; assert nothing is logged.

### S4 — metadata resolvers
Add the five kinds from design §5 to `core/metadata.ts`, including the suite tree flattening
and its cross-branch ambiguity error.
Tests: cache key includes the product id and the kind; 24 h TTL; `--no-cache` bypasses;
ambiguous name lists candidates; unknown-shaped id passes through untouched; suite name
collision across branches errors with both paths.
**Gate G2**: no id shape is ever validated; `withCacheInvalidation` is used by every write path.

### S5 — commands
`src/cli/commands/product.ts`, `src/cli/commands/idea.ts`, plus the five new `meta`
subcommands; register all of it in `program.ts`. Reuse `cli/commands/common.ts` for paging
flags, table rendering, `runWrite` and timestamp parsing — do not duplicate that plumbing.
Empty `idea update` → `UsageError` exit 2 raised in the command layer.
`idea list` builds `payload.filter` per design §4 and rejects bad combinations before any
request is sent.
Tests: flag validation matrix, empty-patch exit 2, `--state`/`--state-id` mutual exclusion,
`--help` snapshots for every new command, and the existing SKILL.md ↔ CLI command-path
cross-check still passing (it will fail until S6 adds the docs — that is expected and is why
S6 is in the same push, not a separate one).
**Gate G3**: `--json` stdout stays JSON-only; dry-run under `--json` prints
`{"dry_run":true,"request":{…}}` on stdout and sends nothing.

### S6 — skill + README
`skills/pingcode/SKILL.md`: the ship rules (resolve product first, ids are product-scoped,
search is the read path, replace-not-merge, no transition pre-validation, no sorting, the new
scopes). `README.md`: new command groups, new scopes, ship caveats.
**Gate G4**: the SKILL.md ↔ CLI cross-check passes in both directions; every command path
mentioned exists, every new leaf is mentioned.

### S7 — live smoke (AC5, AC6)
Credentials already live in `~/.pingcode/config.json`. The app may need **new scopes** granted
in the PingCode console before this slice can run — check `auth status --check` against a ship
read first and report a 403 rather than guessing.

Smoke list, in order: `product list --json` → `product get <name>` → the five `meta` commands
→ `idea list --product <p> --json --page-size 2` **and** `--page 1 --page-size 2` (this is what
settles Q2 and proves body pagination is honoured) → a filtered `idea list --state <name>` →
`idea get` → `idea create --dry-run --json` (then confirm via a list that nothing was created)
→ a real `idea create` titled with a `[CLI smoke]` prefix and a timestamp → `idea update
--title` → `idea update --state <name>` → a deliberately invalid `--state-id` to see the
rejection path → not-found → 5, bad input → 2, bad credentials (flags only, no `--save`) → 3.

**Gate G5** — must be settled with evidence, not assumption:
1. Does `POST /v1/ship/ideas/search` echo `page_index`? (Q2)
2. Which scope do the `/v1/ship/idea/*` metadata endpoints actually require? (Q1)
3. Do the live idea response fields match `ship-api.md`, including `versions`-style
   singular/plural drift?

Ship exposes **no idea DELETE**, so the smoke idea cannot be removed — it stays, clearly
marked. Say so to the user before creating it.

### S8 — close out
Full-scope check: typecheck, tests, build, every `--help`, `scan:secrets`, `check:commits`.
Walk AC1–AC8 with evidence and state honestly what is only partially proven. Update
`.trellis/spec/` only if this slice established a *new* convention (it probably did not —
prefer no edit over a redundant one). Push, then verify CI with `gh run view` (AC2).

## Dependency graph

```
S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8
```

S5 and S6 must land in the same push (the cross-check test spans them). S7 cannot be
anticipated — AC5/AC6 are only provable against the real API.

## Rollback

One commit per slice; each is independently green, so `git revert` of a single slice is safe.
The only external side effect is the smoke idea from S7, which cannot be deleted and is
therefore marked in its title.

---

## Revision 2 — ticket slices

Approved at the review gate. Ticket work is folded into the existing slices rather than bolted on at
the end, because splitting `src/api/ship.ts` and `core/metadata.ts` across two passes would mean
touching the same files twice.

- **S1** also adds the ticket endpoint paths and ticket/state-flow types.
- **S3** also adds `searchTickets` / `getTicket` / `createTicket` / `updateTicket` and the five
  ticket metadata reads, plus the state-flow read.
- **S4** also adds the five ticket resolvers. Gate **G2** now additionally asserts that
  `ship-ticket-state-flow` is keyed by plan id, not by product.
- **S5** grows a third command file, `src/cli/commands/ticket.ts`, and the five `meta` ticket
  lookups. Implement `idea` first and get it green before starting `ticket` — ticket is the same
  shape, so a wrong abstraction found on idea is cheap and found on both is not.
- **S5b (new, after S5)** — ticket transition pre-validation per design §13.2. Gate **G3b**: an
  illegal transition fails locally with exit 2 and lists reachable states; a failed *flows lookup*
  warns and proceeds rather than blocking the write.
- **S6** SKILL.md must state the idea-vs-ticket transition asymmetry explicitly (G4 cross-check
  covers the new command paths).
- **S7** smoke sequence gains: `meta ticket-types`, `ticket create --dry-run --json` (zero writes),
  a real `ticket create` with `[CLI smoke]` in the title, a legal `ticket transition`, an illegal
  one (expect local exit 2), and an empty `ticket update` (expect exit 2). **G5** additionally must
  settle whether `ticket_state_flows` is reachable with the granted scopes and whether the ticket
  response exposes a usable state-plan reference.
- **S8** unchanged, plus AC9.

Dependency graph: S1 → S2 → S3 → S4 → S5 → S5b → S6 → S7 → S8.
