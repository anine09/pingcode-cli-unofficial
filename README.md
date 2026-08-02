# pingcode-cli

[![CI](https://github.com/anine09/pingcode-cli-unofficial/actions/workflows/ci.yml/badge.svg)](https://github.com/anine09/pingcode-cli-unofficial/actions/workflows/ci.yml)

A command-line client for the [PingCode Open API](https://open.pingcode.com/), plus a single
`pingcode` skill that teaches AI agents how to drive it.

Scope: **projects and work items, ship products/ideas/tickets, testhub libraries/cases/plans/runs,
and the scoped metadata you need to write one.** Wiki, Flow, Insight and the org chart (beyond a
member lookup) are deliberately not covered.

---

## Install

Requires **Node.js >= 20**. The package is not published; build it from a checkout.

```bash
npm install
npm run build            # → dist/bin/pingcode.js
node dist/bin/pingcode.js --help
```

To get `pingcode` on your `PATH`:

```bash
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
3. Grant these scopes — the first four are required by the MVP command surface:

   | Scope | Needed for |
   |---|---|
   | `pcp:read:pjm:project` | `project list` / `project get`, and every project-name lookup |
   | `pcp:read:pjm:workitem` | `project work-item list` / `get`, `project meta types` / `states` / `priorities` |
   | `pcp:write:pjm:workitem` | `project work-item create` / `update` / `transition` |
   | `pcp:read:global:team` | `settings users` |
   | `pcp:read:pjm:sprint` | optional — only `project meta sprints` |
   | `pcp:read:ship:product` | `product list` / `get`, `product meta members`, and every product-name lookup |
   | `pcp:read:ship:idea` | `product idea list` / `get`, `product meta idea-states` / `idea-priorities` / `idea-suites` / `idea-properties` |
   | `pcp:write:ship:idea` | `product idea create` / `update` |
   | `pcp:read:ship:ticket` | `product ticket list` / `get`, `product meta ticket-states` / `ticket-priorities` / `ticket-types` / `ticket-channels` / `ticket-properties` |
   | `pcp:write:ship:ticket` | `product ticket create` / `update` / `transition` |
   | `pcp:read:ship:configuration` | optional — only the state-plan pre-check in `product ticket transition`; without it the CLI warns and lets the server judge |
   | `pcp:read:testhub:library` | `testhub libraries list` / `get`, `testhub meta suites`, and the case-module (模块) tree behind `--suite` |
   | `pcp:write:testhub:library` | `testhub libraries create` — grant it only if you mean to create libraries; they cannot be deleted |
   | `pcp:read:testhub:testcase` | `testhub cases list` / `get`, `testhub meta case-types` |
   | `pcp:write:testhub:testcase` | `testhub cases create` / `update` |
   | `pcp:read:testhub:testplan` | `testhub plans list` / `get`, `testhub meta plan-types`, `testhub runs list` |
   | `pcp:write:testhub:testplan` | `testhub plans create`, `testhub runs patch` / `bulk` |
   | `pcp:read:testhub:configuration` | **not optional** — `testhub meta case-states` / `run-statuses` / `important-levels`, i.e. every `state_id`, `status_id` and `important_level_id` |

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

## Command surface

The top level mirrors PingCode's own GUI modules: each business module owns its resources *and* its
id lookups, so one `--help` shows a module's whole surface.

```
pingcode auth      login | status | logout

# ship (产品管理)
pingcode product   list | get <product>
pingcode product idea    list | get <ref> | create | update <ref>
pingcode product ticket  list | get <ref> | create | update <ref> | transition <ref>
pingcode product meta    idea-states | idea-priorities | idea-suites | idea-properties | members
                         ticket-states | ticket-priorities | ticket-types | ticket-channels
                         ticket-properties

# pjm (敏捷项目管理)
pingcode project   list | get <project>
pingcode project work-item  list | get <ref> | create | update <ref> | transition <ref>
pingcode project meta       types | states | priorities | sprints

# testhub (测试管理)
pingcode testhub libraries  list | get <library> | create
pingcode testhub cases      list | get <ref> | create | update <ref>
pingcode testhub plans      list | get <ref> | create
pingcode testhub runs       list | patch <run> | bulk
pingcode testhub meta       case-states | case-types | important-levels | run-statuses
                            plan-types | suites

# 后台设置
pingcode settings  users
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
  --type 普通测试 --start 2026-08-10 --end 2026-08-31 --assignee 张三 --dry-run --json

pingcode testhub runs list --library LIB --plan "2026 S1 回归" --json
pingcode testhub runs patch 7hK2mQ9x --status 通过 --remark "retested on iOS" --json
pingcode testhub runs bulk --library LIB --plan "2026 S1 回归" --remove-run 7hK2mQ9x --json
```

`--dry-run` on a mutating command prints the request it *would* have sent and exits 0 without
sending it. Read requests still run, so ids are genuinely resolved first.

---

## The `--json` contract

- **stdout carries JSON only.** Tables, logs, warnings, dry-run notes and errors go to stderr.
- Timestamps stay raw **unix seconds** in `--json`; human mode renders local time.
- Three list shapes, by command family:
  - one page of `project list` / `project work-item list` / `product list` / `product idea list` /
    `product ticket list` / `testhub libraries list` / `testhub cases list` / `testhub plans list` /
    `testhub runs list` → `{"page_index":0,"page_size":30,"total":123,"values":[…]}`
  - any list with `--all` → `{"values":[…],"count":42,"all":true}`
  - every `meta` lookup (`product meta …`, `project meta …`, `testhub meta …`, `settings users`) → `{"values":[…],"count":20}`
- Single-resource commands (`get`, `create`, `update`, `transition`) print the resource object.
- `--dry-run` prints `{"dry_run":true,"request":{"method":…,"url":…,"headers":…,"body":…}}` — with
  `Authorization` and any `client_secret` masked.
- Errors print to **stderr** as `{"error":{"kind":…,"message":…,"code":…,"exit":…}}`.

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

This API answers **HTTP 400 where REST convention would use 401 or 404**, so five observed API
`code` values are mapped by code rather than by status (`src/core/wire.ts`):

| API `code` | HTTP | Observed on | → exit |
|---|---|---|---|
| `100024` | 400 | `GET /v1/auth/token` with a wrong client id/secret | 3 (`auth`) |
| `100317` | 400 | `GET /v1/pjm/work_items/{unknown id}` | 5 (`not_found`) |
| `100303` | 400 | `PATCH` with an unknown `state_id` | 5 (`not_found`) |
| `100725` | 400 | `GET /v1/ship/ideas/{unknown id}` | 5 (`not_found`) |
| `100711` | 400 | `GET /v1/ship/tickets/{unknown id}` | 5 (`not_found`) |

Any other code keeps the status-first mapping and is surfaced verbatim on exit 7 — read `code`
before drawing conclusions. (An invalid *bearer* token on a resource endpoint does return a real
401, so the 401 branch is still live.) Note what is deliberately **absent**: ship's `100719` /
`100702` ("state does not exist") also fire for a state that exists but is unreachable under the
state plan, so mapping them to `not_found` would be a lie — they stay on exit 7.

---

## Caveats that matter in practice

- **Ids are project-scoped — run the module`s `meta` lookups first.** The same state name has a different id
  in another project. System work-item types are bare slugs (`task`, `story`, `bug`); custom types,
  states and priorities are 24-hex ids; users are 32-hex. Never reuse an id across projects.
- **`--state <name>` always needs `--type`.** States live in a `(project, work item type)` pair and
  the API never reports a work item's type, so the CLI cannot infer it — not on `list`, and not on
  `update`/`transition` (`create` already requires `--type`). Pass `--type <name|id>`, or skip the
  lookup with `--state-id <id>`. On `update`/`transition`, `--type` is *only* a lookup aid: it is
  never written to the work item. `--state` and `--state-id` are mutually exclusive.
- **`update` replaces, it does not merge.** Every field you pass overwrites the stored value, and
  arrays plus `properties` objects are replaced wholesale. Read the item first if you need to keep
  anything. There is no way to clear a field, and an update with no fields is exit 2, not a no-op.
- **State changes are workflow-validated server-side.** On rejection the CLI prints the server
  message plus the states configured for that type — but only if you passed `--type`.
- **`--all` is best effort, not a snapshot.** It walks 0-based pages (`page_size` ≤ 100),
  de-duplicates by id, stops at `--limit` (default 500) and bails if the server stops honouring
  `page_index`. **No endpoint supports sorting**, so offset paging over changing data can duplicate
  or skip rows. Sort what you collected yourself.
- **Rate limit: 200 requests/minute per token.** 2xx responses carry no rate-limit headers, so the
  budget is invisible until a 429 arrives. Prefer one `--page-size 100` call over many small ones,
  and let the cache work.
- **Timestamps are unix seconds everywhere.** `--start-at` / `--end-at` accept `1730000000` or
  `2026-01-31` (parsed as UTC midnight).
- **Metadata is cached for 24 h** under `~/.pingcode/cache/` (mode `0600`, hashed filenames), keyed
  by `(apiBase, clientId, parentId, kind)` — the parent being a project for pjm, a **product**
  for ship and a **test library** for testhub. Pass `--no-cache` if a project, product or library
  was reconfigured and an id looks stale; a
  write rejected on a cached id invalidates that entry and retries once. `auth login` and
  `auth logout` both clear the cache.

### Ship-specific caveats

Everything above still applies. These are the differences that will cost you time:

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
- **Identifiers and `short_id`s are not lookup keys.** `SLC-1` is resolved through `search` plus an
  exact client-side match; a pasted URL ends in a `short_id` that no endpoint accepts, so prefer an
  id or an identifier.
- **`--suite` filtering on `product idea list` is undocumented** — the API lists `suite.id` as neither
  filterable nor unfilterable, so an empty result proves nothing. The CLI warns when you use it.
- **`ticket.channel` is an object or the bare string `"internal"`**, and `--channel` can only be set
  at create time. Tags cannot be written at all, and a ticket's `submitter_id` is silently ignored
  under a client-credentials token — neither is exposed.

### Testhub-specific caveats

Everything above still applies. Testhub's parent scope is a **test library**, and its write path is
the sharpest in the CLI:

- **A test library is testhub's project.** `state_id`, `type_id`, `status_id`, `suite_id` and the
  plan list are all library-scoped — two libraries never share a state, type or status id, even when
  the names match. `testhub cases list`, `plans list`, `plans get`, `plans create`, `runs bulk` and
  the five library-scoped `meta` leaves (`case-states`, `case-types`, `run-statuses`, `plan-types`,
  `suites`) require `--library <name|id>` (exit 2 without it). `cases get`, `cases update` and
  `runs patch` read the resource first and inherit its library; `runs list` needs one only to
  resolve `--plan` / `--status` by name. `libraries create` is the one testhub leaf with no parent.
- **`cases list` and `runs list` are `POST …/search`.** The plain `GET` lists are never used —
  unfiltered, `GET /v1/testhub/cases` scans every library the token can see. Same DSL limits as
  ship: one operator per field, no `$and`/`$or`, no sorting.
- **`--step` is all-or-nothing, because `steps[]` replaces.** A run's step array is overwritten
  wholesale and a step sent without its `step_id` is re-created with a new id, orphaning its
  history. Re-emitting an untouched step is impossible: a run step reports a status **slug** while
  the write needs a status **id**, and only the localized (renameable) name joins them. So the CLI
  refuses a partial step edit and prints the full list of step ids. `--set` / `properties` on a case
  replace wholesale too.
- **`runs patch` always sends `status_id`, and carries the executor over.** `status_id` is required
  by the API even on PATCH, so the CLI pre-reads the run and re-sends its current result — and its
  current executor — when you do not name one. If the run has no executor and you name none,
  `executor_id` is omitted and the CLI warns that the run stays unassigned (omitting it is a
  verified no-op on PATCH: it neither clears the field nor reassigns the run). With no recorded
  result at all it asks for `--status` (exit 2) rather than sending a half-formed body.
- **`runs bulk` is the only way to delete a run** — and the only way to add one. `--add-case`,
  `--set-status` and `--remove-run` are each capped at **50** entries per call (checked locally),
  and the response is **counts only**: re-list the plan to see the new run ids.
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
- **`short_id` is read-only.** Reads accept an id or a `short_id`; every write documents `id` only,
  so `cases update` and `runs patch` resolve it through a pre-read.
- **Two gaps.** There is no `--maintenance` flag (no filtering cases by maintainer), and `--set`
  keys have no discovery command in this version — testhub's case-property lookup is outside the
  implemented endpoint set, so read the keys off an existing case with `cases get <case> --json`.
  Select-typed values are option ids, not labels.
- **`--start` / `--end` on `plans create`: the end date is inclusive.** Both flags take either a
  zero-padded `YYYY-MM-DD` or a 10-digit unix **seconds** integer. A calendar date resolves to
  **00:00:00 local** for `--start` and **23:59:59 local** for `--end`; a raw integer is passed
  through **verbatim** on both, with no end-of-day adjustment. The asymmetry is deliberate — a range
  runs *through* its end date, and mapping both ends to midnight would silently shorten every plan
  by a day, which no smoke run would catch because the CLI echoes back what it sent. Local rather
  than UTC so that `plans get` agrees with the `plans create` that produced it. Rejected with exit 2
  **before any request**: an unpadded `2026-8-1`, slashes, an ISO string carrying a time, a 13-digit
  milliseconds value, and an impossible date like `2026-02-30` (which JS would roll into March).
  `--end` before `--start` is refused client-side, printing both resolved unix values.
- **`plans create` requires all five fields and `--assignee` has no default.** `--library`,
  `--name` (unique within the library), `--type`, `--start`, `--end`, `--assignee`. There is no
  "assign to me" because a client-credentials token acts as the **bot user**, so a default would
  quietly make a bot the 负责人 of every plan the CLI creates.
- **A plan type carries no `kind`, so the CLI cannot classify it.** Iteration and release types also
  need `sprint_id` / `version_id` (and the `project_id` those make mandatory), but the plan-type
  resource exposes only `id` / `name` / `url` / `library` — and tenants rename these, so the name is
  not a safe discriminator. `plans create` sends the five fields and surfaces the **server's**
  refusal for a type that needs more; it does not warn locally. Use the plain (普通) type unless you
  know the tenant's configuration.
- **A library can be created but never updated or deleted.** `--identifier` is unique across the
  organisation and the server enforces it (no client-side probe: it would race and double the
  request count). Testhub publishes neither a library DELETE nor a library PATCH, so name it right
  the first time — the CLI prints that warning on stderr after every create.
- **Not exposed on purpose:** case deletion (irreversible), library **update** and the member
  endpoints, case-module (suite) writes, plan **update**/**delete**, `POST /v1/testhub/runs` and
  `PUT /runs/{id}` (documented to blank the executor when the field is omitted — unverified and
  untested), configuration writes, and the history reads. Library and plan *creation* are covered,
  which is what lets the CLI bootstrap its own fixtures.


---

## The `pingcode` skill

`skills/pingcode/SKILL.md` is the source of truth for the agent-facing docs, and `test/help.test.ts`
asserts that every command path it mentions exists in the CLI. Sync it to your agent skill
directories:

```bash
npm run skill:install -- --dry-run              # show the destinations, write nothing
npm run skill:install                           # pick a target (prompts on a TTY, else installs both)
npm run skill:install -- --target claude        # Claude Code only
npm run skill:install -- --target opencode      # OpenCode only
npm run skill:install -- --target claude,opencode   # or --target all
npm run skill:install -- --force                # overwrite existing copies
```

Installs are **global (user-level)** only:

| Target | Destination |
| --- | --- |
| `claude` | `~/.claude/skills/pingcode/SKILL.md` |
| `opencode` | `$XDG_CONFIG_HOME/opencode/skills/pingcode/SKILL.md` (default `~/.config/opencode/…`) |

`--target` is repeatable, comma-separated and case-insensitive. With no `--target` the script
prompts when stdin is a TTY (prompt on stderr, `q` aborts without writing) and installs **both**
targets when it isn't, so CI and pipes keep their old behaviour. An unknown target exits `2`.

---

## CI/CD

Two GitHub Actions workflows, both dependency-free: every gate is an npm script you can run
locally with the identical command, so a red run never needs a "push and see" loop.

**`.github/workflows/ci.yml`** — on every push to `main` and every pull request. Superseded runs
for the same ref are cancelled.

| Job | What it does |
| --- | --- |
| `node 20` / `node 22` / `node 24` | `npm ci` → `typecheck` → `test` → `build` → run the built bundle's `--version` and `--help` → `skill:install --dry-run` |
| `secret scan and commit gate` | `scan:secrets` and `check:commits` over the pushed/PR commit range, once per run |

Permissions are `contents: read` at workflow level; only the release job elevates. No secrets are
used or needed — the test suite injects `fetch` and never opens a socket, and there are no PingCode
credentials in CI.

Run the same gates locally:

```bash
npm run typecheck && npm test && npm run build
node dist/bin/pingcode.js --version && node dist/bin/pingcode.js --help
npm run skill:install -- --dry-run

npm run scan:secrets                        # tracked files
npm run scan:secrets -- origin/main..HEAD    # + those commit messages
npm run check:commits                        # whole history
npm run check:commits -- origin/main..HEAD   # just your branch
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

Deliberately out of the MVP, recorded rather than forgotten:

- **Keychain storage.** Credentials sit in a `0600` file; an OS keychain (Keychain Access,
  libsecret, DPAPI) would be stronger.
- **Codegen from `api_data.json`.** PingCode publishes no OpenAPI spec, but its apiDoc source at
  `https://open.pingcode.com/api_data.json` describes 460 endpoints. The MVP hand-writes types for
  its ~15; generating them would remove the drift risk.
- **`state_flows` pre-validation — tried on ship, and deliberately rolled back.** Reading the state
  flow up front to reject illegal transitions locally sounds better than it is: live evidence
  (`08-01-ship-cli/research/s7-smoke.md` F5) showed the server refuses atomically anyway, so
  nothing is saved, while plan discovery is a scan, depends on an optional scope, and can
  mis-identify the plan — turning a legal move into a terminal local refusal with no override. Ship
  now reads the flows only to *explain* a refusal and to answer `--dry-run`. If pjm ever grows the
  same feature, it should be advisory in the same way.
- **`--json` drops `null` and `""` fields.** `api/parse.ts` normalises both to `undefined`, so they
  vanish from the output; an absent key currently means "null, empty, or genuinely missing". `null`
  → absent is defensible, `""` → absent is not (an empty string is a value someone chose). The fix
  — preserve both and reserve `undefined` for genuinely missing — is a **breaking output change**
  and wants its own commit before there are consumers.
- **`POST /v1/pjm/work_items/search`.** The advanced filter/search endpoint is unused, so complex
  queries (multi-value filters, keyword scoring) are not expressible.
- **Bulk `PATCH /v1/pjm/work_items`.** One-field-across-≤100-items updates are not wired up.
- **Self-hosted `--host` verification.** The `<host>/open` derivation is unit-tested only; it has
  never been exercised against a real self-hosted instance.
- **429 and 403 paths are unit-tested only.** Provoking a real 429 means ~200 requests/minute
  against a production org, and the MVP token is org-admin-scoped so nothing denied it with a 403.

Requirements, design and the live-API findings live in
`.trellis/tasks/07-31-pingcode-cli-mvp/` (`prd.md`, `design.md`, `research/pingcode-api.md`,
`research/s8-smoke.md`).
