---
name: pingcode
description: >-
  Use the `pingcode` CLI to work with PingCode (研发管理): 敏捷项目管理 (pjm) projects and work items —
  list and search work items (工作项), read a story/task/bug (需求/任务/缺陷), create one, update fields,
  move it to another state (状态流转) — 产品管理 (ship) products, requirements (需求 / idea) and
  tickets (工单): search, read, create, update and transition them — and 测试管理 (testhub) test
  libraries (测试库), test cases (用例), test plans (测试计划) and runs (执行用例): create a library,
  search cases, read one, create and update a case, create a plan, record a run result, and bulk
  add/update/delete the runs of a plan. Also resolves project-, product- and library-scoped ids and
  organisation members (项目/产品/测试库/迭代/成员). Triggers: pingcode, PingCode 工作项,
  创建任务, 更新状态, 迭代 sprint,
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
   - `pcp:read:testhub:library` — `pingcode testhub libraries list` / `get`, `testhub meta suites`,
     and the case-module (模块) tree behind `--suite`. Every other testhub command starts by
     resolving a library, so this one is not optional
   - `pcp:write:testhub:library` — `testhub libraries create`, and nothing else. Grant it only if
     you intend to create libraries: they cannot be deleted afterwards
   - `pcp:read:testhub:testcase` — `testhub cases list` / `get`, and `testhub meta case-types`
   - `pcp:write:testhub:testcase` — `testhub cases create` / `update`
   - `pcp:read:testhub:testplan` — `testhub plans list` / `get`, `testhub meta plan-types`, and
     `testhub runs list`
   - `pcp:write:testhub:testplan` — `testhub plans create`, `testhub runs patch` / `bulk`
   - `pcp:read:testhub:configuration` — **not optional, despite the name**: `testhub meta
     case-states`, `testhub meta run-statuses` and `testhub meta important-levels` all sit behind
     it, and they are the only source of a `state_id`, a `status_id` and an `important_level_id`.
     Without it those three return a bare 403 while their sibling `case-types` keeps working, and
     since `PATCH /runs/{id}` requires `status_id`, a token without this scope **cannot write a
      run at all**. The CLI adds that explanation to the 403 for all three of those lookups.

   `--executor` on a run and `--assignee` on a plan both resolve through the organisation
   directory, so they also need `pcp:read:global:team`.
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

### Where each module's commands are documented

The per-module surface — every flag, every id lookup, and the traps specific to that module — lives
one file per module, so a module can be revised without touching this one:

| Module | File | Covers |
|---|---|---|
| 项目管理 pjm | [`modules/pjm.md`](modules/pjm.md) | `project list/get`, `project meta …`, `project work-item …` |
| 产品管理 ship | [`modules/ship.md`](modules/ship.md) | `product list/get`, `product meta …`, `product idea …`, `product ticket …`, and the ship-only traps |
| 测试管理 testhub | [`modules/testhub.md`](modules/testhub.md) | `testhub libraries/cases/plans/runs/meta …`, and the testhub-only traps |
| 源码管理 scm | [`modules/scm.md`](modules/scm.md) | **not built yet** — reserved |
| 构建与部署 | [`modules/cicd.md`](modules/cicd.md) | **not built yet** — reserved |
| 跨对象资源 | [`modules/crosscutting.md`](modules/crosscutting.md) | **not built yet** — reserved |
| 通用逃生舱 | [`modules/api.md`](modules/api.md) | `api GET/POST/PATCH/PUT/DELETE <path>` for every documented endpoint, plus `api list` / `api describe` |

A file marked *reserved* describes commands that **do not exist yet**. Do not suggest them; run
`pingcode --help` if you need to know what is actually installed.

`auth` and `settings` are documented here rather than in a module file: they are the CLI's own
credentials and a single directory lookup, not a business module.

### Auth

```bash
pingcode auth login --client-id <id> --client-secret <secret> --save
pingcode auth status
pingcode auth status --check      # adds one live API call: GET /v1/pjm/projects?page_size=1
pingcode auth logout
```

### Settings — 后台设置

```bash
pingcode settings users --keywords wang --json
```

The organisation directory (`/v1/directory/users`, scope `pcp:read:global:team`) belongs to no
business module, which is why it sits here rather than under `product` or `project`. It is the
candidate set for pjm's `--assignee`; ship's `--assignee` uses `product meta members` instead.

### Name → id resolution

`pingcode api` takes **ids only** — it understands no business names on purpose. `resolve` is the
missing half: one lookup, one id on stdout, nothing else.

```bash
pingcode resolve list --json                                   # every kind and the parent it needs
pingcode resolve project "移动端 App" --json                     # {"kind":"project","id":"5f2a…",…}
pingcode resolve ship-product SLC --json                       # identifier works as an alias
pingcode resolve ship-idea-state 已评审 --parent <product_id> --json
pingcode resolve testhub-library "研发测试库" --json
```

- stdout under `--json` is the resolution itself, so it composes:
  `pingcode api GET /v1/ship/idea/states --query product_id=$(pingcode resolve ship-product "智能客服" --json | jq -r .id)`.
- An **id is passed through** after being verified; a **name must match exactly** (case-insensitively)
  and exactly once. Zero or several matches is exit 2 listing the candidates — it never picks one.
- `--parent` takes an **id**, not a name: chain a second `resolve` if you only have the name.
- Answers are cached for 24 h per (host, `client_id`, parent, kind); `--no-cache` bypasses it.
- Ticket state plans and their flows are absent from `resolve list`, because no name addresses them.

The refined commands (`project meta …`, `product meta …`, `testhub meta …`) already accept names
directly, so `resolve` is mainly for feeding the generic layer.
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
     `run-statuses` (the source of `--status`, needed by every run write), `suites` (the `PATH`
     column is the spelling `--suite` takes) and the org-wide `important-levels`. Find the plan with
     `pingcode testhub plans list --library <l> --json`, or create one — `testhub meta plan-types
     --library <l> --json` first, since `--type` on `plans create` comes from there. If the tenant
     has no usable library at all, `pingcode testhub libraries create` is the bootstrap; read
     [`modules/testhub.md`](modules/testhub.md) §4c rule 15 first, because it cannot be undone.
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
undelete), library **update** and the four library-member endpoints, case-module (suite) writes,
plan **update** and **delete**, `POST /v1/testhub/runs` and `PUT /runs/{id}` (documented to blank the
executor when the field is omitted — untested and not worth testing), every configuration write, the
case/run history reads, and the case-property lookup. Library and plan *creation* **are** covered
(`testhub libraries create`, `testhub plans create`), so the CLI can bootstrap its own fixtures; only
iteration and release plan types are out of reach, for the reason in
[`modules/testhub.md`](modules/testhub.md) §4c rule 14.

## 7. Installing this skill elsewhere

From a checkout of the CLI repository:

```bash
npm run skill:install -- --dry-run    # show the destinations
npm run skill:install                 # copy to ~/.claude/skills and ./.opencode/skills
npm run skill:install -- --force      # overwrite existing copies
```