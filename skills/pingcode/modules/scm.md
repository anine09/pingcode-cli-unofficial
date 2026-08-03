# 源码管理 (scm) — `scm`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the scm command surface and the ids it needs.

**What this module is for.** It is the *write-back* API a CI system uses: you tell PingCode
which hosting platform, git identities, repositories, branches and commits exist, and
PingCode links them to work items. It does **not** read your git server — nothing here
clones, pushes or inspects a repository. Every row you create is a record inside PingCode.

**The CI write-back path, in order.** Each step needs the one before it:

```
platform → repo → branch ─┐
                          ├→ ref   (the link between them)
              commit ──────┘
```

A commit is created *without* a repository (it is organisation-level), so `scm ref create`
is what attaches it to a branch. Do not look for a `--repo` on `scm commit`.

**Two group-wide facts.**

- Every scm endpoint is **企业令牌 only** — which is exactly the token this CLI holds, so the
  whole group works out of the box. Required scopes: `pcp:read:devops:code` and
  `pcp:write:devops:code`. Without them you get exit 4.
- An scm **platform** (托管平台) is *not* a ship product, even though both sit under a
  `products` URL segment. `pingcode product …` is 产品管理; `pingcode scm platform …` is a
  GitHub/GitLab/SVN server record.

### Hosting platforms — `scm platform`

Everything else in scm is addressed under a platform, so this is always the first call.

```bash
pingcode scm platform list --json
pingcode scm platform get Github --json
pingcode scm platform create --name "Gitea (internal)" --type other --dry-run --json
pingcode scm platform create --name "Gitea (internal)" --type other --description "self-hosted" --json
pingcode scm platform update Github --description "github.com" --json
```

`--type` is a closed enum used to pick an icon:
`github | gitlab | bitbucket | coding.net | gogs | git | svn | gerrit | other`. A value outside
it is rejected by the server (exit 7), not by the CLI.

A platform **name is unique per organisation**; creating a duplicate is exit 7 with
`'product'已经存在`.

### Git identities — `scm platform-user`

```bash
pingcode scm platform-user list --platform Github --json
pingcode scm platform-user list --platform Github --name octocat --json
pingcode scm platform-user get 685c6ca42974f854bb4979ac --platform Github --json
pingcode scm platform-user create --platform Github --name octocat --display-name "Octo Cat" \
  --html-url https://github.com/octocat --json
pingcode scm platform-user update 685c6ca42974f854bb4979ac --platform Github --display-name "Octo" --json
```

**A platform user is a git author identity, not a PingCode member, and there is no field that
links it to one.** The resource is exactly `{id, name, display_name, html_url, avatar_url}` —
no `user`, no `user_id`, no `email`, on read or on write. Attribution is by the **name
string**: a commit's `committer_name` and a branch's `sender_name` are matched against these
rows. So do not promise a user that the CLI can "assign a commit to a person"; what it can do
is make sure the git username exists as an identity with a readable display name and avatar.

`get` and `update` take an **id**, because ids in this API have three shapes and are never
guessed. Turn a git username into an id with the exact-match filter above
(`list --name octocat`), which is why no `resolve` kind exists for this resource.

### Repositories — `scm repo`

```bash
pingcode scm repo list --platform Github --json
pingcode scm repo list --platform Github --full-name acme/pingcode-cli --json
pingcode scm repo list --platform Github --all --limit 200 --json

pingcode scm repo get pingcode-cli --platform Github --json
pingcode scm repo get acme/pingcode-cli --platform Github --json

pingcode scm repo create --platform Github --name pingcode-cli --full-name acme/pingcode-cli \
  --owner-name octocat --private true \
  --html-url https://github.com/acme/pingcode-cli \
  --branches-url 'https://github.com/acme/pingcode-cli/tree/{branch}' \
  --commits-url 'https://github.com/acme/pingcode-cli/commit/{sha}' --json

pingcode scm repo update acme/pingcode-cli --platform Github --private false --json
```

Rules that will bite otherwise:

- **`full_name` (`owner/name`) is the unique key, `name` is not.** Two repositories in one
  platform may share a name (a fork and its upstream); `scm repo get <name>` then exits 2 and
  lists both ids, and the `full_name` is what disambiguates it.
- **`--full-name` is the only list filter.** The API ignores a `name` query parameter and
  returns every repository, so the CLI does not offer one.
- **`--owner-name` creates the identity if it does not exist.** An unknown git username is not
  rejected: the server makes a new platform user for it and points `owner` at it. A typo
  therefore silently produces a ghost identity, and nothing in this API can delete it.
- **`--private` and `--fork` take `true` / `false`**, not bare switches, so a repository can be
  made public again. Omit the flag to leave the field untouched.
