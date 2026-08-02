# Implementation plan — CLI 命令树按 GUI 模块聚合重组

Read `prd.md` first. Q1 is settled (Resolved Decisions D1/D2); there is no `design.md`
because this task has no remaining technical decision — only mechanical relocation.

## Ground rules

- **This is one atomic commit.** Unlike a normal sliced task, there is no green
  intermediate state: `test/help.test.ts` asserts the exhaustive leaf-path list *and*
  cross-checks every command path in `skills/pingcode/SKILL.md`. Move one group and both
  assertions go red until every group, both test files and SKILL.md agree again.
  The checkpoints below are a **work order**, not commit boundaries. Only C7 commits.
- Behaviour must not change. Same flags, same output, same exit codes, same API calls.
  Only the argv path changes.
- Do not touch `src/core/**`, `src/api/**`, `src/types/**`. If the refactor appears to
  need it, **stop and report**.
- Zero new dependencies. `package-lock.json` must stay byte-identical.
- Every leaf must still be wrapped in `addGlobalOptions(cmd, { hidden: true })`
  (`src/cli/globals.ts:35-54`). Nesting one level deeper makes it easy to drop; verify
  leaf by leaf, and rely on the existing "accepts the global flags after the subcommand
  too" test in `help.test.ts` to catch misses.
- No alias / deprecation shim for old paths (PRD AC3).

## Leaf conservation — the primary correctness check

The tree today has **36 leaves**. After the refactor it must still have **36**, with the
same trailing verbs. Nothing is added, removed, or renamed except `meta product-members`
→ `product meta members`.

| Group | Today | After |
|---|---|---|
| `auth` | 3 | `auth` 3 |
| `project` | 2 | `project` 2 |
| `work-item` | 5 | `project work-item` 5 |
| `product` | 2 | `product` 2 |
| `idea` | 4 | `product idea` 4 |
| `ticket` | 5 | `product ticket` 5 |
| `meta` (pjm 4) | 4 | `project meta` 4 |
| `meta` (ship 10) | 10 | `product meta` 10 |
| `meta users` | 1 | `settings users` 1 |
| **total** | **36** | **36** |

## Target tree (canonical spelling — copy from here, do not re-derive)

Top-level registration order in `buildProgram()` follows the GUI module order:

```
auth      login status logout

product   list get
          idea     list get create update
          ticket   list get create update transition
          meta     idea-states idea-priorities idea-suites idea-properties members
                   ticket-states ticket-priorities ticket-types ticket-channels
                   ticket-properties

project   list get
          work-item list get create update transition
          meta      types states priorities sprints

settings  users
```

`testhub` is inserted between `project` and `settings` by `08-02-testhub-module`, which
runs **after** this task.

Registration order matters: `help.test.ts` compares `leafPaths()` output as an ordered
array, and `leafPaths` walks `command.commands` in registration order. Inside `product`
register the group's own `list`/`get` first, then `idea`, `ticket`, `meta`. Inside
`project`: `list`/`get`, then `work-item`, then `meta`.

## Checkpoints

### C1 — `product` aggregation
`src/cli/commands/product.ts`: keep `list`/`get` on the group; export
`registerProductCommands(program)` unchanged in name, but have it build the `product`
group and pass that `Command` down.
`src/cli/commands/idea.ts` / `ticket.ts`: change `registerIdeaCommands(program: Command)`
→ `registerIdeaCommands(parent: Command)` and attach to `parent` instead of creating a
top-level group. Body of every leaf is untouched.

### C2 — `project` aggregation
Same treatment for `src/cli/commands/project.ts` + `workItem.ts`.

### C3 — split `meta.ts` (PRD R2)
`src/cli/commands/meta.ts` currently holds three modules' lookups. Split it:

- pjm 4 leaves (`types`, `states`, `priorities`, `sprints`) → `project.ts`, registered as
  a `meta` subgroup of `project`.
- ship 10 leaves → `product.ts`, registered as a `meta` subgroup of `product`. Move the
  `productScoped()` factory with them; it is used by 9 of the 10.
  `product-members` is renamed to `members` — the `product-` prefix is redundant inside
  `product meta`. This is the **only** leaf rename in the task.
- `users` → new `src/cli/commands/settings.ts` exporting
  `registerSettingsCommands(program: Command)`. It keeps `addPagingOptions` and the
  existing `printCollection(page.values, …)` behaviour including the comment explaining
  why a paginated lookup still emits `{values,count}`.
- Delete `meta.ts`. Its `Column` definitions travel with their leaves; if any ends up
  needed in two files, lift it to `cli/commands/common.ts` rather than duplicating.

### C4 — `program.ts`
Imports and registration reduced to four calls in GUI order: `registerAuthCommands`,
`registerProductCommands`, `registerProjectCommands`, `registerSettingsCommands`.
`registerIdeaCommands` / `registerTicketCommands` / `registerWorkItemCommands` are no
longer called from here — their parents call them. `registerMetaCommands` is gone.

### C5 — tests
Four files reference command paths through `buildProgram()` / `runCli`:

- `test/help.test.ts` — rewrite the group list (`seven` → four: `auth`, `product`,
  `project`, `settings`; update the `it(...)` title too) and the 36-entry leaf-path
  array in the new registration order.
- `test/commands.test.ts` — pjm argv (`work-item …`, `meta types …`).
- `test/shipCommands.test.ts` — ship argv (`idea …`, `ticket …`, `meta idea-* …`).
- `test/globals.test.ts` — whichever argv it uses to exercise global flags.

`test/__snapshots__/help.test.ts.snap` (11.8 K): regenerate with `npx vitest -u` and
**read the diff** — group help text now lists subgroups instead of leaves, which is the
intended change; anything else (a lost flag, a changed description) is a bug.

### C6 — docs
`skills/pingcode/SKILL.md` — 77 lines mention `pingcode `; every command path must be
rewritten. This file is cross-checked by `help.test.ts`, so a miss fails CI rather than
silently rotting.
`README.md` — 41 lines mention `pingcode `; same rewrite, not test-enforced, so proofread.

### C7 — verify and commit
```
npm run typecheck
npm test
npm run build
node dist/bin/pingcode.js --help
node dist/bin/pingcode.js product idea --help
node dist/bin/pingcode.js project meta --help
node dist/bin/pingcode.js settings users --help
npm run check:commits
```
Then confirm PRD AC8 mechanically:
```
git diff --stat -- src/core src/api src/types    # must be empty
```
One Conventional Commit, e.g.
`refactor(cli)!: group commands by PingCode GUI module`.

## Risks

| Risk | Mitigation |
|---|---|
| A leaf silently loses `addGlobalOptions` when re-parented | the existing global-flag test in `help.test.ts` iterates every leaf; keep it |
| Leaf-path array order mismatch produces a confusing diff | register in the order given in "Target tree"; the assertion is order-sensitive |
| A `Column` constant is duplicated during the `meta.ts` split | lift to `common.ts` instead; `code-reuse-thinking-guide.md` |
| Snapshot regenerated blindly, hiding a real regression | read the snapshot diff; it should only show nesting changes |
| SKILL.md path missed | `help.test.ts` cross-check catches it — do not weaken that test to get green |

## Rollback

Single commit, no data or config migration, no API change. `git revert` restores the old
tree completely.
