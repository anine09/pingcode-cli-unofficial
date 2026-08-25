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
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import type { SkillTarget } from './paths';
import { TransportError } from './errors';
import type { FetchLike } from './context';

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
 * Copies `SKILL.md` first, then every `.md` file in `modules/` (sorted by
 * name) — reusing the logic from `scripts/install-skill.ts:collectPayload()`.
 * Always force-overwrites existing files.
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
