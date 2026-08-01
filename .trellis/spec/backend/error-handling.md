# Error Handling

> Errors are a public contract in a CLI: the exit code and the JSON error shape are API.

---

## Overview

Every failure becomes a `PingcodeError` subclass with a fixed `kind`, and every `kind` maps to a
fixed exit code. `src/bin/pingcode.ts` is the only place that turns an error into a process exit;
nothing else calls `process.exit`.

Rules:

- **Throw typed errors, never `process.exit` inside a command.** Commands throw; `bin/pingcode.ts`
  renders and exits.
- **Attach a `hint`.** The message says what happened; the hint says what to do next. Every mapped
  API error in `core/wire.ts` carries one.
- **Never swallow an unknown failure.** Unrecognised statuses and API `code`s fall through to
  `ApiError` (exit 7) with the raw `code` preserved, so an unexpected server behaviour is visible
  rather than silently reinterpreted.
- Anything non-`Error` that escapes is normalised by `toPingcodeError()` into `UnexpectedError`.

---

## Error Types

`src/core/errors.ts` — the hierarchy and the exit table are defined together, on purpose:

| Exit | Class | Kind | Trigger |
|---|---|---|---|
| 0 | — | — | success, **including a rendered `--dry-run` plan** |
| 1 | `UnexpectedError` | `unexpected` | unhandled / internal |
| 2 | `UsageError` | `usage` | bad flags, missing input, ambiguous or unresolvable name, empty patch |
| 3 | `AuthError` | `auth` | no/invalid credentials, or a 401 that survived one re-auth |
| 4 | `PermissionError` | `permission` | 403 / scope denied |
| 5 | `NotFoundError` | `not_found` | resource does not exist |
| 6 | `RateLimitError` | `rate_limit` | 429 (carries `retryAfterSeconds`) |
| 7 | `ApiError` | `api` | any other non-2xx, carrying `{code, message}` |
| 8 | `TransportError` | `transport` | DNS/TCP/TLS/timeout, or an unparseable body |

**This table is a stable contract.** Agents and scripts branch on these numbers (see
`skills/pingcode/SKILL.md` and the README). Changing a mapping is a breaking change: update
`errors.ts`, `design.md` §5.2, `SKILL.md`, the README table, and the tests together, in one commit.

`DryRunHalt` is **not** an error. It is control flow: the transport layer throws it instead of
sending a mutating request under `--dry-run`, and `bin/pingcode.ts` renders the plan and exits 0.
`exitCodeFor(DryRunHalt)` is 0 by construction.

---

## Error Handling Patterns

### Status-first, then a narrow `code` override

`errorForResponse()` in `src/core/wire.ts` maps in this order:

1. If the body's `code` is in **`ERROR_CODE_OVERRIDES`**, that wins — because the status is wrong.
2. Otherwise switch on the HTTP status (401/403/404/429).
3. Otherwise `ApiError`.

The override table is small and evidence-backed (`research/s8-smoke.md` F2/F3): this API answers
HTTP **400** where REST convention would use 401 or 404, which made exits 3 and 5 unreachable.

| `code` | HTTP | Observed on | → |
|---|---|---|---|
| `100024` | 400 | `GET /v1/auth/token`, wrong client id/secret | `AuthError` (3) |
| `100317` | 400 | `GET /v1/pjm/work_items/{unknown id}` | `NotFoundError` (5) |
| `100303` | 400 | `PATCH` with an unknown `state_id` | `NotFoundError` (5) |

**Never match on message text.** The PingCode API is Chinese-only and its wording is not a contract;
a locale or copy change would silently break the mapping. Match on the `code` string only, and only
for codes actually observed against the live API. Add a new entry only with a recorded observation
in `research/`, and cite it in the comment above the table.

The 404 branch stays even though this API is not observed to return 404 — for self-hosted builds and
future behaviour. Note the asymmetry: an invalid *bearer* token on a resource endpoint **does**
return a real 401, so that branch is live.

### Never send the same mutating body twice

**Invariant: one invocation of the CLI sends a given mutating request at most once.**

The invalidate-on-rejection path (`withCacheInvalidation` + `runWrite`) is the only thing that
retries a write, and it must decide whether to retry by asking *"would the second request differ?"*
— re-resolve with the cache bypassed, compare the resolved ids, and send again **only if some id
changed**. If they are identical, rethrow the original error and send nothing; `runWrite` signals
this with `RetryWouldBeIdentical`.

Do **not** decide this by classifying the error. It was tried and it cannot work: the API returns
one code (`100702`) both for an id that does not exist and for a value it merely refuses in context
(`08-01-ship-cli/research/s7-smoke.md` F5). Id identity is a fact the CLI owns; error semantics are
not.

### Retry and replay policy

Encoded once, in `core/http.ts`, never at a call site:

- **429** → honour `x-pc-retry-after` (capped at 60 s), retry **once**. If the header is absent,
  **fail fast** — blind retries just burn the same budget.
- **401** → re-acquire the token once and replay the original request. A second 401 becomes
  `AuthError`; the replay must not be able to recurse.
- Anything below HTTP (DNS, TLS, aborts) becomes `TransportError`, with the redacted URL in the
  message.
- **Any 2xx is success.** Never branch on 200 vs 201; the API's own docs are imprecise here.

### Client-side validation happens before the request

Unresolvable/ambiguous names, `--state <name>` without `--type`, `--page-size > 100`, and an empty
update patch are all `UsageError` (exit 2) raised *before* any network call. A `UsageError` that
lists candidates must actually list them — that is the difference between exit 2 being useful and
being noise.

---

## API Error Responses

Rendered by `cli/output.ts`. In `--json` mode the error goes to **stderr** and stdout stays empty:

```json
{"error":{"kind":"not_found","message":"…","code":"100317","exit":5}}
```

Human mode prints the message, then the hint, to stderr. In both modes the message has already been
through `redactUrl()` / `redactSnippet()`.

---

## Common Mistakes

- **Reinterpreting a status without evidence.** F2/F3 were only found by running against the live
  API. If a mapping surprises you, record the observation in `research/` first, then change code.
- **Pattern-matching the Chinese message text** instead of the `code`.
- **Calling `process.exit` from a command**, which bypasses error rendering and the `--json`
  contract.
- **Letting a raw URL into an error message.** The `client_secret` travels in the query string on
  this API — see `logging-guidelines.md`.
- **Treating `DryRunHalt` as a failure**, or catching it too early so the plan is never printed.
- **Retrying a 429 without the header.** There is no safe interval to guess.
