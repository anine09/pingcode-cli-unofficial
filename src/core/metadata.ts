import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cacheDirPath, CONFIG_DIR_MODE, CONFIG_FILE_MODE } from './config';
import type { Ctx } from './context';
import { ENDPOINTS } from './endpoints';
import { NotFoundError, PingcodeError, UsageError, type PingcodeErrorOptions } from './errors';
import { request } from './http';
import { collect, paginate } from './paginate';

/**
 * Name→id resolution and its on-disk cache (design §6).
 *
 * Two facts drive every rule here:
 *  - most `*_id` values are **project-scoped** (research §6.13), so ids cannot be
 *    guessed or reused across projects, and
 *  - id shapes are **not uniform**: 24-hex for most resources, **32-hex for
 *    users**, and bare **slugs** (`epic`, `story`, `bug`, …) for system work-item
 *    types (research §6.8). A resolver must therefore never validate "looks like
 *    an ObjectId" — it tries an exact id match first, then name resolution.
 *
 * `keywords` is fuzzy and `GET /v1/pjm/projects` has no exact-name filter
 * (research §4), so name resolution is: query, then filter to **case-insensitive
 * exact name equality**, then require **exactly one** match. Zero or many is a
 * `UsageError` listing candidates — never silently pick the first.
 *
 * This module lives in `core` and therefore talks to `core/http.ts` directly
 * (with paths from `core/endpoints.ts`) rather than importing the `api` layer,
 * which the layering rule forbids.
 */

export type MetaKind =
  | 'project'
  | 'work_item_type'
  | 'work_item_state'
  | 'work_item_priority'
  | 'sprint'
  | 'user';

export const CACHE_TTL_MS = 24 * 3600 * 1000;

/** How many candidates an error message lists before it gives up. */
const MAX_LISTED_CANDIDATES = 20;

export type Candidate = {
  id: string;
  name: string | undefined;
  /** Extra names a user may reasonably type (username, email, display name). */
  aliases?: string[] | undefined;
};

export type ResolveResult = {
  kind: MetaKind;
  /** What the user typed. */
  input: string;
  /** The id to send to the API — passed through verbatim when the input *was* an id. */
  id: string;
  name: string | undefined;
  /** True when the id was matched against a **cached** candidate list. */
  fromCache: boolean;
  cacheKey: string | null;
};

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

/**
 * Cache identity (design §6) is `(apiBase, clientId, projectId, kind)` — two
 * `client_id`s against one host must never share a cache, because visibility
 * depends on the app's scopes.
 *
 * `scope` is an additional discriminator required for correctness: work-item
 * states depend on `work_item_type_id`, and user lookups depend on the keywords
 * used to fetch the candidate list.
 */
export type CacheKeyParts = {
  apiBase: string;
  clientId?: string | undefined;
  projectId?: string | undefined;
  kind: MetaKind;
  scope?: string | undefined;
};

export function cacheKeyFor(parts: CacheKeyParts): string {
  const material = JSON.stringify([
    parts.apiBase,
    parts.clientId ?? '',
    parts.projectId ?? '',
    parts.kind,
    parts.scope ?? '',
  ]);
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 32);
  return `${parts.kind}-${digest}`;
}

type CacheFile = {
  savedAtMs: number;
  kind: MetaKind;
  candidates: Candidate[];
};

function cacheFilePath(ctx: Ctx, key: string): string {
  return path.join(cacheDirPath(ctx.env), `${key}.json`);
}

