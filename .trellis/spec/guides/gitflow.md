# GitFlow — Branch-Based Development Rules

> The executable process contract for how `pingcode-cli` is developed day-to-day.
> Every contributor (human or AI agent) MUST follow these branch rules.

## 1. Why GitFlow

This project uses GitFlow so that:

- `main` is always deployable / releasable.
- `develop` is the integration branch for the next release.
- Feature work never lands on `main` directly.
- Hotfixes can be cut from `main` without disturbing ongoing feature work.

## 2. Branch Roles

```
main      ← production releases only. Every commit here is tagged (vX.Y.Z).
            Never commit directly. Never merge feature branches here.

develop   ← integration branch for the next release. All feature branches
            merge here first. This is the default branch for new work.

feature/<name>  ← new work, branched off develop, merged back to develop.
release/<ver>   ← stabilization branch, branched off develop,
                  merged to main (tagged) AND back to develop.
hotfix/<name>   ← urgent production fix, branched off main,
                  merged to main (tagged) AND back to develop.
```

## 3. Daily Workflow

### Starting new work

```bash
git checkout develop
git pull origin develop
git checkout -b feature/<name>
```

Work on `feature/<name>`. Commit often (feature code + version bump).
When ready, push and create a PR:

```bash
git push origin feature/<name>
gh pr create --base develop --title "feat(<scope>): <subject>"
```

Wait for CI + CodeRabbit review. Address review comments, push fixes.
When CI is green and CodeRabbit approves, merge the PR:

```bash
gh pr merge --no-ff --delete-branch
```

`--no-ff` is preferred so the feature is visible in history.

### Cutting a release

```bash
git checkout develop
git pull origin develop
git checkout -b release/<ver>
# bump version, stabilize, typecheck+test+build green
git push origin release/<ver>
gh pr create --base main --title "chore(release): <ver>"
# Wait for CI green, then merge
gh pr merge --no-ff
git checkout main && git pull origin main
git tag -a v<ver> -m "release <ver>"
git push origin v<ver>   # triggers GitHub Release
git checkout develop
git merge --no-ff main   # bring release fixes back
git push origin develop
```

### Urgent production fix

```bash
git checkout main
git pull origin main
git checkout -b hotfix/<name>
# fix, bump PATCH, typecheck+test+build green
git push origin hotfix/<name>
gh pr create --base main --title "fix(<scope>): <subject>"
# Wait for CI green, then merge
gh pr merge --no-ff
git checkout main && git pull origin main
git tag -a v<ver> -m "hotfix <ver>"
git push origin v<ver>   # triggers GitHub Release
git checkout develop
git merge --no-ff hotfix/<name>
git push origin develop
```

## 4. Rules

- **Never commit directly to `main`.** All `main` commits come from `release/*` or `hotfix/*` merges.
- **Never merge `feature/*` directly to `main`.** They go to `develop` first.
- **`develop` is the default branch.** New work branches off `develop`, never off `main`.
- **Tags are created on `main` only**, at the release/hotfix merge commit.
- **Version bump happens on the release/hotfix branch** before it merges to `main`, so the tagged commit carries the right number.
- **After a release, merge `main` back to `develop`** (via the release branch merge) so fixes made during stabilization aren't lost.

## 5. For AI Agents

When you are asked to implement a feature or fix:

1. **Check current branch.** If on `main`, STOP — create a `feature/*` branch off `develop` first. Never commit directly to `main`.
2. **Create `feature/<short-name>` off `develop`.**
3. **Do your work on that branch.** Commit feature code first, then version bump as a separate commit.
4. **Push the feature branch and create a PR to `develop`.** Use `gh pr create --base develop`.
5. **Wait for CI + CodeRabbit.** Both run automatically on the PR. Address CodeRabbit comments by pushing additional commits to the same branch.
6. **If CI is green and CodeRabbit approves, merge the PR.** Use `gh pr merge --no-ff --delete-branch`.
7. **Release (only when user explicitly asks):**
   a. Create a `release/<ver>` branch from `develop`
   b. Bump version, verify checklist
   c. Push and create a PR to `main`
   d. Wait for CI green, merge
   e. Tag on `main`: `git tag -a vX.Y.Z -m "release X.Y.Z"`
   f. Push tag: `git push origin vX.Y.Z` → triggers GitHub Release
   g. Merge `main` back to `develop`
8. **Never push directly to `main`** or create tags without explicit user instruction.
9. **Reply to the GitHub issue** before closing it: post a comment explaining what
   changed and which release version fixed it. Include commit links and the release
   URL. The comment is the audit trail that connects the issue to the release.
   Never close an issue silently.

**Version bump is mandatory** for every feature/fix commit batch:
- New command/flag → MINOR bump
- Bug fix → PATCH bump
- Breaking change → MAJOR bump
- Bump `package.json` + `src/version.ts` in a separate `chore:` commit

**Common mistake**: committing feature work directly on `main` without a feature branch. This bypasses CI and breaks the GitFlow model. Always use `feature/*` branches off `develop`.

When you are asked to release:

1. Verify you are on `develop` and it is up to date.
2. Cut `release/<ver>` from `develop`.
3. Bump version, run the full release checklist (see [Versioning Guide](./versioning.md)).
4. Merge to `main`, tag, merge back to `develop`, push all.

## 6. Commit Rules

Every commit message MUST follow [Conventional Commits 1.0.0](./commit-conventions.md).
The format is:

```
<type>(<scope>): <subject>
```

- `type` — required, lowercase, from the type table in `commit-conventions.md`.
- `scope` — optional but strongly preferred; mirrors the source layout.
- `subject` — imperative mood, lowercase start, no trailing period, ≤ 72 characters.

This is machine-enforced by `scripts/check-commits.ts` in CI. Do not invent new types.
If nothing fits, the commit is probably doing two things — split it.

## 7. Wrong vs Correct

#### Wrong — feature merged directly to main
```
git checkout main
git merge feature/thing   # ❌ feature never touches main directly
```

#### Correct — feature flows through develop
```
git checkout develop
git merge --no-ff feature/thing   # ✓ feature lands on develop first
# later: release branch merges develop → main
```

#### Wrong — direct commit on main
```
git checkout main
git commit -m "fix something"   # ❌ never commit directly on main
```

#### Correct — hotfix branch
```
git checkout -b hotfix/fix-xyz
# fix, test, bump PATCH
git checkout main && git merge --no-ff hotfix/fix-xyz && git tag v1.0.1
git checkout develop && git merge --no-ff hotfix/fix-xyz
```
