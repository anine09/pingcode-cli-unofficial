# 项目管理 (pjm) — `project`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the pjm command surface and the ids it needs.

### Projects — 项目管理

```bash
pingcode project list --json
pingcode project list --keywords mobile --type scrum
pingcode project get "Mobile App" --json
pingcode project progress "Mobile App" --json

pingcode project create --name "Payments" --identifier PAY --type scrum --dry-run --json
pingcode project create --name "Payments" --identifier PAY --type scrum \
  --assignee wangxiao --member wangxiao --member lina --json
pingcode project update "Payments" --description "Q4 rewrite" --json
```

**A project cannot be deleted, and cannot even be archived.** There is no `DELETE
/v1/pjm/projects/{id}`, and `is_archived` is read-only — a patch containing it returns 200 and
changes nothing (verified live). So `project create` is **irreversible**: a project created by
mistake stays in every listing forever. Always `--dry-run` first.

Two more create-time facts an `--help` line cannot convey:

- **`--visibility` can only be set at create time.** Patching it later is accepted and silently
  dropped, exactly like `is_archived`, `type` and `process_id`.
- **`--identifier` prefixes every work-item id** in the project (`PAY-1`, `PAY-2`). It must be
  uppercase and short; anything else is rejected as a bad format rather than truncated. It is the
  one required create field that *can* still be changed afterwards — and changing it renames every
  work-item identifier in the project.
- **`--start-at` / `--end-at` are instants, stored verbatim** — `12:34:56` comes back as
  `12:34:56`. This is the opposite of `project sprint` and `project version`, which snap to
  `00:00:00` / `23:59:59` of the date. That is why this pair is spelled `--start-at` / `--end-at`
  and theirs is `--start` / `--end`. The inconsistency is upstream's, not the CLI's.
- **`--assignee` (负责人) is unrelated to membership.** It may be someone who is not a member, and
  setting it does not add them. `PATCH` is partial: fields you do not pass are untouched.

`project progress` returns **work-item counts only** — no sprint, release or workload figure — and
it is a single count block, not a list, despite the API docs implying otherwise. The three counts
group every state by its `type`, so a custom state counts towards whichever of
pending / in_progress / completed it is configured as.

### 项目成员 Members — `project member`

```bash
pingcode project member list --project "Mobile App" --json
pingcode project member get wangxiao --project "Mobile App" --json
pingcode project member add --project "Mobile App" --user lina --json
pingcode project member add --project "Mobile App" --group-id 68389e7f33ee52bc5c2584c1 --json
```

- **A membership is addressed by the USER id.** The row's `id` *is* the user (or group) id, so
  `member get` takes the same reference `member add --user` took. There is no separate membership
  id.
- **There is no `member remove` leaf.** The endpoint exists; it is reachable through the generic
  layer, and that call is verified working:
  `pingcode api DELETE /v1/pjm/projects/<project_id>/members/<user_id> --yes`. It is not a refined
  leaf because a membership is the cheapest thing in this API to recreate — one `member add`.
- `--role-id` is optional and defaults to 普通成员. The three roles are organisation-level:
  `pingcode api GET /v1/directory/roles`.
- A user who is not in the project, **and** an id that does not exist, both answer
  `成员不在项目中` → **exit 5**. The two are indistinguishable, so exit 5 here means "not a member
  of this project", not necessarily "no such user".

### `project meta` — mandatory before creating or updating a work item

`type_id`, `state_id` and `priority_id` are **project-scoped**: the same state name has a different id
in another project, and system work-item types use slugs (`task`, `story`, `bug`) while custom types
use hex ids. Never reuse an id across projects, and never guess one.

```bash
pingcode project meta types --project "Mobile App" --json
pingcode project meta states --project "Mobile App" --type task --json
pingcode project meta priorities --project "Mobile App" --json
pingcode project meta sprints --project "Mobile App" --json
pingcode project meta relation-types --json
pingcode project meta tags --project "Mobile App" --json
```

`pingcode project meta states` requires **both** a project and a type — that is an API constraint, not a CLI
choice.

Lookups are cached under `~/.pingcode/cache/` for 24 hours. Use `--no-cache` if a project was
reconfigured and an id looks stale.

`project meta relation-types` is **organisation-wide** and takes no project: nine system rows, and
the `CATEGORY` column (`relate`, `block`, `blocked_by`, `cause`, `caused_by`, `clone`, `cloned_by`,
`duplicate`, `mention`) is the stable key to script against — the ids are 24-hex and differ per
tenant. It serves `project work-item link add` and nothing else.

