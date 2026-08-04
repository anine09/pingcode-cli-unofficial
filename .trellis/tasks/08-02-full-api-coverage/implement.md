# Implementation plan — PingCode Open API 全量覆盖（两层模型）

先读 `prd.md`，再读 `design.md`。本文档只写执行：子任务树、依赖、验收、验证命令、评审门、回滚点。

**本任务是父任务。** 它自己不实现代码，只拥有需求集合、任务地图、跨 child 的验收与最终集成评审。
下面每个编号 = 一个独立可验收的 child task，用
`python3 ./.trellis/scripts/task.py create "<title>" --slug <name> --parent 08-02-full-api-coverage`
创建。**父/子结构不是依赖系统**：下面写出的依赖顺序必须复制进各 child 的 `prd.md` /
`implement.md`，不能靠树位置隐含（Trellis 规则）。

## Ground rules（每个 child 都适用）

- 每个 child 以 `npm run typecheck && npm test` 全绿收尾，一个或多个 Conventional Commits
  （`npm run check:commits` 在 CI 里强制）。
- **不得修改** `core/auth.ts`、`core/http.ts`、`core/wire.ts`、`core/config.ts`、`core/errors.ts`、
  `core/redact.ts`、`cli/output.ts`。唯一例外是 `wire.ts` 的 `ERROR_CODE_OVERRIDES` 追加行
  （每行带 smoke 证据），且必须在 PR 描述里显式点出。其他任何改动需求 → **停下上报**（PRD R1）。
- 零新依赖，`package-lock.json` 保持字节不变。
- 实机与 `research/open-api-surface-460.md` 或 catalog 冲突时，**实机胜**，并在同一个 commit 里
  更新 `design.md` / `endpoints.ts` 注释 —— 绝不静默绕过（PRD R2/R5）。
- 不提交任何凭据或租户可识别值；`npm run scan:secrets` 在 CI 里跑。
- 新增命令组只允许改 `src/cli/registry.ts` 一行；新增叶子只允许改自己模块的
  `test/help/<group>.test.ts` 与其独占快照。

---

## Phase F · 基础（部分串行，F1 是全树硬门禁）

### F1 — 测试架构与拆分（零行为变化）

**交付物**

- `src/cli/registry.ts`：`GROUPS: readonly [name, register][]`；`program.ts` 迭代它（design D6.2）。
- `test/help.test.ts` → `test/help/root.test.ts` + `test/help/<group>.test.ts` +
  `test/help/skill.test.ts`；旧 `test/__snapshots__/help.test.ts.snap` 按组拆进
  `test/help/__snapshots__/<group>.test.ts.snap`（design D6.3）。
- 穷举叶子列表下沉到各组文件；root 只留组顺序（`= GROUPS.map(([n]) => n)`，自满足）、组数量、
  全局 flag 遍历断言、不绑定 `-v`。
- SKILL.md 契约按 PRD R6 改写：保留「文档提到的路径必须可解析」单向断言，取消反向穷举，
  新增鉴权/`--json`/`--dry-run`/退出码表/allowlist 流程/`api` 逃生舱六类断言。
- `skills/pingcode/modules/{pjm,ship,testhub,scm,cicd,crosscutting,api}.md` 拆分，SKILL.md 引用；
  确认 `scripts/install-skill.ts` 把 `modules/` 一并安装（现有测试断言它只 import `node:*`）。
- `src/types/api.ts` → `src/types/{common,pjm,ship,testhub,scm,crosscutting}.ts` + 原文件全量再导出。
- `src/api/parse.ts` → `src/api/parse/{common,pjm,ship,testhub,scm,crosscutting}.ts` + 原文件全量
  再导出（含 `fetchPageOf`/`iterateOf`/`fetchSearchPageOf`/`iterateSearchOf`/`listAllOf`/`compact`）。

**验收**

- `npm test` 全绿，且**零行为变化**：`--help` 文本逐字节不变（拆分后的快照内容与原
  `help.test.ts.snap` 对应段落一致），任何一条现有非 help 测试都不需要改。
- 新增一个命令组只需改 `registry.ts` 一行 —— 用一个临时的假组证明一次，然后删掉。
- **无任何测试断言全局穷举叶子列表**（grep 证明）。
- `src/cli/program.ts` 不再逐个 import 命令模块。

**依赖**：无。**可并行**：与 F2 完全并行（文件集不交）。

**触及**：`src/cli/{registry.ts,program.ts}`、`src/types/*`、`src/api/parse*`、`test/help/**`、
`test/__snapshots__/help.test.ts.snap`（删除）、`skills/pingcode/**`、`scripts/install-skill.ts`。

---

### F2 — catalog（生成数据）

**交付物**

- `scripts/catalog-sync.ts`：抓 `https://open.pingcode.com/api_data.js`、剥 `define({…})` 壳、
  规范化为 `CatalogEntry[]`、写 `catalog.generated.ts` 与两个 sha256（design D2.1/D2.4/D2.5）。
- `src/core/catalog/catalog.generated.ts`（provenance 头 + **459 条**）。
- `src/core/catalog/index.ts`：加载、按 id 查找、裸路径→条目匹配（`{param}` 段通配、先精确后通配）、
  必填参数校验、`paged` 手写 override 表。
- `.gitattributes`：`src/core/catalog/catalog.generated.ts -diff linguist-generated=true`。
- `package.json`：`catalog:sync`、`catalog:check` 两个 script。
- `test/catalog.test.ts`：内容哈希自校验、计数与直方图、`ENDPOINTS ⊆ catalog`、路径匹配算法
  （含单数/复数 area 段的区分用例）。
- `test/layering.test.ts` 新增：`catalog.generated.ts` 只允许被 `core/catalog/index.ts` import。

**验收**

- **catalog 恰 459 条，且每条 `path` 都以 `/v1/` 开头**（一条测试断言条数、一条断言无非 v1 路径）。
  `GET {oauth2_root}/authorize` **不进 catalog**，理由见 design D2.8（非 v1、非 JSON、浏览器重定向页）。
- method 直方图匹配 **GET 250 / POST 96 / PATCH 54 / DELETE 49 / PUT 10**（合计 459，与条数自洽）；
  area 直方图合计亦为 459。**若实测与本数字冲突，以实测为准**，并在同一个 PR 里回写
  `prd.md`（配平算式与口径节）与 `design.md`（D2.8 / D10）—— 数字只有一处真源，不许两边各写一套。
- `tokenType` 直方图匹配 **APP 388 / ENT 61 / USER 7**；`api list --token ENT` 的 61 条里包含
  DevOps 54 + Nexus/CES 5 + `pjm/sprints/bulk` + `pjm/versions/bulk`。
- 手改生成文件一个字节 → `npm test` 红（用一次真实的临时改动证明，然后还原）。
- `ENDPOINTS`（`endpoints.ts` 全部路径）每条都能在 catalog 里按 method + path 命中。
- `npm run catalog:check` 对当日线上为绿。
- **记录 F2 前后 `tsc --noEmit` 墙钟时间**（各三次取中位数）写进 child 的完成说明；超过 D2.6 的
  退化线则当场切 JSON 资产方案。

