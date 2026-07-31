import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { verifyAccess } from '../../api/projects';
import { acquireToken, clearToken, tokenIsFresh } from '../../core/auth';
import {
  configFilePath,
  saveConfig,
  shouldPersistSecret,
  type ConfigPatch,
} from '../../core/config';
import { UsageError } from '../../core/errors';
import { clearMetadataCache } from '../../core/metadata';
import { maskIdentifier } from '../../core/redact';
import { addGlobalOptions } from '../globals';
import { errLine, formatTimestamp, paint, printJson } from '../output';
import { contextFor, modeOf, printFields } from './common';

/**
 * `pingcode auth login | status [--check] | logout` (design §4.3).
 *
 * Two things here are deliberate and easy to get wrong:
 *  - verification uses **a capability we actually need** (`GET /v1/pjm/projects?page_size=1`),
 *    not `GET /v1/myself`: the org token is not user-bound and
 *    `pcp:read:account:personal` may simply not be granted to a pjm-scoped app,
 *    so a `/v1/myself` failure would reject a token that works perfectly;
 *  - a `client_secret` that arrived by flag/env is **not written to disk** unless
 *    `--save` is given (design D6) — the token is stored either way.
 */

type LoginFlags = {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  save?: boolean | undefined;
};

type StatusFlags = {
  check?: boolean | undefined;
};

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('authenticate against PingCode (Client Credentials app)');

  addGlobalOptions(
    auth
      .command('login')
      .description('acquire an org token and verify it against a real capability')
      .option('--client-id <id>', 'app client id (or PINGCODE_CLIENT_ID)')
      .option('--client-secret <secret>', 'app client secret (or PINGCODE_CLIENT_SECRET)')
      .option('--save', 'also store the client id/secret in the config file (mode 0600)'),
    { hidden: true },
  ).action(async (flags: LoginFlags, command: Command) => {
    await runLogin(flags, command);
  });

  addGlobalOptions(
    auth
      .command('status')
      .description('show host, masked client id and token state')
      .option('--check', 'additionally make one live API call to prove the token works'),
    { hidden: true },
  ).action(async (flags: StatusFlags, command: Command) => {
    await runStatus(flags, command);
  });

  addGlobalOptions(
    auth
      .command('logout')
      .description('remove the stored token and credentials, and clear the metadata cache'),
    { hidden: true },
  ).action((_flags: unknown, command: Command) => {
    runLogout(command);
  });
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

