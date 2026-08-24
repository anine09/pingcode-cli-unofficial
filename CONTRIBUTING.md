# Contributing

## Branch Model

This project uses [GitFlow](https://nvie.com/posts/a-successful-git-branching-model/):

| Branch | Purpose |
|--------|---------|
| `main` | Production releases. Every commit is tagged (`vX.Y.Z`). Never commit directly. |
| `develop` | Integration branch for the next release. Default branch for new work. |
| `feature/<name>` | New work, branched off `develop`, merged back via PR. |
| `release/<ver>` | Stabilization, branched off `develop`, merged to `main` (tagged) and back to `develop`. |
| `hotfix/<name>` | Urgent production fix, branched off `main`, merged to `main` (tagged) and back to `develop`. |

### Daily workflow

```bash
git checkout develop
git pull origin develop
git checkout -b feature/my-change
# ... work, commit ...
git push origin feature/my-change
gh pr create --base develop --title "feat(scope): subject"
# Wait for CI green + review, then:
gh pr merge --merge --delete-branch
```

## Commit Messages

Every commit message follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

| Type | Use for |
|------|---------|
| `feat` | New user-visible capability |
| `fix` | Behaviour correction |
| `docs` | Documentation, specs, research notes |
| `refactor` | Restructuring with no behaviour change |
| `test` | Tests only |
| `chore` | Tooling, deps, task bookkeeping |
| `build` | Build pipeline / packaging |
| `perf` | Performance work |
| `revert` | Reverting a previous commit |

Do not invent new types. If nothing fits, the commit is probably doing two things — split it.

### Scopes

| Scope | Covers |
|-------|--------|
| `cli` | `src/cli/**` — commands, program wiring, output |
| `core` | `src/core/**` — config, auth, http/wire, errors, pagination, metadata |
| `api` | `src/api/**` and `src/types/api.ts` — typed endpoint wrappers |
| `auth` | Authentication flow |
| `http` | Transport behaviour (retries, replay, status mapping) |
| `skill` | `skills/pingcode/**` |
| `research` | `research/*.md` under a task directory |
| `spec` | `.trellis/spec/**` |
| `task` | Trellis task bookkeeping |

Omit the scope only when a change is genuinely repository-wide.

### Subject line rules

- **Imperative mood**: "add", "fix", "remove" — not "added", "adds", "adding".
- **Lowercase start**, **no trailing period**, ≤ 72 characters.
- Describe the **outcome**, not the activity.
- No issue numbers, no ticket prefixes, no emoji, no `WIP`/`misc`/`updates`.

### Body

Include a body when the change is not self-evident. Explain:
- The constraint or API fact that forced the shape.
- Alternatives considered and rejected.
- What the change deliberately does **not** do.
- Which invariant it preserves.

Wrap at 100 columns. Use `-` bullets for lists.

### Breaking changes

```text
feat(cli)!: rename --state-id to --state-ref

BREAKING CHANGE: `--state-id` no longer exists. Scripts must pass `--state-ref`.
```

Either the `!` after the scope or a `BREAKING CHANGE:` footer; using both is clearer.

## Quality Gates

Before committing:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Every commit must have a green tree. New behaviour ships with a regression test in the same commit.

The `pre-commit` hook runs `scan:secrets` + `typecheck`. The `commit-msg` hook validates the message format. CI runs both plus the full test suite on every push and PR.

## Version Bumping

Every commit that adds or changes user-visible capability MUST include a version bump in a **separate commit** (`chore: bump version to X.Y.Z (reason)`) that follows the work commit(s).

| Change type | Bump | Example |
|-------------|------|---------|
| New command / new flag / new auth mode | **MINOR** | 1.1.0 → 1.2.0 |
| Bug fix / behavior correction | **PATCH** | 1.2.0 → 1.2.1 |
| Removed/renamed command, changed flag, changed exit code | **MAJOR** | 1.2.1 → 2.0.0 |
| Docs / tests / refactor only | **No bump** | — |

Files to bump: `package.json` (`version` field) + `src/version.ts` (`VERSION` constant).

## Security

- **No secrets or tenant-identifiable values** in the diff or commit message.
- Client IDs, client secrets, tokens, tenant subdomains, and real resource IDs are disqualifying. Use placeholders (`example-tenant`, `aaaaaaaaaaaaaaaaaaaaaaaa`).
- The `client_secret` travels in the query string — never print a raw URL, header map, or response body. Route through `redactUrl` / `redactHeaders` / `redactSnippet`.

## Setting Up Hooks

```bash
git config core.hooksPath .githooks
git config commit.template .gitmessage
```

This enables:
- **`.githooks/pre-commit`** — secrets scan + typecheck before each commit
- **`.githooks/commit-msg`** — validates commit message format
- **`.gitmessage`** — pre-fills the commit editor with the Conventional Commits format
