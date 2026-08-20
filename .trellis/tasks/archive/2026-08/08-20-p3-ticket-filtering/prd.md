# P3: ticket list server-side filtering

## Goal

给 `ticket list` 命令补全 POST /search 支持的 filter flags，并新增 3 个缺失的 resolver。

## Background

- 参考父任务 `08-20-server-side-filtering/prd.md`、`design.md`、`implement.md`
- ticket 只有 POST /tickets/search 一条路径
- 现有 filter 只覆盖：product/type/state/priority/assignee/channel
- 缺失 3 个 resolver：customer、solution、tags

## Scope（R4）

### 新增 resolver（前置依赖）
| Resolver | Endpoint | 用途 |
|---|---|---|
| `resolveTicketCustomer` | `GET /v1/ship/products/{id}/customers` | `--customer` |
| `resolveTicketSolution` | `GET /v1/ship/ticket/solutions?product_id=` | `--solution` |
| `resolveTicketTag` | `GET /v1/ship/ticket/tags?product_id=` | `--tag` |

每个需要：endpoint 常量（endpoints.ts）+ registry spec（registry.ts）+ resolver 函数（metadata/index.ts）+ list API（ship.ts）+ meta 命令。

### 新增 filter flags

| search filter | CLI flag | 算子 | resolver |
|---|---|---|---|
| `submitted_by.id` | `--submitted-by` | `in` | resolveUser/resolveProductMember ✅ |
| `customer.id` | `--customer` | `in` | resolveTicketCustomer **NEW** |
| `solution.id` | `--solution` | `in` | resolveTicketSolution **NEW** |
| `tags.id` | `--tag` | `in` | resolveTicketTag **NEW** |
| `participants.id` | `--participant` | `in` | resolveProductMember ✅ |
| `submitted_at` | `--submitted-after/before` | `gte`/`lte`/`between` | 无需 |
| `created_at` | `--created-after/before` | 同上 | 无需 |
| `updated_at` | `--updated-after/before` | 同上 | 无需 |
| `completed_at` | `--completed-after/before` | 同上 | 无需 |
| `title` | `--title-contains` | `contains` | 无需 |
| `description` | `--description-contains` | `contains` | 无需 |

## Acceptance Criteria

- [ ] 3 个新 resolver 完整实现（endpoint + registry + resolver + list API + meta 命令）
- [ ] 所有 R4 flags 注册为 `.option()` 并能正确解析
- [ ] filter 构造正确处理多种算子
- [ ] meta 命令可取值（`pingcode ship ticket meta customer list` 等）
- [ ] `--dry-run` 正确
- [ ] 现有测试通过 + 新增测试
- [ ] live smoke test 验证

## Key Files

- `src/cli/commands/ticket.ts` — ListFlags、runList
- `src/core/endpoints.ts` — 新增 3 个常量
- `src/core/metadata/registry.ts` — 新增 3 个 spec
- `src/core/metadata/index.ts` — 新增 3 个 resolver
- `src/api/ship.ts` — 新增 3 个 list 函数
- `src/cli/commands/ship/meta.ts` — 新增取值命令
