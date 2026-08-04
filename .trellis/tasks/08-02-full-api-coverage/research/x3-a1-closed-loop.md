# X3 — A1 end-to-end closed loop, live run

**Date** 2026-08-05 · **Tenant** `open.pingcode.com`, enterprise token (client credentials),
token valid to 2026-09-02 · **Binary** `dist/bin/pingcode.js` built from HEAD `58e275d`
**Run id (`STAMP`)** `1785875150` · **Credentials** an isolated copy at
`$HOME/tmp/x3/config` via `PINGCODE_CONFIG_DIR`; `~/.pingcode/` was never written to.

> **The loop closed.** All 11 hops ran green on the first attempt, 21 mutating CLI
> invocations, every one `--json`-parseable, every id chained forward with `jq` and never
> transcribed by hand. Two hops (3 and 4) had to be driven through the **generic
> `pingcode api` layer** because no refined leaf carries `sprint_id` / `version_ids` on an
> existing work item; one hop (11) uses the **scm-native** `--work-item` association rather
> than `/v1/relations`, because `/v1/relations` has no `commit` in its vocabulary. Both are
> recorded as findings in §7, and one of them falsified a shipped doc claim (§7.1).

## 1. Method, and the one thing I could not do

**`网页端可见` is not achievable here and is not claimed anywhere in this file.** These are API
credentials, not a browser session; I cannot open the PingCode web UI. The substitute used
throughout is strictly stronger *evidence of the same fact*: every link is read back **from the
opposite endpoint**, and for the four `/v1/relations` links the mirror row carries a **different
`id`** than the row the POST returned — which can only be true if the server materialised a
mirrored pair, not merely accepted a request (F5 / S2b's finding, re-confirmed here on three
different principal kinds). Where the API offers no reverse index at all, §6 says so instead of
substituting a weaker read.

Three passes, all logged under `$HOME/tmp/x3/run/`:

| Pass | Invocations | What it proves |
|---|---|---|
| **live** (`MODE=live`) | **42** = 21 × (`--dry-run` pre-flight, then the real write) | the loop closes; every hop's pre-flight plan was inspected before its write went out (smoke discipline #2) |
| **dry** (`MODE=dry`) | **21**, identical argv + `--dry-run` | A1 clause 3: zero writes, complete request plan for all 21 |
| **verify** | **23** reads | A1 clause 1 + the opposite-side read-back of every link |

Plus 11 deliberate error-path probes (§8) and 6 vocabulary probes (§7.3).

Driver: `chain.sh` (one `run()` helper: log argv → run → assert exit 0 → assert stdout parses as
JSON → expose the output file to `j '<jq-expr>'`). Nothing in the chain reads a value from a
human-facing table; every forward reference is `jq -r` on the previous hop's stdout.

## 2. Fixed tenant inputs (surveyed first, per the "count before assuming" rule)

| Thing | Value | Note |
|---|---|---|
| project | `YYHC` `6a1c41781c7734aaad9ec23c` | 10 projects exist; 192 work items before the run |
| sprint | `[CLI smoke] s-e2e` `6a715951a2f1bc8bb00ebf51` | reused — sprints have **no** upstream DELETE |
| product | `PD-YYHC` `6a1c53580faf359d7447b68e` | 46 ideas before the run |
| test library | `CLI Smoke` `6a6ef8d811c48dd2a042367d` | 6 cases / 3 plans before the run |
| plan type | `普通` `6a6ef8d811c48dd2a0423683` | from `testhub meta plan-types` |
| scm platform | `[CLI smoke] pingcode-cli` `6a7052e9919cce9794f005f1` | isolated; the two real GitHub integrations were **never** touched |
| scm repo | `cli-smoke/pingcode-cli-unofficial` `6a70532d919cce9794f00607` | 2 branches / 2 PRs before the run |
| PR target branch | `cli-smoke/keeper` `6a706c3e919cce9794f01221` | pre-existing |
| git identity | `cli-smoke-bot` | reused, because an unknown `--sender` / `--creator` **creates** an undeletable platform user |
| assignee | `luoxiutao` `f5712155d0e54d0b94ffacb1384217f0` | |

Before the run: **0 versions in YYHC, 0 builds, 0 environments, 0 deploys** in the whole
organisation. The chain therefore created the first of each — which is what made the
before/after totals in §5 unambiguous.

## 3. The eleven hops

Notation: `→ VAR` is the value the driver extracted and fed forward; the jq expression is the
one actually executed. All commands ran with `--json`; the `pingcode` prefix stands for
`node dist/bin/pingcode.js`.

