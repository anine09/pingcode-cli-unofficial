# Implementation Plan: delegate `self-update` to npm

## Ordered Checklist

### Step 1 — npm resolution and invocation in `core`

- [ ] `src/core/update.ts`: add `resolveNpm(): string | undefined` — returns
      `path.join(path.dirname(process.execPath), 'npm')`, or `npm.cmd` on win32, or `undefined` when
      neither exists. Must live in `core`: `test/layering.test.ts` forbids `node:fs` in `cli`.
- [ ] Add `installViaNpm(exec, version): Promise<void>` — runs the resolved npm, throws on non-zero
      exit with the output attached, throws on a version mismatch naming both versions.
- [ ] Add `readInstalledVersion(): string | undefined` — reads the installed package's own
      `package.json` version. Decide during implementation whether this reads the npm global prefix
      or the running module; prefer the latter, it is more local and needs no prefix lookup.

### Step 2 — Rewrite `runAutoUpdate`

- [ ] Keep the lock / cooldown / hint shell exactly as-is.
- [ ] Replace everything between `fetchLatestInfo` and `{status:'updated'}` with: compare versions →
      `installViaNpm` → `syncSkills` (new source, step 4).
- [ ] Delete `downloadTarball`, `extractTarball`, `validateStaging`, `atomicReplace`, `verifyBundle`,
      `restoreBackup`, `cleanStaging`, the tmp-tgz write/remove, `ensureDir`.
- [ ] `finally` still releases the lock.

### Step 3 — Rewrite `runSelfUpdate`

- [ ] `src/cli/commands/selfUpdate.ts`: keep `--check-only`, `--force`, `--dry-run`, `--json` and
      `printCheckResult`. Drop the download/extract/staging/swap steps and `printDryRunPlan`'s
      install-dir fields.
- [ ] Three failure modes, each its own message: npm missing (name the path), npm non-zero (attach
      output), npm zero but version mismatch (name both versions).
- [ ] `--json` keeps stdout JSON-only; diagnostics to stderr.

### Step 4 — Skills from the package directory

- [ ] `syncSkills` source becomes `new URL('../../skills/pingcode', import.meta.url)` instead of
      `<install>/skills/pingcode`.
- [ ] `skillTargets(env)` unchanged.

### Step 5 — Delete the dead surface

- [ ] Delete `scripts/install.mjs`, `scripts/package-release.ts`, and the `install:cli` /
      `package:release` entries from `package.json` scripts.
- [ ] `src/core/paths.ts`: remove `installDir`, `binShimPath`, `detectPlatform`, `detectArch` — but
      **search first** (`.trellis/spec/guides/index.md` Pre-Modification Rule). Known consumers to
      clear: `src/cli/commands/skill.ts`, `src/core/skill-ops.ts`,
      `src/cli/commands/selfUpdate.ts`, `test/selfUpdate.test.ts`, `test/paths.test.ts`.
- [ ] Delete `src/core/zip.ts` + `test/zip.test.ts` if unused after the above; verify before
      deleting.
- [ ] Delete the corresponding suites in `test/paths.test.ts` and rewrite
      `test/selfUpdate.test.ts` (most of it covers the removed flow).
- [ ] `test/updateArtifact.test.ts` (written for the previous task) covers `verifyBundle` /
      `restoreBackup` — delete it.

### Step 6 — Tests for the new behaviour

- [ ] `resolveNpm` with an injected fake `execPath` resolves to the expected sibling; returns
      `undefined` when absent.
- [ ] `installViaNpm`: non-zero exit → throw with output; zero exit + wrong version → throw naming
      both versions; zero exit + right version → resolve.
- [ ] `runAutoUpdate` never invokes a download and never mentions `.staging`; lock/cooldown/hint
      behaviour unchanged.
- [ ] `self-update --check-only` succeeds with `resolveNpm()` returning `undefined`.
- [ ] `syncSkills` copies from the package's own `skills/`.

### Step 7 — Release automation and docs

- [ ] `.github/workflows/release.yml`: remove the 6 zip-packaging steps. Keep the npm tarball pack,
      the packed-artifact smoke, and the idempotency / asset-count guard untouched.
- [ ] `test/workflows.test.ts`: drop `npm run package:release`, `install zip`,
      `release/pingcode-cli-v*.zip`. Keep the guard, asset-count, `gh release upload` and
      `--clobber` assertions. Do not weaken `-gt 0`.
- [ ] README: `npm i -g pingcode-cli-unofficial` as the only install path. Remove zip
      instructions. Keep the 1.8.1/1.8.2 reinstall sentence (still true) and the bundled-deps note.
- [ ] `.trellis/spec/` if the layering or docs rules change.

### Step 8 — Version bump

- [ ] `package.json` and `src/version.ts` to `1.9.0` (MINOR — the install method moves onto the
      already-supported `npm i -g`, CLI surface unchanged; see `design.md` §6). Already confirmed at
      review; the arguable alternative was `2.0.0`.
- [ ] Release body: state that `self-update` now requires npm and delegates to `npm i -g`. No
      migration instructions for older installs — that is deliberate policy, not an omission
      (`design.md` §10).

## Validation Commands

```bash
npm run typecheck
npm test
npm run build && node dist/bin/pingcode.js --version && node dist/bin/pingcode.js --help
git grep -n "install:cli\|package:release\|binShimPath\|detectArch\|detectPlatform\|atomicReplace\|verifyBundle\|restoreBackup\|\.staging"
npm pack --silent --ignore-scripts && rm -rf /tmp/pc-smoke && mkdir -p /tmp/pc-smoke \
  && tar -xzf pingcode-cli-unofficial-*.tgz -C /tmp/pc-smoke \
  && node /tmp/pc-smoke/package/dist/bin/pingcode.js --version
```

The last block must still pass — it is the guard on the one thing that must **not** change.

## Review Gates

1. **After steps 1–4** — the npm path works and the invariant holds. Typecheck + tests green.
2. **After steps 5–6** — the deleted code is really gone (`git grep` returns nothing) and the new
   behaviour has tests. This is the gate most likely to be rushed.
3. **After steps 7–8** — CI, tests and docs agree on a one-artifact release.

## Rollback Points

- Steps 1–4 + 8 are one unit: a reverted bundle change alone would leave a `self-update` that
  neither installs nor reports why not.
- Steps 5–6 are deletions; reverting them restores the old code but not the old release artifacts.
- Step 7 can land or revert independently.

## Dependencies

```
1 ─ 2 ─┬─ 6
3 ─────┘
4 ─────┘
5 (independent)
7 (independent)
8 (after 1–4)
```

## Parallelisation

Two disjoint write scopes, so two lanes:

- **Lane A** (steps 1–4, 6, 8): `src/core/update.ts`, `src/cli/commands/selfUpdate.ts`,
  `package.json`, `src/version.ts`, and the new/rewritten tests.
- **Lane B** (steps 5, 7): `src/core/paths.ts`, `src/cli/commands/skill.ts`,
  `src/core/skill-ops.ts`, `src/core/zip.ts`, `scripts/`, `.github/workflows/release.yml`,
  `test/workflows.test.ts`, `test/zip.test.ts`, `test/paths.test.ts`, README.

The only coupling: lane B's deletions in `src/cli/commands/skill.ts` and
`src/cli/commands/selfUpdate.ts` touch files lane A rewrites. Sequence lane A first, then lane B, or
have lane B not touch those two files and fix them in a follow-up commit.
