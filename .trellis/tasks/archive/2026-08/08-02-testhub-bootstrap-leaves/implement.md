# Implement — Testhub 写叶子与验收收尾

Companion to `prd.md` and `design.md`. Read both before starting a slice; this file only sequences
the work. The module's existing architecture lives in
`.trellis/tasks/archive/2026-08/08-02-testhub-module/design.md`.

## Ground rules

- Each slice ends with `npm run typecheck` and `npm test` green, then **one** Conventional Commit.
  Do not batch slices into a single commit; do not leave a slice red.
- **Do not modify** `src/core/{auth,http,config,errors,redact}.ts` or `src/cli/output.ts`.
  `src/core/wire.ts` may be touched **only** to add an `ERROR_CODE_OVERRIDES` row backed by a live
  observation, with the evidence in a comment — the `ac22be4` rule. If a slice seems to need any
  other change there, stop and report.
- **Zero new dependencies.** Runtime stays `commander` + `picocolors`. `package.json` and
  `package-lock.json` must be byte-identical at the end.
- `src/cli/commands/common.ts` and `src/core/metadata.ts` are **shared with pjm and ship**. Any edit
  there must leave `test/commands.test.ts`, `test/shipCommands.test.ts`, `test/metadata.test.ts` and
  `test/shipMetadata.test.ts` passing **unmodified**. If a change requires editing them, it is too
  broad — stop and report.
- **Command-surface contract:** everything new lands inside the existing `testhub` group. Do not add
  leaves to `product`, `project` or `settings`, and do not add a sixth top-level group. The group
  count stays **5**; the leaf count goes 51 → **55**.
- When a live observation contradicts `design.md` or the research report, update **both** in the
  same commit as the code that acts on it. Never leave a falsified claim standing.
- Never commit credentials, tokens, or a raw tenant response containing them. `~/.pingcode/` is
  outside the repo and stays there.
- Read the current assertion in `test/help.test.ts` and extend it. Do not paste the literals from
  this document into a test.

## Slices

### S1 — endpoints and the api layer

Add `testhubLibraryPlanTypes(libraryId)` to `src/core/endpoints.ts`. In `src/api/testhub.ts` add
`planTypes(ctx, libraryId)`, `createLibrary(ctx, input)`, `createPlan(ctx, libraryId, input)` and the
input types from design §3. Correct the now-obsolete docstring on `parseTestPlanType`
(`src/api/parse.ts:747`), which claims plan creation is out of scope.

`TestPlanType`, `TestLibrary`, `TestPlan` and their parsers already exist — reuse, do not redefine.

Tests in `test/testhub.test.ts`: request shape for both creates (method, path, body keys), the
plan-types list, and that optional fields are omitted rather than sent as `undefined`.

No `src/cli/**` changes in this slice.

### S2 — the plan-type resolver · **Gate G1**

Add the `testhub-plan-type` MetaKind and `resolveTestPlanType(ctx, libraryId, input)` to
`src/core/metadata.ts`, per design §5. Library-scoped cache key, same shape as the other five
library-scoped kinds.

Tests in `test/testhubMetadata.test.ts`: exact-name hit, id passthrough, not-found message naming
`testhub meta plan-types`, ambiguity, cache key includes the library id, `--no-cache` bypass, and the
`withCacheInvalidation` retry loop.

**G1:** the six existing resolvers plus this one all resolve and cache; `metadata.test.ts` and
`shipMetadata.test.ts` pass unmodified.

### S3 — date input

Add the `--start` / `--end` parsing helper to `src/cli/commands/common.ts` per design §4:
`YYYY-MM-DD` or a 10-digit unix seconds integer, `--start` to local 00:00:00 and `--end` to local
23:59:59, anything else a `UsageError` at exit 2.

It has no production caller until S4. That is intentional and mirrors how the api wrappers preceded
the commands last milestone — the helper lands with its own tests so the boundary semantics are
pinned before anything depends on them.

Tests: **fix the timezone explicitly** rather than trusting the runner's. Cover both accepted forms,
the start/end asymmetry, and the rejected forms named in design §4 (`2026-8-1`, `08/31/2026`, a
13-digit millisecond value).

### S4 — the four leaves · **Gate G2**

In `src/cli/commands/testhub.ts` add, per design §6:

```
testhub libraries create
testhub plans create
testhub meta plan-types
testhub meta suites
```

Both meta leaves go through the existing `libraryScoped(...)` factory **without** the
configuration-scope argument (design §2 — plan types are `testplan` scope, suites are `library`
scope; a misplaced hint is worse than none). Every leaf wrapped in
`addGlobalOptions(..., { hidden: true })`. `--dry-run` honoured on both creates. `plans create` uses
`runWrite` because it resolves two cached references.

`meta suites` shows the computed `Parent / Child` path, not the server's `paths` field — that field
is the parent chain excluding self.

Tests in `test/testhubCommands.test.ts`: the `--x` / `--x-id` exclusion matrix extended to the new
pairs, required-flag refusals at exit 2 with **zero** requests, `--dry-run` on both creates,
`--json` stdout purity, and `meta suites --parent-id root`.

`src/cli/program.ts` stays untouched, so `help.test.ts` and its snapshot remain green through this
slice.

**G2:** all four leaves work against `createFakeFetch`; no leaf reachable without its required flags.

