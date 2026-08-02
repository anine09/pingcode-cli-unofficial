# PingCode Testhub 测试模块 CLI 支持

## Goal

为 `pingcode` CLI 增加 PingCode **Testhub（测试管理）** 域的支持，使命令行与 AI Agent 能够：读取测试库/模块树/用例/测试计划、查询计划内待执行项、以及记录执行结果。

首版范围锁定为调研报告推荐的 **15 端点 MVP**，覆盖「读测试资产 → 增改用例 → 记录执行结果」这条主链路，刻意排除配置写入、库/成员/模块写入、计划创建与缺陷关联。

## Background & Source of Truth

- API 调研已完成且今日复核无漂移，**不得重新调研**，直接引用：
  `.trellis/tasks/archive/2026-08/08-01-ship-testhub-research/research/testhub-api.md`（65 端点全清单、30 条 GOTCHA、§9 MVP 子集与逐条排除论证、§10 未确定项）
- 官方机器可读真源：`https://open.pingcode.com/api_data.json`（579 条记录；`/docs/` 前缀只返回 SPA 外壳，不可抓）
- 实现先例：`.trellis/tasks/archive/2026-08/08-01-ship-cli/`（新增一整个 API 域的 PRD/design/implement，切片顺序可复用）
- Scope 名（凭据管理需勾选）：`pcp:{read|write}:testhub:{library|testcase|testplan|configuration}`

## Scope

### In scope（15 个端点）

**读取（9）**
1. `GET /v1/testhub/libraries` — 测试库列表（一切的入口，无 `library_id` 寸步难行）
2. `GET /v1/testhub/libraries/{library_id}/suites` — 模块树（支持 `?parent_id=root` 走查）
3. `GET /v1/testhub/case/states?library_id=` — 解析 `state_id`（scope: configuration）
4. `GET /v1/testhub/case/types?library_id=` — 解析 `type_id`
5. `GET /v1/testhub/case_important_levels` — 解析 `important_level_id`（无库级视图，org 级）
6. `GET /v1/testhub/run/statuses?library_id=` — 解析 `status_id`（scope: configuration；**每次 run 写入的硬前置**）
7. `POST /v1/testhub/cases/search` — 用例主查询
8. `GET /v1/testhub/cases/{case_id}` — 用例详情含 `steps[]`（接受 `short_id`）
9. `GET /v1/testhub/libraries/{library_id}/plans` + `/{plan_id}` — 计划列表与详情（详情接受 `short_id`）
10. `POST /v1/testhub/runs/search` — 执行用例主查询（"这个计划还剩什么没测"）

