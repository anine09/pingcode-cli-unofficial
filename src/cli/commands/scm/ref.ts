import type { Command } from 'commander';
import {
  createCommitRef,
  getCommitRef,
  iterateCommitRefs,
  listCommitRefs,
  REF_META_TYPE_BRANCH,
  type CreateRefInput,
  type RefListQuery,
} from '../../../api/scm';
import type { Ctx } from '../../../core/context';
import { collect } from '../../../core/paginate';
import type { Ref, ScmCommitRef } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  addPagingOptions,
  contextFor,
  modeOf,
  printCollection,
  printPage,
  printResource,
  readPaging,
  refName,
  requireFlag,
  runWrite,
  timestampCell,
  type PagingFlags,
  type ResolvedWrite,
} from '../common';
import { addRepoOptions, oneLine, requireRepoScope, type RepoScope } from './branch';

/**
 * `pingcode scm ref …` — 提交引用 ([S§3.12.7]): the join record that says *this
 * commit belongs to this branch*.
 *
 * It exists because the two halves live at different scopes. A commit is
 * organisation-level (`/v1/scm/commits`, no platform in the path) while a branch is
 * repository-scoped, so nothing in the commit itself can say which branch it is on.
 * This family is that missing edge, and it is why the CI write-back order is
 * **commit → ref**: `--sha` must already name a commit (an unknown SHA is exit 5,
 * `100206`), so `scm commit create` comes first.
 *
 * Three shape facts the flags encode, all upstream:
 *
 *  - **`list` requires both `--branch-id` and a `meta_type`.** They are *required*
 *    query parameters, not filters, which means **"list every ref in this
 *    repository" is not an operation this API offers** — refs are enumerated one
 *    branch at a time. That is a limitation to state, not to paper over with a
 *    client-side loop over branches: that would be N requests against a 200/min rate
 *    limit with no atomicity, and it would invent a result set the API never
 *    promises.
 *  - **`meta_type` only accepts `branch`.** The CLI defaults it and does not expose
 *    it as a free-text flag, because there is exactly one legal value today (a
 *    `commit` value is a 400 enum rejection) — but the wire field is kept a string,
 *    so nothing here refuses a value a later server might add.
 *  - **there is no `update` and no `delete`.** A ref is permanent. Worse, deleting
 *    the *branch* it points at does not remove it: the ref keeps reading by id while
 *    `ref list` for that branch id starts answering HTTP 500 (live 2026-08-03,
 *    design D12.5). So an orphaned ref is a one-way door, which is part of why
 *    `scm branch delete` warns the way it does.
 */

const REF_HELP = 'commit ref id';

/**
 * `--branch-id` takes an **id**, not a name.
 *
 * A name would be resolvable — `scm branch` does exactly that — but here it would
 * cost a branch lookup on every ref call to save the caller a paste, and the callers
 * of this family are pipelines that already hold the branch id from
 * `scm branch create`. The honest trade is to take the id and say so; a caller with
 * only a name runs `scm branch get <name> --json` first.
 */
const BRANCH_ID_HELP = 'branch id — the referenced entity (from `scm branch list|get`)';

type ListFlags = PagingFlags & RepoFlags & { branchId: string };

type CreateFlags = RepoFlags & { sha: string; branchId: string };

type RepoFlags = Parameters<typeof requireRepoScope>[1];

export const REF_COLUMNS: Column<ScmCommitRef>[] = [
  { header: 'ID', value: (ref) => ref.id },
  { header: 'SHA', value: (ref) => shortSha(refField(ref.commit, 'sha')) },
  { header: 'MESSAGE', value: (ref) => oneLine(refField(ref.commit, 'message')), flex: true },
  { header: 'BRANCH', value: (ref) => refName(ref.meta) },
  { header: 'TYPE', value: (ref) => refField(ref.meta, 'type') ?? '' },
];

/** One extra field of an embedded reference, without widening `Ref` for every call site. */
function refField(ref: Ref | undefined, field: string): string | undefined {
  const value = ref?.[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function shortSha(sha: string | undefined): string {
  return sha === undefined ? '' : sha.slice(0, 7);
}

export function registerRefCommands(parent: Command): void {
  const group = parent
    .command('ref')
    .description('commit refs 提交引用 — the link from a commit to a branch');

  addGlobalOptions(
    addPagingOptions(
      addRepoOptions(
        group
          .command('list')
          .description('list the commit refs of ONE branch — the API offers no repository-wide list')
          .requiredOption('--branch-id <id>', BRANCH_ID_HELP),
      ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    addRepoOptions(
      group.command('get').description('show one commit ref').argument('<ref>', REF_HELP),
    ),
    { hidden: true },
  ).action(async (target: string, flags: RepoFlags, command: Command) => {
    await runGet(target, flags, command);
  });

  addGlobalOptions(
    addRepoOptions(
      group
        .command('create')
        .description(
          'link an existing commit to a branch — PERMANENT: refs have no delete, which is also ' +
            'why deleting a branch orphans them. Create the commit first',
        )
        .requiredOption('--sha <sha>', 'full SHA of a commit that already exists in PingCode')
        .requiredOption('--branch-id <id>', BRANCH_ID_HELP),
    ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });
}

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const { scope } = await requireRepoScope(ctx, flags);
  const query: RefListQuery = {
    meta_type: REF_META_TYPE_BRANCH,
    meta_id: requireFlag(flags.branchId, '--branch-id'),
  };

  if (paging.all) {
    const values = await collect(
      iterateCommitRefs(ctx, scope.platformId, scope.repositoryId, query, {
        pageSize: paging.pageSize,
        limit: paging.limit,
      }),
    );
    printCollection(values, REF_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listCommitRefs(ctx, scope.platformId, scope.repositoryId, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, REF_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, flags: RepoFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const { scope } = await requireRepoScope(ctx, flags);
  printRef(
    await getCommitRef(ctx, scope.platformId, scope.repositoryId, requireFlag(target, '<ref>')),
    ctx,
  );
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const input: CreateRefInput = {
    sha: requireFlag(flags.sha, '--sha'),
    meta_type: REF_META_TYPE_BRANCH,
    meta_id: requireFlag(flags.branchId, '--branch-id'),
  };

  const ref = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<RepoScope>> => {
      const { scope, resolutions } = await requireRepoScope(attemptCtx, flags);
      return { resolutions, value: scope };
    },
    async (attemptCtx, scope) =>
      await createCommitRef(attemptCtx, scope.platformId, scope.repositoryId, input),
  );
  printRef(ref, ctx, 'created');
}

function printRef(ref: ScmCommitRef, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    ref,
    [
      ['id', ref.id],
      ['platform', refName(ref.product)],
      ['repository', refName(ref.repository)],
      ['commit sha', refField(ref.commit, 'sha') ?? ''],
      ['commit message', oneLine(refField(ref.commit, 'message'))],
      ['committer', refField(ref.commit, 'committer_name') ?? ''],
      ['committed', timestampCell(ref.commit?.committed_at)],
      ['branch', refName(ref.meta)],
      ['branch id', ref.meta?.id ?? ''],
      ['url', ref.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    const sha = shortSha(refField(ref.commit, 'sha'));
    errLine(paint.green(`${verb} ref ${sha || ref.id} → ${refName(ref.meta)}`));
  }
}
