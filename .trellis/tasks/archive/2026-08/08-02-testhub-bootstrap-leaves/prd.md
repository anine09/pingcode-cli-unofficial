# Testhub 写叶子：自举测试库与计划，并收尾验收缺口

## Goal

Make the testhub module able to create the assets its own acceptance run depends on, and close
the five acceptance criteria that the previous milestone had to land as **Partial**.

The previous milestone (`08-02-testhub-module`, archived) shipped a 15-endpoint read/write MVP,
but excluded every library and plan write. The consequence surfaced during its own S6 live smoke:
the tenant had no usable test library, so the smoke assets had to be bootstrapped with raw HTTP
outside the CLI. A CLI that cannot produce the preconditions for its own verification has a real
gap, not a cosmetic one.

This milestone adds the minimum write surface that removes the raw-HTTP dependency, and pays down
the named-but-unfixed debt from the S7 audit rather than letting it disperse.

## Background & Source of Truth

- **API research (authoritative, live-amended):**
  `.trellis/tasks/archive/2026-08/08-01-ship-testhub-research/research/testhub-api.md`
  — 65-endpoint inventory, §7 GOTCHAs, updated in `5c550e2` with S6 live findings.
- **Previous milestone artifacts:**
  `.trellis/tasks/archive/2026-08/08-02-testhub-module/{prd,design,implement}.md`
  — `design.md` §14 holds every S6 live-evidence conclusion; §14.6 lists the tenant residue.
- **Precedent for adding a create leaf:** `src/cli/commands/idea.ts` and `ticket.ts` (`create`
  with resolved references + `--set`), and `product.ts` for the `productScoped` lookup factory.
- **Why plan-create was wrongly excluded:** the previous PRD argued that `project_id` /
  `sprint_id` / `version_id` are conditionally required while `plan_type` carries no `kind`
  discriminator. That is true only for iteration and release plans. A plain plan
  (普通) needs none of the three, and S6 created one successfully. The reasoning for a hard
  subcase was generalised into an exclusion of the whole endpoint.

## Scope

### In scope — write leaves (the bootstrap path)

