# Research — `gh skill install` 的 agent 目录与交互实现

Source: `github.com/cli/cli` @ `trunk` (gh 2.100.0), read via `gh api`.
Local evidence: `gh skill install --help` on this machine lists the same 48 agents.

## 1. Agent 目录表是唯一事实源

`internal/skills/registry/registry.go`

```go
type AgentHost struct {
    ID         string // canonical identifier
    Name       string // display name
    ProjectDir string // relative to project root
    UserDir    string // relative to home
}

var Agents = []AgentHost{ /* 48 entries */ }
```

排序规则：**热门 5 个在前，其余按 ID 字母序**。同一个顺序喂给三处消费者：交互列表、help 文本、flag 枚举补全。其余全部派生，没有第二份表：

- `AgentIDs() []string` → `--agent` 的枚举值
- `AgentNames() []string` → 交互提示的 label
- `AgentHelpList() string` → help 里的 `- Name (id)` 列表
- `ValidAgentIDs() string` → 未知值的报错文案
- `UniqueProjectDirs() []string` → 去重后的真实目录

对我们的取舍：我们**只装全局（user scope）**（`src/core/paths.ts` 注释与 `scripts/install-skill.ts` 都写明了这个决定），所以 catalog 只需要 `ID / Name / dir(global)` 三个字段，`ProjectDir` 不抄。

## 2. 全量 48 个 agent（gh 原文顺序）

global（user）目录即 `$HOME/<UserDir>/skills`。

| # | ID | Name | global skill dir |
|---|---|---|---|
| 1 | `github-copilot` | GitHub Copilot | `.copilot/skills` |
| 2 | `claude-code` | Claude Code | `.claude/skills` |
| 3 | `cursor` | Cursor | `.cursor/skills` |
| 4 | `codex` | Codex | `.agents/skills` |
| 5 | `gemini-cli` | Gemini CLI | `.gemini/skills` |
| 6 | `antigravity` | Antigravity | `.gemini/antigravity/skills` |
| 7 | `antigravity-cli` | Antigravity CLI | `.gemini/antigravity-cli/skills` |
| 8 | `antigravity2.0` | Antigravity 2.0 | `.gemini/config/skills` |
| 9 | `adal` | AdaL | `.adal/skills` |
| 10 | `amp` | Amp | `.config/agents/skills` |
| 11 | `augment` | Augment | `.augment/skills` |
| 12 | `bob` | IBM Bob | `.bob/skills` |
| 13 | `cline` | Cline | `.agents/skills` |
| 14 | `codebuddy` | CodeBuddy | `.codebuddy/skills` |
| 15 | `command-code` | Command Code | `.commandcode/skills` |
| 16 | `continue` | Continue | `.continue/skills` |
| 17 | `cortex` | Cortex Code | `.snowflake/cortex/skills` |
| 18 | `crush` | Crush | `.config/crush/skills` |
| 19 | `deepagents` | Deep Agents | `.deepagents/agent/skills` |
| 20 | `devin` | Devin | `.devin/skills` |
| 21 | `droid` | Droid | `.factory/skills` |
| 22 | `firebender` | Firebender | `.firebender/skills` |
| 23 | `goose` | Goose | `.config/goose/skills` |
| 24 | `grok` | Grok | `.grok/skills` |
| 25 | `iflow-cli` | iFlow CLI | `.iflow/skills` |
| 26 | `junie` | Junie | `.junie/skills` |
| 27 | `kilo` | Kilo Code | `.kilocode/skills` |
| 28 | `kimi-cli` | Kimi Code CLI | `.config/agents/skills` |
| 29 | `kiro-cli` | Kiro CLI | `.kiro/skills` |
| 30 | `kode` | Kode | `.kode/skills` |
| 31 | `mcpjam` | MCPJam | `.mcpjam/skills` |
| 32 | `mistral-vibe` | Mistral Vibe | `.vibe/skills` |
| 33 | `mux` | Mux | `.mux/skills` |
| 34 | `neovate` | Neovate | `.neovate/skills` |
| 35 | `openclaw` | OpenClaw | `.openclaw/skills` |
| 36 | `opencode` | OpenCode | `.config/opencode/skills` |
| 37 | `openhands` | OpenHands | `.openhands/skills` |
| 38 | `pi` | Pi | `.pi/agent/skills` |
| 39 | `pochi` | Pochi | `.pochi/skills` |
| 40 | `qoder` | Qoder | `.qoder/skills` |
| 41 | `qwen-code` | Qwen Code | `.qwen/skills` |
| 42 | `replit` | Replit | `.config/agents/skills` |
| 43 | `roo` | Roo Code | `.roo/skills` |
| 44 | `trae` | Trae | `.trae/skills` |
| 45 | `trae-cn` | Trae CN | `.trae-cn/skills` |
| 46 | `universal` | Universal | `.agents/skills` |
| 47 | `warp` | Warp | `.agents/skills` |
| 48 | `zencoder` | Zencoder | `.zencoder/skills` |

