/**
 * Redaction (design §5.0) — security-critical.
 *
 * The token call carries the org-admin `client_secret` in the **URL query string**,
 * not in a header (research §6.1). So every path that can print a URL — `--verbose`
 * logging, the dry-run plan, `TransportError` snippets, any error carrying a URL —
 * must route through `redactUrl()`. Header redaction stays too.
 *
 * This lives in `core/` (not `cli/`) because `core/http.ts` needs it and `core`
 * must not import `cli`; `cli/output.ts` re-exports it so there is still exactly
 * one implementation.
 */

export const REDACTED = '***REDACTED***';

/** Query params that must never be printed. */
const SENSITIVE_QUERY_PARAMS = ['client_secret', 'code'];

/** Headers that must never be printed. */
const SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie'];

/** JSON keys whose values must never be printed (token responses, config dumps). */
const SENSITIVE_JSON_KEYS = ['access_token', 'refresh_token', 'client_secret'];

const SENSITIVE_QUERY_RE = new RegExp(
  `([?&](?:${SENSITIVE_QUERY_PARAMS.join('|')})=)[^&#\\s]*`,
  'gi',
);

const SENSITIVE_JSON_RE = new RegExp(
  `("(?:${SENSITIVE_JSON_KEYS.join('|')})"\\s*:\\s*")[^"]*(")`,
  'gi',
);

/**
 * Mask sensitive query parameters in a URL. Works on absolute URLs, relative
 * paths, and strings that only look like URLs; never throws.
 */
export function redactUrl(url: string): string {
  let result: string;
  try {
    const parsed = new URL(url);
    let touched = false;
    for (const key of SENSITIVE_QUERY_PARAMS) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, REDACTED);
        touched = true;
      }
    }
    result = touched ? parsed.toString() : url;
  } catch {
    result = url;
  }
  // Also run the textual pass: it covers relative URLs and repeated params,
  // which `URLSearchParams.set` would collapse rather than mask.
  return result.replace(SENSITIVE_QUERY_RE, `$1${REDACTED}`);
}

/** Mask sensitive header values. Header names are matched case-insensitively. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADERS.includes(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/**
 * Mask token/secret values inside a response-body snippet before it lands in a
 * `TransportError` message.
 */
export function redactSnippet(text: string): string {
  return text.replace(SENSITIVE_JSON_RE, `$1${REDACTED}$2`).replace(SENSITIVE_QUERY_RE, `$1${REDACTED}`);
}

/** Mask a client id for display: `abcd…wxyz` (design §4.3). */
export function maskIdentifier(value: string | undefined): string {
  if (value === undefined || value === '') return '(not set)';
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
