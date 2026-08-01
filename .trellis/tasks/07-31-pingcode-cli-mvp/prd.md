# PingCode CLI (TypeScript) + pingcode skill

## Goal

Build a command-line tool (`pingcode`) that wraps the [PingCode Open API](https://open.pingcode.com/),
plus a single AI-agent skill file (`SKILL.md`) that teaches AI agents how to drive that CLI.

The MVP target is a working end-to-end path: **authenticate → list projects → query / read / create / update work items**.
Breadth across other PingCode modules (Testhub, Wiki, org chart, Ship, Flow, Insight) is explicitly out of MVP scope,
but the architecture must not block adding them later.

## Context & Decisions

Decisions confirmed with the user at task creation:

| Topic | Decision |
|---|---|
| Runtime / language | **TypeScript + Node.js** |
| MVP scope | **auth + core work items** (plus the minimum project/user lookups those need) |
| Skill packaging | **A single `pingcode` skill** (one `SKILL.md`, not a family of `pingcode-*` skills) |
| Credentials for validation | User **has** `client_id` / `client_secret` and can provide them for real integration testing |

Project state at kickoff: the repository is effectively empty — only `.trellis/`, `.opencode/`, `.codegraph/`,
`AGENTS.md` exist, and there is no `.git`. This is a greenfield build, so directory layout, tooling,
and conventions are all part of this task.

## Requirements

### R1 — Authentication & credential management

- R1.1 Obtain and cache a PingCode access token from `client_id` / `client_secret` per the official token flow.
- R1.2 Persist credentials and token outside the repo (user config dir, e.g. `~/.pingcode/config.json`), with file permissions `0600`.
- R1.3 Never print secrets or full tokens in output or logs; redact by default.
- R1.4 Accept credentials from, in precedence order: explicit CLI flags → environment variables → stored config file.
- R1.5 Automatically refresh / re-acquire an expired token transparently on API calls, without asking the user to re-login.
- R1.6 Commands: log in / store credentials, show auth status (redacted), log out / clear credentials.

### R2 — Core work-item capabilities

- R2.1 List / query work items with the filters the API supports (at minimum: by project, by type, by state, by assignee, pagination).
- R2.2 Get a single work item's detail by its identifier.
- R2.3 Create a work item (required fields resolved and validated before the request).
- R2.4 Update a work item, including a state transition (e.g. move to done/in-progress) if the API models states separately.
- R2.5 Supporting lookups needed to make the above usable by a human or an agent: list projects, list work-item types/states for a project, resolve users.

### R3 — CLI UX

- R3.1 Consistent verb-based command structure with discoverable `--help` at every level.
- R3.2 Dual output modes: a human-readable default (table/summary) and `--json` for machine/agent consumption. `--json` must emit only valid JSON on stdout.
- R3.3 Errors are actionable: distinguish auth failures, permission/scope failures, validation failures, not-found, and rate limiting; exit codes are non-zero and meaningfully distinct from success.
- R3.4 A no-side-effect preview mode (`--dry-run`) for any mutating command, showing the request that would be sent.
- R3.5 Pagination is handled predictably (explicit page flags, and/or a documented way to fetch all pages).

### R4 — The `pingcode` skill

- R4.1 A single `SKILL.md` with YAML frontmatter (`name`, `description`) that follows the skill conventions already used in this environment.
- R4.2 The `description` must contain concrete trigger phrases so an agent routes to it correctly, and explicit anti-triggers for out-of-scope PingCode modules.
- R4.3 Documents the auth gate first (what to do when not authenticated), then the command catalog with real, copy-pasteable invocations.
- R4.4 Instructs agents to prefer `--json` for parsing and `--dry-run` before mutations, and to ask for confirmation before destructive/mutating calls.
- R4.5 Must be accurate against the shipped CLI: every command and flag it mentions actually exists.
- R4.6 The in-repo `skills/pingcode/SKILL.md` is the source of truth; provide a repeatable install path that syncs it to the user's global agent skill directories (`~/.claude/skills/pingcode/`) and to `.opencode/skills/pingcode/`, so it works beyond this repo.

### R5 — Quality & distribution

- R5.1 TypeScript with strict type checking; the build produces a runnable CLI binary entry point.
- R5.2 Automated tests covering the API client (auth/token refresh, envelope parsing, error mapping) against mocked HTTP, not the live API.
- R5.3 Real-API smoke validation against the user's actual credentials before the task is considered done.
- R5.4 Secrets must never be committed; `.gitignore` (and any `.env`) set up accordingly.

## Non-Goals (MVP)

- Testhub / Wiki / Ship / Flow / Insight / org-chart command coverage.
- Webhook receiving or any long-running server mode.
- Interactive TUI.
- Publishing to a public npm registry.
- A family of `pingcode-*` skills (single skill only, by decision).

## Acceptance Criteria

Verdicts recorded in S9. Evidence is a test name, a step in `research/s8-smoke.md`, or the S9
re-verification noted inline.

- [x] AC1 `pingcode` runs from a built artifact and `--help` lists the auth, project, and work-item command groups.
      — S9: `npm run build` → `node dist/bin/pingcode.js --help` lists `auth`/`project`/`work-item`/`meta`;
      all **15** leaf `--help` pages render with exit 0. Locked by `test/help.test.ts` snapshots.
- [x] AC2 With valid `client_id` / `client_secret`, the login command succeeds and the auth-status command reports an authenticated state with secrets redacted.
      — `s8-smoke.md` steps 1–2 and 13; S9 re-ran `auth status --check --json` (live call ok, `projects_total: 9`).
- [x] AC3 Credentials/token are stored outside the repository with `0600` permissions, and no secret appears in any command output.
      — `s8-smoke.md` steps 3 and 13 (`-rw-------`, dir `0700`, cache `0600`, no 8-char substring of the
      secret anywhere in stdout+stderr); S9 re-confirmed mode `600` on `~/.pingcode/config.json`.
      Tests: `test/config.test.ts` (mode, skipped on `win32`), `test/output.test.ts` (redaction).
- [x] AC4 An expired/invalid cached token is transparently re-acquired: a subsequent API command succeeds without the user re-running login.
      — `s8-smoke.md` step 12: token corrupted by hand → `--verbose` trace shows `← 401` → one re-auth →
      replay `← 200`, stdout still pure JSON. Tests: `test/auth.test.ts`, `test/http.test.ts` (single
      re-auth, no recursion, single in-flight acquisition).
- [x] AC5 Listing projects returns real data from the user's PingCode instance.
      — `s8-smoke.md` step 4 (9 real projects); S9 re-confirmed via the `auth status --check` capability call.
- [x] AC6 Work items can be listed with filters and paginated, a single work item can be fetched by identifier, and both work in `--json` mode emitting valid parseable JSON only.
      — `s8-smoke.md` steps 5–7, G5-1 (full paging matrix), and the 19-command `--json` purity sweep
      (every stdout parsed, every stderr 0 bytes); S9 re-ran `work-item list --project RDD --all --no-cache --json`.
- [x] AC7 A work item can be created and then updated (including a state change) against the real API; `--dry-run` on those same commands performs no write and prints the intended request.
      — `s8-smoke.md` steps 8–10 (dry-run wrote nothing and the follow-up list proved it; create → RDD-26;
      `transition` moved state; empty patch → exit 2) and the S8b live re-verification of the `--type`
      state-name path. The artifact was deleted in S9 (see `s8-smoke.md` "S9 cleanup").
- [x] AC8 Failure modes produce distinct, actionable messages and non-zero exit codes for: missing/invalid credentials, insufficient permission, invalid input, and not-found.
      **Partially provable.** Live-observed: invalid credentials → **3**, invalid input → **2**,
      not-found → **5** (both after the S8b `code`-override fix; `s8-smoke.md` step 11 + S8b table).
      **Insufficient permission (403 → exit 4) was never observed live** — the Client Credentials token
      is org-admin-scoped, so nothing in the MVP surface denied us. It is unit-tested only
      (`test/http.test.ts`). Same caveat for rate limiting (429 → exit 6), which was deliberately not
      provoked against the user's production org.
- [x] AC9 `SKILL.md` exists as a single skill with valid frontmatter, and every command/flag it documents exists in the CLI.
      — `test/help.test.ts`: frontmatter + `name: pingcode`, every command path in `SKILL.md` resolves in
      the commander tree **and** every CLI leaf is mentioned. Command paths are machine-checked; flag
      names are review-checked.
- [x] AC10 Type-check and the mocked-HTTP test suite pass.
      — S9: `npm run typecheck` clean, `npm test` → **13 files / 213 tests** passed, zero network.
- [x] AC11 No secret values are present in any tracked file.
      — S9: the stored `client_id`, `client_secret` and access token were each searched as literal
      substrings across **all** `git ls-files` entries → **0 hits** each. `.gitignore` covers `.env*`,
      `dist/`, `*.log` and now `.pingcode/`; the real store lives outside the repo at `~/.pingcode/`.


## Open Questions

- ~~Q1~~ **Resolved** (`research/pingcode-api.md` §1, `design.md` D4/D7): `client_credentials` only in MVP; the token endpoint is `GET {apiBase}/v1/auth/token` under the **REST root** (not `/oauth2`, not POST+form); `apiBase` is `https://open.pingcode.com` on cloud and `https://<domain>/open` self-hosted. The resulting token is org-wide system-admin with no refresh token — see `design.md` D6 for the storage trade-off.
- ~~Q2~~ **Resolved** (`research/pingcode-api.md` §5, `design.md` D5): PingCode publishes **no** OpenAPI/Swagger and no official SDK. It does expose its apiDoc source at `https://open.pingcode.com/api_data.json` (460 endpoints). MVP hand-writes types for its ~15 endpoints and validates them against the live API; codegen from that URL is a recorded follow-up.
- ~~Q3~~ **Resolved**: the skill lives in-repo as the source of truth (`skills/pingcode/SKILL.md`), and the CLI/repo additionally provides an install path that syncs it to the user's global agent skill directories (`~/.claude/skills/pingcode/`, `.opencode/skills/pingcode/`). Reflected as R4.6 below.

## Notes

- Follow `.trellis/spec/` guidelines when they become populated; at kickoff they were unfilled
  templates, so this task also established the initial conventions. **Done in S9:** the five
  `.trellis/spec/backend/` documents are filled from this codebase, and `.trellis/spec/frontend/`
  is explicitly marked not applicable (there is no frontend).
- Documentation in the repo is written in English; user-facing conversation is Chinese.
