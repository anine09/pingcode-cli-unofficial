# Local State & Persistence

> This project has **no database**. What it does have is credential and cache state on the user's
> disk, and that state is security-sensitive — so the same discipline applies.

---

## Overview

There is no ORM, no migrations, no SQL. Persistence is two things under `~/.pingcode/`
(relocatable via `PINGCODE_CONFIG_DIR`), both owned exclusively by `src/core/config.ts` and
`src/core/metadata.ts`:

| Path | Contents | Written by |
|---|---|---|
| `~/.pingcode/config.json` | `host`, `clientId`, `clientSecret` (only with `--save`), `token{accessToken, expiresAtMs, obtainedAtMs}` | `core/config.ts` |
| `~/.pingcode/cache/<sha256>.json` | resolved metadata lists (types, states, priorities, sprints, users, projects) | `core/metadata.ts` |

Nothing else in the codebase may read or write these files. `cli/` is forbidden from importing
`node:fs` at all (enforced by `test/layering.test.ts`).

---

## Write Patterns

**Permissions.** Directory `0700`, files `0600`, applied on create *and* re-asserted with `chmod`
on every write (a pre-existing directory may have been created loosely). Skipped on `win32`, where
POSIX modes are meaningless. On read, a file looser than `0600` produces a `warn` on stderr rather
than a silent acceptance.

**Atomic writes.** Write to a temp file in the same directory at `0600`, then `renameSync` over the
target. Never truncate-then-write: a crash mid-write would leave the user with no credentials and no
token.

**Merge only the fields you own.** `saveConfig(patch)` re-reads the file, merges the patch, and
writes the union. Two concurrent CLI invocations are normal (an agent may run several), and a blind
whole-file write would drop a token another process had just persisted.

**Secrets are opt-in.** The `client_secret` is persisted **only** when the user passes `--save`, and
`shouldPersistSecret()` also refuses to write a secret that came from the environment. A token
acquired without `--save` is still cached — that is the useful half — but the secret is not.

**Deletes are explicit.** `auth logout` removes the config file *and* the whole cache directory.
`auth login` clears the cache too, because a new set of credentials may see a different set of
projects.

---

## Cache Keying and Invalidation

The cache key is a `sha256` over **`(apiBase, clientId, projectId, kind)`**, truncated to 32 hex
chars and used as the filename. All four components matter:

- `apiBase` — cloud and self-hosted are different universes.
- `clientId` — **two apps against the same host must never share a cache**, because they may have
  different scopes and therefore different visibility. Leaking one app's project list to another is a
  correctness *and* a confidentiality bug.
- `projectId` + `kind` — ids are project-scoped; a state name means a different id per project.

Hashing also means the filename never reveals a project name.

Freshness rules:

- **TTL 24 h**, checked against `ctx.now()` (injected, so it is testable without timers).
- `--no-cache` bypasses reads and writes for that invocation.
- **Invalidate-and-retry-once:** if a write is rejected on an id that came from the cache, that entry
  is dropped and the operation retried exactly once; the error message then names the cache and
  suggests `--no-cache`. Never retry more than once — a genuinely wrong id would loop.
- A cache that cannot be written is a **performance** problem, never a failure: catch and continue.

---

## Naming Conventions

- Config keys are `camelCase` (`clientId`, `expiresAtMs`) — this is our file, not the API's wire
  format. Wire `snake_case` stops at `api/parse.ts`.
- Absolute instants are stored as `…Ms` (epoch milliseconds) internally, even though the API speaks
  unix **seconds**. The conversion happens once, in `normalizeExpiry`.
- Cache filenames are opaque hashes; never encode a human-readable key into a path.

---

## Common Mistakes

- **Whole-file overwrite** instead of merge-on-save — silently discards a concurrently written token.
- **Trusting the directory mode** because you created it with `mode:` — an existing directory keeps
  its old mode; `chmod` explicitly.
- **Persisting the secret by default.** `--save` is a deliberate, informed choice by the user.
- **Dropping the `clientId` from the cache key**, which lets two apps with different scopes poison
  each other's lookups.
- **Treating a cache write failure as fatal.**
- **Reading `~/.pingcode/` from a command.** Go through `core/config.ts`; the layering test will
  catch you.
- **Validating the shape of a cached id.** Ids may be 24-hex, 32-hex, or a bare slug — they pass
  through untouched.
