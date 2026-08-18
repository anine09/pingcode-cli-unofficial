# Logging Guidelines

> In a CLI, "logging" and "output" are two different channels — and confusing them breaks callers.

---

## Overview

There is no logging library. `src/core/logger.ts` is ~30 lines and exposes exactly two levels:

```ts
export type Logger = {
  warn(message: string): void;   // always emitted
  debug(message: string): void;  // only with --verbose
};
```

**Everything a logger emits goes to `process.stderr`.** That is not a stylistic choice: it is what
makes the `--json` stdout-purity contract unbreakable by a stray log line.

The logger is reached through `Ctx` (`ctx.logger`), never imported as a global singleton, so tests
can substitute `silentLogger` or `createMemoryLogger()` and assert on what was said.

---

## The stdout / stderr contract

This is the single most important output rule in the project:

| Channel | Carries |
|---|---|
| **stdout** | the *result* only. With `--json`, valid JSON and nothing else. |
| **stderr** | logs, warnings, `--verbose` traces, dry-run notes, tables' side notes, **and all errors** |

Consequences that are enforced by tests:

- With `--json`, a successful command's stderr is expected to be **0 bytes**; the S8 sweep verified
  this over 19 commands (`research/s8-smoke.md`).
- With `--json`, an *error* leaves stdout **empty** and writes
  `{"error":{"kind","message","code?","exit"}}` to stderr.
- A `--dry-run` plan is a *result*, so it goes to stdout as `{"dry_run":true,"request":{…}}` and
  exits 0.
- Never `console.log` a diagnostic. Use `ctx.logger`. `console.log` in a command is a bug.

## Log Levels

- **`warn`** — always shown. Reserve it for things the user must know but that are not fatal: a
  loose-mode config file permission, a clamped token expiry (once per process), a cache entry
  invalidated after a rejected write.
- **`debug`** — `--verbose` only. Request/response traces: `→ GET <redacted url>`, `← 200`, the
  re-auth decision, cache hits/misses.
- There is no `info` and no `error` level. Results are stdout, failures are thrown.

## Structured Logging

Deliberately none. This is a human/agent-facing CLI, not a service: lines are prose, and machine
consumers use `--json` on stdout instead of parsing stderr. Do not introduce a JSON log format
without a reason that `--json` cannot serve.

## What to Log

- Every outbound request and its status under `--verbose` — this is the main debugging tool, and it
  is how the 401-replay path was verified live.
- Token lifecycle decisions (proactive refresh, reactive re-auth, persistence).
- Cache decisions (hit, expiry, bypass, invalidate-and-retry).
- One-time anomalies via `warn`, guarded so they cannot repeat per request.

## What NOT to Log

**Never the `client_secret`, never an access token, never a full `Authorization` header.**

The mechanism, not just the intention:

- Every printable URL goes through **`redactUrl()`** (`src/core/redact.ts`) — `--verbose` traces,
  the dry-run plan, `TransportError` messages, error snippets. On this API the `client_secret`
  travels in the **URL query string** on the token endpoint, so a raw URL in a log line is a leaked
  secret. Sensitive query params: `client_secret`, `code`, `refresh_token`.
- **`redactHeaders()`** masks `authorization`, `proxy-authorization`, `cookie`, `set-cookie`.
- **`redactSnippet()`** masks `access_token` / `refresh_token` / `client_secret` values inside a
  quoted response body before it lands in an error message.

> **Gotcha — a new secret-bearing query param must be added to `SENSITIVE_QUERY_PARAMS`, not
> just `SENSITIVE_JSON_KEYS`.** `refresh_token` was initially added only to `SENSITIVE_JSON_KEYS`
> (body redaction). But the user-token *refresh* call carries `refresh_token` in the **query
> string** (`GET /v1/auth/token?grant_type=refresh_token&refresh_token=…`), so `redactUrl` would
> have printed it in `--verbose` logs. Whenever a grant/endpoint puts a credential in the query
> string, add it to `SENSITIVE_QUERY_PARAMS` **and** `SENSITIVE_JSON_KEYS` (the query regex
> `SENSITIVE_QUERY_RE` and the URL-parser loop both read the query list; the JSON regex reads the
> key list — they are independent).
- Redaction **fails safe**: the query-value pattern is lazy and only hands back a *trailing* run of
  `)`, `"`, `'`, `,` so an embedded URL keeps its closing paren, while a secret that itself contains
  one of those characters is still masked in full. Over-redacting by a character is acceptable;
  printing a suffix of a secret is not.
- `maskIdentifier()` renders a `client_id` as `abcd…wxyz` for `auth status`. Note the deliberate
  asymmetry: `--verbose` prints the full `client_id`, because it is an identifier, not a secret.
  Only the `client_secret` and the token are secrets. This is documented in the README so it is not
  mistaken for a leak.

If you add a code path that can print a URL, a header map, or a response body, route it through the
matching helper and add a test asserting that **no substring of the secret** survives — the existing
tests check substrings, not just equality, for exactly this reason.
