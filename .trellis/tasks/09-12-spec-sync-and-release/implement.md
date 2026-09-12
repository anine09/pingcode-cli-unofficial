# implement.md — spec 更新与推送发版

## 执行顺序（串行，无并行写冲突）

### Step 1 — spec 文档修复（7 处，design.md §2）

1. `guides/versioning.md:49-50`：两行示例换现存特性（读表后定措辞）。
2. 根 `VERSIONING.md`：grep 确认无强引用 → 改写为指向 `.trellis/spec/guides/versioning.md` 的指针。
3. `backend/database-guidelines.md:111-116`：Gotcha 中性重写（paste 模式不发 redirect_uri；若实例强制注册则注册任一地址）。
4. `backend/directory-structure.md`：补 5 项缺失（prompts/、skill-ops.ts、update-check.ts、jsonInput.ts、test/helpers/）。
5. `guides/index.md:36`：三层措辞改 cli/api/core。
6. `guides/code-reuse-thinking-guide.md` + `guides/cross-layer-thinking-guide.md`：Trellis 模板内容重写为 pingcode-cli 语境；cross-layer 去重（合并重复两节）。写前读 backend/directory-structure.md、quality-guidelines.md 保持一致。
7. `README.md:195`：auth 模块描述更新为已实现。
8. 验证：grep 确认 `--channel`/`loopback`/`not implemented`（auth 段）/Trellis 模板特征词（cli_adapter/rsync/@mindfoldhq）在 spec + README 中清零（--channel 的 ticket 渠道命中除外）。

### Step 2 — spec commit

```
git add .trellis/spec/guides/versioning.md VERSIONING.md .trellis/spec/backend/database-guidelines.md .trellis/spec/backend/directory-structure.md .trellis/spec/guides/index.md .trellis/spec/guides/code-reuse-thinking-guide.md .trellis/spec/guides/cross-layer-thinking-guide.md README.md
git commit -m "docs(spec): sync specs with current code after paste-only login"
```

### Step 3 — skill-multiselect 提交

1. `git diff --stat` 全览工作树剩余改动；读 09-09 任务的 prd/design 确认 feature message 范围。
2. 提交（含 2 个 staged deletions）：message 按其任务性质定，如 `feat(skill): ...`。package.json 的 skill 依赖改动随此 commit。
3. 验证：`git status` 确认工作树只剩 bump 待做。

### Step 4 — 版本 bump 2.0.0

1. package.json version 1.9.0 → 2.0.0。
2. `git commit -m "chore: bump version to 2.0.0 (breaking: remove --channel and oauthRedirectUri)"`（独立 commit，commit-conventions.md:153）。

### Step 5 — 全量验证（合并树）

```
npm run typecheck && npm test && npm run build
```

任一失败 → 修复后重验，不进入 Step 6。

### Step 6 — 推送发版

1. `git push origin main`。
2. 等待 CI：`gh run list --branch main --limit 4`；关注 Release（release.yml）与 Publish to npm（publish.yml）两个 run。
3. 验证产物：
   - `gh release view v2.0.0`（存在、带 tarball 资产）；
   - `npm view <pkg-name> version` = 2.0.0（pkg-name 从 package.json name 字段取）。
4. 失败处理：CI 红 → 看日志修复；npm publish 失败（NPM_TOKEN 未配）→ 告知用户去仓库设置补 secret 后重推（或手动 `npm publish`）。

### Step 7 — Trellis 收尾

1. 提交本任务产物（.trellis/tasks/09-12-spec-sync-and-release/*）。
2. journal 记录（add_session.py 或手动）。
3. `task.py finish` + `task.py archive`（若 finish-work 流程可用优先用命令）。

## 验证命令速查

- grep 过时点：`rg -- '--channel|loopback|cli_adapter|mindfoldhq' .trellis/spec README.md`（排除 ticket 渠道合法命中）
- 全量：`npm run typecheck && npm test && npm run build`
- CI 状态：`gh run list --branch main --limit 4`；`gh run view <id>`

## 风险文件 / 回滚点

- 风险文件：`guides/cross-layer-thinking-guide.md`（重写+去重，内容创作）、`README.md`（双写叠加 skill commit）。
- 推送后回滚：`gh release delete v2.0.0` + `git push origin :refs/tags/v2.0.0`；npm 包已发布则 `npm deprecate`。

## 完成后

- 报告用户：commit 列表、v2.0.0 release URL、npm 包状态。
- 遗留备忘（若发现）：frontend 模板留空属有意；catalog-check 与 spec 无关。