**写入（4）**
11. `POST /v1/testhub/cases` — 创建用例（可设 `suite_id`/`type_id`，bulk 变体不能）
12. `PATCH /v1/testhub/cases/{case_id}` — 唯一的单用例修改入口（也是唯一能改 `state_id`、移动 suite 的入口）
13. `PATCH /v1/testhub/runs/{run_id}` — 记录单条执行结果（测试 CLI 中最高频的写）
14. `POST /v1/testhub/libraries/{library_id}/plans/{plan_id}/runs/bulk` — 计划内 run 的增/改/**删**（删 run 的唯一路径）

### Out of scope（首版明确不做）

- 配置写入：`POST/PATCH /case_properties`、`case_property_plans` 绑定/解绑
- 库 / 成员 / 模块写入：`POST/PATCH /libraries`、4 个 member 端点、`POST/PATCH/DELETE …/suites`（DELETE 级联子模块，首版不暴露）
- `POST/PATCH …/plans` 计划创建与修改（`project_id`/`sprint_id`/`version_id` 的条件必填需要 plan_type 判别，而 plan_type 无 kind 字段）
- `POST/PATCH /cases/bulk`、`POST/PATCH /runs/bulk`（导入器场景）
- `PUT /runs/{run_id}`（对 CLI 严格劣于 PATCH：强制全量 `steps[]`，且省略 `executor_id` 会清空执行人）
- `DELETE /cases/{case_id}`（不可逆，无 undelete 端点）
- 三个 history 端点（`/cases/{id}/histories` 还声明了 write scope）
- `GET /cases`、`GET /runs` 简单列表（官方文档自己引导用 search）
- org 级配置列表与所有单项配置 GET（库级变体返回同样的 id）
- `/v1/relations` 缺陷关联（跨模块，需要 pjm scope 与 work-item resolver，列为下一里程碑）

## Requirements

### R1 分层与复用（不可协商）
- 遵循 `.trellis/spec/backend/directory-structure.md` 的分层不变式：`cli → {api, core}`、`api → core`、`core → 无`；`api` 不得 import `output`。`test/layering.test.ts` 会强制校验。
- **不得修改** `core/auth.ts`、`core/http.ts`、`core/wire.ts`、`core/config.ts`、`core/errors.ts`、`core/redact.ts`、`cli/output.ts`。Testhub 与 pjm/ship 的认证、`{page_size,page_index,total,values}` 信封、`POST …/search` DSL、429 + `x-pc-retry-after` 契约完全同构。若实现中认为必须改动这些文件，**停下来上报**，不要自行改。
- 复用 `api/parse.ts` 的 `fetchPageOf`/`iterateOf`/`fetchSearchPageOf`/`iterateSearchOf`/`compact`，`cli/commands/common.ts` 的 `addPagingOptions`/`readPaging`/`printPage`/`printCollection`/`printResource`/`runWrite`/`parseSetFlags`，以及 `core/metadata.ts` 的作用域 resolver 工厂（ship 的 `productScoped` 对应 testhub 的 library-scoped）。

### R2 命令面
- 所有端点路径集中在 `src/core/endpoints.ts`，注意 **单数 area 段** 陷阱：`/v1/testhub/case/{properties,suites,states,types}`、`/v1/testhub/run/statuses` 与复数的 `/cases`、`/runs` 并存（与 ship 的 `/v1/ship/idea/states` 同款）。
- CLI 组名 kebab-case、文件名 camelCase、叶子动词沿用 `list|get|create|update`，参数用 `<name|id>` 约定，flag kebab-case。
- 每个叶子命令必须包上 `addGlobalOptions(..., { hidden: true })`。
- 新命令组在 `src/cli/program.ts` 注册。

### R3 名称 → ID 解析
- 用户可用**名称**指定 library / suite / case state / case type / important level / run status，CLI 负责解析成 id；同时保留 `--*-id` 直传形式，二者互斥（沿用 `common.ts` 的 `--state` / `--state-id` 模式）。
- 新增的 `MetaKind` 中，`case-state`、`case-type`、`run-status`、`suite` 均为 **library 作用域**，缓存 key 必须含 `library_id`；`case-important-level` 是 org 级。
- `run/statuses` 与 `case/states` 需要 `configuration` scope，而同目录的 `case/types`、`case/properties` 只需 `testcase` —— 文档与错误提示需说明：只申请 `testcase`+`testplan` 的令牌无法解析 `status_id`/`state_id`，因而无法完成任何 run 写入。

### R4 写操作安全
- `PATCH /runs/{run_id}` **强制携带 `status_id`**，无法只改 `remark`；CLI 必须要求或自动补齐当前状态。
- `executor_id` 的取值优先级为 **显式 flag > 从 run 继承 > 省略并告警**：`--executor`/`--executor-id` 给了就发；没给但 run 自身有执行人，就把 `run.executor.id` 原样回传（read-modify-write，自解释）；run 本身没有执行人且用户也没指定时，**整条 `executor_id` 字段不出现在 PATCH body 里**，同时在 stderr 提示"该 run 没有执行人、字段已省略、执行人保持未分配"（退出码仍为 0，不再拒绝）。
  - 依据：2026-08-02 S6 实测两组 raw PATCH 对照（design §7），body 仅含 `status_id`：执行人为 `luoxiutao` 的 run 保持 `luoxiutao`，`executor: null` 的 run 保持 `null`。即 **PATCH 省略 `executor_id` 对该字段是 no-op**，[th#61] 的"不传默认执行人为执行用例的创建人"未复现。
  - `PUT /runs/{id}` 未复测（不在 endpoint 范围内），其"省略即置空"的文档行为仍属**未验证且危险**，因此该端点继续不实现；R4 最初的动机在 PUT 上依然成立。
- `steps[]` 与 `properties` 的 option 均为**整体替换**，且缺 `step_id` 的 step 会被当新步骤重新生成 id（静默孤立历史结果）→ 所有涉及 steps 的修改走 read-modify-write。
- bulk 上限：`inserts/updates/deletes` 各 ≤50；超出需分批或明确报错。
- `short_id` 只在 GET 路径被文档化接受，**所有写路径只传 id**。
- 沿用 `runWrite` 的语义：绝不重复发送同一个变更请求体。

### R5 输出契约
- `--json` 时 stdout 只有 JSON；表格、提示、警告、错误、dry-run 说明一律 stderr。
- 列表 JSON 保留 `page_index/page_size/total/values` 原样；时间戳在 JSON 中保持原始秒级整数，人读视图经 `formatTimestamp` 渲染。
- 帮助文本与错误信息为英文，中文仅出现在命令描述里的领域名词（`测试库`、`用例`、`测试计划`、`执行用例`）与 API 原样返回的 message。

### R6 响应模型健壮性
- 所有 wire 类型按 snake_case、字段全部 optional/nullable —— 文档标为"必填"的响应字段实测可为 `null`（`estimated_workload`、`remaining_workload`、`remark`、`expected_value`、`group_id`、`actual_value`）。
- `is_archived`/`is_deleted`/`is_system` 文档标 Number 但 `allowedValues` 是字符串 `['0','1']`，按整数解析并容忍字符串。
- 两种 history 形状不同、嵌入 `plan` 引用用 `status`(字符串) 而 plan 全量资源用 `state`(对象) —— 不共用反序列化器。

### R7 文档与测试同批更新
新增命令组必然打破以下硬编码校验，必须**同一次提交**内一起更新：
- `test/help.test.ts` 的命令组数量断言与叶子路径全清单
- `test/__snapshots__/help.test.ts.snap`
- `skills/pingcode/SKILL.md`（测试会交叉校验其中每条命令路径）
- `README.md`

### R8 不新增运行时依赖
运行时依赖冻结在 `commander` + `picocolors`。测试零网络，`fetch` 经 `Ctx` 注入（`test/helpers/fake.ts` 的 `createFakeFetch`/`createTestContext`）。

## Acceptance Criteria

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全绿，含更新后的 `help.test.ts` 与 snapshot；`layering.test.ts` 无违规
- [ ] `npm run build` 通过，`node dist/bin/pingcode.js --help` 列出新的 testhub 命令组
- [ ] 新增 `test/testhub.test.ts`（api 层）、`test/testhubMetadata.test.ts`（缓存 key / TTL / 名称歧义）、`test/testhubCommands.test.ts`（命令层，复用 `shipCommands.test.ts` 的 `runCli` harness），全部零网络
- [ ] 15 个 MVP 端点均有 api 层封装与至少一条命令路径可达
- [ ] 名称解析：library / suite / case-state / case-type / important-level / run-status 均可用名称指定，且 `--x` 与 `--x-id` 互斥校验有测试覆盖
- [ ] `--json` 输出纯净性有测试覆盖（stdout 仅 JSON）
- [ ] `--dry-run` 对所有写命令生效；`POST …/search` 在 dry-run 下仍可执行（沿用 `asReadContext`）
- [ ] `PATCH /runs/{run_id}` 在未显式给出 `executor_id` 时的行为经过测试固化（不得静默改变执行人）
- [ ] bulk 超过 50 条时有明确 `UsageError`，测试覆盖
- [ ] `skills/pingcode/SKILL.md` 与 `README.md` 已同步新增命令
- [ ] 未修改 `core/{auth,http,wire,config,errors,redact}.ts` 与 `cli/output.ts`
- [ ] 提交信息符合 `.trellis/spec/guides/commit-conventions.md`，`npm run check:commits` 通过

## Open Questions（列为待实测，不作为设计假设）

1. **GET 列表端点是否真支持分页** —— 全站 579 条记录里没有任何 GET 端点声明 `page_index`/`page_size`，只有平台概述页声明契约。需对 `GET /libraries`、`GET …/plans`、`GET …/suites` 实测。
2. **`run/statuses` 的 name → slug 映射** —— 写入吃 `status_id`，读出是英文 slug（`not_start|pass|block|failure|skip`）与中文 name（未测/通过/受阻/失败/跳过），而 `run_statuses` 项只有 `id/url/name/is_system`，**官方未声明映射**。租户还能自建状态。CLI 需按 name 解析并允许用户覆盖。
3. **自定义 `properties` 各类型的取值编码**（date 秒/毫秒？member 裸 id 还是对象？select 传 id 还是 text？cascade 传路径数组？）官方无记载 → 首版对 `properties` 采取透传策略，不做类型化封装。
4. **`properties` 在 PATCH 是合并还是替换** —— `steps`/`options` 明确整体替换，`properties` 一字未提。
5. **bulk 是原子还是 best-effort**，返回数组是否与请求下标对齐（`runs/bulk` 只返回计数 `{inserts,updates,deletes}`，**不返回新建 run 的 id**）。
6. **错误码目录** —— 无任何 testhub 记录记载错误响应；重名计划、identifier 冲突、bulk 部分失败的具体 code 未知。

## Notes

- 完整 GOTCHA 清单见调研报告 §7（30 条），实现前必读。
- 后续里程碑候选（不在本任务）：`/v1/relations` 缺陷关联、计划创建、bulk 导入、history 报表。

### 命令面结构与姊妹任务

用户要求 CLI 顶层结构与 PingCode GUI 的模块划分一致（产品管理 / 项目管理 /
测试管理 / 后台设置）。因此本任务的所有 testhub 命令收敛在**单一 `testhub`
顶层组**下，按资源分子命令组：

```
testhub libraries  list|get
testhub cases      list|get|create|update
testhub plans      list|get
testhub runs       list|patch|bulk
testhub meta       case-states|case-types|important-levels|run-statuses
```

实现落在单个 `src/cli/commands/testhub.ts`，导出 `registerTesthubCommands(program)`。

现有的 `product`/`idea`/`ticket` 与 `project`/`work-item` 尚未按同样方式聚合，
这项重组由姊妹任务 **`.trellis/tasks/08-02-cli-module-grouping`** 负责，
不在本任务范围内。该任务已拍板的最终顶层结构为：

```
auth      login|status|logout                        CLI 本地凭据
product   list|get · idea · ticket · meta            产品管理
project   list|get · work-item · meta                项目管理
testhub   libraries|cases|plans|runs · meta          测试管理  ← 本任务
settings  users                                      后台设置
```

本任务的 `testhub` 组已与之同形，无需二次调整。

**执行顺序**：两个任务都会重写 `test/help.test.ts`、其 snapshot、
`skills/pingcode/SKILL.md`、`README.md`，必须串行。建议
`08-02-cli-module-grouping` 先做，本任务后做，这样 testhub 的文档只需按最终
结构写一遍。
