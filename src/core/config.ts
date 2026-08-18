import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './errors';
import type { Logger } from './logger';
import { silentLogger } from './logger';

/** Public cloud REST root (research §1.1). */
export const DEFAULT_HOST = 'https://open.pingcode.com';

export const CONFIG_DIR_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;

export const ENV_CONFIG_DIR = 'PINGCODE_CONFIG_DIR';
export const ENV_HOST = 'PINGCODE_HOST';
export const ENV_CLIENT_ID = 'PINGCODE_CLIENT_ID';
export const ENV_CLIENT_SECRET = 'PINGCODE_CLIENT_SECRET';

/**
 * The grant a token came from. `enterprise` = `client_credentials` (app/admin,
 * no refresh); `user` = `authorization_code` (human-bound, refreshable). A
 * legacy on-disk token with no `kind` coerces to `enterprise` (R6).
 */
export type TokenKind = 'enterprise' | 'user';

/**
 * A token as stored locally. `expiresAtMs` is **always** an absolute local
 * timestamp in milliseconds — never the raw `expires_in` (design §4.1). `kind`
 * is optional at the type level so legacy/constructed tokens without it still
 * typecheck; `coerceToken` defaults an absent `kind` to `enterprise` (R6).
 */
export type TokenRecord = {
  accessToken: string;
  expiresAtMs: number;
  obtainedAtMs: number;
  scope?: string | undefined;
  kind?: TokenKind | undefined;
  /** Only `user` tokens carry a refresh token (design D1). */
  refreshToken?: string | undefined;
};

/** A user-slot token: always `kind:'user'` and always refreshable (design D1). */
export type UserTokenRecord = TokenRecord & { kind: 'user'; refreshToken: string };

/**
 * On-disk config shape (design §3). Two token slots coexist: `token` is the
 * enterprise slot (existing), `userToken` is the user slot (new). `authMode`
 * says which is active. A legacy file has only `token` + no `authMode` (D2).
 */
export type Config = {
  host?: string | undefined;
  apiBase?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  /** Enterprise slot (existing, backward-compatible). */
  token?: TokenRecord | undefined;
  /** User slot (authorization_code / refresh_token). */
  userToken?: UserTokenRecord | undefined;
  /** Which slot is active; absent → inferred (D2). */
  authMode?: TokenKind | undefined;
  /** Registered loopback callback for the browser authorize channel (D13). */
  oauthRedirectUri?: string | undefined;
};

/** A patch for `saveConfig`: `undefined` leaves a field alone, `null` deletes it. */
export type ConfigPatch = {
  [K in keyof Config]?: Config[K] | null;
};

export type SettingSource = 'flag' | 'env' | 'file' | 'default';

export type SettingsFlags = {
  host?: string | undefined;
  apiBase?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
};

export type ResolvedSettings = {
  host: string;
  apiBase: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** The active slot's token (user slot when `authMode==='user'`, else enterprise). */
  token: TokenRecord | undefined;
  /** Which slot is active, inferred per D2 when the config does not state it. */
  authMode: TokenKind;
  /** Loopback callback for the browser authorize channel (config only). */
  oauthRedirectUri: string | undefined;
  sources: {
    host: SettingSource;
    apiBase: SettingSource;
    clientId: SettingSource | 'none';
    clientSecret: SettingSource | 'none';
  };
};

// ---------------------------------------------------------------------------
// host → apiBase (design §3, D7)
// ---------------------------------------------------------------------------

/**
 * Cloud keeps the API at the host root; self-hosted installs put it under
 * `<domain>/open` (research §1.1, §6.25). An explicit `apiBase` always wins,
 * and a host that already carries a path is trusted as-is so `--host
 * https://pingcode.acme.com/open` does not become `/open/open`.
 */
export function deriveApiBase(host: string): string {
  const parsed = parseHost(host);
  const carriedPath = parsed.pathname.replace(/\/+$/, '');
  if (carriedPath !== '') return `${parsed.origin}${carriedPath}`;
  if (parsed.hostname.toLowerCase() === 'open.pingcode.com') return parsed.origin;
  return `${parsed.origin}/open`;
}