**`project meta tags` needs reading before you use an id from it.** `--project` is *required* by the
endpoint and then *ignored* by it — three different projects return byte-identical lists (verified
live) — so what you get is every tag in the **organisation**. Tags are nevertheless really
project-scoped where it counts: `work-item tag add` refuses a tag belonging to another project with
`'tag'资源不存在`, which reads as though the tag did not exist. It does; it is simply not this
project's. Concretely: of 23 org-wide tags, **all 23 were refused** for a work item in one project
and **8 were accepted** for a work item in another. There is no endpoint listing just one project's
tags, so the reliable way to find a usable id is to read the `tags[]` of a work item already in that
project. Names are not unique either (four `后端`, three `前端`), which is also why `pingcode resolve`
has **no** work-item-tag kind: a cached resolver would hand back ids the write refuses.

### Work items — `project work-item`

```bash
pingcode project work-item list --project "Mobile App" --json
pingcode project work-item list --project "Mobile App" --type task --state "In Progress" --json
pingcode project work-item list --project "Mobile App" --assignee wangxiao --page-size 20 --page 0
pingcode project work-item list --project "Mobile App" --all --limit 200 --json

pingcode project work-item get SCR-5 --json
pingcode project work-item get 1bAqLmTG --json
pingcode project work-item get https://example.pingcode.com/pjm/work_items/1bAqLmTG --json

pingcode project work-item create --project "Mobile App" --type task --title "Fix login retry" --dry-run --json
pingcode project work-item create --project "Mobile App" --type task --title "Fix login retry" \
  --assignee wangxiao --priority High --end-at 2026-02-15 --json

pingcode project work-item update SCR-5 --title "Fix login retry (v2)" --json
pingcode project work-item update SCR-5 --type task --state "In Progress" --json
pingcode project work-item transition SCR-5 --type task --state Done --json
pingcode project work-item transition SCR-5 --state-id 5eb623f6a70571487ea47000 --json
```

`project work-item get` accepts an id, a `short_id`, an identifier such as `SCR-5`, or a pasted work-item URL.
`update` and `transition` accept the same forms and resolve them to a real id first.

On `update` and `transition`, `--type` is **only** a lookup aid: it resolves `--state <name>` and lets
the CLI list the candidate states if the server rejects the change. It is never written to the work
item — there is no patchable type field.

#### Filtering: two transports, one command

```bash
pingcode project work-item list --project "Mobile App" --unassigned --json
pingcode project work-item list --project "Mobile App" --title-contains login --json
pingcode project work-item list --project "Mobile App" --created-after 2026-08-01 --all --json
```

Six flags — `--unassigned`, `--title-contains`, `--created-after/-before`,
`--updated-after/-before`, marked `(search)` in `--help` — can only be expressed by
`POST /v1/pjm/work_items/search`, so passing any of them switches the transport. **Paging, `--all`
and the reported total behave identically on both**, so the switch is invisible except for which
filters exist. What genuinely differs is the filter vocabulary: search cannot filter by
`identifier`, `short_id` or bug type at all, and the simple list cannot filter by date, title text
or "unassigned".

#### `bulk-update` — one property, many work items

```bash
pingcode project work-item bulk-update --id SCR-5 --id SCR-6 --assignee wangxiao --json
pingcode project work-item bulk-update --id SCR-5 --id SCR-6 --project "Mobile App" --type task --state Done --json
```

**The endpoint carries ONE `property_name` per call**, so exactly one of `--assignee` / `--state` /
`--priority` / `--title` / `--description` / `--property` may be given; two properties need two
invocations. Four things about it that will bite an agent that assumes otherwise:

- **`--sprint` does not exist here, deliberately.** `property_name: sprint_id` is accepted with
  HTTP 200 and `updated: 0`, and changes nothing (verified live). The same is true of `type_id`,
  `tag_ids`, `version_ids`, `participant_ids`, `properties` and `bug_type_id`. To move items into a
  sprint, loop `work-item update --sprint` one item at a time. Only `assignee_id`, `state_id`,
  `priority_id`, `title` and `description` actually apply; `--property` is the unvalidated escape
  hatch for anything else.
- **Always read the `updated` count.** It is the *only* signal the endpoint gives: a nonexistent id,
  a silently-rejected value and an unsupported property all answer 200. The CLI warns when `updated`
  is less than the number of ids sent — treat that warning as "verify by reading the items back".
