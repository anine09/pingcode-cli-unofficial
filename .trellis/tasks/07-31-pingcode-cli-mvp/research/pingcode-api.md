# PingCode Open Platform (REST API) — Research Reference

> Research date: 2026-07-31. Read-only research artifact for the `pingcode` CLI project.
> **Primary source of truth discovered: `https://open.pingcode.com/api_data.json` (2.3 MB, apiDoc format) — the complete machine-readable spec of all 460 endpoints.** See §5.

## 0. Doc pages / sources used

| URL | What it gave us |
|---|---|
| `https://open.pingcode.com/` | Landing page; JS SPA (apiDoc template) — useless to scrape directly |
| `https://open.pingcode.com/api_data.json` | **Full spec: 579 records, 460 real endpoints**, params, response fields, examples, scopes |
| `https://open.pingcode.com/api_data.js` | Same content, JSDoc `define({...})` wrapper |
| `https://open.pingcode.com/api_project.js` | Nav/ordering: top-level module tree (521 ordered entries) |
| `https://pingcode.apifox.cn/` | Third-party Apifox mirror of the "概述" (overview) chapter — human-readable envelope/rate-limit text |
| `https://blog.pingcode.com/bitbucket-app-for-pingcode/` | Confirms admin UI path: 后台管理 → 凭据管理 → 新建应用 (鉴权方式: Client Credentials; 权限 scope selection) |
| `https://github.com/brain-xai/pingcode_api` | Community (non-official) Go SDK attempt — PRD only, no usable code |

There is **no `openapi.json` / `swagger.json`** — probing those paths returns the SPA's `index.html` with HTTP 200 (soft-404). Verified by probing a nonsense path which returned the same HTML.

---

## 1. AUTH MODEL

### 1.1 Base URLs

```
REST root  (public cloud) : https://open.pingcode.com
REST root  (self-hosted)  : https://<your-domain>/open
OAuth2 root (public cloud): https://open.pingcode.com/oauth2
OAuth2 root (self-hosted) : https://<your-domain>/oauth2
```

URI pattern: `https://{rest_api_root}/v1[/{area}]/{resource}[/{action}]`
Examples: `/v1/myself`, `/v1/ship/products`, `/v1/pjm/work_items`, `/v1/testhub/cases/bulk`.

`area` values seen in practice: `pjm`, `ship`, `testhub`, `scm`, `directory`, `wiki`, `release`, `build`, `nexus`, `permission`, `security`, plus root-level `auth`, `myself`, `comments`, `attachments`, `relations`, `participants`, `activities`, `reviews`, `workloads`, `workload_types`.

### 1.2 Obtaining credentials

PingCode 企业后台 (admin backend) → **凭据管理** (Credential Management) → create an application:
- pick 鉴权方式 (grant type): **Client Credentials** or **Authorization Code**
- configure 数据范围 / 权限 (the scope set, see §1.6)
- you receive **`client_id`** + **`client_secret`** (and for authorization-code apps, you register the **`redirect_uri`** there)

There is **no** per-user "personal access token" concept. Everything goes through an app credential.

### 1.3 Flow A — Client Credentials → "企业令牌" (enterprise/org token) ← **recommended for a CLI**

```
GET https://open.pingcode.com/v1/auth/token
      ?grant_type=client_credentials
      &client_id={client_id}
      &client_secret={client_secret}
```
> ⚠️ It's a **GET with query-string params**, not the RFC-6749 `POST application/x-www-form-urlencoded`.

Response:
```json
{
  "access_token": "e7321ca8-f724-4abd-9169-d76d095c6acf",
  "token_type": "Bearer",
  "expires_in": 1577808000
}
```

Semantics (from doc prose):
- The token is **not tied to a user**; it carries **system-administrator privileges** across the org. Treat it as a secret of the highest sensitivity.
- **Validity: 30 days.**
- Deleting the app or resetting its Secret **immediately invalidates** the token.
- There is **no refresh_token** in this flow → just re-call the token endpoint.

### 1.4 Flow B — Authorization Code → "用户令牌" (user token)

Step 1 — send the user's browser to the authorization page (user must already be logged into PingCode):
```
GET https://open.pingcode.com/oauth2/authorize
      ?response_type=code
      &client_id={client_id}
```
Documented params are **only** `response_type` and `client_id`. `redirect_uri` is taken from the app's stored configuration; **`state` and `scope` are not documented** (scopes come from the app config, not the URL). After consent the browser is redirected to the pre-registered `redirect_uri` with `?code=...`.