| Leaf | Endpoint | Required input |
|---|---|---|
| `testhub libraries create` | `POST /v1/testhub/libraries` [th#2] | `--name`, `--identifier` (org-unique) |
| `testhub plans create` | `POST /v1/testhub/libraries/{library_id}/plans` [th#47] | `--library`, `--name` (library-unique), `--type`, `--start`, `--end`, `--assignee` |
| `testhub meta plan-types` | `GET /v1/testhub/libraries/{library_id}/plan_types` [th#60] | `--library` |

Supporting work these require:

- A new `testhub-plan-type` MetaKind in `src/core/metadata.ts` with a **library-scoped** cache key,
  plus `resolveTestPlanType(ctx, libraryId, input)`. This kind was designed in the previous
  milestone and then deliberately dropped for having no consumer; it now has one.
- Date input parsing for `--start` / `--end`. The wire format is 10-digit unix **seconds**.
- `--assignee` resolves through the existing `resolveUser`. Note that an enterprise token creates
  resources as the bot user, so the assignee must be named explicitly — it cannot default to "me".

### In scope — acceptance-gap closeout (S7 audit findings)

| Ref | Gap | Intended resolution |
|---|---|---|
| AC5 | `listSuites` / `iterateSuites` have no production caller, and testhub has no suite discovery leaf while ship exposes `product meta idea-suites` | Add `testhub meta suites`, backed by the existing api-layer wrappers |
| AC10 | The `≤50` bulk cap is asserted only for `--remove-run`, though all three lists share the loop | Assert `--add-case` and `--set-status` too |
| AC8 | Search-under-`--dry-run` is proven only by inheritance from the shared `asReadContext` | Add a testhub-specific `cases list --dry-run` test |
| — | `runWrite`'s cache-invalidation retry fires on bulk code `100619`, where the rejected id came from the user, not from cache | Narrow the retry trigger. This helper is shared with pjm/ship, so behaviour there must be proven unchanged |

### Out of scope

- **Library / suite / plan update and delete**, and the four library-member endpoints. Creation is
  what unblocks verification; mutation of existing assets is not.
- **Iteration and release plan types** (`sprint_id` / `version_id`, and the `project_id` they make
  mandatory). The `plan_type` resource still carries no `kind` field, so the CLI cannot tell a user
  which of the three a given type demands. `plans create` covers the plain case and must **reject**
  a type whose creation the API refuses, surfacing the server message rather than guessing.
- **Suite creation.** Cases can be created without a suite; the tree is only needed for filtering.
- **`cases/bulk`, `PUT /runs/{id}`, the three history endpoints, `/v1/relations`.** Unchanged from
  the previous milestone's exclusions.
- **Configuration writes** (`case_properties`, states, types, importance levels). Organisation-wide
  blast radius; S6 abandoned even a probe for this reason.
- **PRD Q3/Q4 from the previous milestone** (custom-property value encoding, and whether
  `properties` merges or replaces on PATCH). Still blocked on tenant shape, not on effort: they need
  a tenant with a library-local property scheme. Record, do not attempt.
- **AC6's single-tenant limitation.** Cannot be closed from here; it is a property of the
  environment, not of the code.

## Requirements

**R1 — Layering and reuse.** `cli → {api, core}`, `api → core`, `core → neither`; `api` must not
import `output`. Do not modify `src/core/{auth,http,config,errors,redact}.ts` or `src/cli/output.ts`.
`src/core/wire.ts` may be extended **only** through `ERROR_CODE_OVERRIDES`, and only with a code
observed live and an evidence comment — the precedent set in `ac22be4`. If anything else appears to
require touching those files, stop and report rather than working around it.

**R2 — Command surface.** All new leaves live under the existing `testhub` group. No new top-level
group. Every leaf wrapped in `addGlobalOptions(..., { hidden: true })`. The canonical inventory
becomes **5 groups / 55 leaves** (51 + 4).

**R3 — Name→ID resolution.** Every new reference flag ships as a `--x` / `--x-id` pair, mutually
exclusive, rejected at exit 2 with zero requests. `testhub-plan-type` caches under the library id,
consistent with the other five library-scoped kinds.

**R4 — Date input.** `--start` / `--end` accept an unambiguous calendar date and convert to unix
seconds. The chosen format and its timezone behaviour must be stated in `--help` and pinned by a
test — a silent off-by-one-day is the failure mode here, and it is invisible in a smoke run.

**R5 — Write safety.** Every new write honours `--dry-run`. Required-flag and format validation
happens before any network call. Server-side uniqueness (library `identifier`, plan `name`) is not
pre-checked client-side; the server's rejection is surfaced verbatim.

**R6 — Self-bootstrap proof.** The live acceptance run must create its library and its plan
**through the built CLI**, then create a case and patch a run inside them. No raw HTTP anywhere in
the verification path. This is the criterion that distinguishes this milestone from a feature add.

**R7 — Docs and tests in the same push.** `test/help.test.ts` (group count, exhaustive leaf list,
prose rules), its snapshot, `skills/pingcode/SKILL.md` and `README.md` all move together. Read the
current assertion and extend it; never paste a literal from a planning document.

**R8 — No new dependencies.** Runtime stays `commander` + `picocolors`.

## Acceptance Criteria

- [ ] AC1 `npm run typecheck` passes.
- [ ] AC2 `npm test` is green, including `help.test.ts`, its snapshot, and `layering.test.ts`.
- [ ] AC3 `npm run build` passes and the built binary lists **5 groups / 55 leaves**.
- [ ] AC4 The three new endpoints have api-layer wrappers, parsers, and zero-network tests.
- [ ] AC5 `resolveTestPlanType` exists, caches under the library id, and has cache-key, TTL,
      ambiguity and `--no-cache` coverage matching the other testhub kinds.
- [ ] AC6 `--start` / `--end` parsing is pinned by tests, including a rejected malformed value and
      an explicit timezone assertion.
- [ ] AC7 All four new leaves honour `--dry-run`, asserted per leaf.
- [ ] AC8 `testhub meta suites` exists and is the production caller of `iterateSuites`; no api-layer
      wrapper in `src/api/testhub.ts` remains without one. (Amended in S9: this criterion originally
      named `listSuites`. A lookup needs the whole tree — a partial page yields partial paths — so
      the leaf calls `iterateSuites`, and S6 deleted `listSuites` rather than degrade the leaf to
      give it a caller. The second clause is what actually holds, and it holds.)
- [ ] AC9 The `≤50` bulk cap is asserted for all three lists.
- [ ] AC10 A testhub-specific test proves `cases list` still issues its search under `--dry-run`.
- [ ] AC11 `runWrite` no longer retries on a rejection that carries no cached input, and pjm/ship
      behaviour is proven unchanged (`shipCommands`, `commands` suites pass unmodified).
      (**Amended in S9 — the first clause was not met and could not be met; the second was.**
      S7 investigated four narrowings and all four failed: matching the error message is banned by
      `quality-guidelines.md`; reading the rejected field out of the payload is impossible because
      the vendor returns only `{code, message}` and widening that needs the forbidden `errors.ts`;
      a code allow/deny list is self-defeating because `100702` is both dual-cause and the very code
      the locked retry test at `shipCommands.test.ts:718` depends on; and warning only when
      re-resolution differs is blocked by `shipCommands.test.ts:736`, which asserts the warning on
      the identical-ids path. Separating "the server refused a cached id" from "the server refused
      what the user typed" requires knowing which field was refused, and the error body never says.
      `e91b27f` therefore left control flow untouched and fixed the false claim instead: the warning
      no longer asserts that a *cached* id was rejected, and the previously silent
      `RetryWouldBeIdentical` path now states that the cache was not the cause. No double-write ever
      occurred — that is asserted at unit level and was observed live with `--verbose`.
      **Residual cost, accepted knowingly:** on a caller-input rejection the CLI still performs one
      wasted re-resolution *and still invalidates a healthy cache entry*, so the next command
      re-fetches. That is a minor performance regression on an unrelated failure, not a correctness
      bug. Dated resolution in `design.md` §8; §8.4 records that the only sound fix is a vendor error
      body that names the rejected field.)
- [ ] AC12 A live run creates a library, a plan, a case and a run patch entirely through the CLI,
      and the evidence is recorded in the task's design notes.
- [ ] AC13 `skills/pingcode/SKILL.md` and `README.md` cover the new leaves; the SKILL↔CLI
      cross-check passes in both directions.
- [ ] AC14 Commits are conventional; `npm run check:commits` and `npm run scan:secrets` are clean.

## Notes

**Canonical command surface after this milestone:**

```
auth      login | status | logout
product   list | get · idea · ticket · meta
project   list | get · work-item · meta
testhub   libraries (list | get | create)
          cases     (list | get | create | update)
          plans     (list | get | create)
          runs      (list | patch | bulk)
          meta      (case-states | case-types | important-levels | run-statuses
                     | plan-types | suites)
settings  users
```

**Tenant residue to be aware of** (previous `design.md` §14.6): the `CLI Smoke` / `CLISMOKE`
library cannot be deleted — testhub exposes no library DELETE — and the organisation-level property
`CLIsmokeprop` returned 405 on delete and was to be removed by hand from the admin console. Any new
live run should reuse or clearly mark its own assets rather than adding more undeletable residue.

**Carried-forward known limitations**, unchanged and not re-litigated here: `--step` remains
all-or-nothing because a run step reports a status *slug* while the write needs a status *id*,
joined only by a renameable localized name; and `--set` keys have no discovery command because
testhub's case-properties lookup is out of scope.
