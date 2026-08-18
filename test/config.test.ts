import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_MODE,
  DEFAULT_HOST,
  cacheDirPath,
  coerceConfig,
  configFilePath,
  deleteConfigFile,
  deriveApiBase,
  loadConfig,
  resolveSettings,
  saveConfig,
  shouldPersistSecret,
} from '../src/core/config';
import { UsageError } from '../src/core/errors';
import { createMemoryLogger } from '../src/core/logger';

const isWindows = process.platform === 'win32';

describe('deriveApiBase', () => {
  it('keeps the cloud host at its root', () => {
    expect(deriveApiBase(DEFAULT_HOST)).toBe('https://open.pingcode.com');
    expect(deriveApiBase('https://open.pingcode.com/')).toBe('https://open.pingcode.com');
  });

  it('puts self-hosted installs under /open (research §6.25)', () => {
    expect(deriveApiBase('https://pingcode.acme.com')).toBe('https://pingcode.acme.com/open');
    expect(deriveApiBase('pingcode.acme.com')).toBe('https://pingcode.acme.com/open');
    expect(deriveApiBase('https://pingcode.acme.com:8443')).toBe(
      'https://pingcode.acme.com:8443/open',
    );
  });

  it('does not double a path the user already supplied', () => {
    expect(deriveApiBase('https://pingcode.acme.com/open')).toBe('https://pingcode.acme.com/open');
    expect(deriveApiBase('https://pingcode.acme.com/open/')).toBe('https://pingcode.acme.com/open');
  });

  it('rejects nonsense hosts with a usage error', () => {
    expect(() => deriveApiBase('')).toThrow(UsageError);
    expect(() => deriveApiBase('   ')).toThrow(UsageError);
    expect(() => deriveApiBase('ftp://pingcode.acme.com')).toThrow(UsageError);
  });
});

describe('resolveSettings precedence (R1.4)', () => {
  const file = {
    host: 'https://file.pingcode.com',
    clientId: 'file-id',
    clientSecret: 'file-secret',
  };
  const env = {
    PINGCODE_HOST: 'https://env.pingcode.com',
    PINGCODE_CLIENT_ID: 'env-id',
    PINGCODE_CLIENT_SECRET: 'env-secret',
  };

  it('prefers flags over env over file', () => {
    const resolved = resolveSettings({
      flags: { host: 'https://flag.pingcode.com', clientId: 'flag-id' },
      env,
      file,
    });
    expect(resolved.host).toBe('https://flag.pingcode.com');
    expect(resolved.sources.host).toBe('flag');
    expect(resolved.clientId).toBe('flag-id');
    expect(resolved.sources.clientId).toBe('flag');
    // secret had no flag → env wins over file
    expect(resolved.clientSecret).toBe('env-secret');
    expect(resolved.sources.clientSecret).toBe('env');
  });

  it('falls back to env then file then default', () => {
    expect(resolveSettings({ env, file }).host).toBe('https://env.pingcode.com');
    expect(resolveSettings({ env: {}, file }).host).toBe('https://file.pingcode.com');
    const bare = resolveSettings({ env: {} });
    expect(bare.host).toBe(DEFAULT_HOST);
    expect(bare.sources.host).toBe('default');
    expect(bare.clientId).toBeUndefined();
    expect(bare.sources.clientId).toBe('none');
  });

  it('ignores blank env values', () => {
    const resolved = resolveSettings({ env: { PINGCODE_CLIENT_ID: '   ' }, file });
    expect(resolved.clientId).toBe('file-id');
    expect(resolved.sources.clientId).toBe('file');
  });

  it('derives apiBase from the winning host, but an explicit apiBase wins', () => {
    expect(resolveSettings({ env: {}, file: { host: 'https://acme.example.com' } }).apiBase).toBe(
      'https://acme.example.com/open',
    );
    const override = resolveSettings({
      env: {},
      file: { host: 'https://acme.example.com', apiBase: 'https://gateway.example.com/pc' },
    });
    expect(override.apiBase).toBe('https://gateway.example.com/pc');
    expect(override.sources.apiBase).toBe('file');
  });
});

