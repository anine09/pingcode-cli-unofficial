# Work-item CLI 命令修复

## Goal

修复 4 个 GitHub issues (#6-#9)，补全 work-item 相关 CLI 命令的功能缺陷和缺失。

## Task Map

| Child | Issue | Title | Scope |
|-------|-------|-------|-------|
| `08-21-list-state-independent` | #9 | list --state 独立使用 | `src/cli/commands/common.ts`, `src/cli/commands/workItem.ts` |
| `08-21-create-story-points` | #8 | create 增加 --story-points | `src/cli/commands/workItem.ts` |
| `08-21-update-type-sent` | #7 | update --type 实际生效 | `src/cli/commands/workItem.ts`, `src/api/workItems.ts` |
| `08-21-board-commands` | #6 | Board 看板 CLI 命令 | `src/cli/commands/projectBoard.ts` (new), `src/cli/commands/project.ts`, `src/api/workItems.ts`, `src/api/meta.ts` |

## Requirements

1. `work-item list --state <name>` 无需 `--type` 即可使用，CLI 内部自动处理类型解析
2. `work-item create` 支持 `--story-points <n>` 参数
3. `work-item update --type <name>` 实际修改工作项类型（或明确说明 API 限制）
4. 新增 `project board` 子命令：list / entries list / swimlanes list
5. `work-item update` 和 `create` 支持 `--board` / `--entry` / `--swimlane` 参数

## Cross-Child Constraints

- 所有 child 共享 `src/cli/commands/workItem.ts`，需注意合并冲突
- Child #6 和 #9 可能都涉及 state 解析逻辑的修改，需协调
- Child #6 新增的 board/entry/swimlane 解析器应遵循现有 resolve 模式（`src/core/metadata/resolve.ts`）
- 所有 child 必须通过 `trellis-check` 验证
- 每个 child 完成后需确认 GitHub issue 可关闭

## Acceptance Criteria

- [ ] Issue #9: `work-item list --state "打开" --project X` 不报错，正确筛选
- [ ] Issue #8: `work-item create --project X --type story --title "t" --story-points 5` 创建后故事点为 5
- [ ] Issue #7: `work-item update X --type story` 实际修改类型，或帮助文档明确说明 API 限制
- [ ] Issue #6: `project board list` / `entries list` / `swimlanes list` 可用，`work-item update --board/--entry/--swimlane` 可用
- [ ] 所有 child 通过 `trellis-check`
- [ ] 无回归（现有命令行为不变）

## Execution Order

1. Child #8 (create --story-points) — 最简单，先做
2. Child #7 (update --type) — 需要确认 API 支持
3. Child #9 (list --state) — 中等复杂度
4. Child #6 (Board commands) — 最复杂，最后做

## Notes

- Parent task 不直接实现代码，只协调和集成验证
- 每个 child 完成后单独 commit
- 所有 child 完成后，parent 做最终集成验证