**48 个 agent → 43 个互不相同的 global 目录。** 复用关系：

- `.agents/skills` ← `codex`, `cline`, `universal`, `warp`（4 个）
- `.config/agents/skills` ← `amp`, `kimi-cli`, `replit`（3 个）

`claude-code` 的 user dir 在 gh 里受 `CLAUDE_CONFIG_DIR` 覆盖（`registry.go:411 InstallDir`）；我们已用 `XDG_CONFIG_HOME` 覆盖 opencode 的同一套路，catalog 里不复制这层 env 逻辑。

## 3. 交互

`pkg/cmd/skills/install/install.go:907 resolveHosts()` 三段式：

1. `--agent` 有值 → 用它
2. `IO.CanPrompt()` → `Prompter.MultiSelect("Select target agent(s):", []string{"GitHub Copilot"}, labels)`（`:946`），返回 **indices**，再映射回 `registry.Agents`
3. 否则 → `registry.DefaultAgentID`（`github-copilot`）

非交互时默认只装一个 agent；**交互时的默认勾选项是 `github-copilot`**。

UI 实现是 charmbracelet `huh` v2 的 `huh.NewMultiSelect[int]()`（`internal/prompter/huh_prompter.go:73`），另有 `accessiblePrompter`（无障碍退化：编号文本 + 逗号输入）与 `surveyPrompter`（旧回退）。

**重要区分**：选 agent 用的是**无搜索**的 MultiSelect；带搜索框的 `multiSelectSearchField`（`internal/prompter/multi_select_with_search.go`，457 行）是给"从 repo 里选哪个 skill"用的，两者不是一回事。它的键位是 `space/x` 勾选、`↑↓/jk` 移动、`enter` 确认、`shift+tab` 回到搜索框。

## 4. 按目录去重

`install.go:987 buildInstallPlans()`：把选中的 host 按 `resolveInstallDir()` 的结果分组成 `byDir map[string]*installPlan`，落同一目录的多个 host 只装一次，并在提示里把 host 列表一起打印（`formatPlanHosts`）。这是 48→43 的关键。

## 5. 当前调用方的"意外保护"（重要）

`src/core/update.ts:353 syncSkills()` 与 `src/cli/commands/selfUpdate.ts:150` 都只对 **dir 已存在** 的 target 同步：

```ts
for (const target of targets) {
  if (!existsSync(target.dir)) continue;
```

所以把 catalog 从 2 个扩到 48 个 **不会**让 auto-update / `update` 命令往 43 个目录里写文件——它只刷新用户已经装过的目录。这是本改动可以安全扩 catalog 的前提。

## 6. 我们的现状（待改）

| 位置 | 现状 |
|---|---|
| `src/core/paths.ts:44 skillTargets()` | 硬编码 2 个 target（`claude` / `opencode`），label 写死 `(global)` |
| `src/cli/commands/skill.ts:74` | `--target` 逗号列表，**无交互**；`--dry-run` 已声明但 `runInstall` 没用 |
| `src/cli/commands/skill.ts:208 resolveTargets()` | 未知 target **静默 filter 掉**，不报错 |
| `scripts/install-skill.ts:173 promptForTargets()` | readline 行式复选框 + `/` 过滤，同样只有 2 个 target |
| `package.json:27` | `skill:install` 指向该 script |
| `README.md:742-760` | 文档只写 2 个 target |

## 7. gh 里我们不抄的部分

- **project scope**（`resolveScope`，git root vs home）——我们只装全局，是已写明的决定。
- **`--agent` 单值 flag**——我们已有逗号列表，能力是超集。
- **agent 自动探测** `internal/agents/detect.go`（环境变量识别当前 agent）——思路值得抄，用来算交互默认勾选项。
