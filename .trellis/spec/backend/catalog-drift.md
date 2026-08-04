# Catalog Drift

> `src/core/catalog/catalog.generated.ts` is a snapshot of **someone else's documentation**. This is
> the runbook for when it stops matching them — who syncs, what gets committed, and how a conflict
> between the docs and the running API is judged.

---

## Overview

The 459-entry endpoint catalog is scraped from the vendor's apiDoc bundle
(`https://open.pingcode.com/api_data.js`) by `scripts/catalog-sync.ts`. There is no OpenAPI spec, no
changelog, and no sitemap upstream, so **drift is silent by construction**: the vendor can move a
path, tighten a scope or drop an endpoint and nothing announces it.

Two commands and one scheduled job are the whole mechanism:

| Command | Does |
|---|---|
| `npm run catalog:sync` | fetches the live bundle and **rewrites** the generated file + its two hashes |
| `npm run catalog:check` | fetches the live bundle, **writes nothing**, diffs it against the snapshot, exits 1 on any difference |
| `npm run catalog:check -- --from <file>` | the same diff against a saved bundle — offline, reproducible, and how a report in an issue is re-examined weeks later |

`catalog:check` reports five categories — **added / removed / method changed / path changed / scope
changed** — plus `otherChanged` for `module`, `group`, `paged`, `tokenType`, `title`, `deprecated`. It
*also* verifies the vendored file's own content hash, so a hand edit is reported as an integrity
failure rather than mistaken for upstream drift.

`.github/workflows/catalog-check.yml` runs `catalog:check` **weekly** (Mondays 03:17 UTC) and on
`workflow_dispatch`. It is deliberately **not** a step in `ci.yml`, and adding it there is a
regression, asserted by `test/workflows.test.ts`: the check depends on a third-party host and on
changes unrelated to whatever pull request is open, so as a gate one vendor edit would block every
merge and redden `main` (design D2.5). Drift therefore produces **one maintained issue** —
refreshed in place each week, commented on only when the finding actually changes, closed
automatically once upstream matches again — and a **green** job. Only a check that could not run at
all (docs host down, unparseable bundle, after one retry) fails the run.

**The CLI never fetches the docs at runtime.** Drift is never an outage; it is a maintenance signal.

---

## Who runs the sync, and how it is committed

**A maintainer, locally, deliberately — never CI.** The weekly job only ever reads; nothing in this
repository writes the generated file automatically. That is on purpose: a resync is a judgement about
what the vendor changed, and a bot cannot make it.

The commit rules, and why they are what they are:

- **The generated file lands in its own commit** (`chore(catalog): resync …`), separate from every
  hand-written change that follows from it. This is what makes the artifact revertable on its own: if
  the resync turns out to have been premature, `git revert` of that one commit restores the previous
  snapshot without touching the override rows, the `endpoints.ts` comments or any new command written
  against it. The `-diff linguist-generated=true` mark in `.gitattributes` keeps its 459 lines out of
  review diffs — what gets reviewed is the summary `catalog:sync` prints and the drift `catalog:check`
  reported, not the JSON.
- **Never hand-edit it.** The provenance header carries a `content sha256` over the body and
  `test/catalog.test.ts` recomputes it, so an edit fails the suite. Every correction belongs in the
  hand-written tables in `src/core/catalog/index.ts` (see below) — reviewable code, with a comment
  saying where the evidence came from.
- **One exception to "its own commit": the entry count.** `EXPECTED_ENTRIES` in
  `scripts/catalog-sync.ts`, the `toHaveLength(459)` and the two histograms in `test/catalog.test.ts`,
  the sweep in `test/apiCommand.test.ts`, the `api list` description and its help snapshot, and the
  agent docs all say **459**. If the count moved, those move *with* the generated file in the same
  commit — the generator's own error message says so — because the alternative is a commit that
  leaves `npm test` red, and every commit here is required to be independently green. Everything that
  is a *judgement* (an override row, a deprecation note, a new leaf) still goes in a later commit.
- Coordinate a count change with whoever owns the docs surface. It reaches `README.md`,
  `skills/pingcode/**` and `test/help/**`, which are frequently someone else's working tree.

---

## Live evidence outranks the catalog

**PRD R2: when the published docs and the running API disagree, the running API wins.** The catalog is
a machine view of a vendor's documentation build; `endpoints.ts`' comments, `ERROR_CODE_OVERRIDES` and
the override tables are records of what the server actually did. apiDoc does not get to overrule them.

