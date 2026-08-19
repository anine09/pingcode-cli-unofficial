# Implement — clear-assignee honesty guard

Ordered checklist. Validate after each code step. Roll back by reverting the commit (no state migration).

## 0. Read first (already done in planning)
- `prd.md`, `design.md`, this file.
- `research/clear-assignee-api.md`.
- `src/cli/commands/workItem.ts` `runUpdate` (assignee resolution @ ~L1094; patch @ L1118).
- `src/core/metadata/resolve.ts` empty guard @ L347.
- `src/core/errors.ts` (`UsageError` shape, exit 2).
- Spec: `.trellis/spec/backend/error-handling.md` (exit-code contract, hint rule).

## 1. Implement the clear-intent guard (R1–R4)
File: `src/cli/commands/workItem.ts`, `runUpdate`, the assignee block @ ~L1094.

Replace:
```ts
const assignee =
  flags.assignee === undefined ? undefined : await resolveUser(attemptCtx, flags.assignee);
```
with:
```ts
let assignee: ResolveResult | undefined;
if (flags.assignee !== undefined) {
  if (flags.assignee.trim() === '') {
    throw new UsageError("the PingCode Open API cannot clear a work item's assignee", {
      hint: 'clearing the assignee is only supported in the PingCode web UI — `--assignee ""` is not accepted by the API',
    });
  }
  assignee = await resolveUser(attemptCtx, flags.assignee);
}
```
Notes:
- `ResolveResult` is the type already used at the patch site (`present([... assignee ...])`); confirm it is imported (it is — L1125 uses it).
- No API-layer or type change. The patch spread at L1118 (`...(assignee === undefined ? {} : { assignee_id: assignee.id })`) stays identical.

## 2. Document the limitation (R5)
- `workItem.ts` `update` command `--assignee` option (@ L265): extend `'new assignee'` to note the API cannot clear it (one line).
- User-facing doc that documents `work-item update` (the SKILL/README section): add one line stating clearing the assignee is not supported via the Open API.

## 3. Tests
File: `test/workItem.test.ts` (or the command's existing test file — confirm via glob).
- New test: `update` with `--assignee ""` → throws `UsageError`, exit 2, message names the API limitation, and **no fetch/PATCH is issued** (assert the injected `fetch` is not called).
- Existing `--assignee <user>` assign path still resolves and patches (no regression).
Run: `rtk run npm test` (or the repo's test script — confirm in package.json).

## 4. Quality check (trellis-check)
- `rtk run npm test` — all green, incl. the new test.
- `rtk run npm run build` (or `tsup`) — compiles strict.
- `rtk run npm run lint` if present.
- Layering invariant: change is inside `cli/`; no `core`/`api` import direction touched.

## 5. Commit
Stage only: `src/cli/commands/workItem.ts`, the doc file(s), the new/updated test, task artifacts. Message style: `fix(work-item): reject clearing assignee with an actionable error (Open API cannot clear it)`. Reference `Closes #1` only if the repo's convention permits (check recent commits — they don't use issue refs; omit to match style).

## Validation commands (exact)
- `rtk run npm test`
- `rtk run npm run build`
- manual reasoning check: empty assignee throws before `updateWorkItem` (no PATCH).

## Rollback points
- Step 1 only → revert the guard; docs/tests untouched.
- Full revert → revert the commit.

## Review gate
Do NOT `task.py start` implementation until the user approves these artifacts (planning phase). Once approved, start, implement, run trellis-check, commit.
