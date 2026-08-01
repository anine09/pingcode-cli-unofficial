# PingCode Testhub (测试管理 / Test Management) — Open API Research Report

**Source of truth:** `https://open.pingcode.com/api_data.json` (re-fetched and re-parsed for this report).
**Total records in file:** 579. **Records whose `url` contains `/v1/testhub/`:** 65 (all are HTTP endpoints; a further 26 records in groups `测试管理` / `测试配置中心` are empty narrative/section stubs with no `type` and no description text).

**Citation convention used below:** `[th#N]` = the N-th record (0-based) of the list produced by filtering `api_data.json` to records where `'/v1/testhub/' in record.url`, preserving file order. Each citation also names the method + path so it can be re-found independently. Non-obvious claims (defaults, inconsistencies, enum slugs) are cited.

**Redaction note:** all ids, hostnames and user handles from the doc's own examples have been replaced with placeholders (`<id>`, `{rest_api_root}`, `{web_root}`). No credentials, tokens or tenant-identifiable values appear in this document.

---

## 1. Resource inventory

### 1.1 By documentation group (`record.group`) — sums to 65

| Group (Chinese) | Translation | Endpoints |
|---|---|---|
| `计划` | Plan **+ Run (执行用例)** — the doc puts runs in the plan group | 18 |
| `用例配置` | Case configuration (properties, property plans, states, types, important levels) | 16 |
| `测试库` | Test library (library, members, suites/modules) | 14 |
| `用例` | Case | 13 |
| `执行用例配置` | Run-result configuration (`run_statuses`) | 2 |
| `计划配置` | Plan configuration (`plan_states`) | 2 |
| **Total** | | **65** |

### 1.2 By URL resource family (more useful for a CLI) — also sums to 65

| Family | URL prefix | Count | Verbs present |
|---|---|---|---|
| Library (测试库) | `/v1/testhub/libraries` (+ `/members`, `/suites`) | 14 | POST, GET, PATCH, DELETE (no DELETE on the library itself) |
| Case (用例) | `/v1/testhub/cases`, `/v1/testhub/case/*` | 13 | POST, GET, PATCH, DELETE, POST `…/search` |
| Case config (用例配置) | `/v1/testhub/case_properties`, `/case_property_plans`, `/case_states`, `/case_types`, `/case_important_levels` | 16 | POST, GET, PATCH, DELETE (writes only on properties + plan membership) |
| Plan (计划) | `/v1/testhub/libraries/{library_id}/plans`, `/plan_types` | 7 | POST, GET, PATCH (**no DELETE**) |
| Run (执行用例) | `/v1/testhub/runs`, `/v1/testhub/run/statuses` | 11 | POST, GET, PATCH, PUT, POST `…/search` (**no single DELETE**) |
| Plan config (计划配置) | `/v1/testhub/plan_states` | 2 | GET only |
| Run-status config | `/v1/testhub/run_statuses` | 2 | GET only |
| **Total** | | **65** | |

Breakdown of the 7 "Plan" + 11 "Run" entries: plans = create/get/list/patch (4) + plan_types get/list (2) + plan-scoped bulk-run operation (1); runs = create/get/list/patch/put/bulk-create/bulk-patch/search/history-get/history-list (10) + library-scoped run status list (1).

### 1.3 Declared scopes observed (exact strings)

- `pcp:read:testhub:library` / `pcp:write:testhub:library`
- `pcp:read:testhub:testcase` / `pcp:write:testhub:testcase`
- `pcp:read:testhub:testplan` / `pcp:write:testhub:testplan`
- `pcp:read:testhub:configuration` / `pcp:write:testhub:configuration`

Every one of the 65 records declares `permission: ["企业令牌/用户令牌"]` (organisation token / user token) — i.e. no endpoint is user-token-only or org-token-only.

---

## 2. Exhaustive endpoint table

Legend: **REQ** = required, **opt** = optional. Path parameters are always required unless stated. Query params are marked `?`, body params unmarked. Scope column shows the *declared* `scopes[].name`.

### 2.1 Library family — 测试库 (14)

| # | Method | Path | Required params | Optional params | Scope | Purpose |
|---|---|---|---|---|---|---|
| th#2 | POST | `/v1/testhub/libraries` | `name`, `identifier` | `scope_type` (def `organization`), `scope_id`, `visibility` (def `private`), `description`, `members[]` (`members.id` REQ, `members.type` REQ) | `pcp:write:testhub:library` | Create a test library |
| th#12 | GET | `/v1/testhub/libraries` | — | `?scope_type`, `?scope_id`, `?keywords` (name only), `?member_type`, `?member_id`, `?created_between`, `?updated_between`, `?include_deleted`, `?include_archived` | `pcp:read:testhub:library` | List libraries |
| th#7 | GET | `/v1/testhub/libraries/{library_id}` | `library_id` | `?include_deleted`, `?include_archived` | `pcp:read:testhub:library` | Get one library |
| th#13 | PATCH | `/v1/testhub/libraries/{library_id}` | `library_id` | `name`, `identifier`, `description` | `pcp:write:testhub:library` | Partially update a library |
| th#3 | POST | `/v1/testhub/libraries/{library_id}/members` | `library_id` | `member` (**declared optional**, with `member.id` REQ, `member.type` REQ), `role_id` | `pcp:write:testhub:library` | Add a member |
| th#10 | GET | `/v1/testhub/libraries/{library_id}/members` | `library_id` | — | `pcp:read:testhub:library` | List members |
| th#8 | GET | `/v1/testhub/libraries/{library_id}/members/{member_id}` | `library_id`, `member_id` (= user or user_group id) | — | `pcp:read:testhub:library` | Get one member |
| th#15 | PATCH | `/v1/testhub/libraries/{library_id}/members/{member_id}` | `library_id`, `member_id` | `role_id` | `pcp:write:testhub:library` | Change a member's role |
| th#5 | DELETE | `/v1/testhub/libraries/{library_id}/members/{member_id}` | `library_id`, `member_id` | — | `pcp:write:testhub:library` | Remove a member |
| th#4 | POST | `/v1/testhub/libraries/{library_id}/suites` | `library_id`, `name` | `parent_id` | `pcp:write:testhub:library` | Create a case module (suite) |
| th#11 | GET | `/v1/testhub/libraries/{library_id}/suites` | `library_id` | `?parent_id` (empty = all, `root` = top level, id = direct children) | `pcp:read:testhub:library` | List suites |
| th#9 | GET | `/v1/testhub/libraries/{library_id}/suites/{suite_id}` | `library_id`, `suite_id` | — | `pcp:read:testhub:library` | Get one suite |
| th#14 | PATCH | `/v1/testhub/libraries/{library_id}/suites/{suite_id}` | `library_id`, `suite_id` | `name`, `parent_id` | `pcp:write:testhub:library` | Rename / re-parent a suite |
| th#6 | DELETE | `/v1/testhub/libraries/{library_id}/suites/{suite_id}` | `library_id`, `suite_id` | — | `pcp:write:testhub:library` | Delete a suite — **cascades to all child suites** (`请注意，删除一个模块会自动删除其所有的子模块`) |

### 2.2 Case family — 用例 (13)

