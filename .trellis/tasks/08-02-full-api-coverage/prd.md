# PingCode CLI DevOps 闭环补全

## Goal

让 `pingcode` CLI 能够独立支撑一条**端到端的广义 DevOps 流水线**：

```
产品需求(ship idea) → 项目规划(pjm project/sprint/version/work_item)
   → 测试(testhub case/plan/run) → CICD 与源码(scm commit/PR/build/deploy)
                    ↕
        跨阶段串联(relations / comments / attachments / activities)
```

验收口径是**这条链路能真跑通**，而不是端点计数。当前 CLI 覆盖 **53 / 459** 个 v1 API 端点
（53 为按 `(method, path)` 对 `src/core/endpoints.ts` 逐条建账的结果，取代原文的手工估计 52，
待 F2 的 `ENDPOINTS ⊆ catalog` 测试实测确认），但缺口不是均匀分布的：四个阶段里 CICD 段完全为 0，
串联层完全为 0，中间两段缺写操作。本任务补齐的是「让流水线闭合」所必需的那 **107** 个端点，
不是全量 459。

## Background & Source of Truth

- **API 全量图谱（本任务的机器可读真源，不得重新调研）**：
  `.trellis/tasks/08-02-full-api-coverage/research/open-api-surface-460.md`
  全端点清单、按模块分组的 method/path/purpose/token/scope、鉴权两种流程、分页与错误约定、
  每模块文档锚点 URL。
- 官方真源：`https://open.pingcode.com/api_data.js`（2.3 MB `define({...})` AMD 包，
  579 条条目 = **459 个 v1 API 端点 + 1 个浏览器授权页 + 119 个导航桩**；
  **无 OpenAPI/Swagger，无 sitemap**，`/docs/` 等任意路径都只返回同一份 SPA 外壳）。
  英文包 `api_data_en.js` 已过期（347 端点），**以中文包为准**。
- 实现先例（切片顺序与 PRD 粒度可直接复用）：
  - `.trellis/tasks/archive/2026-08/08-01-ship-cli/` — 新增一整个 API 域的 PRD/design/implement
  - `.trellis/tasks/archive/2026-08/08-02-testhub-module/` — 15 端点 MVP 的逐条纳入/排除论证
- 既有调研（避免重复踩坑，含 GOTCHA 清单）：
  `.trellis/tasks/archive/2026-08/08-01-ship-testhub-research/research/{ship-api.md,testhub-api.md}`

### 端点集合的口径（本 PRD 全文的计数基准）

**全文口径统一为 459 个 v1 API 端点。** 这不是笔误，也不是「460 减一」的近似：

- research 的 method 直方图 **GET 250 / POST 96 / PATCH 54 / DELETE 49 / PUT 10 = 459**；
- research §2 的 area 直方图（pjm 145 · ship 101 · testhub 65 · scm 36 · directory 23 ·
  wiki 19 · release 12 · reviews 8 · permission 7 · build 6 · nexus 5 · workloads 5 ·
  attachments 5 · auth 3 · participants 4 · relations 4 · comments 4 · activities 2 ·
  security 2 · workload_types 2 · myself 1）**逐项相加亦为 459**；
- 两个直方图彼此自洽，且与 research §3 逐节小标题之和一致。

**被剔除的那 1 条是 `GET {oauth2_root}/authorize`。** 它是浏览器重定向的 HTML 授权页，不在
`/v1` 之下、不返回 JSON、无法被 CLI 调用，因此**不计入端点集，也不进 catalog**
（`pingcode api` 对它显式拒绝）。research 里 "460 端点" 的写法 = 459 + 这 1 个授权页。

**令牌类型直方图差 3 的解释（待 F2 实测确认的假设）**：research §1.4 给出
双令牌 388 / 企业令牌 only 61 / 用户令牌 only 7，合计 **456**，与 459 差 3。
**假设**这 3 条是 `/v1/auth/token` 的三种 grant（`client_credentials` / `authorization_code` /
`refresh_token`）—— 它们**不需要任何令牌**（就是用来换令牌的），因此未被归入上述三类之一，
`456 + 3 = 459` 闭合。这是假设不是既定事实，F2 同步 `api_data.js` 时一并核实。

### 鉴权前提（本任务的关键正面结论）

CICD 段那 54 个端点（scm 36 + build 6 + release 12）**全部为「企业令牌 only」**，而 CLI 现有的
`client_credentials` 拿到的就是企业令牌。**这段开箱可达，本任务不需要 OAuth。**

