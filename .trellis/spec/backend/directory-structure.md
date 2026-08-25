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
│   ├── program.ts          # the root commander tree + global flags + root-level settings
│   ├── registry.ts         # the group list program.ts iterates — one row per command group
│   ├── globals.ts          # flags + env + config file → a Ctx
│   ├── output.ts           # stdout/stderr contract, tables, JSON, dry-run, error rendering
│   └── commands/           # one file (or directory) per group; _shared/ for cross-object families
├── api/                   # thin typed wrappers over the REST surface
│   ├── projects.ts, workItems.ts, ship.ts, scm.ts, testhub.ts, …
│   └── parse/, parse.ts    # normalises wire quirks once (0/1 → boolean, versions[] vs version)
├── core/                  # transport, auth, config, resolution — no printing, no commander
│   ├── context.ts          # Ctx: apiBase, credentials, injected fetch/now/sleep, logger, flags
│   ├── config.ts           # flag→env→file precedence, host→apiBase, 0600 atomic writes
│   ├── auth.ts             # client_credentials acquisition, expiry normalisation, freshness
│   ├── wire.ts             # URL building, response reading, status/code → error mapping
│   ├── http.ts             # request(): auth injection, dry-run gate, 429/401 policy
│   ├── paginate.ts         # 0-based page walking, dedupe by id, --limit
│   ├── metadata/           # name→id resolution + the 24 h on-disk cache
│   ├── catalog/            # the generated endpoint catalog + its hand-written corrections
│   ├── endpoints.ts        # every curated path string, in one place
│   ├── errors.ts           # the 8-way hierarchy + exit-code table + DryRunHalt
│   ├── zip.ts              # pure-Node ZIP extractor (zero-dep; deflate + stored; path-traversal guard)
│   ├── paths.ts            # XDG install dir, skill targets, bin shim path, platform/arch detection
│   ├── update.ts           # update engine: fetch release, download, atomic replace, skill sync, verify
│   ├── redact.ts           # redactUrl / redactHeaders / redactSnippet / maskIdentifier
│   └── logger.ts           # warn/debug — always to stderr
├── types/                 # hand-written envelope + resource types, per module
└── version.ts

test/                       # vitest; one file per module, layering.test.ts, and help/ per group
scripts/install-skill.ts    # npm run skill:install
scripts/package-release.ts  # npm run package:release — build + zip dist/+skills/ for GitHub Releases
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

- **One new endpoint** = a path in `core/endpoints.ts`, a type in `types/`, a parser in `api/parse/`, a
  wrapper in `api/`, and a command in `cli/commands/`. Do not skip the wrapper and call `request()`
  from a command.
- **A new command group** = a file (or directory) in `cli/commands/`, plus **one row in
  `cli/registry.ts`**, which `cli/program.ts` iterates. Nothing else should need editing: registration
  order is `GROUPS` order and it is the order `--help` prints. The group's own leaves are asserted in
  its own `test/help/<group>.test.ts`.
- **Anything that reads config, builds a URL, or talks to the network belongs in `core/`.**

### Root-level commander settings are load-bearing

Settings on the root `Command` in `buildProgram()` propagate to every subcommand through commander's
`copyInheritedSettings` — **including to leaves injected dynamically at registration time**, because
`parent.command()` copies them at creation. So adding or removing one is a behaviour change to the
entire tree, not a local tweak, and it belongs in `program.ts` with a comment rather than being
sprinkled over leaves. (The same mechanism is why global flags attached by `program.ts` work before
*or* after the subcommand.)

Two of them exist because their absence caused silent data loss:

- **`allowExcessArguments(false)`.** commander's default is to *silently discard* excess positionals,
  which next to a bare boolean switch inverts its meaning: `--yes false` parses as `--yes` plus a
  dropped `false`, and `scm branch delete <ref> --yes false` really did delete the branch. Users have
  every reason to try the value form, since neighbouring flags (`--private true|false`) take one.
  Rejection surfaces as a `CommanderError` → exit 2, so the exit table is unchanged.
- **`.version(VERSION, '--version', …)` on the root reserves that flag globally.** The root parses
  options across the whole argv, so a *leaf* flag named `--version` never arrives — the invocation
  prints the CLI version and exits 0 having sent nothing. `-v` is likewise never bound (it would
  collide with `--version`/`--verbose`).

**Verify such a setting by execution, not by reasoning about it.** The excess-arguments fix was
confirmed by enumerating every action leaf of the real tree and running each with one extra
positional: with the setting, all were refused and none reached the network; without it, only the
leaves that happened to have a `requiredOption` were — the majority had been swallowing the extra
argument. Do this behind an isolated `PINGCODE_CONFIG_DIR` and an injected `fetch`
([Live Verification](./live-verification.md)).

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
