# Design: Auto-release CI on version change

## Architecture

```
push to main (package.json version changed)
        │
        ▼
┌──────────────────────────┐
│  release.yml             │
│  (push to main, paths:   │
│   package.json)          │
└──────────┬───────────────┘
           │
     ┌─────┼─────────────────────┐
     │     │                     │
     ▼     ▼                     ▼
  detect   build              create
  version  zips               GitHub
  change   (6 platform        Release
  │        zips)               (6 zips)
  ▼
  if tag
  exists → skip
  else → continue
```

## Workflow: `release.yml` (replaces tag-driven trigger)

### Trigger

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'package.json'
```

No tag trigger. The version bump commit itself triggers the release.

### Jobs

#### `release` job

1. **Extract version** — read `version` from `package.json`.
2. **Check idempotency** — if tag `v{version}` already exists, skip (exit 0).
3. **Install + typecheck + test + build** — same as old release.yml.
4. **Package zips** — run `npm run package:release` (builds 6 zips in `release/`).
5. **Create tag** — `git tag v{version}` and push it.
6. **Create GitHub Release** — `gh release create v{version} release/*.zip --title v{version} --generate-notes`.

### Differences from old `release.yml`

| Aspect | Old | New |
|--------|-----|-----|
| Trigger | `push: tags: ['v*']` | `push: branches: [main] paths: ['package.json']` |
| Tag creation | Manual (user creates tag) | Auto (workflow creates tag after checks pass) |
| Artifacts | npm tarball only | npm tarball + 6 platform zips |
| Idempotency | N/A (tag is unique) | Check if tag exists before proceeding |

## CI workflows to sync to develop

From `main`, copy:
- `.github/workflows/ci.yml` — quality gate (push to main/develop/feature/* + PRs)
- `.github/workflows/catalog-check.yml` — weekly catalog drift check

These already exist on `main` and are battle-tested.

## Compatibility

- The `self-update` command (`src/cli/commands/selfUpdate.ts`) already expects
  zips named `pingcode-cli-v{version}-{platform}-{arch}.zip` — no change needed.
- `scripts/package-release.ts` already produces correctly-named zips — no change needed.
- Old tag-based workflow is removed; the new push-based workflow creates tags automatically.

## Rollback

If the auto-release creates a bad release:
1. Delete the GitHub Release: `gh release delete v{version}`
2. Delete the tag: `git push origin :refs/tags/v{version}`
3. Fix the issue, bump version again.
