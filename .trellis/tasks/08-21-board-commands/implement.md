# Board 看板 CLI 命令 — Implementation Plan

## Ordered Checklist

### Step 1: API Types + Parse Functions
- [ ] Add `Board`, `BoardEntry`, `Swimlane` types to `src/types/pjm.ts`
- [ ] Add `parseBoard`, `parseBoardEntry`, `parseSwimlane` to `src/api/parse/pjm.ts`
- [ ] Verify: `npx tsc --noEmit` passes

### Step 2: API Functions
- [ ] Add `listBoards(ctx, projectId)` to `src/api/meta.ts`
- [ ] Add `listBoardEntries(ctx, projectId, boardId)` to `src/api/meta.ts`
- [ ] Add `listBoardSwimlanes(ctx, projectId, boardId)` to `src/api/meta.ts`
- [ ] Verify: `npx tsc --noEmit` passes

### Step 3: CLI Command File
- [ ] Create `src/cli/commands/projectBoard.ts`
- [ ] Implement `registerBoardCommands(parent: Command)` with:
  - `board list --project <p>` — resolve project, listBoards, printCollection
  - `board entries list --project <p> --board <name|id>` — resolve project+board, listBoardEntries, printCollection
  - `board swimlanes list --project <p> --board <name|id>` — resolve project+board, listBoardSwimlanes, printCollection
- [ ] Define columns: BOARD_COLUMNS, ENTRY_COLUMNS, SWIMLANE_COLUMNS
- [ ] Define help text for the board group
- [ ] Verify: `npx tsc --noEmit` passes

### Step 4: Register in project.ts
- [ ] Add `import { registerBoardCommands } from './projectBoard'` to `project.ts`
- [ ] Call `registerBoardCommands(group)` in `registerProjectCommands`
- [ ] Verify: `npx tsc --noEmit` passes

### Step 5: work-item update — board/entry/swimlane flags
- [ ] Add `board?`, `entry?`, `swimlane?` to `UpdateFlags` in workItem.ts
- [ ] Add `.option('--board <name|id>', '...')` etc to update command
- [ ] Add resolution in `runUpdate` resolve function using `resolveBoard/Entry/Swimlane`
- [ ] Add to patch: `board_id`, `entry_id`, `swimlane_id`
- [ ] Update help text
- [ ] Verify: `npx tsc --noEmit` passes

### Step 6: work-item create — board/entry/swimlane flags
- [ ] Add `board?`, `entry?`, `swimlane?` to `CreateFlags` in workItem.ts
- [ ] Add `.option('--board <name|id>', '...')` etc to create command
- [ ] Add resolution in `runCreate` resolve function
- [ ] Add to input: `board_id`, `entry_id`, `swimlane_id`
- [ ] Verify: `npx tsc --noEmit` passes

### Step 7: Quality Check
- [ ] Run `npx tsc --noEmit` — no type errors
- [ ] Run `npx eslint src/` — no lint errors
- [ ] Run `npx vitest run` — all tests pass
- [ ] Manual smoke test with `--dry-run` if credentials available

## Validation Commands

```bash
npx tsc --noEmit
npx eslint src/
npx vitest run
```

## Rollback Points

- After Step 1: pure types, no behavior change
- After Step 2: API functions added but not wired
- After Step 3: new command file, not registered yet
- After Step 4: board commands live but work-item flags not added
- After Step 5-6: full feature

## Reference Patterns

- `src/cli/commands/projectSprint.ts` — sprint list/create/update/delete
- `src/cli/commands/projectVersion.ts` — version list/create/update/delete/bulk
- `src/cli/commands/projectMember.ts` — member list/get/add
- `src/cli/commands/workItem.ts` — resolveBoard/Entry/Swimlane usage, UpdateFlags, runUpdate

## Notes

- Board/entry/swimlane are GET-only resources (no create/update/delete API endpoints)
- Entry and swimlane resolution already works without explicit `--board` thanks to `loadBoardChildren` loader
- The `boardChildren` loader iterates all boards — acceptable for CLI usage
- `work-item list --board/--entry/--swimlane` already exist as search filters and are NOT changed
