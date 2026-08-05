import type { Ctx } from '../../../core/context';
import { UsageError } from '../../../core/errors';
import { parseJsonDocument, readJsonStdin, readTextFile } from '../../../core/jsonInput';
import type { ResolveResult } from '../../../core/metadata';
import { parseDateBoundaryFlag } from '../common';

/**
 * Reading the entry list for a `POST …/bulk` leaf, shared by `project sprint bulk-create`
 * and `project version bulk-create`.
 *
 * **Why a JSON document rather than repeatable flags.** Every entry of these two
 * endpoints carries its own name *and* its own date window, and a repeatable flag
 * that packs three fields into one string is a private mini-language nobody can
 * guess. A JSON array is already the shape an agent produces, and it composes with
 * `jq`. The refined leaf still earns its place over
 * `pingcode api POST /v1/pjm/sprints/bulk --body-file`, for four reasons:
 *
 *  1. **names resolve.** `project` and `assignee` may be names; the generic layer
 *     takes ids only, so the same batch would need two `pingcode resolve` calls per
 *     entry.
 *  2. **dates convert correctly.** `start` / `end` accept `YYYY-MM-DD` and get the
 *     00:00:00 / 23:59:59 boundary the server itself applies (design D15.4).
 *  3. **unknown keys are refused.** This API answers 200 and *silently drops* body
 *     fields it does not know (design D11.3), so a typo in a 60-entry batch would
 *     otherwise create 60 rows with a field missing and no complaint. That is the
 *     single most valuable thing this reader does.
 *  4. one shared `--project` / `--assignee` covers the common case where every entry
 *     wants the same ones.
 *
 * **Why `_shared/` for two callers.** `code-reuse-thinking-guide.md` puts the bar at
 * three copies, and this is two — but the two would be *identical* apart from a key
 * list, and they are being written in the same commit, which is precisely when the
 * duplication is cheapest to avoid. The same judgement `_shared/workItems.ts` was
 * created under (design D14.11). `cli/commands/common.ts` is still not touched: it
 * is the file every parallel child edits, and this helps only two leaves.
 */

/** What a caller may supply on both leaves, before per-family keys. */
const COMMON_KEYS = [
  'name',
  'start',
  'end',
  'project',
  'project_id',
  'assignee',
  'assignee_id',
  'categories',
  'category_ids',
] as const;

/** One entry as the caller wrote it, after key validation but before resolution. */
export type RawBulkEntry = {
  name: string;
  start: number;
  end: number;
  /** A name or an id, from `project`; `undefined` when the entry inherits `--project`. */
  project?: string | undefined;
  /** An id, from `project_id` — no lookup. */
  projectId?: string | undefined;
  assignee?: string | undefined;
  assigneeId?: string | undefined;
  categoryIds?: string[] | undefined;
  /** Keys this family declared beyond the common set, values verbatim. */
  extra: Record<string, unknown>;
};

export type BulkSource = { file?: string | undefined; stdin?: boolean | undefined };

/**
 * Read `--file <path>` or `--file -` into a validated entry list.
 *
 * Accepts a bare array or the wire's own `{"sprints":[…]}` / `{"versions":[…]}`
 * wrapper, so a body copied out of the docs works unchanged.
 */
export async function readBulkEntries(
  source: BulkSource,
  options: { wrapperKey: string; extraKeys: readonly string[] },
): Promise<RawBulkEntry[]> {
  const path = source.file?.trim() ?? '';
  if (path === '') {
    throw new UsageError('--file <path|-> is required', {
      hint:
        'pass a JSON array of entries, or - to read it from stdin. Each entry needs name, ' +
        'start and end; project and assignee may be shared with --project / --assignee',
    });
  }

  const document =
    path === '-'
      ? await readJsonStdin()
      : parseJsonDocument(await readTextFile(path, '--file'), `--file ${path}`);

  const list = unwrap(document, options.wrapperKey);
  if (list.length === 0) {
    // Upstream refuses an empty array too (400 `100039`), but doing it here costs no
    // request and names the flag rather than the wire field.
    throw new UsageError('--file contained no entries', {
      hint: `expected a non-empty JSON array, or {"${options.wrapperKey}": [ … ]}`,
    });
  }

  const allowed = new Set<string>([...COMMON_KEYS, ...options.extraKeys]);
  return list.map((entry, index) => readEntry(entry, index, allowed, options.extraKeys));
}

function unwrap(document: unknown, wrapperKey: string): unknown[] {
  if (Array.isArray(document)) return document;
  if (typeof document === 'object' && document !== null) {
    const wrapped = (document as Record<string, unknown>)[wrapperKey];
    if (Array.isArray(wrapped)) return wrapped;
  }
  throw new UsageError('--file must contain a JSON array of entries', {
    hint: `either [ {…}, {…} ] or {"${wrapperKey}": [ {…}, {…} ]}`,
  });
}