Step 2 — exchange the code:
```
GET https://open.pingcode.com/v1/auth/token
      ?grant_type=authorization_code
      &client_id={client_id}
      &client_secret={client_secret}
      &code={code}
```
```json
{
  "access_token": "e7321ca8-...",
  "refresh_token": "f724-4abd-...",
  "token_type": "Bearer",
  "expires_in": 1577808000
}
```

Step 3 — refresh:
```
GET https://open.pingcode.com/v1/auth/token
      ?grant_type=refresh_token
      &refresh_token={refresh_token}
```
Returns a fresh `access_token` **and** a `refresh_token`.

Validity: `access_token` 30 days, `refresh_token` **90 days**. Deleting the app / resetting the Secret invalidates both immediately.

Token scope: a user token can only see data the owning user is permitted to see.

### 1.5 Authenticated request headers

```
Authorization: Bearer {access_token}
Content-Type: application/json      # required for POST/PUT/PATCH
```
- `GET`/`DELETE`: params via query string.
- `POST`/`PUT`/`PATCH`: params via JSON body.
- Methods supported: `OPTIONS / GET / PUT / PATCH / POST / DELETE`.

### 1.6 Scopes (46 total, format `pcp:{read|write}:{product}:{resource}`)

```
pcp:read:account:personal
pcp:read|write:global:team           pcp:read:global:permission
pcp:read|write:global:workload       pcp:read:global:security
pcp:read|write:pjm:project           pcp:read|write:pjm:workitem
pcp:read|write:pjm:sprint            pcp:read|write:pjm:board
pcp:read|write:pjm:release           pcp:read|write:pjm:configuration
pcp:read|write:ship:product          pcp:read|write:ship:idea
pcp:read|write:ship:ticket           pcp:read|write:ship:configuration
pcp:read|write:testhub:library       pcp:read|write:testhub:testcase
pcp:read|write:testhub:testplan      pcp:read|write:testhub:configuration
pcp:read|write:wiki:space            pcp:read|write:wiki:page
pcp:read|write:devops:code           pcp:read|write:devops:build
pcp:read|write:devops:deploy
pcp:storage:app
```
Almost every endpoint declares exactly one scope. **Exceptions with NO declared scope** (they inherit the scope of their `principal_type` — see §4 gotchas): all of `/v1/comments`, `/v1/attachments`, `/v1/participants`, `/v1/relations`, `/v1/activities`, `/v1/reviews`, and the three `bulk` endpoints `POST /v1/pjm/versions/bulk`, `POST /v1/pjm/sprints/bulk`.

---

## 2. RESPONSE ENVELOPE, PAGINATION, ERRORS, RATE LIMIT

### 2.1 Two resource shapes

Every resource type has a **full structure** (returned for single-GET and for items inside a paged list) and a **reference structure** (returned when embedded inside another resource).

```json
// full
{"id":"5e05d8448f8461dada9ba29c","url":"https://{root}/v1/{resource}","name":"…","desc":"…","created_at":1578897962}
// reference
{"id":"5e05d8448f8461dada9ba29c","url":"https://{root}/v1/{resource}","name":"…"}
```

### 2.2 Pagination envelope (uniform across ALL list endpoints)

```json
{
  "page_size": 30,
  "page_index": 0,
  "total": 100,
  "values": [ /* full structures */ ]
}
```
- Query params: `page_index` (**0-based**), `page_size`.
- Default `page_size` = **30**, max = **100**.
- Offset-based, **no cursor**.
- ⚠️ `page_index` / `page_size` are *global* conventions — most list endpoints do **not** list them in their own param docs, but they work.
- ⚠️ The `POST .../search` endpoints move them **into the body**: `payload.page_size`, `payload.page_index`.

### 2.3 Single-resource responses

The overview says single create/update/get/delete returns the resource body, with an example labelled `HTTP 状态码：201`. In practice expect `200` for GET and `201` for POST — the doc is imprecise here, so a CLI should treat **any 2xx as success** and not branch on the exact code.

### 2.4 Error shape

```
HTTP 500
{"code": "100000", "message": "Internal Server Error"}
```
- `code` is a **string of digits**, not an int.
- Standard HTTP status codes carry the class of error.
- Known codes: `100000` = Internal Server Error, `100038` = 请求频率过高 (rate limited).
- **No published error-code catalogue** — only these two appear anywhere in the docs. A CLI must degrade gracefully on unknown codes.

### 2.5 Rate limit

