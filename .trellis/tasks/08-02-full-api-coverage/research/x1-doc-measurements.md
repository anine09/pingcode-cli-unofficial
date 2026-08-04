# X1 — every number published in README.md / SKILL.md, and the command that produced it

Measured at HEAD `5a13fdf` (X2 landed, X1 not yet committed), 2026-08-05. **No number in the docs was
copied from `implement.md` or `design.md`** — those contain pre-implementation estimates, and where
they disagree with a measurement the measurement is what shipped (see §5).

Re-runnable helper scripts live in `research/x1-scripts/`. They are vitest files: copy one into
`test/` and run `npx vitest run test/<name>` (they were deliberately *not* left in `test/`, since they
assert nothing and would inflate the suite count).

---

## 1. The catalog: 459 endpoints

```
$ npm run catalog:check
catalog-sync: in sync with https://open.pingcode.com/api_data.js
  entries: 459
  methods: GET 250 · POST 96 · PATCH 54 · DELETE 49 · PUT 10
  tokens:  APP 388 · ENT 61 · USER 7 · (none) 3
  paged:   false 312 · query 142 · search 5
```

Per-module totals, taken from the **shipped bundle** rather than from a script — the same command a
reader can run:

```
$ for m in pjm ship testhub scm directory wiki release build reviews permission \
           workloads workload_types security myself relations comments attachments \
           activities participants nexus auth; do
    printf '%-16s ' "$m"; node dist/bin/pingcode.js api list --module $m | tail -1
  done
pjm 145 · ship 101 · testhub 65 · scm 36 · directory 23 · wiki 19 · release 12 ·
reviews 8 · permission 7 · build 6 · attachments 5 · nexus 5 · workloads 5 ·
comments 4 · participants 4 · relations 4 · auth 3 · activities 2 · security 2 ·
workload_types 2 · myself 1                                    → Σ = 459 ✅
```

```
$ node dist/bin/pingcode.js api list --method DELETE | tail -1      → 49 row(s)
$ node dist/bin/pingcode.js api list --method PUT | tail -1         → 10 row(s)
$ node dist/bin/pingcode.js api list --token ENT | tail -1          → 61 row(s)
$ node dist/bin/pingcode.js api list --token USER | tail -1         → 7 row(s)
$ node dist/bin/pingcode.js api list --module pjm --search 工作项配置 → 42 row(s)
$ node dist/bin/pingcode.js api list --module pjm --search 项目配置   → 7 row(s)
$ node dist/bin/pingcode.js api list --module pjm --search boards     → 15 row(s)
```

## 2. The command tree: 10 groups, 254 leaves

`research/x1-scripts/zz-x1-measure.test.ts` (traverses `buildProgram()`):

```
GROUPS: 10 :: auth api resolve product project testhub scm build release settings
LEAVES: 254
  auth 3 · api 7 · resolve 32 · product 54 · project 54 · testhub 59 · scm 31 ·
  build 5 · release 8 · settings 1
resolve leaves: 32          (31 resolvable kinds + `resolve list`)
crosscutting leaves: 70     (5 mounts × 14)
mounts: product idea | product ticket | project work-item | testhub cases | testhub runs
kinds: 33 resolvable: 31
```

## 3. Refined endpoint coverage: 158 / 459

`research/x1-scripts/zz-x1-coverage.test.ts`. Method: scan `src/api/**`, `src/core/metadata/**` and
`src/cli/commands/**` for `ENDPOINTS.<helper>` occurrences, infer the verb from the enclosing
`request({method})` spec or from the paging helper (`fetchPageOf`/`iterateOf`/`listAllOf` ⇒ GET,
`fetchSearchPageOf`/`iterateSearchOf` ⇒ POST), resolve each helper to its path template and map
`(method, template)` back onto the catalog via `matchPath`. `unresolved: 0` and `bad: 0` — every
occurrence was classified and every classification matched a catalog entry, which is what makes the
count trustworthy.

Two disambiguations, both forced by the only two duplicate `(method, path)` groups in the catalog
(`zz-x1-dup.test.ts` proves there are exactly two):

- `POST /v1/attachments` is two entries (`…create.json`, `…create.multipart`); only the JSON
  code-snippet half is wired, so only it is counted.
- `GET /v1/auth/token` is three grants; only `client_credentials` is implemented, and it is counted
  as **0** in the published table because it is not a user-facing data command.

```
wired endpoints: 159 / 459     ← includes the internal client_credentials call
                               ← published as 158, i.e. business endpoints only
pjm             40 / 145
ship            27 / 101
testhub         32 / 65
scm             31 / 36
directory        1 / 23
wiki             0 / 19
release          8 / 12
reviews          0 / 8
permission       0 / 7
build            5 / 6
attachments      4 / 5
nexus            0 / 5
workloads        0 / 5
comments         4 / 4
participants     0 / 4
relations        4 / 4
auth             1 / 3          ← published as 0/3, see above
activities       2 / 2
security         0 / 2
workload_types   0 / 2
myself           0 / 1
```

