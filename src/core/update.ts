/**
 * Self-update engine — zero runtime dependencies.
 *
 * Orchestrates the full self-update flow that `cli/commands/selfUpdate.ts`
 * drives: fetch release metadata, download the platform asset, unpack it to
 * a staging directory, atomically swap it into the install dir, sync the
 * bundled skill docs to every agent's global skill dir, and verify the new
 * binary runs.
 *
 * All file-system and process work lives here because `cli/` is forbidden
 * from importing `node:fs` (see `test/layering.test.ts`). The command layer
 * stays thin: it parses flags, calls these functions, and renders.
 */
import {
  copyFileSync,
  createWriteStream,
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
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { configDir } from './config';
import { TransportError } from './errors';
import type { FetchLike } from './context';
import { parseSemver, compareSemver } from './update-check';
import { extractZip } from './zip';
import { VERSION } from '../version';
import type { SkillTarget } from './paths';
import { detectArch, detectPlatform, installDir, skillTargets } from './paths';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const OWNER = 'anine09';
const REPO = 'pingcode-cli-unofficial';
const RELEASES_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const NETWORK_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** A single asset attached to a GitHub Release. */
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** Parsed GitHub Release metadata. */
export interface ReleaseInfo {
  /** Raw tag name (e.g. `v1.5.2`). */
  tag: string;
  /** Version without leading `v` (e.g. `1.5.2`). */
  version: string;
  /** Attached release assets. */
  assets: ReleaseAsset[];
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

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TransportError('unexpected response format from GitHub');
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

/**
 * Fetch the latest release from GitHub, including its assets.
 *
 * @throws TransportError on network failure, non-2xx, or malformed response.
 */
export async function fetchLatestRelease(
  fetchFn: FetchLike = defaultFetch,
): Promise<ReleaseInfo> {
  let response: Response;
  try {
    response = await fetchFn(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TransportError(`failed to fetch release info: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new TransportError(
      `GitHub API returned HTTP ${response.status} for latest release`,
      { status: response.status },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new TransportError(`failed to parse release response: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const record = asObject(body);
  const tag = record.tag_name;
  if (typeof tag !== 'string') {
    throw new TransportError('release response missing tag_name');
  }
  const version = tag.replace(/^v/, '');

  const rawAssets = record.assets;
  if (!Array.isArray(rawAssets)) {
    throw new TransportError('release response missing assets array');
  }
  const assets: ReleaseAsset[] = [];
  for (const raw of rawAssets) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const asset = raw as Record<string, unknown>;
    if (typeof asset.name === 'string' && typeof asset.browser_download_url === 'string') {
      assets.push({ name: asset.name, browser_download_url: asset.browser_download_url });
    }
  }

  return { tag, version, assets };
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

/**
 * Download a release asset to a local file path.
 *
 * Streams the response body to disk via `createWriteStream` so the whole
 * file is never buffered in memory.
 *
 * @throws TransportError on network failure or non-2xx.
 */
export async function downloadReleaseAsset(
  url: string,
  destPath: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
  } catch (error) {
    throw new TransportError(`failed to download asset: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new TransportError(`asset download returned HTTP ${response.status}`, {
      status: response.status,
    });
  }

  if (response.body === null) {
    throw new TransportError('asset download returned empty body');
  }

  const dest = createWriteStream(destPath);
  try {
    await pipeWebStreamToFile(response.body, dest);
  } catch (error) {
    dest.destroy();
    try {
      rmSync(destPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw new TransportError(`failed to write asset to disk: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * Pipe a web `ReadableStream` into a Node `Writable`, resolving when the
 * write finishes (or rejecting on error from either side).
 */
function pipeWebStreamToFile(webStream: ReadableStream<Uint8Array>, dest: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const readable = Readable.fromWeb(webStream as ReadableStream);
    readable.pipe(dest);
    dest.on('finish', resolve);
    const onError = (err: Error) => {
      dest.destroy();
      reject(err);
    };
    dest.on('error', onError);
    readable.on('error', onError);
  });
}

// ---------------------------------------------------------------------------
// atomic replace
// ---------------------------------------------------------------------------

/**
 * Atomically replace the current install directory with the staging directory.
 *
 * 1. If staging is nested under current, move it aside first (so renaming
 *    current → backup doesn't carry staging along).
 * 2. Rename `current` → `current.backup` (if `current` exists)
 * 3. Rename `incoming` → `current`
 * 4. If step 3 fails, restore the backup
 * 5. Clean up the backup on success
 *
 * @throws TransportError if the replace fails (backup is restored).
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

  // If staging is nested under current (e.g. `current/.staging`), move it
  // to a sibling path first. Otherwise renaming `current` → `backup` would
  // carry the staging directory along, and the subsequent rename would fail.
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
      // Restore incoming back to staging if we moved it.
      if (isNested && existsSync(incoming)) {
        try {
          renameSync(incoming, staging);
        } catch {
          // Best-effort restore; the original error is more important.
        }
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
    // Attempt to restore backup.
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

  // Step 3: clean up backup on success.
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch {
    // Non-fatal: a leftover backup dir doesn't break anything.
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

/** Remove a single file (best-effort, never throws). */
export function removeFile(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // best-effort cleanup
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
 * Only syncs to a target if its skill directory **already exists** — the user
 * must have explicitly installed the skill for that agent first (via
 * `skill:install` or a previous self-update). This prevents self-update from
 * creating skill directories for agents the user does not have installed.
 *
 * Within an existing target, always force-overwrites (the whole point of
 * sync is to update).
 *
 * @returns Absolute paths of every file written.
 */
export async function syncSkills(
  sourceDir: string,
  targets: SkillTarget[],
): Promise<string[]> {
  const written: string[] = [];

  // Collect payload: SKILL.md first, then modules sorted by name.
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
    // Skip targets whose skill directory was never created — we do not
    // auto-create directories for agents the user has not opted into.
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

/**
 * Verify the installation by running `node <installDir>/dist/bin/pingcode.js
 * --version` and returning the trimmed output.
 *
 * @throws TransportError if the binary fails to run.
 */
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

/** Result of attempting to acquire the update lock. */
export interface LockResult {
  /** Whether the lock was acquired (caller owns it). */
  acquired: boolean;
  /** Release the lock. No-op if not acquired. */
  release: () => void;
}

/**
 * Acquire an exclusive PID-based lock file.
 *
 * - If the lock doesn't exist: create it and acquire.
 * - If the lock exists and the holder PID is alive: fail to acquire.
 * - If the lock exists but the holder PID is dead: steal the lock.
 *
 * Returns a `LockResult` with `acquired: true` and a `release()` function if
 * the lock was obtained; otherwise `acquired: false`.
 */
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

  // Lock exists — check if holder is still alive.
  let holderDead = false;
  try {
    const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    process.kill(pid, 0); // throws if PID doesn't exist or no permission
  } catch {
    holderDead = true;
  }

  if (!holderDead) {
    return { acquired: false, release: () => {} };
  }

  // Stale lock — steal it.
  try {
    removeFile(lockPath);
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return { acquired: true, release: () => removeFile(lockPath) };
  } catch {
    return { acquired: false, release: () => {} };
  }
}

/**
 * Check whether the auto-update cooldown is still active.
 *
 * Uses mtime of the cooldown timestamp file. Returns `true` if the file
 * exists and was written less than `cooldownMs` ago.
 */
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

/** Create or update the cooldown timestamp file. */
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

/** Hint file contents — a pending update the user should know about. */
export interface UpdateHint {
  version: string;
}

/** Read the hint file. Returns `undefined` if missing or corrupt. */
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

/** Write a hint file (called when auto-update fails). */
export function writeHint(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, HINT_FILENAME),
    JSON.stringify({ version }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

/** Remove the hint file (called on successful update or when up-to-date). */
export function removeHint(dir: string): void {
  removeFile(path.join(dir, HINT_FILENAME));
}

// ---------------------------------------------------------------------------
// auto-update engine
// ---------------------------------------------------------------------------

/** Result of an automatic update attempt. */
export type AutoUpdateResult =
  | { status: 'updated'; version: string }
  | { status: 'up-to-date' }
  | { status: 'failed'; error: string };

/**
 * Run a full background auto-update: fetch latest version, compare, and if
 * newer, download + extract + atomic-replace + sync skills.
 *
 * This is the engine behind the `__auto-update` hidden command, spawned as
 * a detached child process on every CLI startup (subject to cooldown).
 *
 * Unlike the manual `self-update` command, this:
 * - Always touches the cooldown (to prevent sibling processes from also
 *   checking)
 * - Acquires a PID lock (to prevent concurrent updates)
 * - Writes a hint file on failure (so the next startup can tell the user)
 * - Never prompts or blocks — it either succeeds silently or fails silently
 *   with a hint
 */
export async function runAutoUpdate(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchLike = defaultFetch,
  exec: ExecFn = defaultExec,
): Promise<AutoUpdateResult> {
  const dir = installDir(env);
  const stateDir = configDir(env);

  // Touch cooldown immediately so sibling processes skip.
  try { touchCooldown(stateDir); } catch { /* best-effort */ }

  // Acquire PID lock.
  const lock = acquireLock(stateDir);
  if (!lock.acquired) {
    return { status: 'failed', error: 'update already in progress' };
  }

  let release: ReleaseInfo | undefined;
  try {
    // Fetch full release metadata (version + assets) in one call.
    release = await fetchLatestRelease(fetchFn);

    // Compare versions.
    const localParts = parseSemver(VERSION);
    const remoteParts = parseSemver(release.version);
    if (localParts === undefined || remoteParts === undefined) {
      return { status: 'failed', error: 'version parse error' };
    }
    if (compareSemver(localParts, remoteParts) >= 0) {
      // Already up-to-date — clean up any stale hint.
      try { removeHint(stateDir); } catch { /* best-effort */ }
      return { status: 'up-to-date' };
    }

    // Find matching platform asset.
    const platform = detectPlatform();
    const arch = detectArch();
    const assetName = `pingcode-cli-v${release.version}-${platform}-${arch}.zip`;
    const asset = release.assets.find((a) => a.name === assetName);
    if (asset === undefined) {
      try { writeHint(stateDir, release.version); } catch { /* best-effort */ }
      return { status: 'failed', error: `no release asset found: ${assetName}` };
    }

    // Download, extract, validate, replace, sync skills, verify.
    const stagingDir = path.join(dir, '.staging');
    const tmpZip = path.join(os.tmpdir(), asset.name);
    try {
      await downloadReleaseAsset(asset.browser_download_url, tmpZip, fetchFn);
      cleanStaging(stagingDir);
      await extractZip(tmpZip, stagingDir);

      if (!validateStaging(stagingDir)) {
        cleanStaging(stagingDir);
        throw new TransportError('invalid release archive');
      }

      await atomicReplace(dir, stagingDir);

      // Sync skills (only to existing targets).
      const skillSource = path.join(dir, 'skills', 'pingcode');
      if (dirExists(skillSource)) {
        await syncSkills(skillSource, skillTargets(env));
      }

      // Verify the new binary runs.
      verifyInstall(dir, exec);

      // Success — remove hint.
      try { removeHint(stateDir); } catch { /* best-effort */ }
      return { status: 'updated', version: release.version };
    } finally {
      removeFile(tmpZip);
    }
  } catch (error) {
    // Write hint for next startup.
    if (release !== undefined) {
      try { writeHint(stateDir, release.version); } catch { /* best-effort */ }
    }
    return { status: 'failed', error: errorMessage(error) };
  } finally {
    lock.release();
  }
}
