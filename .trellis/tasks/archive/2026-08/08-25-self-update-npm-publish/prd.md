# PRD: Self-Update via GitHub Releases

## Goal

为 PingCode CLI 添加 `pingcode self-update` 命令，使 CLI 能从 GitHub Releases 自主下载并更新自身，同时在更新过程中强制同步本地 Skill 文档。改造安装脚本支持从 Release zip 安装到 XDG 标准目录。添加 Release 打包脚本用于生成平台化 zip 产物。

## Background

- 当前版本 `v1.5.1`，`package.json` 中 `"private": true`（不发布到 npm）
- 现有更新检查 (`src/core/update-check.ts`) 通过 GitHub Releases API 检查新版本，但仅提示用户手动 `git pull && ./install.sh`
- 现有 Skill 安装 (`scripts/install-skill.ts`) 是独立脚本，从本地 checkout 复制 `skills/pingcode/` 到 `~/.claude/skills/` 和 `~/.config/opencode/skills/`
- 命令注册: 通过 `src/cli/registry.ts` 的 `GROUPS` 数组注册
- 构建工具: tsup，输出 `dist/bin/pingcode.js`（Node.js 脚本，需要 Node >= 20）
- 运行时依赖: commander, picocolors
- 无 CI/CD workflow
- 版本管理: GitFlow + SemVer（VERSIONING.md）
- GitHub 仓库: `anine09/pingcode-cli-unofficial`

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| 分发渠道 | GitHub Releases（不发布 npm） | 用户选择；包保持 private |
| 产物格式 | 平台化 zip（兼容 Linux/macOS/Windows） | 用户选择；zip 跨平台通用 |
| 安装目录 | XDG 标准路径（`~/.local/share/pingcode-cli/` / `%LOCALAPPDATA%/pingcode-cli/`） | 用户选择；遵循平台规范 |
| 任务范围 | 命令 + 打包脚本 + 安装脚本改造 | 用户选择；三者强耦合，缺一不可 |

## Requirements

### R1: self-update 命令
- 添加 `pingcode self-update` 子命令，注册到 `src/cli/registry.ts`
- 复用 `checkForUpdate()` 检测 GitHub Releases 最新版本
- 检测当前平台/架构，匹配对应的 release zip asset
- 下载 zip → 解压到 staging 目录 → 原子替换安装目录
- 更新后验证新版本可用（`--version`）
- 支持 `--dry-run`（预览不执行）、`--check-only`（仅检查不更新）

### R2: 强制 Skill 文档同步
- self-update 完成后，从安装目录的 `skills/` 复制到：
  - `~/.claude/skills/pingcode/`
  - `~/.config/opencode/skills/pingcode/`
- 强制覆盖已存在的文件（不提示确认）
- 包含 `SKILL.md` 和 `modules/*.md`

### R3: Release 打包脚本
- 创建 `scripts/package-release.ts`
- 运行 `npm run build` → 打包 `dist/` + `skills/` 为 zip
- 产物命名: `pingcode-cli-v{version}-{platform}-{arch}.zip`
- 输出到 `release/` 目录
- 添加 npm script: `"package:release"`

### R4: 安装脚本改造
- 修改 `scripts/install.mjs` 支持两种模式：
  - **Repo checkout**（`.git` 存在）: 保留现有 `npm link` 流程（开发用）
  - **Standalone**（无 `.git`）: 从 GitHub Releases 下载 zip → 解压到 XDG 目录 → 创建 bin shim
- Bin shim:
  - Linux/macOS: `~/.local/bin/pingcode` shell 脚本
  - Windows: 对应 `.cmd` 文件

### R5: 更新检查提示改造
- `src/bin/pingcode.ts` 中的更新提示从 `git pull && ./install.sh` 改为 `pingcode self-update`
- 更新相关测试断言

## Acceptance Criteria

- [ ] `pingcode self-update --check-only` 能检测 GitHub Releases 最新版本并报告状态
- [ ] `pingcode self-update --dry-run` 能预览将要执行的操作
- [ ] `pingcode self-update` 能下载对应平台的 zip 并完成更新
- [ ] self-update 后 `pingcode --version` 显示新版本号
- [ ] self-update 后本地 Skill 文档被强制更新到最新版本
- [ ] `npm run package:release` 生成有效的平台化 zip 文件
- [ ] 安装脚本支持从 GitHub Releases 安装到 XDG 目录
- [ ] 现有开发工作流（`npm link`）不受影响
- [ ] `npm run typecheck` 和 `npm test` 全部通过

## Out of Scope

- npm 发布（包保持 private）
- CI/CD 自动构建和上传 Release（后续任务）
- Windows 安装器（`.msi` / `.exe`）的修改
- 从 git repo 直接安装的废弃

## Technical Constraints

- 零运行时依赖（仅 commander + picocolors）— ZIP 解压需纯 Node.js 实现
- Node.js >= 20（`zlib.inflateRawSync` 可用）
- Release zip 内容与平台无关（纯 JS），平台标记仅用于 asset 匹配
