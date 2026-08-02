# CLI 命令树按 GUI 模块聚合重组

## Goal

让 `pingcode --help` 的顶层结构与 PingCode 产品本身的模块划分一致。用户在 GUI 里
只看到「产品管理 / 项目管理 / 测试管理 / 后台设置」四块，CLI 顶层就应该是同样的
四块，而不是把同一模块内的资源平铺成多个互不相干的顶层命令组。

这是**纯命令面重组**：不新增端点、不改 API 行为、不改 `src/core/` 与 `src/api/`。

## Background

当前顶层命令组（`src/cli/program.ts:53-59`）：

```
auth        project     work-item   product     idea        ticket      meta
```

其中 `product` / `idea` / `ticket` 全部属于 ship（产品管理），
`project` / `work-item` 全部属于 pjm（项目管理）。同一个 GUI 模块被拆成了
2–3 个平级顶层组，随着 testhub 加入会进一步恶化。

前置讨论结论（用户确认）：
- 「我希望这一个 CLI 的设计保持整体的一致性，我在 PingCode 本身的 GUI 操作界面上，
  我只会看到三个模块产品管理/项目管理/测试管理，再有一个就是后台设置，所以我希望
  CLI 也继承类似这样的模块聚合统一入口」
- 「我们目前没有具体的用户，所以你可以直接改动它，但是对应的测试和文档需要修改」
  → 不需要 deprecation 周期，不需要保留旧路径别名，直接 breaking change。

## Scope

### In scope

目标顶层结构（`testhub` 由姊妹任务落地，此处仅示意最终形态）：

```
auth      login|status|logout                        CLI 本地凭据（不属于任何 GUI 模块）
product   list|get · idea · ticket · meta            产品管理
project   list|get · work-item · meta                项目管理
testhub   libraries|cases|plans|runs · meta          测试管理
settings  users                                      后台设置
```

逐条迁移表：

| 现有路径 | 目标路径 |
|---|---|
| `product list\|get` | `product list\|get`（不变，模块主名词保留在组上） |
| `idea list\|get\|create\|update` | `product idea …` |
| `ticket list\|get\|create\|update\|transition` | `product ticket …` |
| `project list\|get` | `project list\|get`（不变） |
| `work-item list\|get\|create\|update\|transition` | `project work-item …` |
| `auth login\|status\|logout` | `auth …`（不变） |
| `meta types\|states\|priorities\|sprints` | `project meta types\|states\|priorities\|sprints` |
| `meta idea-states\|idea-priorities\|idea-suites\|idea-properties` | `product meta idea-states\|idea-priorities\|idea-suites\|idea-properties` |
| `meta ticket-states\|ticket-priorities\|ticket-types\|ticket-channels\|ticket-properties` | `product meta ticket-…`（同名后缀） |
| `meta product-members` | `product meta members`（`product-` 前缀在模块内冗余，去掉） |
| `meta users` | `settings users` |

`meta` 作为顶层组**消失**。它原本是 15 个查表叶子的杂物袋（10 个 ship-scoped、
4 个 pjm-scoped、1 个 directory 全局），`idea-` / `ticket-` / `product-` 前缀只是
扁平命名空间下的防撞名补丁。聚合后每个模块各自拥有一个 `meta` 子组，与
`08-02-testhub-module` 已定的 `testhub meta case-states|…` 结构同形。

`settings` 对应 GUI 的「后台设置」。`meta users` 走 `/v1/directory/users`、
scope `pcp:read:global:team`，语义上确实是组织目录数据而非业务模块数据。
`auth` 是 CLI 自身的凭据管理，不是 PingCode 模块，保持顶层裸露、不并入 `settings`。

同批必须更新：
- `src/cli/program.ts` 注册顺序与注册函数签名
- `test/help.test.ts`（硬编码的命令组数量断言 + 叶子路径全清单）
- `test/__snapshots__/help.test.ts.snap`（每组 `--help` 快照）
- `test/shipCommands.test.ts` 等所有以 argv 调用命令的测试
- `skills/pingcode/SKILL.md`（help 测试会交叉校验其中每条命令路径）
- `README.md`

### Out of scope

- 新增/删除任何端点或叶子命令
- 修改 `src/core/**`、`src/api/**`、`src/types/**`
- 修改任何 flag 名称、输出格式、退出码
- testhub 模块本身（由 `08-02-testhub-module` 负责，它一开始就按
  `testhub` 单一顶层组设计，本任务不需要动它）

## Requirements

**R1 纯重组**：命令的行为、flag、输出、退出码逐字不变，只有 argv 路径变。
任何 diff 里出现 `src/core/` 或 `src/api/` 的改动都说明走偏了，停下上报。

**R2 文件组织**：`idea.ts` / `ticket.ts` / `workItem.ts` / `project.ts` / `product.ts`
保持现状，各自仍导出 `registerXCommands`，只是签名从接收 `program` 改为接收父
`Command`。不要为了聚合把它们合并成一个巨型文件。

`src/cli/commands/meta.ts` 是**唯一必须拆分**的文件——它现在同时装着三个模块的
查表。拆法：

- pjm 的 4 个叶子（`types` / `states` / `priorities` / `sprints`）→ 移入
  `project.ts`，注册为 `project meta` 子组