describe('shouldPersistSecret (design D6)', () => {
  it('only persists flag/env secrets when --save is passed', () => {
    expect(shouldPersistSecret('flag', false)).toBe(false);
    expect(shouldPersistSecret('env', false)).toBe(false);
    expect(shouldPersistSecret('flag', true)).toBe(true);
    expect(shouldPersistSecret('env', true)).toBe(true);
    expect(shouldPersistSecret('file', true)).toBe(false);
    expect(shouldPersistSecret('none', true)).toBe(false);
  });
});

describe('config file storage', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-config-'));
    env = { PINGCODE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves paths under the config dir override', () => {
    expect(configFilePath(env)).toBe(path.join(dir, 'config.json'));
    expect(cacheDirPath(env)).toBe(path.join(dir, 'cache'));
  });

  it('returns an empty config when nothing is stored', () => {
    expect(loadConfig(env)).toEqual({});
  });

  it('writes the file 0600 inside a 0700 dir', () => {
    saveConfig({ host: DEFAULT_HOST, clientId: 'abc' }, env);
    const file = configFilePath(env);
    expect(loadConfig(env)).toEqual({ host: DEFAULT_HOST, clientId: 'abc' });
    if (isWindows) return; // POSIX modes are a no-op on Windows (design D6)
    expect(statSync(file).mode & 0o777).toBe(CONFIG_FILE_MODE);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('merges only the fields it owns, re-reading first (design §3)', () => {
    saveConfig({ host: DEFAULT_HOST, clientId: 'abc', clientSecret: 'shh' }, env);
    // Simulate another process updating the file behind our back.
    const file = configFilePath(env);
    const outside = { ...JSON.parse(readFileSync(file, 'utf8')), host: 'https://other.example.com' };
    writeFileSync(file, JSON.stringify(outside), { mode: CONFIG_FILE_MODE });

    saveConfig(
      { token: { accessToken: 't', expiresAtMs: 123, obtainedAtMs: 1 } },
      env,
    );

    const after = loadConfig(env);
    expect(after.host).toBe('https://other.example.com'); // not clobbered
    expect(after.clientId).toBe('abc');
    expect(after.token?.accessToken).toBe('t');
  });

  it('round-trips the user-token keys through save/load (D3)', () => {
    saveConfig(
      {
        oauthRedirectUri: 'http://127.0.0.1:8732/callback',
        authMode: 'user',
        userToken: {
          accessToken: 'u',
          refreshToken: 'rt',
          expiresAtMs: 5,
          obtainedAtMs: 1,
          kind: 'user',
        },
      },
      env,
    );
    const after = loadConfig(env);
    expect(after.oauthRedirectUri).toBe('http://127.0.0.1:8732/callback');
    expect(after.authMode).toBe('user');
    expect(after.userToken?.accessToken).toBe('u');
    expect(after.userToken?.refreshToken).toBe('rt');
  });

  it('deletes fields on an explicit null', () => {
    saveConfig({ clientId: 'abc', clientSecret: 'shh' }, env);
    saveConfig({ clientSecret: null }, env);
    const after = loadConfig(env);
    expect(after.clientId).toBe('abc');
    expect(after.clientSecret).toBeUndefined();
  });

  it('warns when the file mode is looser than 0600', () => {
    if (isWindows) return;
    saveConfig({ clientId: 'abc' }, env);
    const file = configFilePath(env);
    chmodSync(file, 0o644);
    const logger = createMemoryLogger();
    loadConfig(env, logger);
    expect(logger.lines.join('\n')).toMatch(/mode 644/);
  });

  it('rejects a corrupt config file with a usage error', () => {
    writeFileSync(configFilePath(env), '{not json', { mode: CONFIG_FILE_MODE });
    expect(() => loadConfig(env)).toThrow(UsageError);
  });

  it('still writes a good file over a corrupt one', () => {
    writeFileSync(configFilePath(env), '{not json', { mode: CONFIG_FILE_MODE });
    saveConfig({ clientId: 'abc' }, env);
    expect(loadConfig(env).clientId).toBe('abc');
  });

  it('removes the file on delete', () => {
    saveConfig({ clientId: 'abc' }, env);
    deleteConfigFile(env);
    expect(loadConfig(env)).toEqual({});
    deleteConfigFile(env); // idempotent
  });
});