**依赖**：无。**可并行**：与 F1 完全并行。

**触及**：`scripts/catalog-sync.ts`、`src/core/catalog/**`、`.gitattributes`、`package.json`、
`test/catalog.test.ts`、`test/layering.test.ts`。

---

### F3 — 通用执行器 `pingcode api`（**PRD 可达验收在此达成**）

**交付物**

- `src/cli/commands/api.ts`：五个动词（GET/POST/PATCH/PUT/DELETE）+ `--query` / `--body-file` /
  `--body -` / `--set` / 分页四标志 / `--yes`。
- `api list`（`--module` / `--search` / `--token` / `--method`）与 `api describe <id|method path>`。
- 发请求前的 catalog 校验与退出码（design D3.2）：未知路径带 "did you mean" 建议、
  method 不匹配、缺必填、`USER` 令牌前置拒绝、DELETE 缺 `--yes`。
- 403 时把 catalog 声明的 scope 追加到 stderr（**不改 `wire.ts`**，在命令层捕获 `PermissionError`）。
- `test/help/api.test.ts` + 独占快照；`test/apiCommand.test.ts`（注入 `fetch`）。

**验收**

- **全 459 条的可调用性测试**：遍历 catalog，
  - 每个写端点（POST/PATCH/PUT/DELETE）在 `--dry-run` 下产出一个 `DryRunHalt` 计划，
    且 URL 经 `redactUrl` 后不含任何 secret；
  - 每个 GET 拼出一个合法 URL（`new URL()` 可解析、占位段被实参替换）；
  - `USER` 的 7 条被前置拒绝为 exit 2（`tokenType` 判定，网络 IO 之前）；
  - `{oauth2_root}/authorize` **不在 catalog 里**，因此走「未知路径」分支 → 同样 exit 2，
    消息里额外点明「这是浏览器授权页，不是 REST 端点」（design D2.8）。
- 未知路径 → exit 2 且给出最近匹配建议；`DELETE /v1/pjm/projects/{id}` → exit 2 并列出该路径
  实际支持的 method。
- `api list --module scm` 出 36 行、`--module pjm` 出 145 行、`--token ENT` 出 61 行、
  `--method PUT` 出 10 行（这 10 条永远只在通用层可达，design D8.4）。
- `--json` 在 `api` 下是 no-op 且已在 `--help` 与 SKILL.md 写明；stdout 恒为原始 JSON。
- **此 child 落地即达成 PRD A3 第一条与「完全体可达」验收。** 在 child 的完成说明里显式记这一句。

**依赖**：F2（需要 catalog）；F1（需要 `registry.ts` 与 per-group 快照）。**可并行**：与 F4 并行。

**触及**：`src/cli/commands/api.ts`、`src/cli/registry.ts`（一行）、`test/help/api.test.ts` + 快照、
`test/apiCommand.test.ts`、`skills/pingcode/modules/api.md`。

---

### F4 — metadata registry 重构（行为零变化）

**交付物**

- `src/core/metadata/{registry.ts,resolve.ts,index.ts}`，`index.ts` 再导出全部现有公共符号，
  **所有现有 import 路径不变**（design D4.2）。
- `RESOLVERS` 表：label / path / parent / parentQuery / aliases / hint；
  `export type MetaKind = keyof typeof RESOLVERS` 取代手写 union。
- `parseWorkItemRef` / `resolveWorkItem` / `loadSuiteTree` / `resolveShipRef` 保持定制（D4.3）。
- `src/cli/commands/resolve.ts`：`pingcode resolve <kind> <name> [--parent <id>] --json` 与
  `pingcode resolve --list`；`test/help/resolve.test.ts` + 独占快照。

**验收**

- **既有 `test/metadata.test.ts`(419) / `test/shipMetadata.test.ts`(538) /
  `test/testhubMetadata.test.ts`(720) 未经修改即通过。** 任何一行需要改 = F4 失败。
- `MetaKind` 由表派生（删掉一行表项，TS 立刻在对应调用点报错，用一次临时改动证明）。
- 每个仍手写的 resolver 体 ≤ 5 行；`metadata` 目录总行数相对原 1457 行显著下降（记录实际值）。
- `pingcode resolve project <name> --json` 输出即 `ResolveResult` 的序列化形态，字段名不变。

**依赖**：F1（`registry.ts`、per-group 快照）。**可并行**：与 F3 并行（文件集不交）。

**触及**：`src/core/metadata.ts` → `src/core/metadata/**`、`src/cli/commands/resolve.ts`、
`src/cli/registry.ts`（一行）、`test/help/resolve.test.ts` + 快照。

---

### F5 — 跨对象注入器 + `api/common.ts`（承载 PRD S0）

**交付物**

- `src/api/common.ts`：relations / comments / attachments / activities 的封装（design D7.0 的 15 条）。
- `src/cli/commands/_shared/crosscutting.ts`：`addCrosscutting(parent, principalType, opts)`。
- 挂到现有 5 个精修实体：`project work-item`、`product idea`、`product ticket`、`testhub cases`、
  ~~`testhub plans`~~ → **`testhub runs`**（挂哪些族由实机支持情况决定，见验收）。
  **实机修正（F5，2026-08-03）：测试计划不是 principal** —— 四族全拒，其中 `activities` 回
  HTTP 500，所以第五个挂载点从 plans 换成 runs（`test_run` 四族全通）。定稿表见 design D5.2。
- 一快照多挂载断言（design D5.6）：一个挂载点做 `toMatchSnapshot()`，其余做归一化后的结构化等值。
- `src/types/crosscutting.ts` + `src/api/parse/crosscutting.ts`。

**两项前置实机验证（都必须先做）**

1. **附件上传形态**（design D5.5）：`POST /v1/attachments` 是单步 multipart、预签名两步、还是
   代码片段 JSON 可用。需要改 `wire.ts` / `http.ts` → **停下上报**，本 child 只做
   `attachment list|get|delete`。
2. **`POST /v1/relations` 的 body 契约**（design D7.6）：research 没有给出它的字段表。必须确认
   它是否需要 relation type id，以及那个 id 来自哪张词表（pjm 的工作项关联类型，还是一套独立的
   全局关联类型）。**结论直接决定 S2b 的纳入理由是否成立** —— 若它用的是**另一套**词表，
   回写 design D7.6、PRD 的 S2 纳入理由，并在报告里指出。

**验收**

- `relations` / `comments` / `attachments` / `activities` 在 **work_item / ticket / idea / case**
  四类实体上实机可用（PRD A2 第一条），逐条记录实机输出。
- catalog 测试证明**没有族被挂到不支持的实体上**；同时在 child 说明里写明 catalog 只能证明端点存在、
  不能证明该 `principal_type` 被接受，后者由上一条实机覆盖。
