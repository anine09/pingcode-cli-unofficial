# Design — Testhub (测试管理) command surface

Reads: `prd.md` (R1–R8, AC1–AC12). API facts cited as `[th#N]` refer to
`.trellis/tasks/archive/2026-08/08-01-ship-testhub-research/research/testhub-api.md`.
Existing architecture cited as `M§x` refers to the pjm MVP design at
`.trellis/tasks/archive/2026-08/07-31-pingcode-cli-mvp/design.md`.
Ship precedent: `.trellis/tasks/archive/2026-08/08-01-ship-cli/design.md`.

## 1. Shape of the change

Additive only. No file in `src/core/` changes behaviour except additions:
`endpoints.ts` gains testhub paths, `metadata.ts` gains testhub resolver kinds.
Nothing in `auth.ts`, `http.ts`, `wire.ts`, `config.ts`, `errors.ts`, `redact.ts`
or `cli/output.ts` is touched — if testhub appears to need a change there, stop and
raise it.

New files:

```
src/api/testhub.ts           typed wrappers + response parsing
src/cli/commands/testhub.ts  unified group: libraries / cases / plans / runs / meta
test/testhub.test.ts         api wrappers + parsing
test/testhubMetadata.test.ts cache keys / TTL / name ambiguity
test/testhubCommands.test.ts command-layer tests
```

Modified: `src/core/endpoints.ts`, `src/types/api.ts`, `src/core/metadata.ts`,
`src/cli/program.ts`, `skills/pingcode/SKILL.md`, `README.md`, `test/help.test.ts`,
`test/__snapshots__/help.test.ts.snap`.

`src/cli/commands/meta.ts` **no longer exists** — `08-02-cli-module-grouping` (commit
`80f9c10`) split it into `product meta` / `project meta` / `settings users`. The testhub
lookups follow that same shape: a `meta` subgroup **inside** the `testhub` group, living
in the new file. Do not add testhub leaves to `product.ts`, `project.ts` or
`settings.ts`.
Canonical leaf inventory:

```
testhub libraries list|get
testhub cases     list|get|create|update
testhub plans     list|get
testhub runs      list|patch|bulk
testhub meta      case-states|case-types|important-levels|run-statuses
```

Layering is unchanged and still enforced by `test/layering.test.ts`:
`cli → {api, core}`, `api → core`, `core` imports nothing from either.

## 2. Endpoints used

| Purpose | Call |
|---|---|
| library list / name→id | `GET /v1/testhub/libraries` (`keywords`, paging) |
| library detail | `GET /v1/testhub/libraries/{library_id}` |
| suite tree | `GET /v1/testhub/libraries/{library_id}/suites` (`?parent_id=root` for top-level) |
| case read (primary) | `POST /v1/testhub/cases/search` |
| case detail | `GET /v1/testhub/cases/{case_id}` (accepts `short_id`) |
| case create | `POST /v1/testhub/cases` — required: `test_library_id`, `title` |
| case update | `PATCH /v1/testhub/cases/{case_id}` |
| plan list | `GET /v1/testhub/libraries/{library_id}/plans` (`?name`, date filters) |
| plan detail | `GET /v1/testhub/libraries/{library_id}/plans/{plan_id}` (accepts `short_id`) |
| run read (primary) | `POST /v1/testhub/runs/search` |
| run update | `PATCH /v1/testhub/runs/{run_id}` |
| plan runs bulk | `POST /v1/testhub/libraries/{library_id}/plans/{plan_id}/runs/bulk` |
| case states (library-scoped) | `GET /v1/testhub/case/states?library_id=` — scope `configuration` |
| case types (library-scoped) | `GET /v1/testhub/case/types?library_id=` |
| case important levels | `GET /v1/testhub/case_important_levels` — org-scoped, no library_id |
| run statuses (library-scoped) | `GET /v1/testhub/run/statuses?library_id=` — scope `configuration` |

That is **16** endpoints: the PRD's 15-endpoint MVP plus `GET /libraries/{library_id}`,
which the MVP list omits but every `libraries get` invocation needs.

