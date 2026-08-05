import type { Command } from 'commander';
import {
  createCommit,
  getCommit,
  iterateCommits,
  listCommits,
  type CommitListQuery,
  type CreateCommitInput,
} from '../../../api/scm';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { collect } from '../../../core/paginate';
import type { ScmCommit } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  addPagingOptions,
  collectValue,
  contextFor,
  modeOf,
  parseTimestampFlag,
  printCollection,
  printPage,
  printResource,
  readPaging,
  requireFlag,
  timestampCell,
  type PagingFlags,
} from '../common';
import { identifiersOf, oneLine, warnUnlinkedWorkItems, workItemIdentifiers } from './branch';

/**
 * `pingcode scm commit …` — 提交 ([S§3.12.7]).
 *
 * **This is the one scm family that is not addressed under a 托管平台, and therefore
 * the one that takes no `--platform`.** `/v1/scm/commits` has no `product_id` and no
 * `repository_id` in any of its three paths: a commit is an organisation-level
 * record. The asymmetry is the API's, not the CLI's, and it has two consequences a
 * caller has to know:
 *
 *  - `commit list` with no filter is a **whole-organisation scan** (live 2026-08-03:
 *    3725 rows in a tenant with one real integration), so `--sha` or `--work-item-id`
 *    is what you actually want.
 *  - a commit cannot be created "into" a repository. Linking it to one is a separate
 *    step and a separate resource: `scm ref create`, which joins a commit SHA to a
 *    branch. The CI order is **commit → ref**, never both at once.
 *
 * `get` takes an **id or a full 40-hex SHA** — that is the whole point of the family
 * for CI, where a pipeline holds a SHA and has never seen a PingCode id. The value is
 * passed through verbatim with **no shape validation** (ids in this API come in three
 * shapes and validating them client-side is forbidden). Note upstream does not accept
 * an *abbreviated* SHA, which is the first thing a git user will try, so `--help`
 * says so.
 *
 * Unlike a branch's `--sender`, **`--committer` is not an upsert**: it creates no
 * platform user, because this endpoint has no platform to create one in (live
 * 2026-08-03, design D12.1). A misspelling here leaves a commit attributed to a name
 * no identity matches — worth fixing, but it does not manufacture a permanent row,
 * and the two hazards must not be documented as one.
 *
 * There is no `update` and no `delete`: upstream offers neither for this family.
 */

const COMMIT_HELP = 'commit id, or its full 40-character SHA (an abbreviated SHA is not accepted)';

type ListFlags = PagingFlags & { sha?: string | undefined; workItemId?: string | undefined };

type CreateFlags = {
  sha: string;
  message: string;
  committer: string;
  committedAt: string;
  treeId?: string | undefined;
  added?: string[] | undefined;
  removed?: string[] | undefined;
  modified?: string[] | undefined;
  workItem?: string[] | undefined;
};

export const COMMIT_COLUMNS: Column<ScmCommit>[] = [
  { header: 'SHA', value: (commit) => shortSha(commit.sha) },
  { header: 'MESSAGE', value: (commit) => oneLine(commit.message), flex: true },
  { header: 'COMMITTER', value: (commit) => commit.committer_name ?? '' },
  { header: 'COMMITTED', value: (commit) => timestampCell(commit.committed_at) },
  { header: 'FILES', value: (commit) => String(commit.file_changed_count ?? '') },
  { header: 'WORK ITEMS', value: (commit) => identifiersOf(commit.work_items).join(' ') },
];

/**
 * A table cell shows the familiar 7-character prefix; `--json` and the single-resource
 * view keep the full value. Shortening is display-only and never round-trips — the API
 * does not accept an abbreviated SHA back.
 */
function shortSha(sha: string | undefined): string {
  return sha === undefined ? '' : sha.slice(0, 7);
}

