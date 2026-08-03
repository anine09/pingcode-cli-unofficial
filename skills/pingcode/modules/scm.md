# 源码管理 (scm) — `scm`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the scm command surface and the ids it needs.

**What this module is for.** It is the *write-back* API a CI system uses: you tell PingCode
which hosting platform, git identities, repositories (and later branches, commits, pull
requests) exist, and PingCode links them to work items. It does **not** read your git
server — nothing here clones, pushes or inspects a repository. Every row you create is a
record inside PingCode.

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

### Name → id

```bash
pingcode resolve scm-platform Github --json
pingcode resolve scm-repo pingcode-cli --parent 68393e8b47512a5d5d4e5b55 --json
```

Both are cached for 24 h under `~/.pingcode/cache/`; pass `--no-cache` when a platform was
reconfigured. `--platform <name|id>` resolves by name; `--platform-id <id>` is sent verbatim
with no lookup, and the two are mutually exclusive (exit 2).

### There is no `delete`, and no `replace`

- **No DELETE exists upstream** for platforms, identities or repositories. Nothing you create
  here can be removed through the API — mark test data clearly.
- **`PUT` is deliberately not offered.** All three families document a `PUT` that replaces the
  whole record and blanks every field you did not send, and this API never documents what
  clearing a field does. Use `update` (PATCH). If you truly want a full replacement, ask for it
  explicitly through the escape hatch:

  ```bash
  pingcode api PUT /v1/scm/products/68393e8b47512a5d5d4e5b55 \
    --set name=Github --set type=github
  ```

  See [`api.md`](api.md). The same applies to the endpoints S1a does not refine yet — branches,
  commits, refs, pull requests and code reviews are all reachable through `pingcode api` today.

### Errors you should expect

| Situation | Exit |
|---|---|
| `--platform` missing, or given together with `--platform-id` | 2 |
| a name matches nothing, or matches two repositories | 2 |
| `update` with no field to change | 2 |
| `--private maybe` | 2 |
| the token lacks `pcp:*:devops:code` | 4 |
| a platform / repository / identity id does not exist | 5 |
| a `--type` outside the enum, or a duplicate name | 7 |