- 459 端点中 388 个双令牌可用、61 个企业令牌 only、7 个用户令牌 only（余 3 条见上文差值假设）。
- 用户令牌 only 的 7 个（`/v1/myself`、`/v1/permission/my/*`、`/v1/permission/check/*`）对本流水线
  无关紧要，**明确排除**。
- OAuth 授权码流程（浏览器跳转 + 本地回调 + refresh_token 持久化）**另开任务**，不属于本任务。

需在 PingCode 企业后台「凭据管理」勾选的 scope（较现状新增）：
`pcp:{read|write}:pjm:{project,workitem,sprint,release,board}`、
`pcp:{read|write}:wiki:{space,page}`（若纳入 W 阶段）、
`pcp:{read|write}:devops:{code,build,deploy}`、`pcp:{read|write}:global:workload`（若纳入工时）。

## Scope

### In scope — 按流水线阶段（107 个新端点）

逐端点清单与纳入理由见 `design.md` D7；此处锁定范围边界与刚需判定。
**每节标题的数字等于该节 bullet 清单的实际条数**，全部经 research §3 逐行点数。

#### S0 · 跨阶段串联层（15 个）— **最高优先，其余阶段的前置**

这是把四个孤岛焊成流水线的唯一胶水，当前覆盖率 0。

- `/v1/relations` × 4（create / list / get / delete）— **本任务的单点最高价值缺口**。
  需求↔工作项↔用例↔缺陷↔commit/PR 的全部追溯都走它。
- `/v1/comments` × 4 — 自动化流程回写说明（"CI #123 失败，已建缺陷 BUG-45"）。
- `/v1/attachments` × 5 — 测试报告、构建产物、代码片段上传。
- `/v1/activities` × 2 — 审计与追溯。

小计 4 + 4 + 5 + 2 = **15**。这些资源对 `principal_type` + `principal_id` 多态，覆盖
work_item / ticket / idea / case / page 等。通用（跨对象）层共 **27** 条，余 12 条见 Out of scope。

#### S1 · CICD 与源码管理（44 个）— 唯一的整块 0

以下每个家族的条数**已扣除其 `PUT`**（全量替换语义，依 `design.md` D8.4 统一归 Out of scope）：

- `scm` 托管平台 4（5 − PUT 1）、平台用户 4（5 − PUT 1）、仓库 4（5 − PUT 1）、
  分支 5（本家族**无** `PUT`，第五条是 `DELETE`）= 17
- `scm` 拉取请求 4（5 − PUT 1）、代码评审 4（5 − PUT 1）= 8
- `scm` 提交 × 3（`GET /v1/scm/commits/{commit_id_or_sha}` 支持按 SHA 取，CI 侧关键）、
  提交引用 refs × 3 = 6
- `build` 构建记录 5（6 − PUT 1，含 DELETE）= 5
- `release` 环境与部署记录的**主线 8 / 12**：环境 `POST`/`GET 列表`/`GET 单条`/`PATCH` × 4 +
  部署 `POST`/`GET 列表`/`GET 单条`/`PATCH` × 4 = 8

小计 17 + 8 + 6 + 5 + 8 = **44**（原标题「约 30 个」与原清单「50」皆已作废：前者与清单矛盾，
后者含 6 个 `PUT`）。devops 段余下 10 条（6 个 `PUT` + release 的 2 个 `PUT` 与 2 个 `DELETE`）
见 Out of scope。

语义定位：这些是 PingCode 的**数据写回接口**，供 CI 把 commit / PR / 构建 / 部署事实推回并挂到
工作项上。没有这段，前三阶段的数据进得去但代码与流水线的事实进不来，CLI 在 DevOps 语义上是断头的。

#### S2 · 项目规划补写（30 个）

- **迭代写操作与单条读取**：`POST/PATCH /v1/pjm/projects/{id}/sprints` × 2、
  `POST /v1/pjm/sprints/bulk` × 1、`GET /v1/pjm/projects/{project_id}/sprints/{sprint_id}` × 1 = 4
  — 当前只有列表，规划迭代必须去网页点；get-one 属基础读取面，且与**已覆盖**的 sprints 列表配对，
  没有它 `sprint get` 无法成立。
- **工作项高级查询**：`POST /v1/pjm/work_items/search` × 1（过滤 DSL）— 当前只有扁平 query 参数。
- **工作项批量更新**：`PATCH /v1/pjm/work_items` × 1 — 挪 20 个工作项进迭代不必跑 20 次。
- **工作项删除**：`DELETE /v1/pjm/work_items/{id}` × 1 — CLI 目前**没有任何 DELETE 能力**。
- **工作项关联与标签**：`work_items/{id}/relations` × 4、`work_items/{id}/tags` × 3、
  `transition_histories` × 2 = 9。
