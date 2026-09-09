# Implementation Plan: self-contained self-update

## Ordered Checklist

### Step 1 — Bundle the frozen runtime deps
- [ ] `tsup.config.ts`: add `noExternal: ['commander', 'picocolors']` **and** the
      `esbuildOptions` `createRequire` banner shown in `design.md` §2. `noExternal` alone throws
      `Dynamic require of "events" is not supported` (verified); `shims: true` does not fix it
      (verified). Both keys are required — do not ship one without the other.
- [ ] Verify self-containment: `npm run build`, then `mv node_modules node_modules.bak && node dist/bin/pingcode.js --version && node dist/bin/pingcode.js --help && mv node_modules.bak node_modules`. Both must succeed.
- [ ] Verify the bundle: `dist/bin/pingcode.js` contains no bare `commander` / `picocolors` import specifiers.
- [ ] Record the post-build bundle size for the release notes (baseline 996.77 KB; bundled ≈ 1.08 MB, +~85 KB).

### Step 2 — Core update engine: gate before the swap, no npm install
- [ ] `src/core/update.ts`: add `verifyBundle(dir, exec, expectedVersion): string` — runs
      `node <dir>/dist/bin/pingcode.js --version`, returns trimmed output, throws `TransportError`
      with the `try running manually` hint, and throws when the output is not `expectedVersion`.
- [ ] `src/core/update.ts`: add `restoreBackup(current): void` — `renameSync(`${current}.backup`,
      current)`, `TransportError` on failure naming the manual restore command.
- [ ] `src/core/update.ts`: delete `verifyInstall` (superseded by `verifyBundle`); confirm no
      reference survives in `src/` or `test/`.
- [ ] `runAutoUpdate`: after `validateStaging`, call `verifyBundle(stagingDir, exec, newVersion)`
      (pre-swap gate).
- [ ] `runAutoUpdate`: delete the `exec('npm', ['install', '--production', ...])` block **and** its
      broken `atomicReplace(dir, `${dir}.backup`)` rollback.
- [ ] `runAutoUpdate`: after `syncSkills`, call `verifyBundle(dir, exec, newVersion)`; on failure
      `restoreBackup(dir)` then rethrow.

### Step 3 — Interactive self-update: same order
- [ ] `src/cli/commands/selfUpdate.ts`: hoist the `execFileSync` adapter into a local
      `const exec: ExecFn = ...` so both gates share it.
- [ ] After `validateStaging`, call `verifyBundle(stagingDir, exec, newVersion)` under the existing
      `Verifying...` line, before `atomicReplace`.
- [ ] Replace the post-swap `verifyInstall` call with `verifyBundle(install, exec, newVersion)`.
- [ ] On post-swap failure: `restoreBackup(install)`, then throw a `TransportError` whose hint names
      the manual restore command.
- [ ] `--dry-run` output unchanged.

### Step 4 — Regression tests
- [ ] `test/selfUpdate.test.ts`: extend the `runAutoUpdate` suite —
      (a) `exec` is never called with `npm`;
      (b) a staging bundle that fails to run aborts **before** the swap: install dir content
      unchanged, no `.backup` left, `.staging` cleaned;
      (c) a failed post-swap verify restores the backup so the install dir content equals the
      pre-update content;
      (d) a bundle reporting the wrong version is rejected.
      Follow the file's existing harness (fake `fetch` + injected `exec` + temp dirs); do not add a
      new root program or a real network call.
- [ ] New `test/updateArtifact.test.ts`: `verifyBundle` success / failure / wrong-version / missing
      hint, and `restoreBackup` success + failure, against a temp dir and a fake `exec`.
- [ ] New `test/buildArtifact.test.ts`: when `dist/bin/pingcode.js` exists, assert it contains no
      bare `commander` / `picocolors` specifier; skip when `dist/` is absent (unit tests do not
      build). This is the developer-local analogue of the CI gate.

