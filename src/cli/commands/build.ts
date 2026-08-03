import type { Command } from 'commander';
import {
  createBuild,
  deleteBuild,
  getBuild,
  iterateBuilds,
  listBuilds,
  updateBuild,
  type CreateBuildInput,
  type UpdateBuildInput,
} from '../../api/build';
import type { Ctx } from '../../core/context';
import { UsageError } from '../../core/errors';
import { collect } from '../../core/paginate';
import type { BuildRecord } from '../../types/api';
import { addGlobalOptions } from '../globals';
import { errLine, paint, type Column } from '../output';
import {
  identifiersOf,
  oneLine,
  warnUnlinkedWorkItems,
  workItemIdentifiers,
} from './_shared/workItems';
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
  requireFlag,
  timestampCell,
  type PagingFlags,
} from './common';

/**
 * `pingcode build …` — 构建记录 ([S§3.12.8]), the CI write-back surface for builds.
 *
 * One resource, five leaves, and **no parent flag anywhere**: `/v1/build/builds`
 * carries no platform, repository or project, so a build record is a free-standing
 * fact. Its only link to the rest of PingCode is `--work-item`, which is what makes a
 * build show up on a story or a bug. Same organisation-level shape as `scm commit`
 * (design D12.6), and the same consequence — nothing to resolve first.
 *
 * Group-wide facts, so no leaf repeats them:
 *
 *  - **企业令牌 only**, under `pcp:read:devops:build` / `pcp:write:devops:build` — its
 *    **own** scope pair. A token granted scm's `devops:code` cannot touch builds, and
 *    the failure is a bare 403, so the scopes are named in `--help`.
 *  - **No `replace`.** `PUT /v1/build/builds/{id}` replaces the whole record and blanks
 *    every field it is not sent; design D8.4 keeps every `PUT` in the generic layer, so
 *    a full replacement is `pingcode api PUT /v1/build/builds/<id>` and nothing else.
 *
 * Four upstream behaviours the flags are shaped around, all verified live 2026-08-04
 * (design D14) rather than read off the docs:
 *
 *  - **`build list` cannot filter. At all.** The endpoint documents no query parameter,
 *    and `?identifier=`, `?name=`, `?status=`, `?provider=` and `?work_item_id=` were
 *    each probed and *silently ignored* — every row came back every time. So this
 *    command offers paging only, and it is always a whole-organisation scan. Exposing a
 *    flag for any of them would be a filter that appears to work and does not (D11.2),
 *    which is the failure mode this CLI treats as worse than a missing feature.
 *  - **an `identifier` is not a key.** Two builds were created with `identifier:
 *    "9001"` and the API accepted both. Combined with the absent filter, that means
 *    the only way back to a build is the `id` from `build create --json` or a page
 *    walk — so `<build>` is an id, and there is no name resolution to offer.
 *  - **nothing here upserts.** Unlike scm, where `--sender` / `--owner-name` /
 *    `--creator` mint a permanent 托管平台用户 from a typo, no field in this family is a
 *    `*_name` reference. Probed for, and deliberately **not** warned about: asserting a
 *    hazard that does not exist is as wrong as omitting one that does (design D12.1).
 *  - **`--work-item` links can fail silently.** An identifier that does not exist is
 *    dropped and the call still returns 200, so the response's `work_items` is the only
 *    evidence. Every write here compares the two and warns on the difference; the exit
 *    code stays 0 because the server did succeed.
 *
 * `build delete` is the one destructive leaf. It is offered — where scm's platforms,
 * repositories, pull requests and reviews have no delete at all — because PRD R3 allows
 * one where the data is easily rebuilt, and a build record is a fact a pipeline can
 * simply write again. It is still a hard delete with no undo, so it takes `--yes` and
 * its confirmation names the build rather than echoing the id back.
 */