- 跨对象一项新增的帮助快照条目数 ≤ 2（证明 D5.6 的机制生效，而不是新增约 40 个）。
- 每个新观测到的错误码：要么带证据进 `ERROR_CODE_OVERRIDES`，要么显式论证不加（PRD R5）。

**依赖与顺序**

- 依赖 F1、F3（`api describe` 用于查 principal 参数）、F4（`resolve` 用于父引用解析）。
- **不可并行**：它是 Phase S 的共同前置。
- **F5 不等 S2b。** `POST /v1/relations` 需要的 relation type id，F5 用通用层取：
  `pingcode api GET /v1/pjm/work_item/relation_types`（F3 之后即可用）。精修查表
  `project meta relation-types` 由 **S2b** 交付，属体验补全，不是 F5 的阻塞前置
  —— 这正是 D1 两层模型的实际收益：Reach 先到，Ergonomics 后补。
- **F5 必须把实机观测到的 relation type `id` / 名称对照表记进完成说明**，S2b 的 resolver 拿它对账。
  这条顺序写在 F5 与 S2b 双方的 artifact 里，不靠父子树位置表达（design D7.6）。

**F5 实机结论（2026-08-03）：这条依赖不存在。** `POST /v1/relations` 没有任何 relation type 字段，
它与 `relation_types` 无关；后者是**同类工作项关联族**（S2b 的
`POST /v1/pjm/work_items/{id}/relations`）的前置。design D7.6 与 PRD S2 的纳入理由已在同一个
commit 里改写，端点条数与三集合平衡不变。对账表（9 条 `category`/名称，id 逐租户不同）见 D7.6。
15 条中实现 14 条：文件上传（单步 multipart，需改禁改文件）出范围，见 design D5.5。

**触及**：`src/api/common.ts`、`src/api/parse/crosscutting.ts`、`src/types/crosscutting.ts`、
`src/cli/commands/_shared/crosscutting.ts`、`src/core/endpoints.ts`（追加通用层分区）、
`test/help/{project,product,testhub}.test.ts` + 各自快照、`test/crosscutting.test.ts`、
`skills/pingcode/modules/crosscutting.md`。

---

### Phase F 依赖图

```
F1 ∥ F2  →  F3 ∥ F4  →  F5  →  Phase S（8 个 child）  →  Phase X
                                  │
                                  ├─ S1a ──→ S1b ∥ S1c        （S1a 是 scm 地基）
                                  ├─ S1d                       （零共享，无条件并行）
                                  ├─ S2a ∥ S2b                 （共享 project 快照，先合并者胜）
                                  ├─ S3
                                  └─ S4
```

**跨阶段内容依赖（唯一一条，不靠树位置表达）**：F5 的 relations 写入需要 relation type id →
F5 用通用层取并记录观测值；S2b 交付精修查表 `project meta relation-types` 并承担 relations
创建链路的端到端验收。写在 F5 与 S2b 各自的 artifact 里（design D7.6）。

**F1 是全树硬门禁**：F1 未合并前不得启动任何模块子任务（design D9 风险 1）。
F2 可与 F1 并行，因为它不碰 `test/help/**` 也不碰 `types`/`parse`。

---

## Phase S · 阶段实现（F5 后基本全并行）

优先级按 PRD 阶段与用户给定顺序：**S0（最高，其基础设施由 F5 承载并在 F5 里完成）→ S1 CICD →
S2 规划补写 → S3 测试补齐 → S4 需求补齐**。

**端点预算（PRD 定稿，child 不得自行改动）**：S0 15 + S1 **44** + S2 **30** + S3 13 + S4 5 = **107**。
六个 S child 的端点数之和必须等于 107 − 15（S0 由 F5 承载）= **92**。

每个 S child 的验收模板（除各自的专属项外，一律附加）：

> 1. 该阶段的 happy-path 在真实租户上跑通，逐条记录实机输出；每个新观测到的错误码**要么**带一次
>    smoke 证据进 `ERROR_CODE_OVERRIDES`，**要么**在 `design.md` 里显式论证不加（PRD R5）。
> 2. `--json` stdout 纯净、`--dry-run` 零写入并打印完整请求计划。
> 3. 新增叶子只出现在自己模块的 `test/help/<group>.test.ts` 与其独占快照里。
> 4. **本 child 不得为任何 `PUT` 端点创建精修命令（依 design D8.4，PRD 已采纳为硬约束）。**
>    若本 child 的模块含 `PUT`，需有一条测试断言对应叶子不存在，并在 `modules/<module>.md` 里
>    指明用 `pingcode api PUT` 兜底。

---

### S1a — scm 平台与仓库骨架（platform / platform-user / repo）

**交付物**：新建命令组 `scm`。端点 4 + 4 + 4 = **12 条**（design D7.1 前三节，各家族 5 条**扣除
1 个 `PUT`**）。叶子 12 条：`scm platform list|get|create|update`、
`scm platform-user list|get|create|update`、`scm repo list|get|create|update`。
同时建立 scm 的地基：`endpoints.ts` 的 scm 分区、`types/scm.ts`、`api/parse/scm.ts`、`api/scm.ts`、
`cli/commands/scm/{index,platform,platformUser,repo}.ts`、`test/help/scm.test.ts` 及其独占快照。
metadata 新增 kinds：`scm-platform`、`scm-repo`（`registry.ts` 加两行）。

**专属验收**

- 3 个 `PUT` 均不存在精修叶子（模板第 4 条）。
- 平台用户映射跑通：能把一个 git 作者身份关联到 PingCode 成员 —— **commit 归属靠它**，
  没有映射，S1b 写回的 commit 挂不到人。

  > **S1a 实机推翻了这条的前提（2026-08-03，已记入 design.md §D11）。** 托管平台用户
  > **完全不携带 PingCode 成员引用**：资源恰为 `{id, url, product, name, display_name,
  > html_url, avatar_url}`，读写都没有 `user` / `user_id` / `email`。POST 里带 `user_id`
  > 或 `email` 返回 200 但**静默丢弃**（回读不存在）—— 这条更一般的教训是：**本 API 忽略
  > 未知 body 字段而不是拒绝它们**，所以「200」不等于「字段被接受」，写路径必须回读验证。
  >
  > 映射实际是**按 name 字符串**：commit 的 `committer_name` / 分支的 `sender_name` 与这些
  > 行匹配。更强的证据是仓库的 `owner_name` 是 **upsert** —— `--owner-name no-such-git-user`
  > 返回 200 并**新建**了一个平台用户。**给 S1b 的两条后果**：①先建身份再写 commit；
  > ②`committer_name` 打错很可能凭空造出一个**无法删除**的幽灵身份（scm 全域无 DELETE），
  > S1b 应把这一点当作一条待确认项而不是假设。

