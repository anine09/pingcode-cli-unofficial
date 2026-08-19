# Design — clear-assignee honesty guard

## Problem, precisely

`work-item update` resolves `--assignee` through the generic name resolver:

```ts
// src/cli/commands/workItem.ts:1094  (inside runUpdate's resolve closure)
const assignee =
  flags.assignee === undefined ? undefined : await resolveUser(attemptCtx, flags.assignee);
```

`resolveUser → root('user') → resolveWith`, and `resolveWith` rejects an empty input *before* any
lookup (`src/core/metadata/resolve.ts:347`):

```ts
if (input === '') throw new UsageError(`${spec.label} must not be empty`);
```

So `--assignee ""` dies with `user must not be empty` — a message that reads as a CLI input-validation
nag, not as "the API can't do this". And because the guard is generic, we have no way to *interpret*
an empty assignee as a clear-intent and answer it honestly. Worse, via the raw `api PATCH` path there
is no guard at all, so `{assignee_id: null}` returns 200 and silently does nothing — the worst failure
mode (looks like success).

## Decision: client-side clear-intent guard (before any network)

Intercept the empty assignee **inside `runUpdate`**, *before* `resolveUser` is called, and raise a
`UsageError` (exit 2, unchanged contract) with a message that names the real reason and a hint that
points to the Web UI. Placing it here (not in the generic `resolveWith`) is deliberate: the "can't
clear" fact is specific to the work-item assignee field, not to user resolution in general — `user`
resolution legitimately rejects empty input everywhere else, and we must not weaken that.

### Intercept point

Replace the one-liner at `workItem.ts:1094-1095` with an explicit branch:

```ts
let assignee: ResolveResult | undefined;
if (flags.assignee !== undefined) {
  if (flags.assignee.trim() === '') {
    throw new UsageError(
      "the PingCode Open API cannot clear a work item's assignee",
      {
        hint: 'clearing the assignee is only supported in the PingCode web UI — `--assignee ""` is not accepted by the API',
      },
    );
  }
  assignee = await resolveUser(attemptCtx, flags.assignee);
}
```

Why this placement satisfies the constraints:

- **Before network.** It is inside the `resolve` closure, which `runWrite` calls before issuing the
  PATCH. Throwing `UsageError` here aborts before `updateWorkItem` runs — no request, no 200 no-op.
  (R3.)
- **Retry-safe.** `runWrite` only retries on a *write* rejection to re-resolve ids; a `UsageError`
  is not a write error and is never retried. The empty string cannot change on retry anyway, so there
  is no risk of a second identical send. (Invariant: never send the same mutating body twice — still
  holds, trivially, because we send nothing.)
- **Contract untouched.** `UsageError` → exit 2, `kind: usage`. No new error class, no exit-code
  change, no change to `error-handling.md`'s table. (R-constraint.)
- **No message-text matching.** We match on our *own* input (`flags.assignee.trim() === ''`), never
  on the API's Chinese response.

### Why empty string is the (only) clear-intent signal

The reporter's natural attempt is `--assignee ""`. No legitimate update wants an empty assignee
*name*, so an empty value is unambiguous clear-intent. We do **not** add a `--clear-assignee` flag: the
API cannot fulfil it, so such a flag would only need its own error — a new surface for no capability.
If PingCode ever exposes clearing, that is a separate, forward-looking task.

## Documentation (requirement B)

- Update the `--assignee` option description on `work-item update` (`workItem.ts:265`, currently
  `'new assignee'`) to note the limitation in one line, e.g. that the API cannot clear it.
- Add a short note in the user-facing doc that lists command behaviour (the SKILL/README section that
  documents `work-item update`), stating clearing the assignee is not supported via the API.

## Out of scope / explicitly rejected

- Sending `assignee_id: null` or `""` and hoping — rejected: `null` is a silent 200 no-op (dishonest),
  `""` is a 400. We refuse to send instead.
- Widening `UpdateWorkItemInput.assignee_id` to `string | null` — rejected: implies a capability the
  API lacks.
- Changing `resolveWith`'s empty guard — rejected: would weaken empty-input validation for every
  other resolver.

## Rollout / rollback

Single bounded change to one command file + help text + docs + one test. Revert = revert the commit;
no data or state migration. No feature flag needed.