| # | Method | Path | Required params | Optional params | Scope | Purpose |
|---|---|---|---|---|---|---|
| th#16 | POST | `/v1/testhub/cases` | `test_library_id`, `title` | `suite_id`, `type_id`, `important_level_id`, `maintenance_id`, `participant_ids[]`, `properties` (`properties.{key}`), `description`, `precondition`, `steps[]` (`steps.step_id`, `steps.description`, `steps.expected_value`, `steps.is_group`, `steps.group_id` — all opt) | `pcp:write:testhub:testcase` | Create one case |
| th#18 | POST | `/v1/testhub/cases/bulk` | `cases[]` (≤100), `cases.test_library_id`, `cases.title` (1–200 chars) | `cases.important_level_id`, `cases.maintenance_id`, `cases.participant_ids[]`, `cases.properties`, `cases.description`, `cases.precondition`, `cases.steps[]` (+5 sub-fields) | `pcp:write:testhub:testcase` | Bulk create cases (**no `suite_id`, no `type_id`**) |
| th#19 | PATCH | `/v1/testhub/cases/bulk` | `cases[]`, `cases.case_id` | `cases.state_id`, `cases.type_id`, `cases.title`, `cases.important_level_id`, `cases.maintenance_id`, `cases.properties`, `cases.description`, `cases.precondition`, `cases.steps[]` (+5 sub-fields) | `pcp:write:testhub:testcase` | Bulk partial update (**no `suite_id`**; no array size limit documented) |
| th#28 | PATCH | `/v1/testhub/cases/{case_id}` | `case_id` | `suite_id`, `state_id`, `type_id`, `title`, `important_level_id`, `maintenance_id`, `properties`, `description`, `precondition`, `steps[]` | `pcp:write:testhub:testcase` | Partially update one case |
| th#17 | DELETE | `/v1/testhub/cases/{case_id}` | `case_id` | — | `pcp:write:testhub:testcase` | Delete one case (returns the full case body) |
| th#21 | GET | `/v1/testhub/cases/{case_id}` | `case_id` (**accepts `id` or `short_id`**) | `?include_public_image_token` (comma-separated, ≤32, supports `description` and custom textarea props, e.g. `description,properties.prop_b`) | `pcp:read:testhub:testcase` | Get one case |
| th#22 | GET | `/v1/testhub/cases` | — | `?library_id`, `?maintenance_id`, `?state_id`, `?important_level_id`, `?tag_id`, `?keywords` (case number + title), `?include_public_image_token`, `?include_deleted`, `?include_archived` | `pcp:read:testhub:testcase` | Simple case list; doc explicitly redirects complex filtering to `POST /cases/search` |
| th#20 | POST | `/v1/testhub/cases/search` | `mode` (only `query`), `payload` | `payload.filter`, `payload.keywords`, `payload.include_public_image_token`, `payload.include_deleted` (def `false`), `payload.include_archived` (def `false`), `payload.page_size` (def 30, 1–100), `payload.page_index` (def 0) | `pcp:read:testhub:testcase` | Structured case search (see §4) |
| th#26 | GET | `/v1/testhub/cases/{case_id}/histories` | `case_id` | — | **`pcp:write:testhub:testcase`** (see GOTCHA 1) | Last execution result of every run of this case |
| th#23 | GET | `/v1/testhub/case/properties?library_id={library_id}` | `?library_id` **REQ** | — | `pcp:read:testhub:testcase` | Custom case properties effective in a library |
| th#24 | GET | `/v1/testhub/case/suites?library_id={library_id}` | `?library_id` **REQ** | — | `pcp:read:testhub:testcase` | Case modules of a library (duplicate of th#11, different scope/shape) |
| th#25 | GET | `/v1/testhub/case/states?library_id={library_id}` | `?library_id` **REQ** | — | **`pcp:read:testhub:configuration`** | Case states of a library |
| th#27 | GET | `/v1/testhub/case/types?library_id={library_id}` | `?library_id` **REQ** | — | `pcp:read:testhub:testcase` | Case types of a library |

### 2.3 Case configuration family — 用例配置 (16)

| # | Method | Path | Required params | Optional params | Scope | Purpose |
|---|---|---|---|---|---|---|
| th#29 | POST | `/v1/testhub/case_properties` | `name` (unique per org), `type` (13-value enum, §8) | `options[]` (`options.text` REQ; `options._id`, `options.parent_id` opt; cascade depth ≤4) | `pcp:write:testhub:configuration` | Create a custom case property |
| th#44 | PATCH | `/v1/testhub/case_properties/{property_id}` | `property_id` | `name`, `options[]` (**whole-array replace**) | `pcp:write:testhub:configuration` | Update a custom property |
| th#32 | GET | `/v1/testhub/case_properties/{property_id}` | `property_id` | — | `pcp:read:testhub:configuration` | Get one property |
| th#37 | GET | `/v1/testhub/case_properties` | — | — | `pcp:read:testhub:configuration` | List all properties (org-wide) |
| th#43 | GET | `/v1/testhub/case_property_plans` | — | `?library_id` (pass when querying plans with library-local config) | `pcp:read:testhub:configuration` | List property plans |
| th#33 | GET | `/v1/testhub/case_property_plans/{property_plan_id}` | `property_plan_id` | — | `pcp:read:testhub:configuration` | Get one property plan |
| th#30 | POST | `/v1/testhub/case_property_plans/{property_plan_id}/case_properties` | `property_plan_id`, `property_id` | — | `pcp:write:testhub:configuration` | Attach a property to a plan |
| th#31 | DELETE | `/v1/testhub/case_property_plans/{property_plan_id}/case_properties/{property_id}` | `property_plan_id`, `property_id` | — | `pcp:write:testhub:configuration` | Detach a property from a plan |
| th#41 | GET | `/v1/testhub/case_property_plans/{property_plan_id}/case_properties/{property_id}` | both | — | `pcp:read:testhub:configuration` | Get one plan↔property link |
| th#42 | GET | `/v1/testhub/case_property_plans/{property_plan_id}/case_properties` | `property_plan_id` | — | `pcp:read:testhub:configuration` | List properties in a plan |
| th#34 | GET | `/v1/testhub/case_states/{state_id}` | `state_id` | — | `pcp:read:testhub:configuration` | Get one case state |
| th#38 | GET | `/v1/testhub/case_states` | — | — | `pcp:read:testhub:configuration` | List all case states (org-wide) |
| th#35 | GET | `/v1/testhub/case_types/{type_id}` | `type_id` | — | `pcp:read:testhub:configuration` | Get one case type |
| th#39 | GET | `/v1/testhub/case_types` | — | — | `pcp:read:testhub:configuration` | List all case types |
| th#36 | GET | `/v1/testhub/case_important_levels/{important_level_id}` | `important_level_id` | — | `pcp:read:testhub:configuration` | Get one importance level |
| th#40 | GET | `/v1/testhub/case_important_levels` | — | — | `pcp:read:testhub:configuration` | List all importance levels |

### 2.4 Plan family — 计划 (7 of the 18 in group `计划`)