export function readCache(ctx: Ctx, key: string): Candidate[] | undefined {
  if (!ctx.useCache) return undefined;
  let raw: string;
  try {
    raw = readFileSync(cacheFilePath(ctx, key), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: CacheFile;
  try {
    parsed = JSON.parse(raw) as CacheFile;
  } catch {
    return undefined;
  }
  if (typeof parsed.savedAtMs !== 'number' || !Array.isArray(parsed.candidates)) return undefined;
  if (ctx.now() - parsed.savedAtMs > CACHE_TTL_MS) return undefined;
  return parsed.candidates;
}

export function writeCache(ctx: Ctx, key: string, kind: MetaKind, candidates: Candidate[]): void {
  if (!ctx.useCache) return;
  const dir = cacheDirPath(ctx.env);
  try {
    mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
    const payload: CacheFile = { savedAtMs: ctx.now(), kind, candidates };
    writeFileSync(cacheFilePath(ctx, key), `${JSON.stringify(payload)}\n`, {
      mode: CONFIG_FILE_MODE,
    });
  } catch {
    // A cache we cannot write is a performance problem, never a failure.
  }
}

export function invalidateCacheKey(ctx: Ctx, key: string): void {
  try {
    rmSync(cacheFilePath(ctx, key), { force: true });
  } catch {
    // ignore
  }
}

/** Cleared by both `auth login` and `auth logout` (design §6). */
export function clearMetadataCache(ctx: Ctx): void {
  try {
    rmSync(cacheDirPath(ctx.env), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** A view of the context that ignores the on-disk cache (`--no-cache`). */
export function withoutCache(ctx: Ctx): Ctx {
  return { ...ctx, useCache: false };
}

// ---------------------------------------------------------------------------
// candidate loading (raw, minimal shapes — parsing lives in `api/parse.ts`)
// ---------------------------------------------------------------------------

function toCandidate(raw: unknown, aliasKeys: string[] = []): Candidate | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : undefined;
  if (id === undefined) return undefined;
  const name = typeof record.name === 'string' && record.name !== '' ? record.name : undefined;
  const aliases: string[] = [];
  for (const key of aliasKeys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') aliases.push(value);
  }
  return aliases.length > 0 ? { id, name, aliases } : { id, name };
}

async function loadList(
  ctx: Ctx,
  path_: string,
  query: Record<string, unknown>,
  aliasKeys: string[] = [],
): Promise<Candidate[]> {
  const rows = await collect(
    paginate<unknown>(ctx, path_, query, { pageSize: 100, limit: 1000 }),
  );
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const candidate = toCandidate(row, aliasKeys);
    if (candidate !== undefined) candidates.push(candidate);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// generic resolution
// ---------------------------------------------------------------------------

type ResolveSpec = {
  kind: MetaKind;
  input: string;
  /** Human label used in error messages, e.g. `project` or `state`. */
  label: string;
  cacheKey: string | null;
  load: (ctx: Ctx) => Promise<Candidate[]>;
  /**
   * When the candidate list was scoped by the user's own input (a `keywords`
   * search over an unbounded set), an empty result is not proof of a typo — the
   * input is then passed through verbatim as an id.
   */
  passThroughWhenEmpty?: boolean;
  /** Extra guidance appended to a failure. */
  hint?: string | undefined;
};

async function resolveWith(ctx: Ctx, spec: ResolveSpec): Promise<ResolveResult> {
  const input = spec.input.trim();
  if (input === '') {
    throw new UsageError(`${spec.label} must not be empty`);
  }

  let fromCache = false;
  let candidates: Candidate[] | undefined =
    spec.cacheKey === null ? undefined : readCache(ctx, spec.cacheKey);
  if (candidates !== undefined) fromCache = true;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (candidates === undefined) {
      candidates = await spec.load(ctx);
      if (spec.cacheKey !== null) writeCache(ctx, spec.cacheKey, spec.kind, candidates);
      fromCache = false;
    }

    // 1. Exact id — ids pass through untouched, whatever their shape.
    const byId = candidates.find((candidate) => candidate.id === input);
    if (byId !== undefined) {
      return {
        kind: spec.kind,
        input,
        id: byId.id,
        name: byId.name,
        fromCache,
        cacheKey: spec.cacheKey,
      };
    }

    // 2. Case-insensitive exact name (or alias) equality — never fuzzy.
    const matches = candidates.filter((candidate) => namesOf(candidate).includes(input.toLowerCase()));
    if (matches.length === 1) {
      const match = matches[0] as Candidate;
      return {
        kind: spec.kind,
        input,
        id: match.id,
        name: match.name,
        fromCache,
        cacheKey: spec.cacheKey,
      };
    }
    if (matches.length > 1) {
      throw new UsageError(
        `"${input}" matches ${matches.length} ${spec.label}s: ${describeCandidates(matches)}`,
        { hint: 'pass the id instead of the name' },
      );
    }

    // Nothing matched. If the list came from cache it may simply be stale.
    if (fromCache && attempt === 0) {
      if (spec.cacheKey !== null) invalidateCacheKey(ctx, spec.cacheKey);
      ctx.logger.debug(`no cached ${spec.label} matched "${input}"; refreshing the cache`);
      candidates = undefined;
      continue;
    }
    break;
  }

  if (spec.passThroughWhenEmpty === true && (candidates?.length ?? 0) === 0) {
    // Unbounded, keyword-scoped set: assume the caller gave us an id.
    return {
      kind: spec.kind,
      input,
      id: input,
      name: undefined,
      fromCache: false,
      cacheKey: spec.cacheKey,
    };
  }

  throw new UsageError(`no ${spec.label} matches "${input}"`, {
    hint:
      spec.hint ??
      (candidates === undefined || candidates.length === 0
        ? `no ${spec.label}s are visible to this token`
        : `available: ${describeCandidates(candidates)}`),
  });
}

function namesOf(candidate: Candidate): string[] {
  const names: string[] = [];
  if (candidate.name !== undefined) names.push(candidate.name.toLowerCase());
  for (const alias of candidate.aliases ?? []) names.push(alias.toLowerCase());
  return names;
}

function describeCandidates(candidates: Candidate[]): string {
  const shown = candidates
    .slice(0, MAX_LISTED_CANDIDATES)
    .map((candidate) => `${candidate.name ?? '(unnamed)'} (${candidate.id})`)
    .join(', ');
  return candidates.length > MAX_LISTED_CANDIDATES
    ? `${shown}, … ${candidates.length - MAX_LISTED_CANDIDATES} more`
    : shown;
}

// ---------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------

export async function resolveProject(ctx: Ctx, input: string): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'project',
    input,
    label: 'project',
    cacheKey: cacheKeyFor({
      apiBase: ctx.apiBase,
      clientId: ctx.credentials.clientId,
      kind: 'project',
    }),
    load: (c) => loadList(c, ENDPOINTS.projects, {}, ['identifier']),
  });
}

export async function resolveWorkItemType(
  ctx: Ctx,
  projectId: string,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'work_item_type',
    input,
    label: 'work item type',
    cacheKey: cacheKeyFor({
      apiBase: ctx.apiBase,
      clientId: ctx.credentials.clientId,
      projectId,
      kind: 'work_item_type',
    }),
    load: (c) => loadList(c, ENDPOINTS.workItemTypes, { project_id: projectId }),
  });
}

