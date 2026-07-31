import { createContext, type Ctx, type FetchLike } from '../../src/core/context';
import { createMemoryLogger } from '../../src/core/logger';

export type FakeCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type FakeHandler = (call: FakeCall, index: number) => Response | Promise<Response>;

export type FakeFetch = {
  fetch: FetchLike;
  calls: FakeCall[];
  /** Convenience: URLs only, in order. */
  urls(): string[];
};

/**
 * An injected `fetch` (design D3): no msw, no nock, no network. Handlers are
 * consumed in order; the last handler repeats if more requests arrive.
 */
export function createFakeFetch(handlers: FakeHandler | FakeHandler[]): FakeFetch {
  const list = Array.isArray(handlers) ? handlers : [handlers];
  const calls: FakeCall[] = [];

  const fetch: FetchLike = async (input, init) => {
    const index = calls.length;
    const call: FakeCall = {
      url: input,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: normalizeHeaders(init?.headers),
      body: parseBody(init?.body),
    };
    calls.push(call);
    const handler = list[Math.min(index, list.length - 1)];
    if (handler === undefined) throw new Error('fake fetch: no handler configured');
    return await handler(call, index);
  };

  return { fetch, calls, urls: () => calls.map((call) => call.url) };
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (headers === undefined) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return { ...(headers as Record<string, string>) };
}

function parseBody(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function textResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/plain', ...(init.headers ?? {}) },
  });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

export type TestContextOptions = {
  fetch?: FetchLike;
  apiBase?: string;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  token?: Ctx['auth']['token'];
  now?: number | (() => number);
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
  useCache?: boolean;
  env?: NodeJS.ProcessEnv;
  persistToken?: (token: NonNullable<Ctx['auth']['token']>) => void;
};

export type TestContext = Ctx & {
  logLines: string[];
  sleeps: number[];
};

/** A `Ctx` wired for tests: fake fetch, in-memory logger, fake clock, no sleeping. */
export function createTestContext(options: TestContextOptions = {}): TestContext {
  const logger = createMemoryLogger(true);
  const sleeps: number[] = [];
  const now =
    typeof options.now === 'function'
      ? options.now
      : (() => {
          const fixed = options.now ?? 1_700_000_000_000;
          return () => fixed;
        })();

  const ctx = createContext({
    apiBase: options.apiBase ?? 'https://open.pingcode.com',
    credentials: { clientId: options.clientId, clientSecret: options.clientSecret },
    auth: { token: options.token, clampWarned: false },
    dryRun: options.dryRun ?? false,
    json: options.json ?? false,
    verbose: options.verbose ?? true,
    useCache: options.useCache ?? true,
    logger,
    now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    env: options.env ?? {},
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.persistToken === undefined ? {} : { persistToken: options.persistToken }),
  });

  return Object.assign(ctx, { logLines: logger.lines, sleeps });
}
