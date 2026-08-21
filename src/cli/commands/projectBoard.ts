import type { Command } from 'commander';
import { listBoardEntries, listBoards, listBoardSwimlanes } from '../../api/meta';
import { resolveBoard, resolveProject } from '../../core/metadata';
import type { Board, BoardEntry, Swimlane } from '../../types/api';
import { addGlobalOptions } from '../globals';
import { type Column } from '../output';
import { contextFor, modeOf, printCollection, refName, requireFlag } from './common';

/**
 * `pingcode project board …` — 看板 (boards): the columns and swimlanes of a
 * project's kanban/scrum boards. Read-only: GET only, no create/update/delete
 * endpoints exist (catalog `pjm.projects.boards.*`).
 *
 * Scopes `pcp:read:pjm:board` / `pcp:read:pjm:boardentry` /
 * `pcp:read:pjm:boardswimlane` — all read-only.
 *
 * Entries and swimlanes are board-scoped (both ids ride in the path), so their
 * leaves require `--board <name|id>`. The board resolver lists every board of
 * the project, then matches by name.
 */

const PROJECT_HELP = 'project name or id';
const BOARD_HELP = 'board name or id — list boards with `project board list`';

type ListFlags = { project: string };
type EntriesFlags = { project: string; board: string };
type SwimlanesFlags = { project: string; board: string };

const BOARD_COLUMNS: Column<Board>[] = [
  { header: 'ID', value: (b) => b.id },
  { header: 'NAME', value: (b) => b.name ?? '', flex: true },
  { header: 'PROJECT', value: (b) => refName(b.project) },
];

const ENTRY_COLUMNS: Column<BoardEntry>[] = [
  { header: 'ID', value: (e) => e.id },
  { header: 'NAME', value: (e) => e.name ?? '', flex: true },
];

const SWIMLANE_COLUMNS: Column<Swimlane>[] = [
  { header: 'ID', value: (s) => s.id },
  { header: 'NAME', value: (s) => s.name ?? '', flex: true },
];

export function registerBoardCommands(parent: Command): void {
  const group = parent
    .command('board')
    .description(
      '看板 boards: list boards, entries and swimlanes (scopes pcp:read:pjm:board / pcp:read:pjm:boardentry / pcp:read:pjm:boardswimlane)',
    )
    .addHelpText(
      'after',
      '\nAll three are read-only: the API exposes GET only for boards, entries and\n' +
        'swimlanes. There is no create/update/delete — a board is configured in the\n' +
        'PingCode web UI.\n' +
        'Entries and swimlanes are board-scoped: every entry/swimlane belongs to exactly\n' +
        'one board, so their leaves need --board. `--board <name>` resolves the board\n' +
        'name against the project\'s board list.\n' +
        'A work item joins a board/entry/swimlane through `work-item update --board <b>`\n' +
        '/ --entry <e> / --swimlane <s> — the ids come from this command group.\n',
    );

  addGlobalOptions(
    group
      .command('list')
      .description('list the boards of a project')
      .requiredOption('--project <name|id>', PROJECT_HELP),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runListBoards(flags, command);
  });

  addGlobalOptions(
    group
      .command('entries')
      .description('board entries (columns) — scoped to one board')
      .requiredOption('--project <name|id>', PROJECT_HELP)
      .requiredOption('--board <name|id>', BOARD_HELP),
    { hidden: true },
  ).action(async (flags: EntriesFlags, command: Command) => {
    await runListEntries(flags, command);
  });

  addGlobalOptions(
    group
      .command('swimlanes')
      .description('board swimlanes — scoped to one board')
      .requiredOption('--project <name|id>', PROJECT_HELP)
      .requiredOption('--board <name|id>', BOARD_HELP),
    { hidden: true },
  ).action(async (flags: SwimlanesFlags, command: Command) => {
    await runListSwimlanes(flags, command);
  });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runListBoards(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const project = await resolveProject(ctx, flags.project);
  const boards = await listBoards(ctx, project.id);
  printCollection(boards, BOARD_COLUMNS, modeOf(ctx));
}

async function runListEntries(flags: EntriesFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const project = await resolveProject(ctx, flags.project);
  const board = await resolveBoard(ctx, project.id, requireFlag(flags.board, '--board'));
  const entries = await listBoardEntries(ctx, project.id, board.id);
  printCollection(entries, ENTRY_COLUMNS, modeOf(ctx));
}

async function runListSwimlanes(flags: SwimlanesFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const project = await resolveProject(ctx, flags.project);
  const board = await resolveBoard(ctx, project.id, requireFlag(flags.board, '--board'));
  const swimlanes = await listBoardSwimlanes(ctx, project.id, board.id);
  printCollection(swimlanes, SWIMLANE_COLUMNS, modeOf(ctx));
}