async function runLogin(flags: LoginFlags, command: Command): Promise<void> {
  let built = contextFor(command, {
    clientId: flags.clientId,
    clientSecret: flags.clientSecret,
  });

  // Prompt only when we are attached to a terminal and not in --json mode:
  // a prompt on stdout would break the stdout-is-pure-JSON contract, so the
  // prompts are written to stderr.
  let promptedClientId: string | undefined;
  let promptedClientSecret: string | undefined;
  if (built.settings.clientId === undefined) {
    promptedClientId = await promptVisible('PingCode client id: ', built.ctx.json);
  }
  if (built.settings.clientSecret === undefined) {
    promptedClientSecret = await promptHidden('PingCode client secret: ', built.ctx.json);
  }
  if (promptedClientId !== undefined || promptedClientSecret !== undefined) {
    built = contextFor(command, {
      clientId: flags.clientId ?? promptedClientId,
      clientSecret: flags.clientSecret ?? promptedClientSecret,
    });
  }

  const { ctx, settings } = built;
  const mode = modeOf(ctx);

  // Always start from scratch: a login is an explicit "use these credentials".
  clearToken(ctx);
  const token = await acquireToken(ctx); // persists `token` alone (design §3)
  const projectsTotal = await verifyAccess(ctx);

  // A different client_id sees different data, so the cache cannot survive.
  clearMetadataCache(ctx);

  const save = flags.save === true;
  const patch: ConfigPatch = { host: settings.host };
  const storeClientId = shouldPersistSecret(settings.sources.clientId, save);
  const storeClientSecret = shouldPersistSecret(settings.sources.clientSecret, save);
  if (storeClientId) patch.clientId = settings.clientId;
  if (storeClientSecret) patch.clientSecret = settings.clientSecret;
  saveConfig(patch, process.env);

  const credentialsStored = storeClientId && storeClientSecret;

  if (mode.json) {
    printJson({
      ok: true,
      host: settings.host,
      api_base: settings.apiBase,
      client_id: maskIdentifier(settings.clientId),
      credentials_stored: credentialsStored,
      projects_total: projectsTotal,
      token_expires_at: Math.floor(token.expiresAtMs / 1000),
      verified_with: 'GET /v1/pjm/projects?page_size=1',
    });
    return;
  }

  printFields([
    ['host', settings.host],
    ['api base', settings.apiBase],
    ['client id', maskIdentifier(settings.clientId)],
    ['projects visible', String(projectsTotal)],
    ['token expires', formatTimestamp(Math.floor(token.expiresAtMs / 1000))],
    ['config file', configFilePath(process.env)],
  ]);
  errLine(paint.green('authenticated'));
  if (!credentialsStored) {
    errLine(
      paint.dim(
        'the client id/secret were not written to disk (pass --save to store them); ' +
          'the token was stored, but a re-login will be needed once it expires',
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus(flags: StatusFlags, command: Command): Promise<void> {
  const { ctx, settings, file } = contextFor(command);
  const mode = modeOf(ctx);
  const token = settings.token;
  const expiresAt = token === undefined ? undefined : Math.floor(token.expiresAtMs / 1000);

  let check: { ok: boolean; endpoint: string; projects_total: number } | undefined;
  if (flags.check === true) {
    const projectsTotal = await verifyAccess(ctx);
    check = {
      ok: true,
      endpoint: 'GET /v1/pjm/projects?page_size=1',
      projects_total: projectsTotal,
    };
  }

  if (mode.json) {
    printJson({
      host: settings.host,
      api_base: settings.apiBase,
      // Never the secret, never the full token (R1.3, AC3/AC11).
      client_id: maskIdentifier(settings.clientId),
      client_id_source: settings.sources.clientId,
      client_secret_present: settings.clientSecret !== undefined,
      client_secret_source: settings.sources.clientSecret,
      credentials_stored: file.clientId !== undefined && file.clientSecret !== undefined,
      token_present: token !== undefined,
      token_fresh: tokenIsFresh(token, ctx.now()),
      token_expires_at: expiresAt ?? null,
      token_scope: token?.scope ?? null,
      config_file: configFilePath(process.env),
      ...(check === undefined ? {} : { check }),
    });
    return;
  }

  printFields([
    ['host', settings.host],
    ['api base', settings.apiBase],
    ['client id', `${maskIdentifier(settings.clientId)} (${settings.sources.clientId})`],
    [
      'client secret',
      settings.clientSecret === undefined
        ? '(not set)'
        : `(set, ${settings.sources.clientSecret})`,
    ],
    [
      'token',
      token === undefined
        ? '(none) — run `pingcode auth login`'
        : tokenIsFresh(token, ctx.now())
          ? 'present'
          : 'present but stale (it will be re-acquired on the next call)',
    ],
    ['token expires', expiresAt === undefined ? '' : formatTimestamp(expiresAt)],
    ['token scope', token?.scope ?? ''],
    ['config file', configFilePath(process.env)],
    [
      'live check',
      check === undefined
        ? '(skipped — pass --check)'
        : `ok · ${check.projects_total} project(s) visible via ${check.endpoint}`,
    ],
  ]);
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

function runLogout(command: Command): void {
  const { ctx } = contextFor(command);
  const mode = modeOf(ctx);

  // `host` is intentionally kept: it is not a credential, and losing it would
  // silently point a self-hosted user back at the public cloud.
  saveConfig({ token: null, clientId: null, clientSecret: null }, process.env);
  clearToken(ctx);
  clearMetadataCache(ctx);

  if (mode.json) {
    printJson({
      ok: true,
      cleared: ['token', 'client_id', 'client_secret', 'metadata_cache'],
      config_file: configFilePath(process.env),
    });
    return;
  }
  errLine(
    `removed the token, stored credentials and metadata cache (${configFilePath(process.env)})`,
  );
}

// ---------------------------------------------------------------------------
// prompts (stderr only, never stdout)
// ---------------------------------------------------------------------------

function missingCredential(what: string): UsageError {
  return new UsageError(`no ${what} available`, {
    hint: `pass --${what === 'client id' ? 'client-id' : 'client-secret'}, set PINGCODE_${
      what === 'client id' ? 'CLIENT_ID' : 'CLIENT_SECRET'
    }, or run the command from a terminal to be prompted`,
  });
}

async function promptVisible(question: string, json: boolean): Promise<string> {
  if (json || process.stdin.isTTY !== true) throw missingCredential('client id');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim();
    if (answer === '') throw missingCredential('client id');
    return answer;
  } finally {
    rl.close();
  }
}

/** Read a secret without echoing it. */
async function promptHidden(question: string, json: boolean): Promise<string> {
  const input = process.stdin;
  if (json || input.isTTY !== true) throw missingCredential('client secret');

  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  const value = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const done = (): void => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          done();
          process.stderr.write('\n');
          resolve(buffer);
          return;
        }
        if (char === '\u0003') {
          done();
          process.stderr.write('\n');
          reject(new UsageError('cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };
    input.on('data', onData);
  });

  const trimmed = value.trim();
  if (trimmed === '') throw missingCredential('client secret');
  return trimmed;
}