export type ResolveStateOptions = {
  projectId: string;
  /** Required to resolve a **name**; states live in the type's state scheme. */
  typeId?: string | undefined;
  input: string;
  /**
   * Escape hatch for callers that know the value is already an id and cannot
   * supply a type. Off by default so a name without `--type` is exit 2.
   */
  assumeIdWhenTypeUnknown?: boolean | undefined;
};

/**
 * `GET /v1/pjm/work_item/states` requires **both** `project_id` and
 * `work_item_type_id` (research §4), so `--state <name>` without `--type` cannot
 * be resolved at all — that is a `UsageError` (exit 2), not a guess.
 */
export async function resolveWorkItemState(
  ctx: Ctx,
  options: ResolveStateOptions,
): Promise<ResolveResult> {
  const { projectId, typeId, input } = options;
  if (typeId === undefined || typeId === '') {
    if (options.assumeIdWhenTypeUnknown === true) {
      return {
        kind: 'work_item_state',
        input,
        id: input.trim(),
        name: undefined,
        fromCache: false,
        cacheKey: null,
      };
    }
    throw new UsageError('resolving a state requires --type', {
      hint:
        'work-item states are scoped to (project, work item type): ' +
        'GET /v1/pjm/work_item/states needs both project_id and work_item_type_id',
    });
  }

  return await resolveWith(ctx, {
    kind: 'work_item_state',
    input,
    label: 'state',
    cacheKey: cacheKeyFor({
      apiBase: ctx.apiBase,
      clientId: ctx.credentials.clientId,
      projectId,
      kind: 'work_item_state',
      scope: typeId,
    }),
    load: (c) =>
      loadList(c, ENDPOINTS.workItemStates, {
        project_id: projectId,
        work_item_type_id: typeId,
      }),
    hint: 'state changes are workflow-validated: the state must belong to this type\'s state scheme',
  });
}