## 4. The pre-task baseline: 53 — the PRD's estimate was exact

The PRD's `已覆盖 53` was explicitly marked 待实测 ("backfill from F2's `ENDPOINTS ⊆ catalog` test").
It is now measured, by running the *same* script against the tree as it stood before this task:

```
$ git worktree add /tmp/pre cf8335f~1          # 74c4f67, the commit before F2
$ ln -s <repo>/node_modules /tmp/pre/node_modules
$ cp src/core/catalog/*.ts /tmp/pre/src/core/catalog/     # the catalog to measure against
$ cp research/x1-scripts/zz-x1-coverage.test.ts /tmp/pre/test/
  # one edit: pre-task `src/core/metadata` is a file, not a directory
$ cd /tmp/pre && npx vitest run test/zz-x1-coverage.test.ts

wired endpoints: 54 / 459
pjm 10 · ship 22 · testhub 20 · directory 1 · auth 1 · everything else 0
```

`10 + 22 + 20 + 1 = 53`, matching the PRD's four-way split **exactly**, including its correction of
the earlier hand estimate of 52. So the methodology in §3 agrees with the PRD's counting convention,
and the delta it reports is real rather than an artefact.

## 5. Where a planning document disagrees with the measurement

| Doc | Says | Measured | Verdict |
|---|---|---|---|
| `implement.md` X1 | 「可达 459 / 精修约 150」 | 158 | estimate, superseded. `implement.md` X1 itself says to take F2's measured value, which is what happened |
| `design.md` D1 table | 精修「现状 55 条叶子 → 约 150 条」 | 254 leaves | the leaf estimate was made before F5 mounted the cross-object families on five entities (+70) and before F4 exposed 32 `resolve` leaves. Both are leaf-count inflation from *one* implementation each, not extra hand-written surface — which is exactly why the README publishes an endpoint table and warns against comparing leaves to endpoints |
| `prd.md` 配平 | 已覆盖 53 + In scope 107 + Out of scope 299 | 53 + **105** + **301** | two of the 107 did not land, both for stated reasons (below). The 53 is confirmed exact |

The two In-scope endpoints that did not become named commands:

1. **`POST /v1/attachments` (`multipart/form-data`)** — PRD S0 counted the attachment family as 5
   endpoints. A real file part cannot be sent without changing `core/wire.ts`, which PRD R1 forbids
   (「若实现中认为必须改动这些文件，停下来上报」), so F5 shipped the JSON snippet half and reported the
   other. Recorded in `modules/crosscutting.md` and in the README follow-ups.
2. **`GET /v1/testhub/plan_states/{state_id}`** — PRD S3 counted `plan_states × 2`. Only the list
   (`testhub meta plan-states`) is wired; the get-one has no consumer, because the plan write needs a
   `state_id` and the list is where one comes from. `ENDPOINTS.testhubPlanState` exists
   (`endpoints.ts:507`) but nothing calls it. Recorded in `modules/testhub.md` §5.

Neither is a reach gap: both paths answer through `pingcode api` (the multipart *form* does not — see
the README follow-up, which is precise about that distinction).

## 6. Test suite

```
$ npm test
Test Files  49 passed (49)
     Tests  1522 passed (1522)
```

Unchanged by X1 — this child touches no `src/` and no test file. `npm run typecheck`, `npm run build`
and `node dist/bin/pingcode.js --help` were run after every edit round.

## 7. Command paths newly written into the docs, and actually executed

Each was run as `--help` (or in full, for the local catalog views) to prove the path resolves:

```
node dist/bin/pingcode.js testhub meta plan-states --help
node dist/bin/pingcode.js testhub runs bulk-create --help
node dist/bin/pingcode.js product plan list --help
node dist/bin/pingcode.js project work-item history list --help
node dist/bin/pingcode.js scm review update --help
node dist/bin/pingcode.js testhub cases delete --help
node dist/bin/pingcode.js api describe scm.products.replace
node dist/bin/pingcode.js api list --method PUT
node dist/bin/pingcode.js api list --module wiki
node dist/bin/pingcode.js resolve list --json
```

`api describe scm.products.replace` caught a real error in a first draft: the README example had cited
`scm.products.update`, which is the **PATCH**. The PUT's catalog id is `scm.products.replace`.

Flags quoted in the new DevOps example block were read off `--help` rather than assumed, which
corrected three of them: `scm commit create` takes `--committer` (not `--committer-name`) and **no**
`--repo` (commits are organisation-level), `scm pr create` takes `--source-branch-id` /
`--target-branch-id` (ids, not branch names), and `release deploy create --status` is
`deployed | not_deployed` (not `success`).
