# Add server-side filtering to CLI commands

## Goal

让 CLI 用户在列表查询时直接使用 PingCode API 支持的服务端筛选参数，避免"拉全量 → 本地过滤"的性能浪费，减少 API 调用次数和本地内存/CPU 开销。

核心价值：当用户只想查"某个项目的 open bugs 且优先级为 high"时，不需要先拉全部工作项再在客户端 `.filter()`。

## Background（已确认事实）

### 项目侧架构

1. **网络层**：`src/core/http.ts:42 request()` 是唯一出口，`src/core/wire.ts:37 buildUrl()` 自动序列化 query 对象为 query string（数组→CSV，drop null）。
2. **工作项 REST 列表 API 类型已就绪**：`src/api/workItems.ts:43 WorkItemListQuery` 已声明 19 个 API 支持的 query 参数。
3. **搜索端点已就绪**：`src/api/workItems.ts:229 searchWorkItems()` + `src/core/paginate.ts:193 SearchPayload` 支持 `filter` + `keywords`。
4. **其他资源也有类似模式**：ideas/tickets/testhub cases/runs 各有 POST `/search` 端点。
5. **filter 构造工具**：`refFilter()` (common.ts:341) + `mergeFilters()` (common.ts:350) 用于 ship 命令；workItem 用内联 filter 对象（因为需要多种算子）。
6. **name→id 解析器**：集中在 `src/core/metadata/index.ts`，表驱动 registry (`registry.ts`)。

### API 侧（官方）

1. **REST query string 过滤 ✅**：`GET /v1/pjm/work_items` 支持结构化过滤参数。
2. **POST /search 过滤 ✅**：`POST /v1/pjm/work_items/search` 等支持 filter（每字段单 operator，多字段 AND），filter 词汇表与 query string 不同。
3. **GraphQL ❌**：不支持。
4. **字段选择 ❌**：不支持 `?fields=`，始终返回全量。
5. **分页 ✅**：page_size (max 100) + page_index。

## Requirements

### R1: work-item list — 补全 REST GET list 缺失的 query 参数

`WorkItemListQuery` 已声明但 CLI 未暴露的参数：

| API 参数 | CLI flag | name→id resolver | resolver 存在？ |
|---|---|---|---|
| `priority_id` | `--priority <name\|id>` | `resolveWorkItemPriority` | ✅ |
| `identifier` | `--identifier <text>` | 无需（纯文本） | ✅ |
| `board_id` | `--board <name\|id>` | `resolveBoard`（work-item 专属） | ✅ |
| `entry_id` | `--entry <name\|id>` | `resolveEntry` | ✅ |
| `swimlane_id` | `--swimlane <name\|id>` | `resolveSwimlane` | ✅ |
| `phase_id` | `--phase <name\|id>` | `resolvePhase` | ✅ |
| `version_id` | `--release <name\|id>` | `resolveProjectVersion` | ✅ |
| `tag_id` | `--tag <name\|id>` | `resolveWorkItemTag` | ✅ |
| `bug_type_id` | `--bug-type <name\|id>` | `resolveBugType` | ✅ |
| `created_by` | `--created-by <name\|id>` | `resolveUser` | ✅ |
| `participant_id` | `--participant <name\|id>` | `resolveUser` | ✅ |

### R2: work-item list — 补全 POST /search 缺失的 filter

| search filter | CLI flag | 算子类型 |
|---|---|---|
| `priority.id` | `--priority <name\|id>` | `in` |
| `board.id` | `--board <name\|id>` | `in` |
| `entry.id` | `--entry <name\|id>` | `in` |
| `swimlane.id` | `--swimlane <name\|id>` | `in` |
| `phase.id` | `--phase <name\|id>` | `in` |
| `participants.id` | `--participant <name\|id>` | `in`（注意复数） |
| `versions.id` | `--release <name\|id>` | `in`（注意复数） |
| `tags.id` | `--tag <name\|id>` | `in`（注意复数） |
| `created_by.id` | `--created-by <name\|id>` | `in` |
| `description` | `--description-contains <text>` | `contains` |
| `start_at` | `--start-after <date>` / `--start-before <date>` | `gte`/`lte` |
| `end_at` | `--end-after <date>` / `--end-before <date>` | `gte`/`lte` |
| `completed_at` | `--completed-after <date>` / `--completed-before <date>` | `gte`/`lte` |

### R3: idea list — 补全 search filter

**入口**：`idea.ts:344 runList()` → `POST /ship/ideas/search`（无 runSearch 切换机制，直接加 filter）。