export async function resolveWorkItemPriority(
  ctx: Ctx,
  projectId: string,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'work_item_priority',
    input,
    label: 'priority',
    cacheKey: cacheKeyFor({
      apiBase: ctx.apiBase,
      clientId: ctx.credentials.clientId,
      projectId,
      kind: 'work_item_priority',
    }),
    load: (c) => loadList(c, ENDPOINTS.workItemPriorities, { project_id: projectId }),
  });
}

export async function resolveSprint(
  ctx: Ctx,
  projectId: string,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'sprint',
    input,
    label: 'sprint',
    cacheKey: cacheKeyFor({
      apiBase: ctx.apiBase,
      clientId: ctx.credentials.clientId,
      projectId,
      kind: 'sprint',
    }),
    load: (c) => loadList(c, ENDPOINTS.projectSprints(projectId), {}),
    hint: 'sprints only exist for scrum/hybrid projects (research §6.14)',
  });
}

/**
 * Users are an unbounded set, so the candidate list is a `keywords` search over
 * the input. The cache key includes those keywords; an empty result means the
 * input is treated as an id (32-char hex — but never validated as such).
 */
export async function resolveUser(ctx: Ctx, input: string): Promise<ResolveResult> {
  const keywords = input.trim();
  return await resolveWith(ctx, {
    kind: 'user',
    input,
    label: 'user',
    cacheKey: cacheKeyFor({
      apiBase: ctx.apiBase,
      clientId: ctx.credentials.clientId,
      kind: 'user',
      scope: keywords.toLowerCase(),
    }),
    load: (c) =>
      loadList(c, ENDPOINTS.users, { keywords }, ['display_name', 'username', 'email']),
    passThroughWhenEmpty: true,
  });
}

// ---------------------------------------------------------------------------
// work-item references: id | short_id | identifier | pasted URL
// ---------------------------------------------------------------------------

export type WorkItemRef =
  | { kind: 'id_or_short_id'; value: string }
  | { kind: 'identifier'; value: string };

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * `GET /v1/pjm/work_items/{id}` accepts **`id` or `short_id`** (research §6.9),
 * so we also accept a pasted `html_url` (its last segment is the `short_id`) and
 * an `identifier` like `SCR-5` — the form humans and agents actually see (R2.2).
 */
export function parseWorkItemRef(input: string): WorkItemRef {
  const trimmed = input.trim();
  if (trimmed === '') throw new UsageError('a work item id, identifier or URL is required');

  let value = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new UsageError(`cannot read a work item reference from "${input}"`);
    }
    const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
    const last = segments[segments.length - 1];
    if (last === undefined) {
      throw new UsageError(`cannot read a work item reference from "${input}"`);
    }
    value = decodeURIComponent(last);
  }

  return IDENTIFIER_RE.test(value)
    ? { kind: 'identifier', value }
    : { kind: 'id_or_short_id', value };
}

export type WorkItemLocator = {
  id: string;
  identifier: string | undefined;
  shortId: string | undefined;
  title: string | undefined;
  projectId: string | undefined;
  typeId: string | undefined;
  stateId: string | undefined;
  stateName: string | undefined;
};