/** The two documented enums, quoted in `--help` and never enforced client-side. */
const PROVIDERS = 'bamboo | bitbucket | jenkins | other';
const STATUSES = 'success | failure';

const BUILD_HELP = 'build record id (not the build number — that is not unique)';

const WORK_ITEM_HELP =
  'work item identifier such as PLM-001, repeatable — an unknown one is silently ignored by the API';

const TIME_HELP = 'unix seconds or a date like 2026-08-04T09:00:00Z';

type CreateFlags = {
  name: string;
  identifier: string;
  provider: string;
  status: string;
  startAt: string;
  endAt: string;
  duration: string;
  jobUrl?: string | undefined;
  resultOverview?: string | undefined;
  resultUrl?: string | undefined;
  workItem?: string[] | undefined;
};

type UpdateFlags = {
  name?: string | undefined;
  identifier?: string | undefined;
  provider?: string | undefined;
  status?: string | undefined;
  startAt?: string | undefined;
  endAt?: string | undefined;
  duration?: string | undefined;
  jobUrl?: string | undefined;
  resultOverview?: string | undefined;
  resultUrl?: string | undefined;
  workItem?: string[] | undefined;
};

type DeleteFlags = { yes?: boolean | undefined };

export const BUILD_COLUMNS: Column<BuildRecord>[] = [
  { header: 'ID', value: (build) => build.id },
  { header: 'NUMBER', value: (build) => build.identifier ?? '' },
  { header: 'NAME', value: (build) => oneLine(build.name), flex: true },
  { header: 'PROVIDER', value: (build) => build.provider ?? '' },
  { header: 'STATUS', value: (build) => build.status ?? '' },
  { header: 'DURATION', value: (build) => durationCell(build.duration) },
  { header: 'WORK ITEMS', value: (build) => identifiersOf(build.work_items).join(' ') },
];

/** Seconds, with the unit, because a bare number in a column headed DURATION is ambiguous. */
function durationCell(duration: number | undefined): string {
  return duration === undefined ? '' : `${duration}s`;
}