- 本租户几乎肯定没有托管平台/仓库，所以 `platform create` + `repo create` 就是 S1 全系列的
  前置数据制造者，其输出（`product_id` / `repository_id`）记进 child 完成说明供 S1b/S1c 使用。

  > **S1a 实机推翻了「几乎肯定没有」。** 租户已有 **2 个托管平台 / 38 个仓库 / 40 个身份**，
  > 其中 `Github`（`68393e8b47512a5d5d4e5b55`）与 `GitHub Enterprise`
  > （`685c6c3c2974f854bb4979ab`）是**真实生产集成**。因此 S1a 没有往它们里写，而是另建了一个
  > 隔离的 `[CLI smoke]` 平台。**S1b/S1c 必须沿用同一纪律：真实集成只读，写操作一律落在
  > 隔离的 smoke 平台上。** 由于 scm 全域没有任何 DELETE，写错即永久。

**依赖**：F5。**它是 scm 三个 child 的地基，必须第一个合并**（S1b/S1c 依赖它建立的 `scm` 组、
`types/scm.ts` 与 scm 快照文件）。这条顺序写在 S1b/S1c 各自的 `prd.md` 里，不靠树位置表达。

**触及**：`src/cli/commands/scm/{index,platform,platformUser,repo}.ts`、`src/api/scm.ts`、
`src/api/parse/scm.ts`、`src/types/scm.ts`、`src/core/endpoints.ts`（scm 分区）、
`src/core/metadata/registry.ts`（两行）、`src/cli/registry.ts`（一行）、
`test/help/scm.test.ts` + 独占快照、`test/scm.test.ts`、`skills/pingcode/modules/scm.md`。

---

### S1b — scm 分支 / 提交 / 提交引用（CI 写回主路径）

**交付物**：端点 5 + 3 + 3 = **11 条**（design D7.1 的代码分支、提交、提交引用三节）。
叶子 11 条：`scm branch list|get|create|update|delete`、`scm commit list|get|create`、
`scm ref list|get|create`。

**专属验收**

- `GET /v1/scm/commits/{commit_id_or_sha}` **按 SHA 取通**（A2 第二条点名的那条），
  SHA 原样透传、不做形状校验（`metadata.ts` 的「ids pass through untouched」纪律）。
- `scm branch delete` 有 `--yes` 门、确认信息回显**分支名**、无 `--all`
  —— 它是 49 个 DELETE 里最疼的两个之一（design D9 风险 3）。
- **代码分支家族没有 `PUT`**（第五个动词是 `DELETE`）—— child 需在 `modules/scm.md` 里点明这个
  与其他 scm 家族不同的形状，避免后来者"补全 PUT"。

**依赖**：F5，且**在 S1a 之后**（需要 `product_id` / `repository_id` 与 scm 地基）。
**可并行**：与 S1c 并行，但两者共享 `test/help/scm.test.ts.snap` → 先合并者胜，后者 rebase。

**触及**：`src/cli/commands/scm/{branch,commit,ref}.ts`、`src/api/scm.ts`、`src/api/parse/scm.ts`、
`src/types/scm.ts`、`src/core/endpoints.ts`、`test/help/scm.test.ts` + 快照、`test/scm.test.ts`、
`skills/pingcode/modules/scm.md`。

---

### S1c — scm 拉取请求与代码评审

**交付物**：端点 4 + 4 = **8 条**（design D7.1 的拉取请求、代码评审两节，各扣 1 个 `PUT`）。
叶子 8 条：`scm pr list|get|create|update`、`scm review list|get|create|update`。

**专属验收**

- PR 与代码评审的读写主线可用（A2 第二条）。
- 2 个 `PUT` 均不存在精修叶子。
- 确认 `/v1/reviews`（通用层 8 条）在代码评审流程中是否必需；必需则按 PRD 的回收条款纳入本 child
  并在 `design.md` D5.4 与 PRD 的配平算式里补记（**会改动 In/Out 数字，须先上报**），
  否则明确留在通用层。
- `scm review`（PR 上的代码评审记录）与通用层 `/v1/reviews`（评审对象）**不是同一资源**，
  `modules/scm.md` 必须写清区别。

**依赖**：F5，且**在 S1a 之后**。**可并行**：与 S1b 并行（共享 scm 快照，见 S1b）。

**触及**：`src/cli/commands/scm/{pr,review}.ts`、`src/api/scm.ts`、`src/api/parse/scm.ts`、
`src/types/scm.ts`、`src/core/endpoints.ts`、`test/help/scm.test.ts` + 快照、
`skills/pingcode/modules/scm.md`。

---

### S1d — build + release（流水线写回）

**交付物**：两个新命令组 `build` 与 `release`。端点 5 + 8 = **13 条**
（build 6 扣 1 个 `PUT`；release 主线 8 = env 4 + deploy 4）。
叶子 13 条：`build list|get|create|update|delete`、`release env list|get|create|update`、
`release deploy list|get|create|update`。

**专属验收**

- `build create|update` 能把一次构建事实写回并挂到工作项上（A1 的「写回构建」跳）。
- `release deploy create` 能写回部署记录（A1 的「写回部署」跳）。
- 3 个 `PUT`（build 1 + release 2）均不存在精修叶子。
- `release env` / `release deploy` 的字段契约实机确认后写进 `design.md`；
  两个 `DELETE` 的纳入与否按实机结果决定并写明理由（PRD Open Question 第三条）。
  **若决定回收，会改动 In/Out 配平数字，须先上报。**
- `build delete` 有 `--yes`、无 `--all`（构建记录可重建，符合 PRD R3）。

**依赖**：F5。**与 scm 三个 child 完全并行、零共享快照** —— 它拥有 `build` 与 `release` 两个独立
命令组，因此独占 `test/help/build.test.ts.snap` 与 `test/help/release.test.ts.snap`。

**触及**：`src/cli/commands/build.ts`、`src/cli/commands/release/**`、`src/api/{build,release}.ts`、
`src/api/parse/scm.ts`（devops 共用 parser 分区）、`src/types/scm.ts`、`src/core/endpoints.ts`、
`src/cli/registry.ts`（两行）、`test/help/{build,release}.test.ts` + 各自独占快照、
`skills/pingcode/modules/cicd.md`。

---

### S2a — 迭代与版本（sprint + version）

**交付物**：端点 4 + 6 = **10 条**（design D7.2 前两节）。
叶子 10 条：`project sprint list|get|create|update|bulk` 里的 `create|update|bulk|get`（列表已存在，
为 `project meta sprints`）、`project version create|list|get|update|delete|bulk`。

**专属验收**

- 迭代可建可改；版本可建可挂（A2 第三条的一半）。
- `project sprint get`（`GET …/sprints/{sprint_id}`）落地 —— PRD 定稿新纳入的 3 条之一。
- 两条 `*/bulk` 的 ENT-only + 无声明 scope 如实反映在 `api describe` 与 help 里。
- **`sprint delete` 不存在**、**`project delete` 不存在** —— help 与 modules 文档里显式说明，
  测试断言这两条叶子不存在（防止后来者"补全对称性"）。
