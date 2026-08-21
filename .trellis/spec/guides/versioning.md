# Versioning & Branching — GitFlow + Semantic Versioning

> The executable process contract for how `pingcode-cli` is versioned and released.
> Every release MUST follow these rules. This file is the single source of truth.

## 1. Scope / Trigger

- **Trigger:** the project adopts a disciplined version-management model so any contributor
  (human or AI agent) can release predictably, and any consumer can reason about what a
  version number means.
- **Baseline:** semantic versioning starts at **`1.0.0`** (first stable release). Everything
  before it was pre-1.0 development.

## 2. Signatures

**Semantic version format**

```
MAJOR.MINOR.PATCH[-prerelease][+build]
1.0.0
1.2.0
1.2.3
2.0.0-rc.1
2.0.0-beta.2
1.4.0+sha.92929f5
```

- `MAJOR.MINOR.PATCH` are non-negative integers, no leading zeros.
- Pre-release tag: `-` then dot-separated identifiers (`rc.1`, `beta.2`, `alpha`).
- Build metadata: `+` then dot-separated identifiers (a git sha, `sha.92929f5`).

**GitFlow branches**

```
main    ← production releases only. Every commit here is tagged (vX.Y.Z). Never commit directly.
develop ← integration branch for the next release. All feature branches merge here first.
feature/<name>  ← new work, branched off develop, merged back to develop.
release/<ver>   ← stabilization, branched off develop, merged to main (tagged) + back to develop.
hotfix/<name>   ← urgent production fix, branched off main, merged to main (tagged) + back to develop.
```

## 3. Contracts

**Semantic versioning — when to bump which number (the core rule)**

| Bump | When | Examples |
|---|---|---|
| **MAJOR** | an incompatible / breaking change — a removed or renamed command, a changed flag, a dropped config key, a behavior change that breaks existing scripts or agents | rename `work-item` → `workitem`; drop `--mode`; change an exit code's meaning |
| **MINOR** | new functionality, backward-compatible — a new command, a new flag, a new auth mode | add `auth login --mode user`; add `--channel`/`--code` |
| **PATCH** | backward-compatible bug fix, doc/test-only, refactor with no behavior change | fix the loopback hint; add redaction; internal refactor |

- Pre-1.0 (`0.y.z`): `MINOR` may still break; the API is not yet stable. **`1.0.0` is the
  stability commitment** — from it on, the table above is the contract.
- A release that only fixes one thing is a PATCH. A release that adds a feature is a MINOR.
  Never ship a breaking change as a PATCH or MINOR.

**Branch merge rules**

- `feature/*` → `develop` (merge, no fast-forward preferred so the feature is visible).
- `release/*` → `main` (**tag here**, e.g. `v1.2.0`) **AND** back into `develop` (so fixes
  made during stabilization aren't lost).
- `hotfix/*` → `main` (**tag here**, e.g. `v1.2.1`) **AND** back into `develop`.
- `main` only ever moves forward via a tagged release or hotfix. No direct commits.
- The version in `package.json` is bumped on the release/hotfix branch **before** it merges to
  `main`, so the tagged commit carries the right number.

**Tags**

- Annotated tags: `vMAJOR.MINOR.PATCH` (e.g. `v1.0.0`, `v1.2.0`, `v1.2.1`).
- A tag is created on `main` at the release/hotfix merge commit and pushed (`git push origin v1.0.0`).
- Pre-releases tag too: `v2.0.0-rc.1`.

## 4. Validation & Error Matrix

| Condition | Action |
|---|---|
| Breaking change on a feature branch | bump `MAJOR` on the next release; note it in the commit/release notes |
| New flag/command | bump `MINOR` |
| Bug fix / refactor / docs | bump `PATCH` |
| About to cut a release | merge `develop` → `release/<ver>`, bump version, stabilize, then → `main` + tag + back to `develop` |
| Urgent prod fix | branch `hotfix/<name>` off `main`, fix, bump PATCH, → `main` + tag + back to `develop` |
| Version mismatch (tag vs `package.json`) | the tagged commit's `package.json` MUST equal the tag; reject/fix before tagging |

## 5. Good / Base / Bad Cases

- **Good:** a release that adds the user-token auth mode (backward-compatible) → `1.1.0`,
  tagged `v1.1.0`, merged release branch → `main` → back to `develop`.
- **Base:** a doc/test-only change → `1.0.1`, tagged `v1.0.1`.
- **Bad:** removing a command and shipping it as `1.0.1` (a PATCH) — it's a breaking change and
  must be `2.0.0`; or bumping to `1.0.0` then tagging a commit whose `package.json` still says
  `0.1.0`.

## 6. Tests Required (release checklist)

Before tagging a release, ALL of:

- [ ] `rtk npm run typecheck` — clean.
- [ ] `rtk npm test` — green (the suite gates behavior, and a MINOR/MAJOR must not regress).
- [ ] `rtk npm run build` — succeeds; `dist/bin/pingcode.js --version` prints the new version.
- [ ] `package.json` `version` equals the intended release number (no leading `v`).
- [ ] `src/version.ts` `VERSION` constant matches `package.json`.
- [ ] The tagged commit is on `main` and `origin/main` is in sync before tagging.
- [ ] Tag pushed: `git push origin vX.Y.Z`.
- [ ] GitHub Release created (automatically by tag push via `.github/workflows/release.yml`).

## 7. Release Flow (GitFlow)

Every feature follows this flow end-to-end:

```
feature/<name> (off develop)
    ↓ commit feature + version bump
    ↓ push → CI runs
    ↓ CI green → merge to develop
    ↓
release/<ver> (off develop, when ready to release)
    ↓ verify checklist above
    ↓ merge to main
    ↓ tag v<ver> on main
    ↓ push origin main v<ver> → triggers GitHub Release
    ↓ merge back to develop
```

**AI agents**: never push to `main` directly. Never create tags without explicit user instruction. Always use `feature/*` branches off `develop`.

## 7. Wrong vs Correct

#### Wrong — breaking change shipped as a patch, tagged off the wrong branch
```
# removed a flag, bumped PATCH, tagged from a feature branch
git checkout feature/thing
# version 1.0.1 in package.json, but a flag was removed → actually 2.0.0
git tag v1.0.1
```

#### Correct — release via the release branch, tagged on main, version matches
```
git checkout develop
git checkout -b release/1.1.0
# bump package.json to 1.1.0, stabilize, typecheck+test+build green
git checkout main
git merge --no-ff release/1.1.0
git tag -a v1.1.0 -m "release 1.1.0"
git checkout develop
git merge --no-ff release/1.1.0   # bring release fixes back
git push origin main develop v1.1.0
```

---

## Practical note for this repo (baseline)

- The first stable release is **`v1.0.0`**, tagged on `main`.
- `main` = production releases (tagged); `develop` = ongoing integration. New work branches off
  `develop`, never off `main`.
- Until `develop` exists, `main` also carries integration; once a feature is in flight, cut
  `develop` from `main` and move forward per the model above.