- ship 的 10 个叶子（`idea-*` 4 个 / `ticket-*` 5 个 / `members`）→ 移入
  `product.ts`，注册为 `product meta` 子组，含现有的 `productScoped()` 工厂
- `users` → 新建 `src/cli/commands/settings.ts`，导出
  `registerSettingsCommands(program)`
- `meta.ts` 删除；其中的 `Column` 定义（`TYPE_COLUMNS` / `STATE_COLUMNS` /
  `SPRINT_COLUMNS` / `USER_COLUMNS` / `SHIP_*_COLUMNS` 等）跟随各自的叶子迁移，
  若被多处引用则提到 `common.ts`

**R3 全局选项**：每个叶子仍必须被 `addGlobalOptions(cmd, { hidden: true })` 包住
（`src/cli/globals.ts:35-54`）。嵌套一层后容易漏，需要逐个复核。

**R4 分层不变**：`test/layering.test.ts` 的 `cli → {api, core}` 约束继续成立。

**R5 文档与测试同批**：`help.test.ts` 与 `SKILL.md` 存在交叉校验，
两者加上 snapshot、README 必须在同一个 commit 里更新，否则 CI 必红。
其中 `help.test.ts` 的硬编码组数从当前的 **7** 改为 **4**
（`auth` / `product` / `project` / `settings`）；`08-02-testhub-module` 之后会
把它带到 5，那不是本任务的事。

**R6 零新依赖**：运行时依赖仍冻结在 `commander` + `picocolors`。

## Acceptance Criteria

- [ ] AC1 `pingcode --help` 顶层只列出 `auth` / `product` / `project` / `settings`
      （testhub 任务落地后再加 `testhub`），不再有 `idea` / `ticket` / `work-item` /
      `meta` 作为顶层组
- [ ] AC2 `pingcode product idea list` / `product ticket transition` /
      `project work-item create` 等新路径全部可用
- [ ] AC3 旧路径 `pingcode idea list`、`pingcode meta users` 直接报未知命令
      （不做别名兼容）
- [ ] AC4 `npm run typecheck` 与 `npm test` 全绿，snapshot 已重新生成并 review 过
- [ ] AC5 `help.test.ts` 的命令组计数与叶子路径清单已按新树更新
- [ ] AC6 `skills/pingcode/SKILL.md` 中每条命令路径都能被 help 测试的交叉校验通过
- [ ] AC7 `README.md` 中所有示例命令已更新为新路径
- [ ] AC8 `git diff --stat` 中不含 `src/core/`、`src/api/`、`src/types/`
- [ ] AC9 CI 的 `--help` smoke 步骤通过
- [ ] AC10 原 `meta` 的 15 个叶子全部有新家，无遗漏、无重复：
      `project meta` 4 个、`product meta` 10 个、`settings users` 1 个
- [ ] AC11 `src/cli/commands/meta.ts` 已删除，新增 `src/cli/commands/settings.ts`，
      且 `idea.ts` / `ticket.ts` / `workItem.ts` / `project.ts` / `product.ts` 未被合并

## Resolved Decisions

- **D1 `meta` 归属（已拍板）**：选方案 (c)——查表跟随模块 + 新建 `settings` 顶层组。
  详见 Scope 的迁移表。被否掉的两个方案：
  (a) 保持顶层 `meta` 不动——改动最小，但 15 叶子杂物袋延续，且与
  `08-02-testhub-module` 已定的 `testhub meta …` 嵌套设计结构性矛盾；
  (b) 查表跟随模块但 `users` 留在顶层 `meta`——顶层会剩一个单叶子组，别扭。
  选 (c) 的核心理由：这是唯一让四个业务模块**结构同形**（资源子组 + `meta` 查表
  子组）的方案，testhub 无需为迁就旧结构而破例；且 `users` 语义上确实属于组织
  后台而非任何业务模块。发现性的损失是名义上的——调用查表永远是为了给某个模块的
  写命令拿 ID，而 `--product` / `--project` 必填已强制调用者知道模块。

- **D2 `auth` 不并入 `settings`**：它是 CLI 自身的本地凭据管理，不对应任何
  PingCode GUI 模块，保持顶层裸露。

## Open Questions

- **Q2 ship 侧 meta 覆盖是否完整**：`product meta` 迁移后共 10 个叶子
  （idea-states / idea-priorities / idea-suites / idea-properties / members /
  ticket-states / ticket-priorities / ticket-types / ticket-channels /
  ticket-properties）。design 阶段确认是否存在 `common.ts` 里
  `resolveShipStateFlags` 用得到、但没有对应 `meta` 叶子的查表缺口。
  本任务原则上**不新增叶子**，只记录缺口。

- **Q3 执行顺序**：本任务与 `08-02-testhub-module` 都会重写 `help.test.ts`、
  snapshot、`SKILL.md`、`README.md`。两者必须串行。建议**本任务先做**，
  这样 testhub 的文档一次性写在最终结构上，避免写两遍。

## Notes

- 相关任务：`.trellis/tasks/08-02-testhub-module`（新增 `testhub` 顶层组，
  已按本任务的目标结构设计，无需二次调整）。
- 参考先例：`.trellis/tasks/archive/2026-08/08-01-ship-cli/`（新增整个 API 域时
  如何同批更新 help 测试 + snapshot + SKILL.md + README.md）。
