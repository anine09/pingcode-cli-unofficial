import type { Command } from 'commander';
import {
  createEnvironment,
  getEnvironment,
  iterateEnvironments,
  listEnvironments,
  updateEnvironment,
  type EnvironmentListQuery,
  type UpdateEnvironmentInput,
} from '../../../api/release';
import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { resolveEnvironment, type ResolveResult } from '../../../core/metadata';
import { collect } from '../../../core/paginate';
import type { ReleaseEnvironment } from '../../../types/api';
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
  requireFlag,
  runWrite,
  type PagingFlags,
  type ResolvedWrite,
} from '../common';

/**
 * `pingcode release env …` — 环境 ([S§3.12.9]), **plus the `--env` plumbing
 * `release deploy` is built on**.
 *
 * An environment is the smallest resource in the CLI — `{id, url, name, html_url}` —
 * and the only *named* thing in the DevOps write-back surface outside scm. Two live
 * facts (2026-08-04) make that name a complete address, which is what the rest of this
 * group leans on:
 *
 *  - **the name is unique per organisation** (a duplicate create is 400 `100105`), and
 *  - **`?name=` on the list is an exact, case-insensitive filter that upstream really
 *    honours** — unlike the repository list's, which it ignores (design D11.2).
 *
 * So `--env production` resolves through `core/metadata` (kind `release-env`, an
 * unparented row like `scm-platform`), which is also what makes
 * `pingcode resolve release-env <name>` available for handing an `env_id` to the
 * generic layer. The resolver loads the whole list rather than using `?name=`, on
 * purpose: an exact filter cannot answer "which environments are there", so a failed
 * lookup would have no candidates to print.
 *
 * Two things this subgroup does **not** have, for two different reasons:
 *
 *  - **no `replace`** — `PUT …/environments/{id}` is excluded permanently (design
 *    D8.4); `pingcode api PUT /v1/release/environments/<id>` reaches it.
 *  - **no `delete`** — `DELETE …/environments/{id}` exists upstream and works; it is
 *    out of this task's scope, not missing. `pingcode api DELETE
 *    /v1/release/environments/<id> --yes` does it, and the server refuses while any
 *    deploy still references the environment (400 `100106`), so it cannot be orphaned.
 *
 * One asymmetry worth knowing before scripting an update: **`html_url` cannot be
 * cleared.** The server validates it as a URL and rejects `""` (400 `100003`), so a
 * link can be replaced but never removed.
 */

export const ENVIRONMENT_HELP = 'environment 环境 name or id';

export type EnvironmentFlags = { env?: string | undefined; envId?: string | undefined };

/**
 * `--env` / `--env-id`, declared here and reused by `deploy.ts`.
 *
 * Same `--x` / `--x-id` contract as scm's `--platform` and testhub's pairs: the name
 * variant resolves, the id variant is sent verbatim with no lookup and no shape check,
 * and the two are mutually exclusive. Kept in this file rather than in
 * `cli/commands/common.ts` for the reason S1a gave for `addPairOptions`: promoting a
 * two-consumer helper into the file every parallel child edits buys nothing.
 */
export function addEnvironmentOptions(command: Command): Command {
  return command
    .option('--env <name|id>', ENVIRONMENT_HELP)
    .option('--env-id <id>', 'environment id, sent unchanged with no lookup');
}

/** Resolve `--env` / `--env-id` to an id, or `undefined` when neither was given. */
export async function resolveEnvironmentFlag(
  ctx: Ctx,
  flags: EnvironmentFlags,
): Promise<ResolveResult | undefined> {
  const byName = flags.env?.trim() ?? '';
  const byId = flags.envId?.trim() ?? '';

  if (byName !== '' && byId !== '') {
    throw new UsageError('--env and --env-id are mutually exclusive', {
      hint: 'use --env <name> to resolve by name, or --env-id <id> to send an id unchanged',
    });
  }
  if (byId !== '') {
    // Pass-through: no lookup, no shape check, and no cache key to invalidate.
    return {
      kind: 'release-env',
      input: byId,
      id: byId,
      name: undefined,
      fromCache: false,
      cacheKey: null,
    };
  }
  if (byName === '') return undefined;
  return await resolveEnvironment(ctx, byName);
}

/** Every deploy write starts here: a deploy cannot exist outside an environment. */
export async function requireEnvironmentFlag(
  ctx: Ctx,
  flags: EnvironmentFlags,
): Promise<ResolveResult> {
  const environment = await resolveEnvironmentFlag(ctx, flags);
  if (environment === undefined) {
    throw new UsageError('--env <name|id> is required', {
      hint:
        'a deploy records which environment it went to, so the API requires env_id — ' +
        'list them with `pingcode release env list`, or create one with ' +
        '`pingcode release env create --name <name>`',
    });
  }
  return environment;
}

type ListFlags = PagingFlags & { name?: string | undefined };