- **It is best-effort, not atomic.** An unknown id is skipped silently and the rest still land. (The
  `sprint bulk` and `version bulk` creates *are* atomic — do not generalise from one to the other.)
- **It leaves no audit trail.** The change appears in neither `work-item activity list` nor
  `work-item history list`, while the equivalent single `update` does. It is invisible to an audit.

#### `delete`

```bash
pingcode project work-item delete SCR-5 --yes --dry-run --json
pingcode project work-item delete SCR-5 --yes
```

`--yes` is mandatory and the refusal echoes the identifier and title, so a wrong reference is
visible before the write. Unlike a sprint (which can never be deleted) a work item **can** be, and
it leaves every list, sprint, board and link immediately. The web UI recycle bin can restore it;
this API cannot.

#### `link` vs `relation` — two unrelated families, and they must not be confused

```bash
pingcode project meta relation-types --json
pingcode project work-item link add SCR-5 --target SCR-6 --relation block --json
pingcode project work-item link list SCR-5 --json
pingcode project work-item link get SCR-5 <link_id> --json
pingcode project work-item link delete SCR-5 <link_id> --yes
```

- **`link` is work item ↔ work item, with a required type** (`/v1/pjm/work_items/{id}/relations`).
  `--relation` accepts the category slug (`block`), the localized name (`阻塞`) or the id — all three
  verified working.
- **`relation` is work item ↔ anything else, with no type at all** (`/v1/relations`) and it
  **refuses** two work items outright (`不支持的'principal_type'`). Use it for a work item to an
  idea, ticket, test case or wiki page.
- The server maintains the **inverse** edge: adding `block` on one item adds `blocked_by` on the
  other, and deleting either side removes both. **The two sides have different link ids**, so delete
  the id `link list` printed for the item you are on — passing the other end's id answers
  `工作项或工作项关联不存在` → exit 5.
- Links may cross projects, and a work item may be linked to itself.

#### `tag` — and the list that does not exist

```bash
pingcode project work-item tag add SCR-5 --tag-id 6a28fbe209dbd0bc097457ee --json
pingcode project work-item tag get SCR-5 <tag_id> --json
pingcode project work-item tag delete SCR-5 <tag_id> --yes
```

**There is no `work-item tag list`, and there cannot be**: upstream has the add, the get-one and the
delete but no collection GET. Read the `tags[]` field of `work-item get` instead — that is the
complete answer for one work item. `project meta tags` is the only way to enumerate the vocabulary,
with the organisation-wide caveat documented above; `--tag <name>` is resolved live against the work
item's own project and errors with the candidates when a name is ambiguous, which the common names
are.

#### `history` — state changes only

```bash
pingcode project work-item history list SCR-5 --json
pingcode project work-item history get SCR-5 <history_id> --json
```

流转记录 is **state changes only**. A title, assignee or sprint change is not here — that is
`work-item activity list`, the free-form audit feed. Every work item has one row from creation, with
`FROM` shown as `(new)`. A `bulk-update` appears in **neither** feed.

### 迭代 Sprints — `project sprint`

```bash
pingcode project meta sprints --project "Mobile App" --json          # the LIST lives here
pingcode project sprint get "Sprint 5" --project "Mobile App" --json
pingcode project sprint create --project "Mobile App" --name "Sprint 5" \
  --start 2026-09-01 --end 2026-09-14 --assignee wangxiao --json
pingcode project sprint update "Sprint 5" --project "Mobile App" --status in_progress --json
pingcode project sprint bulk --project "Mobile App" --assignee wangxiao --file sprints.json --json
```

Four things about sprints that `--help` cannot make obvious enough:

1. **There is no `sprint list` leaf.** The list is `project meta sprints`, because it doubles as
   the lookup `--sprint <name>` resolves against. Do not look for `project sprint list`.
2. **A sprint cannot be deleted. Ever.** The API exposes only `GET` and `PATCH` on a sprint, so
   `pingcode api DELETE /v1/pjm/projects/<p>/sprints/<id>` is refused before any request too.
   Treat `sprint create` and `sprint bulk` as irreversible.
3. **Sprints exist only in scrum and hybrid projects.** In a kanban or waterfall project the list
   is empty and a create fails with `'project'资源不存在` — *the project is fine*, sprints are not
   available in it. That exits **7**, not 5, precisely because the code cannot be told apart from a
   genuinely missing project; the CLI appends the explanation to the message. Plan releases with
   `project version` instead, which works in every project type.
