/**
 * Self-update engine — zero runtime dependencies.
 *
 * A version check plus one npm invocation. `cli/commands/selfUpdate.ts` drives
 * it: fetch the latest version from the npm registry, compare, and if newer ask
 * npm to install it globally — then read back the installed version and report
 * success **only** if it matches what we asked for.
 *
 * npm owns downloading, extracting and replacing. We own the check that the
 * replacement actually happened.
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
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './config';
import { TransportError } from './errors';
import type { FetchLike } from './context';
import { parseSemver, compareSemver } from './update-check';
import { VERSION } from '../version';
import type { SkillTarget } from './paths';
import { skillTargets } from './paths';

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

/**
 * A function that executes a child process and returns stdout.
 *
 * Every caller treats a non-zero exit as a throw, so the contract is: return
 * the captured stdout on success, throw on failure. `defaultExec` keeps npm's
 * stdin inherited (it may prompt) and captures stdout/stderr so the failure
 * message can carry them.
 */
export type ExecFn = (file: string, args: string[]) => string;

/**
 * Default exec: synchronous child process, returns stdout.
 *
 * `stdio: ['inherit', 'pipe', 'pipe']` is deliberate — see `installViaNpm`.
 * On Windows a `.cmd` sibling needs the shell to run at all, so `shell: true`
 * is added for exactly those two extensions.
 */
function defaultExec(file: string, args: string[]): string {
  const isWindowsBatch = /\.(cmd|bat)$/i.test(file);
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    ...(isWindowsBatch ? { shell: true } : {}),
  });
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
// npm: resolve, invoke, read back
// ---------------------------------------------------------------------------

/**
 * The npm binary that manages the node process running this command.
 *
 * Resolved as the *sibling* of `process.execPath` rather than through PATH:
 * PATH is unreliable under cron and minimal environments, and an interactive
 * shell's PATH can resolve `npm` to a different installation than the node
 * actually running us. Every npm install ships the CLI next to its node
 * (nvm, n, system packages, official installers), so the sibling is the one
 * npm that installs for *this* interpreter.
 *
 * @returns The absolute path to npm, or `undefined` when neither sibling exists.
 */
export function resolveNpm(): string | undefined {
  const binDir = path.dirname(process.execPath);
  // Windows: npm is installed as `npm.cmd` — a bare `npm` there is either a
  // shell shim without an extension or a Unix-lookalike, and only `.cmd` is
  // directly spawnable. `npm` is still tried second so an environment that
  // does ship a bare `npm` keeps working.
  const candidates =
    process.platform === 'win32'
      ? [path.join(binDir, 'npm.cmd'), path.join(binDir, 'npm')]
      : [path.join(binDir, 'npm')];
  return candidates.find(existsSync);
}

/**
 * Install `version` globally with the resolved npm.
 *
 * Success is **not** the exit code alone. npm (or a wrapper, or a proxy) can
 * exit 0 having installed nothing, or having installed something else — that
 * is precisely the failure this whole module exists to prevent. So the
 * installed version is read back and must equal `version`.
 *
 * @param exec    Child-process runner.
 * @param version The exact version to install.
 * @throws TransportError when npm is missing, exits non-zero, or the installed
 *         version does not match.
 */
