# Design — skill install 对齐 gh：全量 agent 目录 + 交互式多选

研究记录：`research/gh-skill-registry.md`（gh 2.100.0 源码与本地 `gh skill install --help` 双重验证）。
Spec：`.trellis/spec/backend/index.md` + `guides/*`（code-reuse / cross-layer / versioning / gitflow / commit-conventions）。

## D0 — 分层与文件落位

| 层 | 文件 | 职责 |
|---|---|---|
| core | `src/core/paths.ts` | 48-agent catalog（`AGENT_SPECS`）+ `skillTargets()`；仍零运行时依赖 |
| core | `src/core/skill-targets.ts`（新） | `--target` 解析、别名、`all`、去重、未知值判定（纯函数） |
| core | `src/core/agent-detect.ts`（新） | 从 env 探测当前 agent id（纯函数，端口 gh `detect.go`） |
| core | `src/core/skill-ops.ts` | 写盘层按 `dir` 去重；`installSkill`/`uninstallSkill` 接 `dryRun` |
| cli | `src/cli/prompts/target-select.ts`（新） | 多选交互（**动态** `import('@clack/prompts')`）+ 可注入 io |
| cli | `src/cli/commands/skill.ts` | 接线：解析 → 交互 → dry-run → 渲染 → 错误 |
| build | `tsup.config.ts` | `noExternal` 增加 clack 传递依赖 |
| build | `package.json` | 新增 `@clack/prompts` runtime dep；`skill:install` 改走构建产物 |
| del | `scripts/install-skill.ts`、`test/install-skill.test.ts` | 单一实现，删掉第二份 target 表 |

`cli → {api, core}`、`api → core`、`core` 不反向依赖（`test/layering.test.ts` 强制）。
`core` 层三个文件都不引入 TUI，也不 import `cli/`。
`--json` 时 stdout 只出 JSON；提示与日志一律 stderr。

## D1 — Catalog（`src/core/paths.ts`）

现状 `skillTargets()` 硬编码 2 个 target。改为表驱动：

```ts
interface AgentSpec {
  /** canonical `--target` value */
  id: string;
  /** display name */
  name: string;
  /** dir relative to $HOME — or to the env-scoped config dir when `envScoped` */
  dir: string;
  /** `opencode`: resolved against `$XDG_CONFIG_HOME` instead of `$HOME` */
  envScoped?: boolean;
  /** legacy `--target` spellings still accepted */
  aliases?: readonly string[];
}
const AGENT_SPECS: readonly AgentSpec[] = [ /* 48 entries, gh order */ ];

export function skillTargets(env: NodeJS.ProcessEnv = process.env): SkillTarget[]
```

- 48 条，顺序 = gh `registry.Agents` 原文：热门 5 个在前（`github-copilot`、`claude-code`、`cursor`、`codex`、`gemini-cli`），其余按 id 字母序。**同一顺序喂交互列表、报错文案与 help**。
- `dir` 是相对路径字符串（如 `.claude/skills/pingcode`、`.agents/skills/pingcode`），只有 `opencode` 一条带 `envScoped: true`（dir `.config/opencode/skills/pingcode`）。`skillTargets()` 里 `path.join(home, spec.dir)` 展开为绝对路径 —— 这样 paths.ts 里没有 48 个手写的 `path.join`，且零依赖性质不变（仍只有 `node:os`/`node:path`）。
- `SkillTarget` 保持 `{ name, label, dir }`，**签名与 8 个调用方不变**：`src/core/update.ts:543`、`src/cli/commands/selfUpdate.ts:150/221/230`、`src/cli/commands/skill.ts`。
- `label` = `${name} (global)`，与现有 `Claude Code (global)` 一致。
- `claude-code` 的 dir 仍是 `~/.claude/skills/pingcode`，**不引入 `CLAUDE_CONFIG_DIR` 覆盖**（gh 有，我们不抄；已有 XDG 套路够用）。
- 48 agent → **43 个互不相同的 dir**：`.agents/skills` ← `codex`/`cline`/`universal`/`warp`；`.config/agents/skills` ← `amp`/`kimi-cli`/`replit`。
- `claude-code.aliases = ['claude']`，保证历史 `--target claude` 继续可用。

## D2 — `--target` 解析（`src/core/skill-targets.ts`，新，纯函数）

```ts
export type TargetResolution =
  | { ok: true; targets: SkillTarget[] }
  | { ok: false; unknown: string[]; valid: string[] };

export function resolveTargetList(raw: string, env = process.env): TargetResolution
```

- `all`（含大小写）→ 全部 48。
- 否则按 `,` 切分、trim、小写、去空、**保序去重**。
- 每个名字先查 `id`，再查 `aliases`；查不到进 `unknown`。
- 返回 `unknown: string[]` 而非抛错，因为 **退出码属于 cli 层**（`test/layering.test.ts`）。
- cli 侧 `ok: false` → `throw new UsageError(...)`，`exitCodeFor` 自动映射到 **2**（`.trellis/spec/backend/index.md` 的退出码表，`src/core/errors.ts:73`）。报错文案列出全部合法 id（48 个，一行，stderr）。
- `skill list` 也走同一解析（保持"接受 48 行"的既有行为）。

