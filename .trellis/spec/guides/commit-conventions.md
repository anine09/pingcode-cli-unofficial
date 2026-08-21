# Commit Conventions

> **Purpose**: Every commit message in this repository follows
> [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). The history is public,
> so the log is documentation.
>
> **Machine-enforced.** The checkable rules below — the `type(scope): subject` shape, the type table,
> and the subject-line constraints — are validated by `scripts/check-commits.ts` (`npm run
> check:commits`), which runs in CI on every push and pull request (and on a PR, against the PR title
> too, because a squash merge takes it as the subject). Imperative mood and body quality stay a review
> matter. Related: `npm run scan:secrets` enforces the "no secrets, no tenant-identifiable values"
> rule below over both tracked files and commit messages.

---

## Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type` — required, from the table below, lowercase.
- `scope` — optional but **strongly preferred**; the part of the system that changed.
- `subject` — required. Imperative mood, lowercase start, **no trailing period**, ≤ 72 characters.
- Blank line before the body. Blank line before the footer.

---

## Types

| Type | Use for | Example |
|------|---------|---------|
| `feat` | New user-visible capability | `feat(cli): add auth, project, work-item and meta commands` |
| `fix` | Behaviour correction | `fix(cli): align state resolution and error mapping with live API behaviour` |
| `docs` | Documentation, specs, research notes | `docs(research): record the live-API smoke run` |
| `refactor` | Restructuring with no behaviour change | `refactor(core): extract url building into wire` |
| `test` | Tests only | `test(http): cover 429 backoff without a retry-after header` |
| `chore` | Tooling, deps, task bookkeeping | `chore(task): archive 07-31-pingcode-cli-mvp` |
| `build` | Build pipeline / packaging | `build: emit a single esm bundle with tsup` |
| `perf` | Performance work | `perf(core): cache metadata lookups per project` |
| `revert` | Reverting a previous commit | `revert: feat(cli) add bulk update` |

Do **not** invent new types. If nothing fits, the commit is probably doing two things — split it.

---

## Scopes used in this repository

Scopes mirror the source layout, so they stay greppable:

| Scope | Covers |
|-------|--------|
| `cli` | `src/cli/**` — commands, program wiring, global flags, output |
| `core` | `src/core/**` — config, auth, http/wire, errors, redaction, pagination, metadata |
| `api` | `src/api/**` and `src/types/api.ts` — typed endpoint wrappers |
| `auth` | Authentication flow specifically, when it spans `core` and `cli` |
| `http` | Transport behaviour specifically (retries, replay, status mapping) |
| `skill` | `skills/pingcode/**` and `scripts/install-skill.ts` |
| `research` | `research/*.md` under a task directory |
| `spec` | `.trellis/spec/**` |
| `task` | Trellis task bookkeeping (`chore(task): …`) |

Omit the scope only when a change is genuinely repository-wide (e.g. `docs: add README and backend specs`).

---

## Subject line rules

- **Imperative mood**: "add", "fix", "remove" — not "added", "adds", "adding".
- Describe the **outcome**, not the activity: `feat(auth): add client_credentials auth with dual-shape expiry normalisation`, not `work on auth`.
- No issue numbers, no ticket prefixes, no emoji.
- No `WIP`, `misc`, `updates`, `various fixes`.

---

## Body rules

Include a body whenever the change is not self-evident. Explain **why**, and record decisions that a
future reader cannot recover from the diff:

- The constraint or API fact that forced the shape of the change.
- Alternatives that were considered and rejected, and why.
- What the change deliberately does **not** do.
- Which invariant it preserves (stdout purity, exit-code contract, layering, redaction).

Wrap the body at 100 columns. Use `-` bullets for lists.

---

## Breaking changes

Mark them explicitly, because the CLI's exit codes, `--json` shapes and flag names are contracts that
agents branch on:

```
feat(cli)!: rename --state-id to --state-ref

BREAKING CHANGE: `--state-id` no longer exists. Scripts must pass `--state-ref`.
```

Either the `!` after the scope or a `BREAKING CHANGE:` footer is enough; using both is clearer.

---

## What a commit should contain

- **One logical slice.** During implementation, each planned slice ends in exactly one commit so it
  doubles as a rollback point.
- **A green tree.** `npm run typecheck && npm test` pass at every commit, not just at the tip.
- **No secrets and no tenant-identifiable values** — not in the diff, and not in the message. Client
  ids, client secrets, tokens, tenant subdomains and real resource ids are all disqualifying. Use
  placeholders (`example-tenant`, `aaaaaaaaaaaaaaaaaaaaaaaa`).
- No unrelated formatting churn mixed into a behaviour change.

---

## History rewriting

The published history is the contract. Rewriting is acceptable **only before the first push** — for
example normalising messages or scrubbing tenant identifiers prior to publication. After that, fix
forward with a new commit; never rewrite `origin/main`.

When a rewrite is unavoidable pre-publish:

1. Tag a backup ref first.
2. Verify content is untouched: `git diff <backup> HEAD --stat` must be empty for a message-only rewrite.
3. Remember `--tree-filter` does not touch commit messages, and `--msg-filter` does not touch trees —
   a scrub usually needs both passes.
4. Delete `refs/original/*` and the backup tag, then `reflog expire --expire=now --all && gc --prune=now`.
5. Re-run the test suite afterwards.

---

## Checklist before committing

- [ ] `type(scope): subject` — valid type, imperative, ≤ 72 chars, no trailing period
- [ ] One logical change only
- [ ] `npm run typecheck && npm test` green
- [ ] Body explains *why* if the diff does not
- [ ] `!` / `BREAKING CHANGE:` present if a contract changed
- [ ] No secrets, tokens or tenant-identifiable values in the diff or the message
- [ ] **Version bumped** if this commit adds/changes user-visible capability — see [Versioning](./versioning.md)

## Version bumping in commits

Every commit that adds or changes user-visible capability MUST include a version bump in the same commit batch. The version bump is a **separate commit** (`chore: bump version to X.Y.Z (reason)`) that follows the work commit(s).

| Change type | Bump | Example |
|---|---|---|
| New command / new flag / new auth mode | **MINOR** | `feat(cli): add board commands` → 1.1.0 → 1.2.0 |
| Bug fix / behavior correction | **PATCH** | `fix(cli): align state resolution` → 1.2.0 → 1.2.1 |
| Removed/renamed command, changed flag, changed exit code | **MAJOR** | `feat(cli)!: rename --state-id` → 1.2.1 → 2.0.0 |
| Docs / tests / refactor only | **No bump** | `docs: update README` |

Files to bump: `package.json` (`version` field, no leading `v`) + `src/version.ts` (`VERSION` constant).

**Common mistake**: completing a feature, committing the code, and forgetting to bump the version. The next person (or AI) sees new capability at the old version number and cannot tell what changed. Always ask "does this diff add or change user-visible behavior?" before committing.