The half that is easy to forget: **the losing side gets recorded, not dropped.** A disagreement that
is silently coded around is a fact the next person has to rediscover against production. Three worked
examples already in the tree, each resolved differently *because the cost of the docs being wrong was
different*:

1. **`source_branch_id` on `POST …/pull_requests` — docs say optional, API says required.**
   The catalog carries `required: false`; live, the call is refused with `100224 源分支是必填字段` at
   every status. Resolution: `--source-branch-id` is a `requiredOption` on `scm pr create`, and the
   disagreement is written into the header comment of `src/cli/commands/scm/pullRequest.ts` — which is
   also where it is recorded that this retired the neatest argument for excluding `PUT`. **No override
   row**, because a wrongly-*optional* flag costs nothing at the generic layer: the server refuses,
   and the CLI reports its refusal.
2. **`GET /v1/release/environments?name=` — docs say required, API says optional.**
   The mirror image, and much worse, because `missingRequired` refuses the call **before** anything is
   sent: without a correction `pingcode api GET /v1/release/environments` exits 2 with "missing
   required field(s): name (query)" and the endpoint is *unreachable* through the generic layer rather
   than merely awkward. Resolution: one row in `OPTIONAL_QUERY_OVERRIDES`
   (`src/core/catalog/index.ts`), carrying the date and tenant of the S1d smoke that observed the
   unfiltered list answer 200.
3. **`versions.stage_id` on `POST /v1/pjm/versions/bulk` — docs say required, API defaults it.**
   Recorded as an `endpoints.ts` comment and nothing else, because it *cannot* be expressed as a row:
   `missingRequired` only inspects top-level body keys and this one is nested, so nothing is ever
   refused. The entire cost is one misleading line in `api describe`, and a correction mechanism that
   does not exist is not worth inventing for it.

The rule those three share: **correct it where being wrong has a cost, record it where it does not,
and never touch the generated file.** A row added "for tidiness" is a claim of evidence; only add one
after observing the endpoint behave that way, and say where in the comment.

---

## A disappeared endpoint

`removed:` in the drift report means *the docs no longer list it*. It does **not** mean the endpoint is
gone, and it is not grounds for deleting a command.

1. **Do not sync, and do not delete the command.** Refined commands read `src/core/endpoints.ts`, not
   the catalog, so a removal upstream changes nothing at runtime — only `pingcode api`'s discovery and
   its pre-flight validation.
2. **Observe for one more cycle.** The tracking issue's digest makes this cheap: an unchanged finding
   next Monday refreshes the body silently, so a *persisting* removal is exactly what you see. A
   one-week blip in a vendor's docs build is a real event — the English bundle `api_data_en.js` is a
   stale 347-endpoint build with group names polluted by absolute build paths, which is how much these
   artifacts can be trusted.
3. **Ask the API, not the docs.** One live call decides it. Absence on this API is usually HTTP 400
   with a vendor code, not 404 (see `error-handling.md`), so read the code and record it.
4. **Only then** resync, and in a *separate* commit note the removal — with the date and the observed
   response — in the `endpoints.ts` comment for that family, and keep the command with a deprecation
   note in its help text. Deleting a working command is the failure mode this whole sequence exists to
   prevent: it is a breaking change to every script and agent using it, in exchange for a fact about a
   web page.

There is a tripwire if you skip step 1: `test/catalog.test.ts`'s *"finds every curated path in
endpoints.ts"* asserts that every path `ENDPOINTS` declares still matches a catalog entry, so syncing
away a path a refined leaf still uses turns the suite red. **Silencing that by deleting the path from
`endpoints.ts` is the mistake**, not the fix — it is the same red as a path *migration*, which is the
one signal this repository gets for free about a vendor that publishes no changelog.

> **Known gap, stated rather than papered over.** Upstream's own `deprecated` flag is carried on every
> entry, and `test/catalog.test.ts` asserts the deprecated set is empty — so the first genuinely
> deprecated endpoint fails the suite, loudly. But nothing surfaces it to a user: `warningsFor` in
> `src/cli/commands/api.ts` has no `deprecated` branch, and the field appears only in
> `api describe --json`. And because the generated file is hash-pinned, the flag **cannot** be set by
> hand for an endpoint that merely *disappeared*. So "mark it deprecated" here means a dated comment
> in `endpoints.ts` plus the tracking issue — not a field flip. Surfacing the flag in `api describe`
> is a worthwhile follow-up; it is not what this rule depends on.