### Step 5 — Simplify release packaging
- [ ] `scripts/package-release.ts`: remove `RUNTIME_DEPS`, `NODE_MODULES_DIR`, the `node_modules`
      copy step and the runtime-dep existence check.
- [ ] Rewrite its doc comment: deps are bundled into `dist/` by tsup; the zip payload is
      `dist/bin/pingcode.js` + `skills/pingcode/**`; the client needs Node ≥ 20 and nothing else.
- [ ] Leave `scripts/scan-secrets.ts` and `test/scan-secrets.test.ts` untouched (its
      `node_modules/` entry is a secret-scan denylist).

### Step 6 — Artifact-level CI gate
- [ ] `release.yml`: add a `smoke the packed npm tarball` step immediately after the existing
      `pack the npm tarball` step (`id: pack`) — `tar -xzf` into a `mktemp -d`, then run
      `node <tmp>/package/dist/bin/pingcode.js --version` and `--help`, guarded by
      `if: env.skip != 'true'`.
- [ ] `publish.yml`: add a `pack the npm tarball` step plus the same smoke step **before**
      `npm publish`.
- [ ] Re-read the `test/workflows.test.ts` contract in `design.md` §4 before editing: no new
      `npm run <script>`, no literal version, no `npm publish` / `NPM_TOKEN` / `paths:` / `tags:` in
      `release.yml`, required strings and their index order preserved, `uses:` still pinned.
- [ ] After merging, trigger each edited workflow once and read the run — a green push is not proof
      a workflow starts.

### Step 7 — Documentation
- [ ] README (~line 21): remove the claim that release tarballs ship their own `node_modules/`
      (`commander`, `picocolors`) and that an installed binary needs no `npm` on the client; state
      that the published artifact bundles both deps into `dist/`.
- [ ] README: add one sentence — a 1.8.1 / 1.8.2 install cannot self-update and must be reinstalled.
      No troubleshooting walkthrough (deliberate, see `prd.md` non-goals).

### Step 8 — Version bump and release
- [ ] `package.json` → `1.8.3`; `src/version.ts` `VERSION` → `1.8.3` (PATCH: backward-compatible
      bug fix).
- [ ] Commit `fix(self-update): bundle runtime deps so the npm tarball runs without node_modules`.
- [ ] After the auto-release: put the one-line 1.8.1 / 1.8.2 reinstall notice from step 7 into the
      v1.8.3 release body (`--generate-notes` will not carry it) and note the bundle-size delta.

## Validation Commands

```bash
npm run typecheck
npm test
npm run build
mv node_modules node_modules.bak && node dist/bin/pingcode.js --version && node dist/bin/pingcode.js --help && mv node_modules.bak node_modules
npm pack --silent --ignore-scripts && rm -rf /tmp/pc-smoke && mkdir -p /tmp/pc-smoke \
  && tar -xzf pingcode-cli-unofficial-1.8.3.tgz -C /tmp/pc-smoke \
  && node /tmp/pc-smoke/package/dist/bin/pingcode.js --version \
  && node /tmp/pc-smoke/package/dist/bin/pingcode.js --help
```

The last block is the local reproduction of the CI gate added in step 6.

## Review Gates

1. **After steps 1–3** — the update path is correct and the bundle is self-contained; typecheck +
   tests green. This is the only gate that must pass before anything else is merged.
2. **After step 4** — regression tests exist for the exact failure that reached the user, and none
   of them can pass against the old code.
3. **After steps 5–7** — packaging, CI and docs agree with what the artifact actually contains.
4. **After step 8** — version in lockstep, release body carries the reinstall notice.

## Rollback Points

- Steps 1–3 + 7–8 are one unit: reverting the bundle change alone would leave an update path with
  no dependency install at all.
- Step 4 is additive and safe to keep on revert.
- Step 6 can land or revert independently of the code changes.
- Step 5 depends on nothing and can move first if it helps the diff stay reviewable.

## Dependencies

```
1 ─┬─ 2 ─ 3 ─ 4 ─ 8
   └─ 7
5 (independent)
6 (independent)
```
