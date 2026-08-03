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
