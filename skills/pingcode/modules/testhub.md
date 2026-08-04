# 测试管理 (testhub) — `testhub`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the testhub command surface plus the testhub-specific traps.

### Test libraries 测试库 — `testhub libraries`

A **test library** is testhub's parent scope, the way a product is ship's. Resolve it first: case
states, case types, run results, the module tree and the plan list are **all library-scoped**.

```bash
pingcode testhub libraries list --json
pingcode testhub libraries list --keywords payment --json
pingcode testhub libraries get LIB --json        # name, identifier such as LIB, or id
pingcode testhub libraries create --name "Payments" --identifier PAY --json
```

`--keywords` searches library **names** only — the identifier is not searchable server-side. The
`--identifier` given to `create` must be unique across the organisation and the server enforces it,
and `--name` is capped at **32 characters** (verified live 2026-08-02: a longer name is rejected with
code `100019`, exit 7).
There is no `libraries update` and no `libraries delete` leaf, for **two different reasons**: the
API publishes no library DELETE at all, so a library created here is permanent — while a library
PATCH *does* exist upstream and is simply not wrapped:

```bash
pingcode api PATCH /v1/testhub/libraries/<id> --set description="…"   # works (verified live)
```

Note that a `PATCH` with `description: ""` answers 200 and **keeps the old value** (verified live
2026-08-04): this API has no way to clear that field.

### `testhub meta` — the ids a testhub write cannot be built without

```bash
pingcode testhub meta case-states       --library LIB --json   # --state / state_id
pingcode testhub meta case-types        --library LIB --json   # --type / type_id
pingcode testhub meta run-statuses      --library LIB --json   # --status / status_id
pingcode testhub meta plan-types        --library LIB --json   # --type on `plans create`
pingcode testhub meta suites            --library LIB --json   # --suite; PATH is what --suite takes
pingcode testhub meta important-levels  --json                 # --important-level; org-wide
pingcode testhub meta plan-states       --json                 # --state on `plans update`; org-wide
pingcode testhub meta case-properties   --library LIB --json   # the field keys behind --set
```

`important-levels` and `plan-states` are the two lookups with **no per-library variant**, so both
*refuse* `--library` with exit 2 rather than ignoring it (the flag is hidden from `--help`, which is
why it is spelled out here). The others require `--library`.

**Three different vocabularies answer to the word "state" here, and they are not interchangeable:**

| Command | Vocabulary | Scope | Used by |
|---|---|---|---|
| `meta case-states` | 设计 / 就绪 / 废弃 | per library | `cases update --state`, `cases bulk-update --state` |
| `meta plan-states` | 未开始 / 进行中 / 已完成 | organisation | `plans update --state` |
| `meta run-statuses` | 未测 / 通过 / 失败 / 受阻 / 跳过 | per library | `runs patch --status`, `runs bulk-update --status` |

`case-properties` lists the fields **effective in a library**, and its `KEY` column is what a write
addresses. Read rule 11 before using one with `--set`: on this tenant every row is a *built-in*
field, and pushing a built-in through the properties map either answers HTTP 500 or rewrites the
top-level field of the same name.

`suites` accepts `--parent-id root` for the top level only, or a node id for that node's children.

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

# import many at once, and fix them up in one call afterwards
pingcode testhub cases bulk-create --library LIB --file cases.json --dry-run --json
pingcode testhub cases bulk-create --library LIB --important-level P1 --file cases.json --json
pingcode testhub cases bulk-update --case aB3dEf9h --case-id 5f0e…9200 --library LIB --state 就绪 --json
pingcode testhub cases bulk-update --library LIB --file fixes.json --json

pingcode testhub cases delete aB3dEf9h --yes --json     # ⚠️ deletes the case's RUNS too
pingcode testhub cases history list aB3dEf9h --json     # latest result of every run of this case
```

`cases.json` for `bulk-create` is a JSON array (or `{"cases": [ … ]}`), one object per case:

```json
[{"title": "SSO login", "description": "…", "precondition": "…",
  "type": "功能测试", "important_level": "P1", "maintenance": "wangxiao",
  "steps": [{"description": "open /login", "expected_value": "200"}]}]
