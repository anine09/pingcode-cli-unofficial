# 构建与部署 (build / release) — `build`, `release`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the build and deployment write-back surface and
> the ids it needs.

**What these two modules are for.** They are the other half of the *write-back* API
[`scm.md`](scm.md) describes: a CI/CD job tells PingCode "this build ran" and "this release
was deployed", and PingCode shows those facts on the work items involved. Nothing here runs
a pipeline, watches one, or reads anything from your CI server — every row you create is a
record inside PingCode that you wrote.

**Two separate groups, because they are two separate APIs** with different scopes:

```
build    构建记录   /v1/build/builds        pcp:*:devops:build
release  环境       /v1/release/environments  ┐
         部署       /v1/release/deploys       ┘ pcp:*:devops:deploy
```

**The write-back path.** Both groups are flat — there is no platform, project or product to
resolve first, unlike scm:

```
build create ─────────────────────┐
                                  ├→ --work-item PLM-001  (that is the only link)
release env create → deploy create ┘
```

An environment is standing configuration (create it once); a build and a deploy are events
(one row per run).

**Three group-wide facts.**

- Both groups are **企业令牌 only** — which is exactly the token this CLI holds, so they work
  out of the box. `build` needs `pcp:read:devops:build` / `pcp:write:devops:build`;
  `release` needs `pcp:read:devops:deploy` / `pcp:write:devops:deploy` for **both** its
  subgroups. These are *separate* from scm's `devops:code`: a token that can write commits
  cannot write builds, and the only symptom is exit 4.
- **`--work-item` is the entire integration.** Neither group has any other reference to
  PingCode data — no project, no product, no repository. A build or deploy with no
  `--work-item` is invisible outside its own list.
- **Everything is organisation-level.** No `--platform`, no `--project`, no `--product` on
  any leaf. Do not look for one.

### Build records — `build`

```bash
pingcode build list --json
pingcode build list --page 1 --page-size 20 --json
pingcode build get 6a70c1eb919cce9794f01acb --json
pingcode build create --name unit-test --identifier 131 --provider jenkins --status success \
  --start-at 1785700000 --end-at 1785700038 --duration 38 --dry-run --json
pingcode build create --name unit-test --identifier 131 --provider jenkins --status success \
  --start-at 2026-08-04T09:00:00Z --end-at 2026-08-04T09:00:38Z --duration 38 \
  --job-url https://ci.example.com/job/131 --result-overview "1000 test cases pass" \
  --work-item PLM-001 --json
pingcode build update 6a70c1eb919cce9794f01acb --status failure --json
pingcode build delete 6a70c1eb919cce9794f01acb --yes --json
```

**`build list` has no filters. None.** The endpoint documents no query parameter, and
`identifier`, `name`, `status`, `provider` and `work_item_id` were each tried against the
live API and **silently ignored** — every row came back every time. So the CLI offers only
`--page` / `--page-size` / `--all`, and any list is a whole-organisation scan. **Keep the
`id` that `build create --json` returns**; it is the only cheap way back to a build.

**The build number (`--identifier`) is not a key.** Two builds may carry `131` and the API
accepts both. `build get` therefore takes an **id**, never a number, and there is no name
resolution to fall back on.

Seven flags are required on `create` because the API requires all seven: `--name`,
`--identifier`, `--provider`, `--status`, `--start-at`, `--end-at`, `--duration`. In
particular **`--duration` is not derived** from the two timestamps — the server never
computes it, so report whatever your pipeline measured.

- `--provider` is a closed enum: `bamboo | bitbucket | jenkins | other`. Anything else is
  exit 7 from the server, not exit 2 from the CLI. There is no `github-actions` or
  `gitlab-ci` value; use `other`.
- `--status` is `success | failure`. There is no "running", "cancelled" or "unstable" — a
  build in flight is usually recorded once it finishes, or created and then moved with
  `build update --status`.
- Timestamps take unix **seconds** or a date string. Milliseconds are rejected by the server
  (exit 7, `数值不是有效的时间戳`), so pass seconds or let the CLI convert a date for you.

`build delete` exists — the only delete in the whole DevOps surface apart from
`scm branch delete` — because a build record can simply be written again. It requires
`--yes`, it reads the record first so the confirmation names it (`the build #131
"unit-test"`), and it takes no `--all`. It is a hard delete: a following `get` is exit 5.
Unlike deleting an scm branch, it takes nothing else with it.

There is **no `build replace`**. `PUT /v1/build/builds/{id}` exists upstream but would blank
every field you did not send, so it is reachable only as
`pingcode api PUT /v1/build/builds/<id>` — where you are explicitly asking for a full
replacement.

### Deploy environments — `release env`

```bash
pingcode release env list --json
pingcode release env list --name production --json
pingcode release env get production --json
pingcode release env create --name production --html-url https://app.example.com --json
pingcode release env update production --html-url https://app.example.com/status --json
pingcode resolve release-env production --json | jq -r .id
```

**An environment name is a complete address.** Names are unique per organisation and
`--name` is an exact (case-insensitive) filter that upstream really honours — so unlike
most ids in this API, you can pass the name everywhere an environment is expected, and
`pingcode resolve release-env <name>` turns it into the id `pingcode api` wants. A duplicate
create is exit 7 (`环境已经存在`).

Two things to know before scripting an update:

- **`--html-url` cannot be cleared.** The server validates it as a URL and rejects an empty
  value, so a link can be replaced but never removed.
- The resource is only `{id, name, html_url}` — there is nothing else to patch.

There is **no `release env delete` leaf**, and this is *not* because the API lacks one: the
endpoint exists and works. It is simply not wrapped yet. Until it is:

