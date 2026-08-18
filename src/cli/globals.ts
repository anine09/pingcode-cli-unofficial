import { Option, type Command } from 'commander';
import {
  loadConfig,
  resolveSettings,
  saveConfig,
  type Config,
  type ResolvedSettings,
  type TokenRecord,
} from '../core/config';
import { createContext, type Ctx } from '../core/context';
import { createLogger } from '../core/logger';
import type { RawGlobalOptions } from './program';

/**
 * The bridge between commander's flags and the runtime `Ctx` the `core`/`api`
 * layers take (design §2). Commands never read the config file or build URLs
 * themselves — they call this, then hand the `Ctx` to `api/*`.
 */

export type GlobalOptions = {
  host: string | undefined;
  json: boolean;
  dryRun: boolean;
  useCache: boolean;
  verbose: boolean;
};

/**
 * The global flags, defined once. commander binds an option to the command it
 * *follows*, so `pingcode project work-item list --json` would otherwise be an unknown
 * option. Every leaf command therefore repeats these (hidden from its own help,
 * which keeps the root as the single place they are documented) and
 * `readGlobalOptions` picks the innermost value that was actually typed.
 */
const GLOBAL_FLAGS: { flags: string; description: string }[] = [
  {
    flags: '--host <url>',
    description:
      'PingCode host (default https://open.pingcode.com; self-hosted: https://pingcode.example.com)',
  },
  { flags: '--json', description: 'emit machine-readable JSON on stdout' },
  { flags: '--dry-run', description: 'preview mutating requests without sending them' },
  { flags: '--no-cache', description: 'bypass the on-disk metadata cache' },
  { flags: '--verbose', description: 'log requests to stderr (secrets redacted)' },
];

export function addGlobalOptions(command: Command, options: { hidden?: boolean } = {}): Command {
  for (const spec of GLOBAL_FLAGS) {
    const option = new Option(spec.flags, spec.description);
    if (options.hidden === true) option.hideHelp();
    command.addOption(option);
  }
  return command;
}

/**
 * Read a global flag from the innermost command that actually carries a typed
 * value, falling back to the outermost default (`--no-cache` defaults to `true`).
 */
function readGlobalFlag(command: Command, key: keyof RawGlobalOptions): unknown {
  let fallback: unknown;
  let cursor: Command | null = command;
  while (cursor !== null) {
    const source = cursor.getOptionValueSource(key);
    if (source !== undefined) {
      if (source !== 'default' && source !== 'implied') return cursor.getOptionValue(key);
      if (fallback === undefined) fallback = cursor.getOptionValue(key);
    }
    cursor = cursor.parent;
  }
  return fallback;
}

/** Read the global flags from any (sub)command, wherever on the line they appeared. */
export function readGlobalOptions(command: Command): GlobalOptions {
  const host = readGlobalFlag(command, 'host');
  return {
    host: typeof host === 'string' ? host : undefined,
    json: readGlobalFlag(command, 'json') === true,
    dryRun: readGlobalFlag(command, 'dryRun') === true,
    // commander maps `--no-cache` to `cache: false`; the default is `true`.
    useCache: readGlobalFlag(command, 'cache') !== false,
    verbose: readGlobalFlag(command, 'verbose') === true,
  };
}

export type BuildContextInput = {
  globals: GlobalOptions;
  /** Credentials supplied by flags (`auth login`). */
  credentials?:
    | { clientId?: string | undefined; clientSecret?: string | undefined }
    | undefined;
  env?: NodeJS.ProcessEnv | undefined;
};

export type BuiltContext = {
  ctx: Ctx;
  /** Where each value came from — `auth status` prints it, `--save` gating needs it. */
  settings: ResolvedSettings;
  /** The config file as read, for commands that need to know what is stored. */
  file: Config;
};

/**
 * Resolve flag → env → file (R1.4), derive `apiBase` from the winning host, and
 * assemble the context. Reading the config file here is also what surfaces the
 * loose-permission warning (design §3).
 */
export function buildContext(input: BuildContextInput): BuiltContext {
  const env = input.env ?? process.env;
  const logger = createLogger({ verbose: input.globals.verbose });
  const file = loadConfig(env, logger);

  const settings = resolveSettings({
    flags: {
      host: input.globals.host,
      clientId: input.credentials?.clientId,
      clientSecret: input.credentials?.clientSecret,
    },
    env,
    file,
  });

  const ctx = createContext({
    apiBase: settings.apiBase,
    credentials: { clientId: settings.clientId, clientSecret: settings.clientSecret },
    auth: {
      token: settings.token, // the active slot's token (D2/D5)
      clampWarned: false,
      mode: settings.authMode,
    },
    oauth: { redirectUri: settings.oauthRedirectUri },
    dryRun: input.globals.dryRun,
    json: input.globals.json,
    verbose: input.globals.verbose,
    useCache: input.globals.useCache,
    logger,
    env,
    // Mode-aware persist (D5): route by the token's kind to the right slot and
    // stamp the active mode. saveConfig re-reads + merges, so this writes only
    // the owned field (never a whole stale Config).
    persistToken: (token: TokenRecord) => {
      if (token.kind === 'user') {
        saveConfig(
          {
            userToken: { ...token, kind: 'user', refreshToken: token.refreshToken ?? '' },
            authMode: 'user',
          },
          env,
        );
      } else {
        saveConfig({ token, authMode: 'enterprise' }, env);
      }
    },
  });

  return { ctx, settings, file };
}