```

Names are resolved for you (`type`, `important_level`, `maintenance`, and `state` on
`bulk-update`); every key also has an `_id` twin that is sent verbatim. **`suite`/`suite_id` and
`state`/`state_id` are refused on `bulk-create`** — the API accepts them and lands nothing, so the
CLI stops you instead of letting a 60-case import land in the wrong module. Unknown keys are refused
for the same reason. Up to **100** entries per call.

`testhub cases list` is `POST /v1/testhub/cases/search`; the plain list endpoint is never used
(unfiltered it scans every visible library). `--state` is **PATCH-only**: a case is always created in
the library's initial state, so `cases create` has no `--state`.

### Test plans 测试计划 — `testhub plans`

```bash
pingcode testhub plans list --library LIB --json
pingcode testhub plans list --library LIB --name "2026 S1 回归" --json
pingcode testhub plans get "2026 S1 回归" --library LIB --json    # name, id or short_id
pingcode testhub plans create --library LIB --name "2026 S2 回归" \
  --type 普通 --start 2026-08-10 --end 2026-08-31 --assignee 张三 --json

pingcode testhub plans update "2026 S2 回归" --library LIB --state 进行中 --json
pingcode testhub plans update "2026 S2 回归" --library LIB --summary "42/50 passed, 3 blocked" --json
pingcode testhub plans update "2026 S2 回归" --library LIB --end 2026-09-07 --json
```

`create` takes all five: `--name` (unique within the library), `--type` (from
`testhub meta plan-types`), `--start`, `--end` and `--assignee`.
**Read §4c rule 12 before passing a date** — `--end` lands on 23:59:59, not midnight.

`update` is partial: only the flags you pass are sent. It is the only way to move a plan's state and
the only way to write the test-report `summary`. Three things to know:

- `--state` takes an **organisation-level** plan state (`meta plan-states`), not a case state;
- the dates are stored **verbatim** — unlike a pjm sprint or release window, the server does **not**
  snap them to whole days (verified live 2026-08-04);
- an empty patch is refused locally (exit 2) because the API answers 200 to one and changes nothing,
  and `--summary ""` is refused too: the server rejects an empty summary (`100003`), so a summary can
  be replaced but never cleared.

There is still **no plan delete** — that endpoint does not exist.

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

# add runs and record results without the plan-scoped bulk
pingcode testhub runs create --library LIB --plan "2026 S1 回归" --case aB3dEf9h --executor wangxiao --json
pingcode testhub runs bulk-create --library LIB --plan "2026 S1 回归" --case aB3dEf9h --case-id 5f0e…9200 --json
pingcode testhub runs bulk-update --run 7hK2mQ9x --run-id 5f0e…9200 --library LIB --status 通过 --json
pingcode testhub runs bulk-update --library LIB --file results.json --json

pingcode testhub runs history list 7hK2mQ9x --json          # every result ever recorded
pingcode testhub runs history get 7hK2mQ9x <history-id> --json
```

`results.json` for `bulk-update` is one object per run; `status` (or `status_id`) is **required** on
every entry, and `steps` is refused — use `runs patch --step` for those:

```json
{"runs": [{"run": "7hK2mQ9x", "status": "通过", "remark": "retested"},
          {"run_id": "5f0e…9200", "status_id": "68ff…9bdb"}]}
```

**The two bulk-run halves fail in opposite ways, and this is the single most important thing to know
before scripting them:**

| Command | Endpoint | On a bad entry |
|---|---|---|
| `runs bulk-create` | `POST /v1/testhub/runs/bulk` | **per-element best effort** — HTTP 200, one row per case, failures marked `failure` with a message |
| `runs bulk-update` | `PATCH /v1/testhub/runs/bulk` | **atomic** — one unknown run id rejects the whole batch (`100016`) and nothing is applied |
| `runs bulk` | `POST …/plans/{plan}/runs/bulk` | counts only; a bogus `--add-case` is skipped silently (see rule 16) |

