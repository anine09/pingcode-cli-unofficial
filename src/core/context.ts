import { DEFAULT_HOST, deriveApiBase, type TokenRecord } from './config';
import { createLogger, type Logger } from './logger';

/** The injected `fetch` implementation — this is what makes design D3 (no msw/nock) work. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * In-process auth state. Kept mutable and per-context so `ensureFreshToken` can
 * serialise re-acquisition behind a single in-flight promise (design §4.2).
 * `mode` is the active grant; `buildContext` stamps it from the resolved config
 * (the safe process default, when no auth is supplied, is `enterprise`).
 */
export type AuthSession = {
  mode?: 'enterprise' | 'user' | undefined;
  token?: TokenRecord | undefined;
  inflight?: Promise<TokenRecord> | undefined;
  /** The past-expiry clamp warns once per process (design §4.1). */
  clampWarned: boolean;
};

/**
 * Everything the `core` and `api` layers need at runtime. `cli/globals.ts` builds
 * it from flags + env + config file; tests build it directly with a fake `fetch`.
 *
 * Passing this explicitly (rather than reaching into `cli` globals from `core`)
 * is what keeps the layering rule `core imports neither cli nor api` true.
 */
export type Ctx = {
  apiBase: string;
  credentials: {
    clientId?: string | undefined;
    clientSecret?: string | undefined;
  };
  auth: AuthSession;
  /** Loopback callback info for the browser authorize channel (D13). */
  oauth: { redirectUri?: string | undefined };
  /** `--dry-run`: mutating requests throw `DryRunHalt` instead of being sent. */
  dryRun: boolean;
  /** `--json` */
  json: boolean;
  /** `--verbose` */
  verbose: boolean;
  /** `--no-cache` sets this to false. */
  useCache: boolean;
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** Persist a freshly acquired token. Absent ⇒ nothing is written to disk. */
  persistToken?: ((token: TokenRecord) => void) | undefined;
};

export type ContextOptions = Partial<Ctx>;

export function createContext(options: ContextOptions = {}): Ctx {
  const fetchImpl: FetchLike =
    options.fetch ??
    ((input, init) => (init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init)));

  const verbose = options.verbose ?? false;

  return {
    apiBase: options.apiBase ?? deriveApiBase(DEFAULT_HOST),
    credentials: options.credentials ?? {},
    auth: options.auth ?? { clampWarned: false, mode: 'enterprise' },
    oauth: options.oauth ?? {},
    dryRun: options.dryRun ?? false,
    json: options.json ?? false,
    verbose,
    useCache: options.useCache ?? true,
    fetch: fetchImpl,
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    logger: options.logger ?? createLogger({ verbose }),
    env: options.env ?? process.env,
    persistToken: options.persistToken,
  };
}