/** Normalise a user-supplied host into `scheme://authority[/path]` (no trailing slash). */
export function normalizeHost(host: string): string {
  const parsed = parseHost(host);
  const carriedPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${carriedPath}`;
}

function parseHost(host: string): URL {
  const trimmed = host.trim();
  if (trimmed === '') throw new UsageError('host must not be empty');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new UsageError(`invalid host: ${host}`, {
      hint: 'expected something like https://open.pingcode.com or https://pingcode.example.com',
    });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UsageError(`invalid host scheme: ${parsed.protocol}`, {
      hint: 'only http:// and https:// are supported',
    });
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = readEnv(env, ENV_CONFIG_DIR);
  if (override !== undefined) return override;
  return path.join(os.homedir(), '.pingcode');
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'config.json');
}

export function cacheDirPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'cache');
}

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------

/**
 * Read the config file. A missing file yields `{}`. Corrupt JSON is a
 * `UsageError` rather than a silent reset — losing stored credentials without
 * saying so would be worse.
 *
 * Warns on stderr when the file mode is looser than `0600`: a file we wrote can
 * be `chmod`'d later. Skipped on Windows, where the mode is meaningless.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  logger: Logger = silentLogger,
): Config {
  const file = configFilePath(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return {};
    throw new UsageError(`cannot read ${file}: ${errorMessage(error)}`, { cause: error });
  }

  warnOnLoosePermissions(file, logger);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON`, {
      hint: 'fix the file by hand, or delete it and run `pingcode auth login` again',
      cause: error,
    });
  }
  return coerceConfig(parsed);
}

function warnOnLoosePermissions(file: string, logger: Logger): void {
  if (process.platform === 'win32') return;
  try {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger.warn(
        `${file} has mode ${mode.toString(8).padStart(3, '0')}; it holds an org-admin credential. ` +
          `Run: chmod 600 ${file}`,
      );
    }
  } catch {
    // Not worth failing a read over.
  }
}

/**
 * Merge a patch into the config file and write it atomically.
 *
 * Cross-process safety (design §3): several `pingcode` invocations can run in
 * parallel, so a save **re-reads the file and merges only the fields it owns** —
 * a token refresh writes back `token` alone, never a whole stale `Config`.
 */
export function saveConfig(patch: ConfigPatch, env: NodeJS.ProcessEnv = process.env): Config {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, CONFIG_DIR_MODE);
    } catch {
      // Best effort: a pre-existing dir we do not own is not fatal.
    }
  }

  const current = safeReadForMerge(env);
  const merged: Config = { ...current };
  for (const [key, value] of Object.entries(patch) as [keyof Config, unknown][]) {
    if (value === undefined) continue;
    if (value === null) {
      delete merged[key];
      continue;
    }
    Object.assign(merged, { [key]: value });
  }

  const file = configFilePath(env);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;
  try {
    writeFileSync(tmp, serialized, { mode: CONFIG_FILE_MODE });
    if (process.platform !== 'win32') chmodSync(tmp, CONFIG_FILE_MODE);
    renameSync(tmp, file);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw new UsageError(`cannot write ${file}: ${errorMessage(error)}`, { cause: error });
  }
  return merged;
}

/** Delete the config file entirely (`auth logout`). */
export function deleteConfigFile(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(configFilePath(env), { force: true });
}

function safeReadForMerge(env: NodeJS.ProcessEnv): Config {
  try {
    return loadConfig(env, silentLogger);
  } catch {
    // A corrupt file must not block writing a good one.
    return {};
  }
}

/** Defensively narrow untrusted JSON into a `Config`. Unknown fields are dropped. */
export function coerceConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const config: Config = {};
  const host = asString(record.host);
  if (host !== undefined) config.host = host;
  const apiBase = asString(record.apiBase);
  if (apiBase !== undefined) config.apiBase = apiBase;
  const clientId = asString(record.clientId);
  if (clientId !== undefined) config.clientId = clientId;
  const clientSecret = asString(record.clientSecret);
  if (clientSecret !== undefined) config.clientSecret = clientSecret;
  const token = coerceToken(record.token);
  if (token !== undefined) config.token = token;
  const userToken = coerceUserToken(record.userToken);
  if (userToken !== undefined) config.userToken = userToken;
  const authMode = asAuthMode(record.authMode);
  if (authMode !== undefined) config.authMode = authMode;
  const oauthRedirectUri = asString(record.oauthRedirectUri);
  if (oauthRedirectUri !== undefined) config.oauthRedirectUri = oauthRedirectUri;
  return config;
}

function asAuthMode(raw: unknown): TokenKind | undefined {
  return raw === 'enterprise' || raw === 'user' ? raw : undefined;
}

/** Coerce a user-slot token: must be `kind:'user'` and carry a refresh token. */
function coerceUserToken(raw: unknown): UserTokenRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (asAuthMode(record.kind) !== 'user') return undefined;
  const base = coerceTokenBase(record);
  if (base === undefined) return undefined;
  const refreshToken = asString(record.refreshToken);
  if (refreshToken === undefined) return undefined;
  return { ...base, kind: 'user', refreshToken };
}