type CreateFlags = { name: string; htmlUrl?: string | undefined };

type UpdateFlags = { name?: string | undefined; htmlUrl?: string | undefined };

export const ENVIRONMENT_COLUMNS: Column<ReleaseEnvironment>[] = [
  { header: 'ID', value: (environment) => environment.id },
  { header: 'NAME', value: (environment) => environment.name ?? '', flex: true },
  { header: 'PAGE', value: (environment) => environment.html_url ?? '', flex: true },
];

export function registerEnvironmentCommands(parent: Command): void {
  const group = parent
    .command('env')
    .description('deploy environments 环境 — names are unique per organisation');

  addGlobalOptions(
    addPagingOptions(
      group
        .command('list')
        .description('list deploy environments')
        .option(
          '--name <name>',
          'exact (case-insensitive) environment name — a real filter, but not a search',
        ),
    ),
    { hidden: true },
  ).action(async (flags: ListFlags, command: Command) => {
    await runList(flags, command);
  });

  addGlobalOptions(
    group
      .command('get')
      .description('show one environment')
      .argument('<environment>', ENVIRONMENT_HELP),
    { hidden: true },
  ).action(async (target: string, _flags: unknown, command: Command) => {
    await runGet(target, command);
  });

  addGlobalOptions(
    group
      .command('create')
      .description('create an environment (the name must be unique in the organisation)')
      .requiredOption('--name <name>', 'environment name, e.g. production')
      .option('--html-url <url>', 'environment page; without it PingCode renders no jump link'),
    { hidden: true },
  ).action(async (flags: CreateFlags, command: Command) => {
    await runCreate(flags, command);
  });

  addGlobalOptions(
    group
      .command('update')
      .description('patch an environment — only the fields you pass are sent')
      .argument('<environment>', ENVIRONMENT_HELP)
      .option('--name <name>', 'new name, unique per organisation')
      .option(
        '--html-url <url>',
        'new environment page — must be a URL, and cannot be cleared: the API rejects an empty value',
      ),
    { hidden: true },
  ).action(async (target: string, flags: UpdateFlags, command: Command) => {
    await runUpdate(target, flags, command);
  });
}

async function runList(flags: ListFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const paging = readPaging(flags);
  // The docs mark `name` required; live it is optional, and this is the call that
  // proves it — an unfiltered list is the default (design D14).
  const query: EnvironmentListQuery = flags.name === undefined ? {} : { name: flags.name };

  if (paging.all) {
    const values = await collect(
      iterateEnvironments(ctx, query, { pageSize: paging.pageSize, limit: paging.limit }),
    );
    printCollection(values, ENVIRONMENT_COLUMNS, modeOf(ctx), { all: true });
    return;
  }

  const page = await listEnvironments(ctx, query, {
    pageIndex: paging.pageIndex,
    pageSize: paging.pageSize,
  });
  printPage(page, ENVIRONMENT_COLUMNS, modeOf(ctx));
}

async function runGet(target: string, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const environment = await resolveEnvironment(ctx, requireFlag(target, '<environment>'));
  printEnvironment(await getEnvironment(ctx, environment.id), ctx);
}

async function runCreate(flags: CreateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  // Nothing to resolve: an environment has no parent, so there is no cached id that
  // could be stale and no `runWrite` wrapper to justify.
  const environment = await createEnvironment(ctx, {
    name: requireFlag(flags.name, '--name'),
    ...(flags.htmlUrl === undefined ? {} : { html_url: flags.htmlUrl }),
  });
  printEnvironment(environment, ctx, 'created');
}

async function runUpdate(target: string, flags: UpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);

  const patch: UpdateEnvironmentInput = {
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.htmlUrl === undefined ? {} : { html_url: flags.htmlUrl }),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to update: no updatable field was given', {
      hint: 'an environment has two patchable fields: pass --name or --html-url',
    });
  }

  const environment = await runWrite(
    ctx,
    async (attemptCtx): Promise<ResolvedWrite<string>> => {
      const resolved = await resolveEnvironment(attemptCtx, requireFlag(target, '<environment>'));
      return { resolutions: [resolved], value: resolved.id };
    },
    async (attemptCtx, environmentId) =>
      await updateEnvironment(attemptCtx, environmentId, patch),
  );
  printEnvironment(environment, ctx, 'updated');
}

export function printEnvironment(
  environment: ReleaseEnvironment,
  ctx: Ctx,
  verb?: string,
): void {
  const mode = modeOf(ctx);
  printResource(
    environment,
    [
      ['name', environment.name ?? ''],
      ['id', environment.id],
      ['page', environment.html_url ?? ''],
      ['url', environment.url ?? ''],
    ],
    mode,
  );
  if (!mode.json && verb !== undefined) {
    errLine(paint.green(`${verb} ${environment.name ?? environment.id}`));
  }
}
