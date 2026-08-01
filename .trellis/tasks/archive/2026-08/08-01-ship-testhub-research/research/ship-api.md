# PingCode Ship (产品管理 / Product Management) Open API — endpoint-level map

**Purpose**: design input for a `pingcode product …` CLI surface. Read-only research; no code changes.

**Source of truth**: `https://open.pingcode.com/api_data.json` (apiDoc generator input), downloaded 2026-08-01, `2,367,650` bytes, `579` records.
- `574` records have a non-empty `url`; `5` are empty-`url` nav stubs (`DevOps_数据集成/交付`, `DevOps_数据集成/代码`, `DevOps_数据集成/构建`, `产品管理/产品配置中心`, `项目管理/项目配置中心`).
- Of the 574, `120` have a non-`/v1/` `url` (they are nav placeholders whose `url` is a Chinese label, e.g. `url: "产品成员"`, `url: "URI结构"`). **Real endpoints = 454.**
- **Ship endpoints = 101**, all matching `/v1/ship/…`. Every one of the 101 is a real endpoint (no stubs inside ship).
- Ship `group` distribution: `产品` 31, `工单配置` 30, `工单` 14, `需求配置` 14, `需求` 12.
- Ship method distribution: `GET` 68, `POST` 17, `DELETE` 8, `PATCH` 7 + `Patch` 1 (see GOTCHA #1).
- Every ship record has `version: "1.0.0"` and `permission: [{"name": "企业令牌/用户令牌"}]` (enterprise token **or** user token — no ship endpoint is enterprise-only at the doc level).

**Citation convention used below**: `record: {METHOD} {url} — {name}` uniquely identifies an `api_data.json` element. Where useful I also cite the record's `filename` (the PingCode server-side source path that apiDoc scraped), which is a strong signal about how the backend groups resources.

---

## 1. Resource inventory

Ship has **three top-level business objects** — 产品 (product), 需求 (idea), 工单 (ticket) — plus product-scoped sub-resources and two configuration centres. **There is no roadmap, no release/version, no feedback resource in ship.** (Verified: no ship URL contains `release|version|roadmap|feedback|backlog`. 发布/versions exist only under `pjm`: `/v1/pjm/projects/{project_id}/versions…`.)

| # | Family | 中文 | Endpoints | Backend module (`filename`) | Notes |
|---|---|---|---|---|---|
| A | Product (core) | 产品 | 4 | `ship/product/facade.ts` | POST / GET one / GET list / PATCH. **No DELETE, no archive.** |
| B | Product member | 产品成员 | 4 | `ship/product/member/facade.ts` | add / remove / get / list |
| C | Product tag | 标签 | 4 | `ship/product/tag/facade.ts` | add / remove / get / list. Tags are product-scoped. |
| D | Requirement module (suite) | 需求模块 | 4 | `ship/product/suite/facade.ts` | tree; `type` ∈ `product`(sub-product) \| `module` |
| E | Requirement schedule (plan) | 需求排期 | 2 | `ship/product/plan/facade.ts` | **read-only** (get one, list) |
| F | Ticket channel | 工单渠道 | 2 | `ship/configuration/product/channel/facade.ts` | **read-only**, product-scoped |
| G | Product↔ticket-type binding | 产品工单类型 | 2 | `ship/configuration/ticket/type/facade.ts` (2 of 4) | **read-only** join resource |
| H | Customer | 客户 | 4 | `ship/customer/facade.ts` | POST / GET one / GET list / PATCH. **No DELETE.** |
| I | External user | 外部用户 | 5 | `ship/user/facade.ts` | POST / DELETE / GET one / GET list / PATCH |
| J | Idea (需求) — primary work object | 需求 | 5 | `ship/idea/facade.ts` | POST / POST search / GET one / GET list / PATCH. **No DELETE.** |
| J2 | Idea transition history | 需求流转记录 | 2 | `ship/idea/transition-hisotry/facade.ts` *(sic, typo in server path)* | read-only |
| J3 | Idea metadata lookups (product-scoped) | 需求元数据 | 5 | `ship/idea/{priority,property,plan,suite,state}/facade.ts` | `?product_id=` required |
| K | Ticket (工单) | 工单 | 5 | `ship/ticket/facade.ts` | POST / POST search / GET one / GET list / PATCH. **No DELETE.** |
| K2 | Ticket transition history | 工单流转记录 | 2 | `ship/ticket/transition-hisotry/facade.ts` *(sic)* | read-only |
| K3 | Ticket metadata lookups (product-scoped) | 工单元数据 | 7 | `ship/ticket/{priority,property,tag,channel,state,type,solution}/facade.ts` | `?product_id=` required |
| L | Idea configuration | 需求配置 | 14 | `ship/configuration/idea/**` | properties 4, property_plans 6, priorities 2, states 2 |
| M | Ticket configuration | 工单配置 | 30 | `ship/configuration/ticket/**` | properties 4, property_plans 6, states 4, state_plans 2, states-in-plan 4, state_flows 4, types 2, priorities 2, solutions 2 |

**Reconciliation**: A–I = 31 (`group: 产品`); J+J2+J3 = 12 (`group: 需求`); K+K2+K3 = 14 (`group: 工单`); L = 14 (`group: 需求配置`); M = 30 (`group: 工单配置`). Total **101**. ✅

**Missing families a CLI designer might expect and will not find**: roadmap, release/version, feedback inbox, idea↔ticket "convert/promote" action, idea `tags` write, ticket `tags` write, bulk endpoints (`/bulk` exists in `pjm` and `testhub`, not in ship), any `DELETE` for a business object, any archive/restore, any `PUT` (ship has zero `PUT`; `release` module has some).

---

## 2. Endpoint tables (all 101)

Scope abbreviations: `W:product` = `pcp:write:ship:product`, `R:product` = `pcp:read:ship:product`, `R:cfg` = `pcp:read:ship:configuration`, `W:cfg` = `pcp:write:ship:configuration`, `R:idea`/`W:idea` = `pcp:{read,write}:ship:idea`, `R:ticket`/`W:ticket` = `pcp:{read,write}:ship:ticket`.
Path params are always required and are shown in the path. `REQ` = required body/query params. `OPT` = optional.

### A. Product (产品) — 4

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/products` | `name`, `identifier` | `scope_type`(`organization`\|`user_group`, def `organization`), `scope_id`, `visibility`(`public`\|`private`, def `private`), `description`, `members[]` (`members.id`+`members.type`∈`user`\|`user_group`, both REQ inside each element) | W:product | Create a product. |
| `GET /v1/ship/products/{product_id}` | — | `include_deleted`(Boolean, def false), `include_archived`(Boolean, def false) | R:product | Get one product. |
| `GET /v1/ship/products` | — | `scope_type`(`organization`\|`user_group`), `scope_id`, `keywords`(name only), `member_type`(`user`\|`user_group`), `member_id`, `created_between`, `updated_between`, `include_deleted`, `include_archived` | R:product | List/search products. `member_type` and `member_id` **must be supplied together**. |
| `PATCH /v1/ship/products/{product_id}` | — | `name`, `identifier`, `description` | W:product | Partial update. Only these 3 fields. |

### B. Product member (产品成员) — 4

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/products/{product_id}/members` | `member` (obj), `member.id`, `member.type`∈`user`\|`user_group` | `role_id` | W:product | Add one member (user or team). |
| `DELETE /v1/ship/products/{product_id}/members/{member_id}` | — | — | W:product | Remove a member. `member_id` = **the user id or the group id**, not a membership id. |
| `GET /v1/ship/products/{product_id}/members/{member_id}` | — | — | R:product | Get one member. |
| `GET /v1/ship/products/{product_id}/members` | — | — | R:product | List members. |

### C. Product tag (标签) — 4

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/products/{product_id}/tags` | `name` (unique per product) | — | W:product | Create a tag in a product. |
| `DELETE /v1/ship/products/{product_id}/tags/{tag_id}` | — | — | W:product | Remove a tag. |
| `GET /v1/ship/products/{product_id}/tags/{tag_id}` | — | — | **R:cfg** | Get one tag. |
| `GET /v1/ship/products/{product_id}/tags` | — | — | **R:cfg** | List tags. |

### D. Requirement module / suite (需求模块) — 4

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/products/{product_id}/suites` | `name`, `type`∈`product`\|`module` | `parent_id` | W:product | Add a module (`product` = sub-product 子产品, `module` = module). Names must be unique among siblings. |
| `DELETE /v1/ship/products/{product_id}/suites/{suite_id}` | — | — | W:product | Remove a module. **Deletes all descendants** (doc: 删除一个模块会自动删除其所有的子模块). |
| `GET /v1/ship/products/{product_id}/suites/{suite_id}` | — | — | R:product | Get one module. |
| `GET /v1/ship/products/{product_id}/suites` | — | — | R:product | List modules (flat list with `parent` refs). |

### E. Requirement schedule / plan (需求排期) — 2 (read-only)

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `GET /v1/ship/products/{product_id}/plans/{plan_id}` | — | — | R:product | Get one schedule (full: `assignee`, `start_at`, `end_at`). |
| `GET /v1/ship/products/{product_id}/plans` | — | — | R:product | List schedules. |

### F. Ticket channel (工单渠道) — 2 (read-only, product-scoped)

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `GET /v1/ship/products/{product_id}/channels/{channel_id}` | — | — | R:cfg | Get one channel. |
| `GET /v1/ship/products/{product_id}/channels` | — | — | R:cfg | List channels in a product. |

### G. Product↔ticket-type binding (产品工单类型) — 2 (read-only)

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `GET /v1/ship/products/{product_id}/ticket_types/{ticket_type_id}` | — | — | R:cfg | Get the binding of a ticket type to a product. |
| `GET /v1/ship/products/{product_id}/ticket_types` | — | — | R:cfg | List ticket types enabled in a product (returns `{id, url, product, ticket_type}` join objects). |

### H. Customer (客户) — 4

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/products/{product_id}/customers` | `name` | `assignee_id`, `scale`(Number), `description` | W:product | Create a customer. |
| `GET /v1/ship/products/{product_id}/customers/{customer_id}` | — | — | R:product | Get one customer. |
| `GET /v1/ship/products/{product_id}/customers` | — | — | R:product | List customers. |
| `PATCH /v1/ship/products/{product_id}/customers/{customer_id}` | — | `name`, `assignee_id`, `scale`, `description` | W:product | Partial update. |

### I. External user (外部用户) — 5

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/products/{product_id}/users` | `name` | `email`, `mobile`, `customer_id` | W:product | Create an external (customer-side) user. **`email` or `mobile` required — at least one; if both, `mobile` wins.** |
| `DELETE /v1/ship/products/{product_id}/users/{user_id}` | — | — | W:product | Delete an external user. |
| `GET /v1/ship/products/{product_id}/users/{user_id}` | — | — | R:product | Get one external user. |
| `GET /v1/ship/products/{product_id}/users` | — | — | R:product | List external users. |
| `PATCH /v1/ship/products/{product_id}/users/{user_id}` | — | `customer_id` (**only**) | W:product | Reassign an external user to a customer. Cannot change name/email/mobile. |

### J. Idea (需求) — 5

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/ideas` | `product_id`, `title` (≤255) | `assignee_id`, `description`, `suite_id`, `priority_id`, `properties` (obj; keys = property ids) | W:idea | Create an idea. **No `state_id`, no `plan_id`, no `tags`, no `plan_at` at create time.** |
| `POST /v1/ship/ideas/search` | `mode`=`query`, `payload` | `payload.filter`, `payload.keywords`, `payload.include_public_image_token`, `payload.page_size`(1–100, def 30), `payload.page_index`(def 0) | R:idea | Structured search. See §4. |
| `GET /v1/ship/ideas/{idea_id}` | — | `include_public_image_token` (comma-separated, ≤32, only `description` + custom `textarea` props) | R:idea | Get one idea. |
| `GET /v1/ship/ideas` | — | `product_id`, `state_id`, `priority_id`, `keywords`(identifier or title), `include_public_image_token` | R:idea | Simple list. Doc explicitly says use search for complex/date/custom-property filtering. **No `assignee_id`, no `suite_id`, no `plan_id` filter.** |
| `PATCH /v1/ship/ideas/{idea_id}` | — | `title`, `description`, `state_id`, `priority_id`, `assignee_id`, `progress`(0–1, 2 dp), `plan_at`{`from`,`to`,`granularity`∈`year`\|`quarter`\|`month`\|`day` — all three REQ when `plan_at` present}, `real_at` (same shape), `plan_id`, `suite_id`, `properties` | W:idea | Partial update. **No `product_id`** (cannot move products), no `score`, no `tags`. |

### J2. Idea transition history (需求流转记录) — 2

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `GET /v1/ship/ideas/{idea_id}/transition_histories/{transition_history_id}` | — | — | R:idea | Get one state-transition record. |
| `GET /v1/ship/ideas/{idea_id}/transition_histories` | — | — | R:idea | List state transitions (`from_state`/`to_state`, `created_at`, `created_by`). |

### J3. Idea metadata lookups (product-scoped) — 5

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `GET /v1/ship/idea/priorities?product_id={product_id}` | `product_id` (query) | — | R:idea | Priorities available to ideas in a product. |
| `GET /v1/ship/idea/properties?product_id={product_id}` | `product_id` | — | R:idea | Idea properties (the "property view") for a product — **the authoritative list of valid `properties` keys**. |
| `GET /v1/ship/idea/plans?product_id={product_id}` | `product_id` | — | R:idea | Requirement schedules for `plan_id`. |
| `GET /v1/ship/idea/suites?product_id={product_id}` | `product_id` | — | R:idea | Modules for `suite_id`. |
| `GET /v1/ship/idea/states?product_id={product_id}` | `product_id` | — | R:idea | States for `state_id`. |

Note the singular path segment `idea` (not `ideas`) on all five.

### K. Ticket (工单) — 5

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/tickets` | `product_id`, `title`(≤255), **`type_id`** | `description`, `submitter_id`, `customer_id`, `channel_id`, `assignee_id`, `priority_id`, `properties` | W:ticket | Create a ticket. `submitter_id` is only honoured with **enterprise** auth (企业授权); ignored for personal auth. **No `state_id`, no `solution_id`, no `tags`, no `estimated_at`.** |
| `POST /v1/ship/tickets/search` | `mode`=`query`, `payload` | `payload.filter`, `payload.keywords`, `payload.include_public_image_token`, `payload.page_size`(1–100, def 30), `payload.page_index`(def 0) | R:ticket | Structured search. See §4. |
| `GET /v1/ship/tickets/{ticket_id}` | — | `include_public_image_token` | R:ticket | Get one ticket. |
| `GET /v1/ship/tickets` | — | `product_id`, `type_id`, `state_id`, `priority_id`, `keywords`, `include_public_image_token` | R:ticket | Simple list. **No `assignee_id`, `customer_id`, `channel_id`, `solution_id` filters.** |
| `PATCH /v1/ship/tickets/{ticket_id}` | — | `title`, `description`, `type_id`, `state_id`, `assignee_id`, `submitter_id`, `solution_id`, `priority_id`, `customer_id`, `properties` | W:ticket | Partial update. **No `channel_id`** (channel is set-once), no `tags`, no `estimated_at`, no `product_id`. |

### K2. Ticket transition history (工单流转记录) — 2

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `GET /v1/ship/tickets/{ticket_id}/transition_histories/{transition_history_id}` | — | — | R:ticket | Get one transition record. |
| `GET /v1/ship/tickets/{ticket_id}/transition_histories` | — | — | R:ticket | List transitions. |

### K3. Ticket metadata lookups (product-scoped) — 7

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `GET /v1/ship/ticket/priorities?product_id={product_id}` | `product_id` | — | R:ticket | Priorities for `priority_id`. |
| `GET /v1/ship/ticket/properties?product_id={product_id}` | `product_id` | — | R:ticket | Ticket property view — valid `properties` keys. |
| `GET /v1/ship/ticket/tags?product_id={product_id}` | `product_id` | — | R:ticket | Tags usable on tickets (read-only; see GOTCHA #10). |
| `GET /v1/ship/ticket/channels?product_id={product_id}` | `product_id` | — | R:ticket | Channels for `channel_id`. |
| `GET /v1/ship/ticket/states?product_id={product_id}` | `product_id` | — | R:ticket | States for `state_id`. |
| `GET /v1/ship/ticket/types?product_id={product_id}` | `product_id` | — | R:ticket | Types for the **required** `type_id` on create. |
| `GET /v1/ship/ticket/solutions?product_id={product_id}` | `product_id` | — | R:ticket | Solutions for `solution_id`. |

Note: the same underlying data is reachable two ways with **different scopes** — e.g. channels via `R:ticket` (`/v1/ship/ticket/channels?product_id=`) or via `R:cfg` (`/v1/ship/products/{id}/channels`); tags via `R:ticket` (`/v1/ship/ticket/tags?product_id=`) or `R:cfg` (`/v1/ship/products/{id}/tags`).

### L. Idea configuration (需求配置) — 14

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/idea_properties` | `name` (unique per org), `type` ∈ `text`,`textarea`,`select`,`multi_select`,`cascade_select`,`cascade_multi_select`,`member`,`members`,`date`,`number`,`progress`,`rate`,`link` | `options[]` (`options.text` REQ per element; `options._id`, `options.parent_id` opt) | W:cfg | Create an org-level idea property. `options` only meaningful for the 4 select types; `parent_id` only for cascade types, max 4 levels. |
| `PATCH /v1/ship/idea_properties/{property_id}` | — | `name`, `options[]` (`options.text` REQ per element) | W:cfg | Update. **`options` is replaced wholesale (整体更新), not merged.** `type` is not updatable. |
| `GET /v1/ship/idea_properties/{property_id}` | — | — | R:cfg | Get one property. |
| `GET /v1/ship/idea_properties` | — | — | R:cfg | List all org idea properties. |
| `POST /v1/ship/idea_property_plans/{property_plan_id}/idea_properties` | `property_id` | — | W:cfg | Add a property to a property plan (= "property view"). |
| `DELETE /v1/ship/idea_property_plans/{property_plan_id}/idea_properties/{property_id}` | — | — | W:cfg | Remove a property from a plan. |
| `GET /v1/ship/idea_property_plans/{property_plan_id}/idea_properties/{property_id}` | — | — | R:cfg | Get one property in a plan. |
| `GET /v1/ship/idea_property_plans/{property_plan_id}/idea_properties` | — | — | R:cfg | List properties in a plan. |
| `GET /v1/ship/idea_property_plans/{property_plan_id}` | — | — | R:cfg | Get one property plan (`{id, url, product}`; `product` may be `null` = global default). |
| `GET /v1/ship/idea_property_plans` | — | — | R:cfg | List property plans across products. |
| `GET /v1/ship/idea_priorities/{priority_id}` | — | — | R:cfg | Get one idea priority. |
| `GET /v1/ship/idea_priorities` | — | — | R:cfg | List all idea priorities. |
| `GET /v1/ship/idea_states/{idea_state_id}` | — | — | R:cfg | Get one idea state. |
| `GET /v1/ship/idea_states` | — | — | R:cfg | List all idea states. |

**Asymmetry**: ideas have **no** state-plan and **no** state/priority write endpoints. Tickets do (`ticket_state_plans`, `ticket_state_flows`, `POST/PATCH ticket_states`).

### M. Ticket configuration (工单配置) — 30

| Method + Path | REQ | OPT | Scope | Purpose |
|---|---|---|---|---|
| `POST /v1/ship/ticket_properties` | `name`, `type` (same 13-value enum as idea properties) | `options[]` (`options.text` REQ; `_id`, `parent_id` opt) | W:cfg | Create an org-level ticket property. |
| `PATCH /v1/ship/ticket_properties/{property_id}` | — | `name`, `options[]` | W:cfg | Update; `options` replaced wholesale. |
| `GET /v1/ship/ticket_properties/{property_id}` | — | — | R:cfg | Get one. |
| `GET /v1/ship/ticket_properties` | — | — | R:cfg | List all. |
| `POST /v1/ship/ticket_property_plans/{property_plan_id}/ticket_properties` | `property_id` | — | W:cfg | Add property to plan. |
| `DELETE /v1/ship/ticket_property_plans/{property_plan_id}/ticket_properties/{property_id}` | — | — | W:cfg | Remove property from plan. |
| `GET /v1/ship/ticket_property_plans/{property_plan_id}/ticket_properties/{property_id}` | — | — | R:cfg | Get one property in plan. |
| `GET /v1/ship/ticket_property_plans/{property_plan_id}/ticket_properties` | — | — | R:cfg | List properties in plan. |
| `GET /v1/ship/ticket_property_plans/{property_plan_id}` | — | — | R:cfg | Get one property plan. |
| `GET /v1/ship/ticket_property_plans` | — | — | R:cfg | List property plans. |
| `POST /v1/ship/ticket_states` | `name` (unique per org), `type` ∈ `pending`,`in_progress`,`completed`,`closed` | — | W:cfg | Create a ticket state. |
| `PATCH /v1/ship/ticket_states/{ticket_state_id}` | — | `name`, `type` (same enum) | W:cfg | Update a ticket state. (`type` field of this record is `"Patch"`, see GOTCHA #1.) |
| `GET /v1/ship/ticket_states/{ticket_state_id}` | — | — | R:cfg | Get one state. |
| `GET /v1/ship/ticket_states` | — | — | R:cfg | List all states. |
| `GET /v1/ship/ticket_state_plans/{state_plan_id}` | — | — | R:cfg | Get one state plan (`{id, url, product}`, `product` nullable). |
| `GET /v1/ship/ticket_state_plans` | — | — | R:cfg | List state plans. |
| `POST /v1/ship/ticket_state_plans/{state_plan_id}/ticket_states` | `state_id` | — | W:cfg | Add a state to a state plan. |
| `DELETE /v1/ship/ticket_state_plans/{state_plan_id}/ticket_states/{state_id}` | — | — | W:cfg | Remove a state from a plan. **Fails if it would leave a `type` with zero states.** |
| `GET /v1/ship/ticket_state_plans/{state_plan_id}/ticket_states/{state_id}` | — | — | R:cfg | Get one state in plan. |
| `GET /v1/ship/ticket_state_plans/{state_plan_id}/ticket_states` | — | — | R:cfg | List states in plan. |
| `POST /v1/ship/ticket_state_plans/{state_plan_id}/ticket_state_flows` | `from_state_id`, `to_state_id` | — | W:cfg | Add an allowed transition. |
| `DELETE /v1/ship/ticket_state_plans/{state_plan_id}/ticket_state_flows/{state_flow_id}` | — | — | W:cfg | Remove a transition. |
| `GET /v1/ship/ticket_state_plans/{state_plan_id}/ticket_state_flows/{state_flow_id}` | — | — | R:cfg | Get one transition. |
| `GET /v1/ship/ticket_state_plans/{state_plan_id}/ticket_state_flows` | — | — | R:cfg | List transitions (this is how you know which `state_id` a ticket may move to). |
| `GET /v1/ship/ticket_types/{ticket_type_id}` | — | — | R:cfg | Get one ticket type (`is_system`). |
| `GET /v1/ship/ticket_types` | — | — | R:cfg | List all ticket types. |
| `GET /v1/ship/ticket_priorities/{priority_id}` | — | — | R:cfg | Get one priority. |
| `GET /v1/ship/ticket_priorities` | — | — | R:cfg | List all priorities. |
| `GET /v1/ship/ticket_solutions/{ticket_solution_id}` | — | — | R:cfg | Get one solution. |
| `GET /v1/ship/ticket_solutions` | — | — | R:cfg | List all solutions. |

---

## 3. Response field lists (core resources)

All list endpoints return the standard envelope `{page_size, page_index, total, values[]}` — documented explicitly as `success.fields` on every ship list record. `page_size`/`page_index` are **never documented as inputs** on GET lists (only inside `payload` of the two `POST …/search` bodies).

### 3.1 Product (产品) — full structure
`record: GET /v1/ship/products/{product_id} — 获取一个产品`

`id`, `url`, `identifier`, `name`, `scope_type`, `scope_id`, `visibility`, `color`, `description`, `members[]`, `created_at`, `created_by`, `updated_at`, `updated_by`, `is_archived`, `is_deleted`.

- `members[]` elements: `{id, url, type, user?, user_group?}` — `user` present iff `type == "user"`, `user_group` iff `type == "user_group"`. **The member's `id` equals the user/group id.** In the *embedded* form (inside a product) there is **no `role`**; in the dedicated member endpoints there **is** `role` and `product`.
- Field order differs between the single-get example (`scope_type` before `visibility`) and the list example (`visibility` before `scope_type`) — cosmetic only, but note the docs are hand-maintained.
- `color` is read-only (no write parameter anywhere).
- Product **reference** structure (as embedded elsewhere): `{id, url, identifier, name, is_archived, is_deleted}`.

### 3.2 Idea (需求) — full structure — ship's primary work object
`record: GET /v1/ship/ideas/{idea_id} — 获取一个需求`

`id`, `url`, `product`, `identifier`, `title`, `short_id`, `html_url`, `assignee`, `state`, `priority`, `plan`, `suite`, `plan_at{from,to,granularity}`, `real_at{from,to,granularity}`, `score`, `progress`, `description`, `properties`, `properties.prop_a`, `properties.prop_b`, `participants[]`, `public_image_token`, `completed_at`, `completed_by`, `created_at`, `created_by`, `updated_at`, `updated_by`, `is_archived`, `is_deleted`.

- Idea **reference** structure (as seen in `/v1/relations`): `{id, url, identifier, title, short_id, html_url}`.
- `state` ref: `{id, url, name, type}` where `type` ∈ `pending`… (idea state `type` enum is **not** documented anywhere — see §9).
- `suite` ref: `{id, url, name, type}` with `type: "module"`.
- `plan` ref: `{id, url, name}`.
- `properties` values for select-type properties are **option `_id`s**, not display text: `"backlog_type": "5cb7e763fda1ce4ca0010002"` matches `options[]._id` from `GET /v1/ship/idea/properties`. Doc request examples only show text-type values (`"prop_a": "prop_a_value"`), which is misleading.
- System properties visible in examples: `backlog_from`, `backlog_type`, `identifier`.
- **Doc inconsistencies**:
  - `POST /v1/ship/ideas` and `PATCH /v1/ship/ideas/{idea_id}` are the **only two ship records with no `success.fields` table at all** — they have response examples only. The field list above therefore comes from the GET record.
  - The `POST /v1/ship/ideas` response example is **syntactically invalid JSON** (missing comma after `"html_url"`, line 16) — it is the only malformed example among all ship request/response examples. Do not machine-parse it.
  - `real_at.granularity` is described as "需求的**计划**时间周期单位" (copy-paste from `plan_at`).
  - `score` appears in the response and in the search DSL but has **no write parameter** → read-only/computed.
  - Idea has **no `tags` field** in the response schema, yet `POST /v1/ship/ideas/search` documents `tags.id` as filterable (see GOTCHA #11).

### 3.3 Ticket (工单) — full structure
`record: GET /v1/ship/tickets/{ticket_id} — 获取一个工单`

`id`, `url`, `product`, `identifier`, `title`, `short_id`, `html_url`, `assignee`, `state`, `type`, `customer`, `solution`, `priority`, `channel`, `description`, `properties`, `properties.prop_a`, `properties.prop_b`, `estimated_at{from,to,granularity}`, `tags[]`, `participants[]`, `public_image_token`, `submitted_at`, `submitted_by`, `completed_at`, `completed_by`, `created_at`, `created_by`, `updated_at`, `updated_by`, `is_archived`, `is_deleted`.

- **`channel` is `Object`/`String`** — documented type literally `"Object/String"`: an object for externally-submitted tickets, or the bare string `"internal"` for internal tickets. This is the single most important shape hazard in ship.
- `tags[]` elements are product-tag refs `{id, url, name}` (url points at `/v1/ship/products/{pid}/tags/{tid}`).
- `state` ref includes `type` ∈ `pending`|`in_progress`|`completed`|`closed` (enum confirmed by `POST /v1/ship/ticket_states`).
- Ticket **reference** structure: `{id, url, identifier, title, short_id, html_url}` (identical shape to idea ref → a CLI cannot tell them apart without `principal_type`/`target_type`).
- `estimated_at` is present in responses but has **no write parameter** and is explicitly listed as **not filterable** in ticket search.
- `properties.prop_a`/`prop_b` are documented as `Object` type but examples show plain strings — the `<Object>` typing in the docs is a placeholder, not a real type.

### 3.4 Customer (客户) — full structure
`record: GET /v1/ship/products/{product_id}/customers/{customer_id}`

`id`, `url`, `product`, `name`, `assignee`, `scale`, `description`, `created_at`, `created_by`, `updated_at`, `updated_by`, `is_archived`, `is_deleted`. Customer ref: `{id, url, name}`.

### 3.5 External user (外部用户) — full structure
`record: GET /v1/ship/products/{product_id}/users/{user_id}`

`id`, `url`, `name`, `display_name`, `avatar`, `email`, `mobile`, `product`, `customer`. **No `created_at`/`is_deleted`** — this resource does not follow the standard audit-field convention. In the example, the external user's `id` is a **24-hex ObjectId** (`64a2b61c3a12e6c2e46d41e9`) whereas org users are 32-hex (`a0417f68e846aae315c85d24643678a9`).

### 3.6 Metadata / configuration objects (exact shapes)

| Resource | Fields | Source record |
|---|---|---|
| suite (module) | `id, url, product, name, type, parent` | `GET …/suites/{suite_id}` |
| plan (schedule) — full | `id, url, product, name, assignee, start_at, end_at` | `GET …/plans/{plan_id}` |
| plan — as returned by `GET /v1/ship/idea/plans` | `id, url, name` **only** | inconsistency, see GOTCHA #12 |
| tag | `id, url, product, name, color` | `GET …/tags/{tag_id}` |
| channel | `id, url, name, product, description` | `GET …/channels/{channel_id}` |
| product↔ticket_type join | `id, url, product, ticket_type` | `GET …/ticket_types/{ticket_type_id}` |
| member | `id, url, product, type, user?, user_group?, role` | `GET …/members/{member_id}` |
| ticket state | `id, url, name, type, color` | `GET /v1/ship/ticket_states/{id}` |
| idea state | `id, url, name, type, color` | `GET /v1/ship/idea_states/{id}` |
| priority (idea & ticket) | `id, url, name` | `GET /v1/ship/{idea,ticket}_priorities/{id}` |
| ticket type | `id, url, name, is_system` | `GET /v1/ship/ticket_types/{id}` — but the **product-scoped** list `GET /v1/ship/ticket/types?product_id=` omits `is_system` |
| ticket solution | `id, url, name` | `GET /v1/ship/ticket_solutions/{id}` |
| property (idea) | `id, url, name, type, options[], is_removable, is_name_editable, is_options_editable` **+ (POST/PATCH only) `select_all_level`, `display_all_level`, `display_separator`** | `POST/PATCH /v1/ship/idea_properties` vs `GET /v1/ship/idea_properties/{id}` |
| property (ticket) | `id, url, name, type, options[], is_removable, is_name_editable, is_options_editable` — cascade display fields **never documented** | `GET /v1/ship/ticket_properties/{id}` |
| property plan | `id, url, product` (`product` nullable) | `GET /v1/ship/{idea,ticket}_property_plans/{id}` |
| state plan | `id, url, product` (`product` nullable) | `GET /v1/ship/ticket_state_plans/{id}` |
| state flow | `id, url, state_plan, **form_state**, to_state` | GOTCHA #2 |
| transition history | `id, url, {idea\|ticket}, from_state, to_state, created_at, created_by` | `from_state` may be `null` for the first transition |

---

## 4. Search / filter DSL

Ship has exactly **two** search endpoints: `POST /v1/ship/ideas/search` and `POST /v1/ship/tickets/search`. Body shape is identical:

```json
{
  "mode": "query",
  "payload": {
    "filter": { "<field>": { "<operator>": <value> } },
    "keywords": "SLC-1",
    "include_public_image_token": "description",
    "page_size": 10,
    "page_index": 0
  }
}
```

- `mode` is REQUIRED and its only allowed value is `"query"`.
- `payload` is REQUIRED; every key inside it is optional.
- `page_size` 1–100 (default 30), `page_index` 0-based (default 0). These are the **only** documented pagination inputs in all of ship.
- `keywords` matches identifier **or** title.
- Naming rules: reference fields use `{field}.id` (e.g. `product.id`, `assignee.id`, `tags.id`, `participants.id`); custom properties use `properties.{key}` (e.g. `properties.prop_a`).
- **One operator per field. No logical operators (`$and`/`$or`) — explicitly "暂不支持使用逻辑运算符".** Multiple fields in `filter` are implicitly AND-ed.
- **No sorting parameter** on either endpoint (consistent with the established fact that only `POST /v1/nexus/ces/find` supports sorting).

### Operators by field type (identical for both endpoints unless noted)

| Field type | Operators |
|---|---|
| Text (`title`, `description`, custom `text`/`textarea`/`link`) | `exists`, `contains` |
| Number | `exists`, `eq`, `ne`, `gt`, `lt`, `gte`, `lte` — **tickets**: custom `number`/`progress`/`rate` only; **ideas**: doc names built-ins `score`, `effort`, `progress` |
| Time (Unix seconds) | `exists`, `gt`, `lt`, `gte`, `lte`, `between` (value = `[start, end]`) — **filtering granularity is per-day (以「天」为单位)**, so `gte: 1730000000` is snapped to a day boundary |
| Option (custom `select`, `multi_select`, `cascade_select`, `cascade_multi_select`) | `exists`, `in`, `nin` |
| Reference (incl. array refs) | `exists`, `in`, `nin` |

### Filterable reference fields

- **Ticket**: `product.id`, `type.id`, `state.id`, `priority.id`, `assignee.id`, `submitted_by.id`, `customer.id`, `solution.id`, `channel.id`, `tags.id`, `participants.id`.
- **Idea** (doc's enumerated list): `product.id`, `state.id`, `priority.id`, `assignee.id`, `tags.id`. The idea request **example** also uses `participants.id`, which is not in the enumerated list — treat `participants.id` as probably-working-but-undocumented for ideas.
- Filterable time fields — **ticket**: `submitted_at`, `created_at`, `updated_at`, `completed_at`. **Idea**: `created_at`, `updated_at`, `completed_at`.

### NOT filterable (explicit doc statements)

- **Ticket**: `id`, `url`, `identifier`, `short_id`, `html_url`, `public_image_token`, `estimated_at`, `is_archived`, `is_deleted`.
- **Idea**: `id`, `url`, `identifier`, `short_id`, `html_url`, `public_image_token`, `is_archived`, `is_deleted`.
- Idea `plan.id`, `suite.id`, `plan_at`, `real_at` appear in **neither** the filterable nor the non-filterable list → undetermined (see §9). This matters: you cannot rely on filtering ideas by module or schedule.

---

## 5. Parent-scoping map (what a CLI must resolve before writing)

```
organization (enterprise)
├── ship product  (24-hex ObjectId; also has a human `identifier`, e.g. "SLC", unique per org)
│   ├── member            id = user id (32-hex) or user_group id (24-hex)   [scoped to product]
│   ├── tag               24-hex                                            [scoped to product]
│   ├── suite (module)    24-hex, tree via parent_id                        [scoped to product]
│   ├── plan (schedule)   24-hex                                            [scoped to product, read-only]
│   ├── channel           24-hex                                            [scoped to product]
│   ├── customer          24-hex                                            [scoped to product]
│   ├── external user     24-hex                                            [scoped to product, optionally → customer]
│   ├── ticket_type binding (product ↔ org-level ticket_type)
│   ├── idea_property_plan   ── 1:1-ish with product; `product` may be null (global default)
│   ├── ticket_property_plan ── same
│   └── ticket_state_plan    ── same
├── org-level (NOT product-scoped, shared across products)
│   ├── idea_property / ticket_property   id may be a SLUG (`solution`, `identifier`, `backlog_type`) or 24-hex
│   ├── idea_state / ticket_state         24-hex
│   ├── idea_priority / ticket_priority   24-hex legacy constants (e.g. 5cb9466afda1ce4ca0090005 = "P0")
│   ├── ticket_type                       24-hex, has is_system
│   └── ticket_solution                   24-hex
└── work objects
    ├── idea   → product_id (REQ at create), suite_id, plan_id, priority_id, state_id (PATCH only), assignee_id
    └── ticket → product_id + type_id (both REQ at create), state_id/solution_id (PATCH only),
                 customer_id, channel_id (create only), priority_id, assignee_id
```

**Practical consequence — the lookup chain a CLI must walk:**

| To write… | You must first resolve… | Via |
|---|---|---|
| any idea/ticket | `product_id` | `GET /v1/ship/products?keywords=` (name search only — **`identifier` is not searchable**) |
| `POST /v1/ship/tickets` | `type_id` (**required**) | `GET /v1/ship/ticket/types?product_id=` |
| idea/ticket `priority_id` | product-scoped priority list | `GET /v1/ship/{idea,ticket}/priorities?product_id=` |
| idea/ticket `state_id` (PATCH) | product-scoped state list; for tickets also the allowed flow | `GET /v1/ship/{idea,ticket}/states?product_id=`; `GET /v1/ship/ticket_state_plans/{plan}/ticket_state_flows` |
| idea `suite_id` | product modules | `GET /v1/ship/idea/suites?product_id=` or `GET /v1/ship/products/{id}/suites` |
| idea `plan_id` | product schedules | `GET /v1/ship/idea/plans?product_id=` or `GET /v1/ship/products/{id}/plans` |
| ticket `customer_id` | product customers | `GET /v1/ship/products/{id}/customers` |
| ticket `channel_id` | product channels | `GET /v1/ship/ticket/channels?product_id=` or `GET /v1/ship/products/{id}/channels` |
| ticket `solution_id` | solutions | `GET /v1/ship/ticket/solutions?product_id=` |
| `assignee_id` / `submitter_id` | product members (32-hex user ids) | `GET /v1/ship/products/{id}/members` |
| `properties.{key}` | the product's property view **and** the option `_id`s | `GET /v1/ship/{idea,ticket}/properties?product_id=` |
| product `members[].id` at create | org users / teams | `/v1/directory/users`, `/v1/directory/groups` (outside ship) |
| product member `role_id` | roles | `/v1/directory/roles` (outside ship; only visible as a `role.url` in member responses) |

Metadata that is **org-level but exposed product-scoped** (properties, states, priorities, types, solutions) must still be fetched per product, because the product's *plan* (property view / state plan) determines which subset is valid. Do not cache the org-level `/v1/ship/ticket_states` list and assume it applies to a product.

---

## 6. Cross-module relationships (ship ↔ pjm and others)

Ship objects participate in the generic (non-`area`) resources via `principal_type` / `target_type`. Ship contributes exactly two principal types: **`idea`** and **`ticket`**. (`product` is a *pilot*, not a principal — see reviews and workloads below.)

### 6.1 `/v1/relations` — the ship↔pjm link
`record: POST /v1/relations — 创建一个关联`, body: `principal_type`, `principal_id`, `target_type`, `target_id` (all required). Allowed pairs involving ship, with the scopes each pair requires:

| principal_type | target_type | write scopes required |
|---|---|---|
| `idea` | `ticket` | `pcp:write:ship:idea` + `pcp:write:ship:ticket` |
| `idea` | `work_item` | `pcp:write:ship:idea` + `pcp:write:pjm:workitem` |
| `idea` | `test_case` | `pcp:write:ship:idea` + `pcp:write:testhub:testcase` |
| `idea` | `idea` | `pcp:write:ship:idea` |
| `idea` | `page` | `pcp:write:ship:idea` + `pcp:write:wiki:page` |
| `ticket` | `idea` | `pcp:write:ship:ticket` + `pcp:write:ship:idea` |
| `ticket` | `work_item` | `pcp:write:ship:ticket` + `pcp:write:pjm:workitem` |
| `ticket` | `ticket` | `pcp:write:ship:ticket` |
| `ticket` | `page` | `pcp:write:ship:ticket` + `pcp:write:wiki:page` |
| `work_item` | `idea` | `pcp:write:pjm:workitem` + `pcp:write:ship:idea` |
| `work_item` | `ticket` | `pcp:write:pjm:workitem` + `pcp:write:ship:ticket` |
| `test_case` | `idea` | `pcp:write:testhub:testcase` + `pcp:write:ship:idea` |
| `page` → idea/ticket/work_item/test_case | — | **"暂不开放" (not open) for writes** |

**Read asymmetry**: `GET /v1/relations?principal_type=&principal_id=&target_type=` (all three required) *does* list `page → idea`, `page → ticket`, etc. So `page`-as-principal is readable but not writable. Also note relations are directional in the API: to find every link on an idea you must query each `target_type` separately (`ticket`, `work_item`, `test_case`, `idea`, `page`) — there is no "all targets" mode.

Relation response: `{id, url, principal_type, principal, target_type, target}` where `principal`/`target` are the *reference* structures. Idea and ticket refs are structurally identical (`{id,url,identifier,title,short_id,html_url}`), so **you must use `target_type` to disambiguate**; `url` is the only other discriminator (`/ship/ideas/…` vs `/ship/tickets/…`).

### 6.2 Other generic resources accepting ship principals

| Endpoint family | ship principal types accepted | Notes |
|---|---|---|
| `/v1/participants` (关注人) | `idea`, `ticket` | The only way to add/remove watchers — ship write endpoints have no `participants` param. Requires `pcp:{read,write}:ship:{idea,ticket}` in addition. `participant.url` in ship responses is `/v1/participants/{id}?principal_type=idea&principal_id=…`. |
| `/v1/comments` (评论) | `idea`, `ticket` | |
| `/v1/attachments` (附件) | `idea`, `ticket` | Both "upload a file" and "upload a code snippet". `work_item_deliverable` exists for pjm; nothing equivalent for ship. |
| `/v1/activities` (活动记录) | `idea`, `ticket` | |
| `/v1/workloads` (工时) | `idea` **only** (not `ticket`) | `pilot_id` = product id for ideas. Own scope `pcp:{read,write}:global:workload` **plus** `pcp:write:ship:idea`. When filtering by `pilot_id`, the date range is capped at 3 months. |
| `/v1/reviews` (评审) | `idea` **only** | `pilot_id` = **product id**; and the required scope for idea reviews is `pcp:write:ship:product` (**not** `:idea`) — an inconsistency in the permission model. |
| `/v1/permission/{check,my}/principal` | `idea`, `ticket` | For pre-flight permission checks. |

**There is no ship→pjm "convert idea to work item" endpoint.** The only linkage is a `relation`. Likewise there is no ship-side field pointing at a pjm work item — `pjm` work items carry no `idea_id`, and ideas carry no `work_item_id`.

---

## 7. GOTCHAS

1. **`type` casing is not normalized in `api_data.json`.** 100 ship records use uppercase (`GET`/`POST`/`PATCH`/`DELETE`), but `PATCH /v1/ship/ticket_states/{ticket_state_id}` has `"type": "Patch"`. Any codegen reading this file must `.upper()`. (Also that record has an **empty `description`** — the only ship endpoint with no prose at all.)
2. **`form_state` typo.** The state-flow resource documents its field as **`form_state`** (not `from_state`) in three records: `POST …/ticket_state_flows`, `DELETE …/ticket_state_flows/{state_flow_id}`, `GET …/ticket_state_flows/{state_flow_id}` — while `transition_histories` correctly use `from_state`. Unknown whether the wire format really is `form_state`; a CLI should accept **both** keys. **Cannot be resolved from `api_data.json`** (no response example exists for state flows).
3. **`ticket.channel` is `Object` OR the bare string `"internal"`.** Documented type is literally `"Object/String"`. Naive `ticket.channel.name` will throw on internal tickets. Additionally the ticket example's channel `url` is `/v1/ship/channels/{id}` — **an endpoint that does not exist**; the real one is `/v1/ship/products/{product_id}/channels/{channel_id}`. Never follow `channel.url`.
4. **Property/metadata ids are not always ObjectIds — system ones are slugs.** `GET /v1/ship/ticket/properties?product_id=` returns `{"id": "solution", …}` and `{"id": "identifier", …}`; `GET /v1/ship/idea/properties?product_id=` returns `{"id": "backlog_type", …}`, `{"id": "identifier", …}`. The doc's own request example for `POST /v1/ship/ticket_property_plans/{plan}/ticket_properties` is `{"property_id": "solution"}`. Do not validate property ids as 24-hex.
5. **`properties` values for select types are option `_id`s, not text.** Evidence: idea GET returns `"backlog_type": "5cb7e763fda1ce4ca0010002"`, and `GET /v1/ship/idea/properties` shows that exact string as `options[]._id` ("功能需求"). The doc's write examples (`"prop_a": "prop_a_value"`) only illustrate text-type properties and will mislead you into sending display labels.
6. **`properties` writes require the property to be in the product's property view.** `POST /v1/ship/ideas` states: "当前产品的需求属性视图需要包含这些需求属性". Whether an out-of-view key is rejected with an error or **silently dropped** is not documented → must be probed live.
7. **`options` on property PATCH is a wholesale replacement, not a merge.** `PATCH /v1/ship/{idea,ticket}_properties/{property_id}` says "options是整体更新的". Any option you omit is deleted (and existing values referencing it presumably orphaned). Elements you want to keep must be re-sent **with their `_id`**.
8. **The property `options` examples contradict themselves about the id key.** `POST` and cascade examples use `"_id"`; the non-cascade `PATCH` example uses `"id"` (`{"id": "5efb1859110533727a82c603", "text": "严重-update"}`) while the cascade `PATCH` example in the same record uses `"_id"`. The declared parameter name is `options._id`. Send `_id`.
9. **`plan_at` / `real_at` are all-or-nothing objects.** "plan_at是整体更新的，其中包含from、to、granularity三个属性，均为必填" — you cannot patch just `plan_at.to`. `granularity` ∈ `year|quarter|month|day`.
10. **Tags cannot be attached to tickets or ideas through the API.** `ticket.tags[]` is returned, `GET /v1/ship/ticket/tags?product_id=` lists candidates, product tags can be created/deleted — but **no create/update endpoint accepts a tag parameter**, and ideas don't even expose a `tags` field. Tag assignment is UI/Flow-only.
11. **The idea search DSL advertises a field the idea schema doesn't have.** `POST /v1/ship/ideas/search` lists `tags.id` as a filterable reference field and `effort` as a filterable number, but neither `tags` nor `effort` appears in the idea response field list or example. Either the DSL doc is copy-pasted from tickets/work items, or the schema doc is incomplete. Do not build a `--tag` flag for ideas without live verification.
12. **Reference-vs-full structure varies for the *same* resource depending on the endpoint.** `GET /v1/ship/products/{id}/plans` returns full plans (`assignee`, `start_at`, `end_at`); `GET /v1/ship/idea/plans?product_id=` returns only `{id, url, name}`. Same for the product↔ticket_type join: `GET /v1/ship/ticket_types` includes `is_system`, the product-scoped list does not. Don't share one deserializer across both paths.
13. **Required-together and conditionally-required parameters.**
    - `GET /v1/ship/products`: `member_type` and `member_id` must both be present.
    - `POST /v1/ship/products`: `scope_id` is required **iff** `scope_type == "user_group"`, and is *ignored* otherwise.
    - `POST /v1/ship/products/{id}/users`: at least one of `email`/`mobile`; if both are sent, `mobile` takes precedence (the email you passed is effectively downgraded).
    - `POST /v1/ship/products`: `members[].id` and `members[].type` are both required inside each element even though `members` itself is optional.
14. **Write endpoints that silently accept-but-ignore.** `submitter_id` on `POST/PATCH /v1/ship/tickets` is documented as "企业授权时，该值有效；个人鉴权时，指定无效" — with a **user token it is silently ignored**, and the ticket is attributed to the token owner. There is no error. This is auth-mode-dependent behaviour a CLI must warn about.
15. **`PATCH /v1/ship/products` only accepts `name`, `identifier`, `description`.** `visibility`, `scope_type`, `scope_id`, `color`, `members` are creatable-but-not-updatable through this endpoint (members have their own sub-resource; the rest have no write path at all). Whether extra keys 400 or are dropped is undocumented.
16. **Set-once fields.** `channel_id` can be set on `POST /v1/ship/tickets` but **not** on PATCH. `product_id` cannot be changed on either ideas or tickets. Idea `state_id` cannot be set at create (only PATCH), and `plan_id` likewise — so "create an idea already scheduled in state X" needs 2 calls.
17. **There is no DELETE for any ship business object.** All 8 ship DELETEs are relationship/config removals: external user, product member, product tag, product suite, property-in-property-plan (×2), state-in-state-plan, state-flow. No `DELETE /v1/ship/products/{id}`, `/ideas/{id}`, `/tickets/{id}`, `/customers/{id}`. `is_archived`/`is_deleted` are returned but **not writable** — a CLI cannot archive or delete a product, idea or ticket. Do not expose `pingcode product delete`.
18. **`include_deleted` / `include_archived` exist only on products.** Two endpoints (`GET /v1/ship/products`, `GET /v1/ship/products/{product_id}`) accept them; ideas and tickets have no equivalent, so deleted/archived ideas are simply unreachable. Their `Boolean` serialization (`true` vs `1`) is undocumented.
19. **State-plan invariants will make writes fail.** `DELETE /v1/ship/ticket_state_plans/{plan}/ticket_states/{state}`: "移除状态后，每种类型的状态至少存在一种，否则将无法移除" — each of `pending|in_progress|completed|closed` must retain ≥1 state.
20. **Ticket state transitions are constrained by the state plan's flows.** `state_id` on `PATCH /v1/ship/tickets` is not free-form: only `to_state_id`s reachable per `GET /v1/ship/ticket_state_plans/{plan}/ticket_state_flows` should be accepted. Ideas have **no** state-flow endpoint at all, so for ideas there is no documented way to know which transitions are legal — you can only try and handle the error.
21. **Deleting a suite silently cascades to all child suites.** `DELETE /v1/ship/products/{id}/suites/{suite_id}`. Require an explicit `--yes` for this.
22. **Doc example enum mismatch that will teach the wrong lesson.** `POST /v1/ship/ticket_states` example is `{"name": "处理中", "type": "pending"}` — "处理中" means *in progress* but is typed `pending`. Don't infer a name→type mapping from examples.
23. **Property plans and state plans can have `product: null`** (`GET /v1/ship/{idea,ticket}_property_plans`, `GET /v1/ship/ticket_state_plans` examples each show one `null` and one real product). `null` = the org-level default/template plan. Resolving "the plan for product X" by scanning the plan list must skip nulls, and there is **no `?product_id=` filter** on any of the three plan-list endpoints — so this is an O(all plans) client-side scan with no pagination parameters documented.
24. **`GET /v1/ship/ticket_state_plans` example is internally inconsistent** (`"total": 1` with 2 elements in `values`) — a reminder that `total` in the docs is illustrative; trust the wire.
25. **ID shape summary for ship** (never assume uniformity): product/idea/ticket/customer/suite/plan/tag/channel/state/priority/type/solution/plan-ids = 24-hex; **org users = 32-hex**; **external product users = 24-hex**; **properties may be slugs** (`solution`, `identifier`, `backlog_type`); `short_id` is an 8-char base62 string (`Ogf1EYey`) used only in `html_url`, and **no endpoint accepts `short_id` or `identifier` as a lookup key** — only the 24-hex `id`. Resolving "SLC-1" → id requires `keywords` search.
26. **Priorities look global, not per-product.** `GET /v1/ship/ticket/priorities?product_id=` and `GET /v1/ship/ticket_priorities` return the same legacy-looking constants (`5cb9466afda1ce4ca0090005` = "P0"), and idea priorities use the *same* id space (`5cb9466afda1ce4ca0090005` also appears as an idea priority "P0"). Tempting to cache org-wide — but the API deliberately requires `product_id`, so caching across products is unsafe without live verification.
27. **`GET /v1/ship/ticket/solutions?product_id=` example returns `id: 6422711c3f12e6c1e46d40e9`, which is the *product* id used throughout the docs.** Clearly a copy-paste error in the example; solution ids are their own ObjectIds (cf. `62f217ae16e3661a20124330` in the ticket example).
28. **Pagination on GET lists is entirely undocumented in ship.** 41 of the 68 ship GETs are list endpoints returning `{page_size, page_index, total, values}`, and **not one** documents `page_size`/`page_index` as inputs. Only the two `POST …/search` bodies do. (Established as working in practice; just don't expect the docs to back you up.)
29. **Two different scopes reach the same data**, so a token can be "half-capable": product tags need `pcp:read:ship:configuration` via `/products/{id}/tags` but `pcp:read:ship:ticket` via `/ticket/tags?product_id=`. Similarly channels (`R:cfg` vs `R:ticket`) and ticket types (`R:cfg` vs `R:ticket`). A CLI should prefer the path matching the scopes it actually holds, or request `pcp:read:ship:configuration` too.
30. **`POST /v1/ship/ideas`' response example is invalid JSON** (missing comma after `"html_url"`) and both idea write endpoints lack a `success.fields` table entirely — they are the only 2 of 101 ship records with no documented response schema. Derive the idea write response shape from `GET /v1/ship/ideas/{idea_id}`.
31. **Reviews of ideas require a *product* write scope, not an idea scope** (`/v1/reviews` with `principal_type=idea` → `pcp:write:ship:product`), and `pilot_id` there means product id. Easy to get 403 on.
32. **Workloads accept `idea` but not `ticket`.** If your CLI offers `--log-time`, it must be an idea-only flag.

---

## 8. Recommended MVP subset

Design goal: an AI agent can find the product, read/search ideas, create and update an idea, and do the same for tickets, without guessing any id.

### Tier 1 — idea-centric core (11 endpoints)

| # | Endpoint | CLI surface | Why |
|---|---|---|---|
| 1 | `GET /v1/ship/products` | `product list`, and the resolver behind `--product SLC` | Only way to map a human name to a `product_id`. `keywords` covers name; identifier→id needs a client-side match on the returned `identifier`. |
| 2 | `GET /v1/ship/products/{product_id}` | `product show` | Cheap validation + members inline. |
| 3 | `POST /v1/ship/ideas/search` | `product idea list --assignee --state --created-after --title-contains` | The only endpoint with real filtering (assignee, dates, custom properties). Should be the default read path, **not** `GET /v1/ship/ideas`. |
| 4 | `GET /v1/ship/ideas/{idea_id}` | `product idea show` | Full structure + `include_public_image_token`. |
| 5 | `POST /v1/ship/ideas` | `product idea create` | Only 2 required params (`product_id`, `title`) → best-in-class agent ergonomics. |
| 6 | `PATCH /v1/ship/ideas/{idea_id}` | `product idea update` / `idea move --state` | Where state/priority/assignee/progress/schedule actually get set. |
| 7 | `GET /v1/ship/idea/states?product_id=` | `--state` resolution + `product idea states` | Mandatory for #6; ideas have no state-flow endpoint so this is all you get. |
| 8 | `GET /v1/ship/idea/priorities?product_id=` | `--priority` resolution | Mandatory for #5/#6. |
| 9 | `GET /v1/ship/idea/suites?product_id=` | `--module` resolution | `suite_id` is the main structural axis of a product backlog. |
| 10 | `GET /v1/ship/idea/properties?product_id=` | `--set key=value` validation + `product idea fields` | Without this, `properties` writes are blind guesses (slug keys + option `_id`s). |
| 11 | `GET /v1/ship/products/{product_id}/members` | `--assignee` resolution | 32-hex user ids are not guessable; product members is the correct candidate set. |

### Tier 2 — tickets + cross-module (5 endpoints)

| # | Endpoint | CLI surface | Why |
|---|---|---|---|
| 12 | `POST /v1/ship/tickets/search` + `GET /v1/ship/tickets/{ticket_id}` | `product ticket list` / `show` | Same reasoning as #3/#4. (Counted as one pair.) |
| 13 | `POST /v1/ship/tickets` + `PATCH /v1/ship/tickets/{ticket_id}` | `product ticket create` / `update` | Support-flow automation is the other half of ship. |
| 14 | `GET /v1/ship/ticket/types?product_id=` | `--type` resolution | `type_id` is **required** on ticket create — this lookup is not optional. |
| 15 | `GET /v1/ship/ticket/states?product_id=` + `GET /v1/ship/ticket_state_plans/{plan}/ticket_state_flows` | `ticket move` | States alone are insufficient; flows tell you which transitions are legal. |
| 16 | `POST /v1/relations` + `GET /v1/relations` | `product idea link <work-item>` | The only bridge to the pjm surface the CLI already covers — high leverage for an agent that plans in ship and executes in pjm. |

### Deliberately left out, and why

- **All 44 configuration endpoints (L + M)** — property/state/state-plan/state-flow CRUD is admin-console work, org-wide and destructive (GOTCHA #7 wholesale `options` replacement, #19 state-plan invariants). An agent should *read* metadata, never author it. Exception: the two flow-list reads in #15.
- **`GET /v1/ship/ideas` and `GET /v1/ship/tickets`** — strictly weaker than the search endpoints (no assignee/date/property filters) while adding a second code path. Keep only if you want a zero-body fallback for restricted tokens.
- **Customers + external users (9 endpoints)** — CRM-adjacent; only needed if the CLI's job is support intake. `--customer` on ticket create can be added later with `GET …/customers` alone.
- **Product write endpoints** (`POST /v1/ship/products`, members/tags/suites add/remove) — product creation is a one-time governance act, and `DELETE …/suites` cascades silently (GOTCHA #21). `PATCH /v1/ship/products` only edits 3 cosmetic fields.
- **`plans` (需求排期)** — read-only, and `plan_id` can only be set on PATCH; include `GET /v1/ship/idea/plans` only when you add `idea update --schedule`.
- **Transition histories (4 endpoints)** — audit/reporting, not action.
- **Channels, solutions, tags, product↔ticket_type bindings** — either unwritable (tags, GOTCHA #10), set-once (channel), or PATCH-only niceties (solution). Add `GET /v1/ship/ticket/solutions` when you implement ticket closure workflows.
- **`/v1/participants`, `/v1/comments`, `/v1/attachments`, `/v1/workloads`, `/v1/reviews`, `/v1/activities`** — cross-module generics, not ship-specific; belong in a shared `pingcode comment|watch|attach` surface rather than under `product`.

---

## 9. Not determinable from `api_data.json`

1. **Error codes for ship.** There is no error-code catalogue anywhere in the file (no `错误码` group; the only code shown is `100038` inside the 频率限制 overview). Ship-specific codes (e.g. product-not-found, invalid `suite_id`, property-not-in-view) must be discovered by live probing, exactly as `100317`/`100303` were for pjm.
2. **Idea state `type` enum.** Ticket states document `pending|in_progress|completed|closed` (via `POST /v1/ship/ticket_states`). Idea states have **no write endpoint**, so the enum is never declared; the only evidence is the example value `"pending"`. Whether ideas use the same 4 values (or something like `pending|approved|rejected|…` given the example state name 待评审 "awaiting review") is unknown.
3. **Whether the state-flow field is `form_state` or `from_state` on the wire** (GOTCHA #2) — no response example exists for any state-flow endpoint.
4. **Whether unknown/out-of-view `properties` keys are rejected or silently dropped** on idea/ticket writes (GOTCHA #6), and likewise whether `PATCH /v1/ship/products` 400s on `visibility`.
5. **Whether idea `plan.id`, `suite.id`, `plan_at`, `real_at` are filterable** in `POST /v1/ship/ideas/search` — they appear in neither the supported-operators lists nor the explicit "暂不支持过滤" list.
6. **Whether `participants.id` really works as an idea filter** (present in the example, absent from the enumerated reference-field list).
7. **Whether priorities/states/types are truly org-global or product-scoped.** Both list forms exist with identical-looking ids, but the product-scoped forms *require* `product_id`, implying filtering. Cannot confirm without two products in a live org.
8. **Boolean serialization** for `include_deleted`/`include_archived` (`true`/`false` vs `1`/`0`).
9. **`created_between` / `updated_between` format** on `GET /v1/ship/products` — described only as "通过','分割起始时间", with no example. Presumably `"<unix>,<unix>"`, and it is unclear whether an open-ended range (`"1730000000,"`) is accepted.
10. **Default sort order** of every list endpoint (no sorting parameter exists anywhere in ship).
11. **How to find the property plan / state plan for a given product** — the plan-list endpoints have no `product_id` filter and the product resource does not expose plan ids. The only documented route is to list all plans and match on the embedded `product.id`.
12. **Rate-limit interaction with the metadata fan-out.** A single `idea create` with full validation costs ~5 lookups; at 200 req/min a naive agent loop will hit `100038`. Caching policy needs to be decided from live latency/consistency behaviour, not from the docs.
13. **Webhook / Flow event names for ship objects** — no webhook payload documentation exists in `api_data.json` (the 频率限制 page merely *recommends* using PingCode Flow's "发送Webhook"). Event-driven CLI features cannot be designed from this source.
14. **Ship-specific permission points** — `GET /v1/permission/points` exists and its description mentions ship, but the enumerated point list is not in the file; only the scope strings are.
