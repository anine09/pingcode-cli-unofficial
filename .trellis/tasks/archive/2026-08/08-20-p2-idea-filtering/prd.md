# P2: idea list server-side filtering

## Goal

给 `idea list` 命令补全 POST /search 支持的 filter flags。

## Background

- 参考父任务 `08-20-server-side-filtering/prd.md`、`design.md`、`implement.md`
- idea 只有 POST /ideas/search 一条路径，无 runSearch 切换机制
- 现有 filter 只覆盖：product/state/priority/assignee/suite（通过 refFilter + mergeFilters）
- refFilter 只支持 `{field}.id:{in:[id]}`，不能处理 contains/date/number 算子

## Scope（R3）

| search filter | CLI flag | 算子 | resolver |
|---|---|---|---|
| `participants.id` | `--participant` | `in` | resolveProductMember ✅ |
| `created_at` | `--created-after/before` | `gte`/`lte`/`between` | 无需 |
| `updated_at` | `--updated-after/before` | 同上 | 无需 |
| `completed_at` | `--completed-after/before` | 同上 | 无需 |
| `title` | `--title-contains` | `contains` | 无需 |
| `description` | `--description-contains` | `contains` | 无需 |
| `score` | `--score` | `eq`/`ne`/`gt`/`lt`/`gte`/`lte` | 无需 |
| `progress` | `--progress` | 同上 | 无需 |

**排除**：tags.id（GOTCHA #11，idea 无 tags）、plan.id/plan_at/real_at（未验证）

## Acceptance Criteria

- [ ] 所有 R3 flags 注册为 `.option()`
- [ ] participant 经过 resolveProductMember 解析
- [ ] 日期 flags 经过 parseDateBoundaryFlag 解析
- [ ] 数值 flags 经过 parseNumberFlag 解析
- [ ] filter 构造正确处理 contains/gte/lte/between/eq 算子
- [ ] `--dry-run` 正确
- [ ] 现有测试通过 + 新增测试
- [ ] live smoke test 验证

## Key Files

- `src/cli/commands/idea.ts` — ListFlags、runList
- `src/api/ship.ts` — searchIdeas
- `src/core/metadata/index.ts` — resolveProductMember 已存在
