# spec 更新与推送发版

## Goal

在推送前完成团队规范文档（`.trellis/spec/` + README + 根 VERSIONING.md）的过时点清理，使其与当前代码和 CI 实际情况一致；bump 版本到 2.0.0（paste-only login breaking change）；连带提交 skill-multiselect 在途改动；推送 origin/main 触发自动发版（release.yml 建 GitHub Release + publish.yml npm publish）。

**用户价值**：发版动作由推送自动触发，但规范文档若带着过时示例（已删除的 `--channel`、loopback、Trellis 模板残留）发出去，会持续误导后续开发。先对齐 spec、按 SemVer 正确发 2.0.0，保证发布建立在准确的团队约定之上。

## Background（已确认事实）

- 前序任务 `09-12-paste-only-login` 已完成并归档（`01cec6f` breaking + journal `034d9a4` + archive `abac73d`）。本地 main 领先 origin/main 3 个提交，未 push。
- **CI 机制（exp-1 摸底确认）**：
  - push main → `release.yml`（release.yml:31-33）：读 package.json 版本号，skip-if-released 守卫（tag 存在且 release published+assets>0 才 skip），全量门禁（typecheck+test+build+tarball 冒烟），`git tag -f v{ver}` + push，`gh release create` 带 tarball。**不 publish npm**。
  - push main 且触及 package.json → `publish.yml`（publish.yml:3-6）：softprops 建 release + tag，typecheck+build（**不跑 test**），`npm publish --provenance`（NPM_TOKEN + GITHUB_TOKEN）。这是唯一 publish npm 的工作流。
  - **无自动版本 bump**：版本号完全来自 package.json；bump 惯例是独立 commit `chore: bump version to X.Y.Z`（commit-conventions.md:153）。
  - catalog-check.yml 与 spec 无关（校验 vendored API 端点目录漂移），不是 push 门禁。
- **当前版本状态**：package.json = 1.9.0（已提交未发布），最新 tag = v1.8.2。
- **spec 过时点（exp-2 清查确认，21 个 spec 文件）**：
  - A1/A2 `guides/versioning.md:49-50`：MINOR 示例 `add --channel/--code`、PATCH 示例 `fix the loopback hint` 均过时（--channel/loopback 已删，--code 仍在）。
  - A3 根 `VERSIONING.md`：spec/guides/versioning.md 的旧分叉副本（缺 src/version.ts 行、缺 GitFlow Release Flow 节）。
  - B1 `backend/database-guidelines.md:111-116`：Gotcha 措辞含 "Register a loopback address (http://127.0.0.1:8732/callback)"，oauthRedirectUri 已删、CLI 不再发 redirect_uri；"PingCode 后台是否仍强制注册 redirect_uri"这一事实无法从代码确认，按中性措辞重写。
  - C `backend/directory-structure.md:20-54`：缺 5 项实际文件——`src/cli/prompts/`（target-select.ts）、`src/core/skill-ops.ts`、`src/core/update-check.ts`、`src/core/jsonInput.ts`、`test/helpers/`（cli.ts/fake.ts，quality-guidelines.md:45 已引用但目录文档未列）。
  - F1/F2/F3：`guides/code-reuse-thinking-guide.md:147-223` 与 `guides/cross-layer-thinking-guide.md:126-219,223-287` 是未替换的 Trellis 模板（描述 Python trellis 仓库），后者还有两节重复；`guides/index.md:36` 三层措辞（API/Service/Component/Database）与实际 cli/api/core 三层不符。
  - G1 `README.md:195`：auth 模块 "not implemented"/"452 actually callable" 过时（paste-only authorization_code 已实现）。
