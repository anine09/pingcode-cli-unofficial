# Board 看板 CLI 命令

## Goal

补全 PingCode 看板（Board）体系的 CLI 命令，包括查看看板列表、栏位、泳道，以及将工作项分配到看板栏位和泳道。

## Requirements

### 新增 project board 子命令

1. `project board list --project <p>` — 查看看板列表
   - API: `GET /v1/pjm/projects/{project_id}/boards`
2. `project board entries list --project <p> --board <name|id>` — 查看看板栏位
   - API: `GET /v1/pjm/projects/{project_id}/boards/{board_id}/entries`
3. `project board swimlanes list --project <p> --board <name|id>` — 查看泳道
   - API: `GET /v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes`

### work-item update/create 增加 board 参数

4. `work-item update --board <name|id>` — 将工作项分配到看板
5. `work-item update --entry <name|id>` — 将工作项分配到栏位
6. `work-item update --swimlane <name|id>` — 将工作项分配到泳道
7. `work-item create` 同样支持上述三个参数

## Current Behavior

- 完全没有 board 相关命令
- `work-item list` 已有 `--board`、`--entry`、`--swimlane` 作为搜索过滤参数（workItem.ts line 226-228）
- `work-item update` 和 `create` 没有这些参数
- 用户只能通过 `pingcode api` 手动调用

## Acceptance Criteria

- [ ] `project board list --project X` 正确显示看板列表
- [ ] `project board entries list --project X --board B` 正确显示栏位列表
- [ ] `project board swimlanes list --project X --board B` 正确显示泳道列表
- [ ] `work-item update X --board B --entry E --swimlane S` 成功修改
- [ ] `work-item create --project X --type task --title "t" --board B` 创建时指定看板
- [ ] board/entry/swimlane 名称解析遵循现有 resolve 模式
- [ ] 帮助文本清晰说明参数用途
- [ ] 现有测试不受影响

## Technical Notes

- 参考 `project sprint` 命令结构（`src/cli/commands/projectSprint.ts`）实现 board 命令
- 参考 `project version` 命令结构（`src/cli/commands/projectVersion.ts`）
- 需要在 `src/cli/commands/project.ts` 的 `registerProjectCommands` 中注册 `board` 子命令
- 需要新增 API 函数：
  - `listBoards(ctx, projectId)` → `GET /v1/pjm/projects/{project_id}/boards`
  - `listBoardEntries(ctx, projectId, boardId)` → `GET /v1/pjm/projects/{project_id}/boards/{board_id}/entries`
  - `listBoardSwimlanes(ctx, projectId, boardId)` → `GET /v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes`
- 需要新增类型：`Board`, `BoardEntry`, `Swimlane`
- 需要新增 resolve 函数：`resolveBoard`, `resolveBoardEntry`, `resolveSwimlane`
- `work-item update/create` 中的 `--board/--entry/--swimlane` 需要解析名称→id，project 来自 work item 本身（update）或 `--project` 参数（create）

## API Endpoints

- `GET /v1/pjm/projects/{project_id}/boards`
- `GET /v1/pjm/projects/{project_id}/boards/{board_id}/entries`
- `GET /v1/pjm/projects/{project_id}/boards/{board_id}/swimlanes`

## Related Files

- `src/cli/commands/project.ts` — register project commands
- `src/cli/commands/projectSprint.ts` — reference implementation
- `src/cli/commands/workItem.ts` — add board/entry/swimlane to update and create
- `src/api/workItems.ts` — UpdateWorkItemInput, CreateWorkItemInput
- `src/api/meta.ts` — add board/entry/swimlane API functions
- `src/types/api.ts` — add Board, BoardEntry, Swimlane types
- `src/core/metadata/resolve.ts` — add board/entry/swimlane resolvers
- `src/core/endpoints.ts` — add board endpoint definitions