- **关联与标签的词表前置**（两条单数 `work_item` 段，各有不可替代的理由）= 2：
  - `GET /v1/pjm/work_item/relation_types` × 1 — **`POST /v1/pjm/work_items/{id}/relations`
    （本节上一条里的 `work_items/{id}/relations` × 4）的必要前置**：那个族的 `relation_type`
    字段必填，而这是唯一能枚举它的端点。它枚举的是**同类工作项之间**的带类型链接
    （阻塞 / 重复 / 关联 / 原因…，实机 9 条，全部 `is_system`）。
    ⚠️ **原纳入理由已作废**（F5 实机，2026-08-03）：本条原写作"创建 `/v1/relations` 的必要前置"，
    但 `POST /v1/relations` 实机**没有任何 relation type 字段**，body 只有
    `principal_type`/`principal_id`/`target_type`/`target_id`，且只接受**跨种类**配对
    （`work_item→work_item` 被拒）。跨模块追溯（需求↔工作项↔用例↔缺陷）由 S0 独立完成，
    **不依赖本条**；本条负责的是"工作项↔工作项 带类型链接"这一跳。详见 `design.md` D7.6。
    条数不变，仍是 1 条，S2 仍为 30 条。
  - `GET /v1/pjm/work_item/tags` × 1 — 工作项标签词表，`--tag` 名字→ID 解析的唯一数据源。
    research §3.8.3 已记录「有 `GET work_items/{id}/tags/{tag_id}` 但**没有**某个工作项的 tags
    列表」，因此这个词表端点是唯一可枚举标签的入口。
- **版本与发布**：`/v1/pjm/projects/{id}/versions` × 5 + `POST /v1/pjm/versions/bulk` × 1 = 6 —
  规划里"这个需求进 v2.3"目前表达不了。
- **项目写与进度**：`POST/PATCH /v1/pjm/projects` × 2、`projects/{id}/progress` × 1、
  `projects/{id}/members` × 3 = 6。

小计 4 + 1 + 1 + 1 + 9 + 2 + 6 + 6 = **30**（原标题「约 20 个」与原清单「27」皆已作废：
前者与清单矛盾，后者漏了上述 3 条刚需前置读取）。pjm 家族**无任何 `PUT`**，故本节不受 PUT 规则影响。

#### S3 · 测试补齐（13 个）

- **用例批量导入**：`POST/PATCH /v1/testhub/cases/bulk` × 2 — 测试落地的头号刚需。
- **执行记录创建与批量**：`POST /v1/testhub/runs` × 1、`POST/PATCH /v1/testhub/runs/bulk` × 2 = 3
  — 当前只有 plan 内 bulk 与单条 patch。
- **执行结果记录**：`runs/{id}/histories` × 2、`cases/{id}/histories` × 1 = 3 — 测试报告目前出不来。
- **计划修改**：`PATCH /v1/testhub/libraries/{id}/plans/{plan_id}` × 1；`plan_states` × 2 = 3。
- **用例删除**：`DELETE /v1/testhub/cases/{id}` × 1。
- `GET /v1/testhub/case/properties?library_id=` × 1（补齐 meta 最后一块）。

小计 2 + 3 + 3 + 3 + 1 + 1 = **13**。

> **`GET /v1/testhub/runs` 已从本清单移除。** 沿用 `src/core/endpoints.ts:140` 的既有设计决策：
> 简单列表没有 library 过滤，未过滤时会扫遍所有可见测试库，实用性为零，`POST /runs/search`
> 是唯一读路径。理由与替代方案见 `design.md` D7.3。该端点转入 Out of scope（通用层可达）。

#### S4 · 产品需求补齐（5 个）

- 需求排期：`GET /v1/ship/idea/plans?product_id=` × 1、
  `GET /v1/ship/products/{id}/plans` × 2（列表 + 单条）= 3
- 需求流转历史：`GET /v1/ship/ideas/{id}/transition_histories` × 2（列表 + 单条）= 2

小计 3 + 2 = **5**（原标题「约 4 个」与本清单矛盾，以清单为准）。

#### S5 · 基础设施（无新端点，但是 S1–S4 的硬前置）

- 通用逃生舱 `pingcode api <METHOD> <path>` + `api list` / `api describe`：从 `api_data.js` 生成
  hash 锁定的端点目录，使**全部 459 个 v1 端点可调用可发现**，长尾不必手写命令。
