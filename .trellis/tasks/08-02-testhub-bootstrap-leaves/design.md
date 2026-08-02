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

## 11. S8 live-smoke results (2026-08-02)

Run against the live tenant with the built binary at `e76bdff` (`node dist/bin/pingcode.js`).
**No raw HTTP was used at any point** — no `curl`, no `python urllib` — which is the whole claim of
this milestone (PRD R6). Machine timezone **CST / UTC+8** (`date +%z` → `+0800`); every epoch value
below was cross-checked with GNU `date -d`, an implementation independent of the Node `Date` the
CLI uses.

### 11.1 Gate G4: the bootstrap completed unaided

| # | Step | Result |
|---|---|---|
| 1 | `libraries create` | ✅ `CLIB08021926` / `6a6f2980f8f6de4d46717c64` |
| 2 | `meta plan-types` | ✅ 3 types, auto-provisioned on the fresh library |
| 3 | `meta suites` | ✅ empty on a fresh library; exercised against `CLISMOKE` for a real tree |
| 4 | `plans create` | ✅ `3gyKsegN` / `6a6f29f911c48dd2a0423781`, type and assignee resolved **by name** |
| 5 | `plans get` read-back | ✅ dates exact — see 11.2 |
| 6 | `--dry-run` on both creates | ✅ zero rows created, verified by re-listing |
| 7 | `cases create` → `runs bulk --add-case` → `runs patch --status` | ✅ all three inside the new library |

`pcp:write:testhub:library` **is granted** — confirmed by the create succeeding, not by inspection.

### 11.2 The date decision, settled

The one thing a smoke run can silently pass while being wrong. `--start 2026-08-10 --end 2026-08-31`
in UTC+8:

| | sent | read back by `plans get` | independent expectation (`date -d`) |
|---|---|---|---|
| `start_at` | 1786291200 | 1786291200 | `2026-08-10 00:00:00` → 1786291200 ✅ |
| `end_at` | 1788191999 | 1788191999 | `2026-08-31 23:59:59` → 1788191999 ✅ |

The off-by-one-day trap would have produced `end_at` = 1788105600 (`2026-08-31 00:00:00`). The
observed value is **86 399 s later**, i.e. the end of that day, and the span is 22 days inclusive —
exactly what "10 through 31 August" means. Human mode renders `2026-08-31 23:59`, so `plans get`
agrees with the `plans create` that produced it. **§4's asymmetry is correct and survives the round
trip; the server stores what it is sent, with no truncation or timezone shift.**

### 11.3 Error paths observed

| Trigger | Exit | Vendor code | Message |
|---|---|---|---|
| library `--name` longer than 32 chars | 7 | `100019` | `'name'字符串长度不在[1,32]范围内` |
| duplicate library `--identifier` | 7 | `100639` | `'library'标识已经存在` |
| duplicate plan `--name` in a library | 7 | `100618` | `同名测试计划已存在` |
| bogus library id (5 endpoints) | **5** | `100600` | `测试库不存在或无权限访问` |
| bogus run id in `runs bulk --remove-run` | 7 | `100619` | `执行用例不存在` |
| bogus library id on `cases list` (search) | 7 | `100000`, **HTTP 500** | `内部服务错误` |
| `--end` before `--start` | 2 | — | client-side, no request |
| malformed dates (`2026-8-1`, `08/31/2026`, 13-digit ms) | 2 | — | client-side, no request |
| unknown plan-type / library / plan **name** | 2 | — | client-side, resolver miss |

**`ERROR_CODE_OVERRIDES` gained exactly one row: `100600` → `not_found`.** Evidence: observed on five
distinct endpoints with a bogus 24-hex library id (`GET /libraries/{id}/plans`, `/plan_types`,
`/suites`, `GET /case/states?library_id=`, `POST /cases`), same `1006xx` family and the same
`不存在或无权限访问` wording as `100601` / `100603`, which were already mapped. It exited 7 before and
exits 5 now.

`100619` was **left on exit 7 deliberately**, against the first instinct. The S8 probe did narrow
what it refers to — it fires with a *valid* library and plan id and only a bogus `deletes[]` entry,
so it is about the run, not the plan — but the previous milestone's reason for leaving it unmapped
is untouched by that: `runs/bulk` rejects the **whole batch**, so exit 5 would name one missing run
while implying the other entries were applied, which they were not. The new evidence is recorded on
the `ERROR_CODE_OVERRIDES` docstring beside the existing rationale rather than used to overturn it.
The neighbouring codes (`100649`, `100039`, `100043`, `100044`, `100008`, `100000`) likewise stay
unmapped — validation and batch rejections are not absence.