- 「版本 / 发布 / wiki 页面版本 / 配置里的方案 plan」四义同名在 `modules/pjm.md` 里消歧。

**依赖**：F5。**可并行**：与 S2b 并行（叶子与文件分区不同，共享 `test/help/project.test.ts.snap`
→ 两者之一先合并，另一个 rebase；这是 project 组内唯一的协调点）。

**触及**：`src/cli/commands/project/{sprint,version}.ts`、`src/api/projects.ts`、
`src/api/parse/pjm.ts`、`src/types/pjm.ts`、`src/core/endpoints.ts`、
`src/core/metadata/registry.ts`（`pjm-version` 等）、`test/help/project.test.ts` + 快照。

---

### S2b — 工作项写与关联 + 关联类型词表 + 项目写与成员

**交付物**：**20 条端点**（design D7.2 后两节，逐条以该表为准）：
`work_items/search` 1 + `PATCH work_items` 1 + `DELETE work_items/{id}` 1 +
`work_items/{id}/relations` 4 + `work_items/{id}/tags` 3 + `transition_histories` 2 +
**`work_item/relation_types` 1 + `work_item/tags` 1** + `projects` 写 2 + `progress` 1 + `members` 3。

叶子 **19 条**（`search` 增强现有 `project work-item list`，不新增叶子）：
`work-item bulk-update|delete`、`work-item link add|list|get|delete`、
`work-item tag add|get|delete`、`work-item history list|get`、
**`project meta relation-types`、`project meta tags`**、`project create|update|progress`、
`project member add|list|get`。

**专属验收**

- 工作项可批量改、可删、可搜（`POST …/search` 的过滤 DSL）、可关联（A2 第三条的另一半）。
- `project work-item delete` 有 `--yes`、回显 identifier + 标题、无 `--all`。
- **`GET /v1/pjm/work_item/relation_types` 必须由本 child 承担**，且验收包含
  **relations 创建链路端到端跑通**：`project meta relation-types` 取到 relation type →
  用它 `<entity> relation add` 建立一条真实关联（消费 F5 交付的命令）→
  `relation list` / `relation get` 反查到同一条 → `relation delete --yes` 清理。
  逐跳记录实机输出。**这是 S0 的 relations 写入从"能发请求"变成"可用"的那一步**（design D7.6）。
- **`work-item tag list` 不存在**（上游只有 get-one，[S§3.8.3]）—— help 里说明去读工作项的
  `tags[]`；`project meta tags` 是唯一可枚举标签的入口，`--tag` 的名字解析以它为数据源。
- `work-item link`（`work_items/{id}/relations`）与 F5 的 `work-item relation`（`/v1/relations`）
  两条路并存，help 里说明何时用哪条；两者不得互相冒充。

> **拆分规则（已按定稿数字重算）**：本 child 是 20 条端点 / **19 条叶子**，正好在「叶子超过约 20
> 就再拆」的阈值之下 —— PRD 回收的 2 条 meta 叶子已经吃掉了全部余量。因此**触发再拆的条件是明确
> 的**：若 PRD Open Question 里的 `DELETE …/members/{member_id}`（项目成员移除）被回收，
> 或实现中发现某条需要拆成多个叶子，叶子数将 ≥ 20 → **必须**拆成
> S2b-1（search + bulk + delete + 两条 meta 词表）与 S2b-2（link + tag + history + project 写 +
> members），并把决定写进 child 的 `prd.md`。开工前先按实际叶子清单点一次数。

**依赖**：F5（本 child 的端到端验收要调用 F5 交付的 `relation add`）。
**可并行**：与 S2a 见上（共享 project 快照）、与 S1*/S3/S4 全并行。
**顺序**：S2b 在 F5 之后；F5 **不**等 S2b（F5 用通用层
`pingcode api GET /v1/pjm/work_item/relation_types` 取 relation type，见 design D7.6）。

**触及**：`src/cli/commands/project/{workItem,member,meta,index}.ts`、`src/api/workItems.ts`、
`src/api/parse/pjm.ts`、`src/types/pjm.ts`、`src/core/endpoints.ts`、
`src/core/metadata/registry.ts`（新增 `pjm-relation-type`、`pjm-work-item-tag` 两个 kind）、
`test/help/project.test.ts` + 快照、`test/commands.test.ts`。

---

### S3 — 测试补齐 + `cli/commands/testhub.ts` 按资源拆分

**交付物**

- design D7.3 的 **13 条端点**（PRD 定稿数）：`cases bulk-create|bulk-update|delete|history`、
  `runs create|bulk-create|bulk-update|history`、`plans update`、
  `meta plan-states|case-properties`。
- **同时**把 `src/cli/commands/testhub.ts`（1845 行）拆成
  `cli/commands/testhub/{index,libraries,cases,plans,runs,meta}.ts`（design D6.5，**不得推后**）。

**专属验收**

- 用例可批量导入、执行记录可建可批量改、执行历史可读（A2 第四条）。
- run 侧与 case 侧的 history **两个不同形状，两个 deserializer**（[TH§11]）。
- `GET /v1/testhub/cases/{id}/histories` 声明的 `write:` scope 实机确认，结论写进 `design.md`。
- `GET /v1/testhub/runs` **已被 PRD 定稿从 S3 移除**并转入 Out of scope（依 `endpoints.ts:140`），
  child 无需再论证这次取舍；只需确认没有为它建叶子。
- testhub 的 1 个 `PUT`（`/runs/{run_id}`）不得有精修叶子（模板第 4 条）；`modules/testhub.md` 说明
  它会清空 executor（[TH§7] 实机证据），要改单条 run 只能用 `PATCH`。
- bulk 的客户端 ≤50 上限沿用，`--dry-run` 下先探。
- 拆分是零行为变化：拆分 commit 与新叶子 commit **分开**，前者的 `--help` 输出逐字节不变。

**依赖**：F5。**可并行**：与 S1*、S2*、S4 全并行（`test/help/testhub.test.ts.snap` 独占）。

**触及**：`src/cli/commands/testhub/**`（新）、`src/cli/commands/testhub.ts`（删）、
`src/api/testhub.ts`、`src/api/parse/testhub.ts`、`src/types/testhub.ts`、
`src/core/endpoints.ts`、`src/core/metadata/registry.ts`、`test/help/testhub.test.ts` + 快照、
`test/testhub*.test.ts`、`skills/pingcode/modules/testhub.md`。

---

### S4 — 需求补齐（排期 + 流转历史）

**交付物**：design D7.4 的 **5 条端点**：`product meta idea-plans`、`product plan list|get`、
`product idea history list|get`。

**专属验收**

- 排期与流转历史可读（A2 第五条）。
- 单数 `idea` 段陷阱在 `endpoints.ts` 里带注释（与现有四条同款）。
- 「需求排期 / 测试计划 / 配置方案」三义同名在 `modules/ship.md` 里消歧。
- ship 仍然**没有任何 DELETE**，SKILL.md 的 `nothing in ship can be deleted` 断言保持不变。