So: read the `STATE` column of `bulk-create`, and trust `bulk-update` to be all-or-nothing. Both cap
at **100** entries per call, checked locally. `runs bulk-update` carries no plan or library in its
URL, so one call can span plans; it cannot delete anything.

`testhub runs bulk` is the **only** way to delete a run, and the only way to add one. Every
name-resolvable flag has an `--x-id` twin (`--status-id`, `--executor-id`, `--plan-id`,
`--library-id`, …) that is sent verbatim with no lookup; the two forms are mutually exclusive.

## 4c. Testhub rules that will bite you

These are on top of §4. Testhub is the same machinery again, with a different parent scope and a
sharper write path.

1. **Resolve the test library first, and never carry an id across libraries.** `state_id`,
   `type_id`, `status_id`, `suite_id` and the plan list are all **library-scoped**: two libraries
   never share a state, type or status id, even when the names are identical. `testhub cases list`,
   `plans list`, `plans get`, `plans create`, `runs bulk` and the five library-scoped `meta` leaves
   (`case-states`, `case-types`, `run-statuses`, `plan-types`, `suites`) all require
   `--library <name|id>` and refuse to guess (exit 2). `cases get`, `cases update` and `runs patch`
   do not: they read the resource first and inherit its library. `runs list` needs one only to
   resolve a `--plan` or `--status` **by name** — `--plan-id` / `--status-id` work without it.
   `libraries create` is the one testhub command with no parent at all.
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
4. **`testhub runs patch` always sends `status_id`, and carries the executor over for you.**
   `status_id` is required by the API even on PATCH, so the CLI reads the run first and re-sends the
   run's current result when you do not name one — patching only a remark is safe here, and would
   not be if you called the API directly. The run's own executor is re-sent the same way. When the
   run has **no** executor and you name none, `executor_id` is omitted from the body and the CLI
   warns on stderr that the run **stays unassigned** — an omitted `executor_id` is a verified no-op
   on PATCH (2026-08-02), it neither clears the field nor reassigns the run. If the run has no
   recorded result at all, the CLI asks for `--status` (exit 2) instead of sending a half-formed
   body.
