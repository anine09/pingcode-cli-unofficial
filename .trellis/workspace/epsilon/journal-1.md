# Journal - epsilon (Part 1)

> AI development session journal
> Started: 2026-07-31

---

## 2026-08-01 — S8 real-API smoke (pingcode-cli-mvp)

Ran the 13-step S8 list against the live cloud org (`https://open.pingcode.com`, 9 projects), target
project `RDD` (kanban). Full evidence: `.trellis/tasks/07-31-pingcode-cli-mvp/research/s8-smoke.md`.

- Green: auth status/--check, 0600 config + 0700 dir + 0600 hashed cache with no secrets, project and
  meta reads, all four work-item reference forms, paging, filters, `--all`/`--limit`, dry-run
  (provably sent nothing), create, `--state-id` transition, title update, empty patch → 2, missing
  flag → 2, unresolvable name → 2, corrupted-token → transparent 401 re-auth + replay, `--verbose`
  leaks no secret, `--json` stdout pure with empty stderr across 19 commands. `typecheck` + 200 tests
  still green; no source changed.
- Created exactly one artifact: **RDD-26** `bbbbbbbbbbbbbbbbbbbbbbbb` (`[CLI smoke] …`), awaiting a
  delete decision.
- Gate G5: (1) `page_index`/`page_size` are genuinely honoured on GET lists — echoed back, real row
  limits, 0-based offsets, empty page past the end; (2) `expires_in` is an **absolute unix-seconds
  epoch** (1788105520 vs now 1785513519), so the `n > 1e9` branch is the production one and the clamp
  never fired; (3) a second `client_credentials` call does **not** invalidate the first — both tokens
  probed 200 seconds apart from each other.
- Three deviations left unfixed because each contradicts an explicit `design.md` contract (brief says
  stop): F1 the API omits a work item's `type`, so `update/transition --state <name>` and the
  candidate-state hint are dead (only `--state-id` works); F2 missing resources return HTTP 400
  (`100317`), so exit 5 is unreachable server-side; F3 bad credentials return HTTP 400 (`100024`), so
  exit 3 never fires — while an invalid *bearer* token does correctly return 401.

---

## 2026-08-01 — S9 finish (pingcode-cli-mvp)

Full-scope check, docs, spec, cleanup. AC verdicts with per-criterion evidence now live in `prd.md`.

- Checks: `typecheck` clean; `npm test` **13 files / 213 tests**; `tsup` build 89.6 KB; root + all
  **15** leaf `--help` pages exit 0 with the right usage header; unknown command → 2;
  `skill:install --dry-run` lists both targets and writes nothing.
- AC11 done properly: searched the *actual* stored `client_id` / `client_secret` / access token as
  literal substrings across every `git ls-files` entry → **0 hits** each. Added `.pingcode/` to
  `.gitignore` as a belt-and-braces guard, since `PINGCODE_CONFIG_DIR` can point into the repo.
- AC8 is the one honest "partial": 3 / 2 / 5 are live-observed, but **403 → 4 and 429 → 6 are
  unit-tested only** (org-admin token never got denied; provoking 429 means ~200 req/min against the
  user's production org). Said so in `prd.md` rather than ticking it clean.
- `README.md` rewritten for a first-time reader: install, 凭据管理 app + the four scopes, cloud vs
  self-hosted login, command surface, the `--json` contract, the exit-code table **with** the three
  400-mapped codes, the caveats that actually bite, and the follow-up list.
- `.trellis/spec/backend/` filled from real code (layering + its test, stdout purity, exit-code
  contract, redaction, error-mapping policy, testing + API-fact discipline). `database-guidelines.md`
  became "Local State & Persistence" — no DB, but `~/.pingcode/` deserves the same rigour.
  `.trellis/spec/frontend/` marked **N/A**: no frontend, so inventing one would just mislead.
- Deleted the smoke artifact **RDD-26** (user-approved) with one direct
  `DELETE /v1/pjm/work_items/bbbbbbbbbbbbbbbbbbbbbbbb` → **HTTP 200**; RDD back to 25 items, zero
  `[CLI smoke]` titles. Two new API facts fell out (gotchas 33–34): that DELETE endpoint exists at
  all and is a **soft** delete, and its response — uniquely — *does* carry `type`, which narrows F1's
  wording without changing the `--type` flag's necessity.




## Session 1: Fix broken self-update: bundle runtime deps and gate the published tarball

**Date**: 2026-09-09
**Task**: Fix broken self-update: bundle runtime deps and gate the published tarball
**Branch**: `main`

### Summary

self-update 1.8.1->1.8.2 安装出无法启动的二进制：npm tarball 装不进 node_modules 而 tsup 把 commander/picocolors 留作外部依赖，且 verifyInstall 在原子替换之后才跑、备份又在替换成功时被删，失败即死且无法自愈。修复：tsup 加 noExternal + createRequire banner 把两个冻结依赖打进 dist（单加 noExternal 会撞 Dynamic require of events；shims:true 无效，两个键缺一不可，产物 +143KB）；两条更新路径都改成验 staging -> 替换 -> 验安装，atomicReplace 不再自删备份、新增独立 restoreBackup 替换原来静默失效的回滚，顺手修掉 removeFile 缺 recursive 与 renameSync 覆盖非空目录两个文件系统陷阱；删掉 npm install --production；release.yml 与 publish.yml 加打包->解包->跑的产物级 CI gate；README 改正错误声明。验证：npm test 2942 通过、typecheck 干净、npm pack 解包后无 node_modules 且 --version/--help 正常（直接复现并切断用户报错链路）。遗留：需手动触发两个改过的 workflow 确认可启动、发版后补 release body 的 1.8.1/1.8.2 重新安装说明、release zips 冗余待另开任务删除。

### Git Commits

| Hash | Message |
|------|---------|
| `93e2757` | (see git log) |
| `cdf119d` | (see git log) |

### Status

[OK] **Completed**


## Session 2: Let npm own installation: drop the standalone install/update paths

**Date**: 2026-09-09
**Task**: Let npm own installation: drop the standalone install/update paths
**Branch**: `main`

### Summary

Session summary was not supplied.

### Git Commits

| Hash | Message |
|------|---------|
| `27c9475` | (see git log) |

### Status

[OK] **Completed**


## Session 3: paste-only-login: paste-only user login, remove browser channel and loopback

**Date**: 2026-09-12
**Task**: paste-only-login: paste-only user login, remove browser channel and loopback
**Branch**: `main`

### Summary

Replaced the browser-channel authorization_code login with paste-only login; breaking change.

### Main Changes

- auth login user path: printAuthorizeUrl + readPaste + new extractCode (URL or bare code); --code skips the prompt
- Removed --channel flag, openBrowser, captureCodeFromLoopback, parseLoopback, DEFAULT_LOOPBACK_URI, loginHooks loopback hooks
- Removed oauthRedirectUri config key (Config/ResolvedSettings/readConfig/settings) and Ctx.oauth

### Git Commits

| Hash | Message |
|------|---------|
| `01cec6f` | (see git log) |

### Testing

- [OK] npm run typecheck clean; npm test 2952 passed; npm run build success

### Status

[OK] **Completed**

### Next Steps

- Next release must be MAJOR 2.0.0 (breaking: --channel + oauthRedirectUri removed); .trellis/spec/guides/versioning.md:49 still shows 'add --channel' as MINOR example - stale, not in this task's scope
