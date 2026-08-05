# Quality Guidelines

> What "green" means here, and the patterns that are not negotiable.

---

## Overview

Two commands must pass before any slice is considered done:

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest run
```

`npm run build` (tsup) and a manual `node dist/bin/pingcode.js --help` walk are the release check.

TypeScript is strict and then some — `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `moduleResolution: bundler`. `exactOptionalPropertyTypes` in particular
shapes the code: optional fields are written `field?: T | undefined`, and options objects are built
conditionally rather than assigned `undefined`.

---

## Forbidden Patterns

| Forbidden | Why |
|---|---|
| `any`, unchecked `as` on wire data | The API has no OpenAPI spec; `api/parse.ts` is the only place allowed to shape untyped input, and it must narrow explicitly. |
| Importing `cli` or `api` from `core`, or `cli` from `api` | Breaks the layering invariant; `test/layering.test.ts` fails. Pass data through `Ctx`. |
| `node:fs` or `buildUrl` inside `cli/` | Filesystem and URL construction belong to `core/`. Asserted by `test/layering.test.ts`. |
| `console.log` for anything that is not the command's result | Breaks the `--json` stdout contract. Use `ctx.logger` (stderr). |
| `process.exit()` outside `bin/pingcode.ts` | Bypasses error rendering and the exit-code table. Throw a typed error. |
| Matching on API **message text** | The API is Chinese-only; wording is not a contract. Match on the `code` string. |
| Printing a raw URL, header map, or response body | The `client_secret` travels in the query string. Route through `redactUrl` / `redactHeaders` / `redactSnippet`. |
| Real network calls in tests | Inject `fetch` through `Ctx`. See below. |
| Adding a runtime dependency | The list is frozen at `commander` + `picocolors`. Needs a stated reason. |
| Shape-validating an id client-side | Ids are 24-hex, 32-hex (users), *or* bare slugs (`task`, `story`, `bug`). Ids pass through untouched. |
| Naming a leaf flag `--version` (or binding `-v`) | The root owns `--version`, and commander's root parses options across the whole argv: `project work-item update X --version 1.4` printed the CLI version, exited 0 and sent nothing. Use `--release`. Pinned by `test/help/project.test.ts` and `test/help/root.test.ts`. |
| Exposing a flag for a field or filter the server silently ignores | A flag that lies is worse than an absent one; the API answers 200 and sometimes echoes the value it discarded. See [Live Verification](./live-verification.md). |

## Required Patterns

- **Dependency injection via `Ctx`** (`src/core/context.ts`): `fetch`, `now`, `sleep`, `logger`,
  `env` and the persistence hook are all injected. Anything that reaches for a global instead is
  untestable and will be rejected.
- **One place per policy.** Retry/replay lives in `core/http.ts`; error mapping in `core/wire.ts`;
  wire quirks in `api/parse.ts`; paths in `core/endpoints.ts`; redaction in `core/redact.ts`. If a
  call site needs to know a policy, the policy is in the wrong place.
- **Normalise wire quirks exactly once.** `is_archived`/`is_deleted` arrive as `0/1`; `version` is
  sometimes an object and sometimes a `versions` array. Fix it in `api/parse.ts`, not per command.
- **Timestamps stay raw unix seconds** through `core` and `api`, and in `--json`. Formatting happens
  only in `cli/output.ts`.
- **Every mutating command supports `--dry-run`**, and the gate lives in the transport layer so it
  cannot be forgotten by a new command.

## Testing Requirements

