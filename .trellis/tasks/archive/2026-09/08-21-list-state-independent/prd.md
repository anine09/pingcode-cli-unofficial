# work-item list --state 独立使用

## Goal

`work-item list --state <name>` 无需 `--type` 即可使用。CLI 内部自动处理类型解析：查询项目下所有类型，匹配状态名，无歧义直接使用，有歧义列出候选。

## Requirements

1. `work-item list --state <name>` 不带 `--type` 时，不报错
2. CLI 自动查询项目下所有工作项类型
3. 对每个类型查询状态列表，匹配 `--state` 指定的状态名
4. 如果状态名只在一种类型下存在，直接使用该 state_id
5. 如果状态名在多种类型下都存在，自动筛选所有匹配的 state_id（列表端点支持 state_id 过滤）
6. 如果状态名不存在于任何类型，给出明确的错误信息
7. `--state-id <id>` 行为不变（不需要 type）

## Current Behavior

`resolveStateFlags` in `src/cli/commands/common.ts:253` throws `--state <name> requires --type` when `typeId` is undefined.

The `list` command in `src/cli/commands/workItem.ts:207` calls `addStateOptions(group, 'filter by state', 'requires --type')` which adds the `--state`/`--state-id` options but doesn't add `--type`.

## Acceptance Criteria

- [ ] `work-item list --state "打开" --project X` 不报错，正确返回该状态的工作项
- [ ] `work-item list --state "打开" --project X --type story` 行为不变（向后兼容）
- [ ] `work-item list --state-id <id> --project X` 行为不变
- [ ] 状态名不存在时给出清晰的错误信息
- [ ] 状态名在多种类型下都存在时，正确筛选所有匹配（通过 search 端点或多次查询）
- [ ] 现有测试不受影响

## Technical Notes

- `listWorkItemStates` API 需要 `project_id` + `work_item_type_id`，无法一次查询所有类型的状态
- 需要先查 `listWorkItemTypes` 获取所有类型，再逐个查状态
- 可以考虑缓存类型→状态的映射
- list 命令使用 REST list 端点（`GET /v1/pjm/work_items`），search 端点（`POST /v1/pjm/work_items/search`）支持 `state_id` 过滤
- 如果状态名在多种类型下匹配，可能需要使用 search 端点并传入多个 state_id，或者对每个 state_id 分别查询后合并

## Related Files

- `src/cli/commands/common.ts` — `resolveStateFlags`, `addStateOptions`
- `src/cli/commands/workItem.ts` — `registerWorkItemCommands` (list command), `runList`
- `src/api/meta.ts` — `listWorkItemStates`, `listWorkItemTypes`
- `src/core/metadata/resolve.ts` — state resolution logic