export async function installViaNpm(exec: ExecFn, version: string): Promise<void> {
  const npm = resolveNpm();
  if (npm === undefined) {
    throw new TransportError(
      `cannot update: no npm binary found next to the node running this command ` +
        `(tried ${path.join(path.dirname(process.execPath), 'npm')})`,
      { hint: `install Node.js, then re-run this command` },
    );
  }

  const spec = `${PACKAGE_NAME}@${version}`;
  let output: string;
  try {
    output = exec(npm, ['install', '--global', spec]);
  } catch (error) {
    // npm's own stdout/stderr are captured, not inherited — see defaultExec —
    // so they can be carried here. The underlying message is kept too: the
    // background auto-update path only surfaces the message, never the hint.
    const detail = npmOutputOf(error);
    throw new TransportError(
      `npm install --global ${spec} failed (exit ${exitStatusOf(error)}): ${errorMessage(error)}`,
      {
        hint:
          detail === ''
            ? `npm printed nothing; try running manually: ${npm} install --global ${spec}`
            : detail,
        cause: error,
      },
    );
  }

  // Forward npm's own output. stderr, never stdout: `--json` keeps stdout
  // pure (backend/index.md), and this runs under both the interactive command
  // and the background auto-update, which has no logger.
  const trimmed = output.trim();
  if (trimmed !== '') {
    process.stderr.write(`${output.endsWith('\n') ? output : `${output}\n`}`);
  }

  const installed = readInstalledVersion();
  if (installed !== version) {
    throw new TransportError(
      `npm install --global ${spec} exited 0 but the installed version is ` +
        `${installed ?? 'unreadable'}, expected ${version}`,
      { hint: `verify with: ${npm} list --global --depth=0 ${PACKAGE_NAME}` },
    );
  }
}

/**
 * The version of *this package* as it exists on disk right now.
 *
 * Read from the running module's own `package.json`. That is deliberate: npm
 * replaces the files in the package directory in place, so the directory the
 * running process was loaded from is the same directory npm just wrote. The
 * in-memory modules stay old, but the files — and therefore this read-back —
 * are the new install.
 *
 * @returns The version string, or `undefined` when it cannot be read.
 */
export function readInstalledVersion(): string | undefined {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** npm's exit status from a thrown `execFileSync` error, as a display string. */
function exitStatusOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return String(status);
    if (typeof status === 'string' && status !== '') return status;
  }
  return 'unknown';
}

/** The stdout/stderr npm left behind on a failed spawn, trimmed. */
function npmOutputOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const e = error as { stdout?: unknown; stderr?: unknown };
  return [e.stderr, e.stdout]
    .filter((part): part is string | Buffer => part !== undefined && part !== null)
    .map((part) => String(part).trim())
    .filter((part) => part !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// small filesystem helpers
// ---------------------------------------------------------------------------

/** Remove a file (best-effort, never throws). Used for the lock and hint files. */
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
 * The package's own `skills/pingcode` directory.
 *
 * There is no install directory any more: npm owns where the binary lives, so
 * the skills ship inside the package and are resolved relative to the running
 * module. `skills/` is in `package.json#files`, so the payload is present in
 * the published tarball.
 *
 * `src/core/update.ts` → `../../skills/pingcode` in the source tree, and the
 * same two levels up from `dist/bin/pingcode.js` inside the installed package.
 */
export function packageSkillDir(): string {
  return fileURLToPath(new URL('../../skills/pingcode', import.meta.url));
}

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
 * Run a background auto-update: fetch the latest version, compare, and if newer
 * install it with npm and re-sync the skills.
 *
 * Reports `updated` only once npm has exited 0 **and** the installed version
 * reads back as the requested one — see `installViaNpm`. Every failure path
 * writes a hint so the next run re-offers the update, and the lock is released
 * in `finally` regardless.
 */
export async function runAutoUpdate(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchLike = defaultFetch,
  exec: ExecFn = defaultExec,
): Promise<AutoUpdateResult> {
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

    // npm does the install; `installViaNpm` re-reads the installed version, so
    // `updated` below is only reachable when the install really happened.
    await installViaNpm(exec, newVersion);

    // Skills ship inside the package — see `packageSkillDir`.
    const skillSource = packageSkillDir();
    if (dirExists(skillSource)) {
      await syncSkills(skillSource, skillTargets(env));
    }

    try { removeHint(stateDir); } catch { /* best-effort */ }
    return { status: 'updated', version: newVersion };
  } catch (error) {
    if (info !== undefined) {
      try { writeHint(stateDir, info.version); } catch { /* best-effort */ }
    }
    return { status: 'failed', error: errorMessage(error) };
  } finally {
    lock.release();
  }
}
