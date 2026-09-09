# Delegate `self-update` to npm and remove the standalone install paths

## Goal

Stop maintaining our own install/update machinery. `self-update` becomes a thin wrapper over
`npm i -g`, the standalone install paths (`scripts/install.mjs`, the 6 platform zips, the CI
zip-packaging steps) are deleted, and roughly 700 lines of download/extract/swap/verify/rollback
code go with them.

The npm tarball remains the shipping artifact and **keeps its bundled runtime deps** — this is an
orthogonal fix that must not be reverted.

## Background

- `self-update` installs into a hardcoded `~/.local/share/pingcode-cli` and reports `updated` even
  when the binary on PATH lives elsewhere. On this machine `which pingcode` resolves to an nvm global
  install, so self-update has never updated the binary that actually runs. The failure is not that
  it picks the wrong directory — it is that it **reports success without having succeeded**.
- The current update path is self-built: download the tarball, extract to staging, verify, atomic
  swap, re-verify, restore on failure. It took ~765 lines in `src/core/update.ts` plus 259 lines of
  CLI orchestration, and it still got the failure mode above wrong.
- npm already implements install, in-place replacement, rollback via its own registry cache, and
  multi-platform distribution through one tarball. Every surface we maintain has an npm equivalent.
- The fix that shipped earlier this session (tsup `noExternal` + `createRequire` banner) is
  orthogonal: npm only extracts the tarball into `node_modules`. Self-containment of the artifact is
  independent of *who installs it*.

## Decisions already made with the user

1. **Remove the non-npm paths entirely** — `scripts/install.mjs`, the 6 platform zips, the CI
   zip-packaging steps, README zip-install instructions.
2. **Locate `npm` as the sibling of the running node binary**
   (`path.join(path.dirname(process.execPath), 'npm')`), not via PATH — PATH is unreliable under
   cron or a minimal environment.
3. **When npm is missing or `npm i -g` lacks permission: refuse and say so. Never report `updated`.**
4. **`--check-only` stays npm-free** — it is plain HTTP against the registry, and must keep working
   with no npm process on the box.

## Requirements

### R1 — `self-update` delegates to npm

- The install step runs `npm install -g pingcode-cli-unofficial@<version>` using the npm binary
  resolved as the sibling of `process.execPath`.
- The command inherits the user's terminal so npm's own progress output is visible.
- Success is determined by npm's exit code **plus** a post-install verification that the running
  package now reports the expected version.
- Failure is determined by npm's non-zero exit code. On failure the command must report failure with
  npm's output attached — never `updated`.

### R2 — Never report success without succeeding (the invariant)

- If npm cannot be found at the expected path, fail with a message naming the path that was tried.
- If npm exits non-zero, fail with the exit status and the captured output.
- If npm exits zero but the installed version does not match the target, fail and say both versions.
- `--json` output must carry the failure on stdout as JSON only; all human-readable diagnostics go
  to stderr (per `.trellis/spec/backend/index.md`).

### R3 — `--check-only` and the version-check path stay npm-free

- `checkForUpdate` / `fetchLatestInfo` are unchanged: HTTP against the registry, cache, cooldown,
  opt-out env var.
- `self-update --check-only` must work on a machine with no npm installed at all.

### R4 — Delete the standalone install paths

- `scripts/install.mjs` and the `install:cli` npm script are removed.
- `scripts/package-release.ts` and the `package:release` npm script are removed.
- The zip-packaging steps are removed from `.github/workflows/release.yml`.
- README zip-install instructions are removed; the README documents `npm i -g` as the only install
  path.
- This absorbs the previously recorded follow-up "drop the redundant GitHub release zips".

### R5 — Delete the now-dead update machinery

- Removed from `src/core/update.ts`: `downloadTarball`, `extractTarball`, `validateStaging`,
  `atomicReplace`, `verifyBundle`, `restoreBackup`, `cleanStaging`, the tmp-tgz write/remove,
  `ensureDir`.
