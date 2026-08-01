# Backend Development Guidelines

> Conventions for `pingcode-cli` — a single-package, strict-TypeScript Node.js CLI over the PingCode
> Open API. There is no server and no database; "backend" here means everything under `src/`.

---

## Overview

The repository is one ESM package built by `tsup` into `dist/bin/pingcode.js`. Its architecture is
three layers with an enforced direction, and its user-facing contracts (stdout purity, exit codes,
redaction) are treated as API rather than as presentation details.

Start here:

- **`cli → {api, core}`, `api → core`, `core` imports neither.** Enforced by
  `test/layering.test.ts`, not by convention.
- **`--json` means stdout is JSON only.** Logs, warnings, dry-run notes and errors go to stderr.
- **The exit-code table is a stable contract.** Agents branch on it.
- **Every printable URL goes through `redactUrl()`** — on this API the `client_secret` travels in the
  query string.
- **No network in unit tests.** `fetch` is injected through `Ctx`.
- **API facts are recorded in `research/`, never assumed.** When reality contradicts the docs, update
  the research file and `design.md` rather than quietly patching a call site.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Layer layout and the enforced layering invariant | Filled |
| [Local State & Persistence](./database-guidelines.md) | No database — the `~/.pingcode/` credential store and metadata cache | Filled |
| [Error Handling](./error-handling.md) | Error hierarchy, the exit-code contract, status-first + `code`-override mapping | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Forbidden/required patterns, testing policy, API-fact discipline | Filled |
| [Logging Guidelines](./logging-guidelines.md) | The stdout/stderr contract, log levels, redaction | Filled |

There is **no frontend** in this project; see [`../frontend/index.md`](../frontend/index.md).

---

## Where the deeper rationale lives

These guidelines are the distilled rules. The reasoning, the alternatives that were rejected, and the
live-API evidence behind the surprising parts are in
`.trellis/tasks/archive/2026-08/07-31-pingcode-cli-mvp/`:

- `design.md` — architecture decisions D1–D8, §5.2 exit codes, §7 command semantics
- `research/pingcode-api.md` — the endpoint contract and its gotchas
- `research/s8-smoke.md` — what the live API actually did, including the 400-instead-of-401/404
  findings and everything that remains unverified

---

**Language**: All documentation is written in **English**; user-facing conversation is Chinese.
