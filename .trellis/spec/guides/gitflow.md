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

Work on `feature/<name>`. Commit often. When ready:

```bash
git checkout develop
git merge --no-ff feature/<name>
git branch -d feature/<name>
```

`--no-ff` is preferred so the feature is visible in history.

### Cutting a release

```bash
git checkout develop
git checkout -b release/<ver>
# bump version, stabilize, typecheck+test+build green
git checkout main
git merge --no-ff release/<ver>
git tag -a v<ver> -m "release <ver>"
git checkout develop
git merge --no-ff release/<ver>   # bring release fixes back
git push origin main develop v<ver>
```

### Urgent production fix

```bash
git checkout main
git checkout -b hotfix/<name>
# fix, bump PATCH, typecheck+test+build green
git checkout main
git merge --no-ff hotfix/<name>
git tag -a v<ver> -m "hotfix <ver>"
git checkout develop
git merge --no-ff hotfix/<name>
git push origin main develop v<ver>
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
4. **Push the feature branch.** CI will run automatically.
5. **If CI passes, merge to `develop`.** Use `--no-ff` so the feature is visible.
6. **Release (only when user explicitly asks):**
   a. Merge `develop` → `main` (or via `release/<ver>` branch)
   b. Tag on `main`: `git tag -a vX.Y.Z -m "release X.Y.Z"`
   c. Push tag: `git push origin vX.Y.Z` → triggers GitHub Release
   d. Merge `main` back to `develop`
7. **Never push directly to `main`** or create tags without explicit user instruction.

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