/**
 * Resolve any accepted reference to a real `id`. `PATCH`/`DELETE` document only
 * `id` (research §6.9), so mutating commands go through here with one `GET`
 * first — which also hands back the `project.id` / `type.id` that a state
 * transition needs (design §7.1).
 */
export async function resolveWorkItem(ctx: Ctx, input: string): Promise<WorkItemLocator> {
  const ref = parseWorkItemRef(input);

  if (ref.kind === 'identifier') {
    const envelope = await request<{ values?: unknown } | undefined>(ctx, {
      method: 'GET',
      path: ENDPOINTS.workItems,
      query: { identifier: ref.value, page_index: 0, page_size: 10 },
    });
    const rows = Array.isArray(envelope?.values) ? (envelope?.values as unknown[]) : [];
    if (rows.length === 0) {
      throw new NotFoundError(`no work item has identifier "${ref.value}"`, {
        hint: 'identifiers look like SCR-5 and are project-prefixed',
      });
    }
    if (rows.length > 1) {
      const ids = rows.map((row) => locatorOf(row).id).join(', ');
      throw new UsageError(`identifier "${ref.value}" matched ${rows.length} work items: ${ids}`, {
        hint: 'pass the id instead',
      });
    }
    return locatorOf(rows[0]);
  }

  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.workItem(ref.value),
  });
  return locatorOf(raw);
}

function locatorOf(raw: unknown): WorkItemLocator {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const state = refRecord(record.state);
  return {
    id: str(record.id) ?? '',
    identifier: str(record.identifier),
    shortId: str(record.short_id),
    title: str(record.title),
    projectId: str(refRecord(record.project)?.id),
    typeId: str(refRecord(record.type)?.id),
    stateId: str(state?.id),
    stateName: str(state?.name),
  };
}

function refRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------
// invalidate-on-rejection
// ---------------------------------------------------------------------------

/**
 * Run a write that used cache-resolved ids. If the server rejects it, drop those
 * cache keys and retry **once** with the cache bypassed; if it fails again, the
 * message names the culprit — without this, a reconfigured project produces a
 * dead-end "your input is invalid" with no hint that a cache is involved
 * (design §6).
 *
 * The callback receives a context to resolve/send with: the second attempt gets
 * a `--no-cache` view.
 */
export async function withCacheInvalidation<T>(
  ctx: Ctx,
  resolutions: ResolveResult[],
  attempt: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(ctx);
  } catch (error) {
    const cached = resolutions.filter(
      (resolution) => resolution.fromCache && resolution.cacheKey !== null,
    );
    if (cached.length === 0 || !looksLikeStaleId(error)) throw error;

    for (const resolution of cached) {
      if (resolution.cacheKey !== null) invalidateCacheKey(ctx, resolution.cacheKey);
    }
    ctx.logger.warn(
      'the server rejected an id that came from the metadata cache; refreshing it and retrying once',
    );

    try {
      return await attempt(withoutCache(ctx));
    } catch (second) {
      throw annotateWithCacheCulprits(second, cached);
    }
  }
}

function looksLikeStaleId(error: unknown): boolean {
  if (!(error instanceof PingcodeError)) return false;
  return error.kind === 'api' || error.kind === 'not_found';
}

function annotateWithCacheCulprits(error: unknown, cached: ResolveResult[]): unknown {
  if (!(error instanceof PingcodeError)) return error;
  const culprits = cached
    .map((resolution) => `resolved "${resolution.input}" → ${resolution.id} from cache`)
    .join('; ');
  const Ctor = error.constructor as new (
    message: string,
    options?: PingcodeErrorOptions,
  ) => PingcodeError;
  return new Ctor(`${error.message} (${culprits})`, {
    code: error.code,
    status: error.status,
    hint: 'the cache was refreshed and the write still failed — re-run with --no-cache to confirm, then check the project configuration',
    cause: error,
  });
}
