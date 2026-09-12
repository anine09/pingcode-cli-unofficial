# Implement — skill install 对齐 gh：全量 agent 目录 + 交互式多选

设计：`design.md`。研究：`research/gh-skill-registry.md`（48-agent 表在这里，**不要再抓 gh 源码**）。

执行顺序即依赖顺序：core 数据层先落，cli 层才能接线，文档最后。
每一步都要在本地验证通过再进入下一步。

## 依赖安装（前置，第一步）

```bash
npm install @clack/prompts@^1.8.0
```

装完确认 `package.json` 的 `dependencies` 里有 `@clack/prompts`，且 `git diff package.json` 里的 lock 变更只涉及它与其传递依赖（`@clack/core`、`sisteransi`、`fast-wrap-ansi`、`fast-string-width`）。

## S1 — Catalog（`src/core/paths.ts`）

改动：把硬编码的 2 个 target 换成 `AGENT_SPECS: readonly AgentSpec[]`（48 条，gh 顺序）+ `skillTargets()` 映射。
- 字段：`{ id, name, dir, envScoped?, aliases? }`（design D1）。
- 48 条数据照抄 `research/gh-skill-registry.md` §2 的表，**一字不改**（id / name / dir 全对齐 gh）。
- `opencode` 是唯一 `envScoped: true` 的条目（dir `.config/opencode/skills/pingcode`）。
- `claude-code.aliases = ['claude']`。
- 保留 `opencodeConfigDir()` 与 `SkillTarget` 的现有形状；`skillTargets()` 的签名（`env = process.env`）与返回值 `SkillTarget[]` 不变。

验证：`npm run typecheck`

## S2 — `--target` 解析（`src/core/skill-targets.ts`，新）

导出 `TargetResolution` 与 `resolveTargetList(raw, env = process.env)`（design D2）。
- 纯函数，只 import `./paths`，**不 import cli**。
- `all`（大小写不敏感）→ 全部。
- 逗号切分 + trim + 小写 + 保序去重 + 丢弃空串。
- `--target ''`（或只有逗号/空格）→ 视同"未给"：返回 `all`。这一步在 **cli 层**判断更清楚，所以 `resolveTargetList('')` 也直接返回 `all`，保持两处一致。
- 未知值收集进 `unknown`，并把 `valid`（48 个 id + `all`）一并返回供报错文案使用。

验证：`npm run typecheck`

## S3 — 当前 agent 探测（`src/core/agent-detect.ts`，新）

导出 `detectCurrentAgent(env: NodeJS.ProcessEnv = process.env): string | undefined`（design D4）。
- 阶梯顺序照 design D4，逐条短路返回；`AI_AGENT` 原样返回（不校验，gh 同）。
- PATH 判断用 `env['PATH']?.split(path.delimiter).includes(...)` —— **注意**：这会引入 `node:path`，仍是零**运行时**依赖，允许。
- 纯函数，无副作用。

验证：`npm run typecheck`

## S4 — 去重 + dry-run（`src/core/skill-ops.ts`）

- 新增私有 `groupByDir(targets): Map<string, SkillTarget[]>`，按 `target.dir` 分组、保持首次出现顺序。
- `installSkill(sourceRoot, targets, force = false, dryRun = false)`：
  - 源 `skills/pingcode` 不存在 → 保持原样（全部 `not-found`）。
  - 否则按 dir 分组：每组 `mkdirSync`（dry-run 跳过）→ 逐文件 `existsSync` 判定 → `copyFileSync`（dry-run 跳过）。
  - 每组产出一条 `InstallResult`：`target` = 该组 label 用 `, ` 连接；`path` = dir；`action` 取该组实际执行的动作。
  - 单 target 组时 label 与现在完全一致（无回归）。
- `uninstallSkill(targets, dryRun = false)`：同样按 dir 分组，`rmSync` 在 dry-run 跳过。
- `listSkillStatus` **一行不改**（48 行 per-target）。

验证：`npm run typecheck` + `npm test -- test/core/skill-ops.test.ts`（既有用例必须全绿）

## S5 — 交互（`src/cli/prompts/target-select.ts`，新）

- `TargetPromptIO` + `chooseTargets(targets, io)`（design D3）。
- `select` 的默认实现用**动态** `import('@clack/prompts')` 拿 `multiselect`：
  - `options` = `targets.map(t => ({ value: t.name, label: `${t.name} (${t.id})`, hint: t.dir }))`
  - `initialValues` = 默认勾选的 `name[]`
  - `required: false`（允许一个都不选 → 视为 abort，返回 null，不写盘）
  - `isCancel(result)` → 返回 `'aborted'`
- `canPrompt()` 的默认实现：`Boolean(process.stdout.isTTY) && !process.env['CI']`
  —— CI 环境下即使有 TTY 也不弹（CI 日志里交互组件会输出乱码）。**`--json` 与 `--no-interactive` 的拦截在 cli 命令层做**（见 S6），不塞进 `canPrompt`。
- 提示文字与进度输出全部走 `@clack/prompts` 自己的通道（stderr），`--json` 下永不创建。
- 导出 `defaultTargetIO` 供命令层使用；测试注入 fake io。

验证：`npm run typecheck`

## S6 — 接线（`src/cli/commands/skill.ts`）