- **The `*_url` values are templates stored verbatim** (`{branch}`, `{sha}`,
  `{base}...{head}`, `{number}`). PingCode substitutes them when it renders a link; the CLI
  never does. **Quote them** in a shell, or the braces may be eaten.

### Branches — `scm branch`

```bash
pingcode scm branch list --platform Github --repo acme/pingcode-cli --json
pingcode scm branch list --platform Github --repo acme/pingcode-cli --name feature/PLM-001 --json
pingcode scm branch list --platform Github --repo acme/pingcode-cli --work-item-id 5edca524cad2fa112b06105c --json

pingcode scm branch get feature/PLM-001 --platform Github --repo acme/pingcode-cli --json

pingcode scm branch create --platform Github --repo acme/pingcode-cli \
  --name feature/PLM-001-login --sender octocat --work-item PLM-001 --json

pingcode scm branch update feature/PLM-001-login --platform Github --repo acme/pingcode-cli \
  --work-item PLM-001 --work-item PLM-002 --json
pingcode scm branch update feature/PLM-001-login --platform Github --repo acme/pingcode-cli --default --json

pingcode scm branch delete feature/PLM-001-login --platform Github --repo acme/pingcode-cli --yes --json
```

Rules that will bite otherwise:

- **`--sender` creates the git identity if it does not exist**, exactly like `repo
  --owner-name`. An unknown username is not rejected — a platform user is made for it, and
  **nothing in this API can delete a platform user**. Create it deliberately first
  (`scm platform-user create`) and check the spelling.
- **`--default` is a switch, and there is no `--default false`.** On a patch the server
  accepts *only* `true` — the field is really the action "make this the default". It also
  **clears the flag on whichever branch currently holds it**, so one call changes two
  branches. (Contrast `scm repo --private true|false`, which is genuinely three-state.)
- **The first branch in an empty repository becomes the default automatically**, even
  though you did not ask.
- **`--work-item` takes an identifier (`PLM-001`), not an id — and an unknown one is
  silently ignored.** The API returns 200 either way. The CLI compares what came back
  against what you asked for and prints a `warning:` on stderr naming the identifiers that
  did not link; the exit code stays 0, and under `--json` the authoritative answer is the
  `work_items` array on stdout. **Read it.**
- **`--work-item` REPLACES the link set on update**, it does not add to it. Pass every
  identifier you want to keep. There is no "clear" flag — repeat the command with the
  links you want.
- **`--name` is a real filter here** (exact, case-insensitive), unlike on `repo list`.
  Branch names are unique per repository, which is also why `scm branch get <name>` works
  in one request and needs no `resolve` kind.

### Deleting a branch — the one destructive command in scm

```bash
# refuses without --yes, and names the branch it would delete
pingcode scm branch delete feature/old --platform Github --repo acme/pingcode-cli
pingcode scm branch delete feature/old --platform Github --repo acme/pingcode-cli --yes --dry-run --json
pingcode scm branch delete feature/old --platform Github --repo acme/pingcode-cli --yes --json
```

**This is the only `DELETE` in the whole scm module** — 代码分支 is the one family shaped with
a `DELETE` and no `PUT`; the other five are the reverse. Three things to know before you
run it:

- **`--yes` is mandatory** and the refusal echoes the *resolved branch name*, not just what
  you typed. There is deliberately **no `--all`**: bulk branch deletion is not offered.
- **The default branch cannot be deleted at all** (exit 7, `默认分支不能被删除`). Make another
  branch the default first. A repository whose only branch is the default therefore has no
  deletable branch.
- **Deleting a branch orphans its commit refs, permanently.** The refs keep resolving by
  id, but `scm ref list --branch-id <the deleted branch>` then fails with a server error
  (HTTP 500), and **refs have no delete**, so the broken state cannot be cleaned up. Delete
  a branch only when you are sure nothing references it.

### Commits — `scm commit`

```bash
# by SHA — this is the point of the family: a pipeline has a SHA, not a PingCode id
pingcode scm commit get 96a024347146ebdc5f481f45e6e6871e0c43af5f --json
pingcode scm commit get 5e3bb2128cfda459bbafa3fb --json

pingcode scm commit list --sha 96a024347146ebdc5f481f45e6e6871e0c43af5f --json
pingcode scm commit list --work-item-id 5edca524cad2fa112b06105c --json

pingcode scm commit create --sha 96a024347146ebdc5f481f45e6e6871e0c43af5f \
  --message "feat(auth): #PLM-001 add login" --committer octocat \
  --committed-at 2026-08-03T09:00:00Z \
  --added src/login.ts --modified README.md --removed src/old.ts \
  --work-item PLM-001 --json
```

