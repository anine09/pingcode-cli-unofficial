# Implementation Plan — PingCode CLI (TypeScript) + `pingcode` skill

> Requirements: [`prd.md`](./prd.md) · Design: [`design.md`](./design.md) · API facts: [`research/pingcode-api.md`](./research/pingcode-api.md)

**Status of this plan:** revised to match `design.md` **rev 2** (post-architecture-review). The cuts in
design §1.1 are reflected here: no `doctor` command, no `work-item search`, no `skill install`
subcommand, no vendored spec / `check-spec` script, no `oauthBase`.

---

## Ground rules

- Every slice ends **green**: `npm run typecheck && npm test` pass before the next slice starts.
- `git init` + a commit happens in S1 so every later slice has a revert point (`git reset --hard`).
- No secrets in tracked files, ever. Real credentials live only in `~/.pingcode/` or the shell env.
- Layering rule from design §2: **`cli → {api, core}`, `api → core`, `core` imports neither**;
  `api/` never formats output, `cli/` never builds URLs or reads config files directly.
- API facts come from `research/pingcode-api.md`. If reality disagrees during S8, **update the research
  doc and `design.md`** rather than patching a call site silently.

---

## Slice order

### S1 — Scaffold `[foundation]`
- `git init`; `.gitignore` (`node_modules`, `dist`, `.env*`, `*.log`, `coverage`).
- `package.json`: ESM (`"type":"module"`), Node ≥ 20 engine, `bin: {"pingcode": "dist/bin/pingcode.js"}`,
  scripts `build` / `dev` / `typecheck` / `test` / `skill:install`.
- Runtime deps: **`commander`**, **`picocolors`** only. Dev: `typescript`, `vitest`, `@types/node`, `tsup`.
- `tsconfig.json` strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `moduleResolution: bundler`), `README.md` stub.
- `src/bin/pingcode.ts` + `src/cli/program.ts` printing `--help` and `--version` and nothing else.
  Wire `commander`'s `exitOverride` → exit **2** for its own usage errors; do **not** bind `-v`.
- **Validation:** `npm run build && node dist/bin/pingcode.js --help` prints usage; `--version` prints the version.
- **Gate G1:** dependency list is final here — adding a runtime dep later needs a stated reason.

### S2 — Errors + output + config `[core, no network]`
- `core/errors.ts`: the 8-way error hierarchy, **`DryRunHalt`**, and `exitCodeFor()` exactly per design §5.2.
- `cli/output.ts`: stdout-pure-JSON contract, stderr for logs/warnings, table renderer,
  unix-seconds → local formatting, truncation, **TTY/`NO_COLOR` awareness** (design §7.3),
  and the `redactUrl()` / header-redaction helpers (design §5.0).
- `core/config.ts`: `Config` shape **without `grantType`/`refreshToken`/`oauthBase`**, flag→env→file
  precedence, `host → apiBase` derivation (cloud vs `<domain>/open`), atomic write-temp-then-rename at
  `0600` in a `0700` dir via `os.homedir()`, `PINGCODE_CONFIG_DIR` override, **loose-mode warning on
  read**, **merge-only-owned-fields on save** for cross-process safety, and `--save`-gated secret
  persistence (design §3, D6).
- `src/bin/pingcode.ts` maps every thrown error to its exit code and catches `DryRunHalt` → render, exit 0.
- **Tests:** error→exit mapping; `apiBase` derivation for cloud + self-hosted + explicit override;
  precedence order; config file mode is `0600` (**skip on `win32`**); redaction leaves no secret
  substring **including in query strings**; `--json` stdout stays pure on the error path.
- **Validation:** `npm run typecheck && npm test`.

### S3 — Auth `[core, network]`
- `core/auth.ts`: `acquireToken` via **`GET {apiBase}/v1/auth/token?grant_type=client_credentials&…`**
  — under the **REST root**, GET + query string, *not* POST+form and *not* `/oauth2` (design §4).
- `normalizeExpiry` per design §4.1: dual-shape + **past-timestamp clamp to now+30d with a one-time
  warning** + `NaN`/missing guard, returning `{at, clamped}`.
- `ensureFreshToken` with the 120 s proactive window, single in-flight promise to prevent stampede,
  one-shot reactive re-auth contract; `clearToken`.
- **Tests (highest value in the project):** `normalizeExpiry` for absolute-timestamp input, duration
  input, **already-past absolute input → clamped**, zero/negative, missing/`NaN`; proactive refresh
  boundary; concurrent `ensureFreshToken` calls trigger exactly **one** token request.
- **Gate G2:** do not proceed until `normalizeExpiry` tests cover both `expires_in` interpretations
  **and** the past-timestamp clamp.