export function registerBuildCommands(program: Command): void {
  const group = program
    .command('build')
    .description(
      '构建与部署 build: CI build records 构建记录 written back onto work items ' +
        '(企业令牌 only, scopes pcp:read:devops:build / pcp:write:devops:build)',
    )
    // The two verb asymmetries, where the reader is rather than only in modules/cicd.md.
    // `addHelpText` rather than a longer `.description()`: the description is what root
    // `--help` prints for the group, and growing it there would re-wrap the root listing
    // for a detail that only matters once you are inside the group.
    .addHelpText(
      'after',
      '\nBuild records are organisation-level: no --platform, no --project, and no filters on\n' +
        'list — a build reaches a work item only through --work-item.\n' +
        'There is no `replace`: PUT /v1/build/builds/{id} would blank every field it is not\n' +
        'sent, so a full replacement is `pingcode api PUT /v1/build/builds/<id>` and nothing\n' +
        'else. `delete` does exist here — the only delete in the DevOps surface besides\n' +
        '`scm branch delete` — because a pipeline can simply record the build again.\n',
    );

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description(
          'list build records — the API offers NO filters here, so this always scans ' +
            'the whole organisation',
        ),
    ),
    { hidden: true },
  ).action(async (flags: PagingFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    group.command('get').description('show one build record').argument('<build>', BUILD_HELP),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    await runGet(target, command);
  });

  addGlobalOptions(
    group
      .command('create')
      .description('record a build — seven fields are required by the API, none are derived')
      .requiredOption('--name <name>', 'build name, e.g. unit-test')
      .requiredOption(
        '--identifier <number>',
        'the build number from your CI system — NOT unique, so it cannot be looked up later',
      )
      .requiredOption('--provider <tool>', `CI tool, one of: ${PROVIDERS}`)
      .requiredOption('--status <status>', `build result, one of: ${STATUSES}`)
      .requiredOption('--start-at <when>', `build start time: ${TIME_HELP}`)
      .requiredOption('--end-at <when>', `build end time: ${TIME_HELP}`)
      .requiredOption(
        '--duration <seconds>',
        'build duration in seconds — required by the API and never derived from ' +
          '--start-at/--end-at, so report whatever your pipeline measured',
      )
      .option('--job-url <url>', 'CI job page; without it PingCode renders no jump link')
      .option('--result-overview <text>', 'short result summary, e.g. "1000 test cases pass"')
      .option('--result-url <url>', 'CI result/report page')
      .option('--work-item <identifier>', WORK_ITEM_HELP, collectValue),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    group
      .command('update')
      .description('patch a build record — only the fields you pass are sent')
      .argument('<build>', BUILD_HELP)
      .option('--name <name>', 'new build name')
      .option('--identifier <number>', 'new build number')
      .option('--provider <tool>', `new CI tool, one of: ${PROVIDERS}`)
      .option('--status <status>', `new result, one of: ${STATUSES} — this is the mid-run update`)
      .option('--start-at <when>', `new start time: ${TIME_HELP}`)
      .option('--end-at <when>', `new end time: ${TIME_HELP}`)
      .option('--duration <seconds>', 'new duration in seconds')
      .option('--job-url <url>', 'new CI job page')
      .option('--result-overview <text>', 'new result summary (replaces the old one)')
      .option('--result-url <url>', 'new CI result page')
      .option(
        '--work-item <identifier>',
        `${WORK_ITEM_HELP}; REPLACES the existing links`,
        collectValue,
      ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });

  // No `addPagingOptions` here, so `--all` is rejected by commander as an unknown
  // option (design D8.2) — asserted in `test/help/build.test.ts`.
  addGlobalOptions(
    group
      .command('delete')
      .description('delete a build record — irreversible, but a pipeline can simply record it again')
      .argument('<build>', BUILD_HELP)
      .option('--yes', 'confirm the deletion — required, and there is no undo on this API'),
    { hidden: true },
  ).action(async (target: string, flags: DeleteFlags, command: Command) => {
    await runDelete(target, flags, command);
  });
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function runList(flags: PagingFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);

  if (paging.all) {
    const values = await collect(
      iterateBuilds(ctx, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, BUILD_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listBuilds(ctx, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, BUILD_COLUMNS, modeOf(ctx));
}

/**
 * The reference goes to the API **exactly as typed**: no shape check, no "does this
 * look like a build number" branch. Ids in this API come in three shapes and validating
 * them client-side is forbidden (`quality-guidelines.md`), and here there is not even a
 * lookup to fall back on — `identifier` is not unique and the list has no filter, so an
 * id is the only thing that can address a build.
 */
async function runGet(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  printBuild(await getBuild(ctx, requireFlag(target, '<build>')), ctx);
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

/** The optional string fields, shared by create and update. */
function urlsFrom(flags: {
  jobUrl?: string | undefined;
  resultOverview?: string | undefined;
  resultUrl?: string | undefined;
}): Pick<UpdateBuildInput, 'job_url' | 'result_overview' | 'result_url'> {
  return {
    ...(flags.jobUrl === undefined ? {} : { job_url: flags.jobUrl }),
    ...(flags.resultOverview === undefined ? {} : { result_overview: flags.resultOverview }),
    ...(flags.resultUrl === undefined ? {} : { result_url: flags.resultUrl }),
  };
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);
  const times = timesFrom(flags);
  // `requiredOption` guarantees the flags are present; these three still have to be
  // *parsed*, and a value like `--duration abc` is a UsageError from the parser above.
  if (times.start_at === undefined) throw new UsageError('--start-at is required');
  if (times.end_at === undefined) throw new UsageError('--end-at is required');
  if (times.duration === undefined) throw new UsageError('--duration is required');

  const input: CreateBuildInput = {
    name: requireFlag(flags.name, '--name'),
    identifier: requireFlag(flags.identifier, '--identifier'),
    provider: requireFlag(flags.provider, '--provider'),
    status: requireFlag(flags.status, '--status'),
    start_at: times.start_at,
    end_at: times.end_at,
    duration: times.duration,
    ...urlsFrom(flags),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };

  // Nothing to resolve: a build has no parent and every field is a literal value, so
  // there is no cached id that could be stale and no `runWrite` wrapper to justify.
  // (`--work-item` sends *identifiers*, which the server resolves and never caches.)
  const build = await createBuild(ctx, input);
  warnUnlinkedWorkItems(ctx, identifiers, build.work_items);
  printBuild(build, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const identifiers = workItemIdentifiers(flags.workItem);

  const patch: UpdateBuildInput = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.identifier === undefined ? {} : { identifier: flags.identifier }),
    ...(flags.provider === undefined ? {} : { provider: flags.provider }),
    ...(flags.status === undefined ? {} : { status: flags.status }),
    ...timesFrom(flags),
    ...urlsFrom(flags),
    ...(identifiers === undefined ? {} : { work_item_identifiers: identifiers }),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint:
        'pass at least one of --name / --identifier / --provider / --status / --start-at / ' +
        '--end-at / --duration / --job-url / --result-overview / --result-url / --work-item',
    });
  }

  const build = await updateBuild(ctx, requireFlag(target, '<build>'), patch);
  warnUnlinkedWorkItems(ctx, identifiers, build.work_items);
  printBuild(build, ctx, 'updated');
}