## D3 — 交互（`src/cli/prompts/target-select.ts`，新，cli 层）

```ts
export interface TargetPromptIO {
  /** false when --json, non-TTY, --no-interactive, or not a terminal */
  canPrompt(): boolean;
  /** returns the chosen ids, or 'aborted' */
  select(labels: readonly string[], defaultIndexes: readonly number[]): Promise<string[] | 'aborted'>;
}

export async function chooseTargets(
  targets: readonly SkillTarget[],
  io: TargetPromptIO,
): Promise<SkillTarget[] | null>   // null = aborted
```

- **只在 cli 层**，`core` 不碰 TUI。
- **触发条件**：`flags.target` 未给 且 `io.canPrompt()`（stdout.isTTY 且非 `--json` 且非 `--no-interactive`）。
- UI：`@clack/prompts` 的 `autocompleteMultiselect`（**可搜索多选，R8**），**动态** `import('@clack/prompts')`，所以非交互快路径（`--json`、CI、管道）从不加载它。
  - **决定（R8）**：用户要求多选带搜索（"不仅可以多选,还可以搜索, gh skill 是支持这种功能的"）。`@clack/prompts` 1.8.0 自带 `autocompleteMultiselect`，搜索+多选一体，无需引入第二套 TUI 依赖。
  - **默认 filter 足够**：其默认匹配 = 小写 label OR hint OR value 子串（空输入全匹配）。label 格式为 `Name (id)`（同上条），输入 `claude` 同时命中名称与 id，**不传自定义 `filter`**。
  - 文案：message `Search and select target agent(s):`，placeholder `Type to search...`。
  - 键位：输入过滤 + space 勾选 + enter 确认。
  - gh 对照：gh 选 agent 用 huh v2 `MultiSelect` **无搜索**；带搜索框的 `multiSelectSearchField`（cli/cli 内部）是"从 repo 选 skill"用的。本功能是在 gh agent 选择基础上的增强——用户明确要求。
- 选项 label 用 gh 风格 `- Name (id)`？——不。gh 交互里只显示 Name，因为我们有 48 条；为可读性用 `Name (id)`。**决定：label = `${name} (${id})`**，与 `skill list` 的 label 区分开。
- **默认勾选** = 已安装（`listSkillStatus` 里 `installed: true` 的 dir）∪ 探测到的当前 agent（D4）。
- 顺序：**catalog 顺序**（gh 同）。
- 返回 `null`（aborted / Ctrl-C）→ 不写任何东西，exit 0，stderr 一行 dim 提示。**不新增退出码**，退出码表是稳定契约。
- 可注入 `io` 让测试不需要 TTY。

## D4 — 当前 agent 探测（`src/core/agent-detect.ts`，新，纯函数）

端口 gh `internal/agents/detect.go` 的 env 阶梯，映射到我们的 agent id：

```
AI_AGENT              → 原样（若命中已知 id）
AGENT=amp             → amp
CODEX_SANDBOX / CODEX_CI / CODEX_THREAD_ID → codex
GEMINI_CLI            → gemini-cli
COPILOT_CLI           → github-copilot
OPENCODE              → opencode
ANTIGRAVITY_AGENT     → antigravity
AUGMENT_AGENT         → augment
REPL_ID               → replit
CLAUDE_CODE_IS_COWORK / CLAUDECODE / CLAUDE_CODE → claude-code
CURSOR_TRACE_ID / CURSOR_AGENT → cursor
TERM_PROGRAM=kiro     → kiro-cli
PATH 含 /.pi/agent    → pi
GOOSE_PROVIDER        → goose   （最后）
```

- `detectCurrentAgent(env): string | undefined`，零依赖，纯函数，可单测。
- **只用于默认勾选**，不做任何自动安装决定。

## D5 — 按 dir 去重 + dry-run（`src/core/skill-ops.ts`）

- `installSkill` / `uninstallSkill` 内部按 `target.dir` 分组：**同一 dir 只写/删一次**。
- 每个唯一 dir 产出一条 `InstallResult`，`target` = 该 dir 覆盖的 agent label 用 `, ` 连接（例：`Codex, Cline, Universal, Warp`），`path` = dir。这是 48→43 的地方。
- `listSkillStatus` **不变**（仍 per-target 48 行）——`skill list` 行为不变（R7）。
- `installSkill(sourceRoot, targets, force, dryRun?)` / `uninstallSkill(targets, dryRun?)`：dry-run 时跳过所有 `mkdirSync`/`copyFileSync`/`rmSync`，只读 `existsSync` 来判断会是什么动作（`written`/`overwritten`/`removed`/`skipped`/`not-found`），因此输出形状一致、只是不写盘。
- `not-found` 语义不变：源 `skills/pingcode` 不存在 → 全部 target 返回 `not-found`。

