# Design — Testhub 写叶子与验收收尾

Companion to `prd.md`. This document records only what is **new**. The module's established
architecture — layering, envelope handling, `searchPaginate`, the `--x` / `--x-id` convention,
the metadata cache, the error map — was designed in
`.trellis/tasks/archive/2026-08/08-02-testhub-module/design.md` and is unchanged. Read that first
if any of it is unfamiliar; do not re-derive it here.

## 1. Change shape

Smaller than it looks. The previous milestone already landed the types and parsers for plan types,
and the api-layer suite wrappers, so three of the four new leaves are assembly rather than design.

**New files:** none.

**Modified:**

| File | Change |
|---|---|
| `src/core/endpoints.ts` | one constant: `testhubLibraryPlanTypes(libraryId)` |
| `src/api/testhub.ts` | `planTypes()`, `createLibrary()`, `createPlan()`, and their input types |
| `src/core/metadata.ts` | `testhub-plan-type` MetaKind + `resolveTestPlanType`; the `runWrite` retry narrowing if it lands here |
| `src/cli/commands/common.ts` | date parsing helper; possibly the `runWrite` retry narrowing |
| `src/cli/commands/testhub.ts` | four leaves, their columns, `--help` text |
| `src/cli/program.ts` | untouched — the group already exists |
| `test/{testhub,testhubMetadata,testhubCommands,help}.test.ts` + snapshot | per the AC list |
| `skills/pingcode/SKILL.md`, `README.md` | new leaves and the date-format rule |

**Already present, reused as-is:** `TestPlanType` (`src/types/api.ts:703`), `parseTestPlanType`
(`src/api/parse.ts:747` — its docstring says "No wrapper in this slice (plan creation is out of
scope)", which this milestone makes obsolete and must be corrected), `TestLibrary`, `TestPlan`,
`parseTestLibrary`, `parseTestPlan`, `listSuites` / `iterateSuites` (`src/api/testhub.ts:134,149`).

> **Raised in S4, resolved in S6 — `listSuites` is deleted.** `meta suites` collects the whole tree
> via `iterateSuites`, because a suite's path is computed by walking `parent` refs and a paged tree
> therefore yields partial paths. That left `iterateSuites` with a production caller and `listSuites`
> with none. Rather than invent a caller to justify the wrapper, or add `--page` / `--page-size` to
> `meta suites` and degrade the leaf, S6 **removed `listSuites`** along with its test; the
> `?parent_id=root` pass-through it asserted moved onto `iterateSuites`. Both remaining callers — the
> leaf and the `testhub-suite` resolver — need every node, so a single-page variant only offered a way
> to get paths wrong. AC8's "no api-layer wrapper remains without a production caller" now holds
> without a waiver.

## 2. Endpoints

| Constant | Path | Method | Scope |
|---|---|---|---|
| `testhubLibraries` *(exists)* | `/v1/testhub/libraries` | **POST** (new use) | `pcp:write:testhub:library` |
| `testhubLibraryPlans(id)` *(exists)* | `/v1/testhub/libraries/{id}/plans` | **POST** (new use) | `pcp:write:testhub:testplan` |
| `testhubLibraryPlanTypes(id)` **new** | `/v1/testhub/libraries/{id}/plan_types` | GET | `pcp:read:testhub:testplan` |

Two of the three constants already exist because the read side used them. Note that plan types sit
under the **testplan** scope, not `configuration` — so `withConfigurationScope` must **not** wrap
`meta plan-types`. The same applies to `meta suites`, which is `pcp:read:testhub:library`.
Getting this wrong would attach a misleading scope hint to a 403.

## 3. Request bodies

```ts
export type CreateLibraryInput = {
  name: string;
  identifier: string;          // organisation-unique, server-enforced
  description?: string;
  visibility?: 'public' | 'private';   // API default: private
};

export type CreatePlanInput = {
  name: string;                // library-unique, server-enforced
  type_id: string;
  start_at: number;            // 10-digit unix seconds
  end_at: number;
  assignee_id: string;
};
```

`scope_type` / `scope_id` / `members[]` on library create are deliberately omitted: the CLI creates
organisation-scoped libraries, which is the API default, and member management is out of scope.
`project_id` / `sprint_id` / `version_id` on plan create are omitted per the PRD — a type that
requires them will be rejected by the server, and that rejection is what the user sees.