### S4 — Transport `[core, network]`
- `core/http.ts` `request<T>()` with the design §5 responsibility order: URL/query building
  (drop nullish, CSV arrays) → auth injection → **dry-run gate that throws `DryRunHalt`** →
  injected `fetch` → `429` honouring `x-pc-retry-after` (capped 60 s, one retry) and **failing fast
  when the header is absent** → one-shot `401` re-auth replay → **any 2xx is success** → status-first
  error mapping with the string `code` preserved → JSON parse with `TransportError` on garbage.
- All printing paths (verbose, dry-run plan, error snippets) go through `redactUrl()`.
- `core/paginate.ts`: `paginate()` only (no `searchPaginate` — design §1.1): 0-based `page_index`,
  `page_size` ≤ 100, **dedupe by `id`**, stop on a short page, and **bail when the echoed
  `page_index` ≠ requested**.
- **Tests:** dry-run throws and sends **zero** requests for mutating verbs but still allows reads;
  `401` re-auths once then replays, and a second `401` becomes `AuthError` **without recursion**;
  `429` honours the header and fails fast without it; unknown error `code` surfaces verbatim; a `201`
  is treated as success; pagination walks 0-based pages, caps `page_size`, dedupes, `--all` stops at
  `--limit`, and a mismatched echoed `page_index` aborts the walk.
- **Validation:** `npm run typecheck && npm test`.
- **Gate G3:** dry-run provably sends nothing; `401` replay cannot recurse; no secret reachable in output.

### S5 — Typed API wrappers `[api]`
- `types/api.ts`: envelope + MVP resource types hand-written from research §4 / §4.2. Normalize
  `is_archived`/`is_deleted` `0/1` → boolean and the `versions` array vs `version` object
  inconsistency **once**, in the parse helpers. Timestamps stay raw unix seconds.
- `api/projects.ts`, `api/workItems.ts`, `api/meta.ts` (work-item types/states/priorities + sprints +
  `/v1/directory/users`) — thin, no formatting, no config reads.
- **Validation:** `npm run typecheck && npm test`. There is no spec-conformance script by design (D5);
  the endpoint contract is proven in S8.

### S6 — Metadata resolution `[core]`
- `core/metadata.ts`: resolvers for project / type / state / priority / user / sprint.
  **Ids pass through untouched** — never shape-validate, because ids are 24-hex, 32-hex (users),
  or bare slugs (`epic`, `story`, `bug`).
- Name resolution is `keywords` → **case-insensitive exact `name` match** → require exactly one;
  zero or many → `UsageError` listing candidates (design §6).
- **`--state <name>` requires a type**: resolving states needs `project_id` **and**
  `work_item_type_id`, so a name-form `--state` without `--type` is a `UsageError`.
- On-disk cache keyed by **`(apiBase, clientId, projectId, kind)`**, **24 h TTL**, `--no-cache` bypass,
  cleared by `auth login` *and* `auth logout`, with **invalidate-and-retry-once** when a cache-resolved
  id is rejected by a write (message names the cache and suggests `--no-cache`).
- Work-item argument accepts `id` / `short_id` / **`identifier` (`SCR-5`, via `?identifier=`)** /
  pasted `html_url`; mutating commands resolve to a real `id` with one `GET` first.
- **Tests:** pass-through for all three id shapes; exact-name-over-fuzzy-keywords resolution;
  ambiguous-name error; `--state` without `--type` → exit 2; TTL expiry; cache bypass;
  invalidate-on-rejection retries exactly once.

### S7 — Commands + skill `[cli]` — parallelizable
Two independent lanes once S1–S6 are green (they share no files):

- **Lane A — auth & project & meta commands:** `cli/commands/auth.ts` (login with TTY prompt fallback,
  `--save`-gated persistence, **capability-call verification via `GET /v1/pjm/projects?page_size=1`**
  instead of `/v1/myself`, cache clear on login; `status [--check]` with masked `client_id`; `logout`),
  `project.ts` (list/get), `meta.ts` (types/states/priorities/sprints/users).
- **Lane B — work-item commands:** `cli/commands/workItem.ts` (list/get/create/update/transition — **no
  `search`**). `transition` shares one code path with `update --state` and, on rejection, prints the
  server message **plus** the candidate states (design §7.1). Enforce update semantics from design §7.2:
  provided fields only, no clearing, **empty patch → `UsageError` (exit 2)**, arrays/`properties`
  documented as replacing.