- 新增 `resolveSelection(flags): SkillTarget[]`：
  1. `raw = flags.target`
  2. `raw` 未定义或为空 → `all`
  3. `resolveTargetList(raw)`；`ok: false` → `throw new UsageError(\`unknown target: ${unknown.join(', ')}\nsupported: ${valid.join(', ')}, all\`, { hint: 'run `skill list` to see where the skill is installed' })`
- 新增 `maybeChooseTargets(flags, mode, allTargets): Promise<SkillTarget[] | null>`：
  - `mode.json` → 返回 `allTargets`（不弹）
  - `flags.target` 有值 → 返回 `resolveSelection(flags)`（不弹）
  - 否则 `io.canPrompt()` 为假 → 返回 `allTargets`（**保持现有自动化行为：非 TTY 装全部**）
  - 否则：默认勾选 = `listSkillStatus(allTargets).filter(s => s.installed).map(s => s.target.name)` ∪ `detectCurrentAgent()`（若命中）→ `await chooseTargets(allTargets, io)`；返回 null → 打一行 dim `aborted` 到 stderr 并返回 null。
- `runInstall` / `runRemove` / `runUpdate` 改为：
  ```ts
  const targets = await maybeChooseTargets(flags, mode, skillTargets());
  if (targets === null) return;            // aborted: 写盘 0 次，退出 0
  const results = installSkill(sourceRoot, targets, force, flags.dryRun ?? false);   // remove/update 同理
  renderResults(results, mode);
  ```
- `--target` 的 `.option(...)` 描述改为 `agent id(s), comma-separated, or "all"`（design D8）。
- 给三个子命令加 `.option('--no-interactive', 'do not prompt when stdout is a TTY')`。
- `runList` 不弹交互、不接 dry-run（行为不变，R7）。

验证：`npm run typecheck`

## S7 — 删除 `scripts/install-skill.ts`

```bash
git rm scripts/install-skill.ts test/install-skill.test.ts
```

- `package.json`：`"skill:install": "node dist/bin/pingcode.js skill install"` + 新增 `"preskill:install": "npm run build"`。
- `.github/workflows/ci.yml`：删掉 `if: matrix.node != '20'` 与它上面那段解释注释；`npm run skill:install -- --dry-run` 这一行**字符串不动**。
- `test/workflows.test.ts:211` 的 gate-order 断言继续成立，不改。
- `npm run build && npm run skill:install -- --dry-run` 手动确认非 TTY 下列出 43 条计划、不写盘、退出 0。

验证：`npm run typecheck && npm test`

## S8 — 构建内联（`tsup.config.ts`）

`noExternal` 从 `['commander', 'picocolors']` 扩到：

```ts
noExternal: ['commander', 'picocolors', '@clack/prompts', '@clack/core', 'sisteransi', 'fast-wrap-ansi', 'fast-string-width'],
```

理由写进 tsup.config.ts 现有的那条长注释旁边（发布产物无 `node_modules`）。
`npm run build` 后确认 `dist/bin/pingcode.js` 体积增长在预期内（clack 很小），且 `node dist/bin/pingcode.js skill install --dry-run` 仍正常。

## S9 — 测试

新增（见 design D10）：
- `test/core/skill-catalog.test.ts`
- `test/core/skill-targets.test.ts`
- `test/core/agent-detect.test.ts`
- `test/cli/skill-prompts.test.ts`

更新：
- `test/paths.test.ts`：`claude` → `claude-code`（+ 断言 `claude` 别名仍可解析）
- `test/help/__snapshots__/skill.test.ts.snap`：`npm test -- -u test/help/skill.test.ts`，只动该 snap 文件，确认 diff 仅是 `--target` 描述与新增的 `--no-interactive` 行

验证：`npm test`（全绿；基线 85 文件 / 2911 tests）

## S10 — 文档

- `README.md` skill 段落（约 :742-760）：目标数量、43 个真实目录的说明、`--dry-run`、交互说明、`claude` 别名、未知值 exit 2。
- `skills/pingcode/SKILL.md`（约 :428）：同步同一批说法 —— 它是被安装的 payload，改它等于改用户拿到的 skill。
- `.trellis/spec/backend/directory-structure.md:51`：删掉 `scripts/install-skill.ts` 那行。
- 不要新增 README 里的 48 行大表（会淹没正文），指向 `skill list` 与 `skill install --help` 作为发现入口。

验证：`npm test`（`test/help/skill.test.ts` + `test/scan-secrets.test.ts` 全绿）

## 验收门（全部跑完才算完成）

```bash
npm run typecheck
npm test
npm run build
node dist/bin/pingcode.js skill install --dry-run                 # 非 TTY：43 条计划，写盘 0 次，exit 0
node dist/bin/pingcode.js skill install --target nosuchagent      # stderr 列合法 id，exit 2
node dist/bin/pingcode.js skill install --target claude           # 与 --target claude-code 同一 dir
node dist/bin/pingcode.js skill install --target codex,cline,universal,warp   # ~/.agents/skills/pingcode 只写一次
```

手工交互验证（TTY）：`node dist/bin/pingcode.js skill install` 应弹出 clack 多选，已安装的 agent 与探测到的当前 agent 默认勾选，`space` 勾选、`enter` 确认、`Ctrl-C` 取消且写盘 0 次。

## 提交

遵循 `.trellis/spec/guides/commit-conventions.md` 与 `gitflow.md`。
改动集中在 `feat(skill): 全量 agent 目录 + 交互式多选` 一个提交即可（无外部发布动作）。
