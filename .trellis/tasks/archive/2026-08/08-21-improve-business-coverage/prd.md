# 提升业务代码测试覆盖率

## Goal

尽可能提升 `pingcode-cli` 业务代码（`src/`）的测试覆盖率，并落地可持续的覆盖率统计：新增 `test:coverage` 脚本、配置 `coverage.exclude`，使团队本地一键看到聚焦于业务代码的覆盖率报告，并持续补测推高。

## Background（已确认的事实）

- 测试框架 `vitest@2.1.9`；为覆盖率本次安装了 `@vitest/coverage-v8@2.1.9`（已作为 devDependency 写入 `package.json`）。
- 现有测试：53 个文件、**1661 个用例全部通过**；`npm test`（= `vitest run`）不跑覆盖率。
- 当前全局覆盖率（All files，2026-08-21 实测）：
  语句（Stmts）**87.87%** ｜ 分支（Branch）**80.77%** ｜ 函数（Funcs）**81.7%** ｜ 行（Lines）**87.87%**
- 分层规约（`.trellis/spec/backend`）：`cli → {api, core}`、`api → core`、`core` 不反向依赖；单测 **不联网**，`fetch` 通过 `Ctx` 注入；由 `test/layering.test.ts` 强制。`src/` 视为业务代码。

## 现有缺口（语句覆盖率升序，已排除纯类型文件）

`src/` 业务代码中偏低、优先补测的文件：

- `src/api/meta.ts` **50.6%**（13 个导出，约一半未覆盖，缺口最大、易补）
- `src/cli/commands/settings.ts` **56.4%**
- `src/cli/commands/auth.ts` **58.3%**（鉴权，重要）
- `src/cli/commands/projectBoard.ts` **69.7%**
- `src/core/jsonInput.ts` **70.3%**（核心 JSON 解析）
- `src/api/common.ts` **74.8%**
- `src/cli/commands/_shared/bulkEntries.ts` **75.9%**
- `src/cli/commands/workItem.ts` **78.6%**
- `src/cli/commands/oauth.ts` **79.8%**
- 其余 20+ 个命令 / api 文件处于 80%–95% 区间。

## Requirements

- R1：落地覆盖率产物——新增 `test:coverage` 脚本，运行 `vitest run --coverage`。
- R2：配置 `coverage`（provider `v8`，以及合理的 `coverage.exclude` / `coverage.include`），使报告聚焦业务代码。
- R3：补测试提升业务代码覆盖率，优先覆盖缺口最大、业务价值高的文件，**不设硬性阈值、尽量推高**。
- R4：保持现有 1661 个用例全绿，不破坏分层与"单测不联网"约束。
- R5：新增测试遵循现有 `test/` 约定与 `.trellis/spec/backend/quality-guidelines.md` 的测试规范。

## Key Decisions

- **分母口径**：`scripts/*`（git hook / 安装器）与 `src/bin/pingcode.ts`（入口）**不算业务代码**，通过 `coverage.exclude` 排除；本次聚焦 `src/`。
- **目标**：**不设硬性阈值**，以"尽量推高 `src/` 业务代码覆盖率"为准绳，优先补缺口最大的文件；不启用 `coverage.thresholds` 阻断。
- 纯类型文件 `src/types/*`、生成文件 `src/core/catalog/catalog.generated.ts` 同样排除在分母外（无运行时代码）。

## Acceptance Criteria

- [ ] AC1：存在 `test:coverage` 脚本，`npm run test:coverage` 可一键产出覆盖率报告。
- [ ] AC2：覆盖率配置生效——`src/types/*`、`catalog.generated.ts`、`scripts/*`、`src/bin/pingcode.ts` 不进入分母。
- [ ] AC3：`src/` 业务代码语句/行覆盖率相对当前基线显著提升，且尽量推高（无硬阈值，以最大化为准）。
- [ ] AC4：所有现有测试继续通过，`test/layering.test.ts` 通过。
- [ ] AC5：新增测试不引入网络访问（fetch 经 `Ctx` 注入）。

## Out of Scope

- 不改变产品功能行为；本次只新增/补强测试与覆盖率配置。
- `scripts/*` 与 `src/bin/pingcode.ts` 的测试（如需覆盖，另开任务）。
- 联网的真实 API 探测（项目规约：单测不联网）。
