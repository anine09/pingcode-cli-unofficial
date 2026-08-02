# Implementation plan — Testhub (测试管理) command surface

Read `prd.md` then `design.md` first. Slice order is a dependency order, not a suggestion.

## Ground rules

- Every slice ends with `npm run typecheck && npm test` green and one commit
  (Conventional Commits — `check:commits` enforces it in CI).
- Do not touch `auth.ts`, `http.ts`, `wire.ts`, `config.ts`, `errors.ts`, `redact.ts`,
  `output.ts`. If testhub appears to need a change in any of them, **stop and report**.
- Zero new dependencies. `package-lock.json` must stay byte-identical.
- When the live API contradicts `testhub-api.md`, update the research file and `design.md`
  in the same commit as the code — never code around it silently (AC11).
- Never commit credentials or tenant-identifiable values; `scan:secrets` runs in CI.
- **Command-surface contract**: everything this task adds lives under the single
  `testhub` top-level group (see S4 for the canonical leaf inventory). Do not add
  leaves to the top-level `meta` group and do not modify `src/cli/commands/meta.ts`.
- **Ordering vs `08-02-cli-module-grouping`**: that sibling task regroups the existing
  commands and also rewrites `test/help.test.ts`, its snapshot, `SKILL.md` and
  `README.md`. The two tasks must run serially, grouping first. Consequence for the
  hardcoded group count in `help.test.ts`:
  - grouping lands first (expected): it leaves `auth` / `product` / `project` /
    `settings` = **4** groups; this task takes it to **5**.
  - if this task somehow runs first: today's **7** groups become **8**.
  Read the current assertion and increment it by one — do not paste a literal from
  this document.

## Slices

### S1 — endpoints + types
`src/core/endpoints.ts`: the 15 testhub paths from design §2, including the singular
area segments (`/v1/testhub/case/states`, `/v1/testhub/run/statuses`) and the
library-scoped variants.
`src/types/api.ts`: `TestLibrary`, `TestSuite`, `TestCase`, `TestCaseStep`, `TestPlan`,
`TestRun`, `TestCaseState`, `TestCaseType`, `TestCaseImportantLevel`, `TestRunStatus`,
`TestPlanType`, plus the two history item shapes and the `plan` reference divergence.
All fields optional/nullable per PRD R6. Index signature so unknown fields survive.
No behaviour yet. Tests: none beyond typecheck.

### S2 — API wrappers
`src/api/testhub.ts` per design §2, with parsing routed through `api/parse.ts`. Wrappers
take `Ctx`, build no URLs by hand outside `endpoints.ts`, and format nothing.
Key wrappers: `listLibraries/iterateLibraries/getLibrary`, `listSuites/iterateSuites`,
`searchCases/iterateCases/getCase`, `createCase`, `updateCase`,
`listPlans/iteratePlans/getPlan`, `searchRuns/iterateRuns/getRun`,
`patchRun`, `bulkRuns`, plus the four config lookups (`caseStates`, `caseTypes`,
`importantLevels`, `runStatuses`).
Tests (`test/testhub.test.ts`): injected `fetch`; assert method, path, query and body for
each wrapper; assert 0/1 → boolean and singular/plural normalisation; assert nothing is
logged.

### S3 — metadata resolvers
Add the eight kinds from design §5 to `core/metadata.ts`, including the suite tree
flattening and its cross-branch ambiguity error.
Tests (`test/testhubMetadata.test.ts`): cache key includes the `library_id` for
library-scoped kinds and omits it for `testhub-case-important-level`; 24 h TTL;
`--no-cache` bypasses; ambiguous name lists candidates; unknown-shaped id passes through
untouched; suite name collision across branches errors with both paths.
**Gate G1**: no id shape is ever validated; `withCacheInvalidation` is used by every
write path.

### S4 — commands
`src/cli/commands/testhub.ts` per design §1, registering **all five** noun groups
under one `testhub` command: `libraries`, `cases`, `plans`, `runs`, `meta`.
Every leaf lives in this one file; **`src/cli/commands/meta.ts` is not touched by this
task** — the testhub lookups are `testhub meta …`, not top-level `meta …`.
Reuse `cli/commands/common.ts` for paging flags, table rendering, `runWrite` and
timestamp parsing — do not duplicate that plumbing.

Leaf inventory (canonical paths, use these spellings everywhere):

```
testhub libraries list|get
testhub cases     list|get|create|update
testhub plans     list|get
testhub runs      list|patch|bulk
testhub meta      case-states|case-types|important-levels|run-statuses
```