### H1 · 建需求 — `product idea create`

```bash
pingcode product idea create --json \
  --product 6a1c53580faf359d7447b68e \
  --title "[CLI smoke] x3 idea 1785875150" \
  --description "closed-loop probe, safe to delete"
```

`jq -r .id → IDEA_ID=6a724ace4ba4309ef9e95901` · `jq -r .identifier → IDEA_IDENT=PD-YYHC-74`

```json
{"id":"6a724ace4ba4309ef9e95901","identifier":"PD-YYHC-74","short_id":"sN6toWLk",
 "title":"[CLI smoke] x3 idea 1785875150","state":{"name":"待排期"}}
```

Read-back: `product idea get PD-YYHC-74 --json` → same id, title and `description` stored
verbatim.

### H2 · 关联到工作项 — `work-item create` + `product idea relation add`

The chain needs the work item first, so H2 is two invocations.

```bash
pingcode project work-item create --json --project 6a1c41781c7734aaad9ec23c \
  --type story --title "[CLI smoke] x3 story 1785875150" --assignee <user-id>
```
`jq -r .id → STORY_ID=6a724ad00fa6ce89caaabefb` · `jq -r .identifier → STORY_IDENT=YYHC-224`

```bash
pingcode product idea relation add "$IDEA_ID" --json \
  --target-type work_item --target-id "$STORY_ID"
```
`jq -r .id → REL_IDEA_STORY=6a724ad136570f6891f9fd43`

**Opposite-side read-back** — from the *work item*, not the idea:

```bash
pingcode project work-item relation list "$STORY_ID" --target-type idea --json
# [{"rel_id":"6a724ad136570f6891f9fd44","target_type":"idea","target":"6a724ace4ba4309ef9e95901"}]
pingcode product idea relation list "$IDEA_ID" --target-type work_item --json
# [{"rel_id":"6a724ad136570f6891f9fd43","target_type":"work_item"}]
```

**`…fd43` vs `…fd44`.** Two rows, two ids, one link. This is the mirrored pair, seen from both
ends.

### H3 · 工作项入迭代 — `pingcode api PATCH` (no refined leaf exists — §7.1)

```bash
pingcode api PATCH /v1/pjm/work_items/6a724ad00fa6ce89caaabefb --json \
  --body '{"sprint_id":"6a715951a2f1bc8bb00ebf51"}'
```

Read-back, own side and sprint side:

```bash
pingcode project work-item get "$STORY_ID" --json | jq .sprint
# {"id":"6a715951a2f1bc8bb00ebf51","name":"[CLI smoke] s-e2e","status":"in_progress", …}
pingcode project work-item list --project YYHC --sprint 6a715951a2f1bc8bb00ebf51 --json --page-size 100
# → contains "YYHC-224"
```

Third, independent confirmation: the server wrote an **activity record** for it —
`{"property_key":"iteration","origin":null,"target":{"id":"6a715951…","name":"[CLI smoke] s-e2e"}}`
(see §4). That is the same signal the web UI renders in the item's timeline.

### H4 · 建版本 + 工作项挂版本 — `project version create` + `pingcode api PATCH`

```bash
pingcode project version create --json --project 6a1c41781c7734aaad9ec23c \
  --name "[CLI smoke] x3 v1785875150" --assignee <user-id> --start 2026-08-05 --end 2026-08-31
```
`jq -r .id → VERSION_ID=6a724ad33e127a186f11372c`

```bash
pingcode api PATCH /v1/pjm/work_items/"$STORY_ID" --json \
  --body '{"version_ids":["6a724ad33e127a186f11372c"]}'
```

Read-back:

```bash
pingcode project work-item get "$STORY_ID" --json | jq '[.versions[]|{id,name}]'
# [{"id":"6a724ad33e127a186f11372c","name":"[CLI smoke] x3 v1785875150"}]
pingcode api GET /v1/pjm/work_items --query version_id=6a724ad33e127a186f11372c --query page_size=100
# → contains "YYHC-224"
```

Version fields stored as sent: `start_at 1785859200` (2026-08-05 00:00 local),
`end_at 1788191999` (2026-08-31 23:59:59 local), `assignee luoxiutao`, `stage 未开始`
(the API picked the first stage, as `--help` promises). Activity record:
`{"property_key":"version","origin":null,"target":[{…}]}`.

### H5 · 建用例 + 关联工作项 — `testhub cases create` + `cases relation add`

```bash
pingcode testhub cases create --json --library-id 6a6ef8d811c48dd2a042367d \
  --title "[CLI smoke] x3 case 1785875150" --precondition "logged in"
```
`jq -r .id → CASE_ID=6a724ad4f8f6de4d4671c1f2` (`identifier CLISMOKE-13`, `state 设计`)