export function registerCommitCommands(parent: Command): void {
  const group = parent
    .command('commit')
    .description('commits 提交 — organisation-level, so these take no --platform');

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list commits across the whole organisation — filter, or this scans everything')
        .option('--sha <sha>', 'exact full 40-character SHA')
        .option('--work-item-id <id>', 'only commits linked to this work item id (an id, not PLM-001)'),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    group.command('get').description('show one commit, by id or SHA').argument('<commit>', COMMIT_HELP),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    await runGet(target, command);
  });

  addGlobalOptions(
    group
      .command('create')
      .description(
        'record a commit — PERMANENT: there is no commit delete. Link it to a branch ' +
          'afterwards with `scm ref create`',
      )
      .requiredOption('--sha <sha>', 'full 40-character SHA (the server validates this one)')
      .requiredOption('--message <text>', 'commit message')
      .requiredOption(
        '--committer <git-username>',
        'committer git username — unlike branch --sender this creates no platform user',
      )
      .requiredOption('--committed-at <when>', 'commit time: unix seconds or a date like 2026-08-03T09:00:00Z')
      .option('--tree-id <sha>', 'the commit tree SHA')
      .option('--added <path>', 'added file path, repeatable', collectValue)
      .option('--removed <path>', 'removed file path, repeatable', collectValue)
      .option('--modified <path>', 'modified file path, repeatable', collectValue)
      .option(
        '--work-item <identifier>',
        'work item identifier such as PLM-001, repeatable — an unknown one is silently ignored',
        collectValue,
      ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });
}

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const query: CommitListQuery = {
    ...(flags.sha === undefined ? {} : { sha: flags.sha }),
    ...(flags.workItemId === undefined ? {} : { work_item_id: flags.workItemId }),
  };

  if (paging.all) {
    const values = await collect(
      iterateCommits(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, COMMIT_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listCommits(ctx, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, COMMIT_COLUMNS, modeOf(ctx));
}

/**
 * The reference goes to the API **exactly as typed**.
 *
 * No shape check, no lowercasing, no "looks like a SHA" branch: `{commit_id_or_sha}`
 * accepts both and the server is the only thing that knows which ids exist. A
 * client-side guess here would be the id-validation the spec forbids, and it would
 * break the day a fourth id shape appears.
 */
async function runGet(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  printCommit(await getCommit(ctx, requireFlag(target, '<commit>')), ctx);
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);
  const committedAt = parseTimestampFlag(
    requireFlag(flags.committedAt, '--committed-at'),
    '--committed-at',
  );
  if (committedAt === undefined) throw new UsageError('--committed-at is required');

  // All three file arrays are required by the API even when empty, so they default to
  // `[]` rather than being omitted — a caller recording a merge with no file changes
  // should not have to pass three empty flags.
  const input: CreateCommitInput = {
    sha: requireFlag(flags.sha, '--sha'),
    message: requireFlag(flags.message, '--message'),
    committer_name: requireFlag(flags.committer, '--committer'),
    committed_at: committedAt,
    files_added: flags.added ?? [],
    files_removed: flags.removed ?? [],
    files_modified: flags.modified ?? [],
    ...(flags.treeId === undefined ? {} : { tree_id: flags.treeId }),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };

  // Nothing to resolve: a commit has no parent and every field is a literal value, so
  // there is no cached id that could be stale and no `runWrite` wrapper to justify.
  const commit = await createCommit(ctx, input);
  warnUnlinkedWorkItems(ctx, identifiers, commit.work_items);
  printCommit(commit, ctx, 'created');
}

function printCommit(commit: ScmCommit, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    commit,
    [
      ['sha', commit.sha ?? ''],
      ['id', commit.id],
      ['message', oneLine(commit.message)],
      ['committer', commit.committer_name ?? ''],
      ['committed', timestampCell(commit.committed_at)],
      ['tree', commit.tree_id ?? ''],
      ['files added', commit.files_added.join(', ')],
      ['files removed', commit.files_removed.join(', ')],
      ['files modified', commit.files_modified.join(', ')],
      ['files changed', String(commit.file_changed_count ?? '')],
      ['work items', identifiersOf(commit.work_items).join(', ')],
      ['url', commit.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${shortSha(commit.sha) || commit.id}`));
  }
}
