#!/usr/bin/env node
/**
 * One-click installer for the `pingcode` CLI (cross-platform: Linux, macOS, Windows).
 *
 * Two install modes, auto-detected:
 *
 *   1. Repo checkout (`.git` exists): npm install → build → npm link
 *      Used by developers working from source.
 *
 *   2. Standalone (no `.git`): download latest release zip from GitHub →
 *      extract to XDG directory → create bin shim.
 *      Used by end users who downloaded install.sh / install.ps1.
 *
 * Run from the repo checkout:
 *   node scripts/install.mjs        # or: npm run install:cli
 *   ./install.sh                    # Linux / macOS
 *   .\install.ps1                   # Windows PowerShell
 *
 * Re-run after `git pull` to rebuild + relink the latest code — one memorable
 * command instead of npm install / build / link.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { inflateRawSync } from 'node:zlib';

const BIN = 'pingcode';
const NODE_MAJOR_REQUIRED = 20;
const GITHUB_REPO = 'anine09/pingcode-cli-unofficial';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

function die(message) {
  process.stderr.write(`\n✗ install failed: ${message}\n`);
  process.exit(1);
}

function major() {
  return Number(process.versions.node.split('.')[0] ?? 0);
}

/**
 * Run a command, streaming its output, and abort on failure. `shell: true` so `npm`
 * resolves on Windows (npm.cmd) as well as Unix. Returns the resolved binary path on
 * success for the version checks.
 */
function run(label, command, args, { capture = false } = {}) {
  process.stdout.write(`\n→ ${label}: ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    stdio: capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
    encoding: capture ? 'utf8' : undefined,
  });
  if (result.status !== 0) {
    die(`"${command} ${args.join(' ')}" exited with ${String(result.status)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Platform / architecture detection (mirrors src/core/paths.ts)
// ---------------------------------------------------------------------------

function detectPlatform() {
  switch (process.platform) {
    case 'darwin':
      return 'darwin';
    case 'win32':
      return 'win32';
    default:
      return 'linux';
  }
}

function detectArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

// ---------------------------------------------------------------------------
// XDG install directory (mirrors src/core/paths.ts)
// ---------------------------------------------------------------------------

function installDir() {
  if (process.platform === 'win32') {
    const base = process.env['LOCALAPPDATA'];
    const root = base !== undefined && base !== '' ? base : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'pingcode-cli');
  }
  const xdg = process.env['XDG_DATA_HOME'];
  const root = xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(root, 'pingcode-cli');
}

function binShimPath() {
  if (process.platform === 'win32') {
    const base = process.env['LOCALAPPDATA'];
    const root = base !== undefined && base !== '' ? base : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'Microsoft', 'WindowsApps', 'pingcode.cmd');
  }
  return path.join(os.homedir(), '.local', 'bin', 'pingcode');
}

// ---------------------------------------------------------------------------
// Pure-Node ZIP extractor (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Extract a ZIP archive from a Buffer to a destination directory.
 * Supports stored (method 0) and deflated (method 8) entries.
 * Skips directories and entries with unsupported compression methods.
 */
function extractZip(buffer, destDir) {
  // --- End of Central Directory record ---
  // Scan backwards for the EOCD signature (0x06054b50).
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) die('not a valid zip file (EOCD record not found)');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  // --- Walk central directory entries ---
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) {
      die(`corrupt zip: invalid central directory signature at offset ${cdOffset}`);
    }

    const compressionMethod = buffer.readUInt16LE(cdOffset + 10);
    const compressedSize = buffer.readUInt32LE(cdOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(cdOffset + 24);
    const nameLength = buffer.readUInt16LE(cdOffset + 28);
    const extraLength = buffer.readUInt16LE(cdOffset + 30);
    const commentLength = buffer.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdOffset + 42);

    const fileName = buffer.slice(cdOffset + 46, cdOffset + 46 + nameLength).toString('utf8');

    // Advance to next central directory entry.
    cdOffset += 46 + nameLength + extraLength + commentLength;

    // Skip directories (names ending with '/').
    if (fileName.endsWith('/')) continue;

    // --- Read local file header to find the data offset ---
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      die(`corrupt zip: invalid local file header signature for "${fileName}"`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;

    // --- Extract data based on compression method ---
    let data;
    if (compressionMethod === 0) {
      // Stored — raw copy.
      data = buffer.slice(dataOffset, dataOffset + uncompressedSize);
    } else if (compressionMethod === 8) {
      // Deflated — inflate.
      const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
      try {
        data = inflateRawSync(compressed);
      } catch {
        die(`failed to decompress "${fileName}" (corrupt deflate data)`);
      }
    } else {
      die(`unsupported compression method ${compressionMethod} for "${fileName}"`);
    }

    // --- Write file to disk ---
    const outPath = path.join(destDir, fileName);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
  }
}

