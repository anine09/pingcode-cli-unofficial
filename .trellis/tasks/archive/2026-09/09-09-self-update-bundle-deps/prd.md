# Fix broken self-update: bundle runtime deps into dist and gate the published tarball

## Goal

`pingcode self-update` (1.8.1 → 1.8.2) installs a binary that cannot start: the npm tarball ships
`dist/` without `node_modules/`, while tsup leaves `commander` and `picocolors` external, so
`node dist/bin/pingcode.js` dies with `ERR_MODULE_NOT_FOUND`. Because the failure happens *after*
the atomic swap and the backup is deleted on swap success, the user is left with an unusable install
and no way to self-heal.

Ship 1.8.3 with a **self-contained bundle**, a **verify-before-swap** update path in both update
engines, and a **CI gate that actually runs the published artifact**.

Users already stranded on 1.8.1 / 1.8.2 are **out of scope for recovery**: those installs cannot run
the CLI at all, so they are treated as requiring a **fresh reinstall** rather than an in-band repair.
This task therefore does not write recovery instructions, and the release notes only need to state
that 1.8.1 / 1.8.2 users must reinstall.

## Background

- v1.8.0 (`661d7f3`) migrated the update source from GitHub release zips to the **npm registry
  tarball**. The zips, built by `scripts/package-release.ts`, shipped `node_modules/{commander,
  picocolors}` (added in `7db7fef` / `a995227`).
- The npm tarball **cannot** contain `node_modules/`: `package.json` `files` is
  `["dist", "skills", "README.md"]`, and npm only ever adds `package.json` / README / LICENSE on top
  of `files`.
- tsup is configured without `noExternal`, so `dist/bin/pingcode.js` carries
  `import pc from "picocolors"` and `import { Option } from "commander"`.
- The interactive command `src/cli/commands/selfUpdate.ts` never installs dependencies. The
  background engine `src/core/update.ts` (`runAutoUpdate`) got `npm install --production` in v1.8.1
  (`3448d32`), but its rollback branch is itself broken: `atomicReplace(dir, `${dir}.backup`)` passes
  a path that is **not nested** under `dir`, so `atomicReplace` treats it as `incoming` and the
  restore collides with the existing backup — it fails silently inside `catch { /* best-effort */ }`.
- CI never caught it: `release.yml` smokes the binary **inside the checkout**, where `node_modules/`
  exists. Nothing runs the *packed* artifact.

## Requirements

### R1 — Self-contained bundle

- `dist/bin/pingcode.js` must resolve `commander` and `picocolors` with no `node_modules/` present
  next to it. Achieved by tsup `noExternal`, **not** by shipping a dependency payload or by adding a
  runtime dependency.
- The bundle must still behave identically: `--version`, `--help`, every command group.

### R2 — Verify before the swap (both update paths)

- `runAutoUpdate` (`src/core/update.ts`) and `runSelfUpdate` (`src/cli/commands/selfUpdate.ts`) must
  both execute the staged bundle (`node <staging>/dist/bin/pingcode.js --version`) **before**
  `atomicReplace`, and re-verify the installed bundle after the swap.
- A failed pre-swap verify must abort with the install directory untouched, no `.backup` left behind,
  and staging cleaned.
- A failed post-swap verify must restore the backup via an explicit restore step, not by abusing
  `atomicReplace`.
- The version reported by the installed bundle must match the version that was downloaded.

### R3 — No dependency install at update time

- `npm install --production` (and its broken rollback) is removed from the update path. The update
  installs no packages, resolves no package manager, and no longer requires `npm` on the client.
- `dependencies` stays in `package.json` — the build needs it.

### R4 — Artifact-level regression gate

- CI must pack the artifact, extract it to a temp directory, and run it there. This is the gate that
  would have caught this bug; the in-checkout smoke must not be the only one.
- The gate covers the npm tarball (the artifact `self-update` actually downloads) in both
  `publish.yml` and `release.yml`.

### R5 — Simpler release packaging