- 测试架构改造：`test/help.test.ts` 拆分为 per-group 快照文件；`cli/registry.ts` 集中组注册。
  **这是所有并行子任务的解冲突前提。**
- `core/metadata.ts`（1457 行）改为 registry 表驱动。
- `src/types/api.ts`、`src/api/parse.ts` 按模块拆分，避免 S1–S4 并行时在同一文件互撞。

### 集合配平自证

三个集合互斥且穷尽，覆盖全部 459 个 v1 API 端点：

```
已覆盖 53  +  In scope 107  +  Out of scope 299  =  459  ✅
```

> **X1 实测回填（2026-08-05）。** 本节的 **53 已实测确认为准确值**，「待实测」到此关闭；
> 落地后的实际三集合是 **53 + 105 + 301**。命令与逐条量法见
> `research/x1-doc-measurements.md`，README 的覆盖表发布的是这组实测值（158 / 459）。
>
> - **53**：用同一份计数脚本跑 `cf8335f~1`（本任务第一个 commit 之前）复算，得
>   pjm 10 + directory 1 + ship 22 + testhub 20 = 53，与下文四项分解**完全一致**，
>   包括它对旧手工估计 52 的那一条修正。
> - **105 / 107**：少落地 2 条，均有理由且已在用户文档中记录，不是漏做 ——
>   `POST /v1/attachments` 的 `multipart/form-data` 形态（必须改 `core/wire.ts`，
>   R1 明令停下上报，故只落地 JSON 代码段那半）与
>   `GET /v1/testhub/plan_states/{state_id}`（get-one 无消费者，列表才是 `state_id` 的来源）。
> - **301**：`459 − 158`，其中包含 `/v1/auth/token` 的 3 条（仅 `auth login` 内部调用其中的
>   `client_credentials`，不作为数据命令暴露，故 README 的 `auth` 行记 0/3）。
> - 逐模块实测：pjm 40/145 · ship 27/101 · testhub 32/65 · scm 31/36 · build 5/6 ·
>   release 8/12 · 跨对象 14/15 · directory 1/23 · wiki 0/19 · 其余 0。

- **53** = 按 `(method, path)` 对 `src/core/endpoints.ts` 逐条建账：pjm 10 + directory 1 +
  ship 22 + testhub 20。**取代原文的手工估计 52**：差的 1 条是
  `GET /v1/testhub/case_important_levels`（`testhub meta important-levels`，`endpoints.ts:114`）
  —— 它属于 research §3.10.3「用例配置 16」家族而不是「用例」家族，是最容易漏点的一条。
  ~~仍为**待实测值**~~ —— **已于 X1 实测确认为 53，四项分解逐一命中**（见本节开头的回填框）。
  `endpoints.ts` 只有 46 个导出键，其中多个键承载多个动词（`projects` 同时是
  GET 列表与 POST 创建，`workItem` 同时是 GET 与 PATCH），键数不等于端点数。
- **107** = S0 15 + S1 44 + S2 30 + S3 13 + S4 5（S5 无新端点）。
- **299** = Out of scope 一节的逐家族枚举之和，逐项列出并各附排除理由。
- `/v1/auth/token` 的 3 条计入 Out of scope（由 `core/auth.ts` 内部使用，不作为用户命令暴露），
  故不出现在「已覆盖 53」里。
- **全部 10 个 `PUT` 端点一律在 Out of scope**（依 `design.md` D8.4 的通则），无一例外，
  自证见 Out of scope 一节末尾。
- 逐模块闭合校验（各模块三栏之和 = research §3 的模块总数）：
  pjm 10 + 30 + 105 = 145 · ship 22 + 5 + 74 = 101 · testhub 20 + 13 + 32 = 65 ·
  通用 0 + 15 + 12 = 27 · devops 0 + 44 + 10 = 54 · wiki 0 + 0 + 19 = 19 ·
  directory 1 + 0 + 22 = 23 · 其余（permission 7 + auth 3 + myself 1 + security 2 + 工时 7 +
  nexus 5）0 + 0 + 25 = 25。

## Requirements

### R1 分层与复用（不可协商）

- 遵循 `.trellis/spec/backend/directory-structure.md` 的分层不变式：`cli → {api, core}`、
  `api → core`、`core → 无`；`api` 不得 import `output`。`test/layering.test.ts` 强制校验。
