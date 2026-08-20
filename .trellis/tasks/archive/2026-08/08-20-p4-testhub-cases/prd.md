# P4: testhub cases image token flag

## Goal

给 `testhub cases list` 命令补全 `include_public_image_token` 参数。

## Background

- 参考父任务 `08-20-server-side-filtering/prd.md`、`design.md`、`implement.md`
- `getCase`（testhub.ts:278）已暴露此参数，但 `cases list` 没有
- catalog L412 声明 `POST /cases/search` body 支持 `include_public_image_token`

## Scope（R5）

| 参数 | CLI flag | 说明 |
|---|---|---|
| `include_public_image_token` | `--include-image-token <fields>` | CSV，max 32 |

## Acceptance Criteria

- [ ] `--include-image-token` flag 注册
- [ ] 值正确传递到 SearchPayload.include_public_image_token
- [ ] `--dry-run` 正确
- [ ] 现有测试通过
- [ ] live smoke test 验证

## Key Files

- `src/cli/commands/testhub/cases.ts` — CaseListFlags、runCaseList
