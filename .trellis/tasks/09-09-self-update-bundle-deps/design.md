# Design: bundle runtime deps, verify-before-swap, artifact gate

## 1. Root cause restated as a state machine

```
today (1.8.2)                          npm tarball content            node_modules/ on client
─────────────────                      ──────────────────             ──────────────────────
download tgz                           dist/bin/pingcode.js           absent
extract → <install>/.staging           skills/                        (npm `files` forbids it)
validateStaging  (file exists? yes)    package.json
atomicReplace   (swap)                 ← imports "picocolors" / "commander" left external
syncSkills
verifyInstall   → node … --version  ✗  unresolvable import
backup already deleted                ⇒ install is dead, no rollback
```

Two independent defects compound: the **bundle is not self-contained**, and the **update path has no
gate before the point of no return**. Both are fixed. Fixing only the first would leave the second
bug live; fixing only the second would turn every update into a clean rollback instead of a working
install.

---

## 2. The bundle: tsup `noExternal`

`tsup.config.ts` gains two keys:

```ts
noExternal: ['commander', 'picocolors'],
esbuildOptions(options) {
  options.banner = {
    ...options.banner,
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  };
},
```

**Why both.** Verified empirically, not assumed:

| Attempt | Result |
|---|---|
| Baseline (`noExternal` absent) | Reproduces the user's error exactly: `npm pack` → extract to an empty dir → `ERR_MODULE_NOT_FOUND: Cannot find package 'picocolors'`. |
| `noExternal` alone | `Error: Dynamic require of "events" is not supported`. Commander resolves to its CJS build, whose `require("events" | "child_process" | "path" | "fs" | "process")` calls land on esbuild's interop helper — and an ESM output has no `require` to call. |
| `noExternal` + `shims: true` | Same failure. tsup 8.5's `shims` does not inject `createRequire` into the ESM output (verified: zero `createRequire` occurrences in the bundle). |
| **`noExternal` + `createRequire` banner** | **Works.** `--version` → `1.8.2`; `--help` → exit 0; the extracted tarball runs with no `node_modules/` present. |

The banner is 2 lines and is the standard esbuild escape hatch for "bundle a CJS dependency into
ESM for Node". Alternatives considered and rejected: emitting CJS (`format: ['cjs']`) breaks
`package.json#type: module` and the `bin` field; shipping a dependency payload is impossible in an
npm tarball (§1) and requires `npm` on the client when done from the CLI.

Bundle size measured: `996.77 KB` → `1.08 MB` (**+~85 KB**).

Chosen over the alternatives because:

| Option | Verdict |
|---|---|
| `noExternal` + banner for the two frozen deps | **Chosen.** One config block, no payload, works for the npm tarball *and* the GitHub zips, no `npm` on the client. |
| Add `node_modules/` to `package.json#files` | Impossible: npm only ever adds `package.json` / README / LICENSE on top of `files`. |
| Keep shipping `node_modules/` in the zip and add an install step to the CLI | Requires `npm` on the client, adds a network + filesystem step to a pure copy operation, and is exactly what failed in 1.8.1. |

Combination used (`format: ['esm']`, `platform: 'node'`, `splitting: false`, `target: 'node20'`) is a
supported one for `noExternal`; esbuild inlines both packages into the single output file. Both
packages are pure JS with zero transitive runtime deps, so the bundle grows by ~120 KB and nothing
else changes.

`dependencies` stays in `package.json` — the build and `tsc` still resolve them; only the *runtime
resolution* moves into the bundle.

**Verification (not assumed):** after the build, rename `node_modules/` aside and run
`node dist/bin/pingcode.js --version` and `--help`. Both must succeed. Then assert the output
contains no bare `commander` / `picocolors` specifiers.

> Already verified once, out of band, before implementation: the packed tarball extracted into an
> empty temp dir ran `--version` and `--help` with exit 0. The verification step above is repeated
> as part of step 1 of `implement.md` so the property is re-proven on the real commit.

---

## 3. The update path: gate before the point of no return

### 3.1 New / changed exports in `src/core/update.ts`

| Export | Change |
|---|---|
| `verifyBundle(dir, exec): string` | **New.** Runs `node <dir>/dist/bin/pingcode.js --version`, returns the trimmed output. Carries the existing `TransportError` + `try running manually` hint from `verifyInstall`. Called **twice**: once on staging (pre-swap), once on the install dir (post-swap). Throws when the reported version does not equal the expected version. |
| `restoreBackup(current): void` | **New.** `renameSync(`${current}.backup`, current)`, wrapped so a failure throws a `TransportError` that names the manual restore command. Replaces the ab-`atomicReplace`-as-restore trick. |
| `verifyInstall` | **Deleted.** Superseded by `verifyBundle`. |
| `atomicReplace(current, staging)` | **Unchanged.** Still the two-argument swap with the nested-`staging` → `.incoming` dance. Deliberately not extended into a restore primitive — see §5 non-goals. |
| `validateStaging(dir): boolean` | **Unchanged** (existence only). Kept as the cheap shape check; `verifyBundle` is the loadability check. Running it on staging is what catches a broken bundle. |

`restoreBackup` lives in `core`, not `cli`, because `test/layering.test.ts` forbids `node:fs` in
`cli/`.

`ExecFn` is unchanged, so the existing injectable-exec seam covers both new call sites.

### 3.2 `runAutoUpdate` (`src/core/update.ts`)