### 11.4 Findings that falsified documentation (all fixed in this commit)

1. **Library `name` is capped at 32 characters.** Undocumented anywhere — §3's `CreateLibraryInput`
   said only `name: string`. The first create attempt failed with `100019`. Recorded in SKILL.md
   beside the `--identifier` uniqueness rule. Not pre-checked client-side, consistent with §7's
   stance on server-enforced constraints: the rejection is precise and names the range.
2. **The tenant's plan types are `普通` / `迭代` / `发布` — not `普通测试` / `迭代测试` / `发布测试`.**
   The `plans create` examples in SKILL.md and README used `--type 普通测试`, which does not resolve
   on this tenant; both now use `普通`. Two source docstrings that contrasted "迭代测试 vs 发布测试"
   now speak of iteration vs release *types*, since the literal names are tenant-specific — which is
   exactly why §5 forbids inferring the kind from the name.
3. **`runs bulk --add-case` silently ignores a nonexistent case id**: `{"inserts":0,…}` at exit 0, no
   error. A bogus `--remove-run` id by contrast fails loudly (`100619`). Added as SKILL.md §4c rule
   16 — the existing "the API returns counts only, re-list the plan" notice is what saves the user
   here, and it is now load-bearing rather than decorative.

### 11.5 Other observations (no action taken)

- **Plan types are auto-provisioned.** A brand-new library already has all three; no configuration
  write is needed before `plans create`. This is what makes the bootstrap single-pass.
- **A fresh library has no modules**, so `meta suites` correctly returns `{"values":[],"count":0}`.
  Suite creation is out of PRD scope and there is no CLI path to it — the tree can only be read.
  Exercised against `CLISMOKE` instead, where `computed_path` renders `登录 / 短信验证码` while the
  server's `paths` holds `登录`, confirming the `f74ecd2` finding *and* the S4 path computation.
- **`POST /cases/search` answers HTTP 500** (`100000`) for a bogus `library.id` filter where a 400
  would be right. Server-side defect; the CLI surfaces it faithfully as exit 7. Not an override
  candidate.
- **The full plan resource carries both `status` (flat string) and `state` (object).** The previous
  milestone's design said the object form was exclusive to the full resource and the string form to
  embedded refs; live, the full resource has both. Additive, and the parser reads `state`, so no
  defect — recorded so the claim is not repeated as an exclusion.
- **Run statuses are exactly the documented five** (未测 / 通过 / 失败 / 受阻 / 跳过) with `is_system`
  absent, and `runs patch --status 通过` round-trips to `status: "pass"`. The localized-name ↔ slug
  join holds on a fresh library.
- **`created_by` on everything the CLI writes is the bot user `Ping`** (`0111…0000`). This is the
  concrete justification for `--assignee` having no default (§6): "me" is the bot.
- **`runWrite`'s retry fired on the duplicate-plan-name rejection** (`100618`) — a caller-input
  error with no cached id involved, the same defect §8 records for `100619`. Verified with
  `--verbose` that **only one POST was sent**: `RetryWouldBeIdentical` suppressed the second, so the
  cost is one wasted re-resolution plus a misleading "the server rejected an id that came from the
  metadata cache" warning. Second live instance; evidence for S7.

### 11.6 Residue left in the tenant

Testhub still exposes **no library DELETE and no library PATCH**, so everything below is permanent
and unrenameable.

| Kind | Identifier / id | Note |
|---|---|---|
| Library | `CLIB08021926` · `6a6f2980f8f6de4d46717c64` | name `[CLI] bootstrap 08021926`. **Undeletable.** |
| Plan | `3gyKsegN` · `6a6f29f911c48dd2a0423781` | `bootstrap plan 08021926`, inside the above |
| Case | `CLIB08021926-1` · `6a6f2ace11c48dd2a0423784` | `[CLI smoke] bootstrap case 08021926` |
| Run | `buEcG-DG` · `6a6f2ae18359e0328fce7ecc` | patched to 通过, remark `[CLI smoke] bootstrap patch` |

Carried over from the previous milestone and still present: library `CLI Smoke` / `CLISMOKE`
(`6a6ef8d811c48dd2a042367d`) and the org-level property `CLIsmokeprop`. This run added **one**
library rather than reusing `CLISMOKE`, because proving `libraries create` against a *fresh* library
is the point of the slice — a fresh library is also what proved plan types are auto-provisioned.
The identifier is timestamped (`CLIB<MMDDHHMM>`), so a repeat run will not collide.

No credentials, tokens or tenant-identifying values are recorded here or in any committed file.
