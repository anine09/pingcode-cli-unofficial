# pingcode-cli

A command-line client for the [PingCode Open API](https://open.pingcode.com/), plus a single
`pingcode` skill that teaches AI agents how to drive it.

Scope: **projects, work items, and the project-scoped metadata you need to write one.** Testhub,
Wiki, Ship, Flow, Insight and the org chart (beyond a member lookup) are deliberately not covered.

---

## Install

Requires **Node.js >= 20**. The package is not published; build it from a checkout.

```bash
npm install
npm run build            # → dist/bin/pingcode.js
node dist/bin/pingcode.js --help
```

To get `pingcode` on your `PATH`:

```bash
npm link                 # then just: pingcode --help
```

Development commands:

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest run — no network, ever
npm run dev              # tsup --watch
npm run skill:install    # copy skills/pingcode/SKILL.md to the agent skill dirs
```

---

## Get credentials

The CLI authenticates as an **application**, not as a user, using the OAuth
`client_credentials` grant.

1. In the PingCode enterprise console open **后台管理 (企业后台) → 凭据管理** ("Credential
   Management") and create an application.
2. Set 鉴权方式 (grant type) to **Client Credentials**.
3. Grant these scopes — the first four are required by the MVP command surface:

   | Scope | Needed for |
   |---|---|
   | `pcp:read:pjm:project` | `project list` / `project get`, and every project-name lookup |
   | `pcp:read:pjm:workitem` | `work-item list` / `get`, `meta types` / `states` / `priorities` |
   | `pcp:write:pjm:workitem` | `work-item create` / `update` / `transition` |
   | `pcp:read:global:team` | `meta users` |
   | `pcp:read:pjm:sprint` | optional — only `meta sprints` |

4. Copy the `client_id` and `client_secret`.

> **A `client_credentials` token carries organisation-wide system-administrator authority** and is
> not tied to any user. Treat it, and `~/.pingcode/config.json`, as a secret.

## Log in

```bash
# public cloud (default host: https://open.pingcode.com)
pingcode auth login --client-id <id> --client-secret <secret> --save

# self-hosted: pass your instance host, the API is served from <host>/open
pingcode auth login --host https://pingcode.example.com \
  --client-id <id> --client-secret <secret> --save

pingcode auth status --check     # adds one live call: GET /v1/pjm/projects?page_size=1
pingcode auth logout             # drops the token, the credentials and the metadata cache
```

Credentials resolve in this precedence order: **CLI flags → environment
(`PINGCODE_CLIENT_ID`, `PINGCODE_CLIENT_SECRET`, `PINGCODE_HOST`) → `~/.pingcode/config.json`**.
With a TTY attached, `auth login` prompts for anything missing.

- `--save` is what persists the client id/secret. Without it only the token is stored, so you must
  log in again when it expires.
- Storage is `~/.pingcode/config.json`, mode `0600` inside a `0700` directory (a no-op on Windows).
  `PINGCODE_CONFIG_DIR` relocates it.
- Tokens are valid ~30 days and are re-acquired **transparently**: proactively 120 s before expiry,
  and reactively once on a `401`, replaying the original request. You never have to re-run `login`
  while the credentials are stored.
- Repeated logins do **not** invalidate previously issued tokens, so parallel invocations are safe.

---

## Command surface

```
pingcode auth      login | status | logout
pingcode project   list | get <project>
pingcode work-item list | get <ref> | create | update <ref> | transition <ref>
pingcode meta      types | states | priorities | sprints | users
```

Global flags — valid **before or after** the subcommand: `--host <url>`, `--json`, `--dry-run`,
`--no-cache`, `--verbose`, `--version`, `--help`. `--help` works at every level
(`pingcode work-item update --help`).

```bash
pingcode project list --json
pingcode project get "Mobile App" --json

# metadata first — ids are project-scoped
pingcode meta types      --project "Mobile App" --json
pingcode meta states     --project "Mobile App" --type task --json
pingcode meta priorities --project "Mobile App" --json
pingcode meta users      --keywords wang --json

pingcode work-item list --project "Mobile App" --type task --state "In Progress" --json
pingcode work-item list --project "Mobile App" --all --limit 200 --json
pingcode work-item get SCR-5 --json          # also: id, short_id, or a pasted work-item URL

pingcode work-item create --project "Mobile App" --type task --title "Fix login retry" --dry-run --json
pingcode work-item create --project "Mobile App" --type task --title "Fix login retry" \
  --assignee wangxiao --priority High --end-at 2026-02-15 --json

pingcode work-item update SCR-5 --title "Fix login retry (v2)" --json
pingcode work-item transition SCR-5 --type task --state Done --json
pingcode work-item transition SCR-5 --state-id 5eb623f6a70571487ea47000 --json
```

`--dry-run` on a mutating command prints the request it *would* have sent and exits 0 without
sending it. Read requests still run, so ids are genuinely resolved first.

---

## The `--json` contract

- **stdout carries JSON only.** Tables, logs, warnings, dry-run notes and errors go to stderr.
- Timestamps stay raw **unix seconds** in `--json`; human mode renders local time.
- Three list shapes, by command family:
  - one page of `project list` / `work-item list` → `{"page_index":0,"page_size":30,"total":123,"values":[…]}`
  - any list with `--all` → `{"values":[…],"count":42,"all":true}`
  - every `pingcode meta …` lookup → `{"values":[…],"count":20}`
- Single-resource commands (`get`, `create`, `update`, `transition`) print the resource object.
- `--dry-run` prints `{"dry_run":true,"request":{"method":…,"url":…,"headers":…,"body":…}}` — with
  `Authorization` and any `client_secret` masked.
- Errors print to **stderr** as `{"error":{"kind":…,"message":…,"code":…,"exit":…}}`.

### Exit codes

| Exit | Kind | Meaning |
|---|---|---|
| 0 | — | success, including a printed dry-run plan |
| 1 | `unexpected` | unhandled internal error |
| 2 | `usage` | bad/missing flags, ambiguous or unresolvable name, empty update |
| 3 | `auth` | no or invalid credentials |
| 4 | `permission` | 403, or a scope the app was never granted |
| 5 | `not_found` | the work item, state or other resource does not exist |
| 6 | `rate_limit` | 429 — the limit is 200 requests/minute per token |
| 7 | `api` | any other non-2xx, carrying the API's `{code, message}` |
| 8 | `transport` | DNS / TCP / TLS / timeout / unparseable body |

This API answers **HTTP 400 where REST convention would use 401 or 404**, so three observed API
`code` values are mapped by code rather than by status (`src/core/wire.ts`):

| API `code` | HTTP | Observed on | → exit |
|---|---|---|---|
| `100024` | 400 | `GET /v1/auth/token` with a wrong client id/secret | 3 (`auth`) |
| `100317` | 400 | `GET /v1/pjm/work_items/{unknown id}` | 5 (`not_found`) |
| `100303` | 400 | `PATCH` with an unknown `state_id` | 5 (`not_found`) |

Any other code keeps the status-first mapping and is surfaced verbatim on exit 7 — read `code`
before drawing conclusions. (An invalid *bearer* token on a resource endpoint does return a real
401, so the 401 branch is still live.)

---

## Caveats that matter in practice

- **Ids are project-scoped — run `pingcode meta …` first.** The same state name has a different id
  in another project. System work-item types are bare slugs (`task`, `story`, `bug`); custom types,
  states and priorities are 24-hex ids; users are 32-hex. Never reuse an id across projects.
- **`--state <name>` always needs `--type`.** States live in a `(project, work item type)` pair and
  the API never reports a work item's type, so the CLI cannot infer it — not on `list`, and not on
  `update`/`transition` (`create` already requires `--type`). Pass `--type <name|id>`, or skip the
  lookup with `--state-id <id>`. On `update`/`transition`, `--type` is *only* a lookup aid: it is
  never written to the work item. `--state` and `--state-id` are mutually exclusive.
- **`update` replaces, it does not merge.** Every field you pass overwrites the stored value, and
  arrays plus `properties` objects are replaced wholesale. Read the item first if you need to keep
  anything. There is no way to clear a field, and an update with no fields is exit 2, not a no-op.
- **State changes are workflow-validated server-side.** On rejection the CLI prints the server
  message plus the states configured for that type — but only if you passed `--type`.
- **`--all` is best effort, not a snapshot.** It walks 0-based pages (`page_size` ≤ 100),
  de-duplicates by id, stops at `--limit` (default 500) and bails if the server stops honouring
  `page_index`. **No endpoint supports sorting**, so offset paging over changing data can duplicate
  or skip rows. Sort what you collected yourself.
- **Rate limit: 200 requests/minute per token.** 2xx responses carry no rate-limit headers, so the
  budget is invisible until a 429 arrives. Prefer one `--page-size 100` call over many small ones,
  and let the cache work.
- **Timestamps are unix seconds everywhere.** `--start-at` / `--end-at` accept `1730000000` or
  `2026-01-31` (parsed as UTC midnight).
- **Metadata is cached for 24 h** under `~/.pingcode/cache/` (mode `0600`, hashed filenames), keyed
  by `(apiBase, clientId, projectId, kind)`. Pass `--no-cache` if a project was reconfigured and an
  id looks stale; a write rejected on a cached id invalidates that entry and retries once.
  `auth login` and `auth logout` both clear the cache.

---

## The `pingcode` skill

`skills/pingcode/SKILL.md` is the source of truth for the agent-facing docs, and `test/help.test.ts`
asserts that every command path it mentions exists in the CLI. Sync it to your agent skill
directories:

```bash
npm run skill:install -- --dry-run   # show the destinations, write nothing
npm run skill:install                # → ~/.claude/skills/pingcode/ and ./.opencode/skills/pingcode/
npm run skill:install -- --force     # overwrite existing copies
```

---

## Security notes

- Credentials and token live in `~/.pingcode/config.json` (mode `0600`), never in the repository.
- The `client_secret` travels in the **URL query string** on the token endpoint, so every printable
  URL — `--verbose` logs, dry-run plans, error messages, body snippets — goes through `redactUrl()`.
  `Authorization` headers and `access_token` / `client_secret` JSON values are masked too.
- `--verbose` prints request URLs with the full `client_id` visible, while `auth status` shows it
  masked (`abcd…wxyz`). That asymmetry is intentional: the `client_id` is an identifier, not a
  secret — only the `client_secret` and the access token are, and both are redacted everywhere.

---

## Known limitations / follow-ups

Deliberately out of the MVP, recorded rather than forgotten:

- **Keychain storage.** Credentials sit in a `0600` file; an OS keychain (Keychain Access,
  libsecret, DPAPI) would be stronger.
- **Codegen from `api_data.json`.** PingCode publishes no OpenAPI spec, but its apiDoc source at
  `https://open.pingcode.com/api_data.json` describes 460 endpoints. The MVP hand-writes types for
  its ~15; generating them would remove the drift risk.
- **`state_flows` pre-validation.** Illegal transitions are only caught by the server. Reading the
  type's state flow up front would let the CLI reject them locally with better messages.
- **`POST /v1/pjm/work_items/search`.** The advanced filter/search endpoint is unused, so complex
  queries (multi-value filters, keyword scoring) are not expressible.
- **Bulk `PATCH /v1/pjm/work_items`.** One-field-across-≤100-items updates are not wired up.
- **Self-hosted `--host` verification.** The `<host>/open` derivation is unit-tested only; it has
  never been exercised against a real self-hosted instance.
- **429 and 403 paths are unit-tested only.** Provoking a real 429 means ~200 requests/minute
  against a production org, and the MVP token is org-admin-scoped so nothing denied it with a 403.

Requirements, design and the live-API findings live in
`.trellis/tasks/07-31-pingcode-cli-mvp/` (`prd.md`, `design.md`, `research/pingcode-api.md`,
`research/s8-smoke.md`).
