# Design: delegate `self-update` to npm

## 1. What actually changes

Two things, and it is important not to conflate them.

**Before:** `self-update` is a self-built package manager. It downloads a tarball, extracts it to
`.staging`, verifies the staged bundle, swaps directories, re-verifies, and rolls back on failure.
~765 lines in `src/core/update.ts` + 259 lines of CLI orchestration, on top of `binShimPath`,
`detectPlatform`, `detectArch`, `installDir`, and a zip extractor.

**After:** `self-update` is a version check plus one npm invocation.

```
resolve npm as the sibling of process.execPath
        ↓
npm install -g pingcode-cli-unofficial@<version>
        ↓
read the installed version; it must equal <version>
```

npm owns downloading, extracting, in-place replacement, rollback via its own cache, and
multi-platform distribution. We own nothing in that chain.

## 2. The invariant that must survive the rewrite

The bug that started this whole session was never "it picked the wrong directory". It was **that it
reported success without having succeeded**. Everything in this design serves one rule:

> `self-update` may only report `updated` if npm exited 0 **and** the installed version matches the
> target.

Three distinct failure modes, each with its own message:

| condition | behaviour |
|---|---|
| no `npm` at `path.join(path.dirname(process.execPath), 'npm')` | fail, name the path tried |
| npm exits non-zero | fail, attach the exit status and output |
| npm exits 0, installed version ≠ target | fail, name both versions |

The third row is the one worth keeping. A non-zero exit is npm being honest; a zero exit with the
wrong version is npm (or a wrapper script, or a proxy) lying, and it is exactly the shape of the
bug we are removing. Re-verify after the install, not just trust the exit code.

## 3. Locating npm

`path.join(path.dirname(process.execPath), 'npm')`.

Rationale: `process.execPath` is the node binary actually running this process. npm ships as its
sibling in every npm installation (nvm, n, system packages, official installers). PATH is not a
reliable way to find it — cron and minimal environments run with a reduced PATH, and a user's
interactive shell PATH may resolve `npm` to a *different* installation than the node running us.

Windows: the sibling is `npm.cmd`. Use `npm` plus `shell: true` semantics appropriate to the
platform, or resolve `npm.cmd` on win32 — this needs a decision during implementation, and it is
the one platform-sensitive detail in the change.

## 4. New module boundary

Per `test/layering.test.ts`, `cli` must never contain `from 'node:fs'` and never contain
`buildUrl`. So the whole install operation is a `core` function.

New in `src/core/update.ts`:

```
resolveNpm(): string | undefined          // sibling of process.execPath; undefined if absent
installViaNpm(exec, version): Promise<void>  // spawn npm, throw on non-zero or version mismatch
readInstalledVersion(): string            // reads the installed package's own version
```

`runAutoUpdate` collapses to: lock → cooldown → `fetchLatestInfo` → compare → `installViaNpm` →
`syncSkills` → `{status:'updated',version}`. Errors still write a hint and release the lock.

`runSelfUpdate` (`src/cli/commands/selfUpdate.ts`) keeps its `--check-only` / `--dry-run` /
`--json` shape and loses everything between "download" and "report".

`checkForUpdate` (`src/core/update-check.ts`) is **untouched** — it is HTTP only and already has no
install logic, which is precisely why `--check-only` keeps working with no npm on the box.

## 5. Skills: new source, same target

`syncSkills` currently copies from `<install>/skills/pingcode`. With no install directory it
resolves the package's own directory:

```ts
// dist/bin/pingcode.js → ../skills/pingcode inside the npm package
new URL('../../skills/pingcode', import.meta.url)
```

The npm tarball still ships `skills/` (it is in `files`), so the payload is present — only the
lookup changes. `skillTargets(env)` is unchanged.

## 6. Version number

`.trellis/spec/guides/index.md` treats versioning as a rule, not a suggestion. This change removes a
documented install path (`scripts/install.mjs`, the release zips).

That is a breaking change to the published install contract, so the number is a MINOR bump to
**`1.9.0`**, not a PATCH. The argument for `2.0.0` (a documented install path disappears) was
considered and set aside at review: the *CLI* surface — commands, flags, exit codes, `--json` shape —
is unchanged, and the primary install path is already `npm i -g`, so the change moves an existing
minority path onto the supported one rather than removing a capability the CLI exposes.

Compatibility is not part of this reasoning. The project rule stated by the user is: **no migration
or backward-compatibility design at all** — there are no other users, so sweeping changes are
acceptable. Nothing in this task carries a migration path, a deprecation window, or a notice to
existing installs, and nothing should be added later for that reason.

## 7. Release automation

`.github/workflows/release.yml` attaches only the npm tarball. The idempotency guard and the
"published AND has assets" check added this session both stay, unchanged in logic — they simply see
one asset instead of seven. Do not weaken the asset-count check to `> 0` already-true; it is what
makes the guard distinguish a complete release from an empty one.

`.github/workflows/publish.yml` is unchanged.

## 8. Rollback

Reverting is one commit. Nothing about the npm tarball, the bundled deps, or the registry contents
changes, so a reverted install keeps working — users on 1.9.0 who ran `npm i -g` are on the same
artifact they would have been on either way.

## 9. What is explicitly not touched

- `tsup.config.ts` — `noExternal` and the `createRequire` banner stay. npm only extracts the
  tarball; self-containment is orthogonal to who installs it.
- The packed-artifact CI smoke in `release.yml` and `publish.yml`.
- `src/core/update-check.ts`, `checkForUpdate`, `fetchLatestInfo`.
- The runtime dependency list — still `commander` + `picocolors`.

## 10. No migration notice, by policy

Earlier drafts of this design said the command must detect that npm does not manage the running
binary and print the `npm i -g` command. That is dropped: the project does not design for migration,
and such a notice would only exist for installs this project no longer supports. The only surviving
requirement is the correctness one from §2 — never report `updated` without having succeeded.