4. **`--status` writes a field, it does not run the lifecycle.** Setting `in_progress` or
   `completed` through the API leaves `started_at` and `completed_at` `null`, and neither is
   writable. A sprint "completed" via the API is not the same as one completed in the web UI.

### 发布 Releases — `project version`

```bash
pingcode project version list --project "Mobile App" --json
pingcode project version list --project "Mobile App" --name 1.4 --status in_progress --json
pingcode project version get "1.4.0" --project "Mobile App" --json
pingcode project version create --project "Mobile App" --name 1.4.0 \
  --start 2026-09-01 --end 2026-09-30 --assignee wangxiao --json
pingcode project version update "1.4.0" --project "Mobile App" --stage-id <id> --operate-at 2026-09-20 --json
pingcode project version delete "1.4.0" --project "Mobile App" --yes --json
pingcode project version bulk --project "Mobile App" --assignee wangxiao --file releases.json --json
```

**"version" is the most overloaded word in this API. This one is a project release 发布.** It is
not a wiki page revision (`/v1/wiki/pages/{id}/versions`), not a work-item state or property
*scheme* (`work_item_state_plans`, `*_property_plans`), and not a test plan or a requirement
schedule. Four different resources, one English word. `project version` only ever means the first.

- **`--name` on the list is a SUBSTRING search**, case-insensitive — `--name 1.4` matches `1.4.0`
  and `1.4.1`. This is unlike `scm platform list --name` and `release env list --name`, which are
  exact matches. Do not use it as an existence check.
- **`--status` filters on the stage's *kind*** — `pending | in_progress | published` — not on a
  field of the release, which has no `status` at all. Stage *names* (`未开始`) are rejected with
  exit 2.
- **The API ignores `--project` on `get` and `update`.** A version id is effectively
  organisation-wide: naming the wrong project still reads, and still *writes* — the change lands on
  the release in its real project. Only `delete` refuses a mismatched pair. Never treat a
  successful update as proof that the project was right.
- **`progress` and `changelog` are read-only.** No body field writes either; sending one is
  accepted and silently dropped.
- **`--operate-at` requires `--stage-id`.** Sent alone the API answers 200, echoes the *previous*
  value and stores nothing, so the CLI refuses it with exit 2. Moving to a stage the release has
  never been in requires it; moving to one it has been in does not. Moving to the stage it is
  already in is refused by the server (exit 7).
- **`version delete` detaches the release from every work item that references it.** The work items
  survive; their version link disappears. It is gated behind `--yes` and the confirmation names the
  release.
- **Stages and categories are ids, not names.** `--stage-id` and `--category-id` take ids because
  the stage and category endpoints are outside this command group:
  `pingcode api GET /v1/pjm/stages` and
  `pingcode api GET /v1/pjm/projects/<project_id>/version_categories`. A release name *is*
  resolvable: `pingcode resolve pjm-version "1.4.0" --parent <project_id>`.

### Both families: dates, and the two `bulk` leaves

**`--start` and `--end` are dates, not instants.** The server stores `--start` at `00:00:00` and
`--end` at `23:59:59` of the date given, in both families, on create and on update. Pass
`2026-09-01`, not a timestamp, and do not try to express a partial day — it will be widened.
Unlike `release deploy`, both ends may travel in one update and are validated against each other.

Both `bulk` leaves take a JSON array (or the wire's own `{"sprints": […]}` / `{"versions": […]}`
wrapper) through `--file <path>`:

```json
[
  {"name": "Sprint 5", "start": "2026-09-01", "end": "2026-09-14"},
  {"name": "Sprint 6", "start": "2026-09-15", "end": "2026-09-28", "assignee": "lina"}
]
```

- Every entry needs `name`, `start`, `end`, a project and an assignee. The last two may come from
  the entry (`project` / `project_id`, `assignee` / `assignee_id`) or from a shared `--project` /
  `--assignee` on the command line.
- **Unknown keys are refused before anything is sent.** This matters: the API accepts unknown body
  fields with a 200 and silently drops them, so a typo would otherwise create every row with the
  field missing and no error anywhere.
- **The call is atomic.** If any entry is rejected, none is created — verified live. There is no
  entry limit (60 in one call was accepted), but two entries sharing a name inside one batch is an
  HTTP 500.
- **Both bulk endpoints are 企业令牌 only and the docs declare no scope for them.** They work with
  the CLI's client-credentials token. `pingcode api describe pjm.sprints.bulk` reports the same.