| search filter | CLI flag | 算子类型 | resolver |
|---|---|---|---|
| `participants.id` | `--participant <name\|id>` | `in` | `resolveProductMember` ✅ |
| `created_at` | `--created-after/before <date>` | `gte`/`lte`/`between` | 无需 |
| `updated_at` | `--updated-after/before <date>` | 同上 | 无需 |
| `completed_at` | `--completed-after/before <date>` | 同上 | 无需 |
| `title` | `--title-contains <text>` | `contains` | 无需 |
| `description` | `--description-contains <text>` | `contains` | 无需 |
| `score` | `--score <n>` | `eq`/`ne`/`gt`/`lt`/`gte`/`lte` | 无需 |
| `progress` | `--progress <n>` | 同上 | 无需 |

**排除**：`tags.id`（idea 无 tags 字段，GOTCHA #11）、`plan.id`/`plan_at`/`real_at`（未验证，跳过）。

### R4: ticket list — 补全 search filter

**入口**：`ticket.ts:236 runList()` → `POST /ship/tickets/search`（同 idea，无切换机制）。

| search filter | CLI flag | 算子类型 | resolver |
|---|---|---|---|
| `submitted_by.id` | `--submitted-by <name\|id>` | `in` | 复用 `resolveUser` / `resolveProductMember` ✅ |
| `customer.id` | `--customer <name\|id>` | `in` | ❌ **需新增** `resolveTicketCustomer` |
| `solution.id` | `--solution <name\|id>` | `in` | ❌ **需新增** `resolveTicketSolution` |
| `tags.id` | `--tag <name\|id>` | `in` | ❌ **需新增** `resolveTicketTag` |
| `participants.id` | `--participant <name\|id>` | `in` | `resolveProductMember` ✅ |
| `submitted_at` | `--submitted-after/before <date>` | `gte`/`lte`/`between` | 无需 |
| `created_at` | `--created-after/before <date>` | 同上 | 无需 |
| `updated_at` | `--updated-after/before <date>` | 同上 | 无需 |
| `completed_at` | `--completed-after/before <date>` | 同上 | 无需 |
| `title` | `--title-contains <text>` | `contains` | 无需 |
| `description` | `--description-contains <text>` | `contains` | 无需 |

**ticket 额外需要的新 resolver**：
- `resolveTicketCustomer` → `GET /v1/ship/products/{id}/customers`（catalog L315）
- `resolveTicketSolution` → `GET /v1/ship/ticket/solutions?product_id=`（catalog L344）
- `resolveTicketTag` → `GET /v1/ship/ticket/tags?product_id=` 或 `GET /v1/ship/products/{id}/tags`（catalog L332/L346）

每个新 resolver 需要：endpoint 常量（endpoints.ts）、resolver spec（registry.ts）、resolver 函数（metadata/index.ts）。

### R5: testhub cases list — 补全缺失参数

| 参数 | CLI flag | 说明 |
|---|---|---|
| `include_public_image_token` | `--include-image-token <fields>` | CSV，max 32，catalog L412 声明支持但 CLI 未暴露 |

### R6: testhub runs list

**无缺口**。CLI 已暴露所有 API 支持的筛选参数。

## Acceptance Criteria

- [ ] `work-item list` 支持 R1 所有 REST query 参数 + R2 所有 search filter 作为 CLI flags
- [ ] `idea list` 支持 R3 所有 search filter 作为 CLI flags
- [ ] `ticket list` 支持 R4 所有 search filter 作为 CLI flags（含新增 3 个 resolver）
- [ ] `testhub cases list` 支持 `include_public_image_token`
- [ ] 所有新 flags 经过 name→id 解析（复用现有 resolve 模式）
- [ ] `--help` 文本清晰标注 search-only flags（哪些会触发 POST /search）
- [ ] `--dry-run` 正确打印请求而不执行
- [ ] 现有测试通过；新增 flags 有对应测试覆盖
- [ ] live smoke test 验证新 flags 实际被服务端接受（不回退到本地过滤）

## Out of Scope

- GraphQL 支持（API 不支持）
- 字段选择 / partial response（API 不支持）
- 自定义 DSL / OData（API 不支持）
- 修改网络层或分页机制（现有架构已足够）
- idea 的 `plan.id`/`plan_at`/`real_at` 筛选（未验证，跳过）
- testhub 未知 filter 键的探测（无 catalog 依据，风险高）

## Key Decisions

1. **全覆盖 4 个命令区**（user 确认）
2. **work-item 的双路径保留**：REST GET list 和 POST /search 各管各的 filter 集，不合并
3. **idea/ticket 不引入 runSearch 切换**：它们只有 POST /search 一条路，新 filter 直接加到 runList
4. **ticket 的 customer/solution/tags resolver 本次一并补全**：虽然工作量大，但属于 R4 的必要前置

## Phased Implementation（4 个 child task，各自独立验证）

| Phase | Child | 范围 | 依赖 |
|---|---|---|---|
| P1 | work-item list | R1 + R2 | 无 |
| P2 | idea list | R3 | 无 |
| P3 | ticket list | R4（含新 resolver） | 无 |
| P4 | testhub cases | R5 | 无 |

P1–P4 无互相依赖，可并行实现。
