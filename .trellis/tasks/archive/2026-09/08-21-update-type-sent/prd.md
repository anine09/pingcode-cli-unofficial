# work-item update --type 实际生效

## Goal

`work-item update --type <name>` 实际修改工作项类型。如果 API 不支持，至少在帮助文档中明确说明。

## Requirements

1. 确认 PingCode Open API 是否支持通过 PATCH 修改工作项类型（`type_id` 字段）
2. 如果 API 支持：将 `--type` 解析后的 `type_id` 加入 PATCH body
3. 如果 API 不支持：更新 `TYPE_FLAG_HELP` 和 `update --help` 说明，告知用户 API 限制，建议通过 Web UI 或 delete+recreate 处理
4. 无论哪种方式，`work-item update X --type story` 不应报 `nothing to update`

## Current Behavior

- `runUpdate` in `src/cli/commands/workItem.ts:1157` 只在 `wantsState` 时解析 `--type`（line 1217-1221）
- 解析后的 `type` 仅用于 state 解析和 `explainStates`，从不加入 patch
- 代码注释（line 1194-1197）说明 "PATCH documents only `id`" — 需要验证 API 是否真的不支持 `type_id`
- `update` 命令已有 `.option('--type <name|id>', TYPE_FLAG_HELP)` (line 314)

## Acceptance Criteria

- [ ] 确认 API 是否支持 `type_id` in PATCH body（通过 research 或 live test）
- [ ] 如果支持：`work-item update X --type story` 成功修改类型
- [ ] 如果不支持：`update --help` 明确说明，且 `work-item update X --type story` 给出有用的错误信息（而非 `nothing to update`）
- [ ] `--type` 配合 `--state` 的现有行为不受影响
- [ ] 现有测试不受影响

## Technical Notes

- 需要先用 `pingcode api PATCH /v1/pjm/work_items/{id}` 测试 `type_id` 字段
- 如果 API 支持，在 `patch` 构建（line 1268）中增加 `...(type === undefined ? {} : { type_id: type.id })`
- 如果 API 不支持，需要修改 `wantsReference` 逻辑和空 patch 检查，使 `--type` 被识别为有效字段（即使不发送）
- 或者增加独立的 `work-item change-type` 命令

## Related Files

- `src/cli/commands/workItem.ts` — `runUpdate` (line 1157), `UpdateFlags`, `TYPE_FLAG_HELP`
- `src/api/workItems.ts` — `UpdateWorkItemInput` type