**依赖**：F5。**可并行**：全并行（`test/help/product.test.ts.snap` 独占，但与 F5 的 idea/ticket
挂载共享 → F5 先合并即无冲突）。

**触及**：`src/cli/commands/{product,idea}.ts`、`src/api/ship.ts`、`src/api/parse/ship.ts`、
`src/types/ship.ts`、`src/core/endpoints.ts`、`test/help/product.test.ts` + 快照、
`skills/pingcode/modules/ship.md`。

---

### Phase S 写作用域不重叠证明（并行派发的前提）

| child | 端点 | 叶子 | 独占的命令文件 | 独占的快照 | 共享文件（仅追加） |
|---|---|---|---|---|---|
| S1a | 12 | 12 | `cli/commands/scm/{index,platform,platformUser,repo}.ts` | 建立 `scm.test.ts.snap` | `endpoints.ts`、`registry.ts`、`metadata/registry.ts` |
| S1b | 11 | 11 | `cli/commands/scm/{branch,commit,ref}.ts` | `scm.test.ts.snap`（与 S1a/S1c 共享） | 同上 + `types/scm.ts`、`api/parse/scm.ts` |
| S1c | 8 | 8 | `cli/commands/scm/{pr,review}.ts` | 同上 | 同上 |
| S1d | 13 | 13 | `cli/commands/build.ts`、`cli/commands/release/**` | `build.test.ts.snap`、`release.test.ts.snap`（**独占，零共享**） | 同上 |
| S2a | 10 | 10 | `cli/commands/project/{sprint,version}.ts` | `project.test.ts.snap`（与 S2b 共享） | 同上 |
| S2b | 20 | 19 | `cli/commands/project/{workItem,member,meta}.ts` | 同上 | 同上 |
| S3 | 13 | ~10 | `cli/commands/testhub/**` | `testhub.test.ts.snap` | 同上 |
| S4 | 5 | 5 | `cli/commands/{product,idea}.ts` | `product.test.ts.snap` | 同上 |

**端点预算自证**：12 + 11 + 8 + 13 + 10 + 20 + 13 + 5 = **92** = In scope 107 − S0 的 15（由 F5 承载）✅
其中 S1 四个 child = 12 + 11 + 8 + 13 = **44** ✅、S2 两个 child = 10 + 20 = **30** ✅。

**切分依据**（三条，按优先级）：

1. **单 child 叶子数 ≤ 20**（可 review 的上限）。这条把旧方案的 S1a（26 端点 / 23 叶子）否掉了 ——
   旧 S1a/S1b 还有一个算术错误：26 + 28 = 54 ≠ 50，它把 release 按 12 条算而 S1 总数按 8 条算。
   现在四个 scm/devops child 最大 13 叶子，两个 pjm child 最大 19 叶子。
2. **命令组边界优先于端点数量**：S1d 单独拿走 `build` + `release` 两个组，于是它**独占**两个快照
   文件、与 scm 三个 child 零冲突面 —— 用一次切分同时换到"体量合适"和"零协调"。
3. **地基先行**：S1a 建立 `scm` 组、`types/scm.ts`、scm 快照与两个 metadata kind，S1b/S1c 才有
   东西可挂。这是 S1 内唯一的强顺序。

**需要协调的共享点只有四类**（第四类由 S1a 实机发现，原表漏了）：

| 共享点 | 参与者 | 处理方式 |
|---|---|---|
| `test/help/scm.test.ts.snap` | S1a → S1b ∥ S1c | S1a 先合并（地基），S1b/S1c 谁先合并谁胜，另一个 rebase |
| `test/help/project.test.ts.snap` | S2a ∥ S2b | 先合并者胜，后者 rebase |
| `endpoints.ts` / `cli/registry.ts` / `metadata/registry.ts` 的追加行 | 全部 8 个 child | 尾部按模块分区追加，冲突平凡 |
| **`test/help/resolve.test.ts` + `resolve.test.ts.snap`** | **任何往 `metadata/registry.ts` 加行的 child** | 计数断言 + 每行一条生成叶子，**必然**同改；先合并者胜，后者 rebase |

> **第四类的由来（S1a，2026-08-03）**：F4 让 `pingcode resolve` 的叶子**由 `RESOLVERS` 表派生**，
> 所以「往 registry 加一行」与「改 resolve 的帮助快照」是同一个动作的两面 —— 加两行 kind 就把
> `test/help/resolve.test.ts` 的 `27→29` / `25→27` 两处计数断言和快照一起带上了。原表把
> `metadata/registry.ts` 归入「追加行，冲突平凡」，**低估了它**：追加行本身平凡，它派生出的
> 快照不平凡。这是 F4 的表驱动设计买到的便利（零 resolver 代码）所对应的代价（一处共享快照），
> 不是缺陷。后续每个加 kind 的 child 都应预期这处 diff，**不要以为自己弄坏了什么**。

**S1d、S3、S4 零共享快照**，可无条件并行。**这就是 F1 拆分快照文件所买到的东西**：八个并行 child
只剩两处需要排序，而不是八个都在同一个 17.6 KB 快照里互撞。

---

## Phase X · 收尾（串行，最后）

### X1 — 文档

- `README.md`：两层模型说明（**可达 459 / 精修约 150**）+ **按模块的精修覆盖表**
  （形如 `pjm 精修 40/145 · scm 31/36 · build+release 13/18 · 通用层可达 459/459`）。
  覆盖基线数字取 F2 实测（design D10 待验项 ③），不要抄本文档里的估算值。
- 同时记录 PRD 的三集合配平（已覆盖 53 + In scope 107 + Out of scope 299 = 459）与
  **10 个 `PUT` 一律只在通用层可达**这条约束 —— 用户会问"为什么没有 `scm platform replace`"。
- `skills/pingcode/SKILL.md`：分层文档定型 —— 根文档只留鉴权、全局契约、退出码、
  `api`/`api list`/`api describe`/`resolve` 逃生舱、以及 allowlist 里的各条精修流程；
  模块细节全在 `modules/*.md`。
- 新增 scope 清单（见「前置准备」）写进 README 与 SKILL.md。

**依赖**：全部 S child。

