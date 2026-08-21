/**
 * Startup version check against GitHub Releases.
 *
 * On CLI startup, a fire-and-forget check queries the latest GitHub Release
 * for this repo. If the remote tag is newer than the local `VERSION`, a
 * one-line hint is printed to stderr — unless `--json` is active or the user
 * opted out via `PINGCODE_NO_UPDATE_CHECK=1`.
 *
 * The check is **non-blocking**: a 2-second timeout and a 24-hour on-disk
 * cache mean the normal cold path is a single cache read; the network is hit
 * at most once per day. Any failure (DNS, timeout, 404, malformed JSON) is
 * silently swallowed — a notification must never break the CLI.
 *
 * Design: see `.trellis/tasks/08-21-startup-version-check/prd.md`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './config';
import { VERSION } from '../version';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const OWNER = 'anine09';
const REPO = 'pingcode-cli-unofficial';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const CHECK_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 h
const CACHE_FILENAME = 'update-check.json';

/** Environment variable that disables the check entirely. */
export const ENV_NO_UPDATE_CHECK = 'PINGCODE_NO_UPDATE_CHECK';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** On-disk cache shape. */
interface CheckCache {
  /** ISO timestamp of the last successful check. */
  checkedAt: string;
  /** The remote version string (without leading `v`). */
  latestVersion: string;
}

/** Result of a version comparison. */
export type CheckResult =
  | { status: 'update-available'; current: string; latest: string }
  | { status: 'up-to-date' }
  | { status: 'skipped' };

// ---------------------------------------------------------------------------
// semver comparison (lightweight — no dependency needed)
// ---------------------------------------------------------------------------

/**
 * Parse a semver string into a comparable tuple.
 * Accepts optional leading `v` and an optional pre-release suffix
 * (ignored for ordering — we only care about major.minor.patch).
 */
function parseSemver(raw: string): [number, number, number] | undefined {
  const stripped = raw.replace(/^v/, '').split('-')[0] ?? '';
  const parts = stripped.split('.');
  if (parts.length !== 3) return undefined;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return undefined;
  }
  return [major, minor, patch];
}

/**
 * Compare two semver tuples. Returns:
 *  - negative if a < b
 *  - 0 if equal
 *  - positive if a > b
 */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// cache helpers
// ---------------------------------------------------------------------------

function cacheFilePath(): string {
  return path.join(configDir(), CACHE_FILENAME);
}

async function readCache(): Promise<CheckCache | undefined> {
  try {
    const raw = await readFile(cacheFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.checkedAt === 'string' &&
      typeof parsed.latestVersion === 'string'
    ) {
      return { checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion };
    }
  } catch {
    // No cache or corrupt — ignore.
  }
  return undefined;
}

async function writeCache(version: string): Promise<void> {
  const file = cacheFilePath();
  const data: CheckCache = { checkedAt: new Date().toISOString(), latestVersion: version };
  try {
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Cache write failure is non-fatal.
  }
}

function isCacheFresh(cache: CheckCache): boolean {
  const age = Date.now() - new Date(cache.checkedAt).getTime();
  return age < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

/**
 * Fetch the latest release tag from GitHub. Returns the version string
 * (without leading `v`) or `undefined` on any failure.
 */
async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { tag_name?: unknown };
    const tag = body.tag_name;
    if (typeof tag !== 'string') return undefined;
    // Strip leading 'v' (tags are like "v1.4.1")
    return tag.replace(/^v/, '');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Check whether a newer version is available. Uses cache when fresh;
 * otherwise fetches from GitHub. Always resolves (never rejects).
 *
 * Returns:
 * - `{ status: 'update-available', current, latest }` — newer version exists
 * - `{ status: 'up-to-date' }` — local is current or cache says so
 * - `{ status: 'skipped' }` — check disabled via env var
 */
export async function checkForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckResult> {
  // Opt-out via environment variable.
  const disabled = env[ENV_NO_UPDATE_CHECK];
  if (disabled === '1' || disabled?.toLowerCase() === 'true') {
    return { status: 'skipped' };
  }

  // Try cache first.
  const cache = await readCache();
  if (cache && isCacheFresh(cache)) {
    return compareVersions(cache.latestVersion);
  }

  // Cache miss or stale — fetch from network.
  const remote = await fetchLatestVersion();
  if (remote !== undefined) {
    await writeCache(remote);
    return compareVersions(remote);
  }

  // Network failed; fall back to stale cache if we have one.
  if (cache) {
    return compareVersions(cache.latestVersion);
  }

  return { status: 'up-to-date' };
}

/**
 * Compare a remote version string against the local VERSION.
 */
function compareVersions(remote: string): CheckResult {
  const localParts = parseSemver(VERSION);
  const remoteParts = parseSemver(remote);
  if (localParts === undefined || remoteParts === undefined) {
    return { status: 'up-to-date' };
  }
  if (compareSemver(localParts, remoteParts) < 0) {
    return { status: 'update-available', current: VERSION, latest: remote };
  }
  return { status: 'up-to-date' };
}
