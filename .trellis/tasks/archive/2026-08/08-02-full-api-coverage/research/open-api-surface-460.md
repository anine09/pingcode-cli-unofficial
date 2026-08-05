<task id="ses_03d661f82ffewOGoHgYNMBJgWz" state="completed">
<task_result>
I now have the complete picture. Here is the report.

---

# PingCode Open API — Complete Surface Map

**Research date:** 2026‑08‑02 · **Doc build timestamp:** `2026-07-27T09:00:39Z` (from `api_project.js`, apiDoc 0.20.1)

## 0. How this map was obtained (methodology + reproducibility)

`https://open.pingcode.com` is an **apiDoc**-generated single-page site rendered client-side with Handlebars — plain fetching returns only a shell. There is **no OpenAPI/Swagger spec and no sitemap** (the host returns `index.html` with HTTP 200 for *every* unknown path, so `sitemap.xml`, `/docs`, `/en/` etc. are all false positives — verified by identical 21,251-byte bodies).

The complete API surface is in two machine-readable bundles:

| Artifact | Size | Contents |
|---|---|---|
| `https://open.pingcode.com/api_data.js` | 2,367,670 B | **579 entries** = 460 endpoints + 119 nav/section stubs (简体中文, current) |
| `https://open.pingcode.com/api_project.js` | 17,598 B | nav ordering (521 entries), generator metadata |
| `https://open.pingcode.com/api_data_en.js` | 1,663,585 B | **417 entries = 347 endpoints** (English, **STALE** — see §8) |

Both are `define({...})` AMD wrappers. Everything below is derived from the **Chinese bundle**, which is authoritative and current.

> **Counts:** 460 endpoints across 50 endpoint-bearing groups. Methods: `GET` 250, `POST` 96, `PATCH` 54, `DELETE` 49, `PUT` 10.

**Per-endpoint doc URL formula** (apiDoc anchor, confirmed from the `id="api-{{group}}-{{name}}"` template in `index.html`):

```
https://open.pingcode.com/#api-<percent-encoded group>-<percent-encoded name>
```

e.g. 获取工作项列表 → `https://open.pingcode.com/#api-%E5%B7%A5%E4%BD%9C%E9%A1%B9-%E8%8E%B7%E5%8F%96%E5%B7%A5%E4%BD%9C%E9%A1%B9%E5%88%97%E8%A1%A8`

Because the per-endpoint anchors are ~200-char percent-encoded strings, the tables below cite **group-level doc URLs** (listed in §9), which is what you'd want in a PRD anyway. Applying the formula above to any row yields its exact anchor.

---

## 1. Auth model

