# Design: Server-side filtering for CLI commands

## Architecture Overview

```
CLI flags (commander)
  ↓ parse & resolve name→id
Filter entries (Record<string, unknown>[])
  ↓ mergeFilters() / inline filter object
SearchPayload { filter, keywords, include_* }
  ↓ buildSearchBody() / buildUrl()
POST /search  body  OR  GET query string
  ↓
PingCode API
```

**Two transport patterns exist in the codebase:**

| Pattern | Used by | Filter encoding |
|---|---|---|
| **A: GET + query string** | work-item simple list (`GET /work_items`) | `WorkItemListQuery` → `buildUrl()` 序列化 |
| **B: POST /search + body filter** | work-item search, idea, ticket, testhub cases/runs | `SearchPayload.filter` → `buildSearchBody()` 包装 |

Pattern A 只有 work-item 用。Pattern B 是 idea/ticket/testhub 的唯一路径。

## Shared Design Decisions

### D1: filter 构造模式

**Reference 字段**（`{field}.id: {in: [id]}`）：
- idea/ticket/testhub 复用现有 `refFilter()` + `mergeFilters()`（common.ts:341/350）
- work-item search 用内联 filter 对象（已有模式，`workItem.ts:873-887`）

**文本字段**（`{field}: {contains: text}`）：
- 新 helper：`textFilter(field, value)` → `{ [field]: { contains: value } }`
- 或内联（参考 `workItem.ts:882` 的 `filter.title = { contains: ... }`）

**时间字段**（`{field}: {gte/lte/between}`）：
- 复用现有 `rangeFilter()` 模式（`workItem.ts:913-921`）
- 或提取为 shared helper：`dateRangeFilter(field, from, to)`

**数值字段**（`{field}: {eq/ne/gt/lt/gte/lte}`）：
- 新 helper：`numberFilter(field, op, value)` → `{ [field]: { [op]: value } }`

### D2: name→id 解析时机

所有 reference filter 的 name→id 解析在 `runList` 入口处批量完成（与现有模式一致），然后传入 filter 构造。解析失败时抛出 `NotFoundError` 或 `UsageError`（与现有行为一致）。

### D3: search-only flag 标记

work-item 已有 `SEARCH_FLAG_MARK` 标记 search-only flags。idea/ticket 不需要这个标记（它们只有 POST /search 一条路）。

但 work-item 的新 flags 需要区分：
- **REST-only**（GET list 支持但 search 不支持）：`identifier`、`bug_type_id`
- **Search-only**（POST /search 支持但 GET list 不支持）：`description-contains`、`start-at`、`end-at`、`completed-at`、`story-points`
- **Both**（两条路都支持）：`priority`、`board`、`entry`、`swimlane`、`phase`、`release`、`tag`、`created-by`、`participant`

当用户传入 search-only flag 时，自动切换到 POST /search（现有 `searchOnlyFlagsOf()` 逻辑扩展）。

### D4: ticket 新增 resolver

ticket 需要 3 个新 resolver，每个遵循现有 `scoped()` / `root()` 工厂模式：

```
resolveTicketCustomer  → scoped('ship-ticket-customer')  → GET /v1/ship/products/{id}/customers
resolveTicketSolution  → scoped('ship-ticket-solution')  → GET /v1/ship/ticket/solutions?product_id=
resolveTicketTag       → scoped('ship-ticket-tag')       → GET /v1/ship/ticket/tags?product_id=
```

每个需要：
1. `endpoints.ts` 新增路径常量
2. `registry.ts` 新增 `MetaKind` spec
3. `metadata/index.ts` 新增 resolver 函数
4. `ship.ts` 新增 list 函数（如 `listTicketCustomers`）
5. `meta.ts` 新增取值命令（如 `ticket customer list`）

### D5: testhub cases — include_public_image_token

`CaseListFlags` 新增 `includeImageToken?: string`，`runCaseList` 传入 `SearchPayload.include_public_image_token`。模式与 `getCase` 一致（`testhub.ts:278`）。

## Per-Command Design

### work-item list (workItem.ts)