```bash
pingcode testhub cases relation add "$CASE_ID" --json --target-type work_item --target-id "$STORY_ID"
```
`jq -r .id → REL_CASE_STORY=6a724ad685dbd8d6c0b89851`

**Opposite-side read-back** — from the work item:

```bash
pingcode project work-item relation list "$STORY_ID" --target-type test_case --json
# [{"rel_id":"6a724ad685dbd8d6c0b89852","target_type":"test_case"}]
```

`…9851` → `…9852`. Mirrored pair again, this time on a `test_case` principal.

### H6 · 建测试计划 + 执行记录 — `testhub plans create` + `runs create`

```bash
pingcode testhub plans create --json --library-id <lib> \
  --name "[CLI smoke] x3 plan 1785875150" --type-id 6a6ef8d811c48dd2a0423683 \
  --assignee-id <user> --start 2026-08-05 --end 2026-08-31
```
`jq -r .id → PLAN_ID=6a724ad78ec841d4a86c4ee6` (`status pending` / 未开始)

```bash
pingcode testhub runs create --json --library-id <lib> \
  --plan-id "$PLAN_ID" --case-id "$CASE_ID" --executor-id <user>
```
`jq -r .id → RUN_ID=6a724ad78ec841d4a86c4ee9` — created at `status: not_start`, as
`runs create --help` promises.

**Opposite-side read-back** — from the plan:

```bash
pingcode testhub runs list --library-id <lib> --plan-id "$PLAN_ID" --json
# [{"id":"6a724ad78ec841d4a86c4ee9","plan":"6a724ad78ec841d4a86c4ee6",
#   "case":"6a724ad4f8f6de4d4671c1f2","status":"failure"}]   ← after H7
```

### H7 · 记录执行失败 — `testhub runs patch --status 失败`

```bash
pingcode testhub runs patch "$RUN_ID" --json --status 失败 \
  --remark "[CLI smoke] x3 failed on 1785875150"
```

Read-back on the raw wire plus the run's own history family:

```json
{"status":"failure","remark":"[CLI smoke] x3 failed on 1785875150",
 "executor":"luoxiutao","latest_executed_status":{"name":"失败"}}
```
```bash
pingcode testhub runs history list "$RUN_ID" --json
# [{"status":"failure","remark":"[CLI smoke] x3 failed on 1785875150"}]
```

Two independent confirmations of the failure: the slug `failure` on the run, and one history row.
The executor was **inherited** (`--executor` not passed) exactly as [TH§14 / D17] describes — the
name-to-slug table (`失败 → failure`) matched the one S3 measured.

### H8 · 建缺陷 + 关联用例 — `work-item create --type bug` + `work-item relation add`

```bash
pingcode project work-item create --json --project <proj> --type bug \
  --title "[CLI smoke] x3 bug 1785875150" --assignee <user> --parent "$STORY_ID"
```
`jq -r .id → BUG_ID=6a724ada0fa6ce89caaabf04` · `jq -r .identifier → BUG_IDENT=YYHC-225`

```bash
pingcode project work-item relation add "$BUG_ID" --json \
  --target-type test_case --target-id "$CASE_ID"
```
`jq -r .id → REL_BUG_CASE=6a724adc87d77b3ccbf1852d`

**Opposite-side read-back** — from the *case*:

```bash
pingcode testhub cases relation list "$CASE_ID" --target-type work_item --json
# [{"rel_id":"6a724adc87d77b3ccbf1852e","target_type":"work_item"}]
```

`…852d` → `…852e`. Third mirrored pair. Also verified: the bug's `parent` reads back as
`YYHC-224`, so bug→story is linked twice over — once by parentage (typed, same-kind) and once
transitively through the case.

> **Relation-system discipline, hop by hop.** H2 (`idea`↔`work_item`), H5
> (`test_case`↔`work_item`) and H8 (`work_item`↔`test_case`) are all **cross-kind**, so all
> three correctly use `/v1/relations` (`<entity> relation add`). None of them could have used
> `work-item link add`, and `work-item link add` was **not** used anywhere in this chain: the
> only same-kind pair in the loop is bug→story, and that is expressed as parentage. H11 is
> neither family — see §7.3.

### H9 · 写回 commit / PR — branch, commit, ref, PR