| # | Method | Path | Required params | Optional params | Scope | Purpose |
|---|---|---|---|---|---|---|
| th#47 | POST | `/v1/testhub/libraries/{library_id}/plans` | `library_id`, `name` (unique per library), `type_id`, `start_at`, `end_at`, `assignee_id` | `project_id` (**REQ when `sprint_id` or `version_id` is set**), `sprint_id` (only when `type_id` = sprint test), `version_id` (only when `type_id` = release test) | `pcp:write:testhub:testplan` | Create a plan |
| th#59 | GET | `/v1/testhub/libraries/{library_id}/plans` | `library_id` | `?name`, `?created_between`, `?updated_between` | `pcp:read:testhub:testplan` | List plans |
| th#53 | GET | `/v1/testhub/libraries/{library_id}/plans/{plan_id}` | `library_id`, `plan_id` (**id or short_id**) | — | `pcp:read:testhub:testplan` | Get one plan |
| th#62 | PATCH | `/v1/testhub/libraries/{library_id}/plans/{plan_id}` | `library_id`, `plan_id` (id only) | `name`, `type_id`, `project_id`, `sprint_id`, `version_id`, `start_at`, `end_at`, `assignee_id`, `state_id`, `summary` | `pcp:write:testhub:testplan` | Partially update a plan / write the report summary |
| th#60 | GET | `/v1/testhub/libraries/{library_id}/plan_types` | `library_id` | — | `pcp:read:testhub:testplan` | List plan types |
| th#54 | GET | `/v1/testhub/libraries/{library_id}/plan_types/{plan_type_id}` | `library_id`, `plan_type_id` | — | `pcp:read:testhub:testplan` | Get one plan type |
| th#49 | POST | `/v1/testhub/libraries/{library_id}/plans/{plan_id}/runs/bulk` | `library_id`, `plan_id` | `inserts[]` (≤50; `inserts.case_id` REQ, `inserts.executor_id` opt), `updates[]` (≤50; `updates.run_id` REQ, `updates.status_id` REQ, `updates.steps[]` opt with `step_id` REQ + `status_id` REQ + `actual_value` opt, `updates.executor_id` opt), `deletes[]` (≤50 run ids) | `pcp:write:testhub:testplan` | **The only way to delete runs**; single call insert+update+delete |

### 2.5 Run family — 执行用例 (11)

| # | Method | Path | Required params | Optional params | Scope | Purpose |
|---|---|---|---|---|---|---|
| th#46 | POST | `/v1/testhub/runs` | `library_id`, `plan_id`, `case_id` | `executor_id` | `pcp:write:testhub:testplan` | Add one case to a plan as a run |
| th#48 | POST | `/v1/testhub/runs/bulk` | `runs[]` (≤100), `runs.library_id`, `runs.plan_id`, `runs.case_id` | `runs.executor_id` | `pcp:write:testhub:testplan` | Bulk add runs |
| th#45 | PUT | `/v1/testhub/runs/{run_id}` | `run_id`, `status_id`, `steps[]` (**REQ**; `steps.step_id` REQ, `steps.status_id` REQ, `steps.actual_value` opt) | `remark`, `executor_id` (**omitted ⇒ executor becomes empty**) | `pcp:write:testhub:testplan` | Full update (record a result) |
| th#61 | PATCH | `/v1/testhub/runs/{run_id}` | `run_id`, `status_id` (**required even on PATCH**) | `remark`, `steps[]` (whole-array replace), `executor_id` (**omitted ⇒ executor defaults to the run's creator**) | `pcp:write:testhub:testplan` | Partial update (record a result) |
| th#50 | PATCH | `/v1/testhub/runs/bulk` | `runs[]`, `runs.run_id`, `runs.status_id` | `runs.remark`, `runs.steps[]` (`step_id` REQ, `status_id` REQ, `actual_value` opt), `runs.executor_id` | `pcp:write:testhub:testplan` | Bulk record results (no size limit documented) |
| th#52 | GET | `/v1/testhub/runs/{run_id}` | `run_id` (**id or short_id**) | — | `pcp:read:testhub:testplan` | Get one run |
| th#56 | GET | `/v1/testhub/runs` | — | `?plan_id`, `?case_id`, `?suite_id`, `?status_id`, `?keywords` | `pcp:read:testhub:testplan` | Simple run list; doc redirects complex filtering to `POST /runs/search` |
| th#51 | POST | `/v1/testhub/runs/search` | `mode` (only `query`), `payload` | `payload.filter`, `payload.keywords`, `payload.page_size` (def 30, 1–100), `payload.page_index` (def 0) | `pcp:read:testhub:testplan` | Structured run search (see §4) |
| th#58 | GET | `/v1/testhub/runs/{run_id}/histories` | `run_id` | — | `pcp:read:testhub:testplan` | List result records of a run |
| th#55 | GET | `/v1/testhub/runs/{run_id}/histories/{history_id}` | `run_id`, `history_id` | — | `pcp:read:testhub:testplan` | Get one result record |
| th#57 | GET | `/v1/testhub/run/statuses?library_id={library_id}` | `?library_id` **REQ** | — | **`pcp:read:testhub:configuration`** | Run-result options available in a library — **the lookup you need for `status_id`** |

### 2.6 Plan configuration — 计划配置 (2) and Run-result configuration — 执行用例配置 (2)

| # | Method | Path | Required params | Scope | Purpose |
|---|---|---|---|---|---|
| th#63 | GET | `/v1/testhub/plan_states/{state_id}` | `state_id` | `pcp:read:testhub:configuration` | Get one plan state |
| th#64 | GET | `/v1/testhub/plan_states` | — | `pcp:read:testhub:configuration` | List all plan states (org-wide) |
| th#0 | GET | `/v1/testhub/run_statuses/{status_id}` | `status_id` | `pcp:read:testhub:configuration` | Get one run-result option |
| th#1 | GET | `/v1/testhub/run_statuses` | — | `pcp:read:testhub:configuration` | List all run-result options (org-wide) |

---

## 3. Response field lists for core resources

All list endpoints return the platform-standard envelope: `page_size`, `page_index` (0-based), `total`, `values[]` — declared identically on every testhub list record. Per the `使用方式` overview record: default `page_size` = 30, max 100, driven by `?page_size` / `?page_index` in the query string (**not declared on the individual testhub list records** — see GOTCHA 12).

