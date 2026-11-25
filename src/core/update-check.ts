/**
 * Startup version check against the npm registry.
 *
 * On CLI startup, a fire-and-forget check queries the latest published version
 * of this package on the npm registry. If the remote version is newer than the
 * local `VERSION`, a one-line hint is printed to stderr — unless `--json` is
 * active or the user opted out via `PINGCODE_NO_UPDATE_CHECK=1`.
 *
 * The check is **non-blocking**: a 5-second timeout and a 24-hour on-disk
 * cache mean the normal cold path is a single cache read; the network is hit
 * at most once per day. Any failure (DNS, timeout, 404, malformed JSON) is
 * silently swallowed — a notification must never break the CLI.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './config';
import { VERSION } from '../version';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const PACKAGE_NAME = 'pingcode-cli-unofficial';
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`;
const CHECK_TIMEOUT_MS = 5_000;
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

export function parseSemver(raw: string): [number, number, number] | undefined {
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
export function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

type ComparableVersion = {
  core: [bigint, bigint, bigint];
  /** Undefined denotes a stable release, which outranks every prerelease. */
  prerelease: string[] | undefined;
};

const SEMVER_IDENTIFIER = /^[0-9A-Za-z-]+$/;

/** Parse the precedence-bearing parts of SemVer 2.0.0; build metadata is ignored. */
function parseComparableVersion(raw: string): ComparableVersion | undefined {
  let version = raw.startsWith('v') ? raw.slice(1) : raw;

  const buildIndex = version.indexOf('+');
  if (buildIndex !== -1) {
    const build = version.slice(buildIndex + 1);
    if (
      build.includes('+') ||
      !build.split('.').every((identifier) => SEMVER_IDENTIFIER.test(identifier))
    ) {
      return undefined;
    }
    version = version.slice(0, buildIndex);
  }

  const prereleaseIndex = version.indexOf('-');
  const coreText = prereleaseIndex === -1 ? version : version.slice(0, prereleaseIndex);
  const prereleaseText = prereleaseIndex === -1 ? undefined : version.slice(prereleaseIndex + 1);
  const parts = coreText.split('.');
  if (
    parts.length !== 3 ||
    !SEMVER_COMPONENT.test(parts[0]!) ||
    !SEMVER_COMPONENT.test(parts[1]!) ||
    !SEMVER_COMPONENT.test(parts[2]!)
  ) {
    return undefined;
  }

  let prerelease: string[] | undefined;
  if (prereleaseText !== undefined) {
    prerelease = prereleaseText.split('.');
    const valid = prerelease.every((identifier) =>
      SEMVER_IDENTIFIER.test(identifier) &&
      (!/^\d+$/.test(identifier) || SEMVER_COMPONENT.test(identifier)));
    if (!valid) return undefined;
  }

  return {
    core: [BigInt(parts[0]!), BigInt(parts[1]!), BigInt(parts[2]!)],
    prerelease,
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftIdentifier = left[index]!;
    const rightIdentifier = right[index]!;
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return left.length - right.length;
}

function compareComparableVersions(left: ComparableVersion, right: ComparableVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const leftPart = left.core[index]!;
    const rightPart = right.core[index]!;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  if (left.prerelease === undefined || right.prerelease === undefined) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === undefined ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** True only when `candidate` is a valid SemVer strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateVersion = parseComparableVersion(candidate);
  const currentVersion = parseComparableVersion(current);
  return candidateVersion !== undefined
    && currentVersion !== undefined
    && compareComparableVersions(currentVersion, candidateVersion) < 0;
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
 * Fetch the latest published version from the npm registry. Returns the
 * version string (without leading `v`) or `undefined` on any failure.
 */
async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body)
    ) {
      return undefined;
    }
    const distTags = (body as Record<string, unknown>)['dist-tags'];
    if (
      typeof distTags !== 'object' ||
      distTags === null ||
      Array.isArray(distTags)
    ) {
      return undefined;
    }
    const latest = (distTags as Record<string, unknown>).latest;
    if (typeof latest !== 'string') return undefined;
    // Reject malformed versions — never cache them.
    return parseSemver(latest) === undefined ? undefined : latest;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Check whether a newer version is available. Uses cache when fresh;
 * otherwise fetches from the npm registry. Always resolves (never rejects).
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
  if (isNewerVersion(remote, VERSION)) {
    return { status: 'update-available', current: VERSION, latest: remote };
  }
  return { status: 'up-to-date' };
}