- **These leaves take no `--platform` and no `--repo`.** A commit is an
  organisation-level record; that is the API's shape, not an omission. Consequently
  `commit list` with no filter **scans every commit in the organisation** — always pass
  `--sha` or `--work-item-id`.
- **`get` accepts a full 40-character SHA or a PingCode id.** An **abbreviated SHA does not
  work** (the server answers "resource path error", exit 5), even though every git tool
  accepts one. Pass the full hash.
- **`--sha` is the one value this API validates for you**: a malformed SHA is exit 7 on
  create, not a silent acceptance.
- **`--committer` does NOT create an identity.** This is the opposite of branch `--sender`:
  the commit stores the name as a plain string and no platform user is made, so a typo
  leaves the commit attributed to nobody rather than creating a ghost row. Fix it by
  recreating the commit — but note a duplicate SHA is rejected, so the wrong one persists.
- **`--added` / `--removed` / `--modified` are repeatable** and all three are sent even when
  empty. `file_changed_count` is computed by the server.
- There is **no `update` and no `delete`** for a commit.

### Commit refs — `scm ref`

A ref is the record that says *this commit is on this branch*. Create the commit first.

```bash
pingcode scm ref create --platform Github --repo acme/pingcode-cli \
  --sha 96a024347146ebdc5f481f45e6e6871e0c43af5f --branch-id 564587fe700d43b81b080767 --json

pingcode scm ref list --platform Github --repo acme/pingcode-cli --branch-id 564587fe700d43b81b080767 --json
pingcode scm ref get 5e451b7dd704c212f7de8b4f --platform Github --repo acme/pingcode-cli --json
```

- **`--branch-id` is required on `list`, and it takes an id, not a name.** The API's list
  requires the referenced entity, so **there is no way to list every ref in a repository**
  — you enumerate one branch at a time. Get the id from `scm branch list --json`.
- **`--sha` must name a commit that already exists** in PingCode, or you get exit 5
  (`'commit'资源不存在`). Order: `scm commit create` → `scm ref create`.
- Only branches can be referenced; the CLI sends `meta_type=branch` for you.
- There is **no `update` and no `delete`**, and a ref outlives the branch it points at (see
  the branch delete warning above).

### Name → id

```bash
pingcode resolve scm-platform Github --json
pingcode resolve scm-repo pingcode-cli --parent 68393e8b47512a5d5d4e5b55 --json
```

Both are cached for 24 h under `~/.pingcode/cache/`; pass `--no-cache` when a platform was
reconfigured. `--platform <name|id>` resolves by name; `--platform-id <id>` is sent verbatim
with no lookup, and the two are mutually exclusive (exit 2).

### What cannot be deleted, and why nothing is `replace`d

**`scm branch delete` is the only delete in this module.** For everything else — platforms,
git identities, repositories, commits and refs — **no DELETE exists upstream**. Nothing you
create there can ever be removed through the API, so mark test data clearly and check
spellings before you write. `--owner-name` and branch `--sender` are the two flags that can
create a row by accident.

**`PUT` is deliberately not offered anywhere.** Five scm families document a `PUT` that
replaces the whole record and blanks every field you did not send, and this API never
documents what clearing a field does. Use `update` (PATCH). If you truly want a full
replacement, ask for it explicitly through the escape hatch:

```bash
pingcode api PUT /v1/scm/products/68393e8b47512a5d5d4e5b55 \
  --set name=Github --set type=github
```

See [`api.md`](api.md).

⚠️ **代码分支 has no `PUT` upstream at all** — its fifth verb is `DELETE`, which is why
`scm branch delete` exists while its siblings have none. So there is nothing missing to
"complete": do not add a `scm branch replace`, and do not expect `scm platform delete` to
appear. Pull requests and code reviews are the remaining unrefined families and stay
reachable through `pingcode api` for now.

### Errors you should expect

| Situation | Exit |
|---|---|
| `--platform` missing, or given together with `--platform-id` | 2 |
| a name matches nothing, or matches two repositories | 2 |
| `update` with no field to change | 2 |
| `--private maybe` | 2 |
| the token lacks `pcp:*:devops:code` | 4 |
| a platform / repository / identity / branch / commit / ref id does not exist | 5 |
| `scm ref create` names a `--sha` or `--branch-id` that does not exist | 5 |
| an abbreviated SHA passed to `scm commit get` | 5 |
| `--branch-id` missing on `scm ref list` | 2 |
| `scm branch delete` without `--yes` | 2 |
| deleting the **default** branch | 7 |
| a `--type` outside the enum, or a duplicate name / SHA / ref | 7 |
| `scm ref list` for a branch that was deleted (server error) | 7 |
