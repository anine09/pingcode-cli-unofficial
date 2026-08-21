# P1: work-item list server-side filtering

## Goal

给 `work-item list` 命令补全所有 API 支持但 CLI 未暴露的筛选 flags（REST GET list + POST /search 两条路径）。

## Background

- 参考父任务 `08-20-server-side-filtering/prd.md`、`design.md`、`implement.md`
- `WorkItemListQuery`（workItems.ts:43）已声明 19 个参数，CLI 只暴露了 project/type/assignee/sprint/parent/keywords/state
- `runSearch`（workItem.ts:838）已实现 filter 构造，但只覆盖了 project/type/state/assignee/sprint/parent/unassigned/title/created_at/updated_at

## Scope（R1 + R2）

### R1: REST GET list 新增 flags
- `--priority` → priority_id（resolveWorkItemPriority）
- `--identifier` → identifier（纯文本，无需解析）
- `--board` → board_id（resolveBoard）
- `--entry` → entry_id（resolveEntry）
- `--swimlane` → swimlane_id（resolveSwimlane）
- `--phase` → phase_id（resolvePhase）
- `--release` → version_id（resolveProjectVersion）
- `--tag` → tag_id（resolveWorkItemTag）
- `--bug-type` → bug_type_id（resolveBugType）
- `--created-by` → created_by（resolveUser）
- `--participant` → participant_id（resolveUser）

### R2: POST /search 新增 filter
- `priority.id` / `board.id` / `entry.id` / `swimlane.id` / `phase.id` / `participants.id` / `versions.id` / `tags.id` / `created_by.id`
- `description: {contains}` → `--description-contains`
- `start_at` / `end_at` / `completed_at` → `--start-after/before` / `--end-after/before` / `--completed-after/before`
- `story_points: {eq}` → `--story-points`

## Acceptance Criteria

- [ ] 所有 R1 flags 注册为 `.option()`，name→id 解析正确
- [ ] 所有 R2 filters 正确构造（注意复数 forms：participants/tags/versions）
- [ ] search-only flags 正确触发 POST /search 切换
- [ ] `--help` 文本标注 search-only flags
- [ ] `--dry-run` 正确
- [ ] 现有测试通过 + 新增测试
- [ ] live smoke test 验证

## Key Files

- `src/cli/commands/workItem.ts` — ListFlags、runList、runSearch、searchOnlyFlagsOf
- `src/api/workItems.ts` — WorkItemListQuery
- `src/core/metadata/` — 所有 resolver 已存在，无需新增
