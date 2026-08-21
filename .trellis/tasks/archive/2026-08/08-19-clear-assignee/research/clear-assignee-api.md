# 研究:PingCode Open API 能否清空工作项负责人(assignee)

来源:librarian(lib-1)交叉核验,2026-08-19。置信度 **HIGH**。

## 结论

**PingCode Open REST API 不支持清空/取消分配工作项负责人。** 这是 API 的结构性限制,不是 CLI bug。

## 证据

| 行为 | 结果 | 含义 |
|---|---|---|
| `{"assignee_id": null}` | HTTP 200,但负责人**未清空** | `null` 被服务端当作"字段缺失",空操作(no-op) |
| `{"assignee_id": ""}` | HTTP 400 | `'assignee_id'不是有效的字符串(值不能为空)` |
| `{"assignee_id": "null"}` | HTTP 400 | `不是有效的成员id` |
| CLI `--assignee ""` | 本地 `UsageError: user must not be empty` | 本地校验(resolve.ts:347)在到 API 前就拦下 |

## 根因(结构性)

Go SDK `UpdateWorkItemRequest`(brain-xai/pingcode_api):
```go
type UpdateWorkItemRequest struct {
    AssigneeID *string `json:"assignee_id,omitempty"`  // nil → 被省略,绝不序列化为 null
}
```
`omitempty` + 服务端把 `null` 当缺失 → 客户端**无法表达"清空这个字段"的意图**,只能"设成 X"或"不动"。Web UI 能清空是因为走内部 GraphQL/RPC(区分 set-null 与 omit),公开 REST 不暴露。

## 穷举搜索(均无清空方案)

- 官方 apifox 文档(pingcode.apifox.cn/api-115134401):`assignee_id: type: string`,无 nullable、无哨兵值、无清空说明
- 工作项目录下无独立 assignee 子资源端点(仅 relations/participants 等)
- 错误码文档(doc-7021019):无"字段不可清空"类错误码
- GitHub 全语言搜 `assignee_id` / `清空负责人`:0 相关实现
- 5+ PingCode MCP server:`update_work_item`/`bulk_update` 都只能 SET,无 clear
- 中文社区 + changelog:无方案

## 对 CLI 的含义

无法让 PATCH 真正清空负责人。可做的交付物是**把失败模式变诚实、可操作**:
1. 识别"清空意图"(空 assignee),不要抛隐晦的 `user must not be empty`,而是给出清晰报错:说明 Open API 不支持清空负责人,需到 Web UI 操作。
2. 文档化该限制。
3. (可选)即便 API 未来修复,也不要静默返回 200 谎称成功——必须校验回包确认真的清空了,否则报错。

## 关键来源

- PATCH schema: https://pingcode.apifox.cn/api-115134401
- 错误码: https://pingcode.apifox.cn/doc-7021019
- Go SDK DTO: https://github.com/brain-xai/pingcode_api/blob/main/internal/api/workitem/dto.go
- Go SDK input: https://github.com/brain-xai/pingcode_api/blob/main/sdk/model/workitem/input.go

## 本地代码定位

- CLI 更新入口:`src/cli/commands/workItem.ts` `runUpdate`(assignee 解析 L1094-1095,patch 构 L1118)
- 本地空串校验:`src/core/metadata/resolve.ts:347`(`if (input === '') throw ... must not be empty`)
- API 层:`src/api/workItems.ts:184` `updateWorkItem`,body 经 `compact()`(`src/api/parse/common.ts:160`)
- 类型:`UpdateWorkItemInput.assignee_id?: string | undefined`(src/api/workItems.ts:109)
