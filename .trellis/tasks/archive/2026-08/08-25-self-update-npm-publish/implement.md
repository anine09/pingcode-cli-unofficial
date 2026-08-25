# Implementation Plan: Self-Update via GitHub Releases

## Ordered Checklist

### Step 1: Pure-Node ZIP Extractor
- [ ] Create `src/core/zip.ts` — minimal ZIP reader (~100 lines)
- [ ] Export `extractZip(zipPath: string, destDir: string): Promise<string[]>` (list of extracted paths)
- [ ] Handle: deflate (method 8) via `zlib.inflateRawSync`, stored (method 0)
- [ ] Create `test/zip.test.ts` — test with a hand-crafted or fixture zip file
- [ ] Validation: `npm run typecheck && npm test test/zip.test.ts`

### Step 2: Install Directory Utility
- [ ] Create `src/core/paths.ts` — `installDir()`, `skillTargets()`, `binShimPath()`
- [ ] Export types for platform/arch detection
- [ ] Create `test/paths.test.ts`
- [ ] Validation: `npm run typecheck && npm test test/paths.test.ts`

### Step 3: Self-Update Command
- [ ] Create `src/cli/commands/selfUpdate.ts` — `registerSelfUpdateCommands(program: Command)`
- [ ] Implement full flow: check → download → extract → replace → sync skills → verify
- [ ] Flags: `--dry-run`, `--check-only`, `--force` (skip version check)
- [ ] Register in `src/cli/registry.ts` GROUPS array
- [ ] Create `test/selfUpdate.test.ts` — mock GitHub API, test flow logic
- [ ] Validation: `npm run typecheck && npm test test/selfUpdate.test.ts`

### Step 4: Update Check Hint
- [ ] Modify `src/bin/pingcode.ts:28` — change hint to `pingcode self-update`
- [ ] Update `test/update-check.test.ts` if it asserts on the hint text
- [ ] Validation: `npm test test/update-check.test.ts`

### Step 5: Release Packaging Script
- [ ] Create `scripts/package-release.ts`
- [ ] Build → zip dist/+skills/ → output to `release/`
- [ ] Add npm script: `"package:release": "node --experimental-strip-types scripts/package-release.ts"`
- [ ] Validation: `npm run package:release` produces valid zip files

### Step 6: Install Script Changes
- [ ] Modify `scripts/install.mjs` — detect repo vs standalone
- [ ] Add release download + extract to XDG dir for standalone mode
- [ ] Add bin shim creation (shell script on Unix, .cmd on Windows)
- [ ] Validation: test on current platform

### Step 7: Integration Verification
- [ ] `npm run typecheck` — clean
- [ ] `npm test` — all green
- [ ] `npm run build` — succeeds
- [ ] Manual test: `node dist/bin/pingcode.js self-update --check-only`
- [ ] Manual test: `node dist/bin/pingcode.js self-update --dry-run`

## Risky Files

| File | Risk | Mitigation |
|---|---|---|
| `src/cli/registry.ts` | GROUPS array order affects --help | Insert in logical position (after `settings`) |
| `scripts/install.mjs` | Breaking change for existing users | Detect repo checkout, preserve old flow |
| `src/bin/pingcode.ts` | Hint text change | Update test assertions |
| `src/core/zip.ts` | New code, edge cases | Thorough test with real zip fixtures |

## Rollback Points

- Each step is independently committable
- If Step 3 (self-update) has issues, Steps 1-2 (zip extractor + paths) are still useful
- Install script changes (Step 6) are additive — old `npm link` flow preserved

## Dependencies Between Steps

```
Step 1 (zip) ──┐
               ├──→ Step 3 (self-update command)
Step 2 (paths) ┘         │
                         ├──→ Step 4 (hint change)
                         │
Step 1 (zip) ────────────→ Step 5 (package script)
                         
Step 2 (paths) ──────────→ Step 6 (install script)
```

Steps 1 and 2 are independent and can be done in parallel.
Steps 5 and 6 are independent of Step 3.
Step 4 depends on Step 3 (command must exist before updating the hint).
