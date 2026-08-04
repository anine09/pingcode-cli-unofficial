# 项目管理 (pjm) — `project`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the pjm command surface and the ids it needs.

### Projects — 项目管理

```bash
pingcode project list --json
pingcode project list --keywords mobile --type scrum
pingcode project get "Mobile App" --json
```

### `project meta` — mandatory before creating or updating a work item

`type_id`, `state_id` and `priority_id` are **project-scoped**: the same state name has a different id
in another project, and system work-item types use slugs (`task`, `story`, `bug`) while custom types
use hex ids. Never reuse an id across projects, and never guess one.

```bash
pingcode project meta types --project "Mobile App" --json
pingcode project meta states --project "Mobile App" --type task --json
pingcode project meta priorities --project "Mobile App" --json
pingcode project meta sprints --project "Mobile App" --json
```

`pingcode project meta states` requires **both** a project and a type — that is an API constraint, not a CLI
choice.

Lookups are cached under `~/.pingcode/cache/` for 24 hours. Use `--no-cache` if a project was
reconfigured and an id looks stale.
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