**ListFlags 扩展**（L95-110）：
```typescript
type ListFlags = PagingFlags & StateFlags & {
  project: string;
  // 已有
  type?: string; assignee?: string; sprint?: string;
  parent?: string; keywords?: string;
  // search-only（已有）
  titleContains?: string; createdAfter?: string; createdBefore?: string;
  updatedAfter?: string; updatedBefore?: string; unassigned?: boolean;
  // 新增 — REST + search 共有
  priority?: string; board?: string; entry?: string;
  swimlane?: string; phase?: string; release?: string;
  tag?: string; createdBy?: string; participant?: string;
  // 新增 — search-only
  descriptionContains?: string;
  startAfter?: string; startBefore?: string;
  endAfter?: string; endBefore?: string;
  completedAfter?: string; completedBefore?: string;
  storyPoints?: string;
  // 新增 — REST-only
  identifier?: string; bugType?: string;
};
```

**runList 扩展**（L753-804）：
- 新增 name→id 解析：priority、board、entry、swimlane、phase、release、tag、createdBy、participant、bugType
- `WorkItemListQuery` 构建时加入新字段
- `searchOnlyFlagsOf()` 扩展：`descriptionContains`、`startAfter/Before`、`endAfter/Before`、`completedAfter/Before`、`storyPoints`

**runSearch 扩展**（L838-910）：
- filter 构造新增：`priority.id`、`board.id`、`entry.id`、`swimlane.id`、`phase.id`、`participants.id`、`versions.id`、`tags.id`、`created_by.id`
- 新增 text filter：`description: {contains}`
- 新增 date filters：`start_at`、`end_at`、`completed_at`

### idea list (idea.ts)

**ListFlags 扩展**（现有定义在 idea.ts）：
```typescript
// 新增
participant?: string;
titleContains?: string;
descriptionContains?: string;
createdAfter?: string; createdBefore?: string;
updatedAfter?: string; updatedBefore?: string;
completedAfter?: string; completedBefore?: string;
score?: string;
progress?: string;
```

**runList 扩展**（idea.ts:344-388）：
- 新增 `resolveProductMember` 解析 participant
- 新增 `parseDateBoundaryFlag` 解析 6 个日期 flag
- 新增 `parseNumberFlag` 解析 score/progress
- filter 构造绕过 `refFilter`，直接构建对象（需要 contains/date/number 算子）

### ticket list (ticket.ts)

**ListFlags 扩展**：
```typescript
// 新增
submittedBy?: string;
customer?: string;
solution?: string;
tag?: string;
participant?: string;
titleContains?: string;
descriptionContains?: string;
submittedAfter?: string; submittedBefore?: string;
createdAfter?: string; createdBefore?: string;
updatedAfter?: string; updatedBefore?: string;
completedAfter?: string; completedBefore?: string;
```

**runList 扩展**（ticket.ts:236-283）：
- 新增 resolver 解析：submittedBy、customer、solution、tag、participant
- 日期 flag 解析
- filter 构造绕过 `refFilter`

**新增 resolver 实现**：
- `resolveTicketCustomer` / `resolveTicketSolution` / `resolveTicketTag`
- 对应 endpoint 常量、registry spec、list API 函数、meta 命令

### testhub cases list (cases.ts)

**CaseListFlags 扩展**（cases.ts:133-142）：
```typescript
includeImageToken?: string;  // CSV, max 32
```

**runCaseList 扩展**（cases.ts:351-401）：
- 传入 `SearchPayload.include_public_image_token`

## Compatibility

- 所有新 flags 都是 optional，不改变现有命令行为
- `--dry-run` 自动适配（现有机制覆盖 POST /search 和 GET list）
- 分页行为不变（`--all` / `--page` / `--page-size` / `--limit`）
- `--json` 输出格式不变

## Risks

| 风险 | 缓解 |
|---|---|
| 新 filter 键被服务端拒绝（400 100043） | 实现前对每个新键做 live smoke test |
| ticket 新 resolver 的 endpoint 路径不确定 | 以 catalog.generated.ts 为准，smoke test 验证 |
| idea 的 score/progress 算子类型不确定 | smoke test 确认是 `eq` 还是其他 |
| 时间参数名（`created_at` vs `created_between`） | 以 endpoints.ts 注释和 live 验证为准 |