```bash
pingcode scm branch create --json --platform-id <p> --repo-id <r> \
  --name cli-smoke/x3-1785875150 --sender cli-smoke-bot --work-item "$STORY_IDENT"
#   jq -r .id → BRANCH_ID=6a724adc39cbed1cf712bbeb

pingcode scm commit create --json --sha d2ce9070c5a6e2a6480e38840be4236d1efcb177 \
  --message "feat: #YYHC-224 [CLI smoke] x3 feature commit" --committer cli-smoke-bot \
  --committed-at 2026-08-05T09:00:00Z --added src/x3.ts --modified README.md \
  --work-item "$STORY_IDENT"
#   jq -r .id → COMMIT_ID=6a724add39cbed1cf712bbec

pingcode scm ref create --json --platform-id <p> --repo-id <r> \
  --sha "$FEAT_SHA" --branch-id "$BRANCH_ID"
#   jq -r .id → REF_ID=6a724ade39cbed1cf712bbed

pingcode scm pr create --json --platform-id <p> --repo-id <r> \
  --title "[CLI smoke] x3 pr 1785875150" --number 9850 --creator cli-smoke-bot \
  --status open --source-branch-id "$BRANCH_ID" --target-branch-id 6a706c3e919cce9794f01221 \
  --description "closes #YYHC-224" --work-item "$STORY_IDENT"
#   jq -r .id → PR_ID=6a724ade39cbed1cf712bbee
```

The SHAs are derived from the stamp (`sha1sum` of `x3feat<stamp>` / `x3fix<stamp>`), so a rerun
can never collide with the SHA-uniqueness rule; the PR number is `9100 + stamp % 800 = 9850`,
clear of the existing 9001/9002.

**Opposite-side read-back — `scm commit list --work-item-id` is a genuine reverse index:**

```bash
pingcode scm commit list --work-item-id "$STORY_ID" --json
# [{"id":"6a724add39cbed1cf712bbec","sha":"d2ce9070c5a6",
#   "message":"feat: #YYHC-224 [CLI smoke] x3 feature commit"}]   ← exactly one, the right one
pingcode scm ref list --platform-id <p> --repo-id <r> --branch-id "$BRANCH_ID" --json
# [{"id":"6a724ade39cbed1cf712bbed","branch":"cli-smoke/x3-1785875150","sha":"d2ce9070c5a6"}]
pingcode scm branch get "$BRANCH_ID" … --json | jq '[.work_items[].identifier]'   # ["YYHC-224"]
pingcode scm pr get "$PR_ID" … --json
# {"number":9850,"status":"open","work_items":["YYHC-224"],
#  "src":"cli-smoke/x3-1785875150","dst":"cli-smoke/keeper"}
```

`--work-item YYHC-224` is the flag whose `--help` warns "an unknown one is silently ignored" —
so the read-back is not optional, and it landed on all four scm writes.

Commit payload stored faithfully (raw wire): `files_added ["src/x3.ts"]`, `files_removed []`,
`files_modified ["README.md"]`, `file_changed_count 2` computed by the server,
`committer_name "cli-smoke-bot"`, `committed_at 1785920400`.

### H10 · 写回构建与部署 — `release env create` + `build create` + `release deploy create`

```bash
pingcode release env create --json --name "[CLI smoke] x3 env 1785875150" \
  --html-url https://example.invalid/env/1785875150
#   jq -r .id → ENV_ID=6a724adf919cce9794f06099

pingcode build create --json --name "[CLI smoke] x3 build 1785875150" --identifier 1 \
  --provider jenkins --status failure --start-at 2026-08-05T09:10:00Z \
  --end-at 2026-08-05T09:12:00Z --duration 120 --job-url … \
  --result-overview "1 case failed" --work-item "$STORY_IDENT"
#   jq -r .id → BUILD_ID=6a724adf919cce9794f0609a

pingcode release deploy create --json --env-id "$ENV_ID" --status deployed \
  --release-name "[CLI smoke] x3 rel 1785875150" --start-at … --end-at … --duration 120 \
  --release-url … --work-item "$STORY_IDENT"
#   jq -r .id → DEPLOY_ID=6a724ae039cbed1cf712bbef
```

Read-back:

```bash
pingcode build get "$BUILD_ID" --json
# {"name":"[CLI smoke] x3 build …","status":"failure","work_items":["YYHC-224"]}
pingcode release deploy get "$DEPLOY_ID" --json
# {"status":"deployed","env":"[CLI smoke] x3 env …","work_items":["YYHC-224"]}
pingcode release deploy list --env-id "$ENV_ID" --json   # → the deploy, read from the ENV side
```