- **200 requests / minute per identity** (per token identity; not tiered by plan).
- On breach: `HTTP 429`, header **`x-pc-retry-after: <seconds>`**, body `{"code":"100038","message":"请求频率过高"}`.
- Retrying before expiry restarts the same 429.
- Official advice: cache slow-changing data; prefer PingCode **Flow** webhooks / HTTP actions for change notification instead of polling.
- → CLI should implement: respect `x-pc-retry-after`, exponential backoff, and cache config lookups (types/states/priorities/users).

---

## 3. API DOMAIN MAP

460 documented endpoints. Top-level nav modules (from `api_project.js`): 概述 · 鉴权 · 全局 · 组织 · 安全 · 通用 · 产品管理 · 产品配置中心 · 项目管理 · 项目配置中心 · 测试管理 · 测试配置中心 · 知识管理 · Storage · DevOps_数据集成.

| Area (URL segment) | Product | # eps | Main resources |
|---|---|---|---|
| `pjm` | **项目管理 / Agile** (Project) | 145 | `projects`, `work_items`, `sprints`, `boards`(+`entries`,`swimlanes`), `versions`(releases)+`stages`/`version_sections`/`version_categories`, `deliverables`, `processes`, and a large config surface: `work_item_types`/`_states`/`_properties`/`_tags`/`_priorities` + `*_plans` (scheme) endpoints, `project_properties`, `project_states` |
| `ship` | **产品管理 / Ship** (product, ideas, tickets) | 101 | `products` (+`members`,`suites`,`plans`,`tags`,`customers`,`users`,`channels`,`ticket_types`), `ideas` (需求), `tickets` (工单), plus `idea_*` / `ticket_*` config + `*_property_plans` / `*_state_plans` |
| `testhub` | **测试管理 / Testhub** | 65 | `libraries` (+`members`,`suites`,`plans`,`plan_types`), `cases` (+`bulk`,`search`,`histories`), `runs` (+`bulk`,`search`,`histories`), `case_types`/`case_states`/`case_properties`/`case_important_levels`/`run_statuses`/`plan_states` |
| `scm` | **DevOps 数据集成 – 代码** | 36 | `products` (托管平台: github/gitlab/bitbucket/coding.net/gogs/git/svn/gerrit/other), `repositories`, `branches`, `commits`, `refs`, `pull_requests`, `reviews`, platform `users` |
| `directory` | **目录服务 / Access (组织架构)** | 23 | `team` (enterprise info), `users` (企业成员, +`bulk`), `departments`, `groups` (团队, +`members`), `jobs` (职位), `roles` |
| `wiki` | **知识管理 / Wiki** | 19 | `spaces` (+`members`), `pages` (+`content`, `versions`, `versions/{id}/restore`) |
| `release` | **DevOps – 交付/部署** | 12 | `environments`, `deploys` |
| `reviews` | **通用 – 评审** | 8 | `reviews` (+`principals`) |
| `permission` | **全局 – 权限** | 7 | `permission/my/{global,pilot,principal}`, `permission/check/*`, `permission/points` |
| `build` | **DevOps – 构建** | 6 | `build/builds` |
| `nexus` | **Storage / CES** (custom entity store for apps) | 5 | `nexus/ces/{insert,find,update,delete,count}` — scope `pcp:storage:app` |
| `workloads` + `workload_types` | **全局 – 工时** | 7 | `workloads`, `workload_types` |
| `attachments` | 通用 – 附件 | 5 | upload file / upload snippet / get / list / delete |
| `participants` | 通用 – 关注人 | 4 | add/get/list/remove |
| `relations` | 通用 – 关联 | 4 | create/get/list/delete |
| `comments` | 通用 – 评论 | 4 | create/get/list/delete |
| `activities` | 通用 – 活动记录 | 2 | get/list |
| `security` | 安全 – 日志 | 2 | `security/audit_logs`, `security/login_logs` |
| `myself` | 全局 – 个人 | 1 | `GET /v1/myself` |
| `auth` | 鉴权 | 3 | token endpoints (§1) |

### Not exposed as REST endpoints
**Insight (效能度量), Goals (OKR), Flow (自动化), Plan (项目集/规模化敏捷)** have **no** documented REST endpoints. **Webhooks are not a REST resource either** — webhook/HTTP delivery is configured inside **PingCode Flow** in the product UI, so a CLI cannot manage subscriptions via the API.

### Cross-cutting "principal" model
Comments / attachments / participants / relations / activities / reviews are generic and addressed by `principal_type` + `principal_id`.
Allowed `principal_type` values (union across endpoints): `work_item`, `work_item_deliverable`, `test_case`, `test_run`, `test_plan`, `idea`, `ticket`, `page`. (Each endpoint accepts a subset — check per endpoint.)

