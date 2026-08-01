# Directory Structure

> How the CLI's source is organised, and the one rule that must never be broken.

---

## Overview

This repository is a **single-package Node.js CLI** (no frontend, no server, no database). It is
ESM (`"type": "module"`), strict TypeScript, built with `tsup` into one file:
`dist/bin/pingcode.js`, exposed as the `pingcode` bin.

Runtime dependencies are frozen at **`commander`** and **`picocolors`**. Adding one requires a
stated reason; everything else is `node:*` or dev-only.

---

## Directory Layout

```
src/
├── bin/pingcode.ts        # entry point: parse, catch, map every error to an exit code
├── cli/                   # everything user-facing
│   ├── program.ts          # the commander tree + global flags
│   ├── globals.ts          # flags + env + config file → a Ctx
│   ├── output.ts           # stdout/stderr contract, tables, JSON, dry-run, error rendering
│   └── commands/           # auth.ts, project.ts, workItem.ts, meta.ts, common.ts
├── api/                   # thin typed wrappers over the REST surface
│   ├── projects.ts, workItems.ts, meta.ts
│   └── parse.ts            # normalises wire quirks once (0/1 → boolean, versions[] vs version)
├── core/                  # transport, auth, config, resolution — no printing, no commander
│   ├── context.ts          # Ctx: apiBase, credentials, injected fetch/now/sleep, logger, flags
│   ├── config.ts           # flag→env→file precedence, host→apiBase, 0600 atomic writes
│   ├── auth.ts             # client_credentials acquisition, expiry normalisation, freshness
│   ├── wire.ts             # URL building, response reading, status/code → error mapping
│   ├── http.ts             # request(): auth injection, dry-run gate, 429/401 policy
│   ├── paginate.ts         # 0-based page walking, dedupe by id, --limit
│   ├── metadata.ts         # name→id resolution + the 24 h on-disk cache
│   ├── endpoints.ts        # every path string, in one place
│   ├── errors.ts           # the 8-way hierarchy + exit-code table + DryRunHalt
│   ├── redact.ts           # redactUrl / redactHeaders / redactSnippet / maskIdentifier
│   └── logger.ts           # warn/debug — always to stderr
├── types/api.ts           # hand-written envelope + resource types
└── version.ts

test/                       # vitest; one file per module, plus help.test.ts and layering.test.ts
scripts/install-skill.ts    # npm run skill:install
skills/pingcode/SKILL.md    # the agent-facing docs, source of truth
```

---

## The layering invariant

```
cli → { api, core }
api → core
core → (neither)
```

Plus two narrower rules:

- `api/` **never formats output** — it must not import `cli/output`.
- `cli/` **never builds URLs and never touches the filesystem directly** — no `node:fs`, no
  `buildUrl`. It goes through `core/`.

**This is enforced, not aspirational:** `test/layering.test.ts` walks every file under `src/`,
extracts its import specifiers, and fails the suite on a violation. If you need a `core` module to
know something from `cli`, pass it through `Ctx` (`src/core/context.ts`) instead of importing
upwards — that is exactly why `Ctx` exists.

Practical consequence: shared primitives live in `core/` even when only one layer looks like the
owner. `redact.ts` sits in `core/` because `core/http.ts` needs it and cannot import `cli`;
`cli/output.ts` re-exports it so there is still exactly one implementation. `endpoints.ts` sits in
`core/` because both `api/*` and `core/metadata.ts` need paths.

---

## Module Organization

- **One new endpoint** = a path in `core/endpoints.ts`, a type in `types/api.ts`, a wrapper in
  `api/`, and a command in `cli/commands/`. Do not skip the wrapper and call `request()` from a
  command.
- **A new command group** = a file in `cli/commands/` registered in `cli/program.ts`. Global flags
  are attached by `program.ts` so they work before *or* after the subcommand.
- **Anything that reads config, builds a URL, or talks to the network belongs in `core/`.**

## Naming Conventions

- Files: `camelCase.ts` (`workItems.ts`, `install-skill.ts` is the one kebab-case exception, being a
  script). Directories: lowercase.
- Command groups are kebab-case on the CLI (`work-item`) and camelCase in the filesystem
  (`workItem.ts`).
- Wire-shaped fields keep the API's `snake_case` (`page_index`, `state_id`); everything internal is
  `camelCase`. The boundary is `api/parse.ts` and the `--json` renderers in `cli/output.ts`.

## Examples

- Clean vertical slice: `core/endpoints.ts` → `types/api.ts` → `api/workItems.ts` →
  `cli/commands/workItem.ts`.
- Layering pressure resolved correctly: `core/context.ts` (dependency injection instead of an
  upward import) and `core/redact.ts` (owned by `core`, re-exported by `cli`).
