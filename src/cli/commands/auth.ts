import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { getMyself } from '../../api/meta';
import { verifyAccess } from '../../api/projects';
import {
  acquireToken,
  acquireUserToken,
  clearToken,
  tokenIsFresh,
} from '../../core/auth';
import {
  configFilePath,
  saveConfig,
  shouldPersistSecret,
  type ConfigPatch,
  type TokenKind,
} from '../../core/config';
import { UsageError } from '../../core/errors';
import { clearMetadataCache } from '../../core/metadata';
import { maskIdentifier } from '../../core/redact';
import { addGlobalOptions } from '../globals';
import { errLine, formatTimestamp, paint, printJson } from '../output';
import {
  buildAuthorizeUrl,
  captureCodeFromLoopback,
  openBrowser,
  printAuthorizeUrl,
} from './oauth';
import { contextFor, modeOf, printFields } from './common';

/**
 * `pingcode auth login | status [--check] | logout` (design §4.3, §5).
 *
 * Two modes coexist (design §5):
 *  - **enterprise** (`client_credentials`) — the app/admin identity, verified with
 *    a real capability (`GET /v1/pjm/projects?page_size=1`), unchanged from before;
 *  - **user** (`authorization_code`) — acts as the authenticating human, verified
 *    with `GET /v1/myself`. This is the **default** (R2).
 *
 * Two things here are deliberate and easy to get wrong:
 *  - verification uses **a capability we actually need**, never `/v1/myself` for the
 *    enterprise token: the org token is not user-bound and `pcp:read:account:personal`
 *    may simply not be granted, so a `/v1/myself` failure would reject a token that
 *    works perfectly;
 *  - a `client_secret` that arrived by flag/env is **not written to disk** unless
 *    `--save` is given (design D6) — the token is stored either way.
 */

type AuthMode = 'enterprise' | 'user';
type AuthorizeChannel = 'browser' | 'paste';

type LoginFlags = {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  save?: boolean | undefined;
  mode?: string | undefined;
};

type StatusFlags = {
  check?: boolean | undefined;
};

type LogoutFlags = {
  all?: boolean | undefined;
};

/** A live `status --check` result, discriminated by the endpoint it probed. */
type StatusCheck =
  | { ok: true; endpoint: 'GET /v1/myself'; user: string }
  | { ok: true; endpoint: 'GET /v1/pjm/projects?page_size=1'; projects_total: number };

/**
 * Test seams for the interactive login steps (design D13). Production defaults
 * read from the terminal (stderr); tests stub these so no TTY or browser is
 * needed. `captureCode` defaults to the real loopback; the browser-channel
 * command test stubs it, while `captureCodeFromLoopback` itself is unit-tested
 * against a real `127.0.0.1` listener.
 */
