# [Bug] 清空工作项负责人(assignee)

Issue: <https://github.com/anine09/pingcode-cli-unofficial/issues/1>

## Goal

让"想清空负责人"这个意图在 CLI 里得到**诚实、可操作**的反馈,而不是一个隐晦错误或一次静默的空操作。

## Background — this is an API limitation, not a CLI bug

Live-verified and cross-checked (see `research/clear-assignee-api.md`): the **PingCode Open
REST API cannot clear a work item's assignee.** The `PATCH /v1/pjm/work_items/{id}` body carries
`assignee_id: string` with no `nullable`, and the SDK serializes it with `omitempty` — so a client
can only express "set to X" or "don't touch". The observed behaviour:

- `{"assignee_id": null}` → HTTP 200, but the assignee is **not** cleared (server treats `null` as absent → no-op).
- `{"assignee_id": ""}` → HTTP 400 (`'assignee_id'不是有效的字符串(值不能为空)`).
- The Web UI clears it because it calls an internal GraphQL/RPC that distinguishes set-null from omit; that surface is not public.

So "make clearing actually work" is out of scope and impossible via the public API. The deliverable
is to turn the current failure mode (cryptic `user must not be empty`, or worse a 200 no-op) into a
clear, actionable refusal.

## Requirements

- **R1 — Recognise clear-intent.** When `work-item update` is given `--assignee ""` (empty string —
  the natural way a user tries to clear), the CLI must **not** send a request and must **not** emit
  the generic `user must not be empty`. Instead it raises a `UsageError` (exit 2) whose message
  states the Open API cannot clear the assignee.
- **R2 — Actionable hint.** The error carries a `hint` telling the user the only supported path is
  the PingCode Web UI.
- **R3 — No network, no false success.** The guard fires *before* any request is sent. No PATCH, no
  200 no-op that a user could mistake for success.
- **R4 — No regression.** A real `--assignee <name|id>` still resolves and assigns exactly as today.
- **R5 — Document the limitation.** The `--assignee` help text on `work-item update` (and the
  relevant user-facing doc) notes that clearing is not supported via the API, so users learn it
  without trial-and-error.

## Non-goals / Constraints

- Do **not** change the API layer (`src/api/workItems.ts`), the `UpdateWorkItemInput` type, or the
  exit-code / error-kind contract (exit 2 = `usage` stays).
- Do **not** add a new `--clear-assignee` / `--unassign` flag — the API cannot fulfil it, so a new
  flag would only need its own error. The honest signal is the empty-string attempt, which we now
  explain.
- Do **not** match on the API's Chinese message text anywhere.
- Do **not** widen `assignee_id` to `string | null` or attempt to send `null`; sending anything for a
  clear-intent is the thing we are refusing to do.

## Acceptance Criteria

- [ ] `pingcode project work-item update <id> --assignee ""` → exit **2**, message says the Open API
      cannot clear the assignee, hint points to the Web UI, **no request sent** (verified by
      inspecting that no PATCH is issued / dry-run style).
- [ ] `pingcode project work-item update <id> --assignee <real user>` still resolves and assigns
      (no regression).
- [ ] `work-item update --help` `--assignee` line documents the limitation.
- [ ] Existing `work-item` tests pass; a new test pins the clear-intent `UsageError` and its exit.
- [ ] Change ships with a research-backed rationale (no assumption about the API).
