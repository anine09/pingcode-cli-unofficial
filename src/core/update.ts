/**
 * Self-update engine — zero runtime dependencies.
 *
 * Orchestrates the full self-update flow that `cli/commands/selfUpdate.ts`
 * drives: fetch latest version info from npm registry, download the tarball,
 * unpack it to a staging directory, atomically swap it into the install dir,
 * sync the bundled skill docs to every agent's global skill dir, and verify
 * the new binary.
 *
 * All file-system and process work lives here because `cli/` is forbidden
 * from importing `node:fs` (see `test/layering.test.ts`). The command layer
 * stays thin: it parses flags, calls these functions, and renders.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { configDir } from './config';
import { TransportError } from './errors';
import type { FetchLike } from './context';
import { parseSemver, compareSemver } from './update-check';
import { VERSION } from '../version';
import type { SkillTarget } from './paths';
import { installDir, skillTargets } from './paths';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const PACKAGE_NAME = 'pingcode-cli-unofficial';
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`;
const NETWORK_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** Version info fetched from the npm registry. */
export interface RegistryInfo {
  /** Semantic version string (e.g. "1.5.2"). */
  version: string;
  /** URL of the .tar.gz tarball for this version. */
  tarballUrl: string;
}

/** A function that executes a child process and returns stdout. */
export type ExecFn = (file: string, args: string[]) => string;