- **不得修改** `core/auth.ts`、`core/http.ts`、`core/wire.ts`、`core/config.ts`、`core/errors.ts`、
  `core/redact.ts`。新增域与 pjm/ship/testhub 在认证、`{page_size,page_index,total,values}` 信封、
  `POST …/search` DSL、429 + `x-pc-retry-after` 契约上同构。若实现中认为必须改动这些文件，
  **停下来上报**。
  - 唯一例外：S5 允许在 `core/` 下**新增** `core/catalog/`、`core/metadata/` 目录，且 `metadata`
    重构必须行为零变化。
- 复用 `api/parse.ts` 的 `fetchPageOf`/`iterateOf`/`fetchSearchPageOf`/`iterateSearchOf`/`compact`，
  `cli/commands/common.ts` 的 `addPagingOptions`/`readPaging`/`printPage`/`printCollection`/
  `printResource`/`runWrite`/`parseSetFlags`，以及 `core/metadata.ts` 的作用域 resolver 工厂。

### R2 端点与命令面

- 所有端点路径集中在 `src/core/endpoints.ts`。注意**单数 area 段**陷阱：
  `/v1/testhub/case/{...}`、`/v1/ship/idea/states`、`/v1/pjm/work_item/types` 与复数的
  `/cases`、`/ideas`、`/work_items` 并存。
- 生成的端点目录 `core/catalog/catalog.generated.ts` 携带 provenance 头（源 URL、快照日期、
  上游 payload sha256），由测试断言内容哈希，**手改即 CI 失败**；`.gitattributes` 标记
  `-diff linguist-generated=true`。
- 必须有测试断言 `ENDPOINTS` 中每条路径都存在于 catalog（method + path 匹配），以捕获上游路径迁移。
- **catalog 与实机证据冲突时，实机证据胜**。`endpoints.ts` / `wire.ts` 的注释与
  `ERROR_CODE_OVERRIDES` 是实机观测结论，apiDoc 不得覆盖它们。
- 既有的「不暴露」决策优先于本 PRD 的清单：`GET /v1/ship/ideas`、`GET /v1/ship/tickets`、
  `GET /v1/testhub/cases`、`GET /v1/testhub/runs` 四条简单列表由 `endpoints.ts` 的注释论证过不暴露，
  本任务不推翻，只在通用层保持可达。

### R3 破坏性操作安全

本任务首次为 CLI 引入 DELETE 能力（S1/S2/S3 共涉及约 10 个 DELETE）。

- 通用层 `pingcode api DELETE` 必须要求 `--yes`。
- 精修 `delete` 命令仅在对象可恢复或可轻易重建时提供；确认信息必须回显**解析后的名称**而非仅 ID。
- DELETE **禁止**与 `--all` 组合。
- `--dry-run` 对所有写操作保持"发请求前中止"语义，是安全探针。

### R4 令牌类型前置校验

catalog 已标注每个端点的 token 类型。调用企业令牌 only 或用户令牌 only 端点时，若当前凭据类型不匹配，
必须**在发请求前** exit 2 并说明原因，而不是等服务端 401。`pingcode api list --token ENT` 可枚举
受限集合（61 条）。

### R5 错误码证据纪律

`ERROR_CODE_OVERRIDES` 每新增一行必须引用一次实机 smoke 观测；每条"考虑过但不加"的决定必须写明理由
（沿用 ship/testhub 既有风格）。此表是本仓最有价值的资产，不得退化为猜测清单。

### R6 SKILL.md 契约改造

现有 `test/help.test.ts` 双向断言「每个叶子命令都在 SKILL.md 出现、且 SKILL.md 提到的每条路径都存在」。
叶子数从 **55**（`test/help.test.ts` 现行断言值：5 个命令组 / 10 个子组 / 55 条叶子）涨到约 150 后，
该测试会变成一份 3000 行文档和每个子任务必冲突的合并点。

- **保留**单向：SKILL.md 中出现的每条 `pingcode …` 路径必须可解析。
- **取消**穷举反向，改为断言 SKILL.md 必须记录：鉴权门槛、`--json`/`--dry-run`、退出码表、
  测试中显式 allowlist 列出的各条精修流程、以及 `api` / `api list` 逃生舱。
- 模块专属说明拆到 `skills/pingcode/modules/<module>.md`，由 SKILL.md 引用，使各模块子任务只改
  自己的文件。

## Acceptance Criteria

### A1 端到端闭环（本任务的主验收，必须实机跑通）

- [ ] 一条脚本化的端到端链路在真实租户上跑通，且每一跳的关联在 PingCode 网页端可见：
      建需求 → 关联到工作项 → 工作项入迭代 → 挂到版本 → 建测试用例并关联工作项 → 建测试计划与执行
      记录 → 记录执行失败 → 建缺陷并关联用例 → 写回 commit / PR → 写回构建与部署记录 →
      缺陷关联到 commit。
