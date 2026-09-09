# 非项目成员负责人无法看到卡片

## Goal

Block assignment of work-item assignees who are not project members. In PingCode's permission model, project membership determines work-item visibility — a non-member assignee cannot see the card they are assigned to. The CLI should prevent this footgun at the client side.

## Requirements

1. **Create** (`work item create --assignee`): After resolving the user by name, verify they are a project member before sending. Block with a clear error and hint if not.
2. **Update** (`work item update --assignee`): Same verification, using the project ID read from the work item itself.
3. **Bulk update** (`work item bulk-update --assignee` / `--assignee-id`): Require `--project` (the project must be known to verify membership). Block if the user is not a member.
4. **Project owner** (`project create --assignee`): NOT affected — the project owner (负责人) is intentionally allowed to be a non-member.
5. **Help text**: Update `--assignee` descriptions to state the membership requirement.
6. **Member command group**: Clarify that work-item assignees must be project members, distinguishing from project owner.

## Acceptance Criteria

- [ ] `work item create --assignee <non-member>` → exit 2, error: "not a member of this project — a non-member assignee cannot see the card"
- [ ] `work item update <item> --assignee <non-member>` → exit 2, same error
- [ ] `work item bulk-update --id <id> --assignee <non-member> --project <p>` → exit 2, same error
- [ ] `work item bulk-update --id <id> --assignee-id <non-member-id> --project <p>` → exit 2, same error
- [ ] `work item bulk-update --id <id> --assignee <name>` without `--project` → exit 2, error: "requires --project"
- [ ] All existing assignee tests pass (member IS a member → succeeds)
- [ ] All 2815 existing tests pass
- [ ] Help text reflects membership requirement

## Constraints

- Use `getProjectMember(ctx, projectId, userId)` — one GET call, 404 = not a member
- Only `NotFoundError` (404) triggers the block; other errors (auth, network) propagate
- For bulk update without `--project`, require `--project` (consistent with `--state` and `--priority`)

## Notes

- The `member list` description already says "the --assignee candidate set" — now even more accurate
- Project owner (project create --assignee) is a different concept and remains unaffected