5. **`pingcode testhub runs bulk` is the only way to delete a run** — there is no `runs delete` and
   no run DELETE endpoint. Each of `--add-case`, `--set-status` and `--remove-run` is capped at
   **50** entries per call (checked locally, exit 2), and the response carries **counts only**,
   never the ids of the runs it created: re-list the plan to see them.
   It is no longer the only way to *add* one: `runs create` and `runs bulk-create` do that and
   report what they created.
   **The caps differ per endpoint, and only some are real.** Verified live 2026-08-04:
   `cases/bulk` (both halves) and `runs/bulk` (both halves) are capped at **100** by the server
   itself — a 101st entry answers `100039` before any field is validated, *including* on the two
   halves whose docs declare no limit. The plan-scoped `…/plans/{plan}/runs/bulk`, by contrast,
   enforces **nothing**: 1001 entries sail past the length gate and `updates[50]` is validated, so
   the documented 50 is not a server rule. The CLI keeps 50 there anyway — an unenforced documented
   limit on an insert/update/delete batch is exactly the shape that silently half-applies — and uses
   the API's own 100 everywhere else, because refusing 51–100 entries the server accepts would be
   the CLI inventing a restriction.
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
11. **`--set` keys now have a discovery command, and it is a warning as much as a lookup.**
    `pingcode testhub meta case-properties --library LIB` lists the fields effective in a library.
    Verified live 2026-08-04, on this tenant **all 8 rows are built-in fields** whose key is the
    field's own name (`state_id`, `description`, `steps`, `type`, `important_level`,
    `maintenance_uid`, `precondition`, `test_type`), and pushing one of them through the properties
    map is worse than useless:
    - `--set important_level=…` → **HTTP 500**;
    - `--set description=x` → **200, and it rewrites the top-level `description`**;
    - a *custom* property that exists organisation-wide but is not in this library's scheme →
      **HTTP 500** as well;
    - a key that exists nowhere → 400, refused rather than dropped.

    So set built-ins with their own flags (`--state`, `--type`, `--important-level`,
    `--description`, `--precondition`) and reserve `--set` for a custom property that appears in
    **that library's** list. Values for select-typed properties are option ids, not labels — the
    same trap as ship. This is also why `pingcode resolve` has **no** `testhub-case-property` kind:
    resolving a name would hand `--set` a key that edits a different field.
    The library-scoped list cannot even tell you which rows are custom (it returns only
    `{id, name, type, options}`); the organisation-level list can, one call away:
    `pingcode api GET /v1/testhub/case_properties`.
    Still missing: there is no `--maintenance` flag anywhere, so cases cannot be filtered by
    maintainer (only *set*, through a bulk entry's `maintenance`).
12. **`--start` and `--end` on `plans create`: the end date is inclusive, and that is asymmetric.**
    Both flags accept either form:
    - `YYYY-MM-DD`, zero-padded. `--start 2026-08-10` becomes **00:00:00 local** on that date;
      `--end 2026-08-31` becomes **23:59:59 local** on it.
    - a **10-digit unix seconds** integer, passed through **verbatim** on both flags — no
      end-of-day adjustment is applied to it. Use this when you want an exact instant.

    The asymmetry is deliberate: a date range means the plan runs *through* the end date, and mapping
    both ends to midnight would silently shorten every plan by a day — an error you would never see,
    because the CLI echoes back exactly what it sent. Local time, not UTC, so that a `plans get`
    agrees with the `plans create` that produced it.

    Everything else is refused with exit 2 **before any request**: an unpadded `2026-8-1`, slashes
    (`08/31/2026`), an ISO string with a time in it, a 13-digit **milliseconds** value, and an
    impossible date such as `2026-02-30` (which JavaScript would otherwise roll silently into
    March). `--end` earlier than `--start` is refused client-side too, and the message prints both
    resolved unix values so you can see which end moved.
13. **`plans create` needs all five fields, and `--assignee` has no default.** `--library`,
    `--name`, `--type`, `--start`, `--end` and `--assignee` are all required. There is deliberately
    no "assign it to me": an enterprise (client-credentials) token acts as the **bot user**, so a
    default would quietly make a bot the owner 负责人 of every plan the CLI creates, and nobody would
    notice until they went looking for whom to ask. Name a real person —
    `pingcode settings users --keywords <name> --json` is the candidate set.
14. **A plan type carries no `kind`, so the CLI cannot tell you which types need more.** Iteration
    and release plan types additionally require `sprint_id` / `version_id` (and the `project_id`
    they make mandatory), but the plan-type resource exposes only `id` / `name` / `url` / `library`
    — there is **no `kind` discriminator**, and guessing from the localized name is not safe because
    tenants rename them. `testhub meta plan-types` therefore lists names only, `plans create` sends
    just the five fields, and if you pick a type that needs more, **the server's refusal is what you
    see** — not a local warning. Pick the plain (普通) type unless you know the tenant's setup.
15. **A library can be created but never updated or deleted.** `--identifier` on
    `testhub libraries create` must be **unique across the organisation** and the server enforces it
    (a duplicate is rejected server-side; the CLI does not pre-check, because a probe would race).
    Testhub publishes **no library DELETE**, so a library created here is permanent: get the name
    and identifier right the first time, and mark throwaway ones (for example `[CLI smoke] …`)
    *before* creating them. The CLI says so on stderr after each create.
    A library **PATCH does exist** upstream, though — this was previously documented the other way
    round and is corrected here (verified live 2026-08-04). It is not wrapped as a leaf, so rename
    or re-describe through the generic layer:
    `pingcode api PATCH /v1/testhub/libraries/<id> --set name="…"`. Note it cannot *clear* a field:
    `description: ""` answers 200 and keeps the old value.
16. **`runs bulk --add-case` ignores a case id that does not exist — silently, at exit 0.** Verified
    live 2026-08-02: a bogus `--add-case` id returns `{"inserts":0,"updates":0,"deletes":0}` and
    succeeds. There is no error and no per-entry report, because the endpoint answers with counts
    only. **Read the counts**, and if they do not match what you asked for, re-list the plan with
    `pingcode testhub runs list --plan <plan> --json` to see what actually landed. A bogus id in
    `--remove-run` does fail loudly (code `100619`, exit 7), so the leniency is specific to inserts.
17. **`testhub cases delete` takes the case's runs with it.** Verified live 2026-08-04: deleting a
    case with a run in a plan removed the run from the plan, and the run id stopped resolving
    (`100603`). The CLI counts the runs before the `--yes` gate and names the number, so the
    confirmation tells you the blast radius rather than just the case title. The case itself is only
    **soft**-deleted — `cases list --include-deleted` still finds it with `is_deleted: 1` — but this
    API publishes no undelete, so treat it as one-way. It is also the only DELETE in the module, and
    the case path is **id-only**: the CLI resolves a `short_id` before sending.
18. **Two "history" reads, two different questions.** `runs history list <run>` is every result ever
    recorded on one run, oldest first — the audit trail a test report needs. `cases history list
    <case>` is one row per **run** of that case, carrying only that run's *latest* result, so its
    row count is the number of runs and not the number of attempts. Each of its rows names the run
    it came from, which is how you drill down. There is no per-case history *detail* path: a row is
    a run-history record, so read it with `runs history get <run> <id>`.
    Both paths are **id-only** (a `short_id` answers 404), so the CLI resolves the reference first.
    A history id that belongs to a different run is reported as a **mismatch** (`100643`, exit 7),
    not as missing; a genuinely unknown history id is exit 5.
    Contrary to the vendor docs, the two endpoints return the **same** item shape — the case side
    carries `executed_status` and `remark` too (verified live 2026-08-04).
19. **A bulk result is auditable; a pjm bulk update is not.** Every entry `runs bulk-update` applies
    appends a row to that run's history, so `runs history list` shows batch-recorded results exactly
    like hand-recorded ones. Do not generalise this from module to module: `project work-item
    bulk-update` appears in no feed at all.
20. **`runs create` refuses a case the plan already contains** (`100605`, exit 7) rather than
    deduplicating, and an omitted `--executor` leaves the run **unassigned** — it is not defaulted
    to the creator. When you are adding several cases and some may already be there, prefer
    `runs bulk-create`: it lands the new ones and reports the duplicates instead of failing the call.

## 5. Deliberately left to `pingcode api`

Reachable, just not as named commands — say that rather than reporting a limitation:

| Left out | Why | Reach it with |
|---|---|---|
| library **members** (4 endpoints) | no command needs library membership: `--executor` and `--assignee` resolve against the organisation directory | `pingcode api GET /v1/testhub/libraries/<id>/members` |
| library **update** | exists upstream and cannot clear a field; renaming a library is rare enough not to earn a leaf (rule 15) | `pingcode api PATCH /v1/testhub/libraries/<id> --set name="…"` |
| case-module (**suite**) writes | the suite tree is read to resolve `--suite`; editing it is a configuration act | `pingcode api list --module testhub --search suites` |
| plan **delete** | no test plan DELETE exists upstream at all | — |
| every configuration **write** (case states, types, property schemes) | tenant configuration, and a wrong write is felt by everyone in the library | `pingcode api list --module testhub --search plans` |
| `PUT /v1/testhub/runs/{run_id}` | full replacement, and documented to blank the executor when the field is omitted — `runs patch` covers the same ground without that risk | `pingcode api PUT /v1/testhub/runs/<id>` |
| `GET /v1/testhub/cases` and `GET /v1/testhub/runs` (the simple lists) | unfiltered they scan every library the token can see; `POST …/search` is the only sane read path, and it is what `cases list` / `runs list` use | `pingcode api GET /v1/testhub/cases` |
| `GET /v1/testhub/plan_states/{state_id}` | the *list* (`meta plan-states`) is wired and is the only thing a plan write needs | `pingcode api GET /v1/testhub/plan_states/<id>` |

Library and plan **creation** *are* covered (`testhub libraries create`, `testhub plans create`), so
the CLI can bootstrap its own fixtures — but read rules 13–15 first: only the plain (普通) plan type is
reachable without a sprint or release, and a library cannot be deleted afterwards.