function readEntry(
  raw: unknown,
  index: number,
  allowed: Set<string>,
  extraKeys: readonly string[],
): RawBulkEntry {
  const at = `entry ${index}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageError(`${at} is not a JSON object`);
  }
  const record = raw as Record<string, unknown>;

  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    // The reason this check exists at all: the server would accept these and drop
    // them (design D11.3 / D15.7), so a typo is invisible without it.
    throw new UsageError(`${at} has unknown field(s): ${unknown.join(', ')}`, {
      hint: `accepted keys: ${[...allowed].sort().join(', ')} — this API silently ignores anything else, so a typo would create the row without the field`,
    });
  }

  return {
    name: requireString(record.name, `${at}.name`),
    start: parseDateBoundaryFlag(stringOrUndefined(record.start, `${at}.start`), `${at}.start`, 'start'),
    end: parseDateBoundaryFlag(stringOrUndefined(record.end, `${at}.end`), `${at}.end`, 'end'),
    ...pair(record, 'project', at),
    ...pair(record, 'assignee', at),
    ...(record.categories === undefined && record.category_ids === undefined
      ? {}
      : { categoryIds: requireStringArray(record.categories ?? record.category_ids, `${at}.categories`) }),
    extra: Object.fromEntries(
      extraKeys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]),
    ),
  };
}

/**
 * `project` / `project_id` (and the assignee pair) are mutually exclusive, exactly as
 * the `--x` / `--x-id` flags are: one resolves, one is sent verbatim.
 */
function pair(
  record: Record<string, unknown>,
  field: 'project' | 'assignee',
  at: string,
): Partial<RawBulkEntry> {
  const byName = record[field];
  const byId = record[`${field}_id`];
  if (byName !== undefined && byId !== undefined) {
    throw new UsageError(`${at} sets both ${field} and ${field}_id`, {
      hint: `use ${field} for a name to resolve, or ${field}_id for an id sent unchanged`,
    });
  }
  if (byId !== undefined) {
    return field === 'project'
      ? { projectId: requireString(byId, `${at}.${field}_id`) }
      : { assigneeId: requireString(byId, `${at}.${field}_id`) };
  }
  if (byName === undefined) return {};
  return field === 'project'
    ? { project: requireString(byName, `${at}.${field}`) }
    : { assignee: requireString(byName, `${at}.${field}`) };
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`${at} must be a non-empty string`);
  }
  return value;
}

/** `start` / `end` may arrive as a date string or as a unix-seconds **number**. */
function stringOrUndefined(value: unknown, at: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new UsageError(`${at} must be a date (2026-08-31) or a 10-digit unix seconds value`);
}

function requireStringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new UsageError(`${at} must be an array of id strings`);
  }
  return value as string[];
}

/**
 * Resolve one entry's project and assignee, falling back to the leaf's shared flags.
 *
 * Returns the ids **and** every `ResolveResult` involved, so the caller can hand them
 * to `runWrite`: a batch that used a cached project id must be able to invalidate and
 * retry exactly once, like any other write (design §6).
 */
export async function resolveBulkEntry(
  ctx: Ctx,
  entry: RawBulkEntry,
  shared: {
    project: ResolveResult | undefined;
    assignee: ResolveResult | undefined;
    resolveProject: (ctx: Ctx, input: string) => Promise<ResolveResult>;
    resolveAssignee: (ctx: Ctx, input: string) => Promise<ResolveResult>;
    at: string;
  },
): Promise<{ projectId: string; assigneeId: string; resolutions: ResolveResult[] }> {
  const resolutions: ResolveResult[] = [];

  let projectId = entry.projectId;
  if (projectId === undefined && entry.project !== undefined) {
    const resolved = await shared.resolveProject(ctx, entry.project);
    resolutions.push(resolved);
    projectId = resolved.id;
  }
  projectId ??= shared.project?.id;
  if (projectId === undefined) {
    throw new UsageError(`${shared.at} names no project`, {
      hint: 'give the entry a project / project_id, or pass --project once for the whole batch',
    });
  }

  let assigneeId = entry.assigneeId;
  if (assigneeId === undefined && entry.assignee !== undefined) {
    const resolved = await shared.resolveAssignee(ctx, entry.assignee);
    resolutions.push(resolved);
    assigneeId = resolved.id;
  }
  assigneeId ??= shared.assignee?.id;
  if (assigneeId === undefined) {
    throw new UsageError(`${shared.at} names no assignee`, {
      hint:
        'the API requires an assignee_id on every entry — give the entry an assignee / ' +
        'assignee_id, or pass --assignee once for the whole batch',
    });
  }

  return { projectId, assigneeId, resolutions };
}

/**
 * `--project` / `--assignee` resolved once for the whole batch, when given.
 *
 * The resolvers are parameters rather than imports so this file stays independent of
 * which module is calling: both planning leaves happen to use `resolveProject` and
 * `resolveUser`, but nothing here needs to know that.
 */
export async function readSharedRefs(
  ctx: Ctx,
  flags: { project?: string | undefined; assignee?: string | undefined },
  resolutions: ResolveResult[],
  resolvers: {
    project: (ctx: Ctx, input: string) => Promise<ResolveResult>;
    assignee: (ctx: Ctx, input: string) => Promise<ResolveResult>;
  },
): Promise<{ project: ResolveResult | undefined; assignee: ResolveResult | undefined }> {
  const project = flags.project === undefined ? undefined : await resolvers.project(ctx, flags.project);
  if (project !== undefined) resolutions.push(project);
  const assignee =
    flags.assignee === undefined ? undefined : await resolvers.assignee(ctx, flags.assignee);
  if (assignee !== undefined) resolutions.push(assignee);
  return { project, assignee };
}
