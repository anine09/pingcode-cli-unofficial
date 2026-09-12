# skill install 对齐 gh：全量 agent 目录 + 交互式多选

## Goal

把 `pingcode skill` 的 agent 覆盖面从 2 个扩到与 `gh skill` 同级的 48 个，并在 TTY 下提供复选框式多选安装，同时修掉 `--target` 静默吞掉未知值的缺陷。

研究记录：`research/gh-skill-registry.md`。

## Background

- `src/core/paths.ts:44 skillTargets()` 硬编码 `claude` / `opencode` 两个 target。
- `src/cli/commands/skill.ts` 的 `install` / `remove` / `update` 只接受 `--target` 字符串，没有任何交互；`resolveTargets()` 对未知名字执行 `filter`，结果是**静默什么都不装**（连 `?` 提示都没有）。
- 唯一有交互的是 `scripts/install-skill.ts:173 promptForTargets()`（readline 行式复选框 + 过滤），但它只在开发 checkout 里跑、同样只有 2 个 target，且与 CLI 各存一份 target 表。
- `gh skill install`（cli/cli trunk）用一个 `[]AgentHost` 表驱动 48 个 agent，交互用 `huh` 的 MultiSelect，并按目标目录去重（48 → 43 个真实目录）。

## Requirements

### R1 — 单一 agent 目录表

- `src/core/paths.ts`（零依赖，`node:os` + `node:path`）承载 48 个 agent 的 `{ id, name, dir }`，**global（user）scope only**。
- 顺序沿用 gh：热门在前，其余按 id 字母序。这个顺序同时用于交互列表、help 文本与报错文案。
- 48 个 agent 收敛为 **43 个互不相同的 global 目录**（`.agents/skills` ×4、`.config/agents/skills` ×3）。
- `skillTargets()` 的签名与调用方（`src/core/update.ts:543`、`src/cli/commands/selfUpdate.ts:150/221/230`）保持不变。
- `claude-code` 的 global 目录仍是 `~/.claude/skills`（不引入 `CLAUDE_CONFIG_DIR` 覆盖）；`opencode` 仍受 `XDG_CONFIG_HOME` 覆盖。

### R2 — 交互式复选框多选

- `install` / `remove` / `update` 在 **TTY 且未给 `--target`** 时弹多选；`--json`、非 TTY、`--no-interactive` 一律不弹。
- 多选默认勾选 = **已安装的 agent**（global dir 已存在）+ **探测到的当前 agent**。
- 交互只写在 `src/cli/` 层，`core` 不碰 TUI。

### R3 — `--target` 语义

- 仍是逗号分隔、大小写不敏感，`all` = 全部。
- **未知值必须报错**（exit `2`），错误信息列出合法 id —— 与 `scripts/install-skill.ts:165` 现有行为对齐。
- 历史值 `claude` 继续可用（映射到 `claude-code`）；`opencode` 不变。

### R4 — 按目录去重

- 多个 agent 落到同一 global 目录时只写一次，输出里带上覆盖到的 agent 列表。

### R5 — `--dry-run`

- `install` / `remove` / `update` 支持 `--dry-run`（`SkillFlags.dryRun` 已声明但未接线），只打印计划不写盘。

### R6 — 单一实现

- 删除 `scripts/install-skill.ts`；`npm run skill:install` 改为调用构建产物 `dist/bin/pingcode.js skill install`。
- CI 的 `skill:install --dry-run` 改走同一路径。

### R7 — `skill list`

- 行为不变（目录顺序、`--json` 形状），接受 48 行输出。

### R8 — 可搜索多选（追加需求）

用户原话："我想在 pingcode skill install 的地方不仅可以多选,还可以搜索, gh skill 是支持这种功能的"。

- TTY 且无 `--target` 时的多选支持**输入搜索过滤**：`@clack/prompts` 的 `multiselect` 换成 `autocompleteMultiselect`。
- **无需自定义 filter**：默认 filter（label OR hint OR value 小写子串，空串全匹配）已够用——label 为 `Name (id)` 格式，搜 `claude` 同时命中名称和 id。
- 文案：message `Search and select target agent(s):`，placeholder `Type to search...`。
- 键位（clack 默认）：输入过滤、`space` 勾选、`enter` 确认。
- `TargetPromptIO` 接口不变（`select(labels, defaultIndexes)`），`chooseTargets`、`skill.ts`、`skill-prompts.test.ts` 零改动。
- gh 对照：gh 选 agent 用 huh v2 MultiSelect **无搜索**；搜索框（`multiSelectSearchField`）是 gh 从 repo 选 skill 用的。本功能在 gh agent 选择基础上增强——用户明确要求。

## Constraints

- `src/core/paths.ts` 保持零运行时依赖；交互组件只能加在 `cli` 层。
- `--json` 时 stdout 只能是 JSON；提示与日志走 stderr。
- 不引入 project scope（只装全局，这是已写明的既有决定）。
- 退出码表是稳定契约：未知 target → `2`。
- 不改变 `syncSkills` 的"只同步已存在目录"语义（这是扩 catalog 的安全前提）。

## Acceptance Criteria

- [ ] `skillTargets()` 返回 48 个 target，id 唯一，dir 唯一集合为 43，全部落在 `$HOME/<dir>/pingcode`。
- [ ] `skill install --target claude` 与 `--target claude-code` 等价；`--target nosuchagent` 退出 `2` 并在 stderr 列出合法 id。
- [ ] `skill install --target codex,cline,universal,warp` 只往 `~/.agents/skills/pingcode` 写一次。
- [ ] TTY 且无 `--target` 时出现复选框多选；`--json` 与非 TTY 下绝不出现提示。
- [ ] 多选带搜索框（`autocompleteMultiselect`，placeholder `Type to search...`）；输入 `claude` 同时命中名称与 id；`TargetPromptIO.select` 签名不变。
- [ ] 已安装的 agent 与探测到的当前 agent 在多选里默认勾选。
- [ ] `skill install --dry-run` 不创建任何目录或文件。
- [ ] `scripts/install-skill.ts` 已删除，`npm run skill:install` 与 CI 都走 `dist/bin/pingcode.js skill install`。
- [ ] `npm run typecheck && npm test && npm run build` 全绿。
- [ ] README 的 skill 段落更新到新 target 数量、交互说明与 `--dry-run`。

## Out of Scope

- project scope（git root）安装。
- `--agent` 作为 `--target` 的别名（避免一个 flag 两个名字）。
- skill 的远端拉取 / 版本锁（gh 有，我们没有）。
