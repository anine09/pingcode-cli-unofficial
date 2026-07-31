import type { Command } from 'commander';
import type { Ctx } from '../../core/context';
import { UsageError } from '../../core/errors';
import {
  resolveWorkItemState,
  withCacheInvalidation,
  type ResolveResult,
} from '../../core/metadata';
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  validateLimit,
  validatePageIndex,
  validatePageSize,
  type Page,
} from '../../core/paginate';
import { buildContext, readGlobalOptions, type BuiltContext } from '../globals';
import {
  errLine,
  formatTimestamp,
  outLine,
  paint,
  printJson,
  printTable,
  type Column,
  type OutputMode,
} from '../output';

/**
 * Shared plumbing for `cli/commands/*` (design §7).
 *
 * Commands are deliberately thin: they parse flags, resolve names to ids through
 * `core/metadata.ts`, call `api/*`, and render. They never build URLs and never
 * read the config file themselves — `buildContext` owns that.
 */

// ---------------------------------------------------------------------------
// context / output mode
// ---------------------------------------------------------------------------

export function contextFor(
  command: Command,
  credentials?: { clientId?: string | undefined; clientSecret?: string | undefined } | undefined,
): BuiltContext {
  const globals = readGlobalOptions(command);
  return buildContext({
    globals,
    ...(credentials === undefined ? {} : { credentials }),
    env: process.env,
  });
}

export function modeOf(ctx: Ctx): OutputMode {
  return { json: ctx.json };
}

// ---------------------------------------------------------------------------
// paging flags (design §5.1)
// ---------------------------------------------------------------------------

export type PagingFlags = {
  page?: string | undefined;
  pageSize?: string | undefined;
  all?: boolean | undefined;
  limit?: string | undefined;
};

export type Paging = {
  pageIndex: number;
  pageSize: number;
  all: boolean;
  limit: number;
};

export function addPagingOptions(command: Command): Command {
  return command
    .option('--page <n>', 'page index, 0-based', String(0))
    .option('--page-size <n>', `rows per page, 1-${MAX_PAGE_SIZE}`, String(DEFAULT_PAGE_SIZE))
    .option('--all', 'walk every page (best effort: the API guarantees no ordering)')
    .option('--limit <n>', 'stop after this many rows with --all', String(DEFAULT_LIMIT));
}

export function readPaging(flags: PagingFlags): Paging {
  return {
    pageIndex: validatePageIndex(flags.page),
    pageSize: validatePageSize(flags.pageSize),
    all: flags.all === true,
    limit: validateLimit(flags.limit),
  };
}

// ---------------------------------------------------------------------------
// value flags
// ---------------------------------------------------------------------------

/**
 * Accept a 10-digit unix **seconds** timestamp (what the API speaks, research §2)
 * or a date/date-time string. The wire format is always seconds.
 */
export function parseTimestampFlag(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') throw new UsageError(`${flag} must not be empty`);
  if (/^\d{9,11}$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new UsageError(`${flag} is not a date: "${value}"`, {
      hint: 'pass unix seconds (1730000000) or a date like 2026-01-31 / 2026-01-31T09:00:00Z',
    });
  }
  return Math.floor(ms / 1000);
}

export function parseNumberFlag(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) throw new UsageError(`${flag} must be a number: "${value}"`);
  return parsed;
}

export function requireFlag(value: string | undefined, flag: string): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') throw new UsageError(`${flag} is required`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// state selection: --state <name|id> vs --state-id <id>
// ---------------------------------------------------------------------------

export type StateFlags = {
  state?: string | undefined;
  stateId?: string | undefined;
};

export function addStateOptions(command: Command, noun: string, requires = 'requires --type'): Command {
  return command
    .option('--state <name>', `${noun}, resolved by name (${requires})`)
    .option('--state-id <id>', `${noun}, given as an id (no lookup, no --type needed)`);
}

/**
 * `GET /v1/pjm/work_item/states` needs **both** `project_id` and
 * `work_item_type_id` (research §4), so a state *name* can only be resolved when
 * the type is known. Rather than guessing at id shapes — which is impossible:
 * ids are 24-hex, 32-hex for users, or bare slugs for system types (research §6.8)
 * — the two cases are separate flags:
 *
 * - `--state <name>` always resolves by name and therefore requires a type;
 * - `--state-id <id>` is passed through verbatim, no lookup, no type needed.
 *
 * They are mutually exclusive.
 */