Two OAuth2 flows. Docs: [鉴权 → 客户端凭据](https://open.pingcode.com/#api-%E5%AE%A2%E6%88%B7%E7%AB%AF%E5%87%AD%E6%8D%AE) · [鉴权 → 授权码](https://open.pingcode.com/#api-%E6%8E%88%E6%9D%83%E7%A0%81)

### 1.1 Client Credentials → 企业令牌 ("enterprise token")

```
GET https://open.pingcode.com/v1/auth/token
      ?grant_type=client_credentials&client_id=...&client_secret=...
```
Response:
```json
{ "access_token": "e7321ca8-...", "token_type": "Bearer", "expires_in": 1577808000 }
```
> 客户端凭据模式（OAuth2 Client Credentials）… 通过该方式获取的访问令牌（access_token）不区分用户身份，在 PingCode 中被称为**企业令牌**。**企业令牌拥有系统管理员权限**，主要用于访问、操作全局数据，请谨慎保管。

- Credentials come from PingCode 企业后台 → **凭据管理** (create app, configure data scope).
- **Lifetime: 30 days.** No refresh token for this flow — just re-request.
- Deleting the app or resetting the Secret **immediately invalidates** the token.

### 1.2 Authorization Code → 用户令牌 ("user token")

```
1) GET https://open.pingcode.com/oauth2/authorize?response_type=code&client_id=...
2) GET https://open.pingcode.com/v1/auth/token
        ?grant_type=authorization_code&client_id=...&client_secret=...&code=...
3) GET https://open.pingcode.com/v1/auth/token
        ?grant_type=refresh_token&refresh_token=...
```
- User must already be logged into PingCode before hitting `/authorize`; redirect goes to the app's configured `redirect_uri` with `code` in the query string.
- `access_token` **30 days**; `refresh_token` **90 days**. Refresh returns a new `access_token` **and** a new `refresh_token`.
- Token is scoped to that user — only data within their permissions.

### 1.3 Request headers

| Header | When | Value |
|---|---|---|
| `Authorization` | always | `Bearer {access_token}` |
| `content-type` | `POST`/`PUT`/`PATCH` | `application/json` |
| `content-type` | `POST /v1/attachments` (file) | `multipart/form-data` |
| `content-type` | `POST /v1/attachments` (code snippet) | `application/json` |

⚠️ Note the **token endpoints are `GET` with credentials in the query string**, not the RFC‑6749-standard `POST` form body. A CLI must not log these URLs.

### 1.4 Scopes model

46 distinct scopes, format `pcp:{read|write}:{domain}:{resource}` (+ one special `pcp:storage:app`):

| Domain | Scopes |
|---|---|
| `account` | `read:account:personal` |
| `global` | `read/write:global:team`, `read:global:permission`, `read:global:security`, `read/write:global:workload` |
| `pjm` | `read/write:pjm:` × `project`, `workitem`, `sprint`, `release`, `board`, `configuration` |
| `ship` | `read/write:ship:` × `product`, `idea`, `ticket`, `configuration` |
| `testhub` | `read/write:testhub:` × `library`, `testcase`, `testplan`, `configuration` |
| `wiki` | `read/write:wiki:` × `space`, `page` |
| `devops` | `read/write:devops:` × `code`, `build`, `deploy` |
| storage | `pcp:storage:app` (Nexus/CES only) |

**Token-type requirements** across the 460 endpoints: 388 accept **either** token, **61 require 企业令牌 only**, **7 require 用户令牌 only**. See §7.

⚠️ 33 endpoints (all of `附件`/`评论`/`关注人`/`关联`/`活动记录`/`评审` — the cross-cutting "通用" resources) declare a token type but **no scope at all**. Uncertain whether they are scope-exempt or whether the docs simply omit it. **Needs live verification.**

---

## 2. Base URL & versioning

[概述 → URI结构](https://open.pingcode.com/#api-URI%E7%BB%93%E6%9E%84)

```
https://{rest_api_root}/v1[/{area}]/{resource}[/{action}]
```

| `rest_api_root` | Value |
|---|---|
| Public cloud | `open.pingcode.com` |
| Private deployment | `{custom-domain}/open` |
| Other | context-provided |

`oauth2_root`: `open.pingcode.com/oauth2` (public cloud) / `{custom-domain}/oauth2`.

**Versioning:** a single hard-coded `v1` path segment. Every one of the 460 endpoints is `v1`. `api_project.js` reports `version: "1.0.0"`, `defaultVersion: "0.0.0"` — apiDoc scaffolding, not a real API version axis. There is **no** version header, no `v2`, and no documented deprecation/sunset policy.

**`area` values observed** (the real namespace axis — useful as CLI top-level command groups):
`pjm` (145) · `ship` (101) · `testhub` (65) · `scm` (36) · `directory` (23) · `wiki` (19) · `release` (12) · `reviews` (8) · `permission` (7) · `build` (6) · `nexus` (5) · `workloads` (5) · `attachments` (5) · `auth` (3) · `participants` (4) · `relations` (4) · `comments` (4) · `activities` (2) · `security` (2) · `workload_types` (2) · `myself` (1)

Server-side module layout (leaked via apiDoc `filename`, e.g. `src/modules/v1/pingcode/agile/...`) confirms the product grouping: `agile` (163), `ship` (126), `global` (93), `testhub` (91), `devops` (68), `wiki` (21), `nexus/ces` (6), `authorization` (6).

---

## 3. Full endpoint inventory by module

Legend: **ENT** = 企业令牌 only · **USER** = 用户令牌 only · **both** = either. Scope shown without the `pcp:` prefix.

### 3.1 鉴权 Auth (4)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/auth/token?grant_type=client_credentials` | Get enterprise token |
| GET | `/v1/auth/token?grant_type=authorization_code` | Get user token from code |
| GET | `/v1/auth/token?grant_type=refresh_token` | Refresh user token |
| GET | `{oauth2_root}/authorize?response_type=code` | Authorization page (browser redirect) |

### 3.2 全局 Global — 个人 Personal (1)

| Method | Path | Purpose | Token / Scope |
|---|---|---|---|
| GET | `/v1/myself` | Current user profile | USER · `read:account:personal` |

### 3.3 组织架构 Directory (23) — all `both` · `read/write:global:team`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/directory/team` | Get enterprise info |
| POST | `/v1/directory/users` | Create enterprise member |
| GET | `/v1/directory/users` | List enterprise members |
| GET | `/v1/directory/users/{user_id}` | Get one member |
| PATCH | `/v1/directory/users/{user_id}` | Partially update member |
| PATCH | `/v1/directory/users/bulk` | **Bulk** update member properties |
| POST | `/v1/directory/departments` | Create department |
| GET | `/v1/directory/departments` | List departments |
| GET | `/v1/directory/departments/{department_id}` | Get one department |
| PATCH | `/v1/directory/departments/{department_id}` | Partially update department |
| DELETE | `/v1/directory/departments/{department_id}` | Delete department |
| POST | `/v1/directory/groups` | Create team/group |
| GET | `/v1/directory/groups` | List teams |
| GET | `/v1/directory/groups/{group_id}` | Get one team |
| PATCH | `/v1/directory/groups/{group_id}` | Partially update team |
| POST | `/v1/directory/groups/{group_id}/members` | Add member to team |
| GET | `/v1/directory/groups/{group_id}/members` | List team members |
| GET | `/v1/directory/groups/{group_id}/members/{member_id}` | Get one team member |
| DELETE | `/v1/directory/groups/{group_id}/members/{member_id}` | Remove team member |
| GET | `/v1/directory/roles` | List roles |
| GET | `/v1/directory/roles/{role_id}` | Get one role |
| GET | `/v1/directory/jobs` | List positions |
| GET | `/v1/directory/jobs/{job_id}` | Get one position |

⚠️ No `DELETE /v1/directory/users/{id}` and no `DELETE /v1/directory/groups/{id}` — members/teams cannot be deleted via API (deactivation presumably via `PATCH`).

### 3.4 权限 Permission (7) · `read:global:permission`

| Method | Path | Purpose | Token |
|---|---|---|---|
| GET | `/v1/permission/points` | All permission-point definitions (keyed `global`,`pjm`,`ship`,`testhub`,`wiki`) | both |
| GET | `/v1/permission/my/global` | My global permissions | USER |
| GET | `/v1/permission/my/pilot` | My permissions on a Pilot | USER |
| GET | `/v1/permission/my/principal` | My permissions on a Principal | USER |
| POST | `/v1/permission/check/global` | Batch-check my global permissions by key | USER |
| POST | `/v1/permission/check/pilot` | Batch-check my Pilot permissions → `{key: {pilot_ids: []}}` | USER |
| POST | `/v1/permission/check/principal` | Batch-check my Principal permissions → `{key: {principal_ids: []}}` | USER |

> "Pilot" = container-level object (project/product/library/space); "Principal" = the work object itself (work item/ticket/idea/case/page). This vocabulary recurs across the 通用 endpoints below.

### 3.5 安全日志 Security (2) · both · `read:global:security`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/security/login_logs` | List login logs |
| GET | `/v1/security/audit_logs` | List audit logs |

### 3.6 工时 Worklogs (7) · both · `read/write:global:workload`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/workloads` | Create worklog |
| GET | `/v1/workloads` | List worklogs |
| GET | `/v1/workloads/{workload_id}` | Get one worklog |
| PATCH | `/v1/workloads/{workload_id}` | Partially update worklog — *user token can only update own* |
| DELETE | `/v1/workloads/{workload_id}` | Delete worklog — *user token can only delete own* |
| GET | `/v1/workload_types` | List worklog types |
| GET | `/v1/workload_types/{type_id}` | Get one worklog type |

### 3.7 通用 Cross-cutting resources (27) · all `both` · **no declared scope**

These are the polymorphic attachments/comments/followers/relations/activities/reviews layer, addressed via `principal_type` + `principal_id`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/attachments?principal_type=&principal_id=` | Upload a file (`multipart/form-data`) |
| POST | `/v1/attachments` | Upload a code snippet (`application/json`) |
| GET | `/v1/attachments?principal_type=&principal_id=` | List attachments |
| GET | `/v1/attachments/{attachment_id}` | Get one attachment |
| DELETE | `/v1/attachments/{attachment_id}?principal_type=&principal_id=` | Delete attachment |
| POST | `/v1/comments` | Create comment |
| GET | `/v1/comments?principal_type=&principal_id=` | List comments |
| GET | `/v1/comments/{comment_id}` | Get one comment |
| DELETE | `/v1/comments/{comment_id}?principal_type=&principal_id=` | Delete comment |
| POST | `/v1/participants` | Add a follower |
| GET | `/v1/participants?principal_type=&principal_id=` | List followers |
| GET | `/v1/participants/{participant_id}` | Get one follower |
| DELETE | `/v1/participants/{participant_id}?principal_type=&principal_id=` | Remove follower |
| POST | `/v1/relations` | Create a relation |
| GET | `/v1/relations?principal_type=&principal_id=&target_type=` | List relations |
| GET | `/v1/relations/{relation_id}` | Get one relation |
| DELETE | `/v1/relations/{relation_id}` | Delete relation |
| GET | `/v1/activities?principal_type=&principal_id=` | List activity records |
| GET | `/v1/activities/{activity_id}` | Get one activity record |
| POST | `/v1/reviews` | Create a review |
| GET | `/v1/reviews?principal_type=&pilot_id=` | List reviews |
| GET | `/v1/reviews/{review_id}` | Get one review |
| DELETE | `/v1/reviews/{review_id}?principal_type=` | Delete review |
| POST | `/v1/reviews/{review_id}/principals` | Add review content |
| GET | `/v1/reviews/{review_id}/principals?principal_type=` | List review contents |
| GET | `/v1/reviews/{review_id}/principals/{principal_id}?principal_type=` | Get one review content |
| DELETE | `/v1/reviews/{review_id}/principals/{principal_id}?principal_type=` | Remove review content |

---

### 3.8 PJM — 项目管理 / 敏捷开发 (145)

#### 3.8.1 项目 Project (17) — [doc](https://open.pingcode.com/#api-%E9%A1%B9%E7%9B%AE)

| Method | Path | Purpose | Scope |
|---|---|---|---|
| POST | `/v1/pjm/projects` | Create project | `write:pjm:project` |
| GET | `/v1/pjm/projects` | List projects | `read:pjm:project` |
| GET | `/v1/pjm/projects/{project_id}` | Get one project | `read:pjm:project` |
| PATCH | `/v1/pjm/projects/{project_id}` | Partially update project | `write:pjm:project` |
| POST | `/v1/pjm/projects/{project_id}/clone` | Clone project | `write:pjm:project` |
| GET | `/v1/pjm/projects/{project_id}/progress` | Get project progress | `read:pjm:project` |
| POST | `/v1/pjm/projects/{project_id}/local_config/enable` | Enable project-local configuration | `write:pjm:project` |
| POST | `/v1/pjm/projects/{project_id}/members` | Add project member | `write:pjm:project` |
| GET | `/v1/pjm/projects/{project_id}/members` | List project members | `read:pjm:project` |
| GET | `/v1/pjm/projects/{project_id}/members/{member_id}` | Get one project member | `read:pjm:project` |
| PATCH | `/v1/pjm/projects/{project_id}/members/{member_id}` | Update project member | `write:pjm:project` |
| DELETE | `/v1/pjm/projects/{project_id}/members/{member_id}` | Remove project member | `write:pjm:project` |
| POST | `/v1/pjm/projects/{project_id}/project_properties` | Attach project property | `write:pjm:configuration` |
| GET | `/v1/pjm/projects/{project_id}/project_properties` | List project's properties | `read:pjm:configuration` |
| GET | `/v1/pjm/projects/{project_id}/project_properties/{property_id}` | Get one project property | `read:pjm:configuration` |
| DELETE | `/v1/pjm/projects/{project_id}/project_properties/{property_id}` | Detach project property | `write:pjm:configuration` |
| GET | `/v1/pjm/project/states?project_id=` | List project states | `read:pjm:project` |

⚠️ **No `DELETE /v1/pjm/projects/{id}`** — projects cannot be deleted via API.

#### 3.8.2 项目配置 Project configuration (7) — [doc](https://open.pingcode.com/#api-%E9%A1%B9%E7%9B%AE%E9%85%8D%E7%BD%AE)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/pjm/project_properties` | Create project property |
| GET | `/v1/pjm/project_properties` | List project properties |
| GET | `/v1/pjm/project_properties/{property_id}` | Get one project property |
| PATCH | `/v1/pjm/project_properties/{property_id}` | Partially update project property |
| GET | `/v1/pjm/project_states/{state_id}` | Get one project state |
| GET | `/v1/pjm/processes` | List all project processes (Scrum/Kanban/Waterfall templates) |
| GET | `/v1/pjm/processes/{process_id}` | Get one project process |

#### 3.8.3 工作项 Work items (28) — [doc](https://open.pingcode.com/#api-%E5%B7%A5%E4%BD%9C%E9%A1%B9)

This is the CLI's centre of gravity. 缺陷/Bug, 用户故事/Story, 任务/Task etc. are all *work item types*, not separate endpoints (9 system types + custom).

| Method | Path | Purpose | Scope |
|---|---|---|---|
| POST | `/v1/pjm/work_items` | Create work item | `write:pjm:workitem` |
| GET | `/v1/pjm/work_items` | **Simple** list (flat query params) | `read:pjm:workitem` |
| POST | `/v1/pjm/work_items/search` | **Advanced search** (Mongo-like filter DSL) | `read:pjm:workitem` |
| GET | `/v1/pjm/work_items/{work_item_id}` | Get one work item | `read:pjm:workitem` |
| PATCH | `/v1/pjm/work_items/{work_item_id}` | Partially update work item | `write:pjm:workitem` |
| PATCH | `/v1/pjm/work_items` | **Bulk** partial update | `write:pjm:workitem` |
| DELETE | `/v1/pjm/work_items/{work_item_id}` | Delete work item | `write:pjm:workitem` |
| POST | `/v1/pjm/work_items/{work_item_id}/relations` | Relate a work item | `write:pjm:workitem` |
| GET | `/v1/pjm/work_items/{work_item_id}/relations` | List related work items | `read:pjm:workitem` |
| GET | `/v1/pjm/work_items/{work_item_id}/relations/{relation_id}` | Get one relation | `read:pjm:workitem` |
| DELETE | `/v1/pjm/work_items/{work_item_id}/relations/{relation_id}` | Unrelate | `write:pjm:workitem` |
| POST | `/v1/pjm/work_items/{work_item_id}/tags` | Add tag to work item | `write:pjm:workitem` |
| GET | `/v1/pjm/work_items/{work_item_id}/tags/{tag_id}` | Get one tag on work item | `read:pjm:workitem` |
| DELETE | `/v1/pjm/work_items/{work_item_id}/tags/{tag_id}` | Remove tag from work item | `write:pjm:workitem` |
| GET | `/v1/pjm/work_items/{work_item_id}/transition_histories` | List transition history | `read:pjm:workitem` |
| GET | `/v1/pjm/work_items/{work_item_id}/transition_histories/{transition_history_id}` | Get one transition record | `read:pjm:workitem` |
| GET | `/v1/pjm/work_item/types?project_id=` | List work item types (in project ctx) | `read:pjm:workitem` |
| GET | `/v1/pjm/work_item/states?project_id=&work_item_type_id=` | List states (in ctx) | `read:pjm:workitem` |
| GET | `/v1/pjm/work_item/properties?project_id=&work_item_type_id=` | List properties (in ctx) | `read:pjm:workitem` |
| GET | `/v1/pjm/work_item/priorities?project_id=` | List priorities (in ctx) | `read:pjm:workitem` |
| GET | `/v1/pjm/work_item/tags` | List work item tags | `read:pjm:workitem` |
| GET | `/v1/pjm/work_item/relation_types` | List relation types | `read:pjm:workitem` |
| GET | `/v1/pjm/work_item_relation_types/{relation_type_id}` | Get one relation type | `read:pjm:workitem` |
| POST | `/v1/pjm/deliverables` | Create deliverable target | `write:pjm:project` |
| GET | `/v1/pjm/deliverables` | List deliverable targets | `read:pjm:project` |
| GET | `/v1/pjm/deliverables/{deliverable_target_id}` | Get one deliverable target | `read:pjm:project` |
| PATCH | `/v1/pjm/deliverables/{deliverable_target_id}` | Update deliverable target | `write:pjm:project` |
| DELETE | `/v1/pjm/deliverables/{deliverable_target_id}` | Delete deliverable target | `write:pjm:project` |

⚠️ Asymmetry to design around: there is a `GET .../tags/{tag_id}` but **no `GET .../work_items/{id}/tags` list**.

`GET /v1/pjm/work_items` query params (all optional): `identifier`, `project_id`, `type_id`, `parent_id`, `assignee_id`, `state_id`, `priority_id`, `bug_type_id`, `tag_id`, `sprint_id`, `board_id`, `entry_id`, `swimlane_id`, `phase_id`, `version_id`, `created_by`, `participant_id`, `keywords`, `include_public_image_token`, `include_deleted`, `include_archived`.

#### 3.8.4 工作项配置 Work item configuration (42) — [doc](https://open.pingcode.com/#api-%E5%B7%A5%E4%BD%9C%E9%A1%B9%E9%85%8D%E7%BD%AE) · all `read/write:pjm:configuration`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/pjm/work_item_types` | Create work item type |
| GET | `/v1/pjm/work_item_types` | List all work item types |
| GET | `/v1/pjm/work_item_types/{work_item_type_id}` | Get one type |
| PATCH | `/v1/pjm/work_item_types/{work_item_type_id}` | Update type |
| DELETE | `/v1/pjm/work_item_types/{work_item_type_id}` | Delete type |
| GET | `/v1/pjm/work_item_type_plans` | List type schemes |
| GET | `/v1/pjm/work_item_type_plans/{work_item_type_plan_id}` | Get one type scheme |
| POST | `/v1/pjm/work_item_type_plans/{plan_id}/work_item_types` | Add type to scheme |
| GET | `/v1/pjm/work_item_type_plans/{plan_id}/work_item_types` | List types in scheme |
| GET | `/v1/pjm/work_item_type_plans/{plan_id}/work_item_types/{type_id}` | Get type in scheme |
| PATCH | `/v1/pjm/work_item_type_plans/{plan_id}/work_item_types/{type_id}` | Update type in scheme |
| DELETE | `/v1/pjm/work_item_type_plans/{plan_id}/work_item_types/{type_id}` | Remove type from scheme |
| POST | `/v1/pjm/work_item_states` | Create work item state |
| GET | `/v1/pjm/work_item_states` | List all states |
| GET | `/v1/pjm/work_item_states/{state_id}` | Get one state |
| PATCH | `/v1/pjm/work_item_states/{state_id}` | Update state *(non-system states only)* |
| GET | `/v1/pjm/work_item_state_plans` | List state schemes |
| GET | `/v1/pjm/work_item_state_plans/{state_plan_id}` | Get one state scheme |
| POST | `/v1/pjm/work_item_state_plans/{plan_id}/work_item_states` | Add state to scheme |
| GET | `/v1/pjm/work_item_state_plans/{plan_id}/work_item_states` | List states in scheme |
| GET | `/v1/pjm/work_item_state_plans/{plan_id}/work_item_states/{state_id}` | Get state in scheme |
| DELETE | `/v1/pjm/work_item_state_plans/{plan_id}/work_item_states/{state_id}` | Remove state from scheme |
| POST | `/v1/pjm/work_item_state_plans/{plan_id}/work_item_state_flows` | Add state transition |
| GET | `/v1/pjm/work_item_state_plans/{plan_id}/work_item_state_flows` | List transitions in scheme |
| GET | `/v1/pjm/work_item_state_plans/{plan_id}/work_item_state_flows/{flow_id}` | Get one transition |
| DELETE | `/v1/pjm/work_item_state_plans/{plan_id}/work_item_state_flows/{flow_id}` | Remove transition |
| POST | `/v1/pjm/work_item_properties` | Create work item property |
| GET | `/v1/pjm/work_item_properties` | List all properties |
| GET | `/v1/pjm/work_item_properties/{property_id}` | Get one property |
| PATCH | `/v1/pjm/work_item_properties/{property_id}` | Update property |
| GET | `/v1/pjm/work_item_property_plans` | List property schemes |
| GET | `/v1/pjm/work_item_property_plans/{property_plan_id}` | Get one property scheme |
| POST | `/v1/pjm/work_item_property_plans/{plan_id}/work_item_properties` | Add property to scheme |
| GET | `/v1/pjm/work_item_property_plans/{plan_id}/work_item_properties` | List properties in scheme |
| GET | `/v1/pjm/work_item_property_plans/{plan_id}/work_item_properties/{property_id}` | Get property in scheme |
| DELETE | `/v1/pjm/work_item_property_plans/{plan_id}/work_item_properties/{property_id}` | Remove property from scheme |
| POST | `/v1/pjm/work_item_tags` | Create work item tag |
| GET | `/v1/pjm/work_item_tags` | List all tags |
| GET | `/v1/pjm/work_item_tags/{tag_id}` | Get one tag |
| PATCH | `/v1/pjm/work_item_tags/{tag_id}` | Update tag |
| DELETE | `/v1/pjm/work_item_tags/{tag_id}` | Delete tag |
| GET | `/v1/pjm/work_item_priorities/{priority_id}` | Get one priority |

⚠️ `work_item_priorities` has a get-one but **no list** at this path (use `/v1/pjm/work_item/priorities?project_id=`).

#### 3.8.5 迭代 Sprints (15) — [doc](https://open.pingcode.com/#api-%E8%BF%AD%E4%BB%A3) · `read/write:pjm:sprint`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/pjm/projects/{project_id}/sprints` | Create sprint |
| GET | `/v1/pjm/projects/{project_id}/sprints` | List sprints |
| GET | `/v1/pjm/projects/{project_id}/sprints/{sprint_id}` | Get one sprint |
| PATCH | `/v1/pjm/projects/{project_id}/sprints/{sprint_id}` | Update sprint |
| POST | `/v1/pjm/sprints/bulk` | **Bulk** create sprints — **ENT only, no scope** |
| POST | `/v1/pjm/projects/{project_id}/sprint_sections` | Create sprint section |
| GET | `/v1/pjm/projects/{project_id}/sprint_sections` | List sprint sections |
| GET | `/v1/pjm/projects/{project_id}/sprint_sections/{section_id}` | Get one section |
| PATCH | `/v1/pjm/projects/{project_id}/sprint_sections/{section_id}` | Update section |
| DELETE | `/v1/pjm/projects/{project_id}/sprint_sections/{section_id}` | Delete section |
| POST | `/v1/pjm/projects/{project_id}/sprint_categories` | Create sprint category |
| GET | `/v1/pjm/projects/{project_id}/sprint_categories` | List categories |
| GET | `/v1/pjm/projects/{project_id}/sprint_categories/{sprint_category_id}` | Get one category |
| PATCH | `/v1/pjm/projects/{project_id}/sprint_categories/{sprint_category_id}` | Update category |
| DELETE | `/v1/pjm/projects/{project_id}/sprint_categories/{sprint_category_id}` | Delete category |

⚠️ **No `DELETE` for a sprint itself.**

#### 3.8.6 发布 Releases / versions (21) — [doc](https://open.pingcode.com/#api-%E5%8F%91%E5%B8%83)

| Method | Path | Purpose | Scope |
|---|---|---|---|
| POST | `/v1/pjm/projects/{project_id}/versions` | Create release | `write:pjm:release` |
| GET | `/v1/pjm/projects/{project_id}/versions` | List releases | `read:pjm:release` |
| GET | `/v1/pjm/projects/{project_id}/versions/{version_id}` | Get one release | `read:pjm:release` |
| PATCH | `/v1/pjm/projects/{project_id}/versions/{version_id}` | Update release | `write:pjm:release` |
| DELETE | `/v1/pjm/projects/{project_id}/versions/{version_id}` | Delete release | `write:pjm:release` |
| POST | `/v1/pjm/versions/bulk` | **Bulk** create releases | **ENT only, no scope** |
| POST | `/v1/pjm/projects/{project_id}/version_sections` | Create release section | `write:pjm:release` |
| GET | `/v1/pjm/projects/{project_id}/version_sections` | List release sections | `read:pjm:release` |
| GET | `/v1/pjm/projects/{project_id}/version_sections/{section_id}` | Get one section | `read:pjm:release` |
| PATCH | `/v1/pjm/projects/{project_id}/version_sections/{section_id}` | Update section | `write:pjm:release` |
| DELETE | `/v1/pjm/projects/{project_id}/version_sections/{section_id}` | Delete section | `write:pjm:release` |
| POST | `/v1/pjm/projects/{project_id}/version_categories` | Create release category | `write:pjm:release` |
| GET | `/v1/pjm/projects/{project_id}/version_categories` | List categories | `read:pjm:release` |
| GET | `/v1/pjm/projects/{project_id}/version_categories/{version_category_id}` | Get one category | `read:pjm:release` |
| PATCH | `/v1/pjm/projects/{project_id}/version_categories/{version_category_id}` | Update category | `write:pjm:release` |
| DELETE | `/v1/pjm/projects/{project_id}/version_categories/{version_category_id}` | Delete category | `write:pjm:release` |
| POST | `/v1/pjm/stages` | Create release stage | `write:pjm:configuration` |
| GET | `/v1/pjm/stages` | List release stages | `read:pjm:configuration` |
| GET | `/v1/pjm/stages/{stage_id}` | Get one stage | `read:pjm:configuration` |
| PATCH | `/v1/pjm/stages/{stage_id}` | Update stage | `write:pjm:configuration` |
| DELETE | `/v1/pjm/stages/{stage_id}` | Delete stage | `write:pjm:configuration` |

#### 3.8.7 看板 Boards (15) — [doc](https://open.pingcode.com/#api-%E7%9C%8B%E6%9D%BF) · `read/write:pjm:board`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/pjm/projects/{project_id}/boards` | Create board |
| GET | `/v1/pjm/projects/{project_id}/boards` | List boards |
| GET | `/v1/pjm/projects/{project_id}/boards/{board_id}` | Get one board |
| PATCH | `/v1/pjm/projects/{project_id}/boards/{board_id}` | Update board |
| DELETE | `/v1/pjm/projects/{project_id}/boards/{board_id}` | Delete board |
| POST | `/v1/pjm/projects/{project_id}/boards/{board_id}/entries` | Create board column |
| GET | `/v1/pjm/projects/{project_id}/boards/{board_id}/entries` | List columns |
| GET | `/v1/pjm/projects/{project_id}/boards/{board_id}/entries/{entry_id}` | Get one column |
| PATCH | `/v1/pjm/projects/{project_id}/boards/{board_id}/entries/{entry_id}` | Update column (incl. `wip_limit`) |
| DELETE | `/v1/pjm/projects/{project_id}/boards/{board_id}/entries/{entry_id}` | Delete column |
| POST | `/v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes` | Create swimlane |
| GET | `/v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes` | List swimlanes |
| GET | `/v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes/{swimlane_id}` | Get one swimlane |
| PATCH | `/v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes/{swimlane_id}` | Update swimlane |
| DELETE | `/v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes/{swimlane_id}` | Delete swimlane |

---

### 3.9 SHIP — 产品管理 / 需求 / 工单 (ITSM) (101)

#### 3.9.1 产品 Product + members / customers / external users / tags / suites / plans (31) — [doc](https://open.pingcode.com/#api-%E4%BA%A7%E5%93%81)

| Method | Path | Purpose | Scope |
|---|---|---|---|
| POST | `/v1/ship/products` | Create product | `write:ship:product` |
| GET | `/v1/ship/products` | List products | `read:ship:product` |
| GET | `/v1/ship/products/{product_id}` | Get one product | `read:ship:product` |
| PATCH | `/v1/ship/products/{product_id}` | Update product | `write:ship:product` |
| POST | `/v1/ship/products/{product_id}/members` | Add product member | `write:ship:product` |
| GET | `/v1/ship/products/{product_id}/members` | List product members | `read:ship:product` |
| GET | `/v1/ship/products/{product_id}/members/{member_id}` | Get one member | `read:ship:product` |
| DELETE | `/v1/ship/products/{product_id}/members/{member_id}` | Remove member | `write:ship:product` |
| POST | `/v1/ship/products/{product_id}/customers` | Create customer | `write:ship:product` |
| GET | `/v1/ship/products/{product_id}/customers` | List customers | `read:ship:product` |
| GET | `/v1/ship/products/{product_id}/customers/{customer_id}` | Get one customer | `read:ship:product` |
| PATCH | `/v1/ship/products/{product_id}/customers/{customer_id}` | Update customer | `write:ship:product` |
| POST | `/v1/ship/products/{product_id}/users` | Create external user | `write:ship:product` |
| GET | `/v1/ship/products/{product_id}/users` | List external users | `read:ship:product` |
| GET | `/v1/ship/products/{product_id}/users/{user_id}` | Get one external user | `read:ship:product` |
| PATCH | `/v1/ship/products/{product_id}/users/{user_id}` | Update external user | `write:ship:product` |
| DELETE | `/v1/ship/products/{product_id}/users/{user_id}` | Delete external user | `write:ship:product` |
| POST | `/v1/ship/products/{product_id}/tags` | Add tag to product | `write:ship:product` |
| GET | `/v1/ship/products/{product_id}/tags` | List product tags | `read:ship:configuration` |
| GET | `/v1/ship/products/{product_id}/tags/{tag_id}` | Get one tag | `read:ship:configuration` |
| DELETE | `/v1/ship/products/{product_id}/tags/{tag_id}` | Remove tag | `write:ship:product` |
| POST | `/v1/ship/products/{product_id}/suites` | Add requirement module | `write:ship:product` |
| GET | `/v1/ship/products/{product_id}/suites` | List requirement modules | `read:ship:product` |
| GET | `/v1/ship/products/{product_id}/suites/{suite_id}` | Get one module | `read:ship:product` |
| DELETE | `/v1/ship/products/{product_id}/suites/{suite_id}` | Remove module | `write:ship:product` |
| GET | `/v1/ship/products/{product_id}/plans` | List requirement schedules (排期) | `read:ship:product` |
| GET | `/v1/ship/products/{product_id}/plans/{plan_id}` | Get one schedule | `read:ship:product` |
| GET | `/v1/ship/products/{product_id}/channels` | List ticket channels in product | `read:ship:configuration` |
| GET | `/v1/ship/products/{product_id}/channels/{channel_id}` | Get one channel | `read:ship:configuration` |
| GET | `/v1/ship/products/{product_id}/ticket_types` | List ticket types in product | `read:ship:configuration` |
| GET | `/v1/ship/products/{product_id}/ticket_types/{ticket_type_id}` | Get one ticket type | `read:ship:configuration` |

#### 3.9.2 需求 Ideas / requirements (12) — [doc](https://open.pingcode.com/#api-%E9%9C%80%E6%B1%82) · `read/write:ship:idea`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/ship/ideas` | Create idea |
| GET | `/v1/ship/ideas` | List ideas |
| POST | `/v1/ship/ideas/search` | **Advanced search** ideas |
| GET | `/v1/ship/ideas/{idea_id}` | Get one idea |
| PATCH | `/v1/ship/ideas/{idea_id}` | Update idea |
| GET | `/v1/ship/ideas/{idea_id}/transition_histories` | List transition history |
| GET | `/v1/ship/ideas/{idea_id}/transition_histories/{transition_history_id}` | Get one transition record |
| GET | `/v1/ship/idea/states?product_id=` | List idea states (in ctx) |
| GET | `/v1/ship/idea/priorities?product_id=` | List priorities (in ctx) |
| GET | `/v1/ship/idea/properties?product_id=` | List properties (in ctx) |
| GET | `/v1/ship/idea/suites?product_id=` | List modules (in ctx) |
| GET | `/v1/ship/idea/plans?product_id=` | List schedules (in ctx) |

⚠️ No `DELETE` for ideas.

#### 3.9.3 需求配置 Idea configuration (14) — [doc](https://open.pingcode.com/#api-%E9%9C%80%E6%B1%82%E9%85%8D%E7%BD%AE) · `read/write:ship:configuration`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/ship/idea_properties` | Create idea property |
| GET | `/v1/ship/idea_properties` | List all idea properties |
| GET | `/v1/ship/idea_properties/{property_id}` | Get one property |
| PATCH | `/v1/ship/idea_properties/{property_id}` | Update property |
| GET | `/v1/ship/idea_property_plans` | List property schemes |
| GET | `/v1/ship/idea_property_plans/{property_plan_id}` | Get one scheme |
| POST | `/v1/ship/idea_property_plans/{plan_id}/idea_properties` | Add property to scheme |
| GET | `/v1/ship/idea_property_plans/{plan_id}/idea_properties` | List properties in scheme |
| GET | `/v1/ship/idea_property_plans/{plan_id}/idea_properties/{property_id}` | Get property in scheme |
| DELETE | `/v1/ship/idea_property_plans/{plan_id}/idea_properties/{property_id}` | Remove property from scheme |
| GET | `/v1/ship/idea_states` | List all idea states |
| GET | `/v1/ship/idea_states/{idea_state_id}` | Get one idea state |
| GET | `/v1/ship/idea_priorities` | List all idea priorities |
| GET | `/v1/ship/idea_priorities/{priority_id}` | Get one priority |

#### 3.9.4 工单 Tickets / ITSM (14) — [doc](https://open.pingcode.com/#api-%E5%B7%A5%E5%8D%95) · `read/write:ship:ticket`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/ship/tickets` | Create ticket |
| GET | `/v1/ship/tickets` | List tickets |
| POST | `/v1/ship/tickets/search` | **Advanced search** tickets |
| GET | `/v1/ship/tickets/{ticket_id}` | Get one ticket |
| PATCH | `/v1/ship/tickets/{ticket_id}` | Update ticket |
| GET | `/v1/ship/tickets/{ticket_id}/transition_histories` | List transition history |
| GET | `/v1/ship/tickets/{ticket_id}/transition_histories/{transition_history_id}` | Get one transition record |
| GET | `/v1/ship/ticket/types?product_id=` | List ticket types (in ctx) |
| GET | `/v1/ship/ticket/states?product_id=` | List states (in ctx) |
| GET | `/v1/ship/ticket/priorities?product_id=` | List priorities (in ctx) |
| GET | `/v1/ship/ticket/properties?product_id=` | List properties (in ctx) |
| GET | `/v1/ship/ticket/solutions?product_id=` | List solutions (in ctx) |
| GET | `/v1/ship/ticket/tags?product_id=` | List ticket tags (in ctx) |
| GET | `/v1/ship/ticket/channels?product_id=` | List channels (in ctx) |

⚠️ No `DELETE` for tickets.

#### 3.9.5 工单配置 Ticket configuration (30) — [doc](https://open.pingcode.com/#api-%E5%B7%A5%E5%8D%95%E9%85%8D%E7%BD%AE) · `read/write:ship:configuration`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/ship/ticket_types` | List all ticket types |
| GET | `/v1/ship/ticket_types/{ticket_type_id}` | Get one ticket type |
| POST | `/v1/ship/ticket_states` | Create ticket state |
| GET | `/v1/ship/ticket_states` | List all ticket states |
| GET | `/v1/ship/ticket_states/{ticket_state_id}` | Get one ticket state |
| PATCH | `/v1/ship/ticket_states/{ticket_state_id}` | Update ticket state |
| GET | `/v1/ship/ticket_state_plans` | List state schemes |
| GET | `/v1/ship/ticket_state_plans/{state_plan_id}` | Get one state scheme |
| POST | `/v1/ship/ticket_state_plans/{plan_id}/ticket_states` | Add state to scheme |
| GET | `/v1/ship/ticket_state_plans/{plan_id}/ticket_states` | List states in scheme |
| GET | `/v1/ship/ticket_state_plans/{plan_id}/ticket_states/{state_id}` | Get state in scheme |
| DELETE | `/v1/ship/ticket_state_plans/{plan_id}/ticket_states/{state_id}` | Remove state from scheme |
| POST | `/v1/ship/ticket_state_plans/{plan_id}/ticket_state_flows` | Add state transition |
| GET | `/v1/ship/ticket_state_plans/{plan_id}/ticket_state_flows` | List transitions |
| GET | `/v1/ship/ticket_state_plans/{plan_id}/ticket_state_flows/{state_flow_id}` | Get one transition |
| DELETE | `/v1/ship/ticket_state_plans/{plan_id}/ticket_state_flows/{state_flow_id}` | Remove transition |
| POST | `/v1/ship/ticket_properties` | Create ticket property |
| GET | `/v1/ship/ticket_properties` | List all ticket properties |
| GET | `/v1/ship/ticket_properties/{property_id}` | Get one property |
| PATCH | `/v1/ship/ticket_properties/{property_id}` | Update property |
| GET | `/v1/ship/ticket_property_plans` | List property schemes |
| GET | `/v1/ship/ticket_property_plans/{property_plan_id}` | Get one property scheme |
| POST | `/v1/ship/ticket_property_plans/{plan_id}/ticket_properties` | Add property to scheme |
| GET | `/v1/ship/ticket_property_plans/{plan_id}/ticket_properties` | List properties in scheme |
| GET | `/v1/ship/ticket_property_plans/{plan_id}/ticket_properties/{property_id}` | Get property in scheme |
| DELETE | `/v1/ship/ticket_property_plans/{plan_id}/ticket_properties/{property_id}` | Remove property from scheme |
| GET | `/v1/ship/ticket_priorities` | List all priorities |
| GET | `/v1/ship/ticket_priorities/{priority_id}` | Get one priority |
| GET | `/v1/ship/ticket_solutions` | List all ticket solutions |
| GET | `/v1/ship/ticket_solutions/{ticket_solution_id}` | Get one solution |

---

### 3.10 TESTHUB — 测试管理 (65)

#### 3.10.1 测试库 Libraries (14) — [doc](https://open.pingcode.com/#api-%E6%B5%8B%E8%AF%95%E5%BA%93) · `read/write:testhub:library`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/testhub/libraries` | Create test library |
| GET | `/v1/testhub/libraries` | List test libraries |
| GET | `/v1/testhub/libraries/{library_id}` | Get one library |
| PATCH | `/v1/testhub/libraries/{library_id}` | Update library |
| POST | `/v1/testhub/libraries/{library_id}/members` | Add library member |
| GET | `/v1/testhub/libraries/{library_id}/members` | List library members |
| GET | `/v1/testhub/libraries/{library_id}/members/{member_id}` | Get one member |
| PATCH | `/v1/testhub/libraries/{library_id}/members/{member_id}` | Update member |
| DELETE | `/v1/testhub/libraries/{library_id}/members/{member_id}` | Remove member |
| POST | `/v1/testhub/libraries/{library_id}/suites` | Add case module |
| GET | `/v1/testhub/libraries/{library_id}/suites` | List case modules |
| GET | `/v1/testhub/libraries/{library_id}/suites/{suite_id}` | Get one module |
| PATCH | `/v1/testhub/libraries/{library_id}/suites/{suite_id}` | Update module |
| DELETE | `/v1/testhub/libraries/{library_id}/suites/{suite_id}` | Remove module |

#### 3.10.2 用例 Test cases (13) — [doc](https://open.pingcode.com/#api-%E7%94%A8%E4%BE%8B) · `read/write:testhub:testcase`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/testhub/cases` | Create case |
| GET | `/v1/testhub/cases` | List cases |
| POST | `/v1/testhub/cases/search` | **Advanced search** cases |
| POST | `/v1/testhub/cases/bulk` | **Bulk** create cases |
| PATCH | `/v1/testhub/cases/bulk` | **Bulk** partial update cases |
| GET | `/v1/testhub/cases/{case_id}` | Get one case |
| PATCH | `/v1/testhub/cases/{case_id}` | Update case |
| DELETE | `/v1/testhub/cases/{case_id}` | Delete case |
| GET | `/v1/testhub/cases/{case_id}/histories` | Case execution history *(declares `write:` scope — likely a doc bug)* |
| GET | `/v1/testhub/case/types?library_id=` | List case types (in ctx) |
| GET | `/v1/testhub/case/states?library_id=` | List case states (in ctx) |
| GET | `/v1/testhub/case/properties?library_id=` | List case properties (in ctx) |
| GET | `/v1/testhub/case/suites?library_id=` | List case modules (in ctx) |

#### 3.10.3 用例配置 Case configuration (16) — [doc](https://open.pingcode.com/#api-%E7%94%A8%E4%BE%8B%E9%85%8D%E7%BD%AE) · `read/write:testhub:configuration`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/testhub/case_properties` | Create case property |
| GET | `/v1/testhub/case_properties` | List all case properties |
| GET | `/v1/testhub/case_properties/{property_id}` | Get one property |
| PATCH | `/v1/testhub/case_properties/{property_id}` | Update property |
| GET | `/v1/testhub/case_property_plans` | List property schemes |
| GET | `/v1/testhub/case_property_plans/{property_plan_id}` | Get one scheme |
| POST | `/v1/testhub/case_property_plans/{plan_id}/case_properties` | Add property to scheme |
| GET | `/v1/testhub/case_property_plans/{plan_id}/case_properties` | List properties in scheme |
| GET | `/v1/testhub/case_property_plans/{plan_id}/case_properties/{property_id}` | Get property in scheme |
| DELETE | `/v1/testhub/case_property_plans/{plan_id}/case_properties/{property_id}` | Remove property from scheme |
| GET | `/v1/testhub/case_types` | List all case types |
| GET | `/v1/testhub/case_types/{type_id}` | Get one case type |
| GET | `/v1/testhub/case_states` | List all case states |
| GET | `/v1/testhub/case_states/{state_id}` | Get one case state |
| GET | `/v1/testhub/case_important_levels` | List all importance levels |
| GET | `/v1/testhub/case_important_levels/{important_level_id}` | Get one importance level |

#### 3.10.4 计划 Test plans & runs (18) — [doc](https://open.pingcode.com/#api-%E8%AE%A1%E5%88%92) · `read/write:testhub:testplan`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/testhub/libraries/{library_id}/plans` | Create test plan |
| GET | `/v1/testhub/libraries/{library_id}/plans` | List test plans |
| GET | `/v1/testhub/libraries/{library_id}/plans/{plan_id}` | Get one plan |
| PATCH | `/v1/testhub/libraries/{library_id}/plans/{plan_id}` | Update plan |
| POST | `/v1/testhub/libraries/{library_id}/plans/{plan_id}/runs/bulk` | **Bulk** operate runs in a plan |
| GET | `/v1/testhub/libraries/{library_id}/plan_types` | List plan types |
| GET | `/v1/testhub/libraries/{library_id}/plan_types/{plan_type_id}` | Get one plan type |
| POST | `/v1/testhub/runs` | Create a run (case execution) |
| GET | `/v1/testhub/runs` | List runs |
| POST | `/v1/testhub/runs/search` | **Advanced search** runs |
| POST | `/v1/testhub/runs/bulk` | **Bulk** create runs |
| PATCH | `/v1/testhub/runs/bulk` | **Bulk** partial update runs |
| GET | `/v1/testhub/runs/{run_id}` | Get one run |
| PUT | `/v1/testhub/runs/{run_id}` | **Full** update run |
| PATCH | `/v1/testhub/runs/{run_id}` | Partial update run |
| GET | `/v1/testhub/runs/{run_id}/histories` | List run result records |
| GET | `/v1/testhub/runs/{run_id}/histories/{history_id}` | Get one result record |
| GET | `/v1/testhub/run/statuses?library_id=` | List run statuses (in ctx) · `read:testhub:configuration` |

#### 3.10.5 计划配置 + 执行用例配置 (4) · `read:testhub:configuration`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/testhub/plan_states` | List all plan states |
| GET | `/v1/testhub/plan_states/{state_id}` | Get one plan state |
| GET | `/v1/testhub/run_statuses` | List all run result statuses |
| GET | `/v1/testhub/run_statuses/{status_id}` | Get one run result status |

---

### 3.11 WIKI — 知识管理 (19)

#### 3.11.1 空间 Spaces (9) — [doc](https://open.pingcode.com/#api-%E7%A9%BA%E9%97%B4) · `read/write:wiki:space`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/wiki/spaces` | Create space |
| GET | `/v1/wiki/spaces` | List spaces |
| GET | `/v1/wiki/spaces/{space_id}` | Get one space |
| PATCH | `/v1/wiki/spaces/{space_id}` | Update space |
| DELETE | `/v1/wiki/spaces/{space_id}` | Delete space |
| POST | `/v1/wiki/spaces/{space_id}/members` | Add space member |
| GET | `/v1/wiki/spaces/{space_id}/members` | List space members |
| GET | `/v1/wiki/spaces/{space_id}/members/{member_id}` | Get one space member |
| DELETE | `/v1/wiki/spaces/{space_id}/members/{member_id}` | Remove space member |

#### 3.11.2 页面 Pages (10) — [doc](https://open.pingcode.com/#api-%E9%A1%B5%E9%9D%A2) · `read/write:wiki:page`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/wiki/pages` | Create page |
| GET | `/v1/wiki/pages` | List pages |
| GET | `/v1/wiki/pages/{page_id}` | Get one page (metadata) |
| PATCH | `/v1/wiki/pages/{page_id}` | Update page metadata |
| DELETE | `/v1/wiki/pages/{page_id}` | Delete page |
| GET | `/v1/wiki/pages/{page_id}/content` | Get page body |
| PUT | `/v1/wiki/pages/{page_id}/content` | Replace page body |
| GET | `/v1/wiki/pages/{page_id}/versions` | List page versions |
| GET | `/v1/wiki/pages/{page_id}/versions/{version_id}` | Get one page version |
| POST | `/v1/wiki/pages/{page_id}/versions/{version_id}/restore` | Restore page to a version |

---

### 3.12 DevOps 数据集成 — SCM / Build / Release (54)

⚠️ **Every endpoint in §3.12 is 企业令牌-only (ENT).** These are write-back integration APIs meant for CI systems, not per-user access. This is the bulk of the 61 ENT-only endpoints.

#### 3.12.1 托管平台 Hosting platforms (5) — [doc](https://open.pingcode.com/#api-%E6%89%98%E7%AE%A1%E5%B9%B3%E5%8F%B0) · `read/write:devops:code`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/scm/products` | Create hosting platform |
| GET | `/v1/scm/products` | List hosting platforms |
| GET | `/v1/scm/products/{product_id}` | Get one platform |
| PUT | `/v1/scm/products/{product_id}` | **Full** update platform |
| PATCH | `/v1/scm/products/{product_id}` | Partial update platform |

#### 3.12.2 托管平台用户 Platform users (5) — [doc](https://open.pingcode.com/#api-%E6%89%98%E7%AE%A1%E5%B9%B3%E5%8F%B0%E7%94%A8%E6%88%B7)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/scm/products/{product_id}/users` | Create platform user |
| GET | `/v1/scm/products/{product_id}/users` | List platform users |
| GET | `/v1/scm/products/{product_id}/users/{user_id}` | Get one platform user |
| PUT | `/v1/scm/products/{product_id}/users/{user_id}` | **Full** update |
| PATCH | `/v1/scm/products/{product_id}/users/{user_id}` | Partial update |

#### 3.12.3 代码仓库 Repositories (5) — [doc](https://open.pingcode.com/#api-%E4%BB%A3%E7%A0%81%E4%BB%93%E5%BA%93)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/scm/products/{product_id}/repositories` | Create repository |
| GET | `/v1/scm/products/{product_id}/repositories` | List repositories |
| GET | `/v1/scm/products/{product_id}/repositories/{repository_id}` | Get one repository |
| PUT | `/v1/scm/products/{product_id}/repositories/{repository_id}` | **Full** update |
| PATCH | `/v1/scm/products/{product_id}/repositories/{repository_id}` | Partial update |

#### 3.12.4 代码分支 Branches (5) — [doc](https://open.pingcode.com/#api-%E4%BB%A3%E7%A0%81%E5%88%86%E6%94%AF)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/scm/products/{product_id}/repositories/{repository_id}/branches` | Create branch |
| GET | `/v1/scm/products/{product_id}/repositories/{repository_id}/branches` | List branches |
| GET | `/v1/scm/products/{product_id}/repositories/{repository_id}/branches/{branch_id}` | Get one branch |
| PATCH | `/v1/scm/products/{product_id}/repositories/{repository_id}/branches/{branch_id}` | Update branch |
| DELETE | `/v1/scm/products/{product_id}/repositories/{repository_id}/branches/{branch_id}` | Delete branch |

#### 3.12.5 拉取请求 Pull requests (5) — [doc](https://open.pingcode.com/#api-%E6%8B%89%E5%8F%96%E8%AF%B7%E6%B1%82)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests` | Create PR |
| GET | `/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests` | List PRs |
| GET | `/v1/scm/products/{product_id}/repositories/{repository_id}/pull_requests/{pull_request_id}` | Get one PR |
| PUT | `…/pull_requests/{pull_request_id}` | **Full** update PR |
| PATCH | `…/pull_requests/{pull_request_id}` | Partial update PR |

#### 3.12.6 代码评审 Code reviews (5) — [doc](https://open.pingcode.com/#api-%E4%BB%A3%E7%A0%81%E8%AF%84%E5%AE%A1)

| Method | Path | Purpose |
|---|---|---|
| POST | `…/pull_requests/{pull_request_id}/reviews` | Create code review |
| GET | `…/pull_requests/{pull_request_id}/reviews` | List code reviews |
| GET | `…/pull_requests/{pull_request_id}/reviews/{review_id}` | Get one code review |
| PUT | `…/pull_requests/{pull_request_id}/reviews/{review_id}` | **Full** update |
| PATCH | `…/pull_requests/{pull_request_id}/reviews/{review_id}` | Partial update |

#### 3.12.7 提交 Commits (3) + 提交引用 Refs (3)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/scm/commits` | Create a commit record |
| GET | `/v1/scm/commits` | List commits |
| GET | `/v1/scm/commits/{commit_id_or_sha}` | Get one commit (by id **or SHA**) |
| POST | `/v1/scm/products/{product_id}/repositories/{repository_id}/refs` | Create commit ref |
| GET | `/v1/scm/products/{product_id}/repositories/{repository_id}/refs` | List commit refs |
| GET | `/v1/scm/products/{product_id}/repositories/{repository_id}/refs/{ref_id}` | Get one commit ref |

#### 3.12.8 构建记录 Build records (6) — [doc](https://open.pingcode.com/#api-%E6%9E%84%E5%BB%BA%E8%AE%B0%E5%BD%95) · `read/write:devops:build`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/build/builds` | Create build record |
| GET | `/v1/build/builds` | List build records |
| GET | `/v1/build/builds/{build_id}` | Get one build record |
| PUT | `/v1/build/builds/{build_id}` | **Full** update |
| PATCH | `/v1/build/builds/{build_id}` | Partial update |
| DELETE | `/v1/build/builds/{build_id}` | Delete build record |

#### 3.12.9 环境 Environments (6) — [doc](https://open.pingcode.com/#api-%E7%8E%AF%E5%A2%83) · `read/write:devops:deploy`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/release/environments` | Create environment |
| GET | `/v1/release/environments` | List environments |
| GET | `/v1/release/environments/{env_id}` | Get one environment |
| PUT | `/v1/release/environments/{env_id}` | **Full** update |
| PATCH | `/v1/release/environments/{env_id}` | Partial update |
| DELETE | `/v1/release/environments/{env_id}` | Delete environment |

#### 3.12.10 部署 Deployments (6) — [doc](https://open.pingcode.com/#api-%E9%83%A8%E7%BD%B2) · `read/write:devops:deploy`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/release/deploys` | Create deployment |
| GET | `/v1/release/deploys` | List deployments |
| GET | `/v1/release/deploys/{deploy_id}` | Get one deployment |
| PUT | `/v1/release/deploys/{deploy_id}` | **Full** update |
| PATCH | `/v1/release/deploys/{deploy_id}` | Partial update |
| DELETE | `/v1/release/deploys/{deploy_id}` | Delete deployment |

---

### 3.13 Nexus / CES — app custom-entity storage (5) — [doc](https://open.pingcode.com/#api-CES)

⚠️ **ENT-only · scope `pcp:storage:app`.** Not a PingCode business module — it's a MongoDB-ish key-value store scoped to *your app*, for building self-hosted app state. All verbs are `POST` (RPC-style, not REST).

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/nexus/ces/insert` | Insert custom entities (`entity_name`, `value[]`, `options.ordered`) |
| POST | `/v1/nexus/ces/find` | Query entities (`options.limit`, `options.sort.{property_key,order}`) |
| POST | `/v1/nexus/ces/count` | Count entities |
| POST | `/v1/nexus/ces/update` | Partially update entities |
| POST | `/v1/nexus/ces/delete` | Delete entities |

---

## 4. Common conventions

[概述 → 使用方式](https://open.pingcode.com/#api-%E4%BD%BF%E7%94%A8%E6%96%B9%E5%BC%8F) · [概述 → 数据结构](https://open.pingcode.com/#api-%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84) · [概述 → 频率限制](https://open.pingcode.com/#api-%E9%A2%91%E7%8E%87%E9%99%90%E5%88%B6)

### 4.1 Pagination

Global convention, applied via **querystring** on every list endpoint (and notably **not** repeated in per-endpoint param tables — so don't expect to discover it endpoint-by-endpoint):

| Param | Default | Max | Notes |
|---|---|---|---|
| `page_size` | 30 | **100** | |
| `page_index` | 0 | — | **0-based** ("page_index 为 0 时，表示第一页") |

Envelope (HTTP **200**):
```json
{ "page_size": 30, "page_index": 0, "total": 100, "values": [ /* full structures */ ] }
```

For the 5 `POST .../search` endpoints, pagination moves **into the JSON body** as `payload.page_size` (1–100) and `payload.page_index` (from 0).

### 4.2 Single-resource envelope

**No wrapper** — the resource object is the whole body. Documented HTTP status is **201** for create/update/get/delete of a single resource (⚠️ unusual — 201 documented even for `GET`/`DELETE`; a CLI should treat any 2xx as success rather than matching 201 exactly).

Two shapes per resource type:
- **全量结构 (full)** — returned by get-one and list-page: all attributes.
- **引用结构 (reference)** — returned when *embedded* in another resource: only `id`, `url`, `name`.

```json
// full                                     // reference
{ "id": "5e05d8448f8461dada9ba29c",         { "id": "5e05d8448f8461dada9ba29c",
  "url": "https://{root}/v1/{resource}",      "url": "https://{root}/v1/{resource}",
  "name": "…", "desc": "…",                   "name": "…" }
  "created_at": 1578897962 }
```

### 4.3 Filtering & sorting

There are **two tiers**, and this is the single most important design fact for a CLI:

1. **Simple list** (`GET`): a fixed set of flat, AND-combined, exact-match query params (see §3.8.3 for the work-item set). **No sort parameter anywhere.**
2. **Advanced search** (`POST .../search`), available on exactly 5 resources — `pjm/work_items`, `ship/ideas`, `ship/tickets`, `testhub/cases`, `testhub/runs`:

```json
{ "mode": "query",
  "payload": {
    "filter": {
      "title":           { "contains": "用户故事" },
      "assignee.id":     { "nin": ["315c85d2…"] },
      "project.id":      { "in":  ["5eb623f6…","5eb623f6…"] },
      "end_at":          { "gte": 1730000000 }
    },
    "keywords": "xxx",
    "include_public_image_token": "description",
    "include_deleted": false, "include_archived": false,
    "page_size": 100, "page_index": 0 } }
```

Mongo-like operators by attribute type:

| Attribute type | Operators |
|---|---|
| Text (`title`, `description`, custom single/multi-line, link) | `exists`, `contains` |
| Enum (e.g. `type`) | `exists`, `in`, `nin` |
| Number (`story_points`, custom number/progress/rating) | `exists`, `eq`, `ne`, `gt`, `lt`, `gte`, `lte` |
| Date (`start_at`, `created_at`, custom date) | `exists`, `gt`, `lt`, `gte`, `lte`, `between` (`[from_ts, to_ts]`, **day granularity**) |
| Option (dropdown single/multi, cascade single/multi) | `exists`, `in`, `nin` |
| Reference (`project.id`, `assignee.id`, `versions.id`, `tags.id`, `participants.id`) | `exists`, `in`, `nin` |

Naming rules: reference types use `{attr}.id`; custom attributes use `properties.{key}`.

**Hard limits (documented):** one operator per attribute · **no logical operators** (`$and`/`$or`) · **no sorting** · these built-ins are **not filterable**: `id`, `url`, `identifier`, `short_id`, `html_url`, `public_image_token`, `is_archived`, `is_deleted`.

### 4.4 Error shape

```json
{ "code": "100000", "message": "Internal Server Error" }
```
`code` is a **string**. Only **two** codes are documented anywhere in the entire doc set:

| HTTP | `code` | `message` | Notes |
|---|---|---|---|
| 500 | `100000` | Internal Server Error | |
| 429 | `100038` | 请求频率过高 | + header `x-pc-retry-after: <seconds>` |

⚠️ **There is no error-code reference table**, and **zero** of the 460 endpoints declare an `error` block in apiDoc. 4xx codes (401/403/404/422) are undocumented. A CLI must map errors defensively off HTTP status and surface `code`/`message` verbatim.

### 4.5 Rate limits

> 根据使用者的身份标识，PingCode REST API 最多允许**每位使用者每分钟请求 200 次**

- 200 req/min per identity. Not tiered by customer/service level.
- On exceed: `429` + `x-pc-retry-after` (seconds). **Retrying before expiry fails identically and does not reset** — so honour the header, don't blind-retry.
- Official mitigation advice: cache stable data; use **PingCode Flow** outbound webhooks/HTTP requests instead of polling.

→ For a CLI this argues for: a shared token cache, a client-side token-bucket, `x-pc-retry-after`-aware backoff, and page_size=100 on all list calls.

### 4.6 Dates & IDs

- **All times are 10-digit Unix second timestamps** (`created_at: 1578897962`). No ISO‑8601 anywhere. `between` filters operate at **day** granularity.
- IDs are 24-char hex (Mongo ObjectId, e.g. `5e05d8448f8461dada9ba29c`) — but user IDs appear as 32-char hex (`a0417f68e846aae315c85d24643678a9`). Treat all IDs as opaque strings.
- `OPTIONS` is listed as supported alongside GET/PUT/PATCH/POST/DELETE.

---

## 5. Webhooks / event subscription

**There is no webhook or event-subscription REST API.** Confirmed by exhaustive search of the bundle: 0 endpoints under any `webhook`/`event`/`subscription` path; the string "Webhook" appears exactly **once** in 2.3 MB of docs, and only as advice:

> 使用 **PingCode Flow** 中的**发送 Webhook** 和**发送 HTTP 请求**来将 PingCode 中发生变更的数据发送给订阅者，也可以有效降低 PingCode REST API 的请求数量
> — [概述 → 频率限制](https://open.pingcode.com/#api-%E9%A2%91%E7%8E%87%E9%99%90%E5%88%B6)

Implications for a CLI:
- Outbound events are configured **in-product** (PingCode Flow / 自动化 rules), not via API. There is no way to programmatically create, list, or delete a webhook subscription, and no documented payload schema or signature-verification scheme.
- Any "watch"/"tail" CLI feature must be **polling-based**, budgeted against the 200 req/min limit. The closest primitives are `GET /v1/activities?principal_type=&principal_id=` and the per-resource `transition_histories` endpoints — both are per-object, so there is **no global change feed**.

---

## 6. Modules that do **not** exist in the API

Several things you listed in the request are absent. Flagging explicitly so the PRD doesn't promise them:

| Expected | Status |
|---|---|
| **目标 / OKR (Goals)** | ❌ No `/v1/goal*`. PingCode markets 研发 OKR / 协作空间, but it has **no** public API. |
| **应用交付 / Flow / 自动化** | ❌ No endpoints. Flow is the *producer* of webhooks (§5), not an API surface. |
| **效能度量 / Insight (dashboards)** | ❌ Not in current docs. *(A legacy `GET /v1/dashboard/pages` exists only in the stale EN bundle — see §8.)* |
| **文件 File service** | ⚠️ Only as `/v1/attachments` (polymorphic attachment upload), no standalone file/drive API. |
| **计划 Plan (as a top-level product)** | ⚠️ Not top-level. "计划" means (a) **test plans** `/v1/testhub/libraries/{id}/plans`, and (b) **requirement scheduling** `/v1/ship/products/{id}/plans`. Separately, "方案/plan" in config paths (`*_property_plans`, `*_state_plans`) means **scheme/template**, a totally different concept — do not conflate these in CLI naming. |
| **缺陷 Bug** | ⚠️ Not a separate resource — a **work item type** under `/v1/pjm/work_items` (9 system types incl. `story`, `bug`; `bug_type_id` is a filter param). |
| **版本 Version** | ⚠️ = 发布 Release, at `/v1/pjm/projects/{id}/versions`. Distinct from **wiki page versions**. |
| **迭代 Sprint** | ✅ `/v1/pjm/projects/{id}/sprints` (§3.8.5). |
| **Access / 目录服务 SSO provisioning** | ⚠️ Only the `directory` CRUD in §3.3; no SSO/SCIM config endpoints. |

---

## 7. Deprecations, special permissions, plan tiers

**Deprecations:** none. Zero endpoints carry apiDoc's `deprecated` flag; the strings `废弃/已弃用/即将下线` never appear as API annotations (the 2 hits for 废弃 are a *test-case state enum value*, i.e. business data). Everything is nominally current — but note there is also no published deprecation policy or changelog, and §8 proves endpoints **have** silently disappeared between doc builds.

**Plan/tier gating:** **not documented at all.** Zero occurrences of 套餐 / 企业版 / 专业版 / 旗舰版. The docs make no statement about which subscription plan or purchased sub-product an endpoint requires. In practice a tenant that hasn't bought e.g. Testhub almost certainly can't call `/v1/testhub/*`. ⚠️ **This must be verified live and handled as a runtime error class in the CLI**, since it can't be predicted from docs.

**Special permission requirements:**

*A. 企业令牌-only (61 endpoints)* — cannot be driven by a user-authorized CLI:
- **All 54 DevOps endpoints** (`scm` 36, `build` 6, `release` 12)
- **All 5 Nexus/CES endpoints**
- `POST /v1/pjm/versions/bulk`, `POST /v1/pjm/sprints/bulk` ← note these 2 also declare **no scope**, unlike their non-bulk siblings

*B. 用户令牌-only (7 endpoints)* — cannot be driven by a machine/enterprise token:
- `GET /v1/myself`
- All 6 of `GET|POST /v1/permission/my/*` and `/v1/permission/check/*` (except `GET /v1/permission/points`, which accepts both)

**Design consequence:** a CLI covering the full surface needs **both** credential types simultaneously — `client_credentials` for DevOps/CES/bulk writes, and an authorization-code user token for `myself`/permission introspection. A single-token design cannot reach 100% coverage.

*C. Ownership restrictions* (enforced server-side, documented in prose):
- `PATCH`/`DELETE /v1/workloads/{id}`: with a user token, only the caller's own worklogs.
- `PATCH /v1/pjm/work_item_states/{id}`: 只有非系统类型的工作项状态才能更新 — system states are immutable.

---

## 8. ⚠️ The English bundle is stale — do not use it

`api_data_en.js` (`forceLanguage: "en"`) is an **older build**: 347 endpoints vs 460. Diff:

**Missing from EN (129):** essentially *every* single-resource `GET /…/{id}`, plus all 5 `POST …/search` endpoints, all 7 `/v1/permission/*`, all 5 CES endpoints, `POST /v1/pjm/projects/{id}/local_config/enable`, `/v1/ship/products/{id}/users` CRUD. Its `group` list is also visibly corrupted — several groups are raw absolute build paths like `/Users/wangyuan/code/pc-open/src/modules/v1/ship/product/plan/facade.ts`.

**Present only in EN (16) — these are removed/renamed legacy endpoints.** Valuable as a migration map:

| Legacy (EN bundle only) | Current equivalent |
|---|---|
| `GET|POST|PATCH|DELETE /v1/pjm/workloads[/{id}]`, `GET /v1/pjm/workload_types` | `/v1/workloads`, `/v1/workload_types` (promoted to global) |
| `GET|POST|DELETE /v1/pjm/work_items/{id}/participants[/{pid}]` | `/v1/participants` (polymorphic) |
| `POST|DELETE /v1/testhub/cases/{id}/work_item_relations/bulk` | `/v1/relations` (polymorphic) |
| `GET|POST|DELETE /v1/pjm/projects/{id}/work_item_types[/{tid}]` | `/v1/pjm/work_item_type_plans/{plan_id}/work_item_types` |
| `POST /v1/pjm/work_item_plans` ("Enable workitem local configuration") | `POST /v1/pjm/projects/{id}/local_config/enable` |
| `GET /v1/dashboard/pages` ("Get statistics page") | **removed, no replacement** |
| `GET https://oauth2_root/authorize` | `https://{oauth2_root}/authorize` (placeholder syntax fixed) |

**Also stale:** the third-party Apifox mirror <https://pingcode.apifox.cn/> — it documents `https://rest_api_root/v1[/{area}]/{resource}` without the newer `[/{action}]` segment. Readable HTML (useful if you need a human-browsable citation), but **do not treat as current**.

**Build against the Chinese `api_data.js` only.** Since PingCode publishes no changelog, I'd recommend the CLI repo vendor a pinned snapshot of `api_data.js` plus a CI job that re-fetches and diffs it — that's the only available deprecation signal.

---

## 9. Citable doc URLs

**Root:** <https://open.pingcode.com> · **Raw data:** `https://open.pingcode.com/api_data.js`

Narrative sections:

| Section | URL |
|---|---|
| 欢迎使用 | `https://open.pingcode.com/#api-%E6%A6%82%E8%BF%B0-%E6%AC%A2%E8%BF%8E%E4%BD%BF%E7%94%A8` |
| URI结构 | `https://open.pingcode.com/#api-%E6%A6%82%E8%BF%B0-URI%E7%BB%93%E6%9E%84` |
| 数据结构 | `https://open.pingcode.com/#api-%E6%A6%82%E8%BF%B0-%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84` |
| 使用方式 (pagination/envelope/errors) | `https://open.pingcode.com/#api-%E6%A6%82%E8%BF%B0-%E4%BD%BF%E7%94%A8%E6%96%B9%E5%BC%8F` |
| 频率限制 (rate limits) | `https://open.pingcode.com/#api-%E6%A6%82%E8%BF%B0-%E9%A2%91%E7%8E%87%E9%99%90%E5%88%B6` |

Per-module group anchors (50 endpoint-bearing groups):

| Module group (count) | URL |
|---|---|
| 客户端凭据 (1) | `https://open.pingcode.com/#api-%E5%AE%A2%E6%88%B7%E7%AB%AF%E5%87%AD%E6%8D%AE` |
| 授权码 (3) | `https://open.pingcode.com/#api-%E6%8E%88%E6%9D%83%E7%A0%81` |
| 个人 (1) | `https://open.pingcode.com/#api-%E4%B8%AA%E4%BA%BA` |
| 企业 (1) | `https://open.pingcode.com/#api-%E4%BC%81%E4%B8%9A` |
| 企业成员 (5) | `https://open.pingcode.com/#api-%E4%BC%81%E4%B8%9A%E6%88%90%E5%91%98` |
| 部门 (5) | `https://open.pingcode.com/#api-%E9%83%A8%E9%97%A8` |
| 团队 (8) | `https://open.pingcode.com/#api-%E5%9B%A2%E9%98%9F` |
| 角色 (2) | `https://open.pingcode.com/#api-%E8%A7%92%E8%89%B2` |
| 职位 (2) | `https://open.pingcode.com/#api-%E8%81%8C%E4%BD%8D` |
| 权限 (7) | `https://open.pingcode.com/#api-%E6%9D%83%E9%99%90` |
| 日志 (2) | `https://open.pingcode.com/#api-%E6%97%A5%E5%BF%97` |
| 工时 (7) | `https://open.pingcode.com/#api-%E5%B7%A5%E6%97%B6` |
| 附件 (5) | `https://open.pingcode.com/#api-%E9%99%
</task_result>
</task>