# Design — 提升业务代码测试覆盖率

## 目标与边界

把 `pingcode-cli` 的 **`src/` 业务代码覆盖率**尽量推高，并沉淀可一键运行的覆盖率产物。
**不设硬性阈值**，以最大化业务代码覆盖率为准绳；**不改动任何产品功能行为**。

## 分母口径（coverage 配置）

- **度量范围**：仅 `src/**/*.ts`（`coverage.include`）。
- **排除（`coverage.exclude`）**——不进入分母、不被目标拉低：
  - `src/types/**`（纯类型定义，无运行时代码）
  - `src/bin/**`（CLI 入口 `pingcode.ts`）
  - `src/core/catalog/catalog.generated.ts`（生成文件）
- **入口 `scripts/*`（git hook / 安装器）**：本就位于 `src/` 之外，不进分母（即不被 `include: ['src/**/*.ts']` 统计）。
- 结果：分母 = 业务代码；0% 的纯类型/生成/入口不再污染业务口径。

## 覆盖率产物

- `vitest.config.ts` 的 `test.coverage`：
  - `provider: 'v8'`
  - `reporter: ['text', 'html', 'json-summary']`（终端可读 + 浏览器细看 + 机器可汇总）
  - `include: ['src/**/*.ts']`，`exclude: [...]`（见上）
  - **不启用 `coverage.thresholds`**（用户选择不设硬目标）。
- `package.json` 新增脚本：`"test:coverage": "vitest run --coverage"`。
- `coverage/` 目录加入 `.gitignore`（报告为产物，不入库）。

## 测试补强策略

遵循既有约定：**单测不联网**，`fetch` 经 `Ctx` 注入（`test/helpers/fake` 的 `createFakeFetch` / `createTestContext` / `jsonResponse`）；断言聚焦 URL path、query 参数、请求体与解析结果，而非响应体原样回放。

**优先级 = 缺口大小 × 业务价值**，分批推进（见 implement.md）：

1. **第一梯队（缺口最大、易补）**
   - `src/api/meta.ts`（50.6%）：补 `listWorkItemPriorities / iterateUsers / listBoards / listBoardEntries / listBoardSwimlanes`，复用 `test/api.test.ts` 的 `ctxFor` 模式，直接拉到接近 100%。
   - `src/core/jsonInput.ts`（70.3%）：核心 JSON 输入解析，补边界分支。
2. **第二梯队（命令/api 层 60%–80%）**
   - `src/cli/commands/settings.ts`（56.4%）、`src/cli/commands/auth.ts`（58.3%，鉴权重要）、`src/cli/commands/projectBoard.ts`（69.7%）、`src/api/common.ts`（74.8%）、`src/cli/commands/_shared/bulkEntries.ts`（75.9%）。
3. **第三梯队（80%–95% 区间）**
   - `workItem / oauth / scm/* / testhub/* / release/* / product` 等命令与 api 文件的分支/函数补全。
4. 每补一批即跑 `npm run test:coverage` 复核，按最新缺口动态调整优先级（尽量推高）。

## 兼容性与风险

- **风险：行为漂移**。本次只新增测试，不改 `src/` 逻辑；若补测时发现某分支难以覆盖，仅在确认为不可达代码时按规约清理，否则保留并标注。
- **风险：分层破坏**。新增测试不得引入 cli↔core 反向依赖；`test/layering.test.ts` 须保持通过。
- **回滚**：测试与配置变更各自独立、可逐批回退；不影响产品构建（`dist`）。
- **产物不入库**：`coverage/` 与 node_modules 变化（新增 devDep）可随本任务一并提交。