`job_url`, `result_overview` and `duration` all read back on the raw wire; `result_url` is
`null` because it was not sent. **Honest gap, stated in §6:** for `build ↔ work_item` there is no
reverse index anywhere in the API, so the strongest available evidence is the build's own
`work_items` array. The deploy has one on the *environment* axis only.

### H11 · 缺陷关联到 commit — `scm commit create --work-item <bug>`

```bash
pingcode scm commit create --json --sha 8c5c147cfc0c416e1b1c8d88ff7232ff51b73033 \
  --message "fix: #YYHC-225 [CLI smoke] x3 fix commit" --committer cli-smoke-bot \
  --committed-at 2026-08-05T09:30:00Z --modified src/x3.ts --work-item "$BUG_IDENT"
#   jq -r .id → FIX_COMMIT_ID=6a724ae039cbed1cf712bbf0
```

**Opposite-side read-back — from the bug:**

```bash
pingcode scm commit list --work-item-id "$BUG_ID" --json
# [{"id":"6a724ae039cbed1cf712bbf0","sha":"8c5c147cfc0c",
#   "message":"fix: #YYHC-225 [CLI smoke] x3 fix commit"}]
pingcode scm commit get "$FIX_SHA" --json | jq '[.work_items[].identifier]'   # ["YYHC-225"]
```

Two reverse reads, and note that `commit list --work-item-id "$STORY_ID"` returns **only** the
feature commit while `--work-item-id "$BUG_ID"` returns **only** the fix commit — the index
discriminates, so this is a real association and not a global scan.

**Why this is not a `relation add`.** implement.md's hop-11 spelling was
"缺陷 `relation add` 关联到 commit". `/v1/relations` has no `commit` in its vocabulary — see
§7.3, where six probes settle it. The scm-native `--work-item` association is the only path the
API offers, so the hop's *intent* is met and its *mechanism* differs from the plan.

## 4. Activity records — the closest thing to "web UI visible" that an API can give

```bash
pingcode project work-item activity list "$STORY_ID" --json     # total: 4
```
```
create  {"id":"6a724ad00fa6ce89caaabefe","type":"create"}
update  {"property_key":"iteration","origin":null,"target":{"id":"6a715951…","name":"[CLI smoke] s-e2e"}}
update  {"property_key":"version","origin":null,"target":[{"id":"6a724ad3…","name":"[CLI smoke] x3 v…"}]}
add     {"id":"6a724ada0fa6ce89caaabf0c","type":"add"}          ← the child bug
```

H3 and H4 are therefore confirmed **three** ways: the item's own field, the parent collection's
member list, and a server-written audit row. Worth recording as a negative too: **relations,
commits, builds and deploys leave no row here** — the activity family covers property changes and
child adds only, so for those four families the mirror read in §3 is the *only* evidence
available, which is exactly why every one of them has one.

## 5. The `--dry-run` pass — measured, not argued

Method: snapshot 12 collection totals → replay the **identical 21 argv** with `--dry-run`
appended → snapshot again → `diff`.

```
                      before dry   after dry
ideas                         47          47
work_items                   194         194
versions                       1           1
cases                          7           7
plans                          4           4
branches                       3           3
pull_requests                  3           3
builds                         1           1
environments                   1           1
deploys                        1           1
commits (org-wide)          3836        3836
sprints                        8           8
```

`diff totals-before-dry.txt totals-after-dry.txt` → **empty**. Zero writes across every family
the chain touches.

For context, the same 12 counters *before the live pass*: ideas 46, work_items 192, versions 0,
cases 6, plans 3, branches 2, pull_requests 2, builds 0, environments 0, deploys 0, commits 3834,
sprints 8. So the live pass moved 11 of the 12 counters (`sprints` deliberately not — the sprint
was reused) and the dry pass moved none. That contrast is the proof; the absolute numbers alone
would not be.

**Plan completeness:** all 21 dry outputs satisfy
`has("dry_run") and .dry_run==true and (.request|has("method") and has("url") and has("headers") and has("body"))`
— asserted programmatically, 21/21, plus the 21 pre-flight plans from the live pass, i.e. **42
complete plans**. `Authorization` renders as `***REDACTED***` in every one. Example:

```json
{"dry_run":true,"request":{"method":"POST","url":"https://open.pingcode.com/v1/relations",
 "headers":{"Accept":"application/json","Authorization":"***REDACTED***",
            "Content-Type":"application/json"},
 "body":{"principal_type":"work_item","principal_id":"6a724ada0fa6ce89caaabf04",
         "target_type":"test_case","target_id":"6a724ad4f8f6de4d4671c1f2"}}}
```

