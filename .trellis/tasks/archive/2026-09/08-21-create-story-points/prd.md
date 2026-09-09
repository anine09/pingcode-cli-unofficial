# work-item create 增加 --story-points

## Goal

`work-item create` 支持 `--story-points <n>` 参数，与 `update` 保持一致，避免创建后还需额外调用 update。

## Requirements

1. `work-item create` 命令增加 `--story-points <n>` 选项
2. `CreateFlags` 类型增加 `storyPoints` 字段
3. `runCreate` 函数将 `story_points` 包含在 `CreateWorkItemInput` 中
4. 帮助文本中说明该参数

## Current Behavior

- `runCreate` in `src/cli/commands/workItem.ts:1101` 构建 `CreateWorkItemInput` 时不包含 `story_points`
- `CreateFlags` 类型不包含 `storyPoints`
- `runUpdate` (line 1162) 已正确处理 `storyPoints` via `parseNumberFlag(flags.storyPoints, '--story-points')`
- API 类型 `CreateWorkItemInput` 需要确认是否支持 `story_points` 字段

## Acceptance Criteria

- [ ] `work-item create --project X --type story --title "t" --story-points 5` 创建后 `work-item get` 显示 story_points 为 5
- [ ] 不带 `--story-points` 时行为不变
- [ ] 帮助文本中包含 `--story-points` 说明
- [ ] 现有测试不受影响

## Technical Notes

- 参考 `runUpdate` 中 `storyPoints` 的处理方式（line 1162, 1171）
- 需要在 create 命令的 option 链中增加 `.option('--story-points <n>', 'story points')`
- 在 `runCreate` 的 `input` 构建中增加 `...(storyPoints === undefined ? {} : { story_points: storyPoints })`
- 需要确认 API 的 `CreateWorkItemInput` 类型是否已有 `story_points` 字段，如果没有需要添加

## Related Files

- `src/cli/commands/workItem.ts` — `runCreate` (line 1101), `CreateFlags`, create command option chain
- `src/api/workItems.ts` — `CreateWorkItemInput` type
