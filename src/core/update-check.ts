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
/** Delay before retrying a rate-limited (403) request. */
const RETRY_DELAY_MS = 1_000;

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
  | { status: 'unknown' }
  | { status: 'skipped' };

// ---------------------------------------------------------------------------
// semver comparison (lightweight — no dependency needed)
// ---------------------------------------------------------------------------

/**
 * Parse a semver string into a comparable tuple.
 * Accepts optional leading `v` and an optional pre-release suffix
 * (ignored for ordering — we only care about major.minor.patch).
 */
/** Strict semver component: `0` or a non-zero digit followed by digits (no leading zeros). */
const SEMVER_COMPONENT = /^(0|[1-9]\d*)$/;

function parseSemver(raw: string): [number, number, number] | undefined {
  const stripped = raw.replace(/^v/, '').split('-')[0] ?? '';
  const parts = stripped.split('.');
  if (parts.length !== 3) return undefined;
  if (!SEMVER_COMPONENT.test(parts[0]!) || !SEMVER_COMPONENT.test(parts[1]!) || !SEMVER_COMPONENT.test(parts[2]!)) {
    return undefined;
  }
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
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
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.checkedAt === 'string' &&
      typeof obj.latestVersion === 'string' &&
      parseSemver(obj.latestVersion) !== undefined
    ) {
      return { checkedAt: obj.checkedAt, latestVersion: obj.latestVersion };
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
  const checkedAt = Date.parse(cache.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  const age = Date.now() - checkedAt;
  return age >= 0 && age < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

/**
 * Fetch the latest release tag from GitHub. Returns the version string
 * (without leading `v`) or `undefined` on any failure.
 *
 * Retries once on HTTP 403 (rate limit) after a short delay.
 */
async function fetchLatestVersion(): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(API_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (response.status === 403 && attempt === 0) {
        // Rate limited — wait briefly and retry once.
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return undefined;
      }
      const tag = (body as Record<string, unknown>).tag_name;
      if (typeof tag !== 'string') return undefined;
      // Strip leading 'v' (tags are like "v1.4.1")
      const normalized = tag.replace(/^v/, '');
      // Reject malformed tags (e.g. "latest") — never cache them.
      return parseSemver(normalized) === undefined ? undefined : normalized;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Check whether a newer version is available. Uses cache when fresh;
 * otherwise fetches from GitHub. Always resolves (never rejects).
 *
 * Pass `{ skipCache: true }` to bypass the cache (e.g. `--check-only` should
 * always query the network).
 *
 * Returns:
 * - `{ status: 'update-available', current, latest }` — newer version exists
 * - `{ status: 'up-to-date' }` — local is current
 * - `{ status: 'unknown' }` — check failed and no cache available
 * - `{ status: 'skipped' }` — check disabled via env var
 */
export async function checkForUpdate(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { skipCache?: boolean },
): Promise<CheckResult> {
  // Opt-out via environment variable.
  const disabled = env[ENV_NO_UPDATE_CHECK];
  if (disabled === '1' || disabled?.toLowerCase() === 'true') {
    return { status: 'skipped' };
  }

  // Try cache first (unless explicitly skipped).
  const cache = opts?.skipCache ? undefined : await readCache();
  if (cache && isCacheFresh(cache)) {
    return compareVersions(cache.latestVersion);
  }

  // Cache miss, stale, or skipped — fetch from network.
  const remote = await fetchLatestVersion();
  if (remote !== undefined) {
    await writeCache(remote);
    return compareVersions(remote);
  }

  // Network failed; fall back to stale cache if we have one.
  if (cache) {
    return compareVersions(cache.latestVersion);
  }

  // No cache and no network — we genuinely don't know.
  return { status: 'unknown' };
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