### S5 — help contract and docs · **Gate G3**

Extend `test/help.test.ts` to **55** leaves (still 5 groups, still 10 subgroups) and regenerate the
snapshot. Add prose assertions for the two rules `--help` cannot carry: the `--start`/`--end` date
forms with the end-of-day asymmetry, and that `--assignee` has no default because an enterprise
token acts as a bot.

Update `skills/pingcode/SKILL.md` and `README.md`: the four leaves, the date rule, and the fact that
the CLI can now create its own library and plan. Correct anywhere either document says testhub
cannot create libraries or plans.

**G3:** verify both directions against the **built** binary, not the in-process tree — every
`pingcode …` path mentioned in SKILL.md resolves, and all four new leaves appear verbatim.

### S6 — closing the verification gaps

Almost entirely tests, plus **one production deletion** (see AC5 below) — an earlier revision of this
line said "no production code", which the deletion contradicts. Three additions called out by the S7
audit:

- **AC8:** a testhub-specific test that a search still executes under `--dry-run`
  (`cases list --dry-run` / `runs list --dry-run`). Today this is only inherited from
  `searchPaginate.test.ts`'s coverage of the shared `asReadContext`.
- **AC10:** extend the bulk >50 assertions to `--add-case` and `--set-status`, which share the cap
  loop with `--remove-run` but have no individual coverage.
- **AC5:** `meta suites` (landed in S4) is the production caller of `iterateSuites`. `listSuites` has
  none and is **deleted here**, with its `?parent_id=root` assertion moved onto `iterateSuites` —
  keeping it would imply a paged suite fetch that no caller wants and that would produce partial
  paths. This is the production change this slice makes.

> **Note on AC numbering:** the three bullets above use the numbers from the *previous* milestone's
> audit. In this task's `prd.md` they are AC8 (suites/`listSuites`), AC9 (bulk cap) and AC10
> (dry-run search). The substance is the same; when closing out in S9, walk `prd.md`'s list, not
> this one.
>
> One wording snag for S9: `prd.md` AC8 reads "`testhub meta suites` … is the production caller of
> `listSuites`". After the deletion above the caller is **`iterateSuites`**; the criterion's second
> clause ("no api-layer wrapper … remains without one") is what actually holds. Left unedited here
> because `prd.md` owns the requirements — read AC8 with that substitution, or amend it in S9.

### S7 — narrowing the `runWrite` retry

Per design §8. Read `withCacheInvalidation` first, then choose the code-driven option (2) unless it
proves unworkable. Add a test that a caller-input rejection does **not** trigger a second resolution
pass, while keeping the existing stale-id retry coverage intact.

`test/commands.test.ts` and `test/shipCommands.test.ts` must pass **unmodified**. If they cannot,
**abandon this slice and report** — the current behaviour is harmless, and a mis-scoped fix to shared
code is worse than an extra request.

This slice is independently revertible and independently abandonable. It must not block S8.

### S8 — live bootstrap smoke · **Gate G4**

Run against the live tenant using **only the built CLI**. No `curl`, no `python urllib` — the point
of this milestone is that the CLI can produce its own fixtures. If a step needs raw HTTP, that is a
finding, not a workaround.

Sequence:

1. `testhub libraries create --name "CLI Bootstrap <ts>" --identifier "CLIB<ts>" --json --dry-run`,
   then for real.
2. `testhub meta plan-types --library "CLI Bootstrap <ts>" --json` — record every type's id and name.
3. `testhub plans create --library … --name "Bootstrap Plan <ts>" --type <name> --start <date> --end <date> --assignee <name> --json --dry-run`, then for real.
4. `testhub plans get <short_id> --library … --json` — **compare `start_at` / `end_at` against what
   was asked for**, and confirm the end date is the end of that day, not its start. This is the check
   the whole date decision rests on.
5. `testhub meta suites --library … --json`, and again with `--parent-id root`.
6. Prove the bootstrap is complete: from the new library and plan alone, run
   `testhub cases create`, `testhub runs bulk --add-case`, `testhub runs patch --status`.
7. Error paths: a duplicate `--identifier`, a duplicate plan `--name`, a malformed `--start`, a plan
   type that demands `sprint_id`. Record the codes; add an `ERROR_CODE_OVERRIDES` row only where the
   evidence is unambiguous.

Record every finding in `design.md` with the date and the raw response shape. Timestamp-suffix all
created names so a retried run does not collide. Note the residue in `design.md` — testhub still has
no library DELETE.

**G4:** the plan's dates round-trip correctly, and steps 1–6 complete with no raw HTTP.

### S9 — close out

Full gate: `typecheck`, `test`, `build`, `scan:secrets`, `check:commits`, plus a recursive `--help`
walk of the built binary confirming 5 groups / 55 leaves / 10 subgroups. Walk AC1–AC14 and mark each
Full or Partial with a reason — an honest Partial is worth more than an optimistic Full. Push, then
`gh run list` to confirm CI. Then archive.

## Dependencies

```
S1 → S2 → S3 → S4 → S5 → S6 → S8 → S9
                      S7 ──────┘   (separable; abandonable; must not block S8)
```

S4 and S5 must land in the same push: S4 leaves the group unregistered-in-help and S5 fixes the
count, so shipping S4 alone would leave `help.test.ts` describing a surface that no longer matches.
