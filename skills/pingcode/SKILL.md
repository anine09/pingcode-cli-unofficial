---
name: pingcode
description: >-
  Use the `pingcode` CLI to work with PingCode (研发管理): 敏捷项目管理 (pjm) projects and work items —
  list and search work items (工作项), read a story/task/bug (需求/任务/缺陷), create one, update fields,
  move it to another state (状态流转) — 产品管理 (ship) products, requirements (需求 / idea) and
  tickets (工单): search, read, create, update and transition them — and 测试管理 (testhub) test
  libraries (测试库), test cases (用例), test plans (测试计划) and runs (执行用例): search cases, read
  one, create and update a case, record a run result, and bulk add/update/delete the runs of a
  plan. Also resolves project-, product- and library-scoped ids and organisation members
  (项目/产品/测试库/迭代/成员). Triggers: pingcode, PingCode 工作项, 创建任务, 更新状态, 迭代 sprint,
  产品 需求 工单, 测试用例 测试计划 执行用例 测试库, SCR-5 or SLC-1 style identifiers, a work-item or
  idea URL from a PingCode instance. Do NOT use for Wiki pages, customers or external users, the
  org chart beyond a member lookup, Insight/Goals/Flow, or webhooks — none of those are covered by
  this CLI, and webhooks cannot be managed through the PingCode API at all (they live in PingCode
  Flow's UI).
---

# PingCode CLI

`pingcode` is a command-line client for the PingCode Open API. Its top level mirrors PingCode's own
GUI modules: **`product`** (产品管理 / ship — products, requirements/需求, tickets/工单),
**`project`** (项目管理 / pjm — projects and work items), **`testhub`** (测试管理 — test libraries,
cases, plans and runs), **`settings`** (后台设置 — the organisation directory) and **`auth`** (the
CLI's own local credentials).

Each business module owns its resources *and* its id lookups, so a module's whole surface is one
`--help` away:

```
auth      login status logout
product   list get · idea … · ticket … · meta …
project   list get · work-item … · meta …
testhub   libraries … · cases … · plans … · runs … · meta …
settings  users
```

Everything below assumes `pingcode` is on `PATH` (`npm run build` produces `dist/bin/pingcode.js`).

## 1. Authentication gate — do this first

If any command fails with exit code 3, or `pingcode auth status` reports no token, stop and get
credentials before retrying.

Credentials come from a PingCode application, not from a user account:

1. In the PingCode enterprise console, open **后台管理 → 凭据管理** (Credential Management) and create an
   application.
2. Set 鉴权方式 (grant type) to **Client Credentials**.
3. Grant these scopes:
   - `pcp:read:pjm:project` — projects
   - `pcp:read:pjm:workitem` — work items, types, states, priorities
   - `pcp:write:pjm:workitem` — create/update work items
   - `pcp:read:global:team` — `pingcode settings users`
   - `pcp:read:pjm:sprint` — only if you need `pingcode project meta sprints`

   For the ship (产品管理) commands, add:
   - `pcp:read:ship:product` — `product list` / `product get` / `product meta members`, and every
     product name lookup, which every other ship command starts with
   - `pcp:read:ship:idea` — `product idea list` / `get`, and `product meta idea-states|idea-priorities|idea-suites|idea-properties`
   - `pcp:write:ship:idea` — `product idea create` / `update`
   - `pcp:read:ship:ticket` — `product ticket list` / `get`, and `product meta ticket-states|ticket-priorities|ticket-types|ticket-channels|ticket-properties`
   - `pcp:write:ship:ticket` — `product ticket create` / `update` / `transition`
   - `pcp:read:ship:configuration` — **optional**, and only for `product ticket transition`: it is what
     makes the state-plan pre-check possible. Without it the CLI warns on stderr and lets the
     server judge the transition, so tickets stay movable either way.

   The product-scoped metadata endpoints (`/v1/ship/idea/*`, `/v1/ship/ticket/*`) sit under the
   ordinary read scopes above, **not** under `configuration` — only the ticket state plans and
   flows need `configuration`.

   For the testhub (测试管理) commands, add:
   - `pcp:read:testhub:library` — `pingcode testhub libraries list` / `get`, and the case-module
     (模块) tree behind `--suite`. Every other testhub command starts by resolving a library, so
     this one is not optional
   - `pcp:read:testhub:testcase` — `testhub cases list` / `get`, and `testhub meta case-types`
   - `pcp:write:testhub:testcase` — `testhub cases create` / `update`
   - `pcp:read:testhub:testplan` — `testhub plans list` / `get`, and `testhub runs list`
   - `pcp:write:testhub:testplan` — `testhub runs patch` / `bulk`
   - `pcp:read:testhub:configuration` — **not optional, despite the name**: `testhub meta
     case-states`, `testhub meta run-statuses` and `testhub meta important-levels` all sit behind
     it, and they are the only source of a `state_id`, a `status_id` and an `important_level_id`.
     Without it those three return a bare 403 while their sibling `case-types` keeps working, and
     since `PATCH /runs/{id}` requires `status_id`, a token without this scope **cannot write a
     run at all**. The CLI adds that explanation to the 403 for the two library-scoped lookups.

   `--executor` on a run resolves through the organisation directory, so it also needs
   `pcp:read:global:team`.
4. Copy the `client_id` and `client_secret`.

Then:

```bash
pingcode auth login --client-id <id> --client-secret <secret> --save
pingcode auth status --check
```

- `--save` writes the client id/secret to `~/.pingcode/config.json` (mode `0600`). Without `--save`
  only the token is stored, and a new login is needed once it expires.
- Credentials can also arrive as `PINGCODE_CLIENT_ID` / `PINGCODE_CLIENT_SECRET`, or interactively
  when a terminal is attached.
- Self-hosted instances need `--host https://pingcode.example.com` (or `PINGCODE_HOST`); the API is
  served from `<host>/open` there.
- `pingcode auth logout` removes the token, the stored credentials and the metadata cache.

**Security:** a Client Credentials token has organisation-wide system-administrator authority and is
valid for 30 days. It is not tied to a user. Never print it, never copy it into a file in a
repository, and treat `~/.pingcode/config.json` as a secret. The CLI redacts the secret and the token
from every URL, log line, dry-run plan and error message it emits.

## 2. Output contract

- `--json` makes **stdout carry JSON only**. Logs, warnings, tables and notes go to stderr.
- In `--json` mode, timestamps stay raw unix **seconds**. Human mode renders local time.
- Three list shapes, by command family:
  - `project list` / `project work-item list` (one page) → `{"page_index":0,"page_size":30,"total":123,"values":[…]}`,
    and the same for `product`/`testhub` one-page lists
  - any list with `--all` → `{"values":[…],"count":42,"all":true}`
  - every `meta` lookup — `pingcode product meta …`, `pingcode project meta …`,
    `pingcode testhub meta …`, and `pingcode settings users` (which still accepts
    `--page`/`--page-size`) → `{"values":[…],"count":20}`
- Single-resource commands (`get`, `create`, `update`, `transition`) print the resource object.
- **Read keys defensively: an absent key means null or empty.** The CLI normalises `null` and `""`
  to "not present", so a field the API returned as `null` (an unset `plan_at`, `score`, `solution`)
  or as an empty string (a blank `description`) is simply missing from the JSON. It does **not**
  distinguish the two, and a missing key is never evidence that the field does not exist. Use
  `x?.y ?? fallback`, not `'y' in x`.
- `--dry-run` on a mutating command prints `{"dry_run":true,"request":{…}}` to stdout and exits 0
  without sending anything. Read requests still run, so ids are really resolved.
- Errors in `--json` mode go to **stderr** as `{"error":{"kind":…,"message":…,"code":…,"exit":…}}`.
- Global flags (`--host`, `--json`, `--dry-run`, `--no-cache`, `--verbose`) may appear before or
  after the subcommand.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | success (including a printed dry-run plan) |
| 1 | unexpected internal error |
| 2 | usage error: bad flags, missing input, ambiguous or unresolvable name, empty update |
| 3 | authentication: no or invalid credentials |
| 4 | permission: 403, or a scope the app was not granted |
| 5 | not found: the work item, state or other resource does not exist |
| 6 | rate limited: 429 (200 requests/minute per token) |
| 7 | other API error, carrying the API's `{code, message}` |
| 8 | transport failure: DNS, TCP, TLS, timeout, unparseable body |

The API answers HTTP 400 for both "not found" and "bad credentials", so the CLI maps a few known API
codes onto exits 5 and 3 rather than trusting the status. Unknown codes stay on exit 7 with the raw
`code` in the error payload — read it before concluding anything.

## 3. Commands

### Auth

```bash
pingcode auth login --client-id <id> --client-secret <secret> --save
pingcode auth status
pingcode auth status --check      # adds one live API call: GET /v1/pjm/projects?page_size=1
pingcode auth logout
```

### Projects — 项目管理

```bash
pingcode project list --json
pingcode project list --keywords mobile --type scrum
pingcode project get "Mobile App" --json
```

### `project meta` — mandatory before creating or updating a work item

`type_id`, `state_id` and `priority_id` are **project-scoped**: the same state name has a different id
in another project, and system work-item types use slugs (`task`, `story`, `bug`) while custom types
use hex ids. Never reuse an id across projects, and never guess one.

```bash
pingcode project meta types --project "Mobile App" --json
pingcode project meta states --project "Mobile App" --type task --json
pingcode project meta priorities --project "Mobile App" --json
pingcode project meta sprints --project "Mobile App" --json
```

`pingcode project meta states` requires **both** a project and a type — that is an API constraint, not a CLI
choice.

Lookups are cached under `~/.pingcode/cache/` for 24 hours. Use `--no-cache` if a project was
reconfigured and an id looks stale.

### Settings — 后台设置

```bash
pingcode settings users --keywords wang --json
```

The organisation directory (`/v1/directory/users`, scope `pcp:read:global:team`) belongs to no
business module, which is why it sits here rather than under `product` or `project`. It is the
candidate set for pjm's `--assignee`; ship's `--assignee` uses `product meta members` instead.

### Work items — `project work-item`

```bash
pingcode project work-item list --project "Mobile App" --json
pingcode project work-item list --project "Mobile App" --type task --state "In Progress" --json
pingcode project work-item list --project "Mobile App" --assignee wangxiao --page-size 20 --page 0
pingcode project work-item list --project "Mobile App" --all --limit 200 --json

pingcode project work-item get SCR-5 --json
pingcode project work-item get 1bAqLmTG --json
pingcode project work-item get https://example.pingcode.com/pjm/work_items/1bAqLmTG --json

pingcode project work-item create --project "Mobile App" --type task --title "Fix login retry" --dry-run --json
pingcode project work-item create --project "Mobile App" --type task --title "Fix login retry" \
  --assignee wangxiao --priority High --end-at 2026-02-15 --json

pingcode project work-item update SCR-5 --title "Fix login retry (v2)" --json
pingcode project work-item update SCR-5 --type task --state "In Progress" --json
pingcode project work-item transition SCR-5 --type task --state Done --json
pingcode project work-item transition SCR-5 --state-id 5eb623f6a70571487ea47000 --json
```

`project work-item get` accepts an id, a `short_id`, an identifier such as `SCR-5`, or a pasted work-item URL.
`update` and `transition` accept the same forms and resolve them to a real id first.

On `update` and `transition`, `--type` is **only** a lookup aid: it resolves `--state <name>` and lets
the CLI list the candidate states if the server rejects the change. It is never written to the work
item — there is no patchable type field.

### Products — 产品管理

A **product** (产品) is ship's parent scope, the way a project is pjm's. Resolve it first: every other
ship id is scoped to it.

```bash
pingcode product list --json
pingcode product list --keywords sales --json
pingcode product get SLC --json          # name, identifier such as SLC, or id
```

`--keywords` searches the **name only** — the identifier is not searchable server-side, so the CLI
matches it client-side over the full list. There is no `product create`/`update`/`delete`: ship has no
product DELETE at all, and `PATCH` only edits three cosmetic fields.

### `product meta` — mandatory before writing an idea or ticket

```bash
pingcode product meta idea-states       --product SLC --json
pingcode product meta idea-priorities   --product SLC --json
pingcode product meta idea-suites       --product SLC --json
pingcode product meta idea-properties   --product SLC --json
pingcode product meta members          --product SLC --json
pingcode product meta ticket-states     --product SLC --json
pingcode product meta ticket-priorities --product SLC --json
pingcode product meta ticket-types      --product SLC --json
pingcode product meta ticket-channels   --product SLC --json
pingcode product meta ticket-properties --product SLC --json
```

`product meta members` is the **only** valid source of `--assignee` values for ideas and tickets —
the organisation directory is not, because a user who is not a member of the product cannot be
assigned. `product meta idea-properties` / `product meta ticket-properties` are the only source of `--set` keys and,
for select-typed properties, of the option ids you must send instead of the display label.

### Requirements 需求 — `product idea`

```bash
pingcode product idea list --product SLC --json
pingcode product idea list --product SLC --state 待评审 --assignee zhangsan --json
pingcode product idea list --product SLC --keywords sso --page-size 20 --page 0 --json
pingcode product idea list --product SLC --all --limit 200 --json

pingcode product idea get SLC-1 --json                # identifier, id, or a pasted idea URL

pingcode product idea create --product SLC --title "Single sign-on" --dry-run --json
pingcode product idea create --product SLC --title "Single sign-on" \
  --assignee zhangsan --priority P1 --suite "客户端 / 登录" --json

pingcode product idea update SLC-1 --title "Single sign-on (v2)" --json
pingcode product idea update SLC-1 --state 开发中 --json
pingcode product idea update SLC-1 --set 需求类型=5cb7e763fda1ce4ca0010002 --json
```

`product idea list` is `POST /v1/ship/ideas/search` — the plain list endpoint cannot filter by assignee, date
or custom property, so the CLI never uses it. Note there is **no `--type`** anywhere on `idea`: ship
states are scoped to the product alone, which `--product` (or, on `update`, the idea itself) already
supplies.

### Tickets 工单 — `product ticket`

```bash
pingcode product ticket list --product SLC --json
pingcode product ticket list --product SLC --type 故障 --state 待处理 --json
pingcode product ticket list --product SLC --channel 邮件 --all --limit 200 --json

pingcode product ticket get SLC-7 --json

pingcode product ticket create --product SLC --type 故障 --title "Cannot log in" --dry-run --json
pingcode product ticket create --product SLC --type 故障 --title "Cannot log in" \
  --assignee zhangsan --priority P1 --channel 邮件 --json

pingcode product ticket update SLC-7 --title "Cannot log in (iOS)" --json
pingcode product ticket transition SLC-7 --state 处理中 --json
```

`--type` is **required** on `product ticket create` — `type_id` is a required body field, which is the one
place ship demands a lookup (`pingcode product meta ticket-types --product SLC`) before a write can even be
attempted. `--channel` can only be set at create time; there is no way to change it afterwards.

### Test libraries 测试库 — `testhub libraries`

A **test library** is testhub's parent scope, the way a product is ship's. Resolve it first: case
states, case types, run results, the module tree and the plan list are **all library-scoped**.

```bash
pingcode testhub libraries list --json
pingcode testhub libraries list --keywords payment --json
pingcode testhub libraries get LIB --json        # name, identifier such as LIB, or id
```

`--keywords` searches library **names** only — the identifier is not searchable server-side. There
is no library create/update/delete: testhub publishes no library DELETE, so library governance stays
in the console.

### `testhub meta` — the ids a testhub write cannot be built without

```bash
pingcode testhub meta case-states       --library LIB --json   # --state / state_id
pingcode testhub meta case-types        --library LIB --json   # --type / type_id
pingcode testhub meta run-statuses      --library LIB --json   # --status / status_id
pingcode testhub meta important-levels  --json                 # --important-level; org-wide
```

`important-levels` is the one lookup in the module with **no per-library variant**, so it *refuses*
`--library` with exit 2 rather than ignoring it (the flag is hidden from `--help`, which is why it
is spelled out here). The other three require `--library`.

### Test cases 用例 — `testhub cases`

```bash
pingcode testhub cases list --library LIB --json
pingcode testhub cases list --library LIB --state 已评审 --type 功能测试 --json
pingcode testhub cases list --library LIB --suite "登录 / 双因素" --keywords sso --page-size 20 --page 0 --json
pingcode testhub cases list --library LIB --all --limit 200 --json

pingcode testhub cases get 5f0e1a2b3c4d5e6f70819200 --json    # an id or a short_id
pingcode testhub cases get aB3dEf9h --json

pingcode testhub cases create --library LIB --title "SSO login" --dry-run --json
pingcode testhub cases create --library LIB --title "SSO login" \
  --suite "登录 / 双因素" --type 功能测试 --important-level 高 --json

pingcode testhub cases update aB3dEf9h --title "SSO login (v2)" --json
pingcode testhub cases update aB3dEf9h --state 已评审 --json
pingcode testhub cases update aB3dEf9h --set 自动化=5cb7e763fda1ce4ca0010002 --json
```

`testhub cases list` is `POST /v1/testhub/cases/search`; the plain list endpoint is never used
(unfiltered it scans every visible library). `--state` is **PATCH-only**: a case is always created in
the library's initial state, so `cases create` has no `--state`.

### Test plans 测试计划 — `testhub plans`

```bash
pingcode testhub plans list --library LIB --json
pingcode testhub plans list --library LIB --name "2026 S1 回归" --json
pingcode testhub plans get "2026 S1 回归" --library LIB --json    # name, id or short_id
```

Read-only in this version: plans are created and edited in the GUI.

### Runs 执行用例 — `testhub runs`

A **run** is one case scheduled inside one plan; recording a result means patching the run.

```bash
pingcode testhub runs list --library LIB --plan "2026 S1 回归" --json
pingcode testhub runs list --library LIB --plan "2026 S1 回归" --status 失败 --executor wangxiao --json
pingcode testhub runs list --plan-id 5f0e1a2b3c4d5e6f70819200 --all --limit 200 --json

pingcode testhub runs patch 7hK2mQ9x --status 通过 --remark "retested on iOS" --dry-run --json
pingcode testhub runs patch 7hK2mQ9x --status 通过 --executor wangxiao --json
pingcode testhub runs patch 7hK2mQ9x --status 失败 \
  --step s1=通过 --step s2=失败 --step-actual s2="500 from /login" --json

pingcode testhub runs bulk --library LIB --plan "2026 S1 回归" \
  --add-case 5f0e1a2b3c4d5e6f70819200 --executor wangxiao --dry-run --json
pingcode testhub runs bulk --library LIB --plan "2026 S1 回归" --set-status 7hK2mQ9x=通过 --json
pingcode testhub runs bulk --library LIB --plan "2026 S1 回归" --remove-run 7hK2mQ9x --json
```

`testhub runs bulk` is the **only** way to delete a run, and the only way to add one. Every
name-resolvable flag has an `--x-id` twin (`--status-id`, `--executor-id`, `--plan-id`,
`--library-id`, …) that is sent verbatim with no lookup; the two forms are mutually exclusive.

## 4. Rules that will bite you

1. **Resolve ids per project.** Run `pingcode project meta types` / `project meta states` for the project you are
   writing to before `create`. An id from another project is rejected or, worse, silently wrong.
2. **`--state <name>` always requires `--type`.** States live in a `(project, work item type)` pair,
   and the API does **not** report a work item's type, so the CLI cannot infer it — not on `list`, not
   on `create`, and not on `update`/`transition` either. Either pass `--type <name|id>` alongside
   `--state <name>`, or skip the lookup entirely with `--state-id <id>`. `--state` and `--state-id`
   are mutually exclusive.
3. **`update` replaces, it does not merge.** Every field you pass overwrites the stored value, and
   array fields and `properties` objects are replaced wholesale rather than merged. Read the item
   first if you need to preserve anything.
4. **There is no way to clear a field.** Only the fields you pass are sent; the CLI has no
   `--clear-<field>`.
5. **An update with no fields is exit 2**, not a no-op.
6. **State changes are workflow-validated** by the server: the target state must belong to the type's
   state scheme and a legal transition must exist from the current state. On rejection the CLI prints
   the server message plus the states configured for that type on stderr — but only if you passed
   `--type`, since the candidate lookup needs it too.
7. **No endpoint supports sorting.** Neither the CLI nor the API can order results. Sort what you
   collected yourself, and remember that offset paging over unordered, changing data can duplicate or
   skip rows.
8. **`--all` is best effort, not a consistent snapshot.** It walks pages, de-duplicates by id, stops
   at `--limit` (default 500), and gives up if the API stops honouring `page_index`.
9. **Rate limit is 200 requests per minute per token.** Prefer one `--page-size 100` call over many
   small ones, let the metadata cache work, and do not loop `--all` over large projects casually.
10. **Timestamps are unix seconds.** `--start-at` / `--end-at` accept `1730000000` or `2026-01-31`
    (parsed as UTC midnight).

## 4b. Ship rules that will bite you

These are on top of §4, which still applies. Ship is a different module with the same machinery, and
almost every difference is a trap.

1. **Resolve the product first, and scope everything to it.** A product is to ship what a project is
   to pjm. `state_id`, `priority_id`, `suite_id`, `type_id`, `channel_id`, the `properties` keys and
   the assignable people are **all product-scoped**. They frequently *look* org-global — the same
   priority id `P0` appears under several products — but the API requires `product_id` on every
   lookup, so never carry an id from one product to another.
2. **`--assignee` must be a product member.** `pingcode product meta members --product <p>` is the
   only valid candidate set; the organisation directory (`settings users`) is not, and a non-member is
   rejected.
3. **`--state <name>` needs no companion flag here.** Unlike pjm, ship states hang off the product
   alone, so there is no `--type` on `idea` at all, and `--type` on `ticket` is a real field being
   written, not a lookup aid. `--state` and `--state-id` remain mutually exclusive.
4. **Reads go through `search`.** `product idea list` and `product ticket list` are `POST …/search`. The plain list
   endpoints exist but cannot filter by assignee, date or custom property, so the CLI never uses
   them. Search takes **one operator per field and has no `$and`/`$or`**; multiple filters are
   AND-ed. There is still no sorting anywhere.
5. **No state change is refused locally — the server decides, and a ticket refusal is explained.**
   - `pingcode product ticket transition` and `product ticket update --state` send the PATCH. If the server refuses
     it, the error `message` names the product's configured states, the current state and — when
     the state plan can be read — **the states reachable from the current one**. Read it from
     `message`: `--json` errors are `{kind,message,code,exit}` and carry no hint.
   - Want to know before you write? `product ticket transition <t> --state <s> --dry-run` prints the
     reachable set on stderr and sends nothing.
   - `pingcode product idea update --state` gets the configured states on rejection but never a reachable
     set: ship publishes no idea state-flow endpoint at all.
   - The CLI does **not** refuse a transition on its own (the one exception: moving a ticket to the
     state it is already in, which is exit 2). The server refuses atomically with no state change,
     so a local check saves nothing — and a mis-identified state plan would otherwise block a legal
     move with no escape hatch. Expect the server's exit code, not exit 2, for an illegal target.
6. **`--set key=value` sends the value verbatim, and select properties want option ids.** For a
   `select`-typed property the API expects the option's `_id`, not the label you see in the UI —
   the docs' own examples only show text properties, which is the trap. Run
   `pingcode product meta idea-properties --product <p>` (or `ticket-properties`): it prints each key and
   its `label=option_id` pairs. `properties` **replaces**, it never merges.
7. **Nothing in ship can be deleted.** There is no DELETE for products, ideas or tickets, and
   `is_archived` / `is_deleted` are read-only. A test artifact you create is permanent — mark it in
   the title (for example `[CLI smoke] …`) before you create it, not after.
8. **Ship identifiers are not lookup keys.** `SLC-1` cannot be fetched directly; the CLI resolves it
   through `search` and then filters to an exact identifier match. A pasted URL ends in a `short_id`,
   which no endpoint accepts either, so prefer an id or an identifier over a URL.
9. **`--suite` filtering on `product idea list` is undocumented.** The API lists `suite.id` as neither
   filterable nor unfilterable, so an empty result proves nothing. The CLI warns when you use it.
10. **Tags cannot be set through the API** on ideas or tickets, and `submitter_id` on a ticket is
    silently ignored under a client-credentials token — the ticket is attributed to the token owner
    with no error. The CLI exposes neither.

## 4c. Testhub rules that will bite you

These are on top of §4. Testhub is the same machinery again, with a different parent scope and a
sharper write path.

1. **Resolve the test library first, and never carry an id across libraries.** `state_id`,
   `type_id`, `status_id`, `suite_id` and the plan list are all **library-scoped**: two libraries
   never share a state, type or status id, even when the names are identical. `testhub cases list`,
   `plans list`, `plans get`, `runs bulk` and the three library-scoped `meta` leaves all require
   `--library <name|id>` and refuse to guess (exit 2). `cases get`, `cases update` and `runs patch`
   do not: they read the resource first and inherit its library. `runs list` needs one only to
   resolve a `--plan` or `--status` **by name** — `--plan-id` / `--status-id` work without it.
2. **`--json` search is the read path.** `testhub cases list` is `POST /v1/testhub/cases/search` and
   `testhub runs list` is `POST /v1/testhub/runs/search`; the plain `GET` lists are never called
   (unfiltered, `GET /v1/testhub/cases` scans every library you can see). One operator per field, no
   `$and`/`$or`, filters AND-ed, and no sorting anywhere.
3. **`steps[]` replaces, it never merges — so `--step` is all-or-nothing.** A run's step array is
   overwritten wholesale, and a step that arrives without its `step_id` is re-created with a fresh
   id, orphaning its execution history. Re-emitting an untouched step is impossible: a run step
   reports an English status **slug** while the write needs a status **id**, and nothing joins the
   two except the localized name, which a tenant may have renamed. Rather than guess, the CLI
   refuses a partial `--step` edit and lists every step id you must supply. Pass a status for
   **every** step, or none at all. The same "replaces, never merges" applies to `--set`/`properties`
   on a case.
4. **`testhub runs patch` always sends `status_id` *and* `executor_id`.** `status_id` is required by
   the API even on PATCH, and an omitted `executor_id` is **destructive**: the server silently
   reassigns the run to its creator. The CLI reads the run first and re-sends both, inheriting each
   from the run when you do not name it — so patching only a remark is safe here, and would not be
   if you called the API directly. If the run has no recorded result or no executor to inherit, the
   CLI asks for `--status` / `--executor` (exit 2) instead of sending a half-formed body.
5. **`pingcode testhub runs bulk` is the only way to delete a run** — there is no `runs delete` and
   no run DELETE endpoint. It is also the only way to add one. Each of `--add-case`, `--set-status`
   and `--remove-run` is capped at **50** entries per call (checked locally, exit 2), and the
   response carries **counts only**, never the ids of the runs it created: re-list the plan to see
   them.
6. **`testhub runs list` cannot filter by library.** `library.id` is on the API's exclusion list for
   run search, so scope runs with `--plan` instead. Passing `--library` without `--plan` resolves
   names but does not narrow the result, and the CLI warns on stderr when you do it.
7. **`testhub meta important-levels` takes no `--library`.** Importance levels are organisation-wide
   — the only testhub lookup with no per-library variant — so the flag is refused with exit 2 rather
   than accepted and ignored. It is hidden from `--help`; this line is the documentation.
8. **The `pcp:read:testhub:configuration` trap.** `testhub meta case-states` and `testhub meta
   run-statuses` need that scope while their sibling `testhub meta case-types` does not. A token
   granted only `testcase` + `testplan` can list cases, plans and runs but gets a bare 403 from
   those two — and since they are the only source of a `state_id` and a `status_id`, that token
   **cannot write a run at all**. The CLI rewrites the 403 to say so.
9. **`cases create` takes the library as `test_library_id`, and `--state` is PATCH-only.** The
   create body field is `test_library_id` (not `library_id`), which the CLI fills from `--library`;
   a case is created in the library's initial state and can only be moved with
   `pingcode testhub cases update <case> --state <s>`.
10. **`short_id` is read-only.** `testhub cases get`, `plans get` and the run read accept an id or a
    `short_id`, but every write documents `id` only. `testhub cases update` and `testhub runs patch`
    therefore read the resource first and use the real id — which is also where they learn the
    library, so a name lookup works without repeating `--library`.
11. **Two gaps to know about.** There is no `--maintenance` flag (filtering cases by maintainer is
    not exposed), and `--set` keys have **no discovery command** in this version: testhub's property
    lookup is outside this endpoint set, so read the keys off an existing case with
    `pingcode testhub cases get <case> --json`. Values for select-typed properties are option ids,
    not labels — the same trap as ship.

## 5. Agent workflow

1. `pingcode auth status` — if it reports no token, ask the user for credentials (§1) instead of
   guessing.
2. Resolve the parent scope: `pingcode project list --json` for work items,
   `pingcode product list --json` for ideas and tickets, or `pingcode testhub libraries list --json`
   for cases, plans and runs.
3. Resolve ids:
   - pjm: `pingcode project meta types --project <p> --json`, then
     `project meta states --project <p> --type <t> --json`. Keep the type around: you need it again for
     `--state <name>` on any write.
   - ship: `pingcode product meta idea-states --product <p> --json` (or the `ticket-*` equivalents), plus
     `product meta members --product <p> --json` before setting an assignee, and
     `product meta ticket-types --product <p> --json` before creating a ticket — `--type` is required there.
   - testhub: `pingcode testhub meta case-states --library <l> --json`, `case-types`,
     `run-statuses` (the source of `--status`, needed by every run write) and the org-wide
     `important-levels`. Find the plan with `pingcode testhub plans list --library <l> --json`.
4. Read before writing: `pingcode project work-item get <ref> --json`, `pingcode product idea get <ref> --json`,
   `pingcode product ticket get <ref> --json` or `pingcode testhub cases get <ref> --json` — and for a
   step-level run edit, read the run's steps first, because `--step` must cover all of them.
5. For any mutation, run it with `--dry-run --json` first, show the plan, get confirmation, then run
   it again without `--dry-run`. Remember that **nothing in ship can be deleted**, so say so before
   creating anything.
6. Always pass `--json` and parse stdout only; read stderr for warnings.
7. On exit 2 read the message — it names the flag, the ambiguous name, or the states a ticket can
   actually move to. On exit 3 re-authenticate. On exit 6 wait a minute rather than retrying
   immediately.

## 6. Not covered

Wiki spaces and pages, ship customers and external users, product tags, product/suite/member writes,
`POST /v1/relations` (the ship↔pjm link), departments and groups, workloads, comments and
attachments, Insight/Goals/Flow/Plan, and webhooks. PingCode has no REST API for webhooks at all —
they are configured in PingCode Flow's UI.

Inside testhub, this version deliberately leaves out: case **deletion** (irreversible, with no
undelete), library and case-module writes, plan create/update, `POST /v1/testhub/runs` and
`PUT /runs/{id}` (the PUT blanks the executor instead of merely reassigning it), every configuration
write, the case/run history reads, and the case-property lookup.

## 7. Installing this skill elsewhere

From a checkout of the CLI repository:

```bash
npm run skill:install -- --dry-run    # show the destinations
npm run skill:install                 # copy to ~/.claude/skills and ./.opencode/skills
npm run skill:install -- --force      # overwrite existing copies
```