## 4. Date input (the decision most likely to be got wrong)

`--start` and `--end` each accept **either**:

- a calendar date `YYYY-MM-DD`, or
- a 10-digit unix seconds integer, passed through verbatim.

The two are distinguished by shape, so one flag suffices and no `-id` partner is needed — these are
values, not references.

**Boundary semantics, chosen deliberately:**

- `--start 2026-08-10` → **00:00:00 local** on that date.
- `--end 2026-08-31` → **23:59:59 local** on that date.

Rationale: a user writing a date range means the plan runs *through* the end date. Mapping both
ends to local midnight would silently shorten every plan by a day, and that error is invisible in a
smoke run — the CLI would echo back exactly what it sent. The asymmetry is surprising enough that
it must be stated in `--help`, in SKILL.md and in README, and pinned by a test that fixes the
timezone rather than relying on the runner's.

Local, not UTC, because `formatTimestamp` already renders timestamps in local time; a UTC-in /
local-out pair would make `plans get` disagree with the `plans create` that produced it.

Malformed input (`2026-8-1`, `08/31/2026`, a 13-digit millisecond value) is a `UsageError` at
exit 2 before any network call, naming the two accepted forms.

## 5. Metadata: `testhub-plan-type`

```ts
resolveTestPlanType(ctx, libraryId, input): Promise<ResolveResult>
```

Library-scoped, so the cache key carries the library id — identical in shape to the other five
library-scoped kinds (`testhub-suite`, `-case-state`, `-case-type`, `-run-status`, `-plan`). 24 h
TTL, `--no-cache` bypasses read and write, cleared by `auth login` / `logout`.

Loader: `loadList(ctx, ENDPOINTS.testhubLibraryPlanTypes(libraryId), {})` — the library id is in the
**path**, so the query stays empty, unlike the `?library_id=` config views that `libraryScoped(...)`
serves. It therefore cannot use that factory and gets its own resolver, exactly as `resolveTestPlan`
and `resolveTestSuite` do.

> **Corrected in S2.** An earlier revision of this section specified
> `listAllOf(ctx, …, parseTestPlanType)` as the loader. That cannot be used here: `listAllOf` and
> `parseTestPlanType` live in `src/api/parse.ts`, and `core/metadata.ts` may not import from `api/`
> — `test/layering.test.ts` enforces `core → neither`. The metadata layer has its own loader,
> `loadList`, which paginates through `core/paginate.ts` and yields `Candidate` records rather than
> typed resources; that is what every other resolver in the file uses. `listAllOf(…,
> parseTestPlanType)` **is** the right loader for the api-layer wrapper `planTypes()`, which is where
> S1 used it.

**Known limitation, carried forward, not solvable here:** a plan type carries no `kind`
discriminator (only `id` / `url` / `name` / `library`), so the CLI cannot tell the user which types
demand `sprint_id` or `version_id`. `meta plan-types` therefore lists names only, and `plans create`
surfaces the server's refusal for a type it cannot satisfy. Do not attempt to infer the kind from
the localized name — tenants rename these.

## 6. Command surface

Four leaves, taking the group from 51 to **55**.

| Leaf | Required | Optional |
|---|---|---|
| `testhub libraries create` | `--name`, `--identifier` | `--description`, `--visibility` |
| `testhub plans create` | `--library`/`--library-id`, `--name`, `--type`/`--type-id`, `--start`, `--end`, `--assignee`/`--assignee-id` | — |
| `testhub meta plan-types` | `--library`/`--library-id` | — |
| `testhub meta suites` | `--library`/`--library-id` | `--parent-id` (`'root'` = top level only) |

`meta suites` and `meta plan-types` both go through the existing `libraryScoped(...)` factory in
`registerTesthubMetaCommands`, passing **no** configuration-scope argument (see §2).

`--assignee` resolves through the existing `resolveUser`. It cannot default: an enterprise token
acts as the bot user, so "me" is not a meaningful assignee and an implicit default would silently
assign every plan to a bot.

> **Added in S4.** `plans create` also refuses an `--end` that precedes `--start`, as a `UsageError`
> at exit 2 before any request. This section omitted the case. The API's behaviour on an inverted
> range is **unverified** — it may well accept one silently — so the refusal is client-side and
> deliberately conservative; if S8 observes that the server rejects it with a usable code, this
> guard can be reconsidered.