function coerceToken(raw: unknown): TokenRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  // A legacy enterprise token has no `kind` — default to enterprise (R6).
  const kind = asAuthMode(record.kind) ?? 'enterprise';
  const base = coerceTokenBase(record);
  if (base === undefined) return undefined;
  const token: TokenRecord = { ...base, kind };
  const refreshToken = asString(record.refreshToken);
  if (refreshToken !== undefined) token.refreshToken = refreshToken;
  return token;
}

/** Shared coercion for the core token fields; returns the shape minus `kind`. */
function coerceTokenBase(
  record: Record<string, unknown>,
): Omit<TokenRecord, 'kind'> | undefined {
  const accessToken = asString(record.accessToken);
  if (accessToken === undefined) return undefined;
  const token: Omit<TokenRecord, 'kind'> = {
    accessToken,
    expiresAtMs: asFiniteNumber(record.expiresAtMs) ?? 0,
    obtainedAtMs: asFiniteNumber(record.obtainedAtMs) ?? 0,
  };
  const scope = asString(record.scope);
  if (scope !== undefined) token.scope = scope;
  return token;
}

// ---------------------------------------------------------------------------
// precedence: flag → env → file (R1.4)
// ---------------------------------------------------------------------------

export function resolveSettings(input: {
  flags?: SettingsFlags | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  file?: Config | undefined;
}): ResolvedSettings {
  const flags = input.flags ?? {};
  const env = input.env ?? process.env;
  const file = input.file ?? {};

  const hostPick = pick(flags.host, readEnv(env, ENV_HOST), file.host);
  const host = normalizeHost(hostPick.value ?? DEFAULT_HOST);
  const hostSource: SettingSource = hostPick.value === undefined ? 'default' : hostPick.source;

  const apiBasePick = pick(flags.apiBase, undefined, file.apiBase);
  const apiBase =
    apiBasePick.value === undefined ? deriveApiBase(host) : normalizeHost(apiBasePick.value);
  const apiBaseSource: SettingSource =
    apiBasePick.value === undefined ? 'default' : apiBasePick.source;

  const clientIdPick = pick(flags.clientId, readEnv(env, ENV_CLIENT_ID), file.clientId);
  const clientSecretPick = pick(
    flags.clientSecret,
    readEnv(env, ENV_CLIENT_SECRET),
    file.clientSecret,
  );

  // Active-mode inference (D2): an explicit authMode wins; otherwise userToken→user,
  // token→enterprise (legacy), neither→user (brand-new default).
  const authMode = inferAuthMode(file);
  // The active slot's token: the user slot when in user mode, else the enterprise slot.
  const activeToken = authMode === 'user' ? file.userToken : file.token;

  return {
    host,
    apiBase,
    clientId: clientIdPick.value,
    clientSecret: clientSecretPick.value,
    token: activeToken,
    authMode,
    oauthRedirectUri: file.oauthRedirectUri,
    sources: {
      host: hostSource,
      apiBase: apiBaseSource,
      clientId: clientIdPick.value === undefined ? 'none' : clientIdPick.source,
      clientSecret: clientSecretPick.value === undefined ? 'none' : clientSecretPick.source,
    },
  };
}

/**
 * Infer the active mode when the config does not state it (D2, R6):
 * `userToken` present → `user`; else `token` present → `enterprise` (legacy,
 * never flipped on upgrade); else neither → `user` (brand-new default, R2).
 */
function inferAuthMode(file: Config): TokenKind {
  if (file.authMode !== undefined) return file.authMode;
  if (file.userToken !== undefined) return 'user';
  if (file.token !== undefined) return 'enterprise';
  return 'user';
}

/**
 * Should a credential be written to disk? Secrets that arrived by flag or env are
 * **not persisted unless `--save`** (design D6), so vault users can run with
 * nothing but the token on disk — or nothing at all.
 */
export function shouldPersistSecret(source: SettingSource | 'none', save: boolean): boolean {
  if (source === 'none') return false;
  if (source === 'file') return false; // already there
  return save;
}

function pick(
  flag: string | undefined,
  env: string | undefined,
  file: string | undefined,
): { value: string | undefined; source: SettingSource } {
  const fromFlag = trimToUndefined(flag);
  if (fromFlag !== undefined) return { value: fromFlag, source: 'flag' };
  const fromEnv = trimToUndefined(env);
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
  const fromFile = trimToUndefined(file);
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: undefined, source: 'default' };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return trimToUndefined(env[name]);
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
