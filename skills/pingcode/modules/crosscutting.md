# 跨对象资源 — relations / comments / attachments / activities

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the cross-object surface.

Four families are polymorphic over the object they hang on: **关联 relations**, **评论 comments**,
**附件 attachments** and **活动记录 activities**. They are the glue between the four modules — a
requirement linked to a work item linked to a test case linked to a defect — and they are the
only write-back channel an automated flow has for prose.

They live **under the entity they belong to**, so the entity's own command path supplies
`principal_type` and you never type it:

```bash
pingcode project work-item comment add <work-item> --text "CI #123 failed, filed BUG-45"
pingcode product idea relation list <idea> --target-type work_item
pingcode testhub cases relation add <case> --target-type work_item --target-id <id>
pingcode testhub runs activity list <run>
pingcode product ticket attachment list <ticket>
```

There is deliberately **no top-level `comment` group**: it would have to ask you for
`--principal-type`, which is a value you can get wrong. If you need the generic form anyway, it
already exists: `pingcode api GET /v1/comments --query principal_type=work_item --query
principal_id=<id>`.

## 1. Where they are mounted, and where they are not

| mount | `principal_type` | relation | comment | attachment | activity |
|---|---|---|---|---|---|
| `pingcode project work-item …` | `work_item` | yes | yes | yes | yes |
| `pingcode product idea …` | `idea` | yes | yes | yes | yes |
| `pingcode product ticket …` | `ticket` | yes | yes | yes | yes |
| `pingcode testhub cases …` | `test_case` | yes | yes | yes | yes |
| `pingcode testhub runs …` | `test_run` | yes | yes | yes | yes |

**A test plan is not an object these families accept.** There is no
`pingcode testhub plans comment`, and there is no generic way to fake one: the API rejects
`principal_type=test_plan` outright, and `/v1/activities` answers it with an HTTP 500 rather than
a 4xx. Comment on the plan's runs instead.

A wiki page (`principal_type=page`) is accepted by comments and attachments but **not** by
activities, and 知识库 wiki has no command group of its own, so reach it through
`pingcode api … --query principal_type=page`.

## 2. Every command takes the parent object first

```bash
pingcode project work-item comment get <work-item> <comment-id>
pingcode project work-item comment delete <work-item> <comment-id> --yes
```

Two positional arguments, always in that order, for all four families. The reason is the API's,
not ours: `GET /v1/comments/{id}` and `GET /v1/attachments/{id}` **require** the principal in the
query — a comment id alone is not addressable. `relation get` / `relation delete` are the one
exception under the hood (a relation id is globally addressable), but they still take the parent
reference so the four families have one shape; it is accepted and not sent, and costs no request.

The parent reference accepts whatever that entity's own `get` accepts — an id, a `short_id`, an
identifier such as `SCR-5`, a pasted URL — and is resolved to a real id first, because **no
cross-object endpoint accepts anything but an id**.

## 3. relations: cross-*kind* only, and the pairs are asymmetric

`POST /v1/relations` takes no relation type of any kind. What it does take is a pair of kinds,
and it refuses some pairs — including every same-kind work-item pair:

| from ↓ | `work_item` | `idea` | `ticket` | `test_case` | `test_run` | `page` |
|---|---|---|---|---|---|---|
| `work_item` | **no** | yes | yes | yes | no | yes |
| `idea` | yes | yes | yes | yes | no | yes |
| `ticket` | yes | yes | yes | **no** | no | yes |
| `test_case` | yes | yes | **no** | no | no | yes |
| `test_run` | yes | no | no | no | no | no |

Read that table as *observed*, not *documented*: the API declares no vocabulary for either field,
so this is what a live tenant accepted. The CLI refuses nothing locally — it sends what you ask
and explains the rejection.

**There is a second filter the table cannot show: the work item's *type*.** Creating a link
*from* a test case, only a 需求 (story) or 缺陷 (bug) target is accepted; *from* a test run, only
a 缺陷. An epic, feature or task target is rejected with `不支持的工作项类型` (`100107`) — while the
same link created *from the work-item side* succeeds for any type. So if you are linking a case or
a run to a feature, create the link from the work item instead:

