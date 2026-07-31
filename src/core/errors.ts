/**
 * Error hierarchy and exit-code mapping (design §5.2).
 *
 * | exit | error            | trigger                                                   |
 * |------|------------------|-----------------------------------------------------------|
 * | 0    | —                | success, including a rendered dry-run plan                |
 * | 1    | UnexpectedError  | unhandled / internal                                      |
 * | 2    | UsageError       | bad flags, missing input, unresolvable/ambiguous name     |
 * | 3    | AuthError        | no/invalid credentials, 401 after re-auth                 |
 * | 4    | PermissionError  | 403 / scope denied                                        |
 * | 5    | NotFoundError    | 404                                                       |
 * | 6    | RateLimitError   | 429                                                       |
 * | 7    | ApiError         | other non-2xx carrying `{code, message}`                  |
 * | 8    | TransportError   | DNS/TCP/TLS/timeout/unparseable body                      |
 */

export type ErrorKind =
  | 'unexpected'
  | 'usage'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'api'
  | 'transport';

export const EXIT_CODES: Record<ErrorKind, number> = {
  unexpected: 1,
  usage: 2,
  auth: 3,
  permission: 4,
  not_found: 5,
  rate_limit: 6,
  api: 7,
  transport: 8,
};

export type PingcodeErrorOptions = {
  /** Actionable next step, shown after the message. */
  hint?: string | undefined;
  /** The API's `{code}` — a string of digits, never an int (research §2.4). */
  code?: string | undefined;
  /** HTTP status, when the error came from a response. */
  status?: number | undefined;
  cause?: unknown;
};

export abstract class PingcodeError extends Error {
  abstract readonly kind: ErrorKind;
  readonly hint: string | undefined;
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: PingcodeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.hint = options.hint;
    this.code = options.code;
    this.status = options.status;
  }

  get exitCode(): number {
    return EXIT_CODES[this.kind];
  }
}

/** Exit 1 — something we did not anticipate. */
export class UnexpectedError extends PingcodeError {
  readonly kind = 'unexpected' as const;
}

/** Exit 2 — the invocation itself is wrong (also: ambiguous names, empty patch). */
export class UsageError extends PingcodeError {
  readonly kind = 'usage' as const;
}

/** Exit 3 — missing/invalid credentials, or a 401 that survived one re-auth. */
export class AuthError extends PingcodeError {
  readonly kind = 'auth' as const;
}

/** Exit 4 — 403 / scope denied. */
export class PermissionError extends PingcodeError {
  readonly kind = 'permission' as const;
}

/** Exit 5 — 404. */
export class NotFoundError extends PingcodeError {
  readonly kind = 'not_found' as const;
}

/** Exit 6 — 429. The API sends `x-pc-retry-after` (research §2.5). */
export class RateLimitError extends PingcodeError {
  readonly kind = 'rate_limit' as const;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: PingcodeErrorOptions & { retryAfterSeconds?: number | undefined } = {},
  ) {
    super(message, options);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Exit 7 — any other non-2xx. Unknown `{code}` values are surfaced verbatim. */
export class ApiError extends PingcodeError {
  readonly kind = 'api' as const;
}

/** Exit 8 — the request never produced a usable response. */
export class TransportError extends PingcodeError {
  readonly kind = 'transport' as const;
}

/** The request that `--dry-run` refused to send. `url`/`headers` are already redacted. */
export type RequestPlan = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

/**
 * Thrown by the transport layer instead of sending a mutating request under
 * `--dry-run` (design D8). It is control flow, not a failure: `bin/pingcode.ts`
 * renders the plan and exits 0.
 */
export class DryRunHalt extends Error {
  readonly plan: RequestPlan;

  constructor(plan: RequestPlan) {
    super(`dry run: ${plan.method} ${plan.url} was not sent`);
    this.name = 'DryRunHalt';
    this.plan = plan;
  }
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof DryRunHalt) return 0;
  if (error instanceof PingcodeError) return EXIT_CODES[error.kind];
  return EXIT_CODES.unexpected;
}

export function kindOf(error: unknown): ErrorKind {
  return error instanceof PingcodeError ? error.kind : 'unexpected';
}

/** Normalise anything thrown into a `PingcodeError`. */
export function toPingcodeError(error: unknown): PingcodeError {
  if (error instanceof PingcodeError) return error;
  if (error instanceof Error) return new UnexpectedError(error.message, { cause: error });
  return new UnexpectedError(String(error), { cause: error });
}