- `scripts/package-release.ts` no longer carries a `node_modules/` payload nor a `RUNTIME_DEPS`
  existence check. Its doc comment must state the new truth (deps are bundled into `dist/`).
- `scripts/scan-secrets.ts` keeps its `node_modules/` scan-skip prefix — it is a denylist for secret
  scanning, unrelated to the release payload, and `test/scan-secrets.test.ts` pins it. No change.

### R6 — Correct documentation

- The README claim that release tarballs ship their own `node_modules/` is removed and replaced with
  the bundled-deps reality.
- One sentence states that a 1.8.1 / 1.8.2 install cannot self-update and must be reinstalled. No
  troubleshooting walkthrough — by decision, those users reinstall rather than repair.

### R7 — Release 1.8.3

- `package.json` and `src/version.ts` bumped in lockstep to `1.8.3` (PATCH — a backward-compatible
  bug fix).
- The v1.8.3 release body states that 1.8.1 / 1.8.2 users must reinstall (`--generate-notes` will
  not carry it).

## Acceptance Criteria

- [ ] With `node_modules/` renamed away from a fresh build, `node dist/bin/pingcode.js --version` and
      `--help` both succeed.
- [ ] `dist/bin/pingcode.js` contains no bare `commander` / `picocolors` import specifiers.
- [ ] A unit test proves `runAutoUpdate` never invokes `npm`.
- [ ] A unit test proves a staging bundle that fails to run aborts **before** the swap: the install
      directory is unchanged, no `.backup` remains, staging is cleaned.
- [ ] A unit test proves a failed post-swap verify restores the backup (install directory content
      equals the pre-update content).
- [ ] A unit test proves `runAutoUpdate`'s rollback path is reachable and correct — i.e. the
      previous silently-broken branch is gone, not just unused.
- [ ] `npm pack` output, extracted into an empty temp dir, runs `--version` and `--help`.
- [ ] The above is asserted in CI for the npm tarball in both `publish.yml` and `release.yml`, and
      `test/workflows.test.ts` still passes (its textual contract is unchanged).
- [ ] `scripts/package-release.ts` has no `node_modules` payload and its comment matches reality.
- [ ] README no longer claims the release tarballs ship `node_modules/`; it states in one sentence
      that a 1.8.1 / 1.8.2 install must be reinstalled.
- [ ] `package.json` and `src/version.ts` both read `1.8.3`.
- [ ] `npm run typecheck && npm test` green.

## Non-Goals (deliberate, recorded so they are not silently re-litigated)

- **Dropping the GitHub release zips.** The npm tarball now covers every platform, so the 6 zips and
  `scripts/package-release.ts` are redundant. Removing them would mean rewriting
  `test/workflows.test.ts` (which pins the zip path) and touching the install script and README in
  the same commit as a P0 bug fix. Tracked as follow-up.
- **Changing `atomicReplace`'s signature.** It stays a two-argument
  `(current, staging)` swap; the restore path gets its own exported helper instead.
- **Any new runtime dependency.** The frozen list stays `commander` + `picocolors`.
- **No in-band recovery for 1.8.1 / 1.8.2 installs.** Their binary does not start, so the project
  position is *reinstall*. No migration script, no repair instructions, no npm fallback documented.

## Constraints (from `.trellis/spec/backend/quality-guidelines.md`)

- Done means `npm run typecheck && npm test`. `npm run build` plus a
  `node dist/bin/pingcode.js --help` walk is the release check.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `moduleResolution: bundler`.
- `test/layering.test.ts` enforces `cli → {api, core}`, `api → core`, `core` imports neither, and
  `node:fs` / `buildUrl` must not appear in `cli/`. The restore helper therefore belongs in `core`.
- Zero network in unit tests; `fetch` is injected via `Ctx`.
- New behaviour ships with a regression test in the same commit.

## Notes

- Keep this file to requirements, constraints, and acceptance criteria. Technical design lives in
  `design.md`; the ordered execution plan lives in `implement.md`.