```bash
# refused (100107):  testhub cases relation add <case> --target-type work_item --target-id <feature>
pingcode project work-item relation add <feature> --target-type test_case --target-id <case>
```

Three consequences worth internalising:

1. **work item ↔ work item is a different family.** Those links are typed (阻塞 / 重复 / 关联 …)
   and live on `POST /v1/pjm/work_items/{id}/relations` with a `relation_type`. Reach them with
   `pingcode api POST /v1/pjm/work_items/<id>/relations --set target_work_item_id=<id> --set
   relation_type=<type>`, and list the types with
   `pingcode api GET /v1/pjm/work_item/relation_types`.
2. **Direction matters even though the link does not.** `test_run → work_item` is accepted;
   `work_item → test_run` is not. Once created, the link is stored as a mirrored pair and shows up
   from both ends — with a *different* id on each side. Deleting either id removes both.
3. **`--target-type` is mandatory on `relation list`.** It reads like a filter and is not: omit it
   and the API rejects the call.

When a pair is refused, the API answers `不支持的'principal_type'` (code `100049`) **whatever was
actually wrong** — a bad target kind, or no target kind at all. The CLI prints the pair it tried
and the kinds this principal does link to; trust that line over the server's message.

## 4. comments: delete is a soft delete

```bash
pingcode project work-item comment add <work-item> --text "…" --reply-to <comment-id>
pingcode project work-item comment list <work-item> --all
```

`comment delete` **does not remove the row.** It stays in `comment list` with `is_deleted` set, and
the table's `STATE` column shows `deleted`. Read that column and nothing else: whether the text
survives depends on the module — a work-item comment comes back empty, a ticket comment keeps its
body — so neither "has content" nor "has none" tells you whether a comment is live.

## 5. attachments: snippets only, and always under a comment

There are two upload shapes in the API and the CLI can only send one of them:

- **files** are `multipart/form-data` in a single request. This CLI cannot produce that body, so
  `attachment add` does not exist. Read, list and delete work normally on files uploaded through
  the web UI.
- **code snippets** are JSON, and `attachment add-snippet` sends them.

```bash
pingcode project work-item comment add <work-item> --text "build log"
pingcode project work-item attachment add-snippet <work-item> \
  --comment-id <comment-id> --title main.go --format go --content-file ./main.go
```

**`--comment-id` is required**, on the write and on every subsequent read. The docs call it
optional; live, a snippet posted without it is rejected (`100039`), and a snippet that exists is
reported as *not found* (`100045`, exit 5) if you read or delete it without the scope. Create the
comment first, keep its id.

`--format` is a closed vocabulary — `clike css dart django dockerfile go markdown nginx python php
shell sql swift html javascript jsx pascal sass stylus vue yaml haskell` — and anything else is
rejected as a malformed request. `--content` takes the text inline, `--content-file` reads a file
verbatim; exactly one of the two.

Unlike a comment, `attachment delete` is permanent.

## 6. activities: the only change feed there is

Read-only, and per-object. This API has **no webhook API and no global activity stream**, so
polling `activity list` on the objects you care about is the only way to notice a change.

`EVENT` is the machine-readable name (`unrelate-test-case`) and its verb (`unrelate`); `SUMMARY`
is Chinese prose written for humans and is **not** a contract — never match on it. The `content`
object differs per event type and is passed through untouched, so read it from `--json`.

## 7. Exit codes you will actually see here

| what happened | code | exit |
|---|---|---|
| parent reference could not be resolved | — | 2 |
| `--yes` missing on a delete | — | 2 |
| unsupported `principal_type`, or a refused pair, or a missing `--target-type` | `100049` | 7 |
| snippet without `--comment-id`, or an unknown `--format` | `100039` | 7 |
| work item on the other end has a type this direction refuses | `100107` | 7 |
| comment / attachment / activity / relation id does not exist | `100051` / `100045` / `100077` / `100801` | 5 |
| parent object does not exist (work item) | `100317` | 5 |
| `principal_type=test_plan` on `activities` | — | 8-ish: HTTP 500, do not do this |