- [ ] 该链路全程 `--json` 可解析，可被 agent 无人工干预地驱动。
- [ ] 该链路的 `--dry-run` 变体不产生任何写入，且打印出完整的请求计划。

### A2 阶段可用性

- [ ] S0 串联层：`relations` / `comments` / `attachments` / `activities` 在
      work_item / ticket / idea / case 四类实体上均可用，且不会挂载到该实体不支持的族（由 catalog 断言）。
- [ ] S1 CICD：仓库 / 分支 / PR / 代码评审 / commit / 构建 / 部署的读写主线全部可用，
      `GET /v1/scm/commits/{sha}` 按 SHA 取通。
- [ ] S2 规划：迭代可建可改、工作项可批量改可删可搜可关联、版本可建可挂。
- [ ] S3 测试：用例可批量导入、执行记录可建可批量改、执行历史可读。
- [ ] S4 需求：排期与流转历史可读。

### A3 基础设施

- [ ] 全部 **459** 个 v1 端点通过 `pingcode api` 可调用；`pingcode api list --module <m>` /
      `api describe <id>` 可发现。`GET {oauth2_root}/authorize` 不在集合内，且被显式拒绝。
- [ ] catalog **恰 459 条且全部为 `/v1`**；method 直方图匹配
      GET 250 / POST 96 / PATCH 54 / DELETE 49 / PUT 10（合计 459），area 直方图合计亦为 459，
      两者自洽。**以 F2 实测 `api_data.js` 为准：若实测与本数字冲突，实测胜，并须回写本 PRD
      与 `design.md`。**
- [ ] 生成文件手改会导致 CI 失败。
- [ ] `pingcode api list --token ENT` 能枚举出 61 个企业令牌 only 端点；令牌类型不匹配时 exit 2
      且信息可读。
- [ ] `core/metadata` registry 重构**行为零变化**：既有 `metadata.test.ts` / ship / testhub 相关
      测试未经修改即通过。
- [ ] 新增一个命令组只需改 `cli/registry.ts` 一行；无任何测试断言全局穷举叶子列表。

### A4 质量门

- [ ] `npm run typecheck` 通过，且 `tsc --noEmit` 墙钟时间相对本任务前无显著退化
      （catalog 引入的风险点）。
- [ ] `npm test` 全绿；`test/layering.test.ts` 分层不变式未被放宽。
- [ ] 每个精修模块有自己的 `test/help/<module>.test.ts` 与独立快照文件。
- [ ] README 记录两层模型（可达 459 / 精修约 150）与按模块的精修覆盖表，覆盖基线数字取 F2 实测值。

## Out of scope

### 端点集合的排除枚举（299 个）

这些通过 `pingcode api` 可达即可，**不手写命令**。逐家族列出，条数之和 = 299，
与「已覆盖 53 + In scope 107」互斥且穷尽 459。

**通用（跨对象）层剩余 12 / 27**

| 家族 | 条数 | 排除理由 |
|---|---|---|
| `participants` 关注人 | 4 | 关注人不参与追溯链路，也不是自动化回写的载体 |
| `reviews` 评审（`/v1/reviews` × 4 + `reviews/{id}/principals` × 4） | 8 | 与 scm 的 PR 代码评审（`…/pull_requests/{id}/reviews`，已在 S1）**不是同一资源**；若在 S1 中被证明必需则回收进 S1 |

**pjm 105 / 145**

| 家族 | 条数 | 排除理由 |
|---|---|---|
| 工作项配置（`work_item_types` / `_states` / `_properties` / `_tags` 及各自的 `*_plans` 绑定解绑） | 42 | 管理员配 schema 用的，不是流水线跑的 |
| 看板（boards / entries / swimlanes） | 15 | 除非确认以看板驱动规划，否则不手写（见 Open Questions） |
| 发布的分组与阶段配置（`version_sections` 5 + `version_categories` 5 + `stages` 5） | 15 | 版本的分组容器与发布阶段模板，闭环不依赖 |
| 迭代的分组配置（`sprint_sections` 5 + `sprint_categories` 5） | 10 | 同上，迭代的分组容器 |
| 项目配置（`project_properties` × 4 + `project_states/{id}` 1 + `processes` × 2） | 7 | 项目属性与流程模板（Scrum/Kanban/Waterfall）是 schema |
| 项目家族其余（`clone` 1、`local_config/enable` 1、成员 `PATCH`/`DELETE` 2、项目属性绑定解绑 4、`project/states` 1） | 9 | 克隆与本地化配置是一次性管理动作；成员改角色/移除见 Open Questions |
| 工作项家族其余（`work_item/properties` 1、`work_item_relation_types/{id}` 1、`deliverables` 5） | 7 | 自定义属性视图在 S2 的写命令里可由用户直接给 ID；关联类型的**单条**读取无消费者（列表已在 S2）；交付目标（deliverables）闭环不依赖 |