export async function resolveStateFlags(
  ctx: Ctx,
  flags: StateFlags,
  scope: { projectId: string; typeId?: string | undefined; typeHint?: string | undefined },
): Promise<ResolveResult | undefined> {
  const name = flags.state?.trim();
  const id = flags.stateId?.trim();

  if (name !== undefined && name !== '' && id !== undefined && id !== '') {
    throw new UsageError('--state and --state-id are mutually exclusive', {
      hint: 'use --state <name> to resolve by name, or --state-id <id> to send an id unchanged',
    });
  }

  if (id !== undefined && id !== '') {
    // Pass-through: no lookup at all, so no type is required.
    return await resolveWorkItemState(ctx, {
      projectId: scope.projectId,
      input: id,
      assumeIdWhenTypeUnknown: true,
    });
  }

  if (name === undefined || name === '') return undefined;

  const typeId = scope.typeId;
  if (typeId === undefined || typeId === '') {
    throw new UsageError('--state <name> requires --type', {
      hint:
        scope.typeHint ??
        'work-item states are scoped to (project, work item type): pass --type <name|id>, ' +
          'or use --state-id <id> to send a state id unchanged',
    });
  }

  return await resolveWorkItemState(ctx, { projectId: scope.projectId, typeId, input: name });
}

// ---------------------------------------------------------------------------
// writes that used cache-resolved ids (design §6)
// ---------------------------------------------------------------------------

export type ResolvedWrite<R> = {
  resolutions: ResolveResult[];
  value: R;
};

/**
 * Run a write whose ids came from name resolution. If the server rejects it and
 * any id came from the metadata cache, the cache key is dropped and the whole
 * resolve-then-send pass runs **once** more with the cache bypassed.
 */
export async function runWrite<R, T>(
  ctx: Ctx,
  resolve: (ctx: Ctx) => Promise<ResolvedWrite<R>>,
  send: (ctx: Ctx, value: R) => Promise<T>,
): Promise<T> {
  const first = await resolve(ctx);
  return await withCacheInvalidation(ctx, first.resolutions, async (attemptCtx) => {
    const pass = attemptCtx === ctx ? first : await resolve(attemptCtx);
    return await send(attemptCtx, pass.value);
  });
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** One page of a list endpoint. `--json` keeps the envelope's paging fields. */
export function printPage<T>(page: Page<T>, columns: Column<T>[], mode: OutputMode): void {
  if (mode.json) {
    printJson({
      page_index: page.pageIndex,
      page_size: page.pageSize,
      total: page.total,
      values: page.values,
    });
    return;
  }
  printTable(columns, page.values);
  if (page.values.length > 0) {
    errLine(paint.dim(`page ${page.pageIndex} · ${page.values.length} row(s) of ${page.total}`));
  }
}

/** A collected list (`--all`, or a config endpoint that is always small). */
export function printCollection<T>(
  values: T[],
  columns: Column<T>[],
  mode: OutputMode,
  options: { all?: boolean } = {},
): void {
  if (mode.json) {
    printJson({
      values,
      count: values.length,
      ...(options.all === true ? { all: true } : {}),
    });
    return;
  }
  printTable(columns, values);
  if (values.length > 0) errLine(paint.dim(`${values.length} row(s)`));
}

/**
 * A single resource. `--json` prints the resource verbatim (raw unix seconds and
 * all unknown fields intact); human mode prints a curated field block.
 */
export function printResource(
  resource: unknown,
  fields: [string, string][],
  mode: OutputMode,
): void {
  if (mode.json) {
    printJson(resource);
    return;
  }
  printFields(fields);
}

/** An aligned `label  value` block on stdout. Empty values are dropped. */
export function printFields(fields: [string, string][]): void {
  const shown = fields.filter(([, value]) => value !== '');
  const width = shown.reduce((max, [label]) => Math.max(max, label.length), 0);
  for (const [label, value] of shown) {
    outLine(`${paint.dim(label.padEnd(width))}  ${value}`);
  }
}

export function timestampCell(seconds: unknown): string {
  return formatTimestamp(seconds);
}

export function refName(ref: { id: string; name?: string | undefined } | undefined): string {
  if (ref === undefined) return '';
  return ref.name ?? ref.id;
}