### 3.1 Test case (用例) — full structure
From `[th#21] GET /v1/testhub/cases/{case_id}` (identical field set on th#16 POST, th#17 DELETE, th#28 PATCH, th#20 search `values[]`, except `public_image_token`):

| Field | Type | Notes |
|---|---|---|
| `id` | String | |
| `url` | String | API resource address |
| `library` | Object | ref: `id`, `url`, `identifier`, `name`, `is_archived`, `is_deleted` |
| `identifier` | String | human key, e.g. `<LIB>-10` |
| `title` | String | |
| `level` | String | **name** of importance level — duplicates `important_level.name` |
| `short_id` | String | usable in the GET-by-id path |
| `html_url` | String | web UI link |
| `important_level` | Object | ref: `id`, `url`, `name` |
| `suite` | Object | ref: `id`, `url`, `name`, `paths` (`/`-separated ancestor path) |
| `state` | Object | ref: `id`, `url`, `name`, `type` (`pending|completed|closed`) |
| `type` | Object | ref: `id`, `url`, `name` |
| `maintenance` | Object | user ref: `id`, `url`, `name`, `display_name`, `avatar` |
| `test_type` | String | `automation` \| `manual` |
| `description` | String | described as 描述 in the response, 备注 in PATCH request — same field |
| `precondition` | String | |
| `properties` | Object | flat map `{ "<property_key>": <value> }` |
| `estimated_workload` | Number | **can be `null`** despite being declared required (th#18 example) |
| `remaining_workload` | Number | **can be `null`** (same) |
| `steps` | Object[] | `step_id`, `description`, `expected_value` (nullable), `is_group` (Boolean), `group_id` (nullable) |
| `participants` | Object[] | `id`, `url` (points at `/v1/participants/...?principal_type=test_case&principal_id=<case_id>`), `type` (`user|user_group`), `user` / `user_group` object |
| `public_image_token` | String | **only when `include_public_image_token` was supplied** |
| `created_at` / `updated_at` | Number | 10-digit second-precision timestamps |
| `created_by` / `updated_by` | Object | user ref |
| `is_archived` / `is_deleted` | Number | `0` \| `1` |

Not returned but filterable/settable elsewhere: there is **no `tags` field** even though `GET /v1/testhub/cases` accepts `?tag_id` (GOTCHA 6).

### 3.2 Plan (计划) — full structure
From `[th#53] GET /v1/testhub/libraries/{library_id}/plans/{plan_id}` (same on th#47, th#62):

`id`, `url`, `library` (ref), `name`, `state` (ref: `id`,`url`,`name`,`type` ∈ `pending|in_progress|completed`), `start_at`, `end_at`, `short_id`, `html_url`, `type` (ref — plan type; th#53 describes it as "包括项目、发布和迭代" i.e. project/release/sprint), `project` (**pjm** ref: `id`,`url` → `/v1/pjm/projects/<id>`, `identifier`, `name`, `type` e.g. `scrum`, `is_archived`, `is_deleted`), `sprint` (pjm ref, nullable), `version` (pjm ref: `id`,`url` → `/v1/pjm/projects/<id>/versions/<id>`, `name`, `start_at`, `end_at`, `stage` {`id`,`url` → `/v1/pjm/stages/<id>`,`name`,`type`,`color`}), `assignee` (user ref), `summary` (test-report summary), `created_at`, `created_by`, `updated_at`, `updated_by`.

**No `is_archived` / `is_deleted` on the plan resource** — unlike library, case and run.

### 3.3 Run / 执行用例 — full structure
From `[th#52] GET /v1/testhub/runs/{run_id}` (same on th#45 PUT, th#46 POST, th#61 PATCH, th#51 search `values[]`):

`id`, `url`, `status` (String enum `not_start|pass|block|failure|skip`), `short_id`, `html_url`, `library` (ref), `plan` (ref — see GOTCHA 4), `case` (ref: `id`,`url`,`identifier`,`title`,`level`,`short_id`,`html_url`,`test_type`,`properties`), `latest_executed_status` (ref: `id`,`url` → `/v1/testhub/run_statuses/<id>`, `name` — localized name such as 通过/受阻/失败/跳过/未测), `suite` (ref incl. `paths`), `remark` (nullable), `executor` (user ref), `steps[]` (`step_id`, **`status`** as a slug, `actual_value` nullable), `created_at`, `created_by`, `updated_at`, `updated_by`, `is_archived`, `is_deleted`.

### 3.4 Run result record (执行用例结果记录 / run history)
From `[th#55] GET /v1/testhub/runs/{run_id}/histories/{history_id}` and `[th#58]` list:
`id`, `url`, `run` (ref: `id`,`url`,`status`,`short_id`,`html_url`), `library` (ref), `plan` (ref), `case` (ref), `executed_status` (ref: `id`,`url`,`name`), `remark`, `executed_at`, `executed_by` (user ref), `steps[]` (`step_id`, `status`, `actual_value`).

**Case execution history is a different shape** — `[th#26] GET /v1/testhub/cases/{case_id}/histories` returns items with a top-level **`status`** string (`"status": "pass"`) instead of an `executed_status` object, and its example omits `remark`. Two "history" shapes exist for what the docs call the same thing (GOTCHA 3).

### 3.5 Supporting resources

- **Library**: `id`, `url`, `identifier`, `name`, `scope_type`, `scope_id`, `visibility`, `color`, `description`, `members[]`, `created_at`, `created_by`, `updated_at`, `updated_by`, `is_archived`, `is_deleted` `[th#7]`.
- **Library member**: `id`, `url`, `library` (ref), `type` (`user|user_group`), `user` (when `type=user`), `user_group` (when `type=user_group`), `role` (ref) `[th#8]`.
- **Suite / case module**: `id`, `url`, `library` (ref), `name`, `parent` (ref, optional), `paths` `[th#9]`.
- **Case property**: `id`, `url`, `name`, `type`, `options[]` (`_id`, `text`, optional `parent_id`), `is_removable`, `is_name_editable`, `is_options_editable` `[th#32]`. The example shows `id` as a **slug** (`"id": "severity"`), and the `properties` map on a case is keyed by that same key — so property id == property key.
- **Case property plan**: `id`, `url`, `category` (example `library`), `host` (example `case`), `library` (ref, **nullable** — the org-level default plan has `library: null`) `[th#33]`, `[th#43]`.
- **Case state**: `id`, `url`, `name`, `type` (`pending|completed|closed`), `color` `[th#34]`. *Note:* `color` is declared on the single-get record but is absent from the `case/states` list example `[th#25]`.
- **Case type**: `id`, `url`, `name` `[th#35]`. **Importance level**: `id`, `url`, `name`, `color` `[th#36]`.
- **Plan state**: `id`, `url`, `name`, `type` (`pending|in_progress|completed`), `is_system` (`0|1`) `[th#63]`.
- **Run status**: `id`, `url`, `name`, `is_system` (`0|1`) `[th#0]`. The library-scoped list `[th#57]` omits `is_system` in its example.

### 3.6 Bulk-operation response shapes

- `POST /cases/bulk` `[th#18]` and `PATCH /cases/bulk` `[th#19]`: fields declared as `state` (`success|failure`) + `case` (object), but the **examples return a JSON array** of those objects, one per input element. Neither declares a `message` field even though failures are possible.
- `POST /runs/bulk` `[th#48]` and `PATCH /runs/bulk` `[th#50]`: `state` (`success|failure`), `run` (object, on success), `message` (String, optional, on failure) — again per-element, array-shaped by analogy.
- `POST /libraries/{library_id}/plans/{plan_id}/runs/bulk` `[th#49]`: **counts only** — `{ "inserts": <n>, "updates": <n>, "deletes": <n> }`. No ids of created runs are returned.

---

## 4. Search / filter DSL (`POST …/search`)

Two search endpoints exist: `POST /v1/testhub/cases/search` `[th#20]` and `POST /v1/testhub/runs/search` `[th#51]`. Both share one envelope:

```json
{
  "mode": "query",
  "payload": {
    "filter": { "<attribute>": { "<operator>": <value> } },
    "keywords": "<case number or title>",
    "page_size": 10,
    "page_index": 0
  }
}
```

- `mode` is required and the only allowed value is `query` ("基于 payload.filter 的结构化条件查询").
- `payload.filter` uses **MongoDB-like syntax**. Rules as documented (identical text in both records):
  - Reference types (including array references) are addressed as `{attr}.id`, e.g. `library.id`, `participants.id`, `plan.id`, `case.id`, `latest_executed_status.id`, `executor.id`, `maintenance.id`, `state.id`, `type.id`.
  - Custom properties are addressed as `properties.{property_key}`, e.g. `properties.prop_a`.
  - Operator sets by attribute kind:
    - Text (`title`, `description`, `precondition`, custom text/textarea/link): `exists`, `contains`
    - Enum (e.g. `test_type`): `exists`, `in`, `nin`
    - Number (custom number/progress/rate): `exists`, `eq`, `ne`, `gt`, `lt`, `gte`, `lte`
    - Time (`created_at`, `updated_at`, custom date): `exists`, `gt`, `lt`, `gte`, `lte`, `between` (value = `[start_ts, end_ts]`; **granularity is one day**)
    - Option types (single/multi select, cascade single/multi): `exists`, `in`, `nin`
    - Reference types: `exists`, `in`, `nin`
  - **One operator per attribute only.** **Logical operators (`$and`/`$or`) are not supported.**
  - Non-filterable attributes:
    - cases `[th#20]`: `id`, `url`, `identifier`, `short_id`, `html_url`, `public_image_token`, `steps`, `is_archived`, `is_deleted`
    - runs `[th#51]`: `id`, `url`, `short_id`, `html_url`, **`library.id`**, `steps`, `is_archived`, `is_deleted`
- Case search additionally supports `include_public_image_token`, `include_deleted` (def `false`), `include_archived` (def `false`). **Run search supports none of these three.**

Documented request example, case search `[th#20]` (ids redacted):

```json
{ "mode": "query",
  "payload": {
    "filter": {
      "title": { "contains": "登录" },
      "maintenance.id": { "nin": ["<user_id>"] },
      "library.id": { "in": ["<library_id_a>", "<library_id_b>"] },
      "participants.id": { "in": ["<user_id>"] },
      "created_at": { "gte": 1730000000 }
    },
    "keywords": "<LIB>", "include_public_image_token": "description",
    "include_deleted": false, "include_archived": false,
    "page_size": 10, "page_index": 0 } }
```

Run search example `[th#51]` filters on `title.contains`, `plan.id.in`, `latest_executed_status.id.in`.

---

## 5. Parent-scoping map (which ids live under which parent)

```
organization
├── library (测试库)                       POST /libraries                       — scope_type: organization | user_group
│   ├── member_id                          /libraries/{library_id}/members/{member_id}      (member_id = directory user or user_group id)
│   ├── suite_id  (case module, tree)      /libraries/{library_id}/suites/{suite_id}        (parent_id, paths)
│   ├── plan_id                            /libraries/{library_id}/plans/{plan_id}          ← PLAN IS LIBRARY-SCOPED IN THE URL
│   │   └── runs bulk op                   /libraries/{library_id}/plans/{plan_id}/runs/bulk
│   └── plan_type_id                       /libraries/{library_id}/plan_types/{plan_type_id}
├── case_id (用例)                          /cases/{case_id}                      ← FLAT, NOT under /libraries; library set via body `test_library_id`
│   └── case histories                     /cases/{case_id}/histories
├── run_id (执行用例)                        /runs/{run_id}                        ← FLAT; library_id + plan_id + case_id passed in body on create
│   └── history_id                         /runs/{run_id}/histories/{history_id}
└── configuration (org-level ids, library-filtered views)
    ├── case_properties/{property_id}            org-level;  library view: GET /case/properties?library_id=
    ├── case_property_plans/{property_plan_id}   org-level;  library-local plans: GET /case_property_plans?library_id=
    ├── case_states/{state_id}                   org-level;  library view: GET /case/states?library_id=
    ├── case_types/{type_id}                     org-level;  library view: GET /case/types?library_id=
    ├── case_important_levels/{important_level_id} org-level; NO library-scoped view exists
    ├── plan_states/{state_id}                   org-level;  NO library-scoped view exists
    └── run_statuses/{status_id}                 org-level;  library view: GET /run/statuses?library_id=
```

Key asymmetries:
- **Plans are addressed under `/libraries/{library_id}/…`; cases and runs are not.** A CLI must carry `library_id` for every plan call, but may not need it for case/run reads.
- **`product_id` does not exist in testhub.** The `product`/product-plan hierarchy belongs to the `ship` area; testhub links to **pjm** `project` / `sprint` / `version` only, and only through the plan resource (`project_id`, `sprint_id`, `version_id` on th#47/th#62).
- The `/case/xxx?library_id=` and `/run/statuses?library_id=` singular-noun endpoints are "what is configured for this library" views over org-level config resources; their items' `url` fields point back to the org-level `/case_states/<id>`, `/run_statuses/<id>` etc.

---

## 6. Cross-module relationships to pjm work items (and others)

### 6.1 Direct field-level links
`plan.project` / `plan.sprint` / `plan.version` are pjm references embedded in the plan resource, populated from the create/update params `project_id`, `sprint_id`, `version_id` `[th#47]`, `[th#53]`, `[th#62]`. Constraints as documented:
- `project_id` is required whenever `sprint_id` or `version_id` is supplied.
- `sprint_id` is only valid when `type_id` denotes 迭代测试 (sprint test); `version_id` only when it denotes 发布测试 (release test).
- On PATCH, "指定测试计划类型时，建议同时指定对应的 sprint_id 或 version_id" — when changing plan type, set the matching sprint/version too.

### 6.2 Generic `/v1/relations` links (defect linking)
`POST /v1/relations` with `principal_type` / `principal_id` / `target_type` / `target_id`. The record's `principal_type` description enumerates every supported pair and its required scopes. Testhub-relevant pairs:

| principal_type | target_type | Meaning | Required scopes (write) |
|---|---|---|---|
| `test_plan` | `work_item` | 测试计划关联缺陷 — plan ↔ defect | `pcp:write:testhub:testplan` + `pcp:write:pjm:workitem` |
| `test_run` | `work_item` | 执行用例关联缺陷 — run ↔ defect | `pcp:write:testhub:testplan` + `pcp:write:pjm:workitem` |
| `test_case` | `work_item` | 测试用例关联工作项 | `pcp:write:testhub:testcase` + `pcp:write:pjm:workitem` |
| `test_case` | `idea` | 测试用例关联需求 | `pcp:write:testhub:testcase` + `pcp:write:ship:idea` |
| `test_case` | `page` | 测试用例关联页面 | `pcp:write:testhub:testcase` + `pcp:write:wiki:page` |
| `work_item` | `test_case` | 工作项关联测试用例 (reverse direction) | `pcp:write:pjm:workitem` + `pcp:write:testhub:testcase` |
| `idea` | `test_case` | 需求关联测试用例 | `pcp:write:ship:idea` + `pcp:write:testhub:testcase` |

Read equivalents use the `pcp:read:*` forms. Response enums: `principal_type` ∈ `idea|ticket|work_item|test_plan|test_run|test_case|page`; `target_type` ∈ `ticket|work_item|test_case|idea|page` — note **`test_plan`/`test_run` can only be principals, never targets**, so "link a defect to a run" must be written run→work_item. Documented example is exactly `{"principal_type":"test_run","target_type":"work_item", ...}`.
`GET /v1/relations?principal_type=&principal_id=&target_type=` requires all three query params — you cannot list "all relations of a run" without naming the target type.

### 6.3 Other shared-service endpoints that accept testhub principals

| Service | Endpoints | Testhub principal_type values accepted |
|---|---|---|
| 关注人 Participants | `POST/GET/DELETE /v1/participants` | `test_case` (not `test_run`, not `test_plan`) |
| 工时 Workloads | `POST/GET/PATCH/DELETE /v1/workloads` | `test_case` only |
| 评审 Reviews | `POST/GET/DELETE /v1/reviews`, `…/principals` | `test_case` only |
| 评论 Comments | `POST/GET/DELETE /v1/comments` | `test_case`, `test_run` |
| 附件 Attachments | `POST/GET/DELETE /v1/attachments` | `test_case`, `test_run` |
| 活动记录 Activities | `GET /v1/activities` | `test_case`, `test_run` |

Consequences for a CLI: watchers can only be *set* at case creation (`participant_ids`) — to add/remove later you must call `/v1/participants` with `principal_type=test_case`; and the case's `estimated_workload` / `remaining_workload` are read-only projections of `/v1/workloads` entries. **No testhub principal is accepted by participants/workloads/reviews for `test_plan`.**

---

## 7. GOTCHAS

1. **`GET /v1/testhub/cases/{case_id}/histories` declares a WRITE scope** — `pcp:write:testhub:testcase` `[th#26]`, the only read endpoint in the module that does. Almost certainly a doc bug, but a token minted with read-only scopes may 403. Request both scopes if you need case history.
2. **Config-vs-domain scope split is inconsistent for the `library_id`-scoped lookup endpoints.** `GET /case/types?library_id=` and `GET /case/properties?library_id=` declare `pcp:read:testhub:testcase`, but the sibling `GET /case/states?library_id=` `[th#25]` and `GET /run/statuses?library_id=` `[th#57]` declare `pcp:read:testhub:configuration`. A CLI that only asks for `testcase`+`testplan` scopes will be unable to resolve state ids or status ids — i.e. unable to perform *any* write that needs `state_id` / `status_id`. **Always request `…:configuration` read scope.**
3. **Two different "history" shapes.** `/runs/{run_id}/histories` items carry `executed_status` (object) + `remark`; `/cases/{case_id}/histories` items carry a flat `status` string and no `remark` `[th#26]` vs `[th#55]`/`[th#58]`. Don't share a deserializer.
4. **The embedded `plan` reference uses `status`, but the plan resource uses `state`.** Inside a run/history, `plan` is `{id,url,name,status:"in_progress",start_at,end_at,short_id,html_url}` `[th#52]`, whereas `GET …/plans/{plan_id}` returns `state: {id,url,name,type:"in_progress"}` `[th#53]`. Same concept, different field name and different shape (string vs object).
5. **Writes take `*_id`s, reads return localized objects.** `status_id` (a config id) goes in; `status` (an English slug) plus `latest_executed_status.name` (a Chinese label such as 通过/未测) come out. There is **no documented endpoint that maps the slug `pass` to a `status_id`** — you must fetch `GET /v1/testhub/run/statuses?library_id=` and match, and the only join key offered is the localized `name` (GOTCHA 10).
6. **`GET /v1/testhub/cases` accepts `?tag_id` but no case response field exposes tags** `[th#22]` vs `[th#21]`. Filter-only, un-round-trippable; there is no testhub tag endpoint at all.
7. **`PATCH /v1/testhub/runs/{run_id}` requires `status_id`** `[th#61]` — you cannot PATCH only the `remark` or only the `executor_id`. Effectively every run update re-asserts a result.
8. **`executor_id` default is contradictory between PUT and PATCH.** PUT `[th#45]`: "不传默认执行人为空" (omitted ⇒ executor becomes **empty**). PATCH `[th#61]`: "不传默认执行人为执行用例的创建人" (omitted ⇒ executor becomes the run's **creator**). Both are destructive defaults: always send `executor_id` explicitly.
9. **`steps[]` is replace-not-merge — and this generalises, but only where documented.** Explicit "整体更新" (whole-object update) notes appear on:
   - `POST /cases` `steps` `[th#16]`, `PATCH /cases/{case_id}` `steps` `[th#28]`, `PATCH /cases/bulk` `cases.steps` `[th#19]`
   - `PATCH /runs/{run_id}` `steps` `[th#61]`
   - `PATCH /case_properties/{property_id}` **`options`** `[th#44]` — "options是整体更新的", i.e. the same semantics on a *different* array
   Where it is **not** stated: `PUT /runs/{run_id}` `steps` (moot — PUT is full-update and `steps` is required), `PATCH /runs/bulk` `runs.steps` `[th#50]`, `POST /libraries/{library_id}/plans/{plan_id}/runs/bulk` `updates.steps` `[th#49]`, `POST /cases/bulk` `cases.steps` `[th#18]`, and **`participant_ids`** / **`members`** / **`properties`**.
   **Assessment:** the pattern is "any array-valued body field is replaced wholesale", and it is confirmed for two independent arrays (`steps`, `options`). But it is *undocumented* for `participant_ids`, `members[]` and for the run-side bulk `steps` variants, and `properties` is a map (partial-merge is plausible there but unstated). Treat replace-semantics as the safe default for every array; read-modify-write rather than sending deltas.
   Corollary for `steps` specifically: a step object **without** `step_id` is treated as a new step and gets a fresh id `[th#19]`, `[th#28]` — so a naive resend that drops `step_id`s silently recreates every step and orphans results.
10. **`steps[].status_id` on a run must be a run-status id, and step grouping ids come from the case.** `steps.step_id` values originate in the case's `steps[]`; `steps.status_id` values originate in `run_statuses`. Group steps (`is_group: true`) use their own `step_id` as other steps' `group_id`, and "分组类型的步骤不需要该参数" (group steps must not carry `group_id`) `[th#16]`.
11. **`properties` is documented three different ways.** `POST /cases` declares `properties <Object>` with `properties.prop_a` children `[th#16]`; `POST /cases/bulk` declares `cases.properties` as **`<String>`** `[th#18]`; `PATCH /cases/bulk` declares `cases.properties` as **`<Object[]>`** and its prose claims "property中包含propertyKey、propertyValue和propertyType三个字段" `[th#19]` — yet **all four examples show a flat object map** `{"prop_a": "prop_a_value"}`. Trust the examples: a flat `{key: value}` map. The typed declarations and the propertyKey/propertyValue/propertyType prose are stale.
12. **Paging params are not declared on any testhub list endpoint.** No testhub record lists `page_size` / `page_index` as *request* parameters; they only appear as response fields. The `使用方式` overview record states the platform contract: pass `page_size` (default 30, **max 100**) and `page_index` (0-based) in the query string. Assume it works; the search endpoints are the only ones that declare paging explicitly (inside `payload`).
13. **No DELETE for plans, and no single-run DELETE.** Plans have POST/GET/PATCH only. Runs can only be deleted via `POST /libraries/{library_id}/plans/{plan_id}/runs/bulk` with `deletes[]` `[th#49]`, capped at 50 per call. A library itself also has no DELETE (only `is_archived`/`is_deleted` flags surfaced on reads).
14. **Suite deletion cascades silently.** `DELETE /libraries/{library_id}/suites/{suite_id}` removes all descendant modules `[th#6]`. There is no dry-run and no `force` flag.
15. **Bulk array limits differ per endpoint and two have none.** `cases[]` ≤ 100 `[th#18]`; `runs[]` ≤ 100 `[th#48]`; `inserts[]`/`updates[]`/`deletes[]` ≤ 50 each `[th#49]`. **`PATCH /cases/bulk` `[th#19]` and `PATCH /runs/bulk` `[th#50]` declare no limit** — assume 100 defensively.
16. **`POST /cases/bulk` cannot set `suite_id` or `type_id`; `PATCH /cases/bulk` cannot set `suite_id`.** Single-resource `POST /cases` supports both, and `PATCH /cases/{case_id}` supports `suite_id` `[th#16]`/`[th#28]` vs `[th#18]`/`[th#19]`. Bulk-imported cases therefore land in the default module and need a second per-case PATCH to be filed correctly.
17. **`POST /cases` cannot set `state_id`** (only PATCH can) `[th#16]` vs `[th#28]` — a newly created case always starts in the library's default state.
18. **`POST /libraries/{library_id}/members` declares the `member` object as optional** while its children `member.id`/`member.type` are required `[th#3]` — nonsensical as written; treat `member` as required.
19. **`GET` by `short_id` is supported unevenly.** `case_id` `[th#21]`, `run_id` `[th#52]` and `plan_id` on GET `[th#53]` explicitly accept "id或short_id"; but `PATCH …/plans/{plan_id}` `[th#62]`, `PATCH /cases/{case_id}` `[th#28]`, `DELETE /cases/{case_id}` `[th#17]`, `PATCH/PUT /runs/{run_id}` and `/cases/{case_id}/histories` `[th#26]` say "id" only. Don't feed a `short_id` into a write path.
20. **`GET /v1/testhub/cases` has no required `library_id`** — with no filters it queries every library the token can see, which is expensive and rate-limit relevant (200 req/min per identity, HTTP 429 with an `x-pc-retry-after` header, per the 频率限制 overview record).
21. **Run search cannot filter by library and cannot include deleted/archived.** `library.id` is on the runs-search exclusion list and `include_deleted`/`include_archived` are absent `[th#51]`. To scope runs to a library you must go through `plan.id`.
22. **The runs-search filter documentation is largely copy-pasted from the cases-search record.** It cites `title`, `description`, `precondition`, `test_type` and `properties.prop_a` as filterable — none of which are fields of the *run* resource (they belong to the embedded `case`). Whether `title` is silently resolved against `case.title` is **not determinable from `api_data.json`**; treat anything beyond the documented example (`title.contains`, `plan.id.in`, `latest_executed_status.id.in`) as unverified.
23. **`library` can be `null` on a case property plan** `[th#43]` — that is the org-level default plan. Don't assume the ref is populated.
24. **`estimated_workload` / `remaining_workload` are declared required but appear as `null`** in `POST /cases/bulk`'s own response example `[th#18]`. The same "declared required, observably nullable" pattern applies to `remark` `[th#52]`, `expected_value`, `group_id` and `actual_value`. Every "required" response field in this module should be modelled as nullable.
25. **Boolean-ish numbers are declared with string enums.** `is_archived`, `is_deleted`, `is_system` are `<Number>` with `allowedValues: ['0','1']` — string literals in the schema, integers `0`/`1` in the examples. Parse as integers.
26. **`identifier` on a library is described with copy-pasted project wording** — "项目的标识由大写英文字母/数字/下划线/连接线组成（不超过15个字符）" `[th#2]`, i.e. uppercase letters / digits / underscore / hyphen, ≤15 chars, unique per organisation. The rule is presumably right; the noun ("项目"/project) is wrong.
27. **`visibility` enum order differs between request and response** (`['public','private']` on create vs `['private','public']` on read) `[th#2]` — cosmetic, but a reminder that these lists are hand-maintained.
28. **`GET /case/suites?library_id=` duplicates `GET /libraries/{library_id}/suites`** with a different scope (`testcase` vs `library`) and without the `parent_id` filter `[th#24]` vs `[th#11]`. Prefer the library-scoped one for tree walking; prefer the `case/` one if your token lacks library scope.
29. **`POST /v1/relations` and friends declare no `scopes` at all** (empty array) — the requirement is only in prose inside the `principal_type` description. Don't drive scope selection off the machine-readable field for relations.
30. **Plan names are unique per library and case-module names unique per tree level** `[th#47]`, `[th#4]` — expect 4xx on collision, not silent dedupe.

---

## 8. Enum catalogue (exact slugs)

| Enum | Where | Values |
|---|---|---|
| Run execution status | `run.status`, `run.steps[].status`, run-history `status` `[th#45]`,`[th#46]`,`[th#52]`,`[th#61]`,`[th#26]` | `not_start` \| `pass` \| `block` \| `failure` \| `skip` |
| Case state type | `case.state.type` `[th#34]`,`[th#25]` | `pending` \| `completed` \| `closed` |
| Plan state type | `plan.state.type` `[th#63]`,`[th#53]` | `pending` \| `in_progress` \| `completed` |
| Case test type | `case.test_type` `[th#16]`,`[th#21]` | `automation` \| `manual` |
| Custom case property type | `case_properties.type` `[th#29]` | `text` \| `textarea` \| `select` \| `multi_select` \| `cascade_select` \| `cascade_multi_select` \| `member` \| `members` \| `date` \| `number` \| `progress` \| `rate` \| `link` |
| Library scope type | `library.scope_type` `[th#2]` | `organization` (企业可见 / org-wide) \| `user_group` (团队可见 / team-only) — default `organization` |
| Library visibility | `library.visibility` `[th#2]` | `public` (all org members) \| `private` (library members only) — default `private` |
| Member type | `members.type`, `library_member.type`, participant `type` `[th#2]`,`[th#8]` | `user` \| `user_group` |
| Bulk element state | `POST/PATCH /cases/bulk`, `/runs/bulk` `[th#18]`,`[th#48]` | `success` \| `failure` |
| System flag | `run_status.is_system`, `plan_state.is_system`, `is_archived`, `is_deleted` | `0` \| `1` |
| Search mode | `mode` `[th#20]`,`[th#51]` | `query` |
| Search operators | `payload.filter` `[th#20]`,`[th#51]` | `exists`, `contains`, `in`, `nin`, `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `between` |
| Relation principal types | `/v1/relations` | `idea` \| `ticket` \| `work_item` \| `test_plan` \| `test_run` \| `test_case` \| `page` |
| Relation target types | `/v1/relations` | `ticket` \| `work_item` \| `test_case` \| `idea` \| `page` |
| Property-plan `category` / `host` | `[th#33]` | example values `library` / `case` (full sets not declared) |
| Case-property-plan `library` | `[th#43]` | nullable (org default) |

**Run-status label mapping (INFERRED, not declared).** `GET /v1/testhub/run/statuses?library_id=`'s example `[th#57]` returns exactly five system statuses in this order with these localized names: 通过, 受阻, 失败, 跳过, 未测. Matched against the `status` slug enum, the mapping is almost certainly:

| Localized `name` | Inferred slug | Meaning |
|---|---|---|
| 通过 | `pass` | passed |
| 受阻 | `block` | blocked |
| 失败 | `failure` | failed |
| 跳过 | `skip` | skipped |
| 未测 | `not_start` | not started |

`api_data.json` never states this correspondence, and `run_statuses` items carry **no slug field** — only `id`, `url`, `name`, `is_system`. Tenants can also add custom statuses (`is_system: 0`), whose names will not be in this table. A CLI must therefore resolve `status_id` by fetching the library's status list and matching on `name`, and should let the user override the mapping.

---

## 9. Recommended MVP subset (15 endpoints)

Optimised for "read my test assets, run a plan, record results" with the minimum id-resolution machinery.

**Scopes required for this subset:** `pcp:read:testhub:library`, `pcp:read:testhub:testcase`, `pcp:write:testhub:testcase`, `pcp:read:testhub:testplan`, `pcp:write:testhub:testplan`, `pcp:read:testhub:configuration`.

| # | Endpoint | Why it's in the MVP |
|---|---|---|
| 1 | `GET /v1/testhub/libraries` | Entry point; nothing else is reachable without a `library_id`. |
| 2 | `GET /v1/testhub/libraries/{library_id}/suites` | Module tree for filing/browsing cases; has the `parent_id=root` walk that the `/case/suites` variant lacks. |
| 3 | `GET /v1/testhub/case/states?library_id=` | Resolves `state_id` — mandatory for any case status change. |
| 4 | `GET /v1/testhub/case/types?library_id=` | Resolves `type_id`. |
| 5 | `GET /v1/testhub/case_important_levels` | Resolves `important_level_id`; no library-scoped variant exists. |
| 6 | `GET /v1/testhub/run/statuses?library_id=` | Resolves `status_id` — **hard requirement for every run write** (GOTCHA 5/10). |
| 7 | `POST /v1/testhub/cases/search` | Primary case query; supersedes `GET /cases` for anything non-trivial and is the only way to filter on dates/custom properties. |
| 8 | `GET /v1/testhub/cases/{case_id}` | Full case incl. `steps[]` — needed before any read-modify-write of steps. Accepts `short_id`, so it backs `pc case show <SHORT>`. |
| 9 | `POST /v1/testhub/cases` | Case creation with `suite_id` + `type_id` (which the bulk variant cannot set). |
| 10 | `PATCH /v1/testhub/cases/{case_id}` | The only single-case mutator; also the only way to set `state_id` and to move a case between suites. |
| 11 | `GET /v1/testhub/libraries/{library_id}/plans` | Plan list; also the only place `?name`/`?created_between` filtering exists for plans. |
| 12 | `GET /v1/testhub/libraries/{library_id}/plans/{plan_id}` | Plan detail incl. pjm `project`/`sprint`/`version` links and the report `summary`. Accepts `short_id`. |
| 13 | `POST /v1/testhub/runs/search` | Primary run query — "what's left to execute in this plan", via `plan.id` + `latest_executed_status.id`. |
| 14 | `PATCH /v1/testhub/runs/{run_id}` | Record one result (status + remark + per-step actual values). The single most-used write in a test CLI. |
| 15 | `POST /v1/testhub/libraries/{library_id}/plans/{plan_id}/runs/bulk` | One call for add/update/**delete** of runs in a plan — the only delete path for runs, and it collapses three otherwise-separate bulk endpoints. |

### What was deliberately left out, and why

- **All configuration writes** (`POST/PATCH /case_properties`, `POST/DELETE …/case_property_plans/…/case_properties`, 4 endpoints): admin-console work, org-wide blast radius, rarely scripted. Read-only config resolution (#3–#6) is enough.
- **Library and member/suite writes** (`POST/PATCH /libraries`, all 4 member endpoints, `POST/PATCH/DELETE …/suites`, 8 endpoints): provisioning, not day-to-day testing. `DELETE suites` additionally cascades (GOTCHA 14) — bad first-release surface.
- **`POST …/plans` and `PATCH …/plans/{plan_id}`**: plan creation has awkward conditional requirements (`project_id` required iff sprint/version, type-dependent validity) that need plan-type introspection to do safely. Deferred until #11/#12 prove the plan model.
- **`POST /cases/bulk`, `PATCH /cases/bulk`, `POST /runs/bulk`, `PATCH /runs/bulk`**: importer features. `#15` already covers bulk run mutation within a plan, and the case bulk endpoints can't set `suite_id`/`type_id` (GOTCHA 16), so they'd need a follow-up PATCH per case anyway.
- **`PUT /runs/{run_id}`**: strictly worse than `PATCH` for a CLI — requires the whole `steps[]` array and blanks `executor` when `executor_id` is omitted (GOTCHA 8).
- **`POST /runs` (single)**: `#15`'s `inserts[]` covers it with better ergonomics and the same scope.
- **`DELETE /cases/{case_id}`**: destructive, unrecoverable via API (no undelete endpoint), and `include_deleted` filters suggest soft-delete semantics that aren't documented. Add behind a confirmation flag later.
- **History endpoints** (`/cases/{case_id}/histories`, `/runs/{run_id}/histories`, `/runs/{run_id}/histories/{history_id}`): reporting-only, and the case variant needs a *write* scope (GOTCHA 1) that would otherwise be unnecessary for a read-only invocation.
- **`GET /cases`, `GET /runs`** (simple lists): the docs themselves redirect to the search endpoints; keeping both doubles the filter surface for no capability gain. Exception worth revisiting: `GET /runs?plan_id=` needs no POST body, which is friendlier for shell one-liners.
- **`GET /run_statuses`, `GET /plan_states`, `GET /case_states`, `GET /case_types`, `GET /case_properties` (org-wide variants) and every single-item config GET** (~12 endpoints): the library-scoped list variants return the same items with the same ids and are the ones that reflect what a given library actually offers.
- **`GET /case/properties?library_id=`, `GET /case/suites?library_id=`**: needed only once custom-property editing lands; `#2` already covers suites.
- **`GET /libraries/{library_id}/plan_types[/{plan_type_id}]`**: only needed for plan *creation*, which is out of scope.
- **`/v1/relations` (defect linking)**: cross-module, and arguably the highest-value follow-up — but it needs pjm scopes and a pjm work-item resolver, so it belongs to a second milestone rather than the testhub MVP.

---

## 10. What could NOT be determined from `api_data.json`

1. **Slug↔id mapping for `run_statuses`, `case_states`, `plan_states`, `case_types`, `case_important_levels`.** Config items expose only `id` / `name` (localized) / sometimes `type`. The English slugs (`pass`, `not_start`, …) appear *only* as the value of the derived `status` field. There is no documented endpoint to look a config item up by slug, and no `key`/`slug`/`code` field. The §8 mapping is inference from example ordering.
2. **Value encoding for custom `properties` by type.** Examples only ever show `"prop_a": "prop_a_value"` (a string). How to write a `date` (timestamp? ms?), `member` / `members` (bare id? `{id}`? array?), `select` (option `_id` or `text`?), `cascade_multi_select` (path array?), `rate`, `progress` is **undocumented**. Only the search-side addressing (`properties.{key}`) and operator sets are specified.
3. **Whether `properties` merges or replaces on PATCH.** `steps` and `options` are explicitly whole-object; `properties` says nothing. Unknown whether omitting a key clears it.
4. **Whether `participant_ids` replaces or appends**, and whether it is settable at all after creation (it is absent from both PATCH shapes) — see GOTCHA 9.
5. **Actual paging support on testhub list endpoints.** No testhub record declares `page_size`/`page_index` as request params; only the platform overview does. Also unknown: whether `?page_size` is honoured on the `/case/*?library_id=` config views, and whether any list endpoint supports **sorting** (no `sort`/`order_by` param appears anywhere in the module).
6. **Complete value sets for `case_property_plans.category` and `.host`** — only the observed example values `library` / `case`.
7. **`plan_types` semantics.** `plan.type` is a free-form named reference; the doc says types "包括项目、发布和迭代" (project / release / sprint) and gates `sprint_id`/`version_id` on "type_id 代表迭代测试 / 发布测试", but there is **no type-kind discriminator field** on the plan-type resource (`id`, `url`, `library`, `name` only). Deciding whether a given `type_id` is a sprint test or a release test is only possible by matching its localized `name`.
8. **Error catalogue.** No testhub record documents any error response. Only the global overview gives the shape (`{code, message}`, HTTP 500 example) and the 429 rate-limit contract. Per-endpoint validation codes (duplicate plan name, identifier collision, bulk partial failure) are unknown.
9. **Bulk failure semantics.** Whether `POST/PATCH /cases/bulk` and `/runs/bulk` are atomic or best-effort, and whether the response array is index-aligned with the request array, is not stated — and the case-bulk records don't even declare the `message` field their run-bulk counterparts have.
10. **Webhook / Flow event names for testhub** — nothing in `api_data.json`; it documents only the REST surface (the 频率限制 record merely *mentions* PingCode Flow webhooks as a way to reduce polling).
11. **Archive/unarchive and restore operations.** `is_archived` / `is_deleted` are readable and filterable (`include_archived`, `include_deleted`) on libraries and cases, but **no endpoint sets them** — no `/archive`, `/restore`, and no `is_archived` write param anywhere in the module.
12. **Whether `test_type` (`automation|manual`) is writable.** It is returned on every case but is not a parameter of `POST /cases`, `POST /cases/bulk`, `PATCH /cases/{case_id}` or `PATCH /cases/bulk`. Presumably derived or UI-only.
13. **How `estimated_workload` / `remaining_workload` are populated** — read-only on the case; presumably aggregated from `/v1/workloads` with `principal_type=test_case`, but the relationship is not documented.
14. **Plan `summary` format** — plain text, Markdown or HTML is unspecified; likewise whether `description` / `precondition` / step `description` accept rich text. The existence of `include_public_image_token` for `description` and custom textarea fields implies HTML with embedded image references, but the markup contract is not documented.
15. **Deletion/restore of runs outside a plan context**, and what happens to a run's histories when its case is deleted. Not addressed.