---

## 4. MVP ENDPOINT TABLE (CLI-critical)

`{root}` = `https://open.pingcode.com`. All need `Authorization: Bearer …`.

| # | Purpose | Method + Path | Key params | Scope |
|---|---|---|---|---|
| 1 | Whoami / connectivity smoke test | `GET /v1/myself` | — | `pcp:read:account:personal` |
| 2 | List projects | `GET /v1/pjm/projects` | `keywords`, `type`(`scrum\|kanban\|waterfall\|hybrid`), `scope_type`(`organization\|user_group`), `scope_id`, `member_type`+`member_id`, `created_between`/`updated_between` (`"ts1,ts2"`), `include_deleted`, `include_archived`, `page_index`, `page_size` | `pcp:read:pjm:project` |
| 3 | Get one project | `GET /v1/pjm/projects/{project_id}` | `include_deleted`, `include_archived` | `pcp:read:pjm:project` |
| 4 | **List work items (simple)** | `GET /v1/pjm/work_items` | `project_id`, `identifier`, `type_id`, `parent_id`, `assignee_id`, `state_id`, `priority_id`, `sprint_id`, `board_id`/`entry_id`/`swimlane_id`, `phase_id`, `version_id`, `tag_id`, `bug_type_id`, `created_by`, `participant_id`, `keywords`, `include_public_image_token`, `include_deleted`, `include_archived` | `pcp:read:pjm:workitem` |
| 5 | **Search work items (advanced)** | `POST /v1/pjm/work_items/search` | body `{mode:"query", payload:{filter, keywords, page_size, page_index, include_deleted, include_archived, include_public_image_token}}` — see §4.1 | `pcp:read:pjm:workitem` |
| 6 | Get one work item | `GET /v1/pjm/work_items/{work_item_id}` | path accepts **`id` OR `short_id`**; `include_public_image_token`, `include_deleted`, `include_archived` | `pcp:read:pjm:workitem` |
| 7 | **Create work item** | `POST /v1/pjm/work_items` | **req:** `project_id`, `type_id`, `title`. **opt:** `description`, `start_at`, `end_at`, `priority_id`, `state_id`, `assignee_id`, `parent_id`, `sprint_id`, `version_ids[]`, `board_id`, `entry_id`, `swimlane_id`, `story_points`, `estimated_workload`, `remaining_workload`, `properties{}`, `participant_ids[]` | `pcp:write:pjm:workitem` |
| 8 | **Update work item (incl. state transition)** | `PATCH /v1/pjm/work_items/{work_item_id}` | any of `title`, `description`, `start_at`, `end_at`, `priority_id`, **`state_id`**, `assignee_id`, `parent_id`, `version_ids[]`, `board_id`, `entry_id`, `swimlane_id`, `phase_id`, `story_points`, `estimated_workload`, `remaining_workload`, `properties{}` | `pcp:write:pjm:workitem` |
| 9 | Bulk update one field | `PATCH /v1/pjm/work_items` | `{ids[] (max 100), property_name, property_value}` → `{inserts, updates, deletes}` | `pcp:write:pjm:workitem` |
| 10 | List work item **types** (for `type_id`) | `GET /v1/pjm/work_item/types?project_id=…` | `project_id` **req** | `pcp:read:pjm:workitem` |
| 11 | List work item **states** (for `state_id`) | `GET /v1/pjm/work_item/states?project_id=…&work_item_type_id=…` | both **req** | `pcp:read:pjm:workitem` |
| 12 | List priorities / tags / properties | `GET /v1/pjm/work_item/priorities?project_id=…` · `GET /v1/pjm/work_item/tags` · `GET /v1/pjm/work_item/properties?project_id=…&work_item_type_id=…` | | `pcp:read:pjm:workitem` |
| 13 | **List sprints/iterations** | `GET /v1/pjm/projects/{project_id}/sprints` | `name`, `status`(`pending\|in_progress\|completed`), `created_between`, `updated_between` | `pcp:read:pjm:sprint` |
| 14 | **List users (企业成员)** | `GET /v1/directory/users` | `keywords` (name/username fuzzy), `name`, `emails` (csv ≤20), `mobiles` (csv ≤20), `department_ids` (csv ≤20) | `pcp:read:global:team` |
| 15 | List departments / teams | `GET /v1/directory/departments` · `GET /v1/directory/groups` | | `pcp:read:global:team` |
| 16 | **List wiki spaces** | `GET /v1/wiki/spaces` | `scope_type`(`organization\|user_group\|user`), `scope_id`, `keywords`, `member_type`+`member_id`, `created_between`, `updated_between`, `include_*` | `pcp:read:wiki:space` |
| 17 | **List wiki pages** | `GET /v1/wiki/pages` | `space_id`, `parent_id` | `pcp:read:wiki:page` |
| 18 | **Get page body** | `GET /v1/wiki/pages/{page_id}/content` | `format_type` (`text\|markdown\|html\|block`), `version_id`, `include_public_image_token=content` → `{id,url,format_type,content,public_image_token}` | `pcp:read:wiki:page` |
| 19 | Create / update page | `POST /v1/wiki/pages` (`space_id`,`name` req; `parent_id`,`content`+`format_type`) · `PUT /v1/wiki/pages/{page_id}/content` | `content` and `format_type` must be sent **together** | `pcp:write:wiki:page` |
| 20 | **List test cases** | `GET /v1/testhub/cases` | `library_id`, `maintenance_id`, `state_id`, `important_level_id`, `tag_id`, `keywords`, `include_*` | `pcp:read:testhub:testcase` |
| 21 | Search / create test cases | `POST /v1/testhub/cases/search` (same `mode`/`payload` shape as #5) · `POST /v1/testhub/cases` (`test_library_id`,`title` req; `suite_id`,`type_id`,`important_level_id`,`maintenance_id`,`steps[]`,`precondition`,`properties{}`) · `POST\|PATCH /v1/testhub/cases/bulk` | | `pcp:*:testhub:testcase` |
| 22 | Test plans & runs | `GET /v1/testhub/libraries/{library_id}/plans` · `GET /v1/testhub/runs?plan_id=&case_id=&status_id=` · `PATCH /v1/testhub/runs/{run_id}` · `PATCH /v1/testhub/runs/bulk` | run `status` enum: `not_start\|pass\|block\|failure\|skip` | `pcp:*:testhub:testplan` |
| 23 | Ideas (需求) & Tickets (工单) | `GET\|POST /v1/ship/ideas`, `POST /v1/ship/ideas/search`, `PATCH /v1/ship/ideas/{idea_id}`; same for `/v1/ship/tickets` | ideas list: `product_id`,`state_id`,`priority_id`,`keywords` | `pcp:*:ship:idea` / `…:ticket` |
| 24 | **Comment on anything** | `POST /v1/comments` | `principal_type` **req**, `principal_id`, `content` **req**, `reply_comment_id`, `created_at`, `created_by`; list via `GET /v1/comments?principal_type=&principal_id=` | inherits principal's write scope |
| 25 | Attach a file | `POST /v1/attachments?principal_type=&principal_id=` (`type` = `file\|snippet`) | multipart for `file` | inherits principal's write scope |
| 26 | Log work (工时) | `POST /v1/workloads` · `GET /v1/workloads` · `GET /v1/workload_types` | | `pcp:*:global:workload` |
| 27 | Introspect own permissions | `GET /v1/permission/my/global` · `GET /v1/permission/points` | useful for CLI `doctor` command | `pcp:read:global:permission` |

### 4.1 Search filter DSL (`POST .../search`, applies to work_items, tickets, ideas, cases, runs)

`payload.filter` is a **MongoDB-like** object: `{ "<field>": { "<op>": <value> } }`.

- Reference fields are addressed as `{field}.id` → `project.id`, `assignee.id`, `versions.id`, `tags.id`, `participants.id`, `library.id`.
- Custom fields as `properties.{key}` → `properties.prop_a`.
- Operators by type:
  - text (`title`, `description`, custom text/textarea/link): `exists`, `contains`
  - enum (`type`): `exists`, `in`, `nin`
  - number (`story_points`, custom number/progress/rate): `exists`, `eq`, `ne`, `gt`, `lt`, `gte`, `lte`
  - datetime (`start_at`, `created_at`, custom date): `exists`, `gt`, `lt`, `gte`, `lte`, `between` (value `[startTs, endTs]`; **granularity is by DAY**)
  - option (select / multi_select / cascade_*): `exists`, `in`, `nin`
  - reference (`*.id`): `exists`, `in`, `nin`
- **One operator per field. No logical operators (`$and`/`$or`) supported.**
- **Not filterable:** `id`, `url`, `identifier`, `short_id`, `html_url`, `public_image_token`, `is_archived`, `is_deleted`.
- `payload.page_size` range 1–100; `payload.page_index` from 0.

Example:
```json
{"mode":"query","payload":{
  "filter":{
    "title":{"contains":"用户故事"},
    "assignee.id":{"nin":["315c85d24643678a9a0417f68e846aae"]},
    "project.id":{"in":["5eb623f6a70571487ea47000"]},
    "end_at":{"gte":1730000000}
  },
  "keywords":"xxx","page_size":10,"page_index":0}}
```

### 4.2 Key work-item response fields

`id`, `url`, `identifier` (e.g. `SCR-5`), `short_id` (e.g. `1bAqLmTG`), `html_url` (web UI deep link), `title`, `state{}`, `priority{}`, `assignee{}`, `project{}`, `parent{}`/`parent_id`, `sprint{}`, `versions[]`, `board{}`/`entry{}`/`swimlane{}`, `phase{}`, `description`, `start_at`, `end_at`, `completed_at`, `story_points`, `estimated_workload`, `remaining_workload`, `properties{}`, `tags[]`, `participants[]`, `created_at`/`created_by{}`, `updated_at`/`updated_by{}`, `is_archived` (0/1), `is_deleted` (0/1).

> ⚠️ **Corrected 2026-08-01 by live observation (`s8-smoke.md` F1): there is NO `type` field.** The
> docs imply `type` (`epic|feature|story|task|bug|issue|…`) is returned, and an earlier revision of
> this file listed it. It is absent from both `GET /v1/pjm/work_items` rows and the single-item
> `GET /v1/pjm/work_items/{id}` (verified on two items in a kanban project). A client that needs the
> type in order to resolve `state_id` **must take it from the user**; it cannot be read back.
> Observed key set on a kanban item: `created_at, created_by, description, html_url, id, identifier,
> is_archived, is_deleted, parent_id, participants, project, properties, short_id, state, tags, title,
> updated_at, updated_by, url, version, versions`. Note `version: null` **and** `versions: []` are both
> present, `project{}` includes `type` (the *project* type, e.g. `kanban`) and `state{}` includes a
> `type` grouping (e.g. `in_progress`) — neither is the work-item type.

> Note the list/search response uses **`versions` (array)** while single-GET docs show **`version` (object)** — a doc inconsistency; code defensively.

---

## 5. Machine-readable spec (no OpenAPI, but there IS a generator input)

- ❌ No `openapi.json`, no `swagger.json`, no Postman collection published.
- ✅ **`https://open.pingcode.com/api_data.json`** — the apiDoc data file (2,367,650 bytes), an array of 579 objects:
  ```
  {version, group, groupTitle, name, title, type, url, description,
   permission[], scopes[{name}], filename,
   parameter:{fields:{"路径参数"|"查询参数"|"Body"|"Parameter"|"请求参数":[{group,type,field,optional,description,allowedValues?}]}, examples:[…]},
   success:{fields:{"资源属性":[…]}, examples:[…]}}
  ```
  460 records have a `type` (real endpoints); the rest are chapter/section headers.
  **This is the right thing to codegen from** — write a small transformer `api_data.json → OpenAPI 3 / TS types`, and pin a checked-in copy so the CLI's surface is reproducible.
  `filename` even leaks the server-side source layout (`src/modules/v1/pingcode/...facade.ts`) which reveals module boundaries.
- Docs are Simplified-Chinese only. The site has a language selector but no separate English `api_data` file is served (probed `api_data.en.js`, `locales/en/api_data.js`, `en/api_data.js`, `i18n/en.js` → all soft-404).
- **No official SDK** in any language. Nothing on GitHub matches `open.pingcode.com/v1` in code search. The only related repo found is `github.com/brain-xai/pingcode_api` (a Go SDK **PRD document only**, no implementation, unofficial). PingCode's own GitHub presence is a marketplace App, not an API client.

---

## 6. GOTCHAS

**Auth**
1. Token endpoint is **GET with query params** — many HTTP client OAuth helpers assume POST+form and will fail.
2. `expires_in` is documented as "过期时间" and the example value `1577808000` is an **absolute Unix timestamp**, not a seconds-duration. Prose separately says validity = 30 days. → **Do not** compute `now + expires_in`. Store the raw value, detect which it is (`> 1e9` ⇒ absolute), and prefer proactive refresh + 401-triggered re-auth.
3. Client-credentials tokens have **system-admin authority org-wide**. For a CLI this means: never write it to a world-readable file, prefer OS keychain, and consider making authorization-code the default for interactive use.
4. Resetting the app Secret or deleting the app kills live tokens instantly → CLI needs a clean re-login path.
5. Authorization-code flow has **no `state` parameter documented** → CSRF protection is on you, and `redirect_uri` is server-side-registered only (cannot be overridden per-request, which complicates a loopback `http://127.0.0.1:PORT` CLI callback — the port must be fixed and pre-registered).
6. No token-introspection or revoke endpoint documented.

**Data formats**
7. **All timestamps are 10-digit Unix seconds** (not ms, not ISO-8601). Applies to `created_at`, `start_at`, `end_at`, `completed_at`, `published_at`, and to `created_between`/`updated_between` (format `"startTs,endTs"`).
8. IDs are **not uniform**: most resources use 24-char hex ObjectIds (`5eb623f6a70571487ea47000`), but **users use 32-char hex** (`a0417f68e846aae315c85d24643678a9`). Meanwhile **system work-item types and some enums use string slugs as their `id`** (`epic`, `feature`, `story`, `task`, `bug`, `issue`) while custom types use ObjectIds — so `type_id` is `string`, never assume hex.
9. Work items additionally have a **`short_id`** (e.g. `d9WqLmTO`) used in `html_url`. `GET /v1/pjm/work_items/{id}` accepts **either** `id` or `short_id` — great for a CLI that takes a pasted URL. Other endpoints (`PATCH`, `DELETE`) document only `id`.
10. `is_archived` / `is_deleted` are **numbers (0/1)**, not booleans. Deleted/archived rows are hidden unless you pass `include_deleted=true` / `include_archived=true`.
11. `/v1/scm/commits/{commit_id_or_sha}` accepts a SHA — the only such hybrid path.

**Semantics**
12. **State transitions are validated by workflow**, not free-form: a `state_id` is only accepted if it is in the work-item type's **state scheme** (`work_item_state_plans`) *and* a legal **transition** exists (`.../work_item_state_flows`). A CLI `pingcode issue transition` must therefore either (a) look up allowed flows first, or (b) surface the server's rejection clearly.
13. Many `*_id` params are **project/product/library-scoped** — `type_id`, `state_id`, `priority_id`, `properties.*` differ per project. You must resolve them via the per-project config endpoints (`/v1/pjm/work_item/types?project_id=…` etc.), which argues for a local cache keyed by project.
14. `board_id`/`entry_id`/`swimlane_id` only valid for `kanban`/`hybrid` projects; `sprint_id` only for `scrum`/`hybrid`; `phase_id` only for `waterfall`/`hybrid`. Passing them otherwise is silently invalid.
15. `properties` (custom fields) must already be attached to the type's **property scheme**, or the write is rejected.
16. Test-case `steps[]` is **replace-whole-array**, not merge.
17. Generic endpoints (`comments`, `attachments`, `participants`, `relations`, `activities`) declare **no scope of their own** — the required scope depends on `principal_type` (e.g. `principal_type=work_item` ⇒ needs `pcp:*:pjm:workitem`; `test_case` ⇒ `pcp:*:testhub:testcase`). Scope errors will look confusing; document this in CLI error messages.
18. `POST /v1/comments` accepts `created_at` and `created_by` overrides — an import/migration affordance that only works with an admin-level (client-credentials) token.
19. Rich text: `description` and multiline custom fields may contain images whose URLs need a token; request `include_public_image_token=description,properties.prop_b` (max 32 fields, comma-separated) to get `public_image_token`. Wiki content uses `include_public_image_token=content` and only for `format_type` in `markdown|html|block`.
20. Two tiers of listing per entity: `GET …` (simple, indexed single-field filters) vs `POST …/search` (MongoDB-ish, no boolean logic). Neither supports **sorting** — verified: across all 460 endpoints the only `sort` parameter in the entire spec is `options.sort{property_key, order}` on `POST /v1/nexus/ces/find` (the CES custom-entity store). So business-resource ordering must be client-side, which interacts badly with pagination on large sets.
    Likewise, `page_index`/`page_size` appear in the documented parameter lists of only the 5 `POST …/search` endpoints (as `payload.page_index`/`payload.page_size`); on `GET` list endpoints they are undocumented-but-global query params.
21. Bulk endpoints cap at **100 items** (`PATCH /v1/pjm/work_items`).
22. `POST /v1/pjm/versions/bulk` and `POST /v1/pjm/sprints/bulk` are undocumented for scopes and look newer/less stable than their non-bulk siblings.

**Versioning / coverage**
23. Everything is `v1`; apiDoc `version` is `1.0.0` for all 579 records. **No deprecation markers anywhere**, and no changelog on the API doc site (product changelog lives at `blog.pingcode.com` and does not track API changes).
24. No REST surface for **Insight / Goals / Flow / Plan**, and **webhooks are not manageable via API** (Flow UI only). A CLI cannot offer `pingcode webhook create`.
25. Self-hosted installs put the API under `<domain>/open` and OAuth under `<domain>/oauth2` → make the base URL a first-class config value (`--host` / `PINGCODE_HOST`), don't hardcode `open.pingcode.com`.
26. Docs are Chinese-only; enum *values* are English slugs but all descriptions are Chinese — plan for the CLI's own English help text.

**Observed live, 2026-08-01 (public cloud) — see `s8-smoke.md` for the raw evidence**

27. **Work-item payloads carry no `type` field at all** (see the §4.2 correction). This is the single
    biggest surprise of the smoke run: it breaks any name→id resolution for `state_id` that hoped to
    read the type back off the resource, because `GET /v1/pjm/work_item/states` requires
    `work_item_type_id`. The type has to be supplied by the caller.
28. **Token payload is exactly `{access_token, token_type:"Bearer", expires_in}`** — no `scope`, no
    `refresh_token`. `expires_in` is an **absolute unix-seconds epoch** in production (observed
    `1788105520` for a call at `1785513519`, i.e. +30 days), *not* a duration: `now + expires_in` is
    catastrophically wrong. Repeated `client_credentials` acquisitions **coexist** — a new token does
    not rotate or revoke the previous one — so parallel CLI invocations cannot 401 each other. (Probed
    only for two tokens seconds apart; per-app caps and expiry-side revocation were not tested.)
29. **This API returns HTTP 400 where REST convention uses 401/404.** Observed error codes, all on
    `400`: `100024` `'client_id'或'client_secret'错误` (token endpoint, wrong credentials),
    `100317` 工作项资源不存在 (`GET` an unknown work-item id), `100303` `'state'资源不存在` (`PATCH`
    with an unknown `state_id`). A status-only error mapping therefore never reaches its
    "unauthenticated" or "not found" branches. An invalid **bearer token on a resource endpoint does
    return a real 401**, so only failure *classification* is affected, not token refresh.
30. **2xx responses carry no rate-limit headers** (only `Date`, `traceparent`, HSTS,
    `Server: openresty`), so the 200 req/min budget is invisible until a `429` actually lands — a
    client cannot pace itself from response metadata.
31. **`page_index` / `page_size` are confirmed honoured on `GET` list endpoints** despite being
    undocumented there (gotcha 20). Verified on `GET /v1/pjm/work_items`: `page_size` really limits the
    row count, `page_index` is 0-based and really offsets, both are echoed back unchanged, `total`
    ignores paging, and a page past the end returns an empty `values` rather than an error. Ordering
    was stable by identifier across calls and pages did not overlap. Server-side filters compose with
    paging (`total` changes correctly). Full observation table in `s8-smoke.md` G5-1.
32. Confirmed in passing: system work-item type ids are bare slugs (`epic/feature/story/task/bug/issue`),
    state and priority ids are 24-hex, user ids are 32-hex (gotcha 8 holds); kanban items carry
    `board`/`entry`/`swimlane` and `properties.{entry_status,entry_position,operation_time,…}`;
    `sprints` is empty for a kanban project (gotcha 14 holds).

---

## 7. Implications for CLI architecture (condensed)

- **Config**: `base_url` (default `https://open.pingcode.com`), `oauth2_url`, `client_id`, `client_secret`, grant type, token cache (keychain first, file `0600` fallback), `access_token`+`refresh_token`+expiry.
- **Transport layer**: single client that injects `Authorization: Bearer`, sets JSON content-type on write verbs, auto-refreshes on 401, honours `x-pc-retry-after` on 429 with capped backoff, and normalizes `{code, message}` into a typed error.
- **Pagination helper**: one generic `paginate<T>(path, params) → AsyncIterable<T>` over `{page_index, page_size, total, values}` handles ~every list endpoint; a second variant for `POST /search` where paging lives in `payload`.
- **Metadata resolver + cache**: name→id resolution for projects, work-item types, states, priorities, users, sprints (cache aggressively; rate limit is only 200/min).
- **Codegen**: vendor `api_data.json`, generate types/paths from it; do not hand-transcribe 460 endpoints.
- **Timestamps**: convert seconds↔local at the presentation boundary only.