`testhub cases create` requires `test_library_id` and `title`; `testhub cases update`
rejects empty patches as `UsageError` (exit 2) raised in the command layer.
`testhub runs patch` requires `status_id`; if the user does not pass `--status`, resolve
the current status from the run resource and re-emit it alongside the new fields.
`testhub runs patch` always sends `executor_id` — inherited from the existing run if not
given.
`testhub runs bulk` validates `inserts/updates/deletes` count ≤ 50 client-side.
`testhub meta` leaves are library-scoped except `important-levels` (org-level, no
`--library`).
Tests (`test/testhubCommands.test.ts`): flag validation matrix, empty-patch exit 2,
`--library`/`--library-id` mutual exclusion, `--help` snapshots for every new command,
`--json` stdout stays JSON-only, dry-run under `--json` prints `{"dry_run":true,"request":{…}}`
on stdout and sends nothing.
**Gate G2**: `layering.test.ts` passes; `testhub.test.ts` and `testhubMetadata.test.ts`
green.

### S5 — help/docs
No new command code. This slice only makes the docs and the help contract catch up with
S4.
`src/cli/program.ts`: register `registerTesthubCommands(program)`.
`test/help.test.ts`: update the hardcoded command-group count and the exhaustive
leaf-path list. **Target count depends on whether `08-02-cli-module-grouping` has landed
first** — see Ground rules; assert the number that matches the tree at implementation
time, do not hardcode a guess from this document.
`test/__snapshots__/help.test.ts.snap`: regenerate.
`skills/pingcode/SKILL.md`: add the testhub rules (resolve library first, ids are
library-scoped, search is the read path, replace-not-merge, mandatory `status_id` on
run patch, always-explicit `executor_id`, the configuration-scope trap, the new scopes).
`README.md`: new command group, new scopes, testhub caveats.
**Gate G3**: the SKILL.md ↔ CLI cross-check passes in both directions; every command
path mentioned exists, every new leaf is mentioned.

### S6 — live smoke (AC5, AC6)
Credentials already live in `~/.pingcode/config.json`. The app may need **new scopes**
granted in the PingCode console before this slice can run — check `auth status --check`
against a testhub read first and report a 403 rather than guessing.

Smoke list, in order: `testhub libraries list --json` → `testhub libraries get <name>` →
`testhub meta case-states --library <name>` → `testhub meta case-types --library <name>` →
`testhub meta important-levels` → `testhub meta run-statuses --library <name>` →
`testhub cases list --library <name> --json --page-size 2` and `--page 1 --page-size 2`
→ `testhub cases get <short_id>` → `testhub cases create --dry-run --json` (then confirm via
a list that nothing was created) → a real `testhub cases create` titled with a `[CLI smoke]`
prefix and a timestamp → `testhub cases update --title` → `testhub cases update --state <name>` →
a deliberately invalid `--state-id` to see the rejection path → not-found → 5, bad input
→ 2, bad credentials (flags only, no `--save`) → 3.

`testhub plans list --library <name> --json` → `testhub plans get <short_id>` →
`testhub runs list --plan <id> --json` → `testhub runs patch <id> --status <name> --remark
"smoke"` → `testhub runs patch <id> --status <name>` (no remark, verify executor inherited).

**Gate G4** — must be settled with evidence, not assumption:
1. Does `GET /v1/testhub/libraries` echo `page_index`/`page_size`?
2. Does `GET /v1/testhub/libraries/{id}/suites` support `?parent_id=root`?
3. Which scope do the `/v1/testhub/case/states` and `/v1/testhub/run/statuses`
   endpoints actually require? (Expect `configuration`.)
4. Does `run/statuses` name→slug mapping match the documented slugs
   (`not_start|pass|block|failure|skip`)?
5. Does `PATCH /runs/{id}` without `executor_id` set executor to creator (not blank)?
6. Does `POST /cases/bulk` reject `suite_id`/`type_id` as documented?

Smoke artifacts are marked with a `[CLI smoke]` prefix. Testhub exposes no library
DELETE, so smoke libraries can only be marked, not removed.

### S7 — close out
Full-scope check: typecheck, tests, build, every `--help`, `scan:secrets`, `check:commits`.
Walk AC1–AC12 with evidence and state honestly what is only partially proven. Update
`.trellis/spec/` only if this slice established a *new* convention (it probably did not —
prefer no edit over a redundant one). Push, then verify CI with `gh run view` (AC2).

## Dependency graph

```
S1 → S2 → S3 → S4 → S5 → S6 → S7
```

S4 and S5 must land in the same push (the cross-check test spans them). S6 cannot be
anticipated — AC5/AC6 are only provable against the real API.

## Rollback

One commit per slice; each is independently green, so `git revert` of a single slice is safe.
The only external side effect is the smoke data from S6, which is marked and cannot be
deleted (no library DELETE endpoint).
