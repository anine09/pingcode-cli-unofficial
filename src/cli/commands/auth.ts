import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { getMyself } from '../../api/meta';
import { verifyAccess } from '../../api/projects';
import {
  acquireToken,
  acquireUserToken,
  clearToken,
  setPersonalAccessToken,
  tokenIsFresh,
} from '../../core/auth';
import {
  configFilePath,
  saveConfig,
  shouldPersistSecret,
  type ConfigPatch,
  type TokenKind,
} from '../../core/config';
import { PermissionError, UsageError } from '../../core/errors';
import { clearMetadataCache } from '../../core/metadata';
import { maskIdentifier } from '../../core/redact';
import { addGlobalOptions } from '../globals';
import { errLine, formatTimestamp, paint, printJson } from '../output';
import { buildAuthorizeUrl, extractCode, printAuthorizeUrl } from './oauth';
import { contextFor, modeOf, printFields } from './common';

/**
 * `pingcode auth login | status [--check] | logout` (design §4.3, §5).
 *
 * Three modes coexist:
 *  - **enterprise** (`client_credentials`) — the app/admin identity, verified with
 *    a real capability (`GET /v1/pjm/projects?page_size=1`), unchanged from before;
 *  - **user** (`authorization_code`) — acts as the authenticating human, verified
 *    with `GET /v1/myself`. This is the **default** (R2);
 *  - **pat** (personal access token) — a token minted in PingCode personal
 *    settings and pasted in, for scripts/CI where the OAuth dance is impractical.
 *    It needs no app credentials, cannot be refreshed, and carries whatever
 *    `scopes` it was created with, so its verification is tolerant: `/v1/myself`
 *    first, then one capability probe, and an unverified-but-stored outcome only
 *    when neither scope is granted.
 *
 * Two things here are deliberate and easy to get wrong:
 *  - verification uses **a capability we actually need**, never `/v1/myself` for the
 *    enterprise token: the org token is not user-bound and `pcp:read:account:personal`
 *    may simply not be granted, so a `/v1/myself` failure would reject a token that
 *    works perfectly;
 *  - a `client_secret` that arrived by flag/env is **not written to disk** unless
 *    `--save` is given (design D6) — the token is stored either way.
 */

type AuthMode = 'enterprise' | 'user' | 'pat';

