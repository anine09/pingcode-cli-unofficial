import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext, readGlobalOptions } from '../src/cli/globals';
import { buildProgram } from '../src/cli/program';
import { DEFAULT_HOST, loadConfig, saveConfig } from '../src/core/config';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-globals-'));
  env = { PINGCODE_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function parseGlobals(argv: string[]): ReturnType<typeof readGlobalOptions> {
  const program = buildProgram();
  const sub = new Command('probe');
  let captured: ReturnType<typeof readGlobalOptions> | undefined;
  sub.action(() => {
    captured = readGlobalOptions(sub);
  });
  program.addCommand(sub);
  program.parse(['node', 'pingcode', ...argv, 'probe']);
  if (captured === undefined) throw new Error('action did not run');
  return captured;
}

describe('readGlobalOptions', () => {
  it('defaults to human output, no dry run, cache on', () => {
    expect(parseGlobals([])).toEqual({
      host: undefined,
      json: false,
      dryRun: false,
      useCache: true,
      verbose: false,
    });
  });

  it('reads every global flag, including --no-cache', () => {
    expect(parseGlobals(['--json', '--dry-run', '--no-cache', '--verbose', '--host', 'https://x.example.com'])).toEqual({
      host: 'https://x.example.com',
      json: true,
      dryRun: true,
      useCache: false,
      verbose: true,
    });
  });
});

describe('buildContext', () => {
  const globals = {
    host: undefined,
    json: false,
    dryRun: false,
    useCache: true,
    verbose: false,
  };

  it('derives the api base from the default host', () => {
    const { ctx, settings } = buildContext({ globals, env });
    expect(settings.host).toBe(DEFAULT_HOST);
    expect(ctx.apiBase).toBe('https://open.pingcode.com');
    expect(ctx.credentials.clientId).toBeUndefined();
  });

  it('applies flag > env > file precedence and self-hosted derivation', () => {
    saveConfig({ host: 'https://file.example.com', clientId: 'file-id' }, env);
    const { ctx, settings } = buildContext({
      globals: { ...globals, host: 'https://flag.example.com' },
      credentials: { clientSecret: 'flag-secret' },
      env: { ...env, PINGCODE_CLIENT_ID: 'env-id' },
    });
    expect(ctx.apiBase).toBe('https://flag.example.com/open');
    expect(ctx.credentials.clientId).toBe('env-id');
    expect(settings.sources.clientId).toBe('env');
    expect(ctx.credentials.clientSecret).toBe('flag-secret');
    expect(settings.sources.clientSecret).toBe('flag');
  });

  it('loads a stored token into the context', () => {
    saveConfig({ token: { accessToken: 'stored', expiresAtMs: 42, obtainedAtMs: 1 } }, env);
    const { ctx } = buildContext({ globals, env });
    expect(ctx.auth.token?.accessToken).toBe('stored');
  });

  it('persists a refreshed token by merging only that field', () => {
    saveConfig({ host: DEFAULT_HOST, clientId: 'keep-me' }, env);
    const { ctx } = buildContext({ globals, env });
    ctx.persistToken?.({ accessToken: 'fresh', expiresAtMs: 99, obtainedAtMs: 9 });
    const stored = loadConfig(env);
    expect(stored.clientId).toBe('keep-me');
    expect(stored.token?.accessToken).toBe('fresh');
  });

  it('routes a user token to the userToken slot and stamps authMode (D5)', () => {
    saveConfig({ host: DEFAULT_HOST, clientId: 'keep-me' }, env);
    const { ctx } = buildContext({ globals, env });
    ctx.persistToken?.({
      accessToken: 'user-access',
      refreshToken: 'rt-1',
      expiresAtMs: 99,
      obtainedAtMs: 9,
      kind: 'user',
    });
    const stored = loadConfig(env);
    expect(stored.clientId).toBe('keep-me'); // not clobbered
    expect(stored.userToken?.accessToken).toBe('user-access');
    expect(stored.userToken?.refreshToken).toBe('rt-1');
    expect(stored.userToken?.kind).toBe('user');
    expect(stored.authMode).toBe('user');
    expect(stored.token).toBeUndefined(); // enterprise slot untouched
  });

  it('stamps authMode enterprise when persisting an enterprise token (D5)', () => {
    const { ctx } = buildContext({ globals, env });
    ctx.persistToken?.({ accessToken: 'ent', expiresAtMs: 5, obtainedAtMs: 1 });
    const stored = loadConfig(env);
    expect(stored.token?.accessToken).toBe('ent');
    expect(stored.authMode).toBe('enterprise');
    expect(stored.userToken).toBeUndefined();
  });

  it('loads the active slot token and stamps ctx.auth.mode from settings', () => {
    saveConfig(
      {
        host: DEFAULT_HOST,
        token: { accessToken: 'ent', expiresAtMs: 5, obtainedAtMs: 1, kind: 'enterprise' },
        userToken: {
          accessToken: 'usr',
          refreshToken: 'rt',
          expiresAtMs: 6,
          obtainedAtMs: 2,
          kind: 'user',
        },
        authMode: 'user',
      },
      env,
    );
    const { ctx, settings } = buildContext({ globals, env });
    expect(settings.authMode).toBe('user');
    expect(ctx.auth.mode).toBe('user');
    expect(ctx.auth.token?.accessToken).toBe('usr'); // active slot = user
    expect(ctx.oauth.redirectUri).toBeUndefined();
  });

  it('surfaces oauthRedirectUri on ctx.oauth and settings', () => {
    saveConfig(
      { host: DEFAULT_HOST, oauthRedirectUri: 'http://127.0.0.1:8732/callback' },
      env,
    );
    const { ctx, settings } = buildContext({ globals, env });
    expect(settings.oauthRedirectUri).toBe('http://127.0.0.1:8732/callback');
    expect(ctx.oauth.redirectUri).toBe('http://127.0.0.1:8732/callback');
  });

  it('maps --dry-run / --json / --no-cache onto the context', () => {
    const { ctx } = buildContext({
      globals: { host: undefined, json: true, dryRun: true, useCache: false, verbose: true },
      env,
    });
    expect(ctx.dryRun).toBe(true);
    expect(ctx.json).toBe(true);
    expect(ctx.useCache).toBe(false);
    expect(ctx.verbose).toBe(true);
  });
});
