import type { Command } from 'commander';
import {
  createDeploy,
  getDeploy,
  iterateDeploys,
  listDeploys,
  updateDeploy,
  type CreateDeployInput,
  type DeployListQuery,
  type UpdateDeployInput,
} from '../../../api/release';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { collect } from '../../../core/paginate';
import type { Deployment } from '../../../types/api';
import { addGlobalOptions } from '../../globals';
import { errLine, paint, type Column } from '../../output';
import {
  identifiersOf,
  oneLine,
  warnUnlinkedWorkItems,
  workItemIdentifiers,
} from '../_shared/workItems';
import {
  addPagingOptions,
  collectValue,
  contextFor,
  modeOf,
  parseNumberFlag,
  parseTimestampFlag,
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
import {
  addEnvironmentOptions,
  requireEnvironmentFlag,
  resolveEnvironmentFlag,
  type EnvironmentFlags,
} from './environment';

/**
 * `pingcode release deploy …` — 部署 ([S§3.12.10]), one recorded deployment.
 *
 * The event half of the group: `release env` is configuration, this grows a row every
 * time something ships. It is organisation-level like everything else here — the
 * environment travels as `env_id` **in the body**, not in the path, so a deploy is not
 * addressed under its environment and `get` takes no `--env`.
 *
 * Four upstream behaviours the flags are shaped around, all verified live 2026-08-04
 * (design D14):
 *
 *  - **`?env_id=` is the only filter that works.** `status`, `release_name` and
 *    `work_item_id` were each probed and silently ignored, so this command exposes
 *    `--env` / `--env-id` and nothing else. A filter that appears to work and does not
 *    is worse than a missing one (design D11.2).
 *  - **an unknown environment id reads as an empty list, not an error.** `list --env-id
 *    <well-formed but unknown>` answers 200 with zero rows, so silence here does *not*
 *    distinguish "nothing deployed yet" from "no such environment". The same failure
 *    mode as `scm review list` under an unknown `--pr-id` (design D13). Passing `--env
 *    <name>` instead avoids it entirely: an unknown *name* is a resolution error (exit
 *    2) that lists the real environments.
 *  - **`release_name` is not a key.** It is free text and not unique, so — exactly like
 *    a build's number — a deploy can only be addressed by its id. `<deploy>` is
 *    therefore an id, passed through with no shape check.
 *  - **`--work-item` links can fail silently**: an unknown identifier is dropped and the
 *    call still returns 200, so every write here compares what it asked for against the
 *    response's `work_items` and warns. Exit stays 0 — the server did succeed.
 *  - **`env_id` cannot be patched, so `update` takes no `--env`.** The docs list it as an
 *    updatable field and the server accepts it — it returns 200 **and echoes the new
 *    environment in the response body** — but a subsequent `GET` still shows the original
 *    one (live 2026-08-04, verified twice through raw HTTP as well as the CLI, with and
 *    without a `status` in the same request). That is the worst shape a silent failure can
 *    take: the response itself confirms a change that did not happen, so a caller has no
 *    way to notice. A flag that never lands is the same lie as a filter that never filters
 *    (design D11.2), so it is not offered — and there is no way to move a deploy between
 *    environments at all. Record a new deploy instead; the stray one can be removed with
 *    `pingcode api DELETE /v1/release/deploys/<id> --yes`.
 *
 * `--status` is a **two-value** enum, `not_deployed | deployed`. There is no failed or
 * rolled-back state to record; a rollback is a new deploy of the previous release.
 *
 * No `replace` (design D8.4) and no `delete` leaf — but note the delete *endpoint*
 * exists and works, so `pingcode api DELETE /v1/release/deploys/<id> --yes` is the way
 * to remove one, and it is what frees an environment the server otherwise refuses to
 * delete (400 `100106`). See `release/index.ts`.
 */

/** The documented enum, quoted in `--help` and never enforced client-side. */
const STATUSES = 'not_deployed | deployed';

const DEPLOY_HELP = 'deploy record id (release_name is free text and not a key)';

const WORK_ITEM_HELP =
  'work item identifier such as PLM-001, repeatable — an unknown one is silently ignored by the API';

const TIME_HELP = 'unix seconds or a date like 2026-08-04T09:00:00Z';

type ListFlags = PagingFlags & EnvironmentFlags;

type CreateFlags = EnvironmentFlags & {
  status: string;
  releaseName: string;
  startAt: string;
  endAt: string;
  duration: string;
  releaseUrl?: string | undefined;
  workItem?: string[] | undefined;
};

/** No `EnvironmentFlags`: `env_id` is not patchable upstream — see the module note. */
type UpdateFlags = {
  status?: string | undefined;
  releaseName?: string | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
  duration?: string | undefined;
  releaseUrl?: string | undefined;
  workItem?: string[] | undefined;
};

export const DEPLOY_COLUMNS: Column<Deployment>[] = [
  { header: 'ID', value: (deploy) => deploy.id },
  { header: 'RELEASE', value: (deploy) => oneLine(deploy.release_name), flex: true },
  { header: 'ENVIRONMENT', value: (deploy) => refName(deploy.environment) },
  { header: 'STATUS', value: (deploy) => deploy.status ?? '' },
  { header: 'DURATION', value: (deploy) => durationCell(deploy.duration) },
  { header: 'WORK ITEMS', value: (deploy) => identifiersOf(deploy.work_items).join(' ') },
];

/** Seconds, with the unit, because a bare number under DURATION is ambiguous. */
function durationCell(duration: number | undefined): string {
  return duration === undefined ? '' : `${duration}s`;
}

export function registerDeployCommands(parent: Command): void {
  const group = parent
    .command('deploy')
    .description('deployment records 部署 — filterable by environment and nothing else');

  addGlobalOptions(
    addPagingOptions(
      addEnvironmentOptions(
        group
          .command('list')
          .description(
            'list deployment records — an unknown --env-id yields an EMPTY LIST, not an error',
          ),
      ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    group.command('get').description('show one deployment record').argument('<deploy>', DEPLOY_HELP),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    await runGet(target, command);
  });

  addGlobalOptions(
    addEnvironmentOptions(
      group
        .command('create')
        .description('record a deployment — six fields are required by the API, none are derived')
        .requiredOption('--status <status>', `deploy state, one of: ${STATUSES}`)
        .requiredOption('--release-name <name>', 'what was deployed, e.g. 1.4.0 (free text)')
        .requiredOption('--start-at <when>', `deploy start time: ${TIME_HELP}`)
        .requiredOption('--end-at <when>', `deploy end time: ${TIME_HELP}`)
        .requiredOption(
          '--duration <seconds>',
          'deploy duration in seconds — required by the API and never derived from ' +
            '--start-at/--end-at',
        )
        .option('--release-url <url>', 'release page; without it PingCode renders no jump link')
        .option('--work-item <identifier>', WORK_ITEM_HELP, collectValue),
    ),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  // Deliberately **not** `addEnvironmentOptions`: patching `env_id` is accepted, echoed
  // back and then not persisted (live 2026-08-04), so offering `--env` here would promise
  // a move that never happens. See the module note.
  addGlobalOptions(
    group
      .command('update')
      .description(
        'patch a deployment record — only the fields you pass are sent; the environment ' +
          'CANNOT be changed (the API accepts env_id here and silently ignores it)',
      )
      .argument('<deploy>', DEPLOY_HELP)
      .option('--status <status>', `new state, one of: ${STATUSES}`)
      .option('--release-name <name>', 'new release name')
      .option(
        '--start-at <when>',
        `new start time: ${TIME_HELP} — moving the window forward needs --end-at FIRST, ` +
          'in its own call: a new start is validated against the STORED end',
      )
      .option('--end-at <when>', `new end time: ${TIME_HELP}`)
      .option('--duration <seconds>', 'new duration in seconds')
      .option('--release-url <url>', 'new release page')
      .option(
        '--work-item <identifier>',
        `${WORK_ITEM_HELP}; REPLACES the existing links`,
        collectValue,
      ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  const environment = await resolveEnvironmentFlag(ctx, flags);
  const query: DeployListQuery =
    environment === undefined ? {} : { env_id: environment.id };

  if (paging.all) {
    const values = await collect(
      iterateDeploys(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, DEPLOY_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listDeploys(ctx, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, DEPLOY_COLUMNS, modeOf(ctx));
}

/**
 * The reference goes to the API **exactly as typed**: no shape check, and no lookup to
 * fall back on — a deploy has no name, so an id is the only thing that addresses one.
 */
async function runGet(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  printDeploy(await getDeploy(ctx, requireFlag(target, '<deploy>')), ctx);
}

/** The three numbers, parsed once for create and update. `--duration` is seconds, not a date. */
function timesFrom(flags: {
  startAt?: string | undefined;
  endAt?: string | undefined;
  duration?: string | undefined;
}): { start_at?: number; end_at?: number; duration?: number } {
  const startAt = parseTimestampFlag(flags.startAt, '--start-at');
  const endAt = parseTimestampFlag(flags.endAt, '--end-at');
  const duration = parseNumberFlag(flags.duration, '--duration');
  return {
    ...(startAt === undefined ? {} : { start_at: startAt }),
    ...(endAt === undefined ? {} : { end_at: endAt }),
    ...(duration === undefined ? {} : { duration }),
  };
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);
  const times = timesFrom(flags);
  if (times.start_at === undefined) throw new UsageError('--start-at is required');
  if (times.end_at === undefined) throw new UsageError('--end-at is required');
  if (times.duration === undefined) throw new UsageError('--duration is required');

  const fields = {
    status: requireFlag(flags.status, '--status'),
    release_name: requireFlag(flags.releaseName, '--release-name'),
    start_at: times.start_at,
    end_at: times.end_at,
    duration: times.duration,
    ...(flags.releaseUrl === undefined ? {} : { release_url: flags.releaseUrl }),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };

  // `--env <name>` resolves through the 24 h cache, so this is the one write in the
  // group that can be holding a stale id: `runWrite` re-resolves with the cache
  // bypassed and retries **once**, and only if the second pass produced a different id.
  const deploy = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<string>> => {
      const environment = await requireEnvironmentFlag(attemptCtx, flags);
      return { resolutions: [environment], value: environment.id };
    },
    async (attemptCtx, envId) => {
      const input: CreateDeployInput = { ...fields, env_id: envId };
      return await createDeploy(attemptCtx, input);
    },
  );
  warnUnlinkedWorkItems(ctx, identifiers, deploy.work_items);
  printDeploy(deploy, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);
  const deployId = requireFlag(target, '<deploy>');

  const patch: UpdateDeployInput = {
    ...(flags.status === undefined ? {} : { status: flags.status }),
    ...(flags.releaseName === undefined ? {} : { release_name: flags.releaseName }),
    ...timesFrom(flags),
    ...(flags.releaseUrl === undefined ? {} : { release_url: flags.releaseUrl }),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --status / --release-name / --start-at / --end-at / ' +
        '--duration / --release-url / --work-item. The environment is not patchable: the ' +
        'API accepts env_id, echoes it back and does not store it, so record a new deploy ' +
        'instead',
    });
  }

  // No `runWrite` here, and nothing to invalidate: every field of this patch is a literal
  // value the user typed. `create` is the one write in the group that resolves a name.
  const deploy = await updateDeploy(ctx, deployId, patch);
  warnUnlinkedWorkItems(ctx, identifiers, deploy.work_items);
  printDeploy(deploy, ctx, 'updated');
}

function printDeploy(deploy: Deployment, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    deploy,
    [
      ['release', oneLine(deploy.release_name)],
      ['id', deploy.id],
      ['environment', refName(deploy.environment)],
      ['status', deploy.status ?? ''],
      ['started', timestampCell(deploy.start_at)],
      ['ended', timestampCell(deploy.end_at)],
      ['duration', durationCell(deploy.duration)],
      ['release url', deploy.release_url ?? ''],
      ['work items', identifiersOf(deploy.work_items).join(', ')],
      ['url', deploy.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    const label = oneLine(deploy.release_name) || deploy.id;
    const where = refName(deploy.environment);
    errLine(paint.green(`${verb} ${label}${where === '' ? '' : ` → ${where}`}`));
  }
}
