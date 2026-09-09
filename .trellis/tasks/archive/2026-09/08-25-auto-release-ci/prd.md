# Auto-release CI on version change

## Goal

When `package.json` version changes on a push to `main`, automatically build, test,
package 6 platform zips, and create a GitHub Release with all assets attached.
Also sync the existing CI workflows from `main` to `develop`.

## Requirements

1. **Sync CI workflows to develop** — copy `.github/workflows/{ci,catalog-check}.yml`
   from `main` to `develop` so the `develop` branch also has CI/CD gates.
2. **Auto-trigger release on version change** — a push to `main` that changes
   `package.json` (version field) automatically triggers a release build.
   No manual `git tag` required.
3. **Build 6 platform zips** — run `scripts/package-release.ts` to produce
   `pingcode-cli-v{version}-{linux,darwin,win32}-{x64,arm64}.zip`.
4. **Upload all zips to GitHub Release** — the release includes 6 platform zips
   plus the npm tarball.
5. **Self-update compatibility** — the `self-update` command downloads the
   correct platform zip from the release. Asset naming must match:
   `pingcode-cli-v{version}-{platform}-{arch}.zip`.
6. **Idempotent** — if a release for the same version already exists, skip.

## Non-Goals

- npm registry publish (package name not claimed yet).
- Cross-OS CI matrix (Ubuntu only).
- Auto-bumping the version (version bump is still a manual commit).
- CHANGELOG generation.

## Acceptance Criteria

- [ ] AC1: `.github/workflows/` exists on `develop` with `ci.yml` and `catalog-check.yml`.
- [ ] AC2: Push to `main` with `package.json` version bump triggers release workflow.
- [ ] AC3: GitHub Release is created with 6 platform zips attached.
- [ ] AC4: `pingcode self-update` can download and install from the new release.
- [ ] AC5: Re-pushing the same version does not create a duplicate release.
- [ ] AC6: All existing CI checks (typecheck, test, build, smoke, secret scan) pass.
- [ ] AC7: No new dependencies in `package.json`.
