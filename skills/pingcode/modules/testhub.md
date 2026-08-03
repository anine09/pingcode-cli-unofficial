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
There is no library update or delete: testhub publishes no library DELETE, so anything created here
is permanent.

### `testhub meta` — the ids a testhub write cannot be built without

```bash
pingcode testhub meta case-states       --library LIB --json   # --state / state_id
pingcode testhub meta case-types        --library LIB --json   # --type / type_id
pingcode testhub meta run-statuses      --library LIB --json   # --status / status_id
pingcode testhub meta plan-types        --library LIB --json   # --type on `plans create`
pingcode testhub meta suites            --library LIB --json   # --suite; PATH is what --suite takes
pingcode testhub meta important-levels  --json                 # --important-level; org-wide
```

`important-levels` is the one lookup in the module with **no per-library variant**, so it *refuses*
`--library` with exit 2 rather than ignoring it (the flag is hidden from `--help`, which is why it
is spelled out here). The others require `--library`.

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
```

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
```

`create` takes all five: `--name` (unique within the library), `--type` (from
`testhub meta plan-types`), `--start`, `--end` and `--assignee`. There is no plan update or delete.
**Read §4c rule 12 before passing a date** — `--end` lands on 23:59:59, not midnight.

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
    Testhub publishes no library DELETE and no library PATCH, so a library created here is permanent
    and unrenameable: get the name and identifier right the first time, and mark throwaway ones
    (for example `[CLI smoke] …`) *before* creating them. The CLI says so on stderr after each
    create.
16. **`runs bulk --add-case` ignores a case id that does not exist — silently, at exit 0.** Verified
    live 2026-08-02: a bogus `--add-case` id returns `{"inserts":0,"updates":0,"deletes":0}` and
    succeeds. There is no error and no per-entry report, because the endpoint answers with counts
    only. **Read the counts**, and if they do not match what you asked for, re-list the plan with
    `pingcode testhub runs list --plan <plan> --json` to see what actually landed. A bogus id in
    `--remove-run` does fail loudly (code `100619`, exit 7), so the leniency is specific to inserts.