```diff
-      if (!validateStaging(stagingDir)) { … }
+      if (!validateStaging(stagingDir)) { … }
+      // Gate 1: the staged bundle must actually run, and must be the version we asked for.
+      verifyBundle(stagingDir, exec, newVersion);
 
       await atomicReplace(dir, stagingDir);
 
-      // Install runtime dependencies (npm tarball does not include node_modules).
-      try { exec('npm', ['install', '--production', '--prefix', dir]); }
-      catch (error) {
-        const backup = `${dir}.backup`;
-        try { atomicReplace(dir, backup); } catch { /* best-effort */ }
-        throw new TransportError(…);
-      }
-
       // Sync skills.
       …
-      verifyInstall(dir, exec);
+      // Gate 2: the installed bundle must run, or we put the backup back.
+      try {
+        verifyBundle(dir, exec, newVersion);
+      } catch (error) {
+        restoreBackup(dir);
+        throw error;
+      }
```

Outcome: `exec` is never called with `npm`; a broken tarball is rejected while the user's current
install is still intact; a post-swap failure restores instead of stranding.

### 3.3 `runSelfUpdate` (`src/cli/commands/selfUpdate.ts`)

Same order, plus the existing UX lines. The inline `execFileSync` adapter is hoisted into a local
`exec` so both gates share it:

```ts
const exec: ExecFn = (file, args) => String(execFileSync(file, args, { encoding: 'utf8' }));
```

Sequence: download → extract → `validateStaging` → **`verifyBundle(stagingDir, exec, newVersion)`**
(prints `Verifying...`) → `atomicReplace` → `syncSkills` →
**`verifyBundle(install, exec, newVersion)`**, on failure `restoreBackup(install)` + a
`TransportError` whose hint names the manual restore command.

`--dry-run` output is unchanged.

---

## 4. The regression gate that CI should have had

`release.yml` already packs the tarball (`npm pack --silent --ignore-scripts`, `id: pack`). Add a
step immediately after it that runs the *packed* artifact from an empty temp dir:

```yaml
      - name: smoke the packed npm tarball
        if: env.skip != 'true'
        env:
          TARBALL: ${{ steps.pack.outputs.tarball }}
        run: |
          dir="$(mktemp -d)"
          tar -xzf "${TARBALL}" -C "${dir}"
          node "${dir}/package/dist/bin/pingcode.js" --version
          node "${dir}/package/dist/bin/pingcode.js" --help
```

`publish.yml` (the workflow that actually publishes what `self-update` downloads) gets the same pack
+ smoke **before** `npm publish`, so a broken tarball can never reach the registry.

Contract with `test/workflows.test.ts` (text-level, no YAML parser): every `npm run <script>` used
must exist in `package.json`; `release.yml` must keep `npm ci` → `npm run typecheck` → `npm test` →
`npm run build` in that index order and must still contain `npm run package:release`, `install zip`,
`npm pack --silent`, `release/pingcode-cli-v*.zip`, `gh release create`, `--generate-notes`,
`git tag "v${VERSION}"`, `node dist/bin/pingcode.js --version`, `--help`; it must **not** contain a
literal version string, `npm publish`, `NPM_TOKEN`, `paths:` or `tags:`; all `uses:` stay pinned
`@vN`; job-level `env:` contexts stay in
`['github','inputs','matrix','needs','secrets','strategy','vars']`.

The new steps use only `npm pack`, `tar`, `node` and `mktemp` — no new `npm run` target, no new
`uses:`, no job-level `env:`, and the required strings and their relative order are untouched.
`tar` is present on the ubuntu-latest CI matrix. GitHub remains the only authoritative validator,
so each edited workflow is triggered once after the change and its run read.

---

## 5. Compatibility

| Surface | Before | After |
|---|---|---|
| Client prerequisites | Node ≥ 20 **and** `npm` on the update path | Node ≥ 20 only |
| Install dir contents | `dist/`, `skills/`, `node_modules/` | `dist/`, `skills/` |
| Bundle size | ~smaller | +~120 KB (both deps inlined) |
| `atomicReplace` signature | `(current, staging)` | unchanged |
| `--json` output shape for `self-update` | `status` / `previous_version` / `new_version` | unchanged |
| Exit codes | unchanged | unchanged |
| Existing installs with a stale `node_modules/` | — | left alone; harmless, and documented as such in the release notes |

A 1.8.1 / 1.8.2 install is treated as **reinstall**, not repair: its binary cannot start, so no
in-band recovery exists for it. The README carries one sentence to that effect and nothing more.

## Rollback

- Revert `tsup.config.ts`, `src/core/update.ts`, `src/cli/commands/selfUpdate.ts`,
  `scripts/package-release.ts`, README and the version bump together — steps 1–3 and 7–8 are one
  unit. The CI gate (step 6) can land or revert independently; the unit tests (step 4) are
  additive and safe to keep.

## Non-goals

- **`atomicReplace` does not gain a restore mode.** Restore is a different operation with different
  failure semantics; a dedicated `restoreBackup` is testable and obvious. Extending `atomicReplace`
  is how the current silent-failure bug came to exist.
- **GitHub release zips are not removed.** Redundant now, but removing them means rewriting
  `test/workflows.test.ts` in the same commit as a P0 fix. Follow-up task.
- **`scripts/scan-secrets.ts` keeps its `node_modules/` skip prefix** — it is a secret-scanning
  denylist, not a release payload; `test/scan-secrets.test.ts:140` pins it.
- **No automated migration for stranded users**, and no recovery instructions either: 1.8.1 /
  1.8.2 installs are reinstalled.