---

## A newly appeared endpoint

`added:` is the cheap case, and it must stay cheap.

- **A resync makes it callable through `pingcode api` for free.** The generic executor is driven
  entirely by the catalog, so a new entry brings its path, method, parameter table, scope, token type
  and paging flavour with it. Nothing has to be written for it to be reachable.
- **The count tripwire fires.** A different entry total is a real surface change: `catalog:check`
  exits 1 with an explicit message, and the count constants listed above have to move in the same
  commit. That friction is deliberate — 459 is a number with one source of truth, echoed by two
  independent histograms.
- **A refined leaf is a separate, deliberate decision** — never a reflex, and never in the resync
  commit. It carries the same evidence bar every Phase S child met: a live happy path, the real error
  codes recorded in `research/` before any `ERROR_CODE_OVERRIDES` row, every filter flag proven to
  *actually filter* (a filter the server silently ignores is worse than no flag — see the
  `?stage_id=` note in `endpoints.ts`), `--yes` on any DELETE, and no `PUT` leaves at all (design
  D8.4). Absent that evidence, the generic layer is the right home and "it is reachable" is a
  complete answer.

---

## The override tables must be re-checked after every sync

Two hand-written tables in `src/core/catalog/index.ts` correct the generated data, and both can rot
silently when the snapshot moves under them:

| Table | Corrects | Why it exists |
|---|---|---|
| `PAGED_OVERRIDES` | `paged`, keyed `METHOD path` | upstream documents paging once, globally, and never per endpoint, so the generator guesses from path shape; 11 GETs that return a single object are corrected here |
| `OPTIONAL_QUERY_OVERRIDES` | `required` on named query params | the docs mark a parameter mandatory that the live API does not, which would make the endpoint unreachable through `pingcode api` |

There **is** a guard for dead rows: `test/catalog.test.ts` ("has no dead override row") and
`test/release.test.ts` ("has no dead correction row") fail if a key matches no catalog entry, so a
resync that moves or drops a path cannot leave an inert correction behind.

What that guard does **not** catch — check these by hand, and this is the actual work after a sync:

- **A row that still matches but is no longer needed.** If upstream fixes its docs, the row keeps
  matching and keeps asserting a correction that now corrects nothing, while its comment claims live
  evidence for a state of affairs that has changed.
- **A row that is no longer correct.** If upstream makes `name` genuinely required and the server now
  enforces it, the row causes the CLI to send a request the API will refuse. No test can tell; only a
  live call can.
- **A row that is missing.** When the docs and the generator agree, nothing is red — and the endpoint
  is simply unreachable through the generic layer. That is exactly how the `release/environments` row
  was found: an S1d smoke run, not a test.
- **Nested body fields**, which cannot be expressed as a row at all (`versions.stage_id`, above).

### The drift report does not diff parameter tables

Worth knowing before trusting a green weekly run: `diffCatalogs` compares ids, paths, methods, scopes
and six scalar fields. It does **not** compare `query` or `body`. So a vendor flipping a `required`
flag, renaming a field or adding one is reported as **"in sync"** — while `catalog:sync` would rewrite
the file and change its content hash.

The detector is manual, and belongs in any investigation of "the API refused a call the catalog says
should work": run `npm run catalog:sync`, read `git diff -- src/core/catalog/catalog.generated.ts`
(pass `--text` if `.gitattributes` has hidden it), then either land it under the rules above or
`git checkout` the file. Do this before starting a task that adds endpoints, too.

---

## Common Mistakes

- **Wiring `catalog:check` into `ci.yml`** — hands a third party the ability to redden `main`.
  `test/workflows.test.ts` fails on it.
- **Editing `catalog.generated.ts`** to fix a wrong `required` flag or to mark something deprecated.
  The content hash catches it; the override tables are the intended door.
- **Deleting a command because the docs stopped listing its endpoint**, without a live call and a
  second cycle of the weekly check.
- **Silencing "finds every curated path in endpoints.ts"** by removing the path instead of asking why
  the catalog no longer has it.
- **Syncing to clear the weekly issue.** The issue closes itself when upstream matches again; a resync
  done to make a notification go away lands a surface change nobody reviewed.
- **Adding an override row without an observation.** Every row is a claim about the live API and must
  name where it was seen.
- **Believing a green `catalog:check` means the parameter tables are unchanged.** It does not.
- **Reading the English bundle.** `api_data_en.js` is a stale 347-endpoint build; only the Chinese
  bundle is current.