> **X1 实测回填（2026-08-05，落地时改写）。** 上面三处数字里有两处是实现前的估算，实测后不成立；
> 全部逐条量法与命令见 `research/x1-doc-measurements.md`，**README 发布的是实测值**。
>
> | 本节写的 | 实测 | 说明 |
> |---|---|---|
> | 精修约 **150** | **158** | 按 `(method, path)` 建账。`pjm 40/145 · ship 27/101 · testhub 32/65 · scm 31/36 · build 5/6 · release 8/12 · 跨对象 14/15 · directory 1/23 · wiki 0/19`，合计 158 / 459，其余 **301** 只在通用层可达 |
> | `build+release 13/18` | ✅ 正确 | build 5/6 + release 8/12，本节的举例数字恰好命中 |
> | `scm 31/36` | ✅ 正确 | 5 个 `PUT` 全部按 D8.4 留通用层 |
> | PRD 配平 53 + 107 + 299 | 53 + **105** + **301** | 已覆盖 **53 完全准确**（pjm 10 + directory 1 + ship 22 + testhub 20，用同一脚本跑 `cf8335f~1` 复算得到，PRD 的「待实测」到此关闭）；In scope 少落地 2 条 |
>
> 少落地的 2 条，都有明确理由，不是漏做：
> 1. `POST /v1/attachments` 的 **`multipart/form-data`** 形态（PRD S0 的第 5 条附件端点）——
>    真正的文件分片必须改 `core/wire.ts`，PRD R1 明令「停下来上报」，F5 因此只落地 JSON 代码段那半，
>    并把另一半写进 `modules/crosscutting.md` 与 README 的 follow-up。
> 2. `GET /v1/testhub/plan_states/{state_id}`（PRD S3 的 `plan_states × 2` 的 get-one）——
>    无消费者：计划写入要的是 `state_id`，而列表（`testhub meta plan-states`）就是它的来源。
>    `ENDPOINTS.testhubPlanState` 已存在但无人调用，记在 `modules/testhub.md` §5。
>
> 另一处**不是**冲突但会被误读的数字：叶子数从 design D1 估的「约 150 条」变成 **254 条**。
> 这不是多写了一百条手写命令 —— F5 的四个跨对象家族是**一份实现挂五个实体**（14 端点 → 70 叶子），
> F4 又把 31 个 resolver kind 各暴露成一条 `resolve` 叶子（+32）。所以 README 发布的是**端点表**，
> 并明确警告不要拿叶子数去比端点数。

### X2 — 漂移治理

- `.github/workflows/catalog-check.yml`：**每周定时** `npm run catalog:check`（非 PR 门禁，
  design D2.5）。失败时创建/更新一个 issue，而不是让 main 变红。
- 漂移处理 runbook 写进 `.trellis/spec/backend/`：谁跑 `catalog:sync`、生成物如何单独提交、
  与实机冲突时如何按 PRD R2 判定、消失的端点如何处理（先标 `deprecated` 观察一周期，不立即删命令）。

**依赖**：F2。可与 X1 并行，但排在 Phase S 之后以免定时任务在 S 期间反复报噪。

### X3 — A1 端到端闭环实机验证（本任务主验收）

脚本化跑通 PRD A1 那条完整链路，每一跳记录命令、`--json` 输出摘要、以及网页端可见的证据：

1. `product idea create` 建需求
2. `product idea relation add`（或 `project work-item link add`）关联到工作项
3. `project work-item update --sprint`（或 `sprint bulk`）入迭代
4. `project version create` + 工作项挂版本
5. `testhub cases create` 建用例 + `testhub cases relation add` 关联工作项
6. `testhub plans create` + `testhub runs create` 建计划与执行记录
7. `testhub runs patch --status 失败` 记录执行失败
8. `project work-item create --type bug` 建缺陷 + `relation add` 关联用例
9. `scm commit create` + `scm pr create` 写回 commit / PR
10. `build create` + `release deploy create` 写回构建与部署
11. 缺陷 `relation add` 关联到 commit

**验收**

- 全程 `--json` 可解析（每一跳的输出过一次 `jq`），可被 agent 无人工干预驱动（A1 第二条）。
- 同一条链路的 `--dry-run` 变体**零写入**且打印完整请求计划 —— 用一次 list 复核 `total` 未变
  （A1 第三条，沿用 [TH§14.7] 的证明方式）。
- 每一跳的关联在 PingCode 网页端可见，逐跳记录。
- 全部 smoke 数据带 `[CLI smoke]` 前缀；不可删除的残留（如无 DELETE 的对象）如实列出，
  不隐藏（[TH§14.6] 的先例）。

**依赖**：全部 S child + X1。

---

## 每阶段的验证命令

```bash
# 每个 child 的最小闭环（提交前必跑）
npm run typecheck
npm test
npm run build
node dist/bin/pingcode.js --help          # 打包产物能启动，tsc 过不代表它能跑

# catalog 相关（F2 之后）
npm run catalog:check                     # 与线上比对；F2 与 X2 必跑，其他 child 可选
node dist/bin/pingcode.js api list --module <m>
node dist/bin/pingcode.js api describe <id>

# 提交纪律
npm run scan:secrets
npm run check:commits

# tsc 墙钟（F2 专用，各三次取中位数）
for i in 1 2 3; do /usr/bin/time -f %e npx tsc --noEmit; done
```

**实机 smoke 的形态**（每个 S child 与 X3）：

1. 先 `auth status --check` 确认令牌与 scope；403 时**报告缺哪个 scope，不要猜**。
2. 每个写命令**先 `--dry-run --json`**，确认 URL、method、body 都对，再去掉 `--dry-run`。
3. 每条命令的 happy-path + 一条故意的错误输入（验 exit 2）+ 一条不存在的 id（验 exit 5 或记录
   实际码）。
4. 凭据只走 `~/.pingcode/config.json` 或 `PINGCODE_CLIENT_ID/SECRET` + 隔离的
   `PINGCODE_CONFIG_DIR`；**不写进任何文档或测试**。

**租户前置数据**（X3 与各 S child 共用，缺哪个补哪个）：

- 一个 pjm 项目（含至少两个工作项类型、一个迭代、一个版本）
- 一个 ship 产品（含至少一个需求、一个工单）
- 一个 testhub 测试库（含至少一个用例、一个测试计划）
- **一个 scm 托管平台 + 一个仓库 + 一个分支** —— **S1a 已完成并推翻了原假设**（原文写「当前租户很可能
  没有」）。租户实际已有 **2 个托管平台 / 38 个仓库 / 40 个身份**，其中 `Github` 与
  `GitHub Enterprise` 是真实生产集成。S1a 因此**没有**往它们里写，而是另建了隔离的
  `[CLI smoke] pingcode-cli` 平台（`type: other`）。S1b/S1c 直接复用：
  platform `6a7052e9919cce9794f005f1`、repo `6a70532d919cce9794f00607`（另有一个同名不同
  owner 的仓库 `6a705358919cce9794f00616` 作名字冲突夹具）、身份 `cli-smoke-bot`
  `6a7052f839cbed1cf7125f78`。**纪律：真实集成只读，写一律落隔离平台 —— scm 全域没有任何
  DELETE，写错即永久。** 分支仍需 S1b 自己用 `scm branch create` 造。
- 一个 release 环境（`release env create`，同上）

---

## Review gates

### G1 — F1 + F2 完成后（基础设施定型）

评审对象：生成物的**形状**与测试架构。具体要看：

