# Implement: Server-side filtering for CLI commands

## Execution Plan

本任务拆为 4 个独立 child task，P1–P4 无互相依赖，可并行实现。

```
P1: work-item list  ─────────┐
P2: idea list       ─────────┤── 全部完成后，integration review
P3: ticket list     ─────────┤
P4: testhub cases   ─────────┘
```

每个 child 的验收标准独立，可单独 `task.py start` → 实现 → `task.py archive`。

---

## P1: work-item list filtering

**范围**：R1（REST GET list 新增 flags）+ R2（POST /search 新增 filter）

**核心文件**：
- `src/cli/commands/workItem.ts` — ListFlags、runList、runSearch、searchOnlyFlagsOf
- `src/api/workItems.ts` — WorkItemListQuery（已有，可能需要微调）
- `src/core/metadata/` — 确认所有需要的 resolver 存在

### 步骤

1. **扩展 ListFlags**（workItem.ts:95-110）：
   - 新增 REST+search 共有 flags：`priority`、`board`、`entry`、`swimlane`、`phase`、`release`、`tag`、`createdBy`、`participant`
   - 新增 search-only flags：`descriptionContains`、`startAfter/Before`、`endAfter/Before`、`completedAfter/Before`、`storyPoints`
   - 新增 REST-only flags：`identifier`、`bugType`

2. **注册 CLI options**（workItem.ts:189-202）：
   - 在 `.command('list')` 链上添加 `.option()` 调用
   - search-only flags 标记 `${SEARCH_FLAG_MARK}`

3. **扩展 runList**（workItem.ts:753-804）：
   - 新增 name→id 解析：priority、board、entry、swimlane、phase、release、tag、createdBy、participant、bugType
   - `WorkItemListQuery` 构建加入新字段
   - 扩展 `searchOnlyFlagsOf()` 包含新 search-only flags

4. **扩展 runSearch**（workItem.ts:838-910）：
   - filter 构造新增：`priority.id`、`board.id`、`entry.id`、`swimlane.id`、`phase.id`、`participants.id`（复数）、`versions.id`（复数）、`tags.id`（复数）、`created_by.id`
   - 新增 text filter：`description: {contains}`
   - 新增 date filters：`start_at`、`end_at`、`completed_at`（复用 `rangeFilter`）

5. **测试**：
   - 单测：flag 解析、filter 构造、searchOnlyFlagsOf 判定
   - live smoke：`pingcode project work-item list --project X --priority high --board Y`

6. **验证命令**：
   ```bash
   npm test -- --grep "work-item"
   pingcode project work-item list --project <name> --priority <name> --dry-run
   ```

---

## P2: idea list filtering

**范围**：R3（POST /search 新增 filter）

**核心文件**：
- `src/cli/commands/idea.ts` — ListFlags、runList
- `src/core/metadata/index.ts` — 确认 `resolveProductMember` 存在

### 步骤

1. **扩展 ListFlags**（idea.ts）：
   - 新增：`participant`、`titleContains`、`descriptionContains`
   - 新增日期：`createdAfter/Before`、`updatedAfter/Before`、`completedAfter/Before`
   - 新增数值：`score`、`progress`

2. **注册 CLI options**（idea.ts:136-148）：
   - 添加对应 `.option()` 调用

3. **扩展 runList**（idea.ts:344-388）：
   - 新增 `resolveProductMember` 解析 participant
   - 新增日期 flag 解析（`parseDateBoundaryFlag`）
   - 新增数值 flag 解析（`parseNumberFlag`）
   - filter 构造：绕过 `refFilter`，直接构建包含 `contains`/`gte`/`lte`/`between`/`eq` 等算子的 filter 对象
   - 用 `mergeFilters()` 合并所有 entries

4. **测试**：
   - 单测：filter 构造逻辑
   - live smoke：`pingcode ship idea list --product X --participant Y --created-after 2026-01-01 --dry-run`

5. **验证命令**：
   ```bash
   npm test -- --grep "idea"
   pingcode ship idea list --product <name> --score 5 --dry-run
   ```

---

## P3: ticket list filtering