**ship 74 / 101**

| 家族 | 条数 | 排除理由 |
|---|---|---|
| 工单配置 —— 家族共 **30** 条（research §3.9.5） | 28 | schema 配置。其中 2 条（`ticket_state_plans`、`ticket_state_flows`）**已被覆盖**，用于工单流转预校验，故排除 28 条 |
| 需求配置 | 14 | schema 配置 |
| 产品家族其余（产品写 2、成员写 3、客户 4、外部用户 5、产品标签 4、需求模块 4、渠道视图 2、工单类型视图 2） | 26 | 产品与客户主数据维护，不在闭环链路上 |
| `GET /v1/ship/ideas` 简单列表 | 1 | `endpoints.ts:38-41` 既有决策：无 assignee/日期/属性过滤，`…/search` 是唯一读路径 |
| 工单家族其余（`GET /v1/ship/tickets` 1、工单流转历史 2、`ticket/solutions` 1、`ticket/tags` 1） | 5 | 简单列表同上；工单不在本闭环的主链路上（需求才是） |

**testhub 32 / 65**

| 家族 | 条数 | 排除理由 |
|---|---|---|
| 用例配置 —— 家族共 **16** 条（research §3.10.3） | 15 | schema 配置。其中 1 条 `GET /v1/testhub/case_important_levels` **已被覆盖**（`testhub meta important-levels`，是本模块唯一没有库作用域变体的 org 级列表），故排除 15 条 |
| 测试库家族其余（`PATCH /libraries/{id}` 1、库成员 5、用例模块写 4） | 10 | 测试库与成员维护不在闭环链路上 |
| 用例家族其余（`GET /v1/testhub/cases` 1、`GET /v1/testhub/case/suites` 1） | 2 | 简单列表按 `endpoints.ts` 决策不暴露；模块视图已有 `libraries/{id}/suites` 覆盖 |
| 计划家族其余（`GET plan_types/{id}` 1、`GET /v1/testhub/runs` 1、`PUT /runs/{id}` 1） | 3 | `GET /runs` 见 S3 的移除说明；`PUT` 为全量替换语义，依 `design.md` D8.4 不进精修层（本条另有实机证据：它会清空 executor，见 testhub 归档 design §7） |
| org 级执行结果状态 `run_statuses` × 2 | 2 | 库作用域的 `run/statuses` 已覆盖，org 级列表无消费者 |

**wiki 19 / 19**

| 家族 | 条数 | 排除理由 |
|---|---|---|
| 空间 9 + 页面 10（含 1 个 `PUT /v1/wiki/pages/{page_id}/content`） | 19 | 依 `README.md:8-10` 既有声明「Wiki … deliberately not covered」刻意不覆盖；若后续确认需求文档要参与追溯，作为增补子任务纳入 |

**devops（scm / build / release）10 / 54**

| 家族 | 条数 | 排除理由 |
|---|---|---|
| `scm` 全量替换 `PUT` × 5（托管平台 / 平台用户 / 仓库 / 拉取请求 / 代码评审各 1） | 5 | `PUT` 为全量替换语义，依 `design.md` D8.4 不进精修层；通用层 `pingcode api PUT` 已可达 |
| `PUT /v1/build/builds/{build_id}` | 1 | 同上 |
| `release` 非主线（`PUT` 环境/部署 2 + `DELETE` 环境/部署 2） | 4 | `PUT` 同上；两个 `DELETE` 已由 S1d 实机验证为可用且引用安全（删除正在使用的环境被 `100106` 拒绝，故 release 里没有任何东西能被孤立 —— 与 scm 的分支/ref 隐患相反），通用层 `pingcode api DELETE --yes` 已可达，精修叶子推迟至 X 阶段按策展背景决定 |

**其余模块 47**