- **Vitest, `test/*.test.ts`, one file per module**, plus the cross-cutting suites:
  `test/layering.test.ts` (the architecture invariant), `test/help/<group>.test.ts` (one `--help`
  suite per command group), `test/help/root.test.ts` (the tree's structural rules) and
  `test/help/skill.test.ts` (every command path named in `SKILL.md` exists in the commander tree).
- **A help suite asserts its own group's leaves — never a repo-wide list.** vitest keeps **one
  snapshot file per test file**, so a single suite holding one ordered list of every leaf in the CLI
  is a merge point that serialises every parallel change through one file; that is exactly what the
  former `test/help.test.ts` did, and splitting it is what made eight children able to add leaves at
  once. `test/help/tree.ts` holds the shared traversal so a group states its leaves once and derives
  the rest. Adding a whole group stays one row in `src/cli/registry.ts` plus a one-line snapshot diff,
  and changes **no** hand-written assertion.
  - Corollary, learned by reverting it: a group *description* renders in `pingcode --help` and
    reflows the root snapshot. Per-group notes — a dead filter, an upstream asymmetry, "this endpoint
    ignores paging" — go in `addHelpText('after')`, which the root never prints.
- **A test harness must not hand-roll the root program.** Root-level commander settings propagate
  downwards, so a harness that builds its own `new Command()` root is testing a tree the CLI never
  runs: `api DELETE … --yes false` passed in three such harnesses while the real binary refused it.
  Use `createCliHarness` (`test/helpers/cli.ts`), which calls `buildProgram()` and owns a temp
  `PINGCODE_CONFIG_DIR`.
  > **Known gap, stated rather than papered over.** Three suites (`apiCommand`, `resolveCommand`,
  > `testhubCommands`) still build their own root and compensate by re-adding
  > `allowExcessArguments(false)` by hand. That patches the one setting known to matter and **will
  > drift again** with the next root-level setting — the defect is the class, not those three lines.
  > The fix is to route them through `createCliHarness` or to assert that a harness root's settings
  > equal `buildProgram()`'s; until then, do not add a fourth hand-rolled root.

- **The workflow and hook suites assert text, not acceptance.** `test/workflows.test.ts` and
  `test/githooks.test.ts` read `.github/workflows/` and `.githooks/` from disk and scan them
  line-by-line — no YAML parser, no shell parser, because that would buy a dependency (see Forbidden
  Patterns). They prove what a file *says*: that every `npm run` target exists, that actions are
  pinned, that a gate was not quietly removed.
  > **Known gap, stated rather than papered over.** Nothing in this repository performs GitHub's own
  > schema validation — context availability per key, allowed `jobs.<id>.*` keys, where an expression
  > may appear — so **a workflow can be fully green locally and still be unable to start**. That
  > failure is close to silent: an invalid job-level `${{ runner.* }}` is not a runtime error but a
  > validation error, reported as a 0-second run with no job, no check suite, and the workflow's `name`
  > falling back to its file path. Nothing is red anywhere; the gate simply never ran. **GitHub is the
  > only authoritative validator.** The rule that follows: after adding or editing a workflow, trigger
  > it once — `gh workflow run <file>` (or `gh api repos/{owner}/{repo}/actions/workflows` and check
  > that `name` is the declared name) — and read the run. A push that no longer errors is not proof the
  > workflow runs. `test/workflows.test.ts` pins each invalid shape once it has been found (the
  > job-level `env:` context allowlist is one); that list is a record of past accidents, not coverage.

- **Zero network in unit tests.** No `msw`, no `nock`: `Ctx.fetch` is replaced with a fake
  (`test/helpers/fake.ts`). A test that would open a socket is a bug in the test.
- **Determinism is injected**, not mocked globally: `now` and `sleep` come from `Ctx`, so expiry
  boundaries and the 429 wait are tested without timers.
- **Test the security properties, not just the happy path.** The redaction tests assert that *no
  substring* of the secret survives, including inside query strings. The dry-run tests assert that
  **zero** requests were sent for a mutating verb while reads still run. The 401 test asserts the
  replay happens exactly once and cannot recurse.
- **The highest-value tests get the most cases.** `normalizeExpiry` is tested against both
  `expires_in` interpretations (absolute epoch and duration), the past-timestamp clamp, zero and
  `NaN`, because getting it wrong silently breaks auth 30 days later.
- **New behaviour ships with a regression test in the same commit.** A bug found by hand becomes a
  test before it becomes a fix.

### Real-API facts are recorded, never assumed

Unit tests prove our logic; they cannot prove the API's. So:

- Live-API behaviour is verified once, by hand, against the user's real instance, and **written down**
  in `.trellis/tasks/*/research/` (`pingcode-api.md` for the endpoint contract, `s8-smoke.md` for the
  observed run). Anything not verified is listed explicitly as *not verified, and why*.
- **When reality contradicts the docs, update `research/pingcode-api.md` and `design.md` — do not
  quietly patch the call site.** The point is that the next person reads the same facts we acted on.
  Every code comment that encodes a surprising API behaviour cites the research file that observed it
  (see the `ERROR_CODE_OVERRIDES` comment in `core/wire.ts`).
- Currently unverified against the live API, by design: 429/`x-pc-retry-after`, 403/exit 4, and the
  self-hosted `<host>/open` derivation. They are unit-tested only, and the README says so.
- **How to obtain such a fact safely — an isolated `PINGCODE_CONFIG_DIR`, an independent read-back
  because a 200 does not mean the field was stored, and a probe per filter — is
  [Live Verification](./live-verification.md).** Read it before any live-tenant work.

## Code Review Checklist

- [ ] `npm run typecheck && npm test` green; new behaviour has a test.
- [ ] Layering respected — would `test/layering.test.ts` still pass conceptually, not just by luck?
- [ ] `--json` stdout still pure; nothing new printed on stdout that is not the result.
- [ ] No new path can print a secret; redaction helper used, and asserted.
- [ ] Exit codes unchanged, or changed everywhere at once (`errors.ts`, `design.md`, `SKILL.md`,
      README, tests).
- [ ] Mutating command has `--dry-run` coverage, and the dry-run sends nothing.
- [ ] `SKILL.md` and the README still describe flags that exist (`test/help/skill.test.ts` checks
      command paths; flags are on the reviewer).
- [ ] New leaves assert their own group's help suite; no repo-wide leaf list was reintroduced.
- [ ] Every new flag is backed by a live observation that the field or filter it sends actually takes
      effect.
- [ ] No new runtime dependency, or a reason stated.
- [ ] A new or edited workflow was actually triggered on GitHub once, not merely pushed.
- [ ] API-behaviour claims trace back to `research/`, not to guesswork.