- **工作树状态**：skill-multiselect（09-09）在途改动未提交：src/cli/commands/skill.ts、src/core/paths.ts、src/core/skill-ops.ts、src/cli/prompts/、src/core/agent-detect.ts、src/core/skill-targets.ts、test/paths.test.ts、test/cli/、README.md、package.json、package-lock.json、tsup.config.ts、.github/workflows/ci.yml、.trellis/spec/backend/directory-structure.md + 2 个 staged deletions（scripts/install-skill.ts、test/install-skill.test.ts）。
- 用户原话："推送吧,它会自动发版的,但是在推送之前，你最好先看我现有的 CI 代码，重新写我们的团队规范文档，因为我感觉可能有些spec已经过时了"

## Requirements

- **R1 spec 过时点修复（全部，用户确认"全部修，含 guides 模板"）**：
  - R1.1 `guides/versioning.md:49-50`：换成本项目现存特性作示例（MINOR 例：新增命令/flag；PATCH 例：修 bug——不用已删特性）。
  - R1.2 根 `VERSIONING.md`：与 spec/guides/versioning.md 对齐——改为指向 spec 版的简短指针（先 grep 确认无其他引用依赖其独立内容）。
  - R1.3 `backend/database-guidelines.md:111-116`：Gotcha 重写为 paste-only 事实（CLI 不发 redirect_uri；用户从地址栏复制 code；若实例强制注册则注册任一地址）。
  - R1.4 `backend/directory-structure.md`：补 5 项缺失（prompts/、skill-ops.ts、update-check.ts、jsonInput.ts、test/helpers/）。
  - R1.5 `guides/index.md:36`：三层措辞改 cli/api/core。
  - R1.6 `guides/code-reuse-thinking-guide.md` + `guides/cross-layer-thinking-guide.md`：Trellis 模板内容重写为 pingcode-cli 语境（跨层指南去重：两节重复合并为一）。
  - R1.7 `README.md:195`：auth 模块描述更新为已实现（--mode user 粘贴登录 + --code 直通）。
- **R2 版本 bump**：package.json 1.9.0 → 2.0.0，独立 commit `chore: bump version to 2.0.0 (breaking: remove --channel and oauthRedirectUri)`。
- **R3 skill-multiselect 连带提交**：把工作树在途改动按逻辑提交（feature commit，message 按其任务设计定），staged deletions 随其提交。
- **R4 全量验证**：合并树 typecheck + test + build 全绿后才推。
- **R5 推送发版**：push origin main → 验证 release.yml（v2.0.0 GitHub Release + tag）与 publish.yml（npm publish 2.0.0）结果。两工作流对同一 push 会并行触发（bump 触及 package.json），需推后检查 release 产物是否冲突（已知 CI 设计如此，属既有行为）。
- **R6 Trellis 收尾**：本任务产物提交 + journal + archive（按流程）。

## Acceptance Criteria

- [ ] AC1：R1.1–R1.7 全部过时点修复落盘；修复后 spec 与代码实际一致（抽查 A/B/C/G 锚点）。
- [ ] AC2：package.json = 2.0.0，bump 为独立 commit。
- [ ] AC3：skill-multiselect 改动已提交（含 2 个 deletions）。
- [ ] AC4：`npm run typecheck && npm test && npm run build` 全绿（合并树）。
- [ ] AC5：push 成功；GitHub 上 v2.0.0 release 存在（带 tarball 资产）；npm registry 上 2.0.0 已发布。
- [ ] AC6：本任务 Trellis 产物（prd/design/implement/jsonl + journal + archive）收尾完成。

## Out of scope

- 修改 CI 工作流本身（release/publish 并行触发同版本 release 的重叠问题属既有设计，推后若真出问题再单独处理）。
- frontend/ spec 模板（刻意留空，index.md 声明"本项目无前端"——非缺陷）。
- catalog-drift / live-verification 等已验证无过时的文档。
- skill-multiselect 任务自身的实现改动（只提交不新改）。

## Open questions

无阻塞项。三个决策已确认：bump 2.0.0、全部修 spec（含 guides）、连带推 skill-multiselect。