Then, after both land:
- **Lane C — the skill:** `skills/pingcode/SKILL.md` (single file, frontmatter with trigger phrases +
  anti-triggers, auth gate first, then command catalog, then agent rules including the org-admin-token
  caveat, the 200/min budget, project-scoped ids, and array-replace semantics) plus
  `scripts/install-skill.ts` wired to `npm run skill:install` (targets `~/.claude/skills/pingcode/` and
  `.opencode/skills/pingcode/`, refuses overwrite without `--force`).
- **Validation:** `pingcode --help` shows all groups; every subcommand's `--help` renders;
  `--help` **snapshot tests** pass; every `pingcode <group> <sub>` command path in `SKILL.md` resolves
  in the `commander` tree; `npm run typecheck && npm test` green.
- **Gate G4:** `--help` snapshots + `SKILL.md` command-path check green.

### S8 — Real-API smoke `[validation, needs the user's credentials]`
Run against the user's real PingCode instance, in order, recording actual output:

1. `pingcode auth login --client-id … --client-secret … --save` → succeeds (AC2)
2. `pingcode auth status --check` → authenticated, live call OK, secret and full token **not** present (AC2, AC3)
3. `ls -l ~/.pingcode/config.json` → `-rw-------` (AC3)
4. `pingcode project list --json | jq .` → real projects, valid JSON only on stdout (AC5, AC6)
5. `pingcode meta types --project <p>` then `meta states --project <p> --type <t>` → ids resolve (AC6)
6. `pingcode work-item list --project <p> --page-size 5 --json` → filtered + paginated (AC6)
7. `pingcode work-item get <identifier|short_id|url>` → single item, all three forms (AC6)
8. `pingcode work-item create --project <p> --type task --title "…" --dry-run --json`
   → **plan on stdout as `{"dry_run":true,…}`**, exit 0, **writes nothing** (AC7)
9. same without `--dry-run` → created (AC7)
10. `pingcode work-item update <id> --state <name>` → state changes; also verify an empty patch → exit 2 (AC7)
11. Negative paths: bad secret → exit 3; nonexistent id → exit 5; missing required flag → exit 2 (AC8)
12. Corrupt the cached token by hand, re-run a read command → transparently re-acquires (AC4)
13. `--verbose` on the login path → confirm **no `client_secret`** appears anywhere in output (AC3/AC11)

- **Gate G5 — three doc gaps must be settled here, not guessed:**
  1. do `page_index`/`page_size` really work on `GET` list endpoints? They are **undocumented** there
     *(research §6.20)*. If ignored, `--all`/`--page` behaviour and both docs must be revised.
  2. what is the real `expires_in` shape (duration or absolute)? Simplify `normalizeExpiry` commentary
     accordingly — but keep both branches.
  3. does a **second** `client_credentials` acquisition invalidate the first token? If it rotates,
     parallel invocations can 401 each other and the skill must document it.
- Record results in the task journal; any API-fact surprise updates `research/pingcode-api.md`.

### S9 — Finish
- `npm run typecheck && npm test` full-scope green.
- Full-scope quality check (Trellis 2.2), including a grep for secret-shaped strings in tracked files (AC11).
- `README.md`: install, auth, command examples, self-hosted `--host`, the org-admin-token caveat,
  `--all` is best-effort, and the documented follow-ups (keychain, codegen, `state_flows` pre-validation,
  `POST /search`).
- Populate `.trellis/spec/` with the conventions this task established (Trellis 3.3), then commit (3.4).

---

## Dependency graph

```
S1 → S2 → S3 → S4 → S5 → S6 → S7{Lane A ∥ Lane B} → S7 Lane C → S8 → S9
```

S3 depends on S2 (config/errors). S4 depends on S3 (token injection). S5–S6 depend on S4 (transport).
S7 lanes are file-disjoint and may run in parallel. S8 requires the user's credentials and cannot be
faked. **S9 must not start before S8 passes** — AC5/AC6/AC7 are only provable against the live API.

## Review gates

| Gate | When | What must be true |
|---|---|---|
| G1 | end of S1 | runtime dependency list frozen (`commander`, `picocolors`) |
| G2 | end of S3 | `normalizeExpiry` tested against **both** `expires_in` interpretations **and** the past-timestamp clamp |
| G3 | end of S4 | dry-run provably sends nothing; `401` replay cannot recurse; no secret reachable in any printed URL |
| G4 | end of S7 | `--help` snapshots + every `SKILL.md` command path exists in the CLI |
| G5 | end of S8 | every live-API acceptance criterion observed **and** the three doc gaps above settled, with output recorded |

## Rollback points

Greenfield, no consumers. Each slice is a separate commit; rollback is `git reset --hard <slice>`.
The only external side effects are (a) files under `~/.pingcode/`, removable via `pingcode auth logout`,
and (b) work items created during S8, which must be deleted or clearly marked as CLI test artifacts
in the user's PingCode instance.
