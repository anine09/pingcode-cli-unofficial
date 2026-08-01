import type { Command } from 'commander';
import type { Ctx } from '../../core/context';
import { UsageError } from '../../core/errors';
import {
  resolveWorkItemState,
  RetryWouldBeIdentical,
  withCacheInvalidation,
  type MetaKind,
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
 * the type is known — and the live API never reports a work item's type
 * (research/s8-smoke.md F1), so the type always comes from `--type`. Rather than
 * guessing at id shapes — which is impossible: ids are 24-hex, 32-hex for users,
 * or bare slugs for system types (research §6.8) — the two cases are separate
 * flags:
 *
 * - `--state <name>` always resolves by name and therefore requires `--type`;
 * - `--state-id <id>` is passed through verbatim, no lookup, no type needed.
 *
 * They are mutually exclusive.
 */
export async function resolveStateFlags(
  ctx: Ctx,
  flags: StateFlags,
  scope: { projectId: string; typeId?: string | undefined },
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
        'work-item states are scoped to (project, work item type), so a state name needs a type: ' +
        'pass --type <name|id>, or use --state-id <id> to send a state id unchanged',
    });
  }

  return await resolveWorkItemState(ctx, { projectId: scope.projectId, typeId, input: name });
}

// ---------------------------------------------------------------------------
// ship: state flags, search filters, --set key=value
// ---------------------------------------------------------------------------

/**
 * Ship's `--state` needs no companion flag. Unlike pjm — where states live in a
 * `(project, work item type)` pair — idea and ticket states are scoped to the
 * **product** alone (ship §J3/§K3), which `--product` or the resolved reference
 * already tells us. `--state-id` still exists as the no-lookup escape hatch.
 */
export function addShipStateOptions(command: Command, noun: string): Command {
  return command
    .option('--state <name|id>', `${noun}, resolved by name against the product's states`)
    .option('--state-id <id>', `${noun}, given as an id (sent unchanged, no lookup)`);
}

export type ShipStateResolver = (ctx: Ctx, input: string) => Promise<ResolveResult>;

/** `--state` and `--state-id` are mutually exclusive, exactly as on pjm. */
export async function resolveShipStateFlags(
  ctx: Ctx,
  flags: StateFlags,
  kind: MetaKind,
  resolve: ShipStateResolver,
): Promise<ResolveResult | undefined> {
  const name = flags.state?.trim();
  const id = flags.stateId?.trim();

  if (name !== undefined && name !== '' && id !== undefined && id !== '') {
    throw new UsageError('--state and --state-id are mutually exclusive', {
      hint: 'use --state <name> to resolve by name, or --state-id <id> to send an id unchanged',
    });
  }

  if (id !== undefined && id !== '') {
    // Pass-through: no lookup, no shape check, no cache key to invalidate.
    return { kind, input: id, id, name: undefined, fromCache: false, cacheKey: null };
  }

  if (name === undefined || name === '') return undefined;
  return await resolve(ctx, name);
}

/**
 * One entry of a ship search `filter`.
 *
 * Reference fields are addressed as `{field}.id` and accept only
 * `exists`/`in`/`nin` — there are no logical operators, and multiple entries are
 * implicitly AND-ed (ship §4). One operator per field, so a filter entry is
 * always a single-key object.
 */
export function refFilter(
  field: string,
  id: string | undefined,
): Record<string, unknown> | undefined {
  if (id === undefined || id === '') return undefined;
  return { [`${field}.id`]: { in: [id] } };
}

/** Merge the defined filter entries into one `payload.filter`. */
export function mergeFilters(
  entries: (Record<string, unknown> | undefined)[],
): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry === undefined) continue;
    Object.assign(filter, entry);
  }
  return filter;
}

/** commander accumulator for a repeatable option. */
export function collectValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export type PropertyAssignment = { key: string; value: string };

/**
 * Parse `--set key=value` (repeatable).
 *
 * The value is sent **verbatim**. For select-typed properties the API expects the
 * option's `_id`, not its display text (ship GOTCHA #5), and the docs' own
 * examples only ever show text-typed properties — which is precisely the trap.
 * `pingcode meta {idea,ticket}-properties --product <p>` lists both the keys and
 * the option ids.
 */
export function parseSetFlags(values: string[] | undefined): PropertyAssignment[] {
  const assignments: PropertyAssignment[] = [];
  for (const raw of values ?? []) {
    const separator = raw.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(`--set expects key=value, got "${raw}"`, {
        hint: 'list valid keys with `pingcode meta idea-properties --product <p>` (ticket-properties for tickets)',
      });
    }
    assignments.push({ key: raw.slice(0, separator).trim(), value: raw.slice(separator + 1) });
  }
  return assignments;
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
 *
 * The second pass only *sends* if re-resolution actually produced a different id.
 * Invariant: **the CLI never sends the same mutating body twice in one
 * invocation.** Asking "would the retry differ?" is exact and needs no knowledge
 * of vendor error codes — which is essential, because the API conflates a stale
 * id with a legitimately refused value (`research/s7-smoke.md` F5): a ticket
 * transition the state plan forbids returns the same `100702`
 * `工单状态不存在` as a state id that does not exist. Before this gate, an illegal
 * transition cost two PATCHes.
 */
export async function runWrite<R, T>(
  ctx: Ctx,
  resolve: (ctx: Ctx) => Promise<ResolvedWrite<R>>,
  send: (ctx: Ctx, value: R) => Promise<T>,
): Promise<T> {
  const first = await resolve(ctx);
  return await withCacheInvalidation(ctx, first.resolutions, async (attemptCtx) => {
    if (attemptCtx === ctx) return await send(attemptCtx, first.value);
    const second = await resolve(attemptCtx);
    if (sameResolvedIds(first.resolutions, second.resolutions)) {
      throw new RetryWouldBeIdentical();
    }
    return await send(attemptCtx, second.value);
  });
}

/** Do two resolution passes name the same ids? Order-insensitive, id-only. */
function sameResolvedIds(before: ResolveResult[], after: ResolveResult[]): boolean {
  if (before.length !== after.length) return false;
  const fingerprint = (resolutions: ResolveResult[]): string =>
    resolutions
      .map((resolution) => `${resolution.input}=>${resolution.id}`)
      .sort()
      .join('\u0000');
  return fingerprint(before) === fingerprint(after);
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