> **Corrected in S1.** An earlier revision of this table also listed
> `GET /v1/testhub/libraries/{library_id}/members`. That endpoint is **not** in the
> PRD's in-scope list — `Out of scope` excludes the member endpoints — and no
> command needs it, since testhub has no `--assignee`-style flag resolved against
> library membership in this milestone (`maintenance_id` / `executor_id` resolve
> against the org directory). No endpoint constant and no wrapper were added for it.

`GET /v1/testhub/cases` and `GET /v1/testhub/runs` are deliberately unreachable from
the CLI (PRD scope). The search endpoints are the single read path for both resources.

## 3. Body pagination (`searchPaginate`)

`POST …/search` takes `{mode, payload:{filter, keywords, page_size, page_index, …}}` and
returns the same envelope as the GET lists. `searchPaginate` in `core/paginate.ts` already
handles this — testhub reuses it unchanged (M§5.1).

Shared contract:
- 0-based `page_index`, default 30, hard cap 100 (client-side `UsageError` above that).
- `--all` walks pages, de-duplicates on `id`, stops on a short page, respects `--limit`
  (default 500).
- If the envelope echoes a `page_index` different from the one requested, warn on stderr
  and stop iterating. Missing `page_index` is treated as "no signal" and the walk continues
  (Q2 defence, already in `paginate.ts`).
- Documented as best-effort, no sorting.

## 4. Filters

