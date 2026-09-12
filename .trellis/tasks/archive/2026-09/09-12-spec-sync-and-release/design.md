# design.md — spec 更新与推送发版

## 1. 总体方案

本任务 = spec 文档修复（纯文档）+ 版本 bump（package.json 一行）+ skill-multiselect 提交（已完成的在途工作）+ 推送发版（CI 驱动）。无新代码逻辑。

```
Phase A  spec 文档修复（7 处，见 §2）
Phase B  skill-multiselect 提交（按 git diff 逻辑分组）
Phase C  版本 bump：package.json 1.9.0 → 2.0.0（独立 commit）
Phase D  全量验证（合并树 typecheck + test + build）
Phase E  push origin main → release.yml + publish.yml 自动发版 → 验证结果
Phase F  Trellis 收尾（产物提交 + journal + archive）
```

顺序约束：B 在 C 前（bump 必须是 package.json 的最后一个改动，publish.yml 依赖"该 push 触及 package.json"）；D 在 E 前；A 可并行 B（不同文件，无冲突——但 A 改 README.md、B 也改 README.md！见 §3 冲突处理）。

## 2. spec 修复清单（逐条，含目标内容）

### R1.1 guides/versioning.md:49-50
- 现状：MINOR 行示例 `add --channel/--code`（--channel 已删）、PATCH 行示例 `fix the loopback hint`（loopback 已删）。
- 目标：换成本项目现存特性。MINOR 例可用 `add a new command group` / `add --all flag`；PATCH 例用真实 bug 类（如 `fix the paste hint`）。具体措辞实施时读该表后定，原则：示例特性必须在当前代码中存在。

### R1.2 根 VERSIONING.md
- 现状：spec/guides/versioning.md 的旧分叉副本（exp-2 diff：缺 src/version.ts 行、缺 GitFlow Release Flow 节）。
- 目标：先 grep 全仓（README、spec、docs）确认无人依赖根 VERSIONING.md 的独立内容；然后把根 VERSIONING.md 改写为简短指针（"见 .trellis/spec/guides/versioning.md"），删除重复正文。若发现强引用则改为同步更新两份。

### R1.3 backend/database-guidelines.md:111-116
- 现状：Gotcha 说 "redirect_uri 注册是强制的" 并给 loopback 地址示例。
- 事实：oauthRedirectUri 配置键已删，CLI authorize URL 只带 response_type+client_id（oauth.ts:29）。PingCode 后台是否强制注册 redirect_uri 无法从代码确认。
- 目标：中性重写——"paste 模式下 CLI 不发送 redirect_uri；用户从地址栏复制 code；若你的 PingCode 实例强制要求注册 redirect_uri，注册任一地址即可（CLI 不使用该值）"。不断言"强制"也不断言"不强制"。

### R1.4 backend/directory-structure.md:20-54
- 补 5 项：`src/cli/prompts/`（target-select.ts）、`src/core/skill-ops.ts`、`src/core/update-check.ts`、`src/core/jsonInput.ts`、`test/helpers/`（cli.ts、fake.ts）。
- 每项一句话说明用途（从 exp-2 报告的用途描述取）。

### R1.5 guides/index.md:36
- "Feature touches 3+ layers (API, Service, Component, Database)" → 本项目实际三层："(CLI command, core, API)"。

### R1.6 guides/code-reuse-thinking-guide.md + cross-layer-thinking-guide.md
- 现状：Trellis 模板原文（Python cli_adapter.py、rsync、@mindfoldhq/trellis 等），与本 Node CLI 无关；cross-layer 还有两节重复（126-219 与 223-287）。
- 目标：按 pingcode-cli 实际重写：
  - code-reuse：本项目的复用模式——src/core/ 共享模块（errors.ts、config.ts、context.ts、catalog/）、src/cli/commands/_shared/、test/helpers/、命令注册表；"先搜后写"的工作流（codegraph/explorer）。
  - cross-layer：cli→core→api 分层规则、跨层数据流（Ctx 贯穿）、错误契约跨层传递。
  - cross-layer 去重：合并重复两节。
- 这是内容创作，需要读现有 spec（backend/directory-structure.md、quality-guidelines.md）保持一致。

### R1.7 README.md:195
- 现状：auth 模块行 "the two user-token grants are not implemented" + 同段 "the authorization-code flow is not implemented" + "452 actually callable"。
- 目标：改为已实现——`auth login --mode user`（粘贴登录，extractCode 解析 URL/code）、`--code` 直通；user 端点经 /v1/myself verify 可达。具体措辞读该段后定。

## 3. 冲突处理：README.md 双写

Phase A（R1.7）和 Phase B（skill-multiselect 提交）都碰 README.md。
- 方案：先完成 A 的 README 编辑并提交（Phase A commit），再做 B——B 提交时 README 已含 A 的改动，B 的 skill-multiselect README 改动叠加其上。两 commit 顺序：spec commit 先，skill commit 后（或反之，只要不并行编辑同一文件即可）。
- 实际上：所有编辑在 orchestrator 会话串行完成，无并行写冲突风险。A 与 B 分成不同 commit。

## 4. 版本 bump（Phase C）

- package.json version: 1.9.0 → 2.0.0。
- 独立 commit：`chore: bump version to 2.0.0 (breaking: remove --channel and oauthRedirectUri)`（commit-conventions.md:153 要求 bump 独立 commit）。
- bump 必须在 skill-multiselect 的 package.json 改动提交之后（skill 改动可能也动 package.json——bump 取其最终态 +0.1.0 语义上独立）。

## 5. 推送与自动发版（Phase E）

推送 origin main 后：
- `release.yml`（无条件）：读 package.json → 2.0.0；tag v2.0.0 不存在 → 全量门禁 → tag + GitHub Release（带 tarball）。
- `publish.yml`（触及 package.json）：bump commit 触及 → typecheck+build → npm publish 2.0.0（--provenance）。
- 两工作流并行触发同一版本 release 是既有 CI 设计（exp-1 确认）；publish.yml 建的 release 无资产、release.yml 的带 tarball，softprops 幂等更新。推后验证：`gh release view v2.0.0`、`npm view pingcode-cli version`（包名待确认——查 package.json name）。
- 验证失败（如 CI 红）→ 按 release.yml:26-28 回滚说明（gh release delete + 删 tag）或修复后重推。

## 6. 风险

- 中：npm publish 需要 NPM_TOKEN secret 在 GitHub 仓库配置好——若未配置，publish.yml 会红。推后必须检查 workflow run 状态。
- 低：release/publish 并行建同一 release 的竞态（既有设计，release.yml 有 skip 守卫）。
- 低：guides 重写内容质量（内容创作，无客观对错，以"不再含 Trellis 模板残留、与 backend spec 一致"为准）。
- 低：skill-multiselect 改动未经本会话验证——Phase D 合并树全量测试会覆盖。

## 7. 回滚

- 推送前：git reset 本地 commit 即可。
- 推送后（release 已建）：`gh release delete v2.0.0` + `git push origin :refs/tags/v2.0.0`（release.yml:26-28）。npm publish 不可撤回（可 deprecate：`npm deprecate`）。