## D6 — 单一实现（删 `scripts/install-skill.ts`）

- `package.json`：
  - `"skill:install": "node dist/bin/pingcode.js skill install"`
  - `"preskill:install": "npm run build"` —— 保证 `dist/` 存在，本地与 CI 命令完全一致。
- `.github/workflows/ci.yml`：`if: matrix.node != '20'` 这个 gate 与它的注释**一起删除**（不再依赖 `--experimental-strip-types`，Node 20 也能跑构建产物）。**`npm run skill:install -- --dry-run` 这一行字符串保持不变**，`test/workflows.test.ts:211` 的 gate-order 断言继续成立。
- 删除 `test/install-skill.test.ts`（227 行，三个 describe 全被取代：`parseArgs` → commander；`selectTargets` → `test/core/skill-targets.test.ts`；`collectPayload` → 既有 `test/core/skill-ops.test.ts`）。

## D7 — 依赖与构建

- `package.json` 新增 runtime dep `"@clack/prompts": "^1.8.0"`（`npm view` 于 2026-09-10：1.8.0）。
- 其传递依赖：`@clack/core@1.5.0`、`sisteransi@^1.0.5`、`fast-wrap-ansi@^0.2.0`、`fast-string-width@^3.0.2`。
- `tsup.config.ts` 的 `noExternal` 从 `['commander', 'picocolors']` 扩到上面 6 个。**必需**：`package.json#files` 只发 `dist`/`skills`/`README.md`，发布产物没有 `node_modules`，不内联就会在运行时炸。
- `sisteransi` 是 CJS；`tsup.config.ts` 已有的全局 banner（`createRequire`）已覆盖所有 js 输出，无需额外处理。

## D8 — help 文本与快照

`--target` 描述从 `comma-separated target(s): claude, opencode, all` 改为
`agent id(s), comma-separated, or "all"`。
→ `test/help/__snapshots__/skill.test.ts.snap` 里 4 个 `skill install/remove/update --help` 快照必须重生成（`vitest -u`，只动该文件）。
48 个合法 id 不进 help（太长），由 unknown-value 报错与 `skill list` 承担发现职责。

## D9 — 文档

- `README.md` 的 skill 段落：目标数量、`--dry-run`、交互说明（TTY 多选 / 非 TTY 装全部）、`claude` 别名、未知值 exit 2。
- `skills/pingcode/SKILL.md`（约 :428，它是被安装的 payload，改它等于改用户拿到的 skill）：同步同一批说法。注意 `test/scan-secrets.test.ts` 会把 `README.md` 当扫描对象，内容改动不影响它。
- `.trellis/spec/backend/directory-structure.md:51` 提到 `scripts/install-skill.ts` → 删掉该行。

## D10 — 测试

新增：
- `test/core/skill-catalog.test.ts` —— 48 条、id 唯一、dir 唯一集合 = 43、全部落在 `$HOME/<dir>/pingcode`、前 5 个是热门序、之后字母序、别名存在。
- `test/core/skill-targets.test.ts` —— `all`、逗号、大小写、空格、保序去重、别名 `claude`→`claude-code`、未知值返回 `unknown`、`--target ''` 视为未给。
- `test/core/agent-detect.test.ts` —— env 阶梯每个分支一条（含 `AI_AGENT` 透传与未知值）。
- `test/cli/skill-prompts.test.ts` —— 注入 fake io：已安装 ∪ 探测默认勾选；非 TTY 不调 select；aborted 返回 null。

更新：
- `test/paths.test.ts` —— `claude` → `claude-code`（`skillTargets({})` 第一个是 `claude-code`）+ 别名解析仍可用。
- `test/help/__snapshots__/skill.test.ts.snap` —— D8。

**不要动**：`test/core/skill-ops.test.ts`、`test/selfUpdate.test.ts`（用自制 fixture，不碰真实 catalog）。
扩 catalog 对 `syncSkills` 安全，因为它只同步 dir 已存在的 target（`research/gh-skill-registry.md` §5）。

## 验证门

1. `npm run typecheck`
2. `npm test`（基线 85 文件 / 2911 tests；改完后重跑全量）
3. `npm run build` 后 `node dist/bin/pingcode.js skill install --dry-run`（非 TTY：列出 43 条计划，不写盘；退出 0）
4. `node dist/bin/pingcode.js skill install --target nosuchagent` → stderr 含合法 id，退出 2
5. `node dist/bin/pingcode.js skill install --target claude` 与 `--target claude-code` 指向同一 dir
6. `node dist/bin/pingcode.js skill install --target codex,cline,universal,warp` → 只往 `~/.agents/skills/pingcode` 写一次

## 不做

- project scope（git root）
- `--agent` 作为 `--target` 别名（一个 flag 两个名字）
- skill 远端拉取 / 版本锁
- `claude-code` 的 `CLAUDE_CONFIG_DIR` env 覆盖