| 家族 | 条数 | 排除理由 |
|---|---|---|
| `directory` 组织架构（部门 / 团队 / 角色 / 职位） | 22 | 组织主数据；保留现有 `settings users`（该 1 条已在「已覆盖」内） |
| `permission` 权限（`points` 1 + `my/*` 3 + `check/*` 3） | 7 | 其中 6 条为用户令牌 only、当前鉴权不可达；`points` 无消费者。**注意：本行已含 `my`/`check` 那 6 条，不再单列，避免重复计数** |
| `myself` | 1 | 用户令牌 only，当前鉴权不可达 |
| `security` 安全日志 | 2 | 审计日志，不在闭环链路上 |
| 工时（`workloads` 5 + `workload_types` 2） | 7 | 工时登记是独立场景，闭环不依赖 |
| `nexus` / CES app 自定义实体存储 | 5 | 不是业务模块，是给 app 存自有状态的 KV 存储，`pcp:storage:app` 专用 scope |
| `auth` 令牌端点（`client_credentials` / `authorization_code` / `refresh_token`） | 3 | `client_credentials` 由 `core/auth.ts` 内部使用，**不作为用户命令暴露**；另两种属 OAuth 授权码流程，另开任务 |

小计：12 + 105 + 74 + 32 + 19 + 10 + 47 = **299**。

**`PUT` 全排除自证（10 / 10）**：research 全库共 10 个 `PUT`，改后无一在 In scope ——
scm 5 与 build 1 在上方 devops 组、release 2 在 devops 组的「非主线」行、
wiki 1（`PUT /v1/wiki/pages/{page_id}/content`）在 wiki 19 内、
testhub 1（`PUT /v1/testhub/runs/{run_id}`）在 testhub「计划家族其余 3」内。5 + 1 + 2 + 1 + 1 = 10 ✅

（另有 1 个非端点条目 `GET {oauth2_root}/authorize` 单独排除：它是浏览器授权页，不是 JSON API，
不计入 459，也不进 catalog。）

### 其他非目标

- OAuth 授权码流程 / 用户令牌获取 —— 另开任务。
- 非精修端点的强类型响应模型与 parser。通用层契约是**原样 JSON 透传**。
- `RESOLVERS` 之外的名字→ID 解析。通用层只接受 ID。
- 交互式 prompt / TUI。CLI 保持 agent-first 非交互，`--yes` 是唯一确认机制。
- 运行时抓取 `api_data.js`（仅由 `scripts/catalog-sync.ts` 按需同步，快照入库）。
- 自建部署 `--host` 实机验证、npm 发布、keychain 存储 —— 沿用既有 follow-up 列表，不在本任务。

## Open Questions

- `POST /v1/attachments` 上传是否需要预签名两步流程？若需要，附件写入降级为独立子任务，本任务只做
  list/get/delete。**S0 实现前必须先实机验证。**
- 通用层的 27 条跨对象端点在文档中**未声明任何 scope**，需实机确认是否 scope 豁免。
  **文档侧自相矛盾**：research §3.7 标题与逐行枚举给出 **27** 条（attachments 5 + comments 4 +
  participants 4 + relations 4 + activities 2 + reviews 8），而 §1.4 写作
  「33 endpoints … declare a token type but no scope at all」。本 PRD 取 **27**（有逐行枚举支撑），
  差额 6 条来源不明；**F2 实测 `api_data.js` 时一并确认**，不擅自改成 33。
- `release` 模块 12 个端点中部署记录部分的实际字段契约需实机验证后再定纳入边界
  （直接决定那 2 个 `DELETE` 是否回收进 S1）。
- `pjm` 看板 15 条是否纳入取决于用户是否以看板驱动规划 —— 待确认。
- `DELETE /v1/pjm/projects/{id}/members/{member_id}`（项目成员移除）是否回收进 S2？
  它可轻易重建（重新 add），符合 R3，但当前清单只取 `members × 3`。

## Notes

- 端点数字（**107 新增 / 160 闭环总量 / 459 全量 / 299 留给逃生舱**，其中闭环总量 =
  已覆盖 53 + 新增 107）来自 `research/open-api-surface-460.md`，是快照值。
  **catalog 与实机冲突时以实机为准**（见 R2）。
- 三集合配平算式见 `## Scope` 末尾；`53` 为按 `endpoints.ts` 逐条建账、仍待 F2 实测的值，
  实测后回填并重新配平（若实测为 N，则 Out of scope 同步调整为 `459 - N - 107`）。
- 本 PRD 全文不使用「460」作为端点总数。research 文件里的 "460 endpoints" 等于
  459 个 v1 API 端点 + 1 个浏览器授权页，两处口径的换算关系写在 Background 的「端点集合的口径」一节。
- 本任务是多交付物任务，按 `design.md` 的子任务树拆分为独立可验收的 child task；依赖顺序写在各 child
  的 `prd.md` / `implement.md` 中，不靠树位置隐含。