```bash
pingcode api DELETE /v1/release/environments/<id> --yes
```

The server **refuses** that while any deploy still references the environment (exit 7,
`'environment'正在使用，不能被删除`) — delete those deploys first. That refusal is good news:
unlike an scm branch, whose deletion orphans its commit refs permanently, nothing in
`release` can be left dangling.

### Deployment records — `release deploy`

```bash
pingcode release deploy list --json
pingcode release deploy list --env production --json
pingcode release deploy get 6a70c153919cce9794f01aca --json
pingcode release deploy create --env production --status deployed --release-name 1.4.0 \
  --start-at 1785700000 --end-at 1785700200 --duration 200 --dry-run --json
pingcode release deploy create --env production --status deployed --release-name 1.4.0 \
  --start-at 2026-08-04T09:00:00Z --end-at 2026-08-04T09:03:20Z --duration 200 \
  --release-url https://github.com/acme/app/releases/tag/1.4.0 --work-item PLM-001 --json
pingcode release deploy update 6a70c153919cce9794f01aca --status deployed --json
```

`--env <name|id>` and `--env-id <id>` are the usual pair: the name resolves (and a typo is
exit 2 that lists the real environments), the id is sent unchanged. One of them is required
on `create`; on `list` it is the **only** filter that works — `status`, `release_name` and
`work_item_id` were tried live and silently ignored.

⚠️ **On `list`, an unknown `--env-id` gives you an empty list, not an error.** The API answers
200 with zero rows, so silence does not distinguish "nothing deployed there" from "no such
environment". Use `--env <name>` instead and a bad name fails loudly. (`release deploy
create` does report a missing environment properly: exit 5.)

Six flags are required on `create`, for the same reason as `build`: `--status`,
`--release-name`, `--start-at`, `--end-at`, `--duration`, plus the environment.

- `--status` has exactly two values: `not_deployed | deployed`. There is **no failed or
  rolled-back state** — record a rollback as another deploy of the previous release.
- `--release-name` is free text (`1.4.0`, a tag, a commit subject) and is **not unique**, so
  it is not a lookup key. `release deploy get` takes an id.

⚠️ **A deploy cannot be moved between environments, and the API pretends otherwise.**
`release deploy update` has no `--env` on purpose: the endpoint documents `env_id` as
updatable and *accepts* it — it returns 200 **and echoes the new environment back in the
response** — but the change is never stored, and a following `get` shows the original
environment. So the usual "read it back to be sure" habit does not protect you here; the
response itself is wrong. Record a new deploy on the right environment instead, and remove
the stray one with `pingcode api DELETE /v1/release/deploys/<id> --yes`.

⚠️ **Moving a deploy's time window needs two calls, `--end-at` first.** A new `--start-at` is
validated against the **stored** `--end-at`, not against one sent in the same request, so
pushing a window forward in a single update is exit 7
(`开始时间必须小于等于已存在的结束时间`). Extend the end, then move the start. Reversing the two
on a `create` is exit 7 as well (`开始时间必须小于等于结束时间`).

No `release deploy replace` (the `PUT` would blank omitted fields — use
`pingcode api PUT /v1/release/deploys/<id>` deliberately) and no `release deploy delete`
leaf, though the endpoint exists and works:
`pingcode api DELETE /v1/release/deploys/<id> --yes`.

### Linking to work items — the trap both groups share

`--work-item` takes a work item **identifier** (`PLM-001`), repeatable, and it is the only
thing that connects a build or a deploy to anything in PingCode.

⚠️ **An identifier that does not exist is silently dropped and the call still returns 200.**
Mixed input links the ones that exist and ignores the rest, so **the exit code cannot tell
you whether the link happened**. The CLI compares what you asked for against the response
and prints a warning on stderr naming the identifiers that did not land — the exit code
stays 0, because the write itself succeeded. Under `--json` the authoritative `work_items`
array is on stdout: read it if you care.

On `update`, `--work-item` **replaces** the whole link set, it does not merge. Passing none
leaves the existing links alone.

Two contrasts with [`scm.md`](scm.md) worth stating, because they are the kind of thing
that gets copied across modules by mistake:

- **Nothing in these two groups upserts an identity.** scm's `--sender`, `--owner-name`,
  `--creator`, `--merged-by` and `--reviewer` each create a permanent 托管平台用户 from a
  typo. No field here is a name reference of that kind, so there is no ghost-identity
  hazard to warn about.
- **A missing parent is reported honestly on a create** (`release deploy create --env-id
  <unknown>` is exit 5), unlike `scm review list` under an unknown pull request. The one
  place silence hides an absence here is `release deploy list --env-id`, called out above.

### What is not here

| Wanted | Reality |
|---|---|
| filter builds by status, work item, provider… | the endpoint honours no filter at all; page through `build list` or keep the id |
| look a build up by its build number | numbers are not unique; use the id |
| a "running"/"cancelled" build status | the enum is `success | failure` only |
| a failed or rolled-back deploy status | the enum is `not_deployed | deployed` only |
| `build replace` / `release … replace` | `PUT` is generic-layer only: `pingcode api PUT <path>` |
| `release env delete` / `release deploy delete` | the endpoints exist and work, but are not wrapped yet: `pingcode api DELETE <path> --yes` |
| move a deploy to another environment | not possible: `env_id` is accepted on PATCH, echoed back, and ignored — create a new deploy |
| attach a build to a project, sprint or release version | not in this API; `--work-item` is the only link |
| trigger, cancel or poll a pipeline | not in this API at all — these are records, not controls |
