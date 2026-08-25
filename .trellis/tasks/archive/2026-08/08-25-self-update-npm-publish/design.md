# Design: Self-Update via GitHub Releases

## Architecture

### Components

```
┌─────────────────────────────────────────────────────┐
│  scripts/package-release.ts  (build-time)           │
│  tsup build → zip dist/+skills/ → release artifacts │
└──────────────────────┬──────────────────────────────┘
                       │ uploads to GitHub Releases
                       ▼
┌─────────────────────────────────────────────────────┐
│  GitHub Releases                                     │
│  pingcode-cli-v1.5.2-linux-x64.zip                  │
│  pingcode-cli-v1.5.2-darwin-arm64.zip               │
│  pingcode-cli-v1.5.2-win32-x64.zip                  │
└──────────────────────┬──────────────────────────────┘
                       │ downloaded by
                       ▼
┌─────────────────────────────────────────────────────┐
│  src/cli/commands/selfUpdate.ts  (runtime)          │
│  check version → download zip → extract → replace   │
│  → sync skills → verify                             │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  scripts/install.mjs  (modified, first-time)        │
│  download release zip → extract to XDG dir → shim   │
└─────────────────────────────────────────────────────┘
```

### Install Directory (XDG)

```typescript
function installDir(): string {
  if (process.platform === 'win32') {
    // %LOCALAPPDATA%/pingcode-cli
    return path.join(
      process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'),
      'pingcode-cli',
    );
  }
  // Linux + macOS: $XDG_DATA_HOME/pingcode-cli or ~/.local/share/pingcode-cli
  const xdg = process.env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg !== '') return path.join(xdg, 'pingcode-cli');
  return path.join(os.homedir(), '.local', 'share', 'pingcode-cli');
}
```

Contents after install:
```
~/.local/share/pingcode-cli/
├── dist/bin/pingcode.js
└── skills/pingcode/
    ├── SKILL.md
    �└── modules/*.md
```

### Release Asset Naming

```
pingcode-cli-v{version}-{platform}-{arch}.zip
```

| Platform | arch values |
|---|---|
| `linux` | `x64`, `arm64` |
| `darwin` | `x64`, `arm64` |
| `win32` | `x64`, `arm64` |

### Zip Contents

```
dist/bin/pingcode.js
skills/pingcode/SKILL.md
skills/pingcode/modules/api.md
skills/pingcode/modules/cicd.md
skills/pingcode/modules/crosscutting.md
skills/pingcode/modules/pjm.md
skills/pingcode/modules/scm.md
skills/pingcode/modules/ship.md
skills/pingcode/modules/testhub.md
```

## Self-Update Flow

```
1. checkForUpdate()         → reuse existing GitHub API check
2. if up-to-date → exit 0   → "already up to date"
3. detectPlatformArch()     → { platform, arch } for asset name
4. fetchReleaseAssets()     → GET /releases/latest, find matching .zip
5. downloadToTemp()         → stream zip to os.tmpdir()
6. extractToStaging()       → pure-Node ZIP extractor to staging dir
7. validate()               → check dist/bin/pingcode.js exists
8. atomicReplace()          → rename staging → installDir (backup old first)
9. syncSkills()             → copy installDir/skills/ → agent skill dirs
10. verify()                → run `node installDir/dist/bin/pingcode.js --version`
11. report()                → "updated v1.5.1 → v1.5.2"
```

### Atomic Replace Strategy

To avoid leaving a broken install if extraction fails:
1. Extract to `installDir.staging/` (sibling of install dir)
2. Validate the staging directory
3. Rename `installDir` → `installDir.backup/`
4. Rename `installDir.staging/` → `installDir`
5. If step 4 fails, rename `installDir.backup/` back
6. On success, optionally clean up `installDir.backup/`

### Pure-Node ZIP Extractor

Node.js has no built-in ZIP support. The project avoids runtime dependencies (only commander + picocolors). Write a minimal ZIP reader (~100 lines):

- Read End of Central Directory record (scan backwards from EOF for `0x06054b50`)
- Parse central directory entries
- For each entry: read local header, extract data
- Use `zlib.inflateRawSync` for deflated entries (method 8)
- Handle stored entries (method 0) directly
- Skip directories, symlinks, and unsupported compression methods

### Skill Sync

Reuse logic from `scripts/install-skill.ts:targets()` and `collectPayload()`, but source from `installDir/skills/pingcode/` instead of repo root. Always force-overwrite (the `--force` behavior is the default for self-update).

Target dirs:
- `~/.claude/skills/pingcode/`
- `~/.config/opencode/skills/pingcode/`

## Package Script: `scripts/package-release.ts`

Build-time script, runs with `node --experimental-strip-types`:
1. Read version from `package.json`
2. Run `npm run build` (tsup)
3. For each platform×arch combination:
   - Create zip containing `dist/` + `skills/`
   - Name: `pingcode-cli-v{version}-{platform}-{arch}.zip`
   - Use system `zip` command via `child_process.execFileSync`
4. Output to `release/` directory

Note: The zip contents are platform-independent (pure JS). The platform in the filename is for asset matching, not because the contents differ.

## Install Script Changes

### `scripts/install.mjs` (modified)

Current flow: `npm install` → `npm run build` → `npm link`
New flow (when run from a downloaded release, not repo):
1. Detect if running from a git repo checkout (`.git` exists)
   - If repo: keep existing flow (npm link, for development)
   - If not repo (standalone): download release zip → extract to XDG dir → create shim
2. Create bin shim:
   - Linux/macOS: `~/.local/bin/pingcode` shell script
   - Windows: `%LOCALAPPDATA%/Microsoft/WindowsApps/pingcode.cmd`

### Bin Shim (Linux/macOS)

```bash
#!/bin/sh
exec node "$HOME/.local/share/pingcode-cli/dist/bin/pingcode.js" "$@"
```

Must compute the actual install dir (respecting XDG_DATA_HOME) rather than hardcoding.

## Update Check Hint Change

`src/bin/pingcode.ts:28` — change:
```
'Run: git pull && ./install.sh'
```
to:
```
'Run: pingcode self-update'
```

## Compatibility

- Existing `npm link` development workflow preserved (install.mjs detects repo checkout)
- `scripts/install-skill.ts` unchanged (still works for manual skill install)
- `checkForUpdate()` unchanged (still queries GitHub Releases API)
- `VERSION` in `src/version.ts` still the source of truth

## Rollback

If self-update fails at any step after atomic replace:
- `installDir.backup/` is preserved
- User can manually rename back: `mv installDir.backup installDir`
- Command prints rollback instructions on failure