describe('coerceConfig', () => {
  it('drops unknown and wrongly-typed fields', () => {
    expect(
      coerceConfig({
        host: 'https://open.pingcode.com',
        clientId: 42,
        bogus: 'x',
        token: { accessToken: 'tok', expiresAtMs: 5, obtainedAtMs: 1, scope: 'a', extra: 1 },
      }),
    ).toEqual({
      host: 'https://open.pingcode.com',
      token: { accessToken: 'tok', expiresAtMs: 5, obtainedAtMs: 1, scope: 'a', kind: 'enterprise' },
    });
  });

  it('drops a token without an access token', () => {
    expect(coerceConfig({ token: { expiresAtMs: 5 } })).toEqual({});
    expect(coerceConfig(null)).toEqual({});
    expect(coerceConfig('nope')).toEqual({});
  });

  it('coerces the new user-token keys (D1/D3)', () => {
    expect(
      coerceConfig({
        oauthRedirectUri: 'http://127.0.0.1:8732/callback',
        authMode: 'user',
        userToken: {
          accessToken: 'u',
          refreshToken: 'rt',
          expiresAtMs: 5,
          obtainedAtMs: 1,
          kind: 'user',
        },
      }),
    ).toEqual({
      oauthRedirectUri: 'http://127.0.0.1:8732/callback',
      authMode: 'user',
      userToken: {
        accessToken: 'u',
        refreshToken: 'rt',
        expiresAtMs: 5,
        obtainedAtMs: 1,
        kind: 'user',
      },
    });
  });

  it('drops a userToken without a refresh token or with the wrong kind', () => {
    expect(coerceConfig({ userToken: { accessToken: 'u', kind: 'user' } })).toEqual({});
    expect(
      coerceConfig({
        userToken: {
          accessToken: 'u',
          refreshToken: 'rt',
          expiresAtMs: 5,
          obtainedAtMs: 1,
          kind: 'enterprise',
        },
      }),
    ).toEqual({});
  });

  it('drops an invalid authMode', () => {
    expect(coerceConfig({ authMode: 'bogus' })).toEqual({});
  });

  it('defaults a legacy token (no kind) to enterprise (R6)', () => {
    expect(coerceConfig({ token: { accessToken: 'tok', expiresAtMs: 5, obtainedAtMs: 1 } })).toEqual(
      {
        token: { accessToken: 'tok', expiresAtMs: 5, obtainedAtMs: 1, kind: 'enterprise' },
      },
    );
  });
});

describe('resolveSettings auth-mode inference (D2)', () => {
  it('prefers user when a userToken is present', () => {
    const file = {
      token: { accessToken: 'ent', expiresAtMs: 5, obtainedAtMs: 1, kind: 'enterprise' as const },
      userToken: {
        accessToken: 'usr',
        refreshToken: 'rt',
        expiresAtMs: 6,
        obtainedAtMs: 2,
        kind: 'user' as const,
      },
    };
    const resolved = resolveSettings({ env: {}, file });
    expect(resolved.authMode).toBe('user');
    expect(resolved.token?.accessToken).toBe('usr'); // active slot = user
  });

  it('infers enterprise for a legacy token-only config (R6)', () => {
    const file = { token: { accessToken: 'ent', expiresAtMs: 5, obtainedAtMs: 1 } };
    const resolved = resolveSettings({ env: {}, file });
    expect(resolved.authMode).toBe('enterprise');
    expect(resolved.token?.accessToken).toBe('ent');
  });

  it('defaults to user for a brand-new config with no token (R2)', () => {
    const resolved = resolveSettings({ env: {} });
    expect(resolved.authMode).toBe('user');
    expect(resolved.token).toBeUndefined();
  });

  it('honours an explicit authMode over inference', () => {
    const file = {
      authMode: 'enterprise' as const,
      token: { accessToken: 'ent', expiresAtMs: 5, obtainedAtMs: 1, kind: 'enterprise' as const },
      userToken: {
        accessToken: 'usr',
        refreshToken: 'rt',
        expiresAtMs: 6,
        obtainedAtMs: 2,
        kind: 'user' as const,
      },
    };
    const resolved = resolveSettings({ env: {}, file });
    expect(resolved.authMode).toBe('enterprise'); // explicit wins despite userToken present
    expect(resolved.token?.accessToken).toBe('ent'); // active slot = enterprise
  });
});