**范围**：R4（POST /search 新增 filter + 3 个新 resolver）

**核心文件**：
- `src/cli/commands/ticket.ts` — ListFlags、runList
- `src/core/endpoints.ts` — 新增 3 个 endpoint 常量
- `src/core/metadata/registry.ts` — 新增 3 个 MetaKind spec
- `src/core/metadata/index.ts` — 新增 3 个 resolver 函数
- `src/api/ship.ts` — 新增 3 个 list 函数
- `src/cli/commands/ship/meta.ts` — 新增取值命令

### 步骤

1. **新增 ticket resolver 基础设施**：
   - `endpoints.ts`：`SHIP_TICKET_CUSTOMERS`、`SHIP_TICKET_SOLUTIONS`、`SHIP_TICKET_TAGS`
   - `registry.ts`：`ship-ticket-customer`、`ship-ticket-solution`、`ship-ticket-tag`
   - `metadata/index.ts`：`resolveTicketCustomer`、`resolveTicketSolution`、`resolveTicketTag`
   - `ship.ts`：`listTicketCustomers()`、`listTicketSolutions()`、`listTicketTags()`
   - `meta.ts`：`ticket customer list`、`ticket solution list`、`ticket tag list` 命令

2. **扩展 ticket ListFlags**：
   - 新增：`submittedBy`、`customer`、`solution`、`tag`、`participant`
   - 新增：`titleContains`、`descriptionContains`
   - 新增日期：`submittedAfter/Before`、`createdAfter/Before`、`updatedAfter/Before`、`completedAfter/Before`

3. **注册 CLI options + 扩展 runList**（ticket.ts）：
   - 添加 `.option()` 调用
   - 新增 resolver 解析
   - filter 构造（绕过 `refFilter`，与 P2 类似模式）

4. **测试**：
   - 单测：resolver + filter 构造
   - live smoke：`pingcode ship ticket list --product X --customer Y --tag Z --dry-run`

5. **验证命令**：
   ```bash
   npm test -- --grep "ticket"
   pingcode ship ticket list --product <name> --customer <name> --dry-run
   pingcode ship ticket meta customer list --product <name>
   ```

---

## P4: testhub cases list filtering

**范围**：R5（`include_public_image_token`）

**核心文件**：
- `src/cli/commands/testhub/cases.ts` — CaseListFlags、runCaseList

### 步骤

1. **扩展 CaseListFlags**（cases.ts:133-142）：
   - 新增 `includeImageToken?: string`

2. **注册 CLI option**（cases.ts:188-205）：
   - `.option('--include-image-token <fields>', 'CSV of field names, max 32')`

3. **扩展 runCaseList**（cases.ts:351-401）：
   - 传入 `SearchPayload.include_public_image_token`

4. **测试**：
   - 单测：flag 传递
   - live smoke：`pingcode testhub case list --library X --include-image-token description --dry-run`

5. **验证命令**：
   ```bash
   npm test -- --grep "case"
   pingcode testhub case list --library <name> --include-image-token description --dry-run
   ```

---

## Integration Review（P1–P4 全部完成后）

1. 全量测试：`npm test`
2. TypeScript 类型检查：`npx tsc --noEmit`
3. Lint：`npm run lint`（如有）
4. 跨命令一致性检查：
   - 相同语义的 flag 命名是否一致（如 `--priority` 在所有命令中行为一致）
   - `--help` 输出格式是否统一
   - search-only flag 标记是否一致

## Rollback Points

- 每个 child 独立，单个 child 出问题不影响其他
- 所有新 flags 都是 optional，回退只需删除 `.option()` 和对应解析逻辑
- 新 resolver 是纯新增，不影响现有 resolver

## Validation Commands（全局）

```bash
# 类型检查
npx tsc --noEmit

# 全量测试
npm test

# 各命令 dry-run 验证
pingcode project work-item list --project <name> --priority <name> --board <name> --dry-run
pingcode ship idea list --product <name> --score 5 --created-after 2026-01-01 --dry-run
pingcode ship ticket list --product <name> --customer <name> --tag <name> --dry-run
pingcode testhub case list --library <name> --include-image-token description --dry-run
```