/** Default exec: synchronous child process, returns stdout. */
function defaultExec(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// npm registry
// ---------------------------------------------------------------------------

/**
 * Fetch the latest version info from the npm registry.
 *
 * @throws TransportError on network failure, non-2xx, or malformed response.
 */
export async function fetchLatestInfo(
  fetchFn: FetchLike = defaultFetch,
): Promise<RegistryInfo> {
  let response: Response;
  try {
    response = await fetchFn(REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TransportError(`failed to fetch npm registry: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new TransportError(
      `npm registry returned HTTP ${response.status}`,
      { status: response.status },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new TransportError(`failed to parse registry response: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const record = body as Record<string, unknown>;
  const distTags = record['dist-tags'];
  if (
    typeof distTags !== 'object' ||
    distTags === null ||
    Array.isArray(distTags)
  ) {
    throw new TransportError('registry response missing dist-tags');
  }

  const latest = (distTags as Record<string, unknown>).latest;
  if (typeof latest !== 'string') {
    throw new TransportError('registry response missing dist-tags.latest');
  }

  const versions = record.versions;
  if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) {
    throw new TransportError('registry response missing versions');
  }

  const versionInfo = (versions as Record<string, unknown>)[latest];
  if (typeof versionInfo !== 'object' || versionInfo === null || Array.isArray(versionInfo)) {
    throw new TransportError(`registry response missing version info for ${latest}`);
  }

  const dist = (versionInfo as Record<string, unknown>).dist;
  if (typeof dist !== 'object' || dist === null || Array.isArray(dist)) {
    throw new TransportError(`registry response missing dist for ${latest}`);
  }

  const tarballUrl = (dist as Record<string, unknown>).tarball;
  if (typeof tarballUrl !== 'string') {
    throw new TransportError(`registry response missing dist.tarball for ${latest}`);
  }

  return { version: latest, tarballUrl };
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

/**
 * Download a tarball to an in-memory buffer.
 *
 * @throws TransportError on network failure or non-2xx.
 */
export async function downloadTarball(
  url: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
  } catch (error) {
    throw new TransportError(`failed to download tarball: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new TransportError(
      `tarball download returned HTTP ${response.status}`,
      { status: response.status },
    );
  }

  if (response.body === null) {
    throw new TransportError('tarball download returned empty body');
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  const MAX_SIZE = 50 * 1024 * 1024; // 50 MB safety cap
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_SIZE) {
      throw new TransportError(`tarball exceeds maximum size of ${MAX_SIZE} bytes`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// tar.gz extraction
// ---------------------------------------------------------------------------

/**
 * Extract a .tar.gz buffer into `destDir`.
 *
 * Strips the top-level `package/` directory that npm tarballs contain.
 * Only regular files and directories are extracted; symlinks and other
 * special entries are skipped.
 *
 * @param buffer  The .tar.gz file contents.
 * @param destDir Destination directory (created recursively if missing).
 * @returns       Relative paths of every extracted file.
 * @throws        Error on corrupt or unsupported tar data.
 */
export function extractTarball(buffer: Buffer, destDir: string): string[] {
  const gzipped = gunzipSync(buffer);
  return extractTar(gzipped, destDir);
}

/**
 * Parse a raw tar stream and extract entries to `destDir`.
 */
function extractTar(tarBuffer: Buffer, destDir: string): string[] {
  const resolvedDest = path.resolve(destDir);
  mkdirSync(resolvedDest, { recursive: true });

  const extracted: string[] = [];
  let offset = 0;

  while (offset < tarBuffer.length) {
    // Each tar entry starts with a 512-byte header.
    if (offset + 512 > tarBuffer.length) break;

    // Check for end-of-archive marker (two consecutive 512-byte zero blocks).
    const headerBlock = tarBuffer.subarray(offset, offset + 512);
    if (headerBlock.every((b) => b === 0)) {
      break;
    }

    const name = readTarString(headerBlock, 0, 100);
    const typeflag = tarBuffer[offset + 156];
    const size = readTarNumber(headerBlock, 124, 12);

    // Advance past the header.
    offset += 512;

    // Calculate data block count (512-byte blocks).
    const dataBlocks = Math.ceil(size / 512);
    const dataOffset = offset;

    if (typeflag === '5'.charCodeAt(0)) {
      // Directory entry — create it.
      const cleanName = stripPackagePrefix(name);
      if (cleanName) {
        const dest = path.resolve(resolvedDest, cleanName);
        if (dest.startsWith(resolvedDest + path.sep) || dest === resolvedDest) {
          mkdirSync(dest, { recursive: true });
        }
      }
    } else if (typeflag === '0'.charCodeAt(0) || typeflag === 0) {
      // Regular file entry.
      const cleanName = stripPackagePrefix(name);
      if (cleanName) {
        const data = tarBuffer.subarray(dataOffset, dataOffset + size);
        const dest = path.resolve(resolvedDest, cleanName);
        if (dest.startsWith(resolvedDest + path.sep)) {
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, data);
          extracted.push(cleanName);
        }
      }
    }
    // Skip other entry types (symlinks, etc.).

    // Advance past the data blocks.
    offset += dataBlocks * 512;
  }

  return extracted;
}

/** Strip the `package/` top-level prefix that npm tarballs contain. */
function stripPackagePrefix(name: string): string {
  if (name.startsWith('package/')) {
    return name.slice('package/'.length);
  }
  return name;
}

/** Read a null-terminated ASCII string from a tar header field. */
function readTarString(buf: Buffer, start: number, maxLen: number): string {
  const end = buf.indexOf(0, start);
  const actualEnd = end < 0 ? start + maxLen : end;
  return buf.subarray(start, actualEnd).toString('utf8').trim();
}

/** Read an octal number from a tar header field (null-terminated). */
function readTarNumber(buf: Buffer, start: number, maxLen: number): number {
  const str = readTarString(buf, start, maxLen);
  // Handle binary-encoded sizes (high bit set).
  if (str.charCodeAt(0) === 0x80) {
    // Base-256 encoding — not needed for npm packages, but handle gracefully.
    return 0;
  }
  return parseInt(str, 8) || 0;
}

// ---------------------------------------------------------------------------
// atomic replace
// ---------------------------------------------------------------------------

/**
 * Atomically replace the current install directory with the staging directory.
 *
 * 1. If staging is nested under current, move it aside first.
 * 2. Rename `current` → `current.backup` (if `current` exists)
 * 3. Rename `incoming` → `current`
 * 4. If step 3 fails, restore the backup
 * 5. Clean up the backup on success
 */
export async function atomicReplace(
  current: string,
  staging: string,
): Promise<void> {
  const backup = `${current}.backup`;

  // Clean up any leftover backup from a previous failed update.
  if (existsSync(backup)) {
    rmSync(backup, { recursive: true, force: true });
  }

  const isNested = staging.startsWith(`${current}${path.sep}`);
  const incoming = isNested ? `${current}.incoming` : staging;

  if (isNested) {
    if (existsSync(incoming)) rmSync(incoming, { recursive: true, force: true });
    try {
      renameSync(staging, incoming);
    } catch (error) {
      throw new TransportError(
        `failed to move staging aside: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  // Step 1: rename current → backup.
  if (existsSync(current)) {
    try {
      renameSync(current, backup);
    } catch (error) {
      if (isNested && existsSync(incoming)) {
        try { renameSync(incoming, staging); } catch { /* best-effort */ }
      }
      throw new TransportError(
        `failed to back up current install: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  // Step 2: rename incoming → current.
  try {
    renameSync(incoming, current);
  } catch (error) {
    try {
      if (existsSync(backup)) renameSync(backup, current);
    } catch (restoreError) {
      throw new TransportError(
        `CRITICAL: update failed AND backup restore failed. ` +
          `Restore manually: mv "${backup}" "${current}". ` +
          `Original error: ${errorMessage(error)}. Restore error: ${errorMessage(restoreError)}`,
        { cause: error },
      );
    }
    throw new TransportError(
      `failed to install update (backup restored): ${errorMessage(error)}`,
      {
        hint: `if needed, restore manually: mv "${backup}" "${current}"`,
        cause: error,
      },
    );
  }

  // Step 3: clean up backup.
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch {
    // Non-fatal.
  }
}

// ---------------------------------------------------------------------------
// staging helpers
// ---------------------------------------------------------------------------

/** Remove the staging directory if it exists. */
export function cleanStaging(stagingDir: string): void {
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Check that the staging directory contains a valid CLI binary. */
export function validateStaging(stagingDir: string): boolean {
  const bin = path.join(stagingDir, 'dist', 'bin', 'pingcode.js');
  return existsSync(bin);
}

/** Write a buffer to a file path (used by cli layer, hence exported). */
export function writeBufferToFile(destPath: string, buffer: Buffer): void {
  writeFileSync(destPath, buffer);
}

/** Create a directory recursively (used by cli layer, hence exported). */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/** Remove a single file (best-effort, never throws). */
export function removeFile(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // best-effort
  }
}

/** Check whether a path exists (directory or file). */
export function dirExists(dirPath: string): boolean {
  return existsSync(dirPath);
}

// ---------------------------------------------------------------------------
// skill sync
// ---------------------------------------------------------------------------

const MODULES_DIR = 'modules';

/**
 * Copy skill files from `sourceDir` to each target directory.
 *
 * Only syncs to a target if its skill directory **already exists**.
 */
export async function syncSkills(
  sourceDir: string,
  targets: SkillTarget[],
): Promise<string[]> {
  const written: string[] = [];

  const payload: { relative: string; source: string }[] = [];
  const skillMd = path.join(sourceDir, 'SKILL.md');
  if (existsSync(skillMd)) {
    payload.push({ relative: 'SKILL.md', source: skillMd });
  }
  const modulesDir = path.join(sourceDir, MODULES_DIR);
  if (existsSync(modulesDir)) {
    for (const entry of readdirSync(modulesDir).sort()) {
      if (!entry.endsWith('.md')) continue;
      payload.push({
        relative: path.join(MODULES_DIR, entry),
        source: path.join(modulesDir, entry),
      });
    }
  }

  for (const target of targets) {
    if (!existsSync(target.dir)) continue;

    for (const file of payload) {
      const dest = path.join(target.dir, file.relative);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(file.source, dest);
      written.push(dest);
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export function verifyInstall(dir: string, exec: ExecFn): string {
  const bin = path.join(dir, 'dist', 'bin', 'pingcode.js');
  try {
    return exec('node', [bin, '--version']).trim();
  } catch (error) {
    throw new TransportError(
      `failed to verify new installation: ${errorMessage(error)}`,
      {
        hint: `try running manually: node "${bin}" --version`,
        cause: error,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// background auto-update: lock, cooldown, hint
// ---------------------------------------------------------------------------

const LOCK_FILENAME = 'update.lock';
const HINT_FILENAME = 'update-available';
const COOLDOWN_FILENAME = 'auto-update-check';
const DEFAULT_COOLDOWN_MS = 18 * 60 * 1000; // 18 min

export interface LockResult {
  acquired: boolean;
  release: () => void;
}

export function acquireLock(dir: string): LockResult {
  const lockPath = path.join(dir, LOCK_FILENAME);
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return { acquired: true, release: () => removeFile(lockPath) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { acquired: false, release: () => {} };
    }
  }

  let holderDead = false;
  try {
    const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    process.kill(pid, 0);
  } catch {
    holderDead = true;
  }

  if (!holderDead) {
    return { acquired: false, release: () => {} };
  }

  try {
    removeFile(lockPath);
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return { acquired: true, release: () => removeFile(lockPath) };
  } catch {
    return { acquired: false, release: () => {} };
  }
}

export function isCooldownActive(
  dir: string,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
): boolean {
  try {
    const mtime = statSync(path.join(dir, COOLDOWN_FILENAME)).mtimeMs;
    return Date.now() - mtime < cooldownMs;
  } catch {
    return false;
  }
}

export function touchCooldown(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, COOLDOWN_FILENAME);
  const now = new Date();
  try {
    utimesSync(file, now, now);
  } catch {
    writeFileSync(file, '');
  }
}

export interface UpdateHint {
  version: string;
}

export function readHint(dir: string): UpdateHint | undefined {
  try {
    const raw = readFileSync(path.join(dir, HINT_FILENAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const version = (parsed as Record<string, unknown>).version;
    if (typeof version !== 'string') return undefined;
    return { version };
  } catch {
    return undefined;
  }
}

export function writeHint(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, HINT_FILENAME),
    JSON.stringify({ version }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

export function removeHint(dir: string): void {
  removeFile(path.join(dir, HINT_FILENAME));
}

// ---------------------------------------------------------------------------
// auto-update engine
// ---------------------------------------------------------------------------

export type AutoUpdateResult =
  | { status: 'updated'; version: string }
  | { status: 'up-to-date' }
  | { status: 'failed'; error: string };

/**
 * Run a full background auto-update: fetch latest version, compare, and if
 * newer, download + extract + atomic-replace + sync skills.
 */
export async function runAutoUpdate(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchLike = defaultFetch,
  exec: ExecFn = defaultExec,
): Promise<AutoUpdateResult> {
  const dir = installDir(env);
  const stateDir = configDir(env);

  try { touchCooldown(stateDir); } catch { /* best-effort */ }

  const lock = acquireLock(stateDir);
  if (!lock.acquired) {
    return { status: 'failed', error: 'update already in progress' };
  }

  let info: RegistryInfo | undefined;
  try {
    info = await fetchLatestInfo(fetchFn);

    const localParts = parseSemver(VERSION);
    const remoteParts = parseSemver(info.version);
    if (localParts === undefined || remoteParts === undefined) {
      return { status: 'failed', error: 'version parse error' };
    }
    if (compareSemver(localParts, remoteParts) >= 0) {
      try { removeHint(stateDir); } catch { /* best-effort */ }
      return { status: 'up-to-date' };
    }

    const newVersion = info.version;

    // Download tarball as buffer.
    const tarballBuffer = await downloadTarball(info.tarballUrl, fetchFn);

    // Extract to staging.
    const stagingDir = path.join(dir, '.staging');
    const tmpTarball = path.join(os.tmpdir(), `pingcode-cli-${newVersion}.tgz`);
    try {
      writeFileSync(tmpTarball, tarballBuffer);
      cleanStaging(stagingDir);
      mkdirSync(stagingDir, { recursive: true });
      extractTarball(tarballBuffer, stagingDir);

      if (!validateStaging(stagingDir)) {
        cleanStaging(stagingDir);
        throw new TransportError('invalid tarball: dist/bin/pingcode.js not found');
      }

      await atomicReplace(dir, stagingDir);

      // Install runtime dependencies (npm tarball does not include node_modules).
      try {
        exec('npm', ['install', '--production', '--prefix', dir]);
      } catch (error) {
        // Roll back to backup on failure.
        const backup = `${dir}.backup`;
        try { atomicReplace(dir, backup); } catch { /* best-effort */ }
        throw new TransportError(
          `failed to install dependencies: ${errorMessage(error)}`, { cause: error },
        );
      }

      // Sync skills.
      const skillSource = path.join(dir, 'skills', 'pingcode');
      if (dirExists(skillSource)) {
        await syncSkills(skillSource, skillTargets(env));
      }

      // Verify.
      verifyInstall(dir, exec);

      try { removeHint(stateDir); } catch { /* best-effort */ }
      return { status: 'updated', version: newVersion };
    } finally {
      removeFile(tmpTarball);
    }
  } catch (error) {
    if (info !== undefined) {
      try { writeHint(stateDir, info.version); } catch { /* best-effort */ }
    }
    return { status: 'failed', error: errorMessage(error) };
  } finally {
    lock.release();
  }
}
