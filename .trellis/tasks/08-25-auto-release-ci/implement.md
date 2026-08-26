# Implementation Plan: Auto-release CI on version change

## Ordered Checklist

### Step 1: Sync CI workflows to develop
- [x] Copy `.github/workflows/ci.yml` from `main` to working tree
- [x] Copy `.github/workflows/catalog-check.yml` from `main` to working tree
- [x] Verify: all three workflow files present on develop

### Step 2: Rewrite release.yml
- [x] Remove old tag-based trigger (`push: tags: ['v*']`)
- [x] Add new trigger: `push: branches: [main] paths: ['package.json']`
- [x] Add version extraction step
- [x] Add idempotency check (skip if tag exists)
- [x] Add `npm run package:release` step
- [x] Update `gh release create` to include `release/*.zip`
- [x] Add tag creation step (after checks pass, before release)
- [x] Keep: npm tarball upload (for npm compatibility)
- [x] Verify: YAML is valid

### Step 3: Quality check
- [x] `npx tsc --noEmit` — no type errors
- [x] `npx eslint src/` — no lint errors
- [x] `npx vitest run` — all tests pass (2886/2886)
- [x] `npm run package:release` — produces 6 zips
- [x] Verify zip contents: 6 zips produced, 237K each

### Step 4: Integration verification (requires push to main)
- [ ] Push to `main` with version bump → release workflow triggers
- [ ] GitHub Release created with 6 zips
- [ ] `pingcode self-update --check-only` detects new version
- [ ] Re-push same version → no duplicate release

## Validation Commands

```bash
npx tsc --noEmit
npx eslint src/
npx vitest run
npm run package:release
```

## Rollback Points

- Step 1: pure file copy, no behavior change
- Step 2: workflow file change, testable by push
- If release.yml has issues, the old tag-based workflow can be restored from main