// ---------------------------------------------------------------------------
// GitHub Release download
// ---------------------------------------------------------------------------

async function fetchReleaseInfo() {
  let response;
  try {
    response = await fetch(GITHUB_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
  } catch (err) {
    die(`failed to reach GitHub API: ${String(err)}`);
  }

  if (!response.ok) {
    die(`GitHub API returned ${response.status} ${response.statusText} for ${GITHUB_API}`);
  }

  return response.json();
}

function findAsset(release, platform, arch) {
  const expectedName = `pingcode-cli-v${release.tag_name.replace(/^v/, '')}-${platform}-${arch}.zip`;
  const asset = release.assets?.find((a) => a.name === expectedName);
  if (!asset) {
    const available = (release.assets ?? [])
      .filter((a) => a.name.endsWith('.zip'))
      .map((a) => `  ${a.name}`)
      .join('\n');
    die(
      `no release asset found for ${platform}-${arch} (looking for "${expectedName}").\n` +
        `Available zip assets:\n${available || '  (none)'}`,
    );
  }
  return asset;
}

async function downloadFile(url, destPath) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    die(`download failed: ${String(err)}`);
  }

  if (!response.ok) {
    die(`download failed: HTTP ${response.status} ${response.statusText}\n  URL: ${url}`);
  }

  mkdirSync(path.dirname(destPath), { recursive: true });
  const fileStream = createWriteStream(destPath);
  try {
    await pipeline(response.body, fileStream);
  } catch (err) {
    // Clean up partial download.
    try {
      rmSync(destPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    die(`download stream error: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Bin shim creation
// ---------------------------------------------------------------------------

function createBinShim(dir) {
  const shim = binShimPath();
  const shimDir = path.dirname(shim);
  const entryPoint = path.join(dir, 'dist', 'bin', 'pingcode.js');

  if (process.platform === 'win32') {
    // Windows: .cmd shim.
    const content = `@echo off\r\nnode "${entryPoint}" %*\r\n`;
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(shim, content);
  } else {
    // Linux/macOS: shell script.
    const content = `#!/bin/sh\nexec node "${entryPoint}" "$@"\n`;
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(shim, content);
    chmodSync(shim, 0o755);
  }
}

function pathHint() {
  const shim = binShimPath();
  const shimDir = path.dirname(shim);

  if (process.platform === 'win32') {
    return `Ensure ${shimDir} is on your PATH (usually already included on Windows 10+).`;
  }

  // Check if shimDir is already on PATH.
  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter);
  if (pathDirs.some((p) => p === shimDir || path.resolve(p) === path.resolve(shimDir))) {
    return null; // Already on PATH.
  }
  return `Add ${shimDir} to your PATH:\n  export PATH="${shimDir}:$PATH"\n  (add to ~/.bashrc, ~/.zshrc, or equivalent)`;
}

// ---------------------------------------------------------------------------
// Standalone install (no .git — downloaded release)
// ---------------------------------------------------------------------------

async function installFromRelease() {
  process.stdout.write(`Installing ${BIN} from GitHub release (standalone mode)…\n`);

  const platform = detectPlatform();
  const arch = detectArch();
  process.stdout.write(`  platform: ${platform}-${arch}\n`);

  // 1. Fetch release info.
  process.stdout.write(`\n→ fetching latest release from GitHub…\n`);
  const release = await fetchReleaseInfo();
  const version = release.tag_name.replace(/^v/, '');
  process.stdout.write(`  latest version: v${version}\n`);

  // 2. Find matching asset.
  const asset = findAsset(release, platform, arch);
  process.stdout.write(`  asset: ${asset.name} (${formatBytes(asset.size)})\n`);

  // 3. Download to temp.
  const tmpDir = path.join(os.tmpdir(), `pingcode-cli-install-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, asset.name);

  process.stdout.write(`\n→ downloading ${asset.browser_download_url}…\n`);
  await downloadFile(asset.browser_download_url, zipPath);
  process.stdout.write(`  saved to ${zipPath}\n`);

  // 4. Extract to XDG install directory.
  const dir = installDir();
  process.stdout.write(`\n→ extracting to ${dir}…\n`);

  try {
    const zipBuffer = readFileSync(zipPath);
    extractZip(zipBuffer, dir);
  } catch (err) {
    // Clean up partial install.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
    die(`extraction failed: ${String(err)}`);
  }

  // 5. Verify the entry point exists.
  const entryPoint = path.join(dir, 'dist', 'bin', 'pingcode.js');
  if (!existsSync(entryPoint)) {
    die(`extraction completed but entry point not found: ${entryPoint}`);
  }

  // 6. Create bin shim.
  process.stdout.write(`\n→ creating bin shim at ${binShimPath()}…\n`);
  createBinShim(dir);

  // 7. Verify.
  process.stdout.write(`\n→ verifying installation…\n`);
  const verify = spawnSync('node', [entryPoint, '--version'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (verify.status !== 0) {
    die(`verification failed: ${verify.stderr || verify.stdout || 'unknown error'}`);
  }
  const installedVersion = (verify.stdout ?? '').trim();

  // 8. Clean up temp.
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Non-fatal.
  }

  // 9. Success message.
  process.stdout.write(`\n✓ ${BIN} v${installedVersion} installed\n`);
  process.stdout.write(`  location: ${dir}\n`);
  process.stdout.write(`  shim:     ${binShimPath()}\n`);

  const hint = pathHint();
  if (hint) {
    process.stdout.write(`\n  ${hint}\n`);
  }
  process.stdout.write(`\n  run: ${BIN} auth login\n`);
}

// ---------------------------------------------------------------------------
// Repo checkout install (has .git — developer mode)
// ---------------------------------------------------------------------------

function installFromRepo() {
  process.stdout.write(`Installing ${BIN} (Node ${process.versions.node})…\n`);

  const m = major();
  if (!Number.isInteger(m) || m < NODE_MAJOR_REQUIRED) {
    die(`Node.js >= ${NODE_MAJOR_REQUIRED} required, found ${process.versions.node}`);
  }

  // 1. dependencies (runs the esbuild/fsevents install scripts the deps commit allows).
  run('dependencies', 'npm', ['install']);

  // 2. build dist/bin/pingcode.js (what package.json `bin` points at).
  run('build', 'npm', ['run', 'build']);

  // 3. global link so `pingcode` lands on PATH.
  run('link', 'npm', ['link']);

  // 4. verify the linked command resolves and reports a version.
  const version = run('verify', BIN, ['--version'], { capture: true });
  const out = (version.stdout ?? '').trim();
  if (out === '') die('the linked `pingcode` command did not print a version');

  process.stdout.write(`\n✓ ${BIN} installed — ${out}\n`);
  process.stdout.write(`  run: ${BIN} auth login\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Resolve the repo root so the script can be run from anywhere; keeps relative reads sane.
export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

async function main() {
  const isRepoCheckout = existsSync(path.join(REPO_ROOT, '.git'));

  if (isRepoCheckout) {
    installFromRepo();
  } else {
    await installFromRelease();
  }
}

main();
