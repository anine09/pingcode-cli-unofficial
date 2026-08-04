# 通用逃生舱 (the generic executor) — `api`

> Part of the `pingcode` skill. Read [`../SKILL.md`](../SKILL.md) first — it carries the
> authentication gate, the stdout/stderr contract, the exit-code table and the rules that
> apply to every module. This file is only the generic executor and its discovery commands.

`pingcode api` calls **any** of the 459 documented `/v1` endpoints directly. Use it whenever the
refined command groups do not cover what you need — that is most of the API, and it is not a
second-class path: the request goes through the same transport, the same auth, the same
`--dry-run` gate and the same exit codes as every other command.

What it deliberately does **not** do: no name→id resolution, no response shaping, no
per-endpoint flags. Ids go in as ids, JSON comes out as JSON.

## 1. The two rules that surprise people

1. **stdout is always the API's raw JSON, so `--json` is a no-op on the five verbs.** There is no
   table, no localised time, no column clipping — nothing to switch off. (`api list` and
   `api describe` are local catalog views and *do* honour `--json`.)
2. **`DELETE` requires `--yes`.** Without it: exit 2, nothing sent, and the message shows what
   would have been sent. `pingcode api list --method DELETE` enumerates all 49 deletable
   endpoints; two of them have no recovery path at all — a wiki page and a code branch.

## 2. Find the endpoint first

```bash
pingcode api list --search commit           # substring over path, title and group
pingcode api list --module scm              # 36 endpoints
pingcode api list --token ENT               # 61 endpoints only a machine identity may call
pingcode api list --method DELETE           # the auditable danger surface, 49 rows
pingcode api describe scm.commits.get       # every documented field, scope, token, paging
pingcode api describe GET /v1/scm/commits/{commit_id_or_sha}
```

Both are **local**: they read a bundled catalog and never make a request. Prefer them over
guessing a path, and prefer them over the documentation site (which is a client-rendered SPA
whose per-endpoint anchors are ~200 characters of percent-encoding).

`api describe` also prints the warnings that matter for that one endpoint: that a `PUT` is a
full replacement, that a `DELETE` is irreversible, that an endpoint needs a user token, or that
the docs declare no scope for it.

## 3. Call it

```bash
pingcode api GET    /v1/scm/commits/9f3c1ab
pingcode api GET    /v1/relations --query principal_type=work_item --query principal_id=<id>
pingcode api GET    /v1/directory/users --page 2 --page-size 100
pingcode api GET    /v1/directory/users --all --limit 200
pingcode api POST   /v1/comments --set principal_type=work_item --set principal_id=<id> --set content="CI #123 failed"
pingcode api PATCH  /v1/build/builds/<id> --set status=success
pingcode api POST   /v1/wiki/pages --body-file page.json
pingcode api POST   /v1/pjm/work_items/search --body '{"mode":"query","payload":{"keywords":"login"}}'
pingcode api DELETE /v1/pjm/projects/<id>/versions/<id> --yes
```

- the path carries **substituted ids**, never `{placeholders}` and never a `?query` — a query
  string in the path is exit 2, because silently dropping it would be worse;
- `--query k=v` is repeatable; repeating a key sends it as CSV, which is this API's convention;
- body: `--set k=v` (repeatable, flat, values sent **verbatim**), `--body-file <path>`,
  `--body '<json>'`, or `--body -` to read stdin. The four are mutually exclusive;
- `--set` values are never type-guessed: a select-typed field wants the option's `_id`, not its
  display text;
- `--set` is **scalar-only**. Its value is sent verbatim as a JSON *string*, so an array or object
  field needs `--body` / `--body-file`. A few fields are genuinely type-checked upstream —
  `--set version_ids='["<id>"]'` on a work item is `100006 'version_ids'不是有效的数组`, exit 7 —
  but do not count on that everywhere: this API's default is to accept a wrong-typed field with 200
  and store nothing;
- paging: `--page` / `--page-size` (max 100) are forwarded **only when you pass them**; `--all`
  walks the pages and prints `{"values":[…],"count":N,"all":true}`. On an endpoint that is not a
  collection, any paging flag is exit 2 rather than silently ignored.

### The five `POST …/search` endpoints

`pjm/work_items`, `ship/ideas`, `ship/tickets`, `testhub/cases`, `testhub/runs`. They are **reads
wearing a mutating verb**, so: they execute even under `--dry-run`, their body is
`{"mode":"query","payload":{…}}` (`mode` has exactly one legal value), and the paging flags are
written into `payload.page_index` / `payload.page_size` for you. stdout is the page envelope.

### `PUT` — prefer `PATCH`

All 10 `PUT` endpoints are reachable **only** here, on purpose. `PUT` replaces the whole object
and this API never documents what an omitted field does; one module was measured clearing a
field that its `PATCH` sibling preserves. Unless you truly mean "replace everything", use
`PATCH`.

## 4. What fails before anything is sent (all exit 2, zero requests)

| Situation | What you get |
|---|---|
| path not in the catalog | the three nearest documented paths ("did you mean …") |
| method the path does not support | the methods that path *does* support |
| a required query/body field missing | the field named, by kind |
| `{placeholder}` or `?query` still in the path | told which one |
| `DELETE` without `--yes` | the request it refused to send |
| paging flags on a non-collection | told that the endpoint does not page |
| `/oauth2/authorize` | told it is the browser authorization page, not a REST endpoint |
| a **user-token-only** endpoint | told this CLI holds an enterprise token |

The seven user-token endpoints — `/v1/myself`, `/v1/permission/my/*` (3) and
`/v1/permission/check/*` (3) — are the only part of the API this CLI cannot reach at all: they
need the OAuth2 authorization-code flow, which is not implemented. Note that
`GET /v1/permission/points` **does** work. Everything else, including all 61 enterprise-token-only
DevOps endpoints, is reachable with the credentials from `pingcode auth login`.

## 5. Everything else behaves exactly as it does elsewhere

`--dry-run` halts every write (search reads excepted, above) and prints the full request plan
with the `Authorization` header and any `client_secret` redacted. A `401` re-acquires the token
and replays once. A `429` honours `x-pc-retry-after` once. Any `2xx` is success. The exit-code
table in [`../SKILL.md`](../SKILL.md) applies unchanged; on a `403` the scope the docs declare
for that endpoint is printed to stderr (or an honest "the docs declare no scope" when they
declare none).

The rate limit is shared with everything else, so a `--all` sweep over a large collection spends
the same budget any other command would.
