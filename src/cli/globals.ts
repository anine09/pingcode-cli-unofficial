import type { Command } from 'commander';
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

/** Read the root-level flags from any (sub)command. */
export function readGlobalOptions(command: Command): GlobalOptions {
  const raw = command.optsWithGlobals<RawGlobalOptions>();
  return {
    host: raw.host,
    json: raw.json === true,
    dryRun: raw.dryRun === true,
    // commander maps `--no-cache` to `cache: false`; the default is `true`.
    useCache: raw.cache !== false,
    verbose: raw.verbose === true,
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
    auth: { token: settings.token, clampWarned: false },
    dryRun: input.globals.dryRun,
    json: input.globals.json,
    verbose: input.globals.verbose,
    useCache: input.globals.useCache,
    logger,
    env,
    // A token refresh writes back `token` alone — never a whole stale Config.
    persistToken: (token: TokenRecord) => {
      saveConfig({ token }, env);
    },
  });

  return { ctx, settings, file };
}
