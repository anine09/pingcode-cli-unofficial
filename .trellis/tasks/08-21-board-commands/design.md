# Board 看板 CLI 命令 — Technical Design

## Existing Infrastructure (Already In Place)

The board feature is partially scaffolded. These pieces exist and should be reused:

| Layer | File | What exists |
|-------|------|-------------|
| Endpoints | `src/core/endpoints.ts:275-290` | `projectBoards`, `projectBoardEntries`, `projectBoardSwimlanes` |
| Resolve | `src/core/metadata/index.ts:70-79` | `resolveBoard`, `resolveEntry`, `resolveSwimlane` |
| Registry | `src/core/metadata/registry.ts:89-129` | `'pjm-board'`, `'pjm-board-entry'`, `'pjm-board-swimlane'` with `boardChildren` loader |
| Resolve loader | `src/core/metadata/resolve.ts:527` | `loadBoardChildren` — lists all boards, then children of each |
| API types | `src/api/workItems.ts:52-54,89-91,120-122` | `board_id`, `entry_id`, `swimlane_id` in list/create/update inputs |
| Parse | `src/api/parse/pjm.ts:121-123` | `board`, `entry`, `swimlane` parsed as `Ref` on WorkItem |
| Types | `src/types/pjm.ts:136-138` | `board?: Ref`, `entry?: Ref`, `swimlane?: Ref` on WorkItem |

## What Must Be Built

### 1. API Functions (`src/api/meta.ts`)

Three list functions, following the `listSprints` / `listVersions` pattern:

```typescript
export async function listBoards(ctx: Ctx, projectId: string): Promise<Board[]>
export async function listBoardEntries(ctx: Ctx, projectId: string, boardId: string): Promise<BoardEntry[]>
export async function listBoardSwimlanes(ctx: Ctx, projectId: string, boardId: string): Promise<Swimlane[]>
```

All use `listAllOf` (no paging envelope). Parse functions needed in `src/api/parse/pjm.ts`.

### 2. Types (`src/types/pjm.ts`)

```typescript
export type Board = { id: string; name?: string; url?: string; project?: Ref; [key: string]: unknown };
export type BoardEntry = { id: string; name?: string; url?: string; board?: Ref; [key: string]: unknown };
export type Swimlane = { id: string; name?: string; url?: string; board?: Ref; [key: string]: unknown };
```

All are read-only list resources (GET only). No create/update/delete endpoints exist.

### 3. CLI Command File (`src/cli/commands/projectBoard.ts`)

New file, following `projectSprint.ts` / `projectVersion.ts` structure:

```
project board
├── list --project <p>
├── entries list --project <p> --board <name|id>
└── swimlanes list --project <p> --board <name|id>
```

- `list`: resolves project, calls `listBoards`, prints with columns
- `entries list`: resolves project, resolves board name→id, calls `listBoardEntries`, prints
- `swimlanes list`: resolves project, resolves board name→id, calls `listBoardSwimlanes`, prints

Each uses `resolveBoard` for `--board` resolution (already exists in `src/core/metadata/index.ts`).

### 4. Registration in `project.ts`

Add import and call in `registerProjectCommands`:

```typescript
import { registerBoardCommands } from './projectBoard';
// ... in registerProjectCommands body:
registerBoardCommands(group);
```

### 5. work-item update/create — board/entry/swimlane flags

**`work-item update`** (`src/cli/commands/workItem.ts:306`):
- Add to `UpdateFlags`: `board?: string`, `entry?: string`, `swimlane?: string`
- Add options: `.option('--board <name|id>', '...')`, `.option('--entry <name|id>', '...')`, `.option('--swimlane <name|id>', '...')`
- In `runUpdate` resolve function: resolve board/entry/swimlane using `resolveBoard/Entry/Swimlane` with projectId from work item
- Add to patch: `board_id`, `entry_id`, `swimlane_id`
- Entry and swimlane resolution needs board context: if `--entry` given but `--board` not given, we need to figure out which board the entry belongs to. The `loadBoardChildren` loader already handles this — it lists all boards and their children, so `resolveEntry(ctx, projectId, entryName)` works without explicit `--board`.

**`work-item create`** (`src/cli/commands/workItem.ts:283`):
- Same flags, same resolution pattern
- Project comes from `--project` flag
- Add to input: `board_id`, `entry_id`, `swimlane_id`

## D5.2 — Cross-Object Family Pattern

The existing `addCrosscutting` function (workItem.ts:458) handles cross-object families. Board is a different pattern — it's a project-scoped child resource, not a cross-object relation. So we follow the sprint/version pattern instead.

## Backward Compatibility

- `work-item list` already has `--board`/`--entry`/`--swimlane` as search filters (workItem.ts:226-228) — these are NOT changed
- `work-item update`/`create` get NEW flags — additive, no behavior change for existing invocations
- `project board` is a new subcommand group — no conflicts

## Risk

- Board/entry/swimlane name resolution: the `boardChildren` loader lists ALL boards and their children, which could be slow for projects with many boards. This is acceptable (matches the resolve pattern used for `work-item list --board <name>`).
- The API may not support `board_id`/`entry_id`/`swimlane_id` in PATCH body — this was verified for bulk-update (silently ignored), but single-item PATCH may differ. Need live verification.