export const loginHooks: {
  selectMode: (json: boolean) => Promise<AuthMode>;
  selectChannel: (json: boolean) => Promise<AuthorizeChannel>;
  openBrowser: (url: string) => void;
  captureCode: (
    ctx: import('../../core/context').Ctx,
    opts?: { timeoutMs?: number },
  ) => Promise<{ code: string; domain?: string }>;
  readCode: (json: boolean) => Promise<string>;
} = {
  selectMode: defaultSelectMode,
  selectChannel: defaultSelectChannel,
  openBrowser,
  captureCode: captureCodeFromLoopback,
  readCode: readCodeFromTerminal,
};

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('authenticate against PingCode (enterprise app or user token)');

  addGlobalOptions(
    auth
      .command('login')
      .description('acquire a token (user token by default) and verify it')
      .option('--client-id <id>', 'app client id (or PINGCODE_CLIENT_ID)')
      .option('--client-secret <secret>', 'app client secret (or PINGCODE_CLIENT_SECRET)')
      .option('--save', 'also store the client id/secret in the config file (mode 0600)')
      .option(
        '--mode <mode>',
        'auth mode: user (authorization_code, default) or enterprise (client_credentials)',
      ),
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
      .description('clear the active token slot (both with --all) and the metadata cache')
      .option('--all', 'clear both the enterprise and user token slots (and authMode)'),
    { hidden: true },
  ).action((flags: LogoutFlags, command: Command) => {
    runLogout(flags, command);
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

  // Resolve the mode: an explicit --mode wins; otherwise default to user (R2)
  // unless a terminal operator is prompted.
  const authMode = await resolveMode(flags.mode, ctx.json);

  // Always start from scratch: a login is an explicit "use these credentials".
  clearToken(ctx);

  let tokenKind: TokenKind;
  let user: { id: string; name?: string; display_name?: string; username?: string } | undefined;
  let verifiedWith: string;

  if (authMode === 'enterprise') {
    // Enterprise path — byte-for-byte equivalent to the pre-user-mode login
    // (design D11): acquire from client_credentials, verify with a real
    // capability, persist the enterprise slot.
    const token = await acquireToken(ctx); // persists `token` + authMode='enterprise'
    const projectsTotal = await verifyAccess(ctx);
    tokenKind = token.kind ?? 'enterprise';
    verifiedWith = 'GET /v1/pjm/projects?page_size=1';
    clearMetadataCache(ctx);
    finishLogin(built, flags, { authMode, tokenKind, projectsTotal, verifiedWith, token });
    return;
  }

  // --- user (authorization_code) path (design D12) ---
  const clientId = requireClientId(settings.clientId);

  // 1. channel: browser (loopback) or paste (manual code).
  const channel = await resolveChannel(ctx.json);
  // 2. build + print the authorize URL (stderr); best-effort open the browser.
  const authorizeUrl = buildAuthorizeUrl(settings.host, clientId);
  printAuthorizeUrl(authorizeUrl);
  if (channel === 'browser') loginHooks.openBrowser(authorizeUrl);

  // 3. obtain the code.
  const code =
    channel === 'paste' ? await loginHooks.readCode(ctx.json) : (await loginHooks.captureCode(ctx)).code;

  // 4. exchange the code → user token (persists userToken + authMode='user').
  const token = await acquireUserToken(ctx, code);

  // 5. verify against the bound identity (design D12 step 6).
  const me = await getMyself(ctx);
  const meIdentity: LoginOutcome['user'] = { id: me.id };
  if (me.name !== undefined) meIdentity.name = me.name;
  if (me.display_name !== undefined) meIdentity.display_name = me.display_name;
  if (me.username !== undefined) meIdentity.username = me.username;
  user = meIdentity;
  tokenKind = 'user';
  verifiedWith = 'GET /v1/myself';
  clearMetadataCache(ctx);
  finishLogin(built, flags, { authMode, tokenKind, user, verifiedWith, token });
}

type LoginOutcome = {
  authMode: AuthMode;
  tokenKind: TokenKind;
  verifiedWith: string;
  token: { expiresAtMs: number };
  projectsTotal?: number | undefined;
  user?: { id: string; name?: string; display_name?: string; username?: string } | undefined;
};

/** Shared tail of both login branches: persist client creds, then print. */
function finishLogin(
  built: ReturnType<typeof contextFor>,
  flags: LoginFlags,
  outcome: LoginOutcome,
): void {
  const { settings } = built;
  const save = flags.save === true;
  const patch: ConfigPatch = { host: settings.host };
  const storeClientId = shouldPersistSecret(settings.sources.clientId, save);
  const storeClientSecret = shouldPersistSecret(settings.sources.clientSecret, save);
  if (storeClientId) patch.clientId = settings.clientId;
  if (storeClientSecret) patch.clientSecret = settings.clientSecret;
  saveConfig(patch, process.env);

  // Credentials that came *from* the config file are already on disk, so
  // `shouldPersistSecret` correctly declines to rewrite them — but the "not
  // written to disk" note would then be true of this invocation and misleading
  // in context (research/s8-smoke.md, cosmetic nits).
  const alreadyStored = built.file.clientId !== undefined && built.file.clientSecret !== undefined;
  const credentialsStored = alreadyStored || (storeClientId && storeClientSecret);

  const mode = modeOf(built.ctx);
  if (mode.json) {
    printJson({
      ok: true,
      mode: outcome.authMode,
      kind: outcome.tokenKind,
      host: settings.host,
      api_base: settings.apiBase,
      client_id: maskIdentifier(settings.clientId),
      credentials_stored: credentialsStored,
      ...(outcome.user === undefined ? {} : { user: outcome.user }),
      ...(outcome.projectsTotal === undefined ? {} : { projects_total: outcome.projectsTotal }),
      token_expires_at: Math.floor(outcome.token.expiresAtMs / 1000),
      verified_with: outcome.verifiedWith,
    });
    return;
  }

  const fields: [string, string][] = [
    ['host', settings.host],
    ['api base', settings.apiBase],
    ['client id', maskIdentifier(settings.clientId)],
    ['mode', outcome.authMode],
    ['token kind', outcome.tokenKind],
  ];
  if (outcome.user !== undefined) {
    fields.push(['user', outcome.user.display_name ?? outcome.user.name ?? outcome.user.username ?? outcome.user.id]);
  }
  if (outcome.projectsTotal !== undefined) {
    fields.push(['projects visible', String(outcome.projectsTotal)]);
  }
  fields.push(['token expires', formatTimestamp(Math.floor(outcome.token.expiresAtMs / 1000))]);
  fields.push(['config file', configFilePath(process.env)]);
  printFields(fields);
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

/** Resolve the login mode: an explicit --mode wins, else the hook's default. */
async function resolveMode(flag: string | undefined, json: boolean): Promise<AuthMode> {
  if (flag === 'enterprise' || flag === 'user') return flag;
  if (flag !== undefined) {
    throw new UsageError(`--mode must be "enterprise" or "user", got "${flag}"`);
  }
  return await loginHooks.selectMode(json);
}

/** Resolve the authorize channel via the hook (default respects TTY/--json). */
async function resolveChannel(json: boolean): Promise<AuthorizeChannel> {
  return await loginHooks.selectChannel(json);
}

function requireClientId(clientId: string | undefined): string {
  if (clientId !== undefined && clientId !== '') return clientId;
  throw new UsageError('no client id available for the authorize URL', {
    hint: 'pass --client-id, set PINGCODE_CLIENT_ID, or run from a terminal to be prompted',
  });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus(flags: StatusFlags, command: Command): Promise<void> {
  const { ctx, settings, file } = contextFor(command);
  const mode = modeOf(ctx);
  const token = settings.token;
  const expiresAt = token === undefined ? undefined : Math.floor(token.expiresAtMs / 1000);
  const authMode: AuthMode = settings.authMode;
  const tokenKind: TokenKind = token?.kind ?? 'enterprise';

  let check: StatusCheck | undefined;
  if (flags.check === true) {
    if (authMode === 'user') {
      const me = await getMyself(ctx);
      check = { ok: true, endpoint: 'GET /v1/myself', user: me.display_name ?? me.name ?? me.username ?? me.id };
    } else {
      const projectsTotal = await verifyAccess(ctx);
      check = { ok: true, endpoint: 'GET /v1/pjm/projects?page_size=1', projects_total: projectsTotal };
    }
  }

  if (mode.json) {
    printJson({
      host: settings.host,
      api_base: settings.apiBase,
      auth_mode: authMode,
      // Never the secret, never the full token (R1.3, AC3/AC11).
      client_id: maskIdentifier(settings.clientId),
      client_id_source: settings.sources.clientId,
      client_secret_present: settings.clientSecret !== undefined,
      client_secret_source: settings.sources.clientSecret,
      credentials_stored: file.clientId !== undefined && file.clientSecret !== undefined,
      token_present: token !== undefined,
      token_kind: tokenKind,
      token_fresh: tokenIsFresh(token, ctx.now()),
      token_expires_at: expiresAt ?? null,
      token_scope: token?.scope ?? null,
      // User-slot refresh-token presence (AC8) — boolean only, never the value.
      user_token_present: file.userToken !== undefined,
      user_refresh_token_present: file.userToken?.refreshToken !== undefined,
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
    ['auth mode', authMode],
    [
      'token',
      token === undefined
        ? '(none) — run `pingcode auth login`'
        : tokenIsFresh(token, ctx.now())
          ? `present (${tokenKind})`
          : `present but stale (${tokenKind}) — it will be re-acquired on the next call`,
    ],
    ['token expires', expiresAt === undefined ? '' : formatTimestamp(expiresAt)],
    ['token scope', token?.scope ?? ''],
    ['user slot', file.userToken === undefined ? '(none)' : 'present (with refresh token)'],
    ['config file', configFilePath(process.env)],
    [
      'live check',
      check === undefined
        ? '(skipped — pass --check)'
        : check.endpoint === 'GET /v1/myself'
          ? `ok · signed in as ${check.user} via ${check.endpoint}`
          : `ok · ${check.projects_total} project(s) visible via ${check.endpoint}`,
    ],
  ]);
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

function runLogout(flags: LogoutFlags, command: Command): void {
  const { ctx, settings } = contextFor(command);
  const mode = modeOf(ctx);
  const all = flags.all === true;

  // `host` is intentionally kept: it is not a credential, and losing it would
  // silently point a self-hosted user back at the public cloud.
  let cleared: string[];
  if (all) {
    // Full wipe: both token slots + the active mode + the app credentials.
    // `host` survives (it is not a credential) and is re-stamped so the
    // re-read+merge in saveConfig keeps it. This restores the original
    // pre-feature `logout` semantics; the default (no --all) is the surgical
    // "active slot only" path above (design D14).
    saveConfig(
      { host: settings.host, token: null, userToken: null, authMode: null, clientId: null, clientSecret: null },
      process.env,
    );
    cleared = ['token', 'user_token', 'auth_mode', 'client_id', 'client_secret', 'metadata_cache'];
  } else {
    // Clear only the ACTIVE slot + authMode; the other slot + creds survive so
    // a switch back is instant (R8, design D14). Clearing authMode is required:
    // leaving it set with the active slot emptied would hide the other slot
    // (resolveSettings reads the active slot by mode).
    const slot = settings.authMode === 'user' ? 'userToken' : 'token';
    saveConfig({ [slot]: null, authMode: null }, process.env);
    cleared = [slot === 'userToken' ? 'user_token' : 'token', 'auth_mode', 'metadata_cache'];
  }
  clearToken(ctx);
  clearMetadataCache(ctx);

  if (mode.json) {
    printJson({
      ok: true,
      cleared,
      config_file: configFilePath(process.env),
    });
    return;
  }
  errLine(`cleared ${cleared.join(', ')} (${configFilePath(process.env)})`);
}

// ---------------------------------------------------------------------------
// interactive prompts (stderr only, never stdout)
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

/** Read the pasted authorization code (stderr prompt; never stdout). */
async function readCodeFromTerminal(json: boolean): Promise<string> {
  if (json || process.stdin.isTTY !== true) {
    throw new UsageError('no authorization code available', {
      hint: 'run from a terminal to paste the code, or use the browser channel',
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question('authorization code: ')).trim();
    if (answer === '') {
      throw new UsageError('no authorization code entered', {
        hint: 'paste the code from the authorize page',
      });
    }
    return answer;
  } finally {
    rl.close();
  }
}

type Choice<T extends string> = { key: T; label: string };

/** A stderr choice prompt; empty input picks the default. Assumes a TTY. */
async function promptChoice<T extends string>(
  question: string,
  choices: readonly Choice<T>[],
  defaultKey: T,
): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const width = Math.max(...choices.map((choice) => choice.key.length));
    errLine(question);
    for (const choice of choices) {
      const mark = choice.key === defaultKey ? '*' : ' ';
      errLine(`  ${mark} ${choice.key.padEnd(width)}  ${choice.label}`);
    }
    const answer = (await rl.question(`choice [${defaultKey}]: `)).trim();
    if (answer === '') return defaultKey;
    const match = choices.find((choice) => choice.key === answer);
    if (match === undefined) {
      throw new UsageError(`invalid choice: "${answer}"`, {
        hint: `choose one of: ${choices.map((choice) => choice.key).join(', ')}`,
      });
    }
    return match.key;
  } finally {
    rl.close();
  }
}

/** Default mode prompt: pre-selects `user` (R2). */
async function defaultSelectMode(json: boolean): Promise<AuthMode> {
  if (json || process.stdin.isTTY !== true) return 'user';
  return await promptChoice<AuthMode>('auth mode', [
    { key: 'user', label: 'authorization_code — acts as you (default)' },
    { key: 'enterprise', label: 'client_credentials — app/admin identity' },
  ], 'user');
}

/** Default channel prompt: pre-selects `browser` (design D12 step 4). */
async function defaultSelectChannel(json: boolean): Promise<AuthorizeChannel> {
  if (json || process.stdin.isTTY !== true) return 'browser';
  return await promptChoice<AuthorizeChannel>('authorize via', [
    { key: 'browser', label: 'open the URL, you log in + consent, CLI catches the redirect' },
    { key: 'paste', label: 'print the URL, you paste the code you generated' },
  ], 'browser');
}