Column sets follow the module's existing shape — `ID` / `NAME` first, with `refName` for
references and `timestampCell` for `start_at` / `end_at`. `meta suites` needs a `PATH` column
showing the computed `Parent / Child` form, since that is the spelling `--suite` accepts; note the
server's own `paths` field is the **parent chain excluding self** (established live in `f74ecd2`)
and must not be shown as if it were the full path.

## 7. Write safety

Both creates honour `--dry-run` through the existing transport gate. Neither needs `runWrite`'s
resolve/retry wrapper for its own sake — but `plans create` resolves two references
(`--type`, `--assignee`) against the 24 h cache, so a stale type id is possible and `runWrite`
applies for the same reason it does on `cases create`.

Server-side uniqueness (library `identifier`, plan `name` within a library) is **not** pre-checked.
A client-side existence probe would double the request count, race, and still be wrong under
concurrent writes. The server's rejection is surfaced verbatim, and any not-found-style code
observed live is a candidate for `ERROR_CODE_OVERRIDES` under the `ac22be4` evidence rule.

## 8. Narrowing the `runWrite` retry

Observed in S6: a bulk call rejected with code `100619` (one `run_id` in the request does not
exist) triggered `runWrite`'s cache-invalidation retry, even though the offending id came straight
from the user rather than from the metadata cache. It was harmless there only because the API
rejects the batch atomically, so the retry could not double-write.

`runWrite` (`src/cli/commands/common.ts:321`) already has the right guard in principle — the second
resolution pass is compared against the first and `RetryWouldBeIdentical` is thrown when the ids
match. The defect is that the retry is *attempted* at all for a rejection that names no cached
value. Two candidate fixes, to be chosen after reading `withCacheInvalidation`:

1. Skip the retry when the resolution set is empty or when no resolved id appears in the error's
   message/payload — precise, but message-shape-dependent, which the quality guidelines forbid.
2. Skip the retry for error codes known to be caller-input rejections rather than stale-id
   rejections — a small allow/deny list beside `ERROR_CODE_OVERRIDES`, driven by observed codes.

**Correction (S1–S3, 2026-08-02): (2) is not simply preferable, and may not be viable at all.** The
docstring on `RetryWouldBeIdentical` in `src/core/metadata.ts` already argues against a code-driven
list, with evidence: ship returns `100702` **both** for a genuinely unknown state id and for an
existing state the flow forbids. One code, two causes — a stale cache and a refused input — so no
allow/deny list keyed on the code can separate them. Whoever takes S7 must reconcile that argument
**before** choosing an approach, not mid-slice. If neither (1) nor (2) survives it, the honest
outcome is to leave the retry as it is and record why; the current behaviour is harmless because the
API rejects these batches atomically.

**This helper is shared with pjm and ship**, so whichever is chosen,
`test/shipCommands.test.ts` and `test/commands.test.ts` must pass unmodified, and the existing
stale-id retry path must keep its coverage. If neither option can be made safe without changing
shared behaviour, stop and report — a mis-scoped fix here is worse than the harmless extra request.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Date boundary off by one day, invisible in smoke | Timezone-fixed unit test; live run reads the plan back and compares against the GUI |
| `runWrite` narrowing regresses pjm/ship | Their suites must pass **unmodified**; if that requires editing them, the change is too broad |
| A plan type needing `sprint_id` is chosen and the failure is opaque | Surface the server message verbatim; document that the CLI cannot classify types |
| `identifier` collision on a retried live run | Suffix bootstrap identifiers with a timestamp, as the case titles already are |
| More undeletable tenant residue | Reuse the existing `CLI Smoke` library where possible; testhub exposes no library DELETE |
| `meta suites` given a configuration-scope hint it does not need | §2 — neither new meta leaf is wrapped by `withConfigurationScope` |

## 10. Rollback

Every slice is one commit and independently revertible. The two riskiest are separable on purpose:
the `runWrite` narrowing (§8) touches shared code and reverts alone; the date semantics (§4) are
confined to one helper plus its call sites. Reverting the whole milestone leaves the module exactly
as `c3af5cf` shipped it, since no existing behaviour is modified — only added.