`case list` and `run list` map flags to `payload.filter` using the documented operator set
([th#20], [th#51]): one operator per field, no `$and`/`$or`, reference fields addressed as
`state.id`, `type.id`, `important_level.id`, `assignee.id`, custom fields as
`properties.{key}`. `keywords` is a sibling of `filter`, not a filter entry.

Notable filter limitations:
- `runs/search` **cannot** filter by `library.id` — it is in the exclusion list ([th#51]).
  Users must filter by `plan.id` instead.
- `GET /cases` has no `library_id` requirement ([th#22]) — unfiltered it scans all visible
  libraries, which is dangerous under the 200/min rate limit. The CLI never exposes the
  unfiltered simple list.

Unsupported flag combinations fail as `UsageError` (exit 2) before any request goes out.

## 5. Metadata resolution

Reuse `core/metadata.ts` wholesale. New kinds:

```ts
| 'testhub-library'
| 'testhub-suite'
| 'testhub-case-state'
| 'testhub-case-type'
| 'testhub-case-important-level'
| 'testhub-run-status'
| 'testhub-plan'
```

**Library-scoped kinds** (cache key includes `library_id`):
`testhub-suite`, `testhub-case-state`, `testhub-case-type`, `testhub-run-status`,
`testhub-plan`.

**Unparented kinds** (no `library_id` in the cache key):
- `testhub-library` — the **bootstrap** hop. It is what *produces* a `library_id`, so by
  construction it cannot be scoped by one.
- `testhub-case-important-level` — genuinely **org-level**: the one lookup in the module
  with no `?library_id=` variant anywhere ([th#40]). Keying it per library would shard one
  identical list into N cache entries and imply a scoping the API does not have.

> **Corrected in S3.** Two fixes to the lists above.
> 1. `'testhub-plan-type'` is **dropped**. It has no consumer: plan creation is outside the
>    PRD's 15-endpoint MVP, S2 therefore ships no `planTypes` wrapper, and the S4 leaf
>    inventory has no `plans create`. Seven kinds, not eight. (`TestPlanType` remains as a
>    *type* in `types/api.ts`, where it records that the resource carries no kind
>    discriminator — see §11.)
> 2. `'testhub-library'` was listed as library-scoped, which cannot be true of the resolver
>    that produces the library id. It is unparented, alongside `ship-product`.

Rules carried over unchanged from ship §5 / M§6:

- Name lookup is `keywords`-then-exact-name, case-insensitive, must be unique; ambiguity
  is a `UsageError` listing candidates.
- Ids pass through untouched — no shape validation, ever (three id shapes exist; users are
  24-hex, some ids are short slugs).
- Cache key `(apiBase, clientId, libraryId, kind[, scope])`, 24 h TTL, `--no-cache`
  bypass, cleared by `auth login` / `auth logout`.
- Writes that used a cached id are wrapped in `withCacheInvalidation`: on rejection, drop
  the key, resolve again, retry once, then report with the "try `--no-cache`" hint. It
  composes unchanged — no testhub-specific forking was needed.

**Suite tree flattening**: suites are a tree served as a flat list, joined by a
**`parent` reference object** ([th#9], [th#11]). The resolver flattens it and matches on
name; if two nodes in different branches share a name, that is an ambiguity error listing
both paths, not a silent pick. Testhub suites carry **no `type` discriminator** — that
field belongs to *ship* suites.

S3 generalised ship's `loadSuites` into a shared `loadSuiteTree(ctx, path, query)` rather
than copying it: the two areas differ only in endpoint and query.

> **Live-verified 2026-08-02 (S6 smoke) — `paths` is the parent chain, not the node's own
> path.** `GET /v1/testhub/libraries/{id}/suites` on a two-node tree (root `登录`, child
> `短信验证码`) returns:
>
> ```json
> {"id":"6a6ef9018359e0328fce7c16","name":"登录","paths":"","parent":null}
> {"id":"6a6ef90111c48dd2a042368f","name":"短信验证码","paths":"登录",
>  "parent":{"id":"6a6ef9018359e0328fce7c16","name":"登录","paths":""}}
> ```
>
> So `paths` holds the **ancestor chain excluding the node itself**, and it is **`""` at a
> root**. It is *not* `Parent/Child` for the node.
>
> This falsifies the S3 addition that registered `paths` verbatim as a typeable alias
> (rationale then: "it is what the API echoes in `case.suite.paths`, so it is what a user
> pastes"). Registering it verbatim gives the child `短信验证码` the alias `登录`, which
> collides with the sibling root actually named `登录` and turns an unambiguous name into a
> spurious `ambiguous suite name` exit 2; at a root it registers the empty string. The
> registration was **removed** — only the computed `Parent / Child`
> (`SUITE_PATH_SEPARATOR = ' / '`) and the plain leaf name are aliases.
>
> No replacement alias was added. The separator-free spelling `登录/短信验证码` would have to
> be *composed* as `paths + '/' + name`, which assumes the `paths` separator (unverified
> beyond one single-level sample) and appears nowhere in the API surface a user copies from
> — `case.suite.paths` yields only `登录`. Composing it would re-introduce exactly the class
> of assumption this finding removed, so it is out. Do not reintroduce either form without
> a live multi-level sample.

**Resolver names** (S4 calls these): `resolveTestLibrary(ctx, input)`,
`resolveTestSuite(ctx, libraryId, input)`, `resolveCaseState(ctx, libraryId, input)`,
`resolveCaseType(ctx, libraryId, input)`, `resolveRunStatus(ctx, libraryId, input)`,
`resolveTestPlan(ctx, libraryId, input)`, `resolveCaseImportantLevel(ctx, input)`.
`--executor` uses the existing org-directory `resolveUser(ctx, input)`; testhub adds no
kind for it.

**`--library` bootstraps everything else**: the library resolver is the first hop for every
library-scoped kind. The CLI requires `--library <name|id>` on any command that needs
`library_id`, resolves it once at the top of the action, and passes the resolved id down to
the metadata resolvers for states/types/statuses/suites.

## 6. `--x` vs `--x-id` mutual exclusion

Reuse `common.ts:134-235` (`addStateOptions` / `resolveStateFlags` and the ship
equivalents). Every name-resolvable field gets a pair:

```
--library <name|id>        --library-id <id>     (mutually exclusive)
--suite <name>             --suite-id <id>
--state <name>             --state-id <id>
--type <name>              --type-id <id>
--important-level <name>   --important-level-id <id>
--status <name>            --status-id <id>
--executor <name>          --executor-id <id>
```

The `--x` variant triggers name resolution; `--x-id` passes through verbatim. Both
variants set the same output variable. If neither is given, the field is omitted from the
request body (except where the API marks it required — see §7).

## 7. Write-path safety (PRD R4)

**Mandatory `status_id` on run PATCH**: `PATCH /runs/{run_id}` requires `status_id`
([th#61]). The CLI must require it — there is no "only change remark" mode. If the user
does not pass `--status`, resolve the current status from the run resource and re-emit it
alongside the new fields. This is a read-modify-write at the command layer, not a silent
server-side default.

**Always-explicit `executor_id`**: omitting `executor_id` is destructive and the behaviour
differs between PUT (clears executor) and PATCH (sets to creator) ([th#45], [th#61]).
The CLI always sends `executor_id` — resolved from `--executor`/`--executor-id` if given,
otherwise inherited from the existing run resource on PATCH, or rejected with a clear
message on PUT.

**Read-modify-write for `steps[]`**: `steps` is a full replacement ([th#61]). A step
without `step_id` is treated as a new step and a new id is silently generated, orphaning
the previous result. The CLI must `GET` the run first, present the existing steps, accept
per-step `status_id` and `actual_value` updates, then PATCH the full array back. This is
the `run patch` UX contract.

**Bulk batching**: `runs/bulk` accepts `inserts[]` and `updates[]` and `deletes[]`,
each capped at 50 ([th#49]). The CLI validates the count client-side and raises
`UsageError` (exit 2) with the count before any request is sent. `PATCH /runs/bulk`
([th#50]) has no declared cap; the CLI applies the same 50-per-array conservative limit.

**`short_id` is read-only**: `GET /cases/{id}`, `GET /runs/{id}`, `GET /plans/{id}`
accept `short_id` ([th#21], [th#52], [th#53]). Every write path documents only `id`.
The CLI accepts `short_id` on `get`/`list` for convenience but resolves to a full `id`
before any PATCH/POST/DELETE.

**`runWrite` reuse**: `cli/commands/common.ts` already provides `runWrite` (cache
invalidation + retry once). All testhub write commands route through it.

## 8. Search DSL

Both `POST /v1/testhub/cases/search` ([th#20]) and `POST /v1/testhub/runs/search`
([th#51]) use the same DSL as pjm/ship:

```json
{
  "mode": "query",
  "payload": {
    "filter": { "<attr>": { "<op>": <value> } },
    "keywords": "<free text>",
    "page_size": 30,
    "page_index": 0
  }
}
```

Rules:
- One operator per field; no `$and`/`$or`.
- Reference fields: `state.id`, `type.id`, `important_level.id`, `assignee.id`,
  `plan.id`, `suite.id`.
- Custom fields: `properties.{key}`.
- `keywords` is a sibling of `filter`, not a filter entry.
- `runs/search` cannot filter by `library.id` ([th#51] exclusion list). Users must
  filter by `plan.id` instead.

## 9. Error mapping

| Failure | CLI error | Exit |
|---|---|---|
| Bad flag combination / missing required flag | `UsageError` | 2 |
| Name resolves to zero or multiple candidates | `UsageError` listing candidates | 2 |
| Resource does not exist on GET | `NotFoundError` with resource name | 5 |
| 403 on metadata endpoint | `PermissionError` naming the missing scope | 4 |
| 403 on write endpoint | `PermissionError` naming the missing scope | 4 |
| 429 rate limit | `RateLimitError` with `retry-after` | 6 |
| Bulk count > 50 | `UsageError` with count | 2 |
| `PATCH /runs/{id}` without `status_id` | `UsageError` (CLI-side, before request) | 2 |
| Ambiguous suite name across branches | `UsageError` listing both paths | 2 |

> **Corrected in S1.** The previous revision put not-found on exit 3 and rate-limit on
> exit 4. The exit table is a **stable contract** owned by `src/core/errors.ts` and
> documented in `.trellis/spec/backend/error-handling.md`: 3 is `auth`, 4 is
> `permission`, 5 is `not_found`, 6 is `rate_limit`. Testhub introduces no new exit
> codes and must not renumber existing ones.

Note also that this API answers **HTTP 400** where REST convention would use 404, so
`NotFoundError` on a missing testhub resource is only reachable once the vendor `code`
is added to `ERROR_CODE_OVERRIDES` in `core/wire.ts` — and testhub documents **no**
error codes at all (testhub §10.8, PRD open question 6). Until S6 observes real codes,
a missing testhub resource surfaces as `ApiError` (exit 7) with the raw code preserved.
That is the documented fall-through, not a defect; do not guess codes into the table.

**Configuration-scope trap** ([th#25], [th#57]): `case/states` and `run/statuses`
require `pcp:read:testhub:configuration`. A token with only `testcase` + `testplan`
will 403 on these endpoints. The CLI detects this on the first resolution failure and
prints an actionable message naming the missing scope, rather than a bare 403.

## 10. Output

Identical contracts to the pjm/ship surface (M§7.2, M§7.3):

- Human mode: width-aware table. `library list`: identifier, name, visibility, member count.
  `case list`: id, title, state, type, important level, suite. `plan list`: id, name, type,
  state, start/end. `run list`: id, case title, executor, status, remark.
- `--json`: stdout is JSON only. List → raw envelope `{page_index, page_size, total, values}`;
  `--all` → `{values, count, all: true}`; single resource → the resource object; config
  lookups → `{values, count}`.
- Timestamps stay raw unix seconds under `--json`, localised only in human mode via
  `formatTimestamp`.
- Errors, dry-run plans, warnings: stderr in human mode; dry-run under `--json` goes to
  stdout as `{"dry_run": true, "request": {…}}`.

## 11. Types

Hand-written in `src/types/api.ts` for all 16 endpoints, snake_case with an index
signature so unknown fields — including custom `properties` — survive into `--json`
untouched. All fields optional/nullable (PRD R6); array fields are the one exception,
normalised to `[]` so call sites never branch, matching `ShipProduct.members` and
`WorkItem.tags`.

> **Corrected in S1 against `testhub-api.md` §3.** The list below is the shape the
> API actually returns. The previous revision mixed **request** parameters into the
> **response** types — it gave `TestCase` a `suite_id`/`type_id`/`state_id`/
> `important_level_id`/`maintenance_id`/`test_library_id` and `TestRun` a
> `status_id`/`executor_id`/`case_id`/`plan_id`/`library_id`. Reads return localized
> *objects* and writes take *`*_id` scalars* (GOTCHA #5); the two never appear in the
> same payload. The request shapes therefore live in `src/api/testhub.ts` as
> `CreateCaseInput` / `UpdateCaseInput` / `PatchRunInput` / `BulkRunsInput`, exactly as
> ship keeps `CreateIdeaInput` separate from `ShipIdea`.

Key types:
- `TestLibrary`: `id`, `identifier`, `name`, `url`, `description`, `visibility`,
  `scope_type`, `scope_id`, `color`, `members[]`, `created_at`/`created_by`,
  `updated_at`/`updated_by`, `is_archived`, `is_deleted` ([th#7]).
- `TestSuite`: `id`, `name`, `url`, `library`, **`parent` (a ref object, not a
  `parent_id` scalar)**, **`paths`** (plural). [th#9] documents no `type`
  discriminator and no `is_archived`/`is_deleted` on a testhub suite — unlike a *ship*
  suite, which is where the earlier `type ∈ library|suite` claim came from.
- `TestCase`: `id`, `identifier`, `short_id`, `url`, `html_url`, `title`, `level`
  (the importance level's *name*), `library`, `suite`, `state`, `type`,
  `important_level`, `maintenance`, `test_type` (`automation|manual`, read-only),
  `description`, `precondition`, `properties`, `estimated_workload`,
  `remaining_workload`, `steps[]`, `participants[]`, `public_image_token`,
  `created_at`/`created_by`, `updated_at`/`updated_by`, `is_archived`, `is_deleted`.
  There is **no `tags` field** despite `?tag_id` being a filter (GOTCHA #6).
- `TestCaseStep` (case side): `step_id`, `description`, `expected_value`, `is_group`,
  `group_id`.
- `TestRunStep` (run side, **a separate type**): `step_id`, `status` (slug),
  `actual_value`. [th#52] gives run steps none of the case-side prose fields, so
  merging the two — as the earlier revision did — would have invented fields on both.
- `TestPlan`: `id`, `short_id`, `name`, `url`, `html_url`, `library`, `type`, `state`,
  `project`, `sprint`, `version`, `assignee`, `start_at`, `end_at`, `summary`,
  `created_at`/`created_by`, `updated_at`/`updated_by`. **No `is_archived` /
  `is_deleted`** — testhub §3.2 calls this out explicitly as the plan's difference
  from library/case/run — and no workload fields.
- `TestPlanRef`: an *embedded* plan, with a flat **`status` string** where the plan
  resource has a **`state` object** (GOTCHA #4). Separate type, separate parser.
- `TestRun`: `id`, `short_id`, `url`, `html_url`, `library`, `plan` (`TestPlanRef`),
  `case`, `suite`, `status` (slug), `latest_executed_status` (localized ref),
  `executor`, `remark`, `steps[]` (`TestRunStep`), `created_at`/`created_by`,
  `updated_at`/`updated_by`, `is_archived`, `is_deleted`.
- `TestCaseState`: `id`, `name`, `type` (`pending|completed|closed`), `color`
  ([th#34]; `color` is absent from the list view [th#25]).
- `TestCaseType`: `id`, `name` ([th#35]).
- `TestCaseImportantLevel`: `id`, `name`, `color` ([th#36]).
- `TestRunStatus`: `id`, `name`, `is_system`. **No slug field** — the CLI must map by
  `name` (未测/通过/受阻/失败/跳过) and allow user overrides.
- `TestPlanType`: `id`, `name`, `library`. **No kind field** — the CLI infers
  "迭代测试" vs "发布测试" from the Chinese `name` (deferred; plan creation is out of
  scope, so S1 adds the type but **no** endpoint and **no** wrapper).
- `TestRunBulkResult`: `{inserts, updates, deletes}` **counts only** — the bulk call
  does not return the ids of the runs it created ([th#49]).

`is_system` is declared by [th#0]/[th#63] on run statuses and plan states only. It is
carried as an optional field on `TestCaseState` / `TestCaseType` /
`TestCaseImportantLevel` too — tolerated if it appears, never defaulted to `false`,
the same treatment `ShipTicketType` gets (ship GOTCHA #12).

**Two distinct history shapes** (do not share a deserializer) — types added in S1,
wrappers deliberately **not**, since the history endpoints are out of PRD scope:
- `TestRunHistoryItem` (`/runs/{id}/histories`): `executed_status` **object** + `remark`.
- `TestCaseHistoryItem` (`/cases/{id}/histories`): flat `status` **string**, no `remark`.

## 12. Risks

| Risk | Mitigation |
|---|---|
| `run/statuses` name→slug mapping is undocumented | CLI resolves by `name`, not slug; user overrides allowed. |
| `plan_type` has no kind field | Plan creation deferred; read-only plan commands do not need it. |
| `runs/search` cannot filter by `library.id` | Documented in `--help` and SKILL.md; users filter by `plan.id`. |
| Suite name collisions across branches | Ambiguity error listing full paths. |
| `properties` merge semantics undocumented | Replace-only; no partial property writes in this slice. |
| Rate limit (200/min) during name resolution | 24 h cache and one lookup per parent. |
| `PATCH /runs/{id}` requires `status_id` | CLI-side guard: resolve current status and re-emit if user omits it. |
| `executor_id` destructive defaults | CLI always sends it; inherited from existing run on PATCH. |
| `steps[]` full replacement | Read-modify-write UX; CLI presents existing steps for editing. |

## 13. Rollback

One commit per slice (see `implement.md`); every commit leaves `typecheck` and `test`
green. The only external side effect is any smoke data created during S7, which is marked
with a `[CLI smoke]` prefix and noted in the wrap-up. Testhub exposes no library DELETE,
so smoke libraries can only be marked, not removed.