- `CatalogEntry` 的字段集是否够 `pingcode api` 用、是否有多余字段；
- `paged` 派生的启发式对 459 条的判定快照（人工过一遍，这是唯一一次成本可接受的机会）；
- provenance + 内容哈希 + 分层 + `.gitattributes` 四道防护是否都有测试落点；
- `test/help/**` 拆分后是否真的做到「每组独占快照」「root 断言自满足」；
- `tsc --noEmit` 墙钟时间对比数字；
- `types/*` 与 `api/parse/*` 的再导出是否真的让所有现有 import 路径不变。

**不通过则不得启动 F3/F4。**

### G2 — F3 完成后（可达验收达成）

评审对象：通用层的**安全面**。具体要看：

- 49 个 DELETE 的 `--yes` 门是否无法绕过（含 `--body-file` 走 DELETE 之类的边角）；
- 令牌类型校验是否真的在网络 IO 之前（用注入的 `fetch` 断言零调用）；
- 未知路径建议算法不会把 `DELETE` 建议成一个更危险的邻近路径；
- 459 条可调用性测试是否真的覆盖 **459** 条（不是 458、不是 460、也不是"抽样"）；
- catalog 里确实没有任何非 `/v1` 路径（`authorize` 已剔除，design D2.8）；
- `--json` no-op 的文档化；
- **在这里正式记录：PRD 的完全体可达验收已达成。**

### G3 — Phase S 全部完成后（跨模块一致性 + A1 闭环）

评审对象：

- **八个** child 的命令命名是否一致（`create/list/get/update/delete` 动词表、`--x` / `--x-id` 成对、
  `delete` 一律 `--yes`）；
- 八个 child 的端点数之和是否仍等于 **92**（= In scope 107 − S0 的 15），
  以及 **没有任何 `PUT` 获得精修叶子**（design D8.4）；
- `ERROR_CODE_OVERRIDES` 的每一行是否都有 smoke 证据，每条不加的决定是否都写了理由；
- 各模块的「上游缺失的对称操作」是否都在 help / 文档里说明而不是留给用户去撞；
- X3 的 A1 链路是否**每一跳**都有实机证据与网页端确认；
- `test/layering.test.ts` 的不变式是否被放宽过（PRD A4）。

---

## 回滚点

- **每个 child 是一个独立可 revert 的提交边界**，每个 commit 落地时 typecheck + test 全绿。
- **catalog 生成物与手写代码分开提交**：`catalog.generated.ts` + `.gitattributes` 一个 commit，
  `core/catalog/index.ts` + 测试另一个。回滚生成物与回滚加载逻辑互不牵连。
- **F1 的拆分**（help 测试 / types / parse / SKILL modules）：全部走再导出与文件移动，
  `git revert` 即回到原状，不影响任何调用点。
- **F4 若行为不等价**：`git revert` 那一个 commit 即回到旧 `metadata.ts`。这之所以安全，是因为
  F4 唯一的对外契约是「import 路径不变、导出符号不变」——
  其他 child 只依赖这个契约，不依赖 `RESOLVERS` 的内部形状。因此即使 F4 被回滚，
  已经合并的 S child 仍然可编译可运行（它们注册的新 kind 需要一并回滚，
  所以 **F4 的 revert 必须连带 revert 各 child 里 `registry.ts` 的新增行** ——
  这一点写进各 child 的 `implement.md`）。
- **S3 的两个 commit 必须分开**：testhub 拆分（零行为变化）与新叶子。拆分若出问题可单独回滚。
- **实机 smoke 数据不可回滚**：ship 无 DELETE、testhub 无 library DELETE、pjm 无 project DELETE。
  因此所有 smoke 数据带 `[CLI smoke]` 前缀 + 时间戳，残留在收尾里如实列出。

---

## 前置准备

### 需在 PingCode 企业后台「凭据管理」新勾选的 scope（PRD Background）

```
pcp:read:pjm:project      pcp:write:pjm:project
pcp:read:pjm:workitem     pcp:write:pjm:workitem     ← 已有，确认 write 也在
pcp:read:pjm:sprint       pcp:write:pjm:sprint       ← S2a 必需
pcp:read:pjm:release      pcp:write:pjm:release      ← S2a 必需（版本 = 发布）
pcp:read:pjm:board        pcp:write:pjm:board        ← 仅在看板纳入时（PRD Open Question 第四条）
pcp:read:devops:code      pcp:write:devops:code      ← S1a / S1b / S1c 必需（scm 全系列）
pcp:read:devops:build     pcp:write:devops:build     ← S1d 必需
pcp:read:devops:deploy    pcp:write:devops:deploy    ← S1d 必需
pcp:read:wiki:space       pcp:write:wiki:space       ← 仅在 wiki 纳入时（默认不在闭环内）
pcp:read:wiki:page        pcp:write:wiki:page        ← 同上
pcp:read:global:workload  pcp:write:global:workload  ← 仅在工时纳入时（默认不纳入）
```

已有且继续需要：`pcp:read:global:team`、ship 的 product/idea/ticket/configuration 六项、
testhub 的 library/testcase/testplan/configuration 七项（见 `test/help.test.ts` 现有断言）。

**通用层的 27 条（relations / comments / attachments / activities / participants / reviews）
文档未声明 scope** —— 无法预先勾选，F5 的第一步就是实机确认它们是否 scope 豁免
（PRD Open Question 第二条）。

### 租户前置数据

见上文「实机 smoke 的形态」末段。**其中 scm 与 release 侧的对象（托管平台 / 仓库 / 分支 / 环境）
当前租户几乎肯定不存在**：托管平台与仓库由 **S1a** 创建（它的 `platform create` / `repo create`
就是 S1 全系列的前置数据制造者），分支由 **S1b** 创建，环境由 **S1d** 创建 —— 既是前置数据，
也是各自的第一条 smoke，不必额外准备。

**不需要为 `PUT` 做任何准备**：10 个 `PUT` 全在 Out of scope（design D8.4），
只在通用层被 `--dry-run` 覆盖，不参与任何实机写入。
**也不需要为 `{oauth2_root}/authorize` 做准备**：它已从端点集剔除（design D2.8），
不进 catalog、不被 `pingcode api` 接受。

### 需要提前和用户确认的两件事（不阻塞 F1–F4）

1. **pjm 看板 15 条是否纳入**（PRD Open Question 第四条）—— 取决于是否以看板驱动规划。
   不确认就默认留通用层。
2. **`DELETE /v1/pjm/projects/{id}/members/{member_id}`（成员移除）是否纳入 S2b** ——
   它可轻易重建，符合 R3，但 PRD S2 只写了 `members × 3`。⚠️ 若回收，S2b 的叶子数会从 19 升到 20，
   **触发 S2b 的再拆规则**，并且会改动 PRD 的配平算式（In 107→108、Out 299→298）—— 须先上报。
3. **`release` 的 2 个 `DELETE` 是否回收进 S1d**（PRD Open Question 第三条）—— 同样会改配平数字。