Two things the dry pass did **not** and cannot prove, said plainly: it does not exercise
server-side uniqueness (a replayed `pr create --number 9850` would be rejected live), and reads
still execute under `--dry-run` — which is by design (the gate is on the mutating verb) and is
why a pre-flight is cheap enough to run before every write.

## 6. Where a true opposite-side read does not exist

| Link | Reverse read used | Strength |
|---|---|---|
| idea ↔ work_item (H2) | `work-item relation list --target-type idea` | **mirror row, different id** |
| test_case ↔ work_item (H5) | `work-item relation list --target-type test_case` | **mirror row, different id** |
| work_item ↔ test_case (H8) | `cases relation list --target-type work_item` | **mirror row, different id** |
| work_item → sprint (H3) | `work-item list --sprint <id>` + activity row | true reverse index |
| work_item → version (H4) | `api GET /v1/pjm/work_items?version_id=` + activity row | true reverse index |
| run → plan (H6) | `runs list --plan-id` | true reverse index |
| commit → work_item (H9, H11) | `scm commit list --work-item-id` | true reverse index, and it discriminates |
| ref → branch (H9) | `scm ref list --branch-id` | true reverse index |
| deploy → environment (H10) | `release deploy list --env-id` | true reverse index |
| branch → work_item (H9) | `scm branch get`.`work_items` | **own side only** — `branch list` has no work-item filter |
| pull_request → work_item (H9) | `scm pr get`.`work_items` | **own side only** — `pr list` has no work-item filter |
| build → work_item (H10) | `build get`.`work_items` | **own side only** — `GET /v1/build/builds` publishes **no filters at all** (verified: the whole `build` module is 6 endpoints, none of them filterable) |
| deploy → work_item (H10) | `release deploy get`.`work_items` | **own side only** |

The bottom four are an API limitation, not a shortfall of the run: PingCode publishes a
work-item reverse index for commits and for nothing else in devops. For those four, the
available evidence is that the server *stored and re-serialised* the association after a
round-trip — which is materially weaker than a mirror row, and is labelled as such rather than
written up as if it were the same thing.

## 7. Findings

### 7.1 A shipped doc claim is false: `work-item update --sprint` does not exist

```
$ pingcode project work-item update <id> --sprint <sprint-id> --json
error: unknown option '--sprint'
(Did you mean --parent?)                                        exit=2
```

`work-item create` has `--sprint`; `work-item update` has neither `--sprint` nor `--version`, and
`bulk-update` answers 200 / `updated: 0` for `sprint_id` and `version_ids` both (S2b's finding,
unchanged). So **for an item that already exists, no refined leaf can move it into a sprint or
onto a release** — and three places in the repo said otherwise:

| Where | Claim |
|---|---|
| `skills/pingcode/modules/pjm.md` (bulk-update bullet) | "To move items into a sprint, loop `work-item update --sprint` one item at a time." |
| `src/cli/commands/workItem.ts` (bulk-update help epilog) | "use `work-item update --sprint` per item" |
| `test/help/__snapshots__/project.test.ts.snap` | the snapshot of the above |

All three corrected to point at the generic layer, which **is** verified to work:

```bash
pingcode api PATCH /v1/pjm/work_items/<id> --set sprint_id=<sprint-id>          # H3
pingcode api PATCH /v1/pjm/work_items/<id> --body '{"version_ids":["<id>"]}'    # H4
```

`pjm.md` also gained a short "Moving an existing item into a sprint, or onto a release" section
with both forms, the array caveat below, and the activity-record verification trick.

**Not fixed here, and it is the orchestrator's call:** whether `work-item update` should simply
grow `--sprint` / `--version`. The API supports both fields on `PATCH` (H3 and H4 prove it), the
api-layer type `UpdateWorkItemInput` already declares `version_ids`, and the closed loop needed
both — so the gap looks like an oversight rather than a decision. That is a behaviour change and
X3 does not make it.

### 7.2 `api --set` is scalar-only, and `version_ids` is one of the few fields upstream type-checks

```
$ pingcode api PATCH /v1/pjm/work_items/<id> --set 'version_ids=["<id>"]'
error: 'version_ids'不是有效的数组 (HTTP 400 code 100006)                       exit=7
```

`--set` sends its value verbatim **as a JSON string**, so `{"version_ids":"[\"…\"]"}` goes on the
wire. Notable because this API's habit is the opposite — accept a wrong-typed field with 200 and
store nothing — so an agent that assumes silence would have believed the write landed. The
version already attached to the story was **unchanged** by the rejected call (re-read: still
`["[CLI smoke] x3 v1785875150"]`).