/**
 * The `--yes` gate (design D8.1), with the build's **identity** in the confirmation.
 *
 * The read costs one request and buys the difference between "delete
 * 6a70c1eb919cce9794f01acb" and "delete build #9001 cli-smoke unit-test". Since a build
 * can only be addressed by an opaque id — there is no number lookup and no list filter
 * — echoing the id the user just pasted would prove nothing at all, which makes the
 * read worth more here than in the families that resolve a name.
 *
 * Under `--dry-run` the read still runs and the DELETE does not (the gate is in the
 * transport layer), so a dry-run delete prints the real request plan for the real
 * record.
 */
async function runDelete(target: string, flags: DeleteFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const buildId = requireFlag(target, '<build>');
  const existing = await getBuild(ctx, buildId);

  if (flags.yes !== true) {
    throw new UsageError(`refusing to delete ${describe(existing)} without --yes`, {
      hint:
        'deleting a build record cannot be undone — but unlike an scm branch it takes ' +
        'nothing else with it, and a pipeline can record the same build again. ' +
        'Re-run with --yes, or with --yes --dry-run to see the request first',
    });
  }

  printBuild(await deleteBuild(ctx, buildId), ctx, 'deleted');
}

/** `build #9001 "unit-test"`, falling back to whatever the record actually has. */
function describe(build: BuildRecord): string {
  const number = build.identifier === undefined ? '' : `#${build.identifier} `;
  const name = oneLine(build.name);
  const quoted = name === '' ? '' : `"${name}"`;
  const label = `${number}${quoted}`.trim();
  return label === '' ? `the build ${build.id}` : `the build ${label}`;
}

function printBuild(build: BuildRecord, ctx: Ctx, verb?: string): void {
  const mode = modeOf(ctx);
  printResource(
    build,
    [
      ['name', oneLine(build.name)],
      ['id', build.id],
      ['number', build.identifier ?? ''],
      ['provider', build.provider ?? ''],
      ['status', build.status ?? ''],
      ['started', timestampCell(build.start_at)],
      ['ended', timestampCell(build.end_at)],
      ['duration', durationCell(build.duration)],
      ['result', oneLine(build.result_overview)],
      ['result url', build.result_url ?? ''],
      ['job url', build.job_url ?? ''],
      ['work items', identifiersOf(build.work_items).join(', ')],
      ['url', build.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${describe(build)}`));
  }
}