type LoginFlags = {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  save?: boolean | undefined;
  mode?: string | undefined;
  /** Authorization code (skips the interactive paste). */
  code?: string | undefined;
  /** Personal access token (`--mode pat`; skips the hidden prompt). */
  token?: string | undefined;
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
 * read from the terminal (stderr); tests stub these so no TTY is needed.
 */
export const loginHooks: {
  selectMode: (json: boolean) => Promise<AuthMode>;
  readPaste: (json: boolean) => Promise<string>;
  readToken: (json: boolean) => Promise<string>;
} = {
  selectMode: defaultSelectMode,
  readPaste: readPasteFromTerminal,
  readToken: readTokenFromTerminal,
};

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('authenticate against PingCode (enterprise app, user token or personal access token)');

  addGlobalOptions(
    auth
      .command('login')
      .description('acquire a token (user token by default) and verify it')
      .option('--client-id <id>', 'app client id (or PINGCODE_CLIENT_ID)')
      .option('--client-secret <secret>', 'app client secret (or PINGCODE_CLIENT_SECRET)')
      .option('--save', 'also store the client id/secret in the config file (mode 0600)')
      .option(
        '--mode <mode>',
        'auth mode: user (authorization_code, default), enterprise (client_credentials) or pat (personal access token)',
      )
      .option('--code <code>', 'authorization code (skips the interactive paste)')
      .option(
        '--token <token>',
        'personal access token for --mode pat (or PINGCODE_TOKEN; skips the hidden prompt)',
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
      .description('clear the active token slot (all three with --all) and the metadata cache')
      .option('--all', 'clear the enterprise, user and personal-token slots (and authMode)'),
    { hidden: true },
  ).action((flags: LogoutFlags, command: Command) => {
    runLogout(flags, command);
  });
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

async function runLogin(flags: LoginFlags, command: Command): Promise<void> {
  // 1. Target mode first — it decides which app's credentials to use (design D12).
  //    A throwaway context gives us `--json` for the (interactive) mode prompt.
  const probe = contextFor(command);
  const authMode = await resolveMode(flags.mode, probe.ctx.json);

  // A personal access token needs no app, no authorize URL and no exchange — its
  // own path starts before any credential plumbing.
  if (authMode === 'pat') {
    await runLoginPat(flags, command);
    return;
  }

  // 2. Build the context routed to the target mode's app slot (user vs enterprise).
  let built = contextFor(
    command,
    { clientId: flags.clientId, clientSecret: flags.clientSecret },
    authMode,
  );

  // 3. Prompt for the target slot's credentials if none are available (stderr,
  //    TTY-only). User mode reads the userClientId/userClientSecret slot;
  //    enterprise reads clientId/clientSecret. `ctx.credentials` is the ACTIVE
  //    set (override or slot), so an explicit --client-id satisfies it.
  let promptedClientId: string | undefined;
  let promptedClientSecret: string | undefined;
  if (built.ctx.credentials.clientId === undefined) {
    promptedClientId = await promptVisible('PingCode client id: ', built.ctx.json);
  }
  if (built.ctx.credentials.clientSecret === undefined) {
    promptedClientSecret = await promptHidden('PingCode client secret: ', built.ctx.json);
  }
  if (promptedClientId !== undefined || promptedClientSecret !== undefined) {
    built = contextFor(
      command,
      {
        clientId: flags.clientId ?? promptedClientId,
        clientSecret: flags.clientSecret ?? promptedClientSecret,
      },
      authMode,
    );
  }

  const { ctx, settings } = built;

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
  const clientId = requireClientId(ctx.credentials.clientId);

  // 1. build + print the authorize URL + paste instructions (stderr); no browser, no loopback.
  const authorizeUrl = buildAuthorizeUrl(settings.host, clientId);
  printAuthorizeUrl(authorizeUrl);

  // 2. obtain the code: an explicit --code skips the paste prompt entirely (non-interactive);
  //    otherwise the operator pastes the redirect URL (or bare code) and extractCode parses it.
  const code =
    flags.code !== undefined && flags.code !== ''
      ? flags.code
      : extractCode(await loginHooks.readPaste(ctx.json));

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
  /** Endpoint that proved the token live; absent when the token's scopes allowed none. */
  verifiedWith?: string | undefined;
  /** Where the PAT came from; the config-file source is not enough once `--token` is used. */
  tokenSource?: 'flag' | 'env' | 'file' | 'prompt' | undefined;
  token: { expiresAtMs: number };
  projectsTotal?: number | undefined;
  user?: { id: string; name?: string; display_name?: string; username?: string } | undefined;
};

// ---------------------------------------------------------------------------
// login — personal access token (pat)
// ---------------------------------------------------------------------------

/**
 * `pat` login: install the pasted token, then verify it as far as its scopes allow.
 *
 * A personal access token is created in PingCode personal settings with its own
 * validity and `scopes`, and it is the operator's only credential — there is
 * nothing to refresh. Verification therefore has to be tolerant: `/v1/myself`
 * needs `pcp:read:account:personal`, which a narrowly-scoped CI token often
 * lacks. Falling back to one capability probe and then to "stored but
 * unverified" keeps a deliberately-scoped token usable, while a `401` still
 * fails hard — that token really is dead.
 */
async function runLoginPat(flags: LoginFlags, command: Command): Promise<void> {
  const built = contextFor(command, undefined, 'pat');
  const { ctx, settings } = built;

  // Resolve the token BEFORE clearing the session: `PINGCODE_TOKEN` and a
  // previously stored slot both reach this context as `ctx.auth.token`.
  const stored = ctx.auth.token?.accessToken;
  const provided = flags.token !== undefined && flags.token !== '' ? flags.token : undefined;
  const source: LoginOutcome['tokenSource'] =
    provided !== undefined
      ? 'flag'
      : stored === undefined
        ? 'prompt'
        : settings.tokenSource === 'env'
          ? 'env'
          : 'file';
  const raw = provided ?? stored ?? (await loginHooks.readToken(ctx.json));

  // Always start from scratch: a login is an explicit "use this token".
  clearToken(ctx);

  // The token goes into the in-memory session immediately (the verification
  // needs it) but is written to disk only once it proved not to be dead.
  const token = setPersonalAccessToken(ctx, raw, { persist: false });
  const verified = await verifyPatToken(ctx);
  ctx.persistToken?.(token);
  clearMetadataCache(ctx);
  finishLogin(built, flags, {
    authMode: 'pat',
    tokenKind: 'pat',
    tokenSource: source,
    token,
    ...verified,
  });
}

/** Probe `GET /v1/myself`, then one capability endpoint, tolerating a scope 403. */
async function verifyPatToken(
  ctx: Parameters<typeof getMyself>[0],
): Promise<Pick<LoginOutcome, 'verifiedWith' | 'user' | 'projectsTotal'>> {
  try {
    const me = await getMyself(ctx);
    const user: NonNullable<LoginOutcome['user']> = { id: me.id };
    if (me.name !== undefined) user.name = me.name;
    if (me.display_name !== undefined) user.display_name = me.display_name;
    if (me.username !== undefined) user.username = me.username;
    return { verifiedWith: 'GET /v1/myself', user };
  } catch (error) {
    // 403 = the token is fine but its scopes do not cover this endpoint → try
    // another. Anything else (401, transport, server error) is a real failure.
    if (!(error instanceof PermissionError)) throw error;
  }
  try {
    const projectsTotal = await verifyAccess(ctx);
    return { verifiedWith: 'GET /v1/pjm/projects?page_size=1', projectsTotal };
  } catch (error) {
    if (!(error instanceof PermissionError)) throw error;
    return {}; // stored, but no granted scope we can probe with
  }
}

/** Shared tail of every login branch: persist the mode's app creds, then print. */
function finishLogin(
  built: ReturnType<typeof contextFor>,
  flags: LoginFlags,
  outcome: LoginOutcome,
): void {
  const { settings, file } = built;
  const save = flags.save === true;
  const patch: ConfigPatch = { host: settings.host };
  let storeId = false;
  let storeSecret = false;
  const isPat = outcome.authMode === 'pat';

  // Route the app credentials to the logged-in mode's slot (design D12). A login
  // into user mode writes userClientId/userClientSecret (the user-token app);
  // enterprise writes clientId/clientSecret. The gate is symmetric: a credential
  // that already lives in the target slot (== file) is not rewritten; one from a
  // flag/env is persisted only with --save — mirroring the enterprise behaviour.
  if (outcome.authMode === 'user') {
    // The USER app credential: an explicit --client-id (this invocation) or the
    // stored userClientId. The enterprise fallback (single-app, no user app) is
    // NOT written to the user slot. Source gating mirrors the enterprise branch:
    // file → never (already there); flag/env → only with --save.
    const userId = flags.clientId ?? settings.userClientId;
    if (userId !== undefined) {
      const fromFile = settings.userClientId !== undefined && settings.userClientId === file.userClientId;
      const source = flags.clientId !== undefined ? 'flag' : fromFile ? 'file' : 'env';
      if (shouldPersistSecret(source, save)) {
        patch.userClientId = userId;
        storeId = true;
      }
    }
    const userSecret = flags.clientSecret ?? settings.userClientSecret;
    if (userSecret !== undefined) {
      const fromFile =
        settings.userClientSecret !== undefined && settings.userClientSecret === file.userClientSecret;
      const source = flags.clientSecret !== undefined ? 'flag' : fromFile ? 'file' : 'env';
      if (shouldPersistSecret(source, save)) {
        patch.userClientSecret = userSecret;
        storeSecret = true;
      }
    }
  } else if (!isPat) {
    storeId = shouldPersistSecret(settings.sources.clientId, save);
    storeSecret = shouldPersistSecret(settings.sources.clientSecret, save);
    if (storeId) patch.clientId = settings.clientId;
    if (storeSecret) patch.clientSecret = settings.clientSecret;
  }
  saveConfig(patch, process.env);

  // Whether the logged-in mode's app creds are now on disk (for the not-stored note).
  // A PAT has no app credentials at all, so there is nothing to report or warn about.
  const alreadyInFile = isPat
    ? true
    : outcome.authMode === 'user'
      ? file.userClientId !== undefined && file.userClientSecret !== undefined
      : file.clientId !== undefined && file.clientSecret !== undefined;
  const credentialsStored = alreadyInFile || (storeId && storeSecret);

  const mode = modeOf(built.ctx);
  // Report the token this login just produced, not the pre-login snapshot in
  // `settings`: a fresh `settings.token` is undefined/source-"none" before the
  // first login, so reading it here would describe the old state (e.g.
  // `token_refreshable: false` for a token the CLI can renew).
  const effectiveSource: 'flag' | 'env' | 'file' | 'prompt' | 'none' = isPat
    ? (outcome.tokenSource ?? 'none')
    : 'file'; // the non-pat token was just written to its slot by persistToken
  const refreshable = !isPat; // enterprise tokens are re-acquirable, user tokens refreshable
  if (isPat && outcome.verifiedWith === undefined) {
    // Machine-readable on stdout, human-readable on stderr — warnings never pollute
    // the JSON payload but must still reach a `--json` caller's terminal.
    errLine(
      paint.yellow(
        'stored, but no granted scope allowed a live check — a 401 will still fail hard, ' +
          'and `auth status --check` will tell you when that happens',
      ),
    );
  }
  if (mode.json) {
    printJson({
      ok: true,
      mode: outcome.authMode,
      kind: outcome.tokenKind,
      host: settings.host,
      api_base: settings.apiBase,
      client_id: isPat ? null : maskIdentifier(settings.clientId),
      credentials_stored: isPat ? false : credentialsStored,
      ...(outcome.user === undefined ? {} : { user: outcome.user }),
      ...(outcome.projectsTotal === undefined ? {} : { projects_total: outcome.projectsTotal }),
      // A PAT's validity is set in PingCode and unknown to us — never invent one.
      token_expires_at: isPat ? null : Math.floor(outcome.token.expiresAtMs / 1000),
      token_source: effectiveSource,
      token_refreshable: refreshable,
      verified_with: outcome.verifiedWith ?? null,
    });
    return;
  }

  const fields: [string, string][] = [
    ['host', settings.host],
    ['api base', settings.apiBase],
  ];
  if (isPat) {
    fields.push(['token source', effectiveSource]);
  } else {
    fields.push(['client id', maskIdentifier(settings.clientId)]);
  }
  fields.push(['mode', outcome.authMode], ['token kind', outcome.tokenKind]);
  if (outcome.user !== undefined) {
    fields.push(['user', outcome.user.display_name ?? outcome.user.name ?? outcome.user.username ?? outcome.user.id]);
  }
  if (outcome.projectsTotal !== undefined) {
    fields.push(['projects visible', String(outcome.projectsTotal)]);
  }
  fields.push([
    'token expires',
    isPat
      ? 'unknown — set by the token in PingCode personal settings'
      : formatTimestamp(Math.floor(outcome.token.expiresAtMs / 1000)),
  ]);
  fields.push(['config file', configFilePath(process.env)]);
  printFields(fields);
  errLine(paint.green(outcome.verifiedWith === undefined ? 'token stored' : 'authenticated'));
  if (!isPat && !credentialsStored) {
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
  if (flag === 'enterprise' || flag === 'user' || flag === 'pat') return flag;
  if (flag !== undefined) {
    throw new UsageError(`--mode must be "enterprise", "user" or "pat", got "${flag}"`);
  }
  return await loginHooks.selectMode(json);
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
  const expiresAt =
    token === undefined || !settings.tokenRefreshable
      ? undefined
      : Math.floor(token.expiresAtMs / 1000);
  const authMode: AuthMode = settings.authMode;
  const tokenKind: TokenKind = token?.kind ?? (authMode === 'pat' ? 'pat' : 'enterprise');
  // `tokenIsFresh` is meaningless for a PAT (validity lives server-side and
  // `expiresAtMs` is 0), so the field is reported as unknown instead of "stale".
  const fresh = settings.tokenRefreshable ? tokenIsFresh(token, ctx.now()) : null;

  let check: StatusCheck | undefined;
  if (flags.check === true) {
    if (authMode === 'user' || authMode === 'pat') {
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
      token_source: settings.tokenSource,
      token_refreshable: settings.tokenRefreshable,
      token_fresh: fresh,
      token_expires_at: expiresAt ?? null,
      token_scope: token?.scope ?? null,
      // User-slot refresh-token presence (AC8) — boolean only, never the value.
      user_token_present: file.userToken !== undefined,
      user_refresh_token_present: file.userToken?.refreshToken !== undefined,
      // Personal-token slot presence — boolean only, never the value.
      pat_token_present: file.patToken !== undefined,
      env_token_present: settings.tokenSource === 'env' && authMode === 'pat',
      config_file: configFilePath(process.env),
      ...(check === undefined ? {} : { check }),
    });
    return;
  }

  const fields: [string, string][] = [
    ['host', settings.host],
    ['api base', settings.apiBase],
  ];
  if (authMode === 'pat') {
    fields.push(['token source', settings.tokenSource]);
  } else {
    fields.push(
      ['client id', `${maskIdentifier(settings.clientId)} (${settings.sources.clientId})`],
      [
        'client secret',
        settings.clientSecret === undefined
          ? '(not set)'
          : `(set, ${settings.sources.clientSecret})`,
      ],
    );
  }
  fields.push(
    ['auth mode', authMode],
    [
      'token',
      token === undefined
        ? '(none) — run `pingcode auth login`'
        : fresh === null
          ? `present (${tokenKind}; not refreshable)`
          : fresh
            ? `present (${tokenKind})`
            : `present but stale (${tokenKind}) — it will be re-acquired on the next call`,
    ],
    [
      'token expires',
      expiresAt === undefined
        ? authMode === 'pat' && token !== undefined
          ? 'unknown — set by the token in PingCode personal settings'
          : ''
        : formatTimestamp(expiresAt),
    ],
    ['token scope', token?.scope ?? ''],
    ['user slot', file.userToken === undefined ? '(none)' : 'present (with refresh token)'],
    ['personal token slot', file.patToken === undefined ? '(none)' : 'present (not refreshable)'],
    ['config file', configFilePath(process.env)],
    [
      'live check',
      check === undefined
        ? '(skipped — pass --check)'
        : check.endpoint === 'GET /v1/myself'
          ? `ok · signed in as ${check.user} via ${check.endpoint}`
          : `ok · ${check.projects_total} project(s) visible via ${check.endpoint}`,
    ],
  );
  printFields(fields);
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
    // Full wipe: all three token slots, the active mode and BOTH app credential
    // pairs (enterprise + user, which live in separate fields). `host` survives
    // (it is not a credential) and is re-stamped so the re-read+merge in
    // saveConfig keeps it. Anything omitted here would be merged back from the
    // existing file, i.e. silently "logout" while the credentials stay usable.
    saveConfig(
      {
        host: settings.host,
        token: null,
        userToken: null,
        patToken: null,
        authMode: null,
        clientId: null,
        clientSecret: null,
        userClientId: null,
        userClientSecret: null,
      },
      process.env,
    );
    cleared = [
      'token',
      'user_token',
      'pat_token',
      'auth_mode',
      'client_id',
      'client_secret',
      'user_client_id',
      'user_client_secret',
      'metadata_cache',
    ];
  } else {
    // Clear only the ACTIVE slot + authMode; the other slots + creds survive so
    // a switch back is instant (R8, design D14). Clearing authMode is required:
    // leaving it set with the active slot emptied would hide the other slot
    // (resolveSettings reads the active slot by mode).
    const slot =
      settings.authMode === 'pat' ? 'patToken' : settings.authMode === 'user' ? 'userToken' : 'token';
    saveConfig({ [slot]: null, authMode: null }, process.env);
    cleared = [
      slot === 'patToken' ? 'pat_token' : slot === 'userToken' ? 'user_token' : 'token',
      'auth_mode',
      'metadata_cache',
    ];
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
  const flag = what === 'client id' ? '--client-id' : what === 'personal access token' ? '--token' : '--client-secret';
  const env =
    what === 'client id'
      ? 'PINGCODE_CLIENT_ID'
      : what === 'personal access token'
        ? 'PINGCODE_TOKEN'
        : 'PINGCODE_CLIENT_SECRET';
  return new UsageError(`no ${what} available`, {
    hint: `pass ${flag}, set ${env}, or run the command from a terminal to be prompted`,
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

/** Read a secret without echoing it. `what` names the credential for error hints. */
async function promptHidden(
  question: string,
  json: boolean,
  what = 'client secret',
): Promise<string> {
  const input = process.stdin;
  if (json || input.isTTY !== true) throw missingCredential(what);

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
  if (trimmed === '') throw missingCredential(what);
  return trimmed;
}

/** Read the pasted authorization code or redirect URL (stderr prompt; never stdout). */
async function readPasteFromTerminal(json: boolean): Promise<string> {
  if (json || process.stdin.isTTY !== true) {
    throw new UsageError('no authorization code available', {
      hint: 'run from a terminal to paste the code or redirect URL, or pass --code <code>',
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // The raw paste is returned (trimmed); extractCode decides what it means.
    return (await rl.question('authorization code or redirect URL: ')).trim();
  } finally {
    rl.close();
  }
}

/** Read the pasted personal access token (stderr prompt; never echoed, never stdout). */
async function readTokenFromTerminal(json: boolean): Promise<string> {
  if (json || process.stdin.isTTY !== true) throw missingCredential('personal access token');
  const token = await promptHidden('personal access token: ', json, 'personal access token');
  if (token.trim() === '') throw missingCredential('personal access token');
  return token;
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
    { key: 'pat', label: 'personal access token — paste a token, no app needed' },
    { key: 'enterprise', label: 'client_credentials — app/admin identity' },
  ], 'user');
}