- Removed from `src/core/paths.ts`: `installDir`, `binShimPath`, `detectPlatform`, `detectArch`
  (verify each is unused first — the Pre-Modification Rule requires a search before removal).
- `src/core/zip.ts` and `test/zip.test.ts` removed if unused after the above.
- Survives: `checkForUpdate`, `fetchLatestInfo`, `syncSkills` (with its source changed, see R6),
  the hint/cooldown/lock state.

### R6 — Skills still sync, from a new source

- `syncSkills` currently copies from `<install>/skills/pingcode`. With no install directory it must
  resolve the package's own `skills/` relative to the running module (`import.meta.url`), because
  the npm tarball still ships `skills/`.
- `skillTargets(env)` is unchanged.

### R7 — The tsup bundling fix stays

- `noExternal: ['commander', 'picocolors']` and the `createRequire` banner in `tsup.config.ts` are
  **not** touched. Removing them restores `ERR_MODULE_NOT_FOUND` inside `node_modules`.
- The CI packed-artifact smoke in `release.yml` and `publish.yml` is **not** touched.

### R8 — Release automation keeps working

- `.github/workflows/release.yml` attaches only the npm tarball (no zips).
- `test/workflows.test.ts` is updated to match: the zip assertions, `npm run package:release`,
  `install zip`, and `release/pingcode-cli-v*.zip` come out; the idempotency and asset-count
  assertions stay.
- The asset-count guard added this session must keep working for a release with exactly one asset.

## Acceptance Criteria

- [ ] `self-update` with no `--check-only` runs `npm i -g pingcode-cli-unofficial@<version>` and
      reports success only when npm exits 0 and the version matches.
- [ ] npm resolved as `path.join(path.dirname(process.execPath), 'npm')`; a unit test injects a
      fake `execPath` and asserts the resolved path.
- [ ] Missing npm binary → non-zero exit, message names the tried path, output contains no
      `updated`.
- [ ] npm non-zero exit → non-zero exit, failure reported with the output attached.
- [ ] npm exits 0 but version does not match → failure naming both versions.
- [ ] `self-update --check-only` succeeds with no npm binary present at all.
- [ ] `--json` mode puts only JSON on stdout; diagnostics on stderr.
- [ ] `syncSkills` copies from the package's own `skills/` directory, not an install directory.
- [ ] `scripts/install.mjs`, `scripts/package-release.ts`, `src/core/zip.ts` and their npm scripts
      are gone; `git grep` for `install:cli` / `package:release` returns nothing.
- [ ] No zip-packaging step remains in `.github/workflows/release.yml`.
- [ ] `test/workflows.test.ts` passes and no longer asserts zips; the idempotency and asset-count
      assertions still pass.
- [ ] `tsup.config.ts` still has `noExternal` and the `createRequire` banner; `npm pack` output
      extracted to an empty dir still runs `--version` and `--help`.
- [ ] `npm run typecheck && npm test` green.
- [ ] README documents `npm i -g` as the only install path and no longer mentions zips.

## Non-Goals

- **Any change to the npm tarball's contents or the bundled-deps fix.** Orthogonal and already
  shipped.
- **Supporting the GitHub release zip as an install path.** Removed, deliberately.
- **Pinning the npm version or adding an npm version check.** If the sibling npm cannot parse our
  arguments that is npm's problem, not ours.
- **Any migration path or backward-compatibility surface.** The project designs without migration:
  there are no other users, so sweeping changes are acceptable. Older installs are not supported and
  the CLI does not tell them what to do. This is deliberate policy, not an omission.
- **Adding a runtime dependency.** The frozen list stays `commander` + `picocolors`.

## Constraints

- `cli` must never import `node:fs` and must never contain `buildUrl`
  (`test/layering.test.ts`). All filesystem work belongs in `core`.
- No network in unit tests; `exec` and `fetch` are injected.
- New behaviour ships with a regression test in the same commit.
- Version bump per `.trellis/spec/guides/index.md`. Removing a documented install path is
  user-visible, so this is not a PATCH — see `design.md` §6 for the number (`1.9.0`, MINOR).
