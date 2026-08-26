# pingcode-cli

[![CI](https://github.com/anine09/pingcode-cli-unofficial/actions/workflows/ci.yml/badge.svg)](https://github.com/anine09/pingcode-cli-unofficial/actions/workflows/ci.yml)

A command-line client for the [PingCode Open API](https://open.pingcode.com/), plus a single
`pingcode` skill that teaches AI agents how to drive it.

Scope, in two tiers: **every one of the 459 documented `/v1` endpoints is reachable** through the
generic executor `pingcode api`, and **158 of them also have named commands** with flag validation,
name→id resolution and tables — projects and work items, ship products/ideas/tickets, testhub
libraries/cases/plans/runs, the SCM and CI/CD write-back surface, and the cross-object
relations/comments/attachments/activities that link them. Wiki has **no** named command (0 of 19
endpoints), and neither do the org chart beyond `settings users`, worklogs, permission views or
Nexus; they are reachable through `pingcode api` only. Flow and Insight have no REST API at all.
See [Coverage](#coverage-reach-vs-ergonomics) for the per-module split.

---

## Install

Requires **Node.js >= 20**. The package is not published to npm; release zips
ship their own `node_modules/` (`commander`, `picocolors`), so an installed
binary needs only Node — no `npm` on the client. Build from a checkout for development.

### One-click (recommended)

From the repo checkout, one command installs deps, builds, and links `pingcode` onto your
`PATH` — compatible with Linux, macOS, and Windows. Re-run it after `git pull` to rebuild +
relink the latest code:

```bash
./install.sh            # Linux / macOS  (or: npm run install:cli)
```

```powershell
.\install.ps1           # Windows PowerShell  (or: npm run install:cli)
```

The Windows variant needs PowerShell (`pwsh` or Windows PowerShell); the `install:cli` npm
script is the cross-platform fallback (`node scripts/install.mjs`).

### Manual

```bash
npm install
npm run build            # → dist/bin/pingcode.js
npm link                 # then just: pingcode --help
```

Development commands:

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest run — no network, ever
npm run dev              # tsup --watch
npm run skill:install    # copy skills/pingcode/SKILL.md to the agent skill dirs
npm run scan:secrets     # credential / tenant-identifier scan
npm run check:commits    # commit-message gate
```

---

## Get credentials

The CLI authenticates as an **application**, not as a user, using the OAuth
`client_credentials` grant.

1. In the PingCode enterprise console open **后台管理 (企业后台) → 凭据管理** ("Credential
   Management") and create an application.
2. Set 鉴权方式 (grant type) to **Client Credentials**.
3. Grant the scopes the commands you intend to use need. This table is the same list
   `skills/pingcode/SKILL.md` §1 gives an agent; the first four cover the smallest useful surface:

   | Scope | Needed for |
   |---|---|
   | `pcp:read:pjm:project` | `project list` / `get` / `progress`, `project member …`, and every project-name lookup |
   | `pcp:write:pjm:project` | `project create` / `update`, `project member add`. Grant deliberately: **a project can never be deleted or archived** through this API |
   | `pcp:read:pjm:workitem` | `project work-item list` / `get` / `history …`, `project meta types` / `states` / `priorities` / `relation-types` / `tags` |
   | `pcp:write:pjm:workitem` | `project work-item create` / `update` / `transition` / `bulk-update` / `delete`, plus `link …` and `tag …` |
   | `pcp:read:global:team` | `settings users`, and every `--assignee` / `--executor` that resolves against the org directory |
   | `pcp:read:pjm:sprint` | `project meta sprints` (which is the sprint *list*) and `project sprint get` |
   | `pcp:write:pjm:sprint` | `project sprint create` / `update` / `bulk-create`. **A sprint can never be deleted** |
   | `pcp:read:pjm:release` | `project version list` / `get`. Note the mismatch: the scope says *release*, the command says *version* |
   | `pcp:write:pjm:release` | `project version create` / `update` / `delete` / `bulk-create` |
   | `pcp:read:ship:product` | `product list` / `get`, `product plan …`, `product meta members`, and every product-name lookup |
   | `pcp:read:ship:idea` | `product idea list` / `get` / `history …`, `product meta idea-*` |
   | `pcp:write:ship:idea` | `product idea create` / `update` |
   | `pcp:read:ship:ticket` | `product ticket list` / `get`, `product meta ticket-*` |
   | `pcp:write:ship:ticket` | `product ticket create` / `update` / `transition` |
   | `pcp:read:ship:configuration` | optional — only the state-plan *explanation* in `product ticket transition`; without it the CLI warns and lets the server judge |
   | `pcp:read:testhub:library` | `testhub libraries list` / `get`, `testhub meta suites`, and the case-module (模块) tree behind `--suite` |
   | `pcp:write:testhub:library` | `testhub libraries create` — grant it only if you mean to create libraries; they cannot be deleted |
   | `pcp:read:testhub:testcase` | `testhub cases list` / `get` / `history list`, `testhub meta case-types` / `case-properties` |
   | `pcp:write:testhub:testcase` | `testhub cases create` / `update` / `bulk-create` / `bulk-update` / `delete` |
   | `pcp:read:testhub:testplan` | `testhub plans list` / `get`, `testhub runs list` / `history …`, `testhub meta plan-types` / `plan-states` |
   | `pcp:write:testhub:testplan` | `testhub plans create` / `update`, `testhub runs create` / `patch` / `bulk*` |
   | `pcp:read:testhub:configuration` | **not optional** — `testhub meta case-states` / `run-statuses` / `important-levels`, i.e. every `state_id`, `status_id` and `important_level_id` |
   | `pcp:read:devops:code` | `scm platform` / `platform-user` / `repo` / `branch` / `commit` / `ref` / `pr` / `review` reads, and every platform/repo name lookup |
   | `pcp:write:devops:code` | every `scm … create` / `update`, and `scm branch delete` |
   | `pcp:read:devops:build` | `build list` / `get` |
   | `pcp:write:devops:build` | `build create` / `update` / `delete`. **Separate from `devops:code`** — a token that can write commits cannot write builds, and the only symptom is exit 4 |
   | `pcp:read:devops:deploy` | `release env list` / `get` **and** `release deploy list` / `get` — one pair covers both subgroups |
   | `pcp:write:devops:deploy` | `release env create` / `update`, `release deploy create` / `update` |

   Every ship command begins by resolving a product name, so `pcp:read:ship:product` is required
   even for a pure `product idea list`. The product-scoped metadata endpoints (`/v1/ship/idea/*`,
   `/v1/ship/ticket/*`) sit under the ordinary read scopes above, **not** under `configuration`.

   Testhub is the same story with a sharper edge: every testhub command begins by resolving a test
   library, so `pcp:read:testhub:library` is required even for a pure `testhub cases list` — and
   `pcp:read:testhub:configuration` is *not* optional despite the name, because `case/states` and
   `run/statuses` live behind it while their sibling `case/types` does not. A token without it can
   list cases, plans and runs but cannot resolve a `status_id`, and `PATCH /runs/{id}` requires one,
   so it cannot write a run at all. `--executor` on a run and `--assignee` on a plan both resolve
   through the organisation directory, so they also need `pcp:read:global:team`.

   The whole DevOps area (`scm`, `build`, `release`) is **企业令牌 only**, which is exactly what
   `client_credentials` yields — no extra grant type is needed, only the six `devops:*` scopes.

   The 15 cross-object endpoints behind `relation` / `comment` / `attachment` / `activity` declare
   **no scope at all** in the vendor docs, and they work with the scopes above; a 403 from one of
   them would be a documentation bug, not a missing grant.

   `pingcode api describe <id>` prints the scope the docs declare for any endpoint, so a 403 through
   the generic layer names the scope it wants instead of leaving you guessing.

4. Copy the `client_id` and `client_secret`.

> **A `client_credentials` token carries organisation-wide system-administrator authority** and is
> not tied to any user. Treat it, and `~/.pingcode/config.json`, as a secret.

## Log in

```bash
# public cloud (default host: https://open.pingcode.com)
pingcode auth login --client-id <id> --client-secret <secret> --save

# self-hosted: pass your instance host, the API is served from <host>/open
pingcode auth login --host https://pingcode.example.com \
  --client-id <id> --client-secret <secret> --save

pingcode auth status --check     # adds one live call: GET /v1/pjm/projects?page_size=1
pingcode auth logout             # drops the token, the credentials and the metadata cache
```

Credentials resolve in this precedence order: **CLI flags → environment
(`PINGCODE_CLIENT_ID`, `PINGCODE_CLIENT_SECRET`, `PINGCODE_HOST`) → `~/.pingcode/config.json`**.
With a TTY attached, `auth login` prompts for anything missing.

- `--save` is what persists the client id/secret. Without it only the token is stored, so you must
  log in again when it expires.
- Storage is `~/.pingcode/config.json`, mode `0600` inside a `0700` directory (a no-op on Windows).
  `PINGCODE_CONFIG_DIR` relocates it.
- Tokens are valid ~30 days and are re-acquired **transparently**: proactively 120 s before expiry,
  and reactively once on a `401`, replaying the original request. You never have to re-run `login`
  while the credentials are stored.
- Repeated logins do **not** invalidate previously issued tokens, so parallel invocations are safe.

---

## Coverage: reach vs ergonomics

The API has **459** documented `/v1` endpoints and no OpenAPI spec. This CLI answers that with two
layers whose costs are completely different, and it is worth knowing which one you are standing on.

| Layer | What you get | Coverage | Cost of adding an endpoint |
|---|---|---|---|
| **Reach** — `pingcode api` | one generic executor over a vendored endpoint catalog: real auth, paging, `--dry-run`, redaction, exit codes, pre-flight validation | **459 / 459** | zero — it is already there |
| **Ergonomics** — the refined layer | `--flags` instead of raw JSON, name→id resolution, width-aware tables, per-endpoint traps recorded in `--help` | **158 / 459** | one live-verified slice each |

"Complete" (完全体) refers to **Reach**, and Reach is finished: every documented endpoint is
invocable today. Seven of the 459 are refused *before any request* because they need a user token
this CLI cannot obtain (`/v1/myself`, `/v1/permission/my/*`, `/v1/permission/check/*` — the
authorization-code flow is not implemented), which leaves 452 actually callable. Ergonomics is a
**curation backlog, not a finish line**: an endpoint earns a named command by being run against a
live tenant, having its error codes either mapped with evidence or explicitly left alone, and
keeping `--json` pure and `--dry-run` silent. Endpoints that nobody drives interactively are better
served by the generic layer than by a hand-written command nobody has exercised.

### Per module

Counted as `(method, path)` pairs: how many of a module's endpoints the refined layer calls, out of
how many the catalog documents. The module names are the ones `pingcode api list --module <m>` takes.

| Module | Refined | Total | Notes |
|---|---|---|---|
| `pjm` 项目管理 | 40 | 145 | projects, work items, sprints, releases, members. The 105 remaining are mostly configuration — 工作项配置 schemes (42) and 项目配置 (7) — plus 看板 boards (15) |
| `ship` 产品管理 | 27 | 101 | products, ideas, tickets, requirement schedules. Customers, external users and product configuration writes are generic-layer only |
| `testhub` 测试管理 | 32 | 65 | libraries, cases, plans, runs and their config lookups |
| `scm` 源码管理 | 31 | 36 | complete except the 5 `PUT`s — see below |
| `directory` 组织架构 | 1 | 23 | `settings users` only; departments, groups, roles and jobs are org master data |
| `wiki` | 0 | 19 | **no named command at all**, by decision: page content is `PUT`-shaped and destructive, and a CLI is a poor editor |
| `release` 部署 | 8 | 12 | environments + deploys; 2 `DELETE`s and 2 `PUT`s are generic-layer only |
| `build` 构建 | 5 | 6 | complete except its 1 `PUT` |
| 跨对象 `relations` `comments` `attachments` `activities` | 14 | 15 | the 15th is the `multipart/form-data` file upload — see the follow-ups |
| `reviews` `participants` | 0 | 12 | 评审 and 关注人; note `scm review` is a *different* resource |
| `permission` | 0 | 7 | 6 of the 7 need a user token; `GET /v1/permission/points` is reachable |
| `workloads` `workload_types` | 0 | 7 | 工时 |
| `nexus` | 0 | 5 | Nexus/CES app storage |
| `auth` | 0 | 3 | not user commands: `auth login` calls the `client_credentials` grant internally, and the two user-token grants are not implemented |
| `security` `myself` | 0 | 3 | login/audit logs, and the user-token `/v1/myself` |
| **Total** | **158** | **459** | 301 endpoints are reachable through `pingcode api` only |

**Two counting traps worth stating, because they make the arithmetic look wrong otherwise.**

- The table counts **endpoints**, while `--help` counts **commands**, and the two do not correspond
  one-to-one in either direction. There are **254** command leaves across **10** groups. The four
  cross-object families are implemented once (14 endpoints) and *mounted on five entities* — work
  items, ideas, tickets, test cases and test runs — so they contribute **70** leaves from those 14
  endpoints. And `pingcode resolve` contributes **32** leaves (one per resolvable metadata kind,
  plus `resolve list`) while calling only lookup endpoints already counted in their own module.
- Conversely one command often covers several endpoints (`project work-item list` is both the simple
  `GET` and `POST …/search`), and **two endpoints have no command at all** yet are counted: `GET
  /v1/ship/ticket_state_plans` and its `…/ticket_state_flows` child are called by the resolver cache,
  to tell `product ticket transition` which states are reachable when the server refuses one. They
  are wired and exercised, just never as a leaf you can type — which is why the layer is labelled
  *the refined layer* rather than *named commands*. So compare the two columns of *this* table, never
  a leaf count against an endpoint count.

### How this task's plan compares

The task that produced this surface planned three mutually exclusive sets over the 459: **53 already
covered + 107 to add + 299 left to the generic layer**. Measured after the fact, at
`(method, path)` granularity:

- the **53** baseline is exact (pjm 10 + directory 1 + ship 22 + testhub 20), confirmed by running
  the same count against the pre-task tree;
- **105 of the 107** landed, so refined coverage is 158 business endpoints and **301** are
  generic-layer only;
- the two that did not: `POST /v1/attachments` in its `multipart/form-data` form (a file upload
  needs a change to the frozen transport layer, so it was reported rather than forced), and
  `GET /v1/testhub/plan_states/{state_id}` (the get-one; the *list* is wired and is the only thing
  the plan write needs).

### Why there is no `scm platform replace`

All **10** `PUT` endpoints — 5 in `scm`, 2 in `release`, 1 each in `build`, `wiki` and `testhub` —
are reachable **only** through `pingcode api`, deliberately. `PUT` is full replacement on this API,
and the docs never say what an omitted field does; one module was measured *clearing* a field its
`PATCH` sibling preserves. A named `replace` command would make that trivially easy to do by
accident, so every refined write is a `PATCH`. If you really mean "replace the whole object":

```bash
pingcode api list --method PUT                # all 10, with the resource each one replaces
pingcode api describe scm.products.replace    # prints the full-replacement warning
pingcode api PUT /v1/scm/products/<id> --set name="…" --set type=other
```

### The escape hatches

```bash
pingcode api list --module scm            # what exists, offline, from the vendored catalog
pingcode api list --method DELETE         # the whole auditable danger surface, 49 rows
pingcode api describe scm.commits.get     # fields, scope, token type, paging, warnings
pingcode api GET /v1/directory/departments --all
pingcode resolve list --json              # every name→id kind and the parent it needs
pingcode resolve ship-product SLC --json  # ids for the generic layer, since it takes no names
```

`api list` / `api describe` read a catalog vendored into the binary and never touch the network. A
weekly CI job diffs that catalog against the live docs — see [CI/CD](#cicd).

---

## Command surface

The top level mirrors PingCode's own GUI modules: each business module owns its resources *and* its
id lookups, so one `--help` shows a module's whole surface. **10 groups, 254 leaves**; `--help`
works at every level, and is the authority — this listing is a map, not a contract.

```
pingcode auth      login | status | logout
pingcode api       GET|POST|PATCH|PUT|DELETE <path> · list | describe
pingcode resolve   list | <kind> <name>          # 31 id-resolvable kinds

# ship (产品管理)
pingcode product   list | get <product>
pingcode product idea    list | get <ref> | create | update <ref> · history list|get
pingcode product ticket  list | get <ref> | create | update <ref> | transition <ref>
pingcode product plan    list | get <ref>        # 需求排期, read-only upstream
pingcode product meta    idea-states | idea-priorities | idea-suites | idea-properties | idea-plans
                         members | ticket-states | ticket-priorities | ticket-types
                         ticket-channels | ticket-properties

# pjm (敏捷项目管理)
pingcode project   list | get <project> | create | update <project> | progress <project>
pingcode project work-item  list | get <ref> | create | update <ref> | transition <ref>
                            bulk-update | delete <ref>
                            link list|get|add|delete · tag add|get|delete · history list|get
pingcode project sprint     get | create | update | bulk-create   # list is `project meta sprints`
pingcode project version    list | get | create | update | delete | bulk-create
pingcode project member     list | get | add
pingcode project meta       types | states | priorities | sprints | relation-types | tags

# testhub (测试管理)
pingcode testhub libraries  list | get <library> | create
pingcode testhub cases      list | get <ref> | create | update <ref> | delete <ref>
                            bulk-create | bulk-update · history list
pingcode testhub plans      list | get <ref> | create | update <ref>
pingcode testhub runs       list | create | patch <run> | bulk | bulk-create | bulk-update
                            history list|get
pingcode testhub meta       case-states | case-types | case-properties | important-levels
                            run-statuses | plan-types | plan-states | suites

# scm (源码管理) — DevOps write-back, 企业令牌 only
pingcode scm platform | platform-user | repo   list | get | create | update
pingcode scm branch    list | get | create | update | delete
pingcode scm commit | ref                      list | get | create
pingcode scm pr | review                       list | get | create | update

# 构建与部署
pingcode build     list | get | create | update | delete
pingcode release env     list | get | create | update
pingcode release deploy  list | get | create | update

# 后台设置
pingcode settings  users

# cross-object, mounted on five entities:
#   product idea · product ticket · project work-item · testhub cases · testhub runs
pingcode <entity> relation    list | get | add | delete
pingcode <entity> comment     list | get | add | delete
pingcode <entity> attachment  list | get | add-snippet | delete
pingcode <entity> activity    list | get
```

Global flags — valid **before or after** the subcommand: `--host <url>`, `--json`, `--dry-run`,
`--no-cache`, `--verbose`, `--version`, `--help`. `--help` works at every level
(`pingcode project work-item update --help`).

```bash
pingcode project list --json
pingcode project get "Mobile App" --json

# metadata first — ids are project-scoped
pingcode project meta types      --project "Mobile App" --json
pingcode project meta states     --project "Mobile App" --type task --json
pingcode project meta priorities --project "Mobile App" --json
pingcode settings users      --keywords wang --json

pingcode project work-item list --project "Mobile App" --type task --state "In Progress" --json
pingcode project work-item list --project "Mobile App" --all --limit 200 --json
pingcode project work-item get SCR-5 --json          # also: id, short_id, or a pasted work-item URL

pingcode project work-item create --project "Mobile App" --type task --title "Fix login retry" --dry-run --json
pingcode project work-item create --project "Mobile App" --type task --title "Fix login retry" \
  --assignee wangxiao --priority High --end-at 2026-02-15 --json

pingcode project work-item update SCR-5 --title "Fix login retry (v2)" --json
pingcode project work-item transition SCR-5 --type task --state Done --json
pingcode project work-item transition SCR-5 --state-id 5eb623f6a70571487ea47000 --json
```

```bash
# ship: resolve the product first — every other ship id hangs off it
pingcode product list --json
pingcode product get SLC --json

pingcode product meta idea-states     --product SLC --json
pingcode product meta members --product SLC --json     # the only valid --assignee values
pingcode product meta ticket-types    --product SLC --json     # required to create a ticket

pingcode product idea list --product SLC --state 待评审 --assignee zhangsan --json
pingcode product idea get SLC-1 --json
pingcode product idea create --product SLC --title "Single sign-on" --dry-run --json
pingcode product idea update SLC-1 --state 开发中 --json

pingcode product ticket list --product SLC --type 故障 --json
pingcode product ticket create --product SLC --type 故障 --title "Cannot log in" --json
pingcode product ticket transition SLC-7 --state 处理中 --json
```

```bash
# testhub: resolve the test library first — states, types, statuses, modules and plans hang off it
pingcode testhub libraries list --json
pingcode testhub libraries get LIB --json
pingcode testhub libraries create --name "Payments" --identifier PAY --json   # permanent: no DELETE

pingcode testhub meta case-states      --library LIB --json   # --state / state_id
pingcode testhub meta case-types       --library LIB --json   # --type / type_id
pingcode testhub meta run-statuses     --library LIB --json   # --status / status_id
pingcode testhub meta plan-types       --library LIB --json   # --type on `plans create`
pingcode testhub meta suites           --library LIB --json   # --suite; the PATH column is the key
pingcode testhub meta suites           --library LIB --parent-id root --json   # top level only
pingcode testhub meta important-levels --json                 # org-wide: takes no --library

pingcode testhub cases list --library LIB --state 已评审 --json
pingcode testhub cases get aB3dEf9h --json                    # an id or a short_id
pingcode testhub cases create --library LIB --title "SSO login" --dry-run --json
pingcode testhub cases update aB3dEf9h --state 已评审 --json

pingcode testhub plans list --library LIB --json
pingcode testhub plans get "2026 S1 回归" --library LIB --json
pingcode testhub plans create --library LIB --name "2026 S2 回归" \
  --type 普通 --start 2026-08-10 --end 2026-08-31 --assignee 张三 --dry-run --json

pingcode testhub runs list --library LIB --plan "2026 S1 回归" --json
pingcode testhub runs update 7hK2mQ9x --status 通过 --remark "retested on iOS" --json
pingcode testhub runs bulk --library LIB --plan "2026 S1 回归" --remove-run 7hK2mQ9x --json
```

```bash
# DevOps write-back: a CI job telling PingCode what happened. Nothing here reads your
# git server or your pipeline — every command writes a record PingCode links to work items.
pingcode scm platform list --json
pingcode scm repo list --platform "GitHub" --json
pingcode scm commit create --sha 9f3c1ab0000000000000000000000000000000ab \
  --message "fix login retry" --committer ci-bot --work-item PLM-1 --dry-run --json
pingcode scm pr create --platform "GitHub" --repo acme/web --title "Fix login retry" \
  --number 42 --status open --creator ci-bot \
  --source-branch-id <id> --target-branch-id <id> --json

pingcode build create --name nightly --identifier 1042 --provider jenkins --status success \
  --start-at 2026-08-05T01:00:00Z --end-at 2026-08-05T01:07:30Z --duration 450 \
  --work-item PLM-1 --json
pingcode release env list --json
pingcode release deploy create --env staging --status deployed --release-name 1.4.0 \
  --start-at 2026-08-05T02:00:00Z --end-at 2026-08-05T02:03:00Z --duration 180 --json
```

```bash
# cross-object: the same four families on any of the five entities
pingcode project work-item comment add SCR-5 --text "blocked by the SSO rollout" --json
pingcode project work-item relation add SCR-5 --target-type test_case --target-id <id> --json
pingcode product idea activity list SLC-1 --json
pingcode testhub runs attachment list 7hK2mQ9x --json
```

`--dry-run` on a mutating command prints the request it *would* have sent and exits 0 without
sending it. Read requests still run, so ids are genuinely resolved first.

---

## The `--json` contract

- **stdout carries JSON only.** Tables, logs, warnings, dry-run notes and errors go to stderr.
- Timestamps stay raw **unix seconds** in `--json`; human mode renders local time.
- Three list shapes, by command family:
  - one page of any refined `list` (`project work-item list`, `product idea list`,
    `testhub cases list`, `scm repo list`, `build list`, `release deploy list`, …) →
    `{"page_index":0,"page_size":30,"total":123,"values":[…]}`
  - any list with `--all` → `{"values":[…],"count":42,"all":true}`
  - every `meta` lookup (`product meta …`, `project meta …`, `testhub meta …`, `settings users`) → `{"values":[…],"count":20}`
- Single-resource commands (`get`, `create`, `update`, `transition`) print the resource object.
- `--dry-run` prints `{"dry_run":true,"request":{"method":…,"url":…,"headers":…,"body":…}}` — with
  `Authorization` and any `client_secret` masked.
- Errors print to **stderr** as `{"error":{"kind":…,"message":…,"code":…,"exit":…}}`.
- **`pingcode api` is different: stdout is always the API's raw JSON, so `--json` is a no-op on the
  five verbs.** There is no table to switch off. Its own `api list` / `api describe` are local
  catalog views and do honour `--json`.
- **Read keys defensively — an absent key means null *or* empty.** `api/parse.ts` normalises both
  `null` and `""` to "not present", so they are simply missing from the output and cannot be told
  apart. See the follow-ups; this is the one output change queued as breaking.

### Exit codes

| Exit | Kind | Meaning |
|---|---|---|
| 0 | — | success, including a printed dry-run plan |
| 1 | `unexpected` | unhandled internal error |
| 2 | `usage` | bad/missing flags, ambiguous or unresolvable name, empty update |
| 3 | `auth` | no or invalid credentials |
| 4 | `permission` | 403, or a scope the app was never granted |
| 5 | `not_found` | the work item, state or other resource does not exist |
| 6 | `rate_limit` | 429 — the limit is 200 requests/minute per token |
| 7 | `api` | any other non-2xx, carrying the API's `{code, message}` |
| 8 | `transport` | DNS / TCP / TLS / timeout / unparseable body |

This API answers **HTTP 400 where REST convention would use 401 or 404**, so a table of observed API
`code` values is mapped by code rather than by status. It currently holds **32 rows** — 1 → exit 3
and 31 → exit 5 — and the authoritative copy, with the live observation behind every single row, is
`ERROR_CODE_OVERRIDES` in `src/core/wire.ts`. A sample:

| API `code` | HTTP | Observed on | → exit |
|---|---|---|---|
| `100024` | 400 | `GET /v1/auth/token` with a wrong client id/secret | 3 (`auth`) |
| `100317` | 400 | `GET /v1/pjm/work_items/{unknown id}` | 5 (`not_found`) |
| `100725` / `100711` | 400 | unknown ship idea / ticket | 5 (`not_found`) |
| `100601` / `100603` / `100600` | 400 | unknown testhub case / run / library | 5 (`not_found`) |
| `100051` / `100045` / `100801` / `100077` | 400 | unknown comment / attachment / relation / activity | 5 (`not_found`) |
| `100200` / `100202` / `100209` | 400 | unknown scm platform / repository / git identity | 5 (`not_found`) |

The rule for growing that table is in
[`.trellis/spec/backend/error-handling.md`](.trellis/spec/backend/error-handling.md): match on the
`code` string only (the API is Chinese-only and its wording is not a contract), and add a row only
with a recorded live observation cited next to it.

Any other code keeps the status-first mapping and is surfaced verbatim on exit 7 — read `code`
before drawing conclusions. (An invalid *bearer* token on a resource endpoint does return a real
401, so the 401 branch is still live.) Note what is deliberately **absent**, and why the absences
matter as much as the rows: ship's `100719` / `100702` ("state does not exist") also fire for a state
that plainly exists but is unreachable under the state plan, so mapping them to `not_found` would be
a lie; testhub's `100619` rejects a *whole* bulk batch, so exit 5 would name one run while implying
the others landed; and `100000` is a real HTTP 500 that must keep it.

---

## Caveats that matter in practice

The exhaustive per-module traps live in `skills/pingcode/modules/*.md` — one file per module, and
they are written for an agent, which makes them the most detailed reference in the repository. What
follows is only what applies everywhere.

- **Ids are parent-scoped — run the module's `meta` lookups first.** The parent is a **project** in
  pjm, a **product** in ship, a **test library** in testhub and a **hosting platform** in scm. The
  same state name has a different id under a different parent. System work-item types are bare slugs
  (`task`, `story`, `bug`); custom types, states and priorities are 24-hex ids; users are 32-hex.
  Never reuse an id across parents, and never let a script validate an id's shape.
- **`update` replaces, it does not merge.** Every field you pass overwrites the stored value, and
  arrays plus `properties` objects are replaced wholesale. Read the item first if you need to keep
  anything. There is no way to clear a field, and an update with no fields is exit 2, not a no-op.
- **Every `delete` needs `--yes`, and the refusal echoes the resolved name**, not just the id — the
  confirmation costs one extra GET and buys back the one class of mistake that cannot be undone.
  `pingcode api list --method DELETE` enumerates all 49 deletable endpoints.
- **`PATCH` only. No refined command issues a `PUT`** — see
  [why there is no `scm platform replace`](#why-there-is-no-scm-platform-replace).
- **`--all` is best effort, not a snapshot.** It walks 0-based pages (`page_size` ≤ 100),
  de-duplicates by id, stops at `--limit` (default 500) and bails if the server stops honouring
  `page_index`. **No endpoint supports sorting**, so offset paging over changing data can duplicate
  or skip rows. Sort what you collected yourself.
- **Rate limit: 200 requests/minute per token.** 2xx responses carry no rate-limit headers, so the
  budget is invisible until a 429 arrives. Prefer one `--page-size 100` call over many small ones,
  and let the cache work.
- **Timestamps are unix seconds everywhere.** Date flags accept `1730000000` or a calendar date;
  read the flag's own `--help`, because the two families differ deliberately: `project --start-at`
  stores the instant verbatim, while `project sprint` / `project version` / `testhub plans` snap
  `--start` to `00:00:00` and `--end` to `23:59:59` of the date.
- **A 200 is not proof the field landed.** This API accepts unknown body fields, several read-only
  fields and (in `work-item bulk-update`) whole unsupported properties with a 200 and no warning.
  Where a command knows about one, it refuses locally or warns on stderr; where it cannot know, read
  the object back.
- **Metadata is cached for 24 h** under `~/.pingcode/cache/` (mode `0600`, hashed filenames), keyed
  by `(apiBase, clientId, parentId, kind)`. Pass `--no-cache` if a parent was reconfigured and an id
  looks stale; a write rejected on a cached id invalidates that entry and retries **once**, and only
  if re-resolving actually changed an id — the CLI never sends the same mutating body twice.
  `auth login` and `auth logout` both clear the cache.
- **`pingcode resolve` is the same lookup as a hand-typed name**, exposed as one id on stdout so it
  can feed `pingcode api`, which takes ids only.
- **Two flag shapes, split by module, both accepting a name or an id.** `testhub`, `scm` and
  `release` use **pairs** — `--library` / `--library-id`, `--platform` / `--platform-id`, `--repo` /
  `--repo-id`, `--env` / `--env-id` — where `--x` looks the name up and `--x-id` is sent verbatim with
  no lookup; the two are mutually exclusive (exit 2). `pjm` and `ship` use a **single** flag
  (`--project`, `--sprint`, `--release`, `--product`) that decides for you and offers no way to skip
  the lookup. Neither shape ever validates an id's format. `SKILL.md` has the table plus the three
  deliberate exceptions (`testhub runs list --case-id`, `scm … list --work-item-id`, and
  `project update --state-id`, which has no `--state` because no resolver kind covers project states).

### pjm-specific caveats

- **`--state <name>` always needs `--type`.** States live in a `(project, work item type)` pair and
  the API never reports a work item's type, so the CLI cannot infer it — not on `list`, and not on
  `update`/`transition` (`create` already requires `--type`). Pass `--type <name|id>`, or skip the
  lookup with `--state-id <id>`. On `update`/`transition`, `--type` is *only* a lookup aid: it is
  never written to the work item. `--state` and `--state-id` are mutually exclusive.
- **State changes are workflow-validated server-side.** On rejection the CLI prints the server
  message plus the states configured for that type — but only if you passed `--type`.
- **A project can never be deleted or archived**, and a **sprint can never be deleted at all**.
  `project create`, `project sprint create` and `sprint bulk-create` are irreversible; `--dry-run` first.
- **`link` and `relation` are different families.** `link` is work item ↔ work item with a required
  type; `relation` is work item ↔ anything *else* and refuses two work items outright.
- **There is no `sprint list` or `work-item tag list` leaf.** The sprint list is `project meta
  sprints` (it doubles as the `--sprint` lookup); a work item's tags are the `tags[]` field of
  `work-item get`, because upstream publishes no collection GET for them.
- **A work item's assignee cannot be cleared via the API.** `PATCH`'s `assignee_id` is a plain
  string with no `nullable`: `null` is a silent HTTP 200 no-op and `""` is an HTTP 400. So
  `work-item update <id> --assignee ""` fails fast (exit 2) rather than sending a request that would
  look like success. To unassign, use the PingCode web UI.

### Ship-specific caveats

Everything above still applies; [`modules/ship.md`](skills/pingcode/modules/ship.md) is the full
version. These are the differences that will cost you time:

- **A product is ship's project.** `state_id`, `priority_id`, `suite_id`, `type_id`, `channel_id`,
  the writable `properties` keys and the assignable people are all **product-scoped**, even though
  several of them look org-global (the same `P0` priority id appears under multiple products). The
  API demands `product_id` on every lookup; never reuse an id across products.
- **`--assignee` resolves against product members**, not `/v1/directory/users`. A user who is not a
  member of the product cannot be assigned, so `product meta members` is the candidate set.
- **`product idea list` and `product ticket list` are `POST …/search`.** The plain list endpoints cannot filter by
  assignee, date or custom property. The DSL allows **one operator per field and no `$and`/`$or`**;
  several filters are AND-ed. Body pagination puts the cursor in `payload.page_index`, and the CLI
  applies the same `--page` / `--page-size` (≤100) / `--all` / `--limit` semantics as elsewhere.
- **State changes are decided by the server; ticket refusals are explained.** Ship publishes the
  legal transitions of a ticket state plan, and the CLI reads them — but only to *explain* a
  refusal, never to pre-empt one. `product ticket transition` sends the PATCH; if the server refuses, the
  error `message` carries the configured states, the current state and the states reachable from
  it. `product ticket transition --dry-run` previews that reachable set on stderr without writing. Ideas
  have **no state-flow endpoint at all**, so `product idea update --state` gets the configured states on
  rejection and nothing more. The only local refusal is moving a ticket to the state it is already
  in. Rationale: the server refuses atomically, so nothing is saved by checking first, while a
  mis-identified plan would block a legal move outright (`s7-smoke.md` F5).
- **Locating a ticket's state plan is a scan, and only ever advisory.** The ticket payload carries
  no plan reference and the plan list has no `product_id` filter, so the CLI lists every plan and
  matches the embedded `product.id`, falling back to the org-default (`product: null`) plan when
  there is exactly one — which live is the common case. Cached per product. Since the answer only
  feeds an explanation, a wrong guess costs a wrong suggestion, never a blocked write.
- **`--set key=value` sends the value verbatim, and select-type properties want the option `_id`,
  not its label.** `product meta idea-properties` / `product meta ticket-properties` print both, and are also the
  authoritative list of writable keys. `properties` replaces wholesale.
- **Nothing in ship can be deleted.** There is no DELETE for products, ideas or tickets, and
  `is_archived` / `is_deleted` are read-only. Anything you create during a test is permanent —
  prefix the title before creating it.
- **An identifier works on the resource, and nowhere below it.** `product idea get` / `ticket get`
  accept the id, the 8-char `short_id` a pasted URL ends in **and** the human `SLC-1` — all three
  answer 200 live. A sub-resource (a comment, an attachment) is addressed by the parent's real id, so
  every write resolves the reference first.
- **`--suite` filtering on `product idea list` is undocumented** — the API lists `suite.id` as neither
  filterable nor unfilterable, so an empty result proves nothing. The CLI warns when you use it.
- **`ticket.channel` is an object or the bare string `"internal"`**, and `--channel` can only be set
  at create time. Tags cannot be written at all, and a ticket's `submitter_id` is silently ignored
  under a client-credentials token — neither is exposed.
- **"Plan" is three unrelated resources**, and mixing them up produces a not-found nobody can
  explain: `product plan` is a 需求排期 (requirement schedule, read-only upstream — a write answers
  HTTP 405), `testhub plans` is a test plan, and `ticket_state_plans` is a configuration scheme
  reachable only through `pingcode api`.
- **`product idea history` is state changes only.** A title or assignee edit is not there; that is
  `product idea activity list`, the free-form feed.

### Testhub-specific caveats

Everything above still applies. Testhub's parent scope is a **test library**, and its write path is
the sharpest in the CLI. [`skills/pingcode/modules/testhub.md`](skills/pingcode/modules/testhub.md)
is the exhaustive version, including the `--set` traps and the two bulk families' opposite failure
modes.

- **A test library is testhub's project.** `state_id`, `type_id`, `status_id`, `suite_id` and the
  plan list are all library-scoped — two libraries never share a state, type or status id, even when
  the names match. Six `meta` leaves are library-scoped (`case-states`, `case-types`,
  `case-properties`, `run-statuses`, `plan-types`, `suites`) and two are organisation-level
  (`important-levels`, `plan-states`); a missing `--library` on a library-scoped command is exit 2.
  `cases get|update|delete`, `plans get|update` and `runs update` read the resource first and inherit
  its library; `runs list` needs one only to resolve `--plan` / `--status` by name.
- **`cases list` and `runs list` are `POST …/search`.** The plain `GET` lists are never used —
  unfiltered, `GET /v1/testhub/cases` scans every library the token can see. Same DSL limits as
  ship: one operator per field, no `$and`/`$or`, no sorting.
- **`--step` is all-or-nothing, because `steps[]` replaces.** A run's step array is overwritten
  wholesale and a step sent without its `step_id` is re-created with a new id, orphaning its
  history. Re-emitting an untouched step is impossible: a run step reports a status **slug** while
  the write needs a status **id**, and only the localized (renameable) name joins them. So the CLI
  refuses a partial step edit and prints the full list of step ids. `--set` / `properties` on a case
  replace wholesale too.
- **`runs update` always sends `status_id`, and carries the executor over.** `status_id` is required
  by the API even on PATCH, so the CLI pre-reads the run and re-sends its current result — and its
  current executor — when you do not name one. If the run has no executor and you name none,
  `executor_id` is omitted and the CLI warns that the run stays unassigned (omitting it is a
  verified no-op on PATCH: it neither clears the field nor reassigns the run). With no recorded
  result at all it asks for `--status` (exit 2) rather than sending a half-formed body.
- **`runs bulk` is the only way to *delete* a run** — there is no run DELETE endpoint at all. Runs
  can be *created* three ways (`runs create`, `runs bulk-create`, or `runs bulk --add-case`), and the
  caps differ: `cases bulk-*` and `runs bulk-*` are capped at **100 by the server**, while
  `runs bulk` enforces nothing upstream and the CLI caps each of its three arrays at **50** locally.
  A bulk response is **counts only**: re-list the plan to see the new ids.
- **The two bulk families fail in opposite ways.** `runs bulk` is per-element best effort under a
  200, `cases bulk-*` is atomic. Do not generalise one to the other — always read the counts.
- **`runs list` cannot filter by `library.id`** — it is on the API's exclusion list for run search,
  so scope runs with `--plan`. The CLI warns when `--library` is given without one.
- **`meta important-levels` takes no `--library`.** Importance levels are organisation-wide, the one
  testhub lookup with no per-library variant, so the flag is refused with exit 2 instead of being
  ignored. The refusal is hidden from `--help`, which is why it is written down here.
- **`pcp:read:testhub:configuration` is a trap, not an option.** `meta case-states` and
  `meta run-statuses` need it; their sibling `meta case-types` does not. Without it a token gets a
  bare 403 from exactly the two lookups that produce a `state_id` and a `status_id` — so it cannot
  write a run at all. The CLI rewrites that 403 to say so.
- **`cases create` sends the library as `test_library_id`** (not `library_id`), and `state_id` is
  **PATCH-only**: a case is created in the library's initial state and moved with `cases update`.
- **`cases delete` takes the case's runs with it**, soft-deleted alongside it. It is gated behind
  `--yes` and the confirmation names the case, because the blast radius is invisible from the
  reference you typed.
- **`short_id` is read-only.** Reads accept an id or a `short_id`; every write documents `id` only,
  so the write paths resolve it through a pre-read.
- **Dates: the end of a range is inclusive.** `--start` / `--end` on `plans create` and
  `plans update` take a zero-padded `YYYY-MM-DD` or a 10-digit unix **seconds** integer. A calendar
  date resolves to **00:00:00 local** for `--start` and **23:59:59 local** for `--end`; a raw integer
  is passed through **verbatim** on both. The asymmetry is deliberate — a range runs *through* its
  end date. Rejected with exit 2 **before any request**: an unpadded `2026-8-1`, slashes, an ISO
  string carrying a time, a 13-digit milliseconds value, an impossible date like `2026-02-30`, and
  `--end` before `--start`.
- **`plans create` requires all six flags and `--assignee` has no default.** `--library`, `--name`
  (unique within the library), `--type`, `--start`, `--end`, `--assignee`. There is no "assign to me"
  because a client-credentials token acts as the **bot user**, so a default would quietly make a bot
  the 负责人 of every plan the CLI creates.
- **A plan type carries no `kind`, so the CLI cannot classify it.** Iteration and release types also
  need `sprint_id` / `version_id` (and the `project_id` those make mandatory), but the plan-type
  resource exposes only `id` / `name` / `url` / `library` — and tenants rename these, so the name is
  not a safe discriminator. `plans create` sends what you gave it and surfaces the **server's**
  refusal for a type that needs more. Use the plain (普通) type unless you know the tenant's setup.
- **A library can be created but never deleted.** `--identifier` is unique across the organisation
  and the server enforces it. There is **no library DELETE**; a library PATCH *does* exist upstream
  and is reachable generically —
  `pingcode api PATCH /v1/testhub/libraries/<id> --set description="…"` — but it cannot clear a
  field, so name a library right the first time. The CLI prints that warning after every create.
- **Still not exposed, on purpose:** library members, case-module (suite) writes, plan **delete**,
  configuration writes, and `PUT /runs/{id}` (documented to blank the executor when the field is
  omitted — unverified, and `runs update` covers the same ground safely). All are reachable through
  `pingcode api` if you really need them.

### SCM, build and release caveats

These three groups are the DevOps **write-back** surface: a CI/CD job tells PingCode what happened,
and PingCode links it to work items. None of them reads your git server or your pipeline.
[`modules/scm.md`](skills/pingcode/modules/scm.md) and
[`modules/cicd.md`](skills/pingcode/modules/cicd.md) are the full versions.

- **All 企业令牌 only**, which is exactly what `client_credentials` yields — but under three
  *separate* scopes (`devops:code`, `devops:build`, `devops:deploy`). A token that can write commits
  cannot write builds, and the only symptom is exit 4.
- **`/v1/scm/products` is a hosting platform (托管平台), not a ship product.** Every scm command
  except the commit family starts by resolving a platform; commits are organisation-level.
- **A "platform user" is a git author identity, not a PingCode member** — it carries no `user_id`,
  and naming an unknown one on a write **creates** it. Since scm has **no DELETE anywhere** except
  branches, a typo in `--sender` or `--creator` is a permanent row.
- **`full_name` (`owner/name`) is a repository's unique key**, and `?name=` is ignored upstream —
  hence `scm repo list --full-name`, an exact filter.
- **`build list` has no filters at all** (five plausible ones were probed live and silently ignored),
  and a build `identifier` is not unique, so it is not a lookup key either.
- **`release deploy list` hides an unknown environment behind an empty list**, so an empty result is
  not evidence the environment exists. Resolve it first.
- **Work items are linked by `--work-item <identifier>`** (`PLM-1`), not by id, and an unknown
  identifier is **silently dropped** by the API under a 200.

---

## The `pingcode` skill

`skills/pingcode/` is the source of truth for the agent-facing docs. It is layered the same way this
README now is: `SKILL.md` carries only what does not scale with the surface — the authentication
gate, the `--json` / `--dry-run` contracts, the exit-code table, the escape hatches and a map — and
one file per module carries that module's flags and traps:

| File | Covers |
|---|---|
| [`modules/pjm.md`](skills/pingcode/modules/pjm.md) | projects, work items, sprints, releases, members |
| [`modules/ship.md`](skills/pingcode/modules/ship.md) | products, ideas, tickets, requirement schedules |
| [`modules/testhub.md`](skills/pingcode/modules/testhub.md) | libraries, cases, plans, runs |
| [`modules/scm.md`](skills/pingcode/modules/scm.md) | platforms, git identities, repos, branches, commits, refs, PRs, reviews |
| [`modules/cicd.md`](skills/pingcode/modules/cicd.md) | build records, environments, deployments |
| [`modules/crosscutting.md`](skills/pingcode/modules/crosscutting.md) | relations, comments, attachments, activities and their five mounts |
| [`modules/api.md`](skills/pingcode/modules/api.md) | the generic executor and `api list` / `api describe` |

`test/help/skill.test.ts` asserts that **every `pingcode …` path mentioned in any of those files
resolves in the real commander tree**, so a documented command that does not exist fails the suite.
The reverse is deliberately *not* asserted: at 254 leaves, requiring every leaf to be documented
would make the docs a merge point for every parallel change. Sync them to your agent skill
directories:

```bash
npm run skill:install -- --dry-run              # show the destinations, write nothing
npm run skill:install                           # pick a target (prompts on a TTY, else installs both)
npm run skill:install -- --target claude        # Claude Code only
npm run skill:install -- --target opencode      # OpenCode only
npm run skill:install -- --target claude,opencode   # or --target all
npm run skill:install -- --force                # overwrite existing copies
```

Installs are **global (user-level)** only, and copy the `modules/` directory alongside `SKILL.md`:

| Target | Destination |
| --- | --- |
| `claude` | `~/.claude/skills/pingcode/SKILL.md` |
| `opencode` | `$XDG_CONFIG_HOME/opencode/skills/pingcode/SKILL.md` (default `~/.config/opencode/…`) |

`--target` is repeatable, comma-separated and case-insensitive. With no `--target` the script
prompts when stdin is a TTY (prompt on stderr, `q` aborts without writing) and installs **both**
targets when it isn't, so CI and pipes keep their old behaviour. An unknown target exits `2`.

---

## CI/CD

Three GitHub Actions workflows, all dependency-free: every gate is an npm script you can run
locally with the identical command, so a red run never needs a "push and see" loop.

**`.github/workflows/ci.yml`** — on every push to `main` and every pull request. Superseded runs
for the same ref are cancelled.

| Job | What it does |
| --- | --- |
| `node 20` / `node 22` / `node 24` | `npm ci` → `typecheck` → `test` → `build` → run the built bundle's `--version` and `--help` → `skill:install --dry-run` |
| `secret scan and commit gate` | `scan:secrets` and `check:commits` over the pushed/PR commit range, once per run |

**`.github/workflows/catalog-check.yml`** — a **weekly** (Mondays 03:17 UTC) and on-demand watch that
diffs the vendored endpoint catalog against the live apiDoc bundle. It is deliberately **not** a PR
gate: it depends on a third-party host, and an upstream documentation edit has nothing to do with
whichever pull request happens to be open when it lands. On drift it files or refreshes a **single**
`catalog-drift` issue and stays green; it closes that issue when upstream matches again, and fails
only when the check itself could not run. What to do with the issue is
[`.trellis/spec/backend/catalog-drift.md`](.trellis/spec/backend/catalog-drift.md) — in particular,
live behaviour outranks the catalog, and a command is never deleted because an endpoint vanished for
one cycle.

Permissions are `contents: read` at workflow level; the release job and the drift watch each elevate
exactly one scope. No secrets are used or needed — the test suite injects `fetch` and never opens a
socket, and there are no PingCode credentials in CI.

Run the same gates locally:

```bash
npm run typecheck && npm test && npm run build
node dist/bin/pingcode.js --version && node dist/bin/pingcode.js --help
npm run skill:install -- --dry-run

npm run catalog:check                        # diff the vendored catalog against the live docs
npm run scan:secrets                        # tracked files
npm run scan:secrets -- origin/main..HEAD    # + those commit messages
npm run check:commits                        # whole history
npm run check:commits -- origin/main..HEAD   # just your branch
npm run check:commits -- --file .git/COMMIT_EDITMSG   # one message file (what the hook runs)
```

`scan:secrets` (`scripts/scan-secrets.ts`) looks for `client_secret=…` assignments,
`PINGCODE_CLIENT_ID` / `PINGCODE_CLIENT_SECRET` assignments with a real-looking value, `Bearer`
token literals, and tenant hosts (a `*.pingcode.com` subdomain containing a digit). The patterns
are deliberately keyword-anchored: a generic "hex id" rule would match every git sha and every
work-item id. Documented placeholders are ignored, and a line carrying `scan-secrets:allow` is
never reported.

`check:commits` (`scripts/check-commits.ts`) enforces
[`.trellis/spec/guides/commit-conventions.md`](.trellis/spec/guides/commit-conventions.md): the
`type(scope): subject` shape, the type table, a lowercase non-empty subject with no trailing period
and at most 72 characters. Merge commits are exempt, and on a pull request the PR title is checked
too because a squash merge turns it into the commit subject.

> **Node version note.** `skill:install`, `scan:secrets` and `check:commits` are TypeScript run
> through `node --experimental-strip-types`, which exists from Node **22.6** only. On the Node 20
> matrix leg the `skill:install --dry-run` step is therefore skipped, and the hygiene job runs on
> Node 24. `engines` still says `>=20` because the *published bundle* is built for Node 20 and is
> smoke-tested there; the restriction is on the repository's own scripts, not on the CLI.

### Git hooks

Native git hooks in [`.githooks/`](.githooks), pointed at by `core.hooksPath`. `npm install` wires
them up through `prepare`; to do it by hand:

```bash
npm run hooks:install     # git config core.hooksPath .githooks
```

| Stage | What it runs |
| --- | --- |
| `pre-commit` | `npm run scan:secrets`, `npm run typecheck` |
| `commit-msg` | `npm run check:commits -- --file "$1"` |
| `pre-push` | `npm test`, `npm run build`, then the built bundle's `--version` and `--help` |

**A hook only ever runs a command CI also runs.** No rule lives in a hook alone, so `git commit
--no-verify` / `git push --no-verify` *defers* feedback to CI rather than skipping a check — which is
exactly what you want when you are mid-thought and the fix is one commit away. The split follows how
expensive a mistake is to undo: a leaked credential is the only irreversible one here (the
`client_secret` travels in a query string, and history already needed one sanitisation pass), so the
secret scan sits in the cheapest, most frequent gate. `check:commits` gained a `--file` mode for the
hook, because in CI it can only look at commits that already exist — a bad message is found after the
commit is written and the fix is a rebase, whereas `commit-msg` catches it before the commit is born.
The slow suite waits for `pre-push`, the point at which code starts reaching other people.

> **Caveat worth knowing: `pre-commit` validates the working tree, not the staged snapshot.** With
> unstaged changes present, `typecheck` and `scan:secrets` check something other than what is being
> committed. Stashing around the hook (`git stash --keep-index`) would fix that and is deliberately
> *not* implemented: an interrupted hook can then lose work, and a documented limitation beats an
> unexplainable failure mode. `scan:secrets` does enumerate `git ls-files`, so newly staged files are
> included — it just reads their contents from disk. CI has the last word either way.

The installer (`scripts/install-hooks.mjs`) no-ops when `CI` is set or when it is not inside a git
work tree, so it can never fail an install. It is plain `.mjs` rather than `.ts` like everything else
in `scripts/` for one reason: `prepare` runs during `npm ci`, including on the Node 20 leg, where
`--experimental-strip-types` does not exist.

**`.github/workflows/release.yml`** — on tags matching `v*`. To cut a release:

```bash
# 1. bump the version in package.json (src/version.ts is asserted to match by test/version.test.ts)
# 2. commit it, and make sure main is green
git tag -a v0.2.0 -m 'v0.2.0'
git push origin v0.2.0
```

The job first asserts `v<version>` equals `package.json`'s version and fails immediately on a
mismatch, then re-runs typecheck/test/build plus the binary smoke on Node 20, `npm pack`s the
tarball, and creates a GitHub Release with auto-generated notes and the tarball attached. It does
**not** push to the npm registry: the package name is unclaimed, so that stays a non-goal.

---

## Security notes

- Credentials and token live in `~/.pingcode/config.json` (mode `0600`), never in the repository.
- The `client_secret` travels in the **URL query string** on the token endpoint, so every printable
  URL — `--verbose` logs, dry-run plans, error messages, body snippets — goes through `redactUrl()`.
  `Authorization` headers and `access_token` / `client_secret` JSON values are masked too.
- `--verbose` prints request URLs with the full `client_id` visible, while `auth status` shows it
  masked (`abcd…wxyz`). That asymmetry is intentional: the `client_id` is an identifier, not a
  secret — only the `client_secret` and the access token are, and both are redacted everywhere.

---

## Known limitations / follow-ups

Recorded rather than forgotten. Three items that used to sit here are **done** and have been
retired: codegen from the apiDoc bundle (there is now a vendored 459-entry catalog, a generator and a
weekly drift watch), `POST /v1/pjm/work_items/search` (wired and live-verified — six flags switch
`project work-item list` to it), and bulk `PATCH /v1/pjm/work_items` (`project work-item bulk-update`).

- **Ergonomics is 158 of 459, and that is a backlog rather than a bug.** 301 endpoints are reachable
  only through `pingcode api`. The gap is largest in `pjm` configuration (schemes and boards),
  `directory` (departments, groups, roles, jobs) and `wiki` (0 of 19, by decision). Nothing is
  *unreachable* because of it; see [Coverage](#coverage-reach-vs-ergonomics).
- **7 endpoints cannot be reached at all**: `/v1/myself`, `/v1/permission/my/*` and
  `/v1/permission/check/*` need a *user* token, i.e. the OAuth2 authorization-code flow, which is not
  implemented. They are refused before any request with an explanation. `GET /v1/permission/points`,
  which looks like it belongs to that set, does work.
- **File attachments cannot be uploaded.** `POST /v1/attachments` has two documented forms: JSON for
  a code snippet and `multipart/form-data` for a real file. Only the snippet form exists, by name
  (`<entity> attachment add-snippet`) and generically (`pingcode api POST /v1/attachments`), because
  a multipart body needs a change to the frozen transport layer that this work was not allowed to
  make. So the *path* is reachable but the *file* form is not expressible in either layer — the one
  place where "459 / 459" is about endpoints rather than about every documented request shape.
- **Keychain storage.** Credentials sit in a `0600` file; an OS keychain (Keychain Access,
  libsecret, DPAPI) would be stronger.
- **`--json` drops `null` and `""` fields.** `api/parse.ts` normalises both to `undefined`, so they
  vanish from the output; an absent key currently means "null, empty, or genuinely missing". `null`
  → absent is defensible, `""` → absent is not (an empty string is a value someone chose). The fix
  — preserve both and reserve `undefined` for genuinely missing — is a **breaking output change**
  and wants its own commit before there are consumers. Note this applies to refined commands only:
  `pingcode api` passes the API's JSON through untouched.
- **`state_flows` pre-validation — tried on ship, and deliberately rolled back.** Reading the state
  flow up front to reject illegal transitions locally sounds better than it is: live evidence
  (`08-01-ship-cli/research/s7-smoke.md` F5) showed the server refuses atomically anyway, so
  nothing is saved, while plan discovery is a scan, depends on an optional scope, and can
  mis-identify the plan — turning a legal move into a terminal local refusal with no override. Ship
  now reads the flows only to *explain* a refusal and to answer `--dry-run`. If pjm ever grows the
  same feature, it should be advisory in the same way.
- **Self-hosted `--host` verification.** The `<host>/open` derivation is unit-tested only; it has
  never been exercised against a real self-hosted instance.
- **429 and 403 paths are unit-tested only.** Provoking a real 429 means ~200 requests/minute
  against a production org, and the token used for the live verification was org-admin-scoped, so
  nothing ever denied it with a 403.
- **Smoke data cannot be cleaned up.** Ship exposes no DELETE at all, and neither do projects,
  sprints or test libraries, so anything created while verifying against a live tenant is permanent.
  Prefix it before you create it.

Requirements, design and the live-API findings live under `.trellis/tasks/` — the original MVP in
`07-31-pingcode-cli-mvp/` (`prd.md`, `design.md`, `research/pingcode-api.md`, `research/s8-smoke.md`)
and the full-coverage work in `08-02-full-api-coverage/`, whose `research/open-api-surface-460.md` is
the endpoint-by-endpoint map of all 459 and whose `design.md` records every live finding per module.