`100006` is **not** proposed for `ERROR_CODE_OVERRIDES`: it is input validation, exit 7 is right,
and the same code will mean "wrong type" on any field.

One clause was added to `skills/pingcode/modules/api.md`; the pre-existing text ("flat, values
sent verbatim", "never type-guessed") was accurate but did not say arrays are impossible, which
is what hop 4 needed to know.

### 7.3 `/v1/relations` has no `commit`, and `100049` names the wrong field

Six probes on `POST /v1/relations`, all with a valid `principal_type: work_item` and a real
`principal_id`:

| `target_type` | result |
|---|---|
| `commit` | 400 `100049` `不支持的'principal_type'` |
| `sha` | 400 `100049` `不支持的'principal_type'` |
| `zzz` | 400 `100049` `不支持的'principal_type'` |
| (control) `principal_type: zzz`, `target_type: idea` | 400 `100049` `不支持的'principal_type'` |

So: (a) `commit` is genuinely outside the vocabulary — it behaves identically to the nonsense
value `zzz`; (b) **the message misattributes the field** — an unsupported *`target_type`* is
reported as an unsupported *`principal_type`*, and the one code `100049` covers both ends of the
pair. An agent debugging a rejected `relation add` will be told to check the wrong flag. The
shipped help already refuses to promise a vocabulary ("that list is what a live tenant accepted
— it is a hint, not a rule"), which is exactly the right posture; nothing needs changing, but the
misleading message is worth knowing.

`100049` is **not** proposed for `ERROR_CODE_OVERRIDES`: it is a vocabulary/validation error, not
an absence, and it is ambiguous across two fields — the same reason `100702` was refused in
`08-01-ship-cli` §14.3a.

### 7.4 No new not-found code — `ERROR_CODE_OVERRIDES` needs no row

Eleven error probes across every family in the loop (§8). Every "does not exist" landed on a code
already in the table or on a real 404, so `src/core/wire.ts` is **unchanged**. That is the
expected outcome after eight S children and the one sanctioned exception was not needed.

### 7.5 Everything else matched the planning documents

Confirmed unchanged, no surprises: the `失败 → failure` run-status mapping ([TH§14 / D17]); a run
created at `not_start` and its executor inherited on PATCH ([TH§14.7]); the atomic date snapping
on `version create` (`00:00:00` / `23:59:59` local, D15.4) and the server picking the first stage
when `--stage-id` is omitted (D15/S2a); `file_changed_count` computed server-side; ship's
resource body accepting `identifier` as a lookup key (`product idea get PD-YYHC-74`, D18.4);
`--json` stdout pure and stderr 0 bytes on all 42 successful invocations.

## 8. Error-path probes (smoke discipline #3)

| Probe | exit | code / message |
|---|---|---|
| `idea create` without `--title` | 2 | commander: `required option '--title <text>' not specified` |
| `work-item create --type zzz` | 2 | `{"kind":"usage","message":"no work item type matches \"zzz\""}` |
| `relation add` without `--target-id` | 2 | commander: required option |
| `version create` without `--start` | 2 | commander: required option |
| `work-item update --sprint` | 2 | `unknown option '--sprint'` (§7.1) |
| `work-item get <unknown 24-hex>` | **5** | `100317 工作项资源不存在` |
| `idea get <unknown 24-hex>` | **5** | `100725 需求不存在或无权访问` |
| `cases get <unknown 24-hex>` | **5** | `100601 测试用例不存在或无权限访问` |
| `runs patch <unknown>` | **5** | `100603 执行用例不存在或无权限访问` |
| `commit get 000…0` | **5** | `100206 'commit'资源不存在` |
| `build get <unknown>` | **5** | `100203 'build'资源不存在` |
| `deploy get <unknown>` | **5** | `100204 'deploy'资源不存在` |
| `api POST /v1/relations` bad vocabulary | 7 | `100049` (§7.3) |
| `api PATCH` stringified array | 7 | `100006` (§7.2) |

Exit 2 before any request, exit 5 for every absence, exit 7 for validation — the contract in
`.trellis/spec/backend/error-handling.md` held on every family the loop touches.

## 9. Residue left in the tenant

All 18 objects — 21 rows, if the three relations are counted as the mirrored pairs they are —
carry a `[CLI smoke]` marker (`[CLI smoke] x3 …` in a name/title/message, or the
`cli-smoke/x3-…` branch prefix). **Nothing was deleted.** The loop *is* the acceptance artifact
for A1, and the one form of verification I cannot perform — opening the web UI and seeing the
links — is the one a human reviewer can, so tearing it down would destroy the only evidence they
can check independently. Every deletable row below has its exact teardown command, so the
decision stays reversible.

| # | Object | Id | Deletable? | Teardown |
|---|---|---|---|---|
| 1 | idea `PD-YYHC-74` | `6a724ace4ba4309ef9e95901` | **no** — ship has no DELETE anywhere | — |
| 2 | work item `YYHC-224` (story) | `6a724ad00fa6ce89caaabefb` | yes | `project work-item delete YYHC-224 --yes` |
| 3 | work item `YYHC-225` (bug) | `6a724ada0fa6ce89caaabf04` | yes | `project work-item delete YYHC-225 --yes` |
| 4 | relation idea↔story (pair) | `…fd43` / `…fd44` | yes | `product idea relation delete <idea> …fd43` |
| 5 | version `[CLI smoke] x3 v…` | `6a724ad33e127a186f11372c` | yes | `project version delete <id> --project YYHC --yes` |
| 6 | case `CLISMOKE-13` | `6a724ad4f8f6de4d4671c1f2` | yes (**cascades to its runs**, D17.5) | `testhub cases delete <id> --yes` |
| 7 | relation case↔story (pair) | `…9851` / `…9852` | yes | `testhub cases relation delete <case> …9851` |
| 8 | test plan `[CLI smoke] x3 plan …` | `6a724ad78ec841d4a86c4ee6` | **no** — testhub publishes no plan DELETE | — |
| 9 | run | `6a724ad78ec841d4a86c4ee9` | **only by cascade** — testhub publishes **no** run DELETE (the whole module has 4: case, suite, library member, case-property binding) | dies with row 6 |
| 10 | relation bug↔case (pair) | `…852d` / `…852e` | yes | `project work-item relation delete <bug> …852d` |
| 11 | branch `cli-smoke/x3-1785875150` | `6a724adc39cbed1cf712bbeb` | yes — **but it orphans the ref permanently** (scm.md) | `scm branch delete <id> …--yes` |
| 12 | commit `d2ce9070…` (feature) | `6a724add39cbed1cf712bbec` | **no** | — |
| 13 | ref | `6a724ade39cbed1cf712bbed` | **no** — scm's *only* DELETE is the branch one | — |
| 14 | pull request `#9850` | `6a724ade39cbed1cf712bbee` | **no** | — |
| 15 | environment `[CLI smoke] x3 env …` | `6a724adf919cce9794f06099` | yes | `api DELETE /v1/release/environments/<id> --yes` |
| 16 | build | `6a724adf919cce9794f0609a` | yes | `build delete <id> --yes` |
| 17 | deploy | `6a724ae039cbed1cf712bbef` | yes | `api DELETE /v1/release/deploys/<id> --yes` |
| 18 | commit `8c5c147c…` (fix) | `6a724ae039cbed1cf712bbf0` | **no** | — |

**Permanent by upstream design: 6 rows** — 1 idea, 1 test plan, 2 commits, 1 ref, 1 PR.

Reused and *not* newly created, so not residue: the sprint `[CLI smoke] s-e2e`, the scm platform,
the repo, the `cli-smoke/keeper` branch, the `cli-smoke-bot` identity, the `CLI Smoke` library.
**No platform user was created** (`--sender` / `--creator` both named the existing bot), and the
two real GitHub integrations were never written to.

Pre-existing residue from earlier children was neither touched nor cleaned: project `CLIS2BX`,
the 4 `[CLI smoke]` sprints in YYHC, the `cli-smoke*` scm series, testhub's 6 soft-deleted cases
and 3 `CLI Smoke Plan*` plans.

## 10. Reproducing this

Scripts live outside the repo at `$HOME/tmp/x3/` (`chain.sh`, `totals.sh`, `verify.sh`, `env.sh`),
with per-invocation `.cmd` / `.out` / `.err` / `.rc` files under `$HOME/tmp/x3/run/`. They are
deliberately **not** committed: they hard-code tenant ids, and `.trellis/spec` forbids tenant
values in the repo. `STAMP=$(date +%s)` makes every artifact name, SHA and PR number unique, so a
rerun collides with nothing.

```bash
export PINGCODE_CONFIG_DIR=$HOME/tmp/x3/config     # isolated copy, never ~/.pingcode
STAMP=$(date +%s)
MODE=live STAMP=$STAMP ./chain.sh                  # 21 hops, each dry-run then real
STAMP=$STAMP ./verify.sh                           # 23 opposite-side reads
./totals.sh > before.txt
MODE=dry  STAMP=$STAMP ./chain.sh                  # replays the same argv with --dry-run
./totals.sh > after.txt && diff before.txt after.txt
```
