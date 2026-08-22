# Implement — 提升业务代码测试覆盖率

有序执行清单。每批完成后跑验证命令，按最新覆盖率缺口动态调整下一批。

## 0. 基础设施（先做）

- [ ] 0.1 在 `vitest.config.ts` 的 `test` 下增加 `coverage` 配置：
  - `provider: 'v8'`
  - `reporter: ['text', 'html', 'json-summary']`
  - `include: ['src/**/*.ts']`
  - `exclude: ['src/types/**', 'src/bin/**', 'src/core/catalog/catalog.generated.ts']`
  - 不设置 `thresholds`。
- [ ] 0.2 `package.json` 增加 `"test:coverage": "vitest run --coverage"`。
- [ ] 0.3 `.gitignore` 增加 `coverage/`。
- [ ] 0.4 跑 `npm run test:coverage`，确认分母口径正确（分母只剩 `src/` 业务代码，0% 的类型/生成/入口消失）。

## 1. 第一梯队：缺口最大、易补

- [ ] 1.1 `test/api.test.ts` 增补 `meta api`：`listWorkItemPriorities`、`iterateUsers`、`listBoards`、`listBoardEntries`、`listBoardSwimlanes`。复用 `ctxFor` + `jsonResponse`，断言 path/params。
- [ ] 1.2 补 `src/core/jsonInput.ts` 边界分支（新建 `test/jsonInput.test.ts`）。
- [ ] 1.3 复跑 `npm run test:coverage`，核对 `meta.ts` / `jsonInput.ts` 提升。

## 2. 第二梯队：命令 / api 层 60%–80%

- [ ] 2.1 `src/cli/commands/settings.ts`（56.4%）
- [ ] 2.2 `src/cli/commands/auth.ts`（58.3%，鉴权重要）
- [ ] 2.3 `src/cli/commands/projectBoard.ts`（69.7%）
- [ ] 2.4 `src/api/common.ts`（74.8%）
- [ ] 2.5 `src/cli/commands/_shared/bulkEntries.ts`（75.9%）
- [ ] 2.6 每文件补完即复跑覆盖率。

## 3. 第三梯队：80%–95% 区间分支/函数补全

- [ ] 3.1 按最新覆盖率从低到高挑：`workItem`、`oauth`、`scm/{repo,ref,branch,commit,pullRequest,review,platformUser,platform}`、`testhub/{runs,cases,plans,meta}`、`release/*`、`product` 等。
- [ ] 3.2 复跑覆盖率，尽量推高，直至明显饱和（边际收益低）。

## 4. 收尾验证

- [ ] 4.1 `npm test` 全绿（现有 1661 用例不回归）。
- [ ] 4.2 `test/layering.test.ts` 通过（分层未被破坏）。
- [ ] 4.3 `npm run test:coverage` 产出最终报告，记录各业务文件覆盖率与总体提升幅度。

## 验证命令

```bash
npm test                       # 现有全量用例
npm run test:coverage          # 覆盖率（聚焦 src/ 业务代码）
npx vitest run test/layering.test.ts   # 分层校验
```

## 分派说明（sub-agent）

- 第 0 批（配置）由 orchestrator 直接完成（小、低风险）。
- 第 1–3 批按文件/目录拆分为独立补测任务，可并行分派 `trellis-implement`，每任务限定单一文件或一组同目录文件，禁止重叠写范围。
- 每批完成后由 orchestrator 用 `npm run test:coverage` 复核并更新下一批优先级。

## 回滚点

- 任何一批引入回归或破坏分层：回退该批测试文件，保留配置；修正后再合入。
