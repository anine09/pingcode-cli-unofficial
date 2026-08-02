import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cacheDirPath, CONFIG_DIR_MODE, CONFIG_FILE_MODE } from './config';
import type { Ctx } from './context';
import { ENDPOINTS } from './endpoints';
import { NotFoundError, PingcodeError, UsageError, type PingcodeErrorOptions } from './errors';
import { request } from './http';
import { collect, fetchSearchPage, paginate } from './paginate';

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
  | 'user'
  // Ship (产品管理). Everything except `ship-product` is parented by a **product**
  // id, because a product's property view and state plan decide which subset of
  // the org-level metadata is valid there (ship §5).
  | 'ship-product'
  | 'ship-product-member'
  | 'ship-idea-state'
  | 'ship-idea-priority'
  | 'ship-idea-suite'
  | 'ship-idea-property'
  | 'ship-ticket-state'
  | 'ship-ticket-priority'
  | 'ship-ticket-type'
  | 'ship-ticket-channel'
  | 'ship-ticket-property'
  /** Parented by the **product** id: which plan a product uses (ship GOTCHA #23). */
  | 'ship-ticket-state-plan'
  /** Parented by the **state plan** id, never by a product (design §13.3). */
  | 'ship-ticket-state-flow'
  // Testhub (测试管理). A **library** is the parent scope here, the way a product
  // is in ship: `state_id`, `type_id`, `status_id`, the suite tree and the plan
  // list are all resolved inside one library (testhub §5).
  //
  // Two exceptions, both deliberate:
  //  - `testhub-library` is the **bootstrap** hop. It has no parent — it is what
  //    produces the `library_id` every other kind below needs — so its cache key
  //    carries no `parentId`.
  //  - `testhub-case-important-level` is genuinely **org-level**: it is the one
  //    lookup in the module with no library-scoped variant at all ([th#40]), so
  //    keying it per library would fragment one list into N identical copies.
  | 'testhub-library'
  | 'testhub-suite'
  | 'testhub-case-state'
  | 'testhub-case-type'
  | 'testhub-case-important-level'
  | 'testhub-run-status'
  | 'testhub-plan'
  | 'testhub-plan-type';

export const CACHE_TTL_MS = 24 * 3600 * 1000;

/** How many candidates an error message lists before it gives up. */
const MAX_LISTED_CANDIDATES = 20;

export type Candidate = {
  id: string;
  name: string | undefined;
  /** Extra names a user may reasonably type (username, email, display name). */
  aliases?: string[] | undefined;
  /**
   * A disambiguating label shown instead of `name` in error messages — used by
   * the suite tree, where two modules in different branches may share a name and
   * only the full path tells them apart (design §5).
   */
  path?: string | undefined;
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
  /**
   * The generalised parent for ship, where the scoping id is a **product** id
   * (states, priorities, suites, types, channels, properties) or a **state plan**
   * id (state flows). Occupies the same slot as `projectId`.
   */
  parentId?: string | undefined;
  kind: MetaKind;
  scope?: string | undefined;
};

export function cacheKeyFor(parts: CacheKeyParts): string {
  const material = JSON.stringify([
    parts.apiBase,
    parts.clientId ?? '',
    parts.parentId ?? parts.projectId ?? '',
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
    hint: failureHint(spec, candidates),
  });
}

/**
 * The candidate list is the actionable half of a failed lookup, so a resolver's
 * own `hint` is **appended** to it rather than replacing it — a `--state Nope`
 * that only explained the scoping rule, without naming a single valid state,
 * was a dead end.
 */
function failureHint(spec: ResolveSpec, candidates: Candidate[] | undefined): string {
  const available =
    candidates === undefined || candidates.length === 0
      ? `no ${spec.label}s are visible to this token`
      : `available: ${describeCandidates(candidates)}`;
  return spec.hint === undefined ? available : `${available}. ${spec.hint}`;
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
    .map((candidate) => `${candidate.path ?? candidate.name ?? '(unnamed)'} (${candidate.id})`)
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
// ship (产品管理) resolvers — design §5, §13.3
// ---------------------------------------------------------------------------

/**
 * Ship repeats pjm's shape with one substitution: the parent is a **product**,
 * not a project. `state_id`, `priority_id`, `suite_id`, `type_id`, `channel_id`,
 * the `properties` keys and the assignee candidate set are all product-scoped
 * (ship §5), so they are cached under the product id and never shared across
 * products — even though the ids frequently *look* org-global (ship GOTCHA #26).
 *
 * Ship widens the "never validate an id's shape" rule rather than narrowing it:
 * products/ideas/tickets are 24-hex, org users are 32-hex, and **property ids are
 * routinely slugs** such as `backlog_type` or `solution` (ship GOTCHA #4). Every
 * resolver below tries an exact id match first and passes the input through when
 * it already is one.
 */

/**
 * Cache key for any *parent-scoped* area resolver.
 *
 * Shared by ship (parent = a product, or a state plan for flows) and testhub
 * (parent = a library). `parentId` is omitted for the bootstrap lookups that
 * have no parent — `ship-product`, `testhub-library` — and for the genuinely
 * org-level `testhub-case-important-level`.
 */
function scopedKey(ctx: Ctx, kind: MetaKind, parentId?: string, scope?: string): string {
  return cacheKeyFor({
    apiBase: ctx.apiBase,
    clientId: ctx.credentials.clientId,
    ...(parentId === undefined ? {} : { parentId }),
    kind,
    ...(scope === undefined ? {} : { scope }),
  });
}

/**
 * `GET /v1/ship/products` searches **names only** — `identifier` is not a
 * `keywords` target (ship §5) — so the whole (small) list is loaded and the
 * identifier is matched client-side as an alias. That is what makes
 * `--product SLC` work.
 */
export async function resolveProduct(ctx: Ctx, input: string): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'ship-product',
    input,
    label: 'product',
    cacheKey: scopedKey(ctx, 'ship-product'),
    load: (c) => loadList(c, ENDPOINTS.shipProducts, {}, ['identifier']),
  });
}

function productScoped(
  kind: MetaKind,
  label: string,
  path_: string,
  hint?: string,
): (ctx: Ctx, productId: string, input: string) => Promise<ResolveResult> {
  return async (ctx, productId, input) =>
    await resolveWith(ctx, {
      kind,
      input,
      label,
      cacheKey: scopedKey(ctx, kind, productId),
      load: (c) => loadList(c, path_, { product_id: productId }),
      ...(hint === undefined ? {} : { hint }),
    });
}

export const resolveIdeaState = productScoped(
  'ship-idea-state',
  'idea state',
  ENDPOINTS.shipIdeaStates,
  'idea states are scoped to the product; unlike tickets, ship exposes no idea state-flow ' +
    'endpoint, so a transition can only be validated by the server',
);

export const resolveIdeaPriority = productScoped(
  'ship-idea-priority',
  'idea priority',
  ENDPOINTS.shipIdeaPriorities,
);

export const resolveIdeaProperty = productScoped(
  'ship-idea-property',
  'idea property',
  ENDPOINTS.shipIdeaProperties,
  'property ids are often slugs (backlog_type, identifier), never 24-hex — list them with ' +
    '`pingcode product meta idea-properties --product <p>`',
);

export const resolveTicketState = productScoped(
  'ship-ticket-state',
  'ticket state',
  ENDPOINTS.shipTicketStates,
);

export const resolveTicketPriority = productScoped(
  'ship-ticket-priority',
  'ticket priority',
  ENDPOINTS.shipTicketPriorities,
);

export const resolveTicketType = productScoped(
  'ship-ticket-type',
  'ticket type',
  ENDPOINTS.shipTicketTypes,
  'type_id is required to create a ticket — list the types with ' +
    '`pingcode product meta ticket-types --product <p>`',
);

export const resolveTicketChannel = productScoped(
  'ship-ticket-channel',
  'ticket channel',
  ENDPOINTS.shipTicketChannels,
  'the channel can only be set when the ticket is created, never patched afterwards',
);

export const resolveTicketProperty = productScoped(
  'ship-ticket-property',
  'ticket property',
  ENDPOINTS.shipTicketProperties,
  'property ids are often slugs (solution, identifier), never 24-hex — list them with ' +
    '`pingcode product meta ticket-properties --product <p>`',
);

/**
 * Requirement modules are a **tree served as a flat list** with `parent`
 * references (ship §D). Names are unique among siblings but not across the tree,
 * so each node also carries its full path (`Parent / Child`) as both an alias —
 * so a user can disambiguate by typing it — and as the label an ambiguity error
 * prints. A name collision across branches is an error listing both paths, never
 * a silent pick.
 */
export async function resolveIdeaSuite(
  ctx: Ctx,
  productId: string,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'ship-idea-suite',
    input,
    label: 'suite',
    cacheKey: scopedKey(ctx, 'ship-idea-suite', productId),
    load: (c) => loadSuiteTree(c, ENDPOINTS.shipIdeaSuites, { product_id: productId }),
    hint: 'two modules in different branches may share a name — pass the full path ("Parent / Child") or the id',
  });
}

export const SUITE_PATH_SEPARATOR = ' / ';

/**
 * Flatten a **tree served as a flat list** into resolver candidates.
 *
 * Shared by ship requirement modules (`GET /v1/ship/idea/suites?product_id=`,
 * ship §D) and testhub case modules
 * (`GET /v1/testhub/libraries/{id}/suites`, [th#9]/[th#11]) — the two are the
 * same shape and must not grow two implementations. Only the path and query
 * differ, so they are parameters.
 *
 * Both join on a **`parent` reference object**, never a `parent_id` scalar. That
 * is the whole load-bearing detail: reading the wrong field yields a forest of
 * roots, every computed path collapses to a bare name, and cross-branch
 * ambiguity silently stops being detectable.
 *
 * Names are unique among siblings but not across the tree, so each node carries
 * its full path (`Parent / Child`, computed here from the parent chain) as the
 * label an ambiguity error prints **and** as a typeable alias.
 *
 * The server's own `paths` string is deliberately **not** registered as an
 * alias. Verified live 2026-08-02 against testhub: `paths` is the *parent
 * chain, excluding the node itself* (`""` at a root), not the node's own path.
 * Registering it verbatim would alias a child to its parent's name — the child
 * `短信验证码` under root `登录` would claim the alias `登录` and make that
 * unambiguous root name an "ambiguous suite" exit 2.
 */
async function loadSuiteTree(
  ctx: Ctx,
  path_: string,
  query: Record<string, unknown>,
): Promise<Candidate[]> {
  const rows = await collect(
    paginate<unknown>(ctx, path_, query, { pageSize: 100, limit: 1000 }),
  );

  const nodes = new Map<string, { name: string | undefined; parentId: string | undefined }>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const id = str(record.id);
    if (id === undefined) continue;
    nodes.set(id, {
      name: str(record.name),
      parentId: str(refRecord(record.parent)?.id),
    });
  }

  const candidates: Candidate[] = [];
  for (const [id, node] of nodes) {
    const path = suitePath(nodes, id);
    const candidate: Candidate = { id, name: node.name, path };
    // The computed path is typeable — that is how a user resolves a collision
    // without looking up an id. A path that is just the bare name adds nothing.
    if (path !== undefined && path !== node.name) candidate.aliases = [path];
    candidates.push(candidate);
  }
  return candidates;
}

function suitePath(
  nodes: Map<string, { name: string | undefined; parentId: string | undefined }>,
  id: string,
): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = id;
  // `seen` guards against a cyclic `parent` chain, which would otherwise hang.
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const node = nodes.get(cursor);
    if (node === undefined) break;
    parts.unshift(node.name ?? '(unnamed)');
    cursor = node.parentId;
  }
  return parts.length === 0 ? undefined : parts.join(SUITE_PATH_SEPARATOR);
}

/**
 * `GET /v1/ship/products/{id}/members` returns membership rows whose `id` **is**
 * the user or group id, with no top-level `name` — the display name lives inside
 * `user` / `user_group` (ship §3.6). So this cannot go through `loadList`, whose
 * candidates read `name` off the row itself.
 */
export async function resolveProductMember(
  ctx: Ctx,
  productId: string,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'ship-product-member',
    input,
    label: 'product member',
    cacheKey: scopedKey(ctx, 'ship-product-member', productId),
    load: (c) => loadProductMembers(c, productId),
    hint: 'only members of this product can be assigned; add them in PingCode first',
  });
}

async function loadProductMembers(ctx: Ctx, productId: string): Promise<Candidate[]> {
  const rows = await collect(
    paginate<unknown>(ctx, ENDPOINTS.shipProductMembers(productId), {}, {
      pageSize: 100,
      limit: 1000,
    }),
  );

  const candidates: Candidate[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const id = str(record.id);
    if (id === undefined) continue;
    const principal = refRecord(record.user) ?? refRecord(record.user_group) ?? {};
    const name = str(principal.display_name) ?? str(principal.name) ?? str(record.name);
    const aliases: string[] = [];
    for (const key of ['name', 'username', 'email']) {
      const value = str(principal[key]);
      if (value !== undefined && value !== name) aliases.push(value);
    }
    candidates.push(aliases.length > 0 ? { id, name, aliases } : { id, name });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// ticket state plans and flows (transition pre-validation, design §13.2)
// ---------------------------------------------------------------------------

/**
 * Find the state plan a product uses — **for advisory use only**.
 *
 * The plan list has **no `?product_id=` filter** and neither the product nor the
 * ticket exposes a plan id, so the only documented route is to list every plan
 * and match the embedded `product.id` (ship GOTCHA #23, §9.11).
 *
 * The docs say to skip `product: null` rows, because `null` means "the org-level
 * template", not "this product". Live, that rule leaves nothing at all: a default
 * org has **exactly one** plan and it is that `null` row, whose flows are
 * nonetheless the ones the server enforces (`research/s7-smoke.md` F5). So after
 * failing to match a product we fall back to the lone org-default plan.
 *
 * That fallback is sound **because the answer is never authoritative**: since
 * S7b nothing refuses a transition locally, the plan is used only to *explain* a
 * rejection or to preview one under `--dry-run`. A guessed plan can therefore
 * produce a slightly-wrong suggestion inside an already-failing message, which is
 * harmless; it can no longer produce a terminal refusal, which was not
 * (design §13.2, §14.3). More than one `null` plan is ambiguous and yields
 * `undefined` rather than a coin flip.
 *
 * Returns `undefined` rather than throwing — a plan we cannot find must never
 * affect a write.
 */
export async function findTicketStatePlanId(
  ctx: Ctx,
  productId: string,
): Promise<string | undefined> {
  const key = scopedKey(ctx, 'ship-ticket-state-plan', productId);
  const cached = readCache(ctx, key);
  if (cached !== undefined) return cached[0]?.id;

  const rows = await collect(
    paginate<unknown>(ctx, ENDPOINTS.shipTicketStatePlans, {}, { pageSize: 100, limit: 1000 }),
  );

  const orgDefaults: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const planProductId = str(refRecord(record.product)?.id);
    const id = str(record.id);
    if (id === undefined) continue;
    if (planProductId === productId) {
      writeCache(ctx, key, 'ship-ticket-state-plan', [{ id, name: undefined }]);
      return id;
    }
    if (planProductId === undefined) orgDefaults.push(id);
  }

  const orgDefault = orgDefaults.length === 1 ? orgDefaults[0] : undefined;
  if (orgDefault !== undefined) {
    writeCache(ctx, key, 'ship-ticket-state-plan', [{ id: orgDefault, name: undefined }]);
    return orgDefault;
  }
  return undefined;
}

/** One legal edge of a state plan. */
export type StateFlowEdge = {
  fromId: string | undefined;
  toId: string;
  toName: string | undefined;
};

/**
 * The legal transitions of a plan, cached under the **plan** id — not the
 * product (design §13.3). Two products sharing a plan share the answer, and a
 * product whose plan changes gets a different key for free.
 */
export async function loadTicketStateFlows(
  ctx: Ctx,
  statePlanId: string,
): Promise<{ edges: StateFlowEdge[]; cacheKey: string; fromCache: boolean }> {
  const cacheKey = scopedKey(ctx, 'ship-ticket-state-flow', statePlanId);
  const cached = readCache(ctx, cacheKey);
  if (cached !== undefined) {
    return { edges: cached.map(decodeEdge), cacheKey, fromCache: true };
  }

  const rows = await collect(
    paginate<unknown>(ctx, ENDPOINTS.shipTicketStateFlows(statePlanId), {}, {
      pageSize: 100,
      limit: 1000,
    }),
  );

  const edges: StateFlowEdge[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    // The docs spell it `form_state` on state flows and `from_state` on
    // transition histories, with no example to settle it (ship GOTCHA #2).
    const from = refRecord(record.from_state) ?? refRecord(record.form_state);
    const to = refRecord(record.to_state);
    const toId = str(to?.id);
    if (toId === undefined) continue;
    edges.push({ fromId: str(from?.id), toId, toName: str(to?.name) });
  }

  writeCache(ctx, cacheKey, 'ship-ticket-state-flow', edges.map(encodeEdge));
  return { edges, cacheKey, fromCache: false };
}

/** Edges ride in the `Candidate` cache file: `id` is `from>to`, `name` is the target's name. */
function encodeEdge(edge: StateFlowEdge): Candidate {
  return { id: `${edge.fromId ?? ''}>${edge.toId}`, name: edge.toName };
}

function decodeEdge(candidate: Candidate): StateFlowEdge {
  const separator = candidate.id.indexOf('>');
  const fromId = separator <= 0 ? undefined : candidate.id.slice(0, separator);
  return { fromId, toId: candidate.id.slice(separator + 1), toName: candidate.name };
}

// ---------------------------------------------------------------------------
// idea / ticket references: id | identifier | pasted URL
// ---------------------------------------------------------------------------

export type ShipRefKind = 'idea' | 'ticket';

export type ShipLocator = {
  id: string;
  identifier: string | undefined;
  title: string | undefined;
  productId: string | undefined;
  stateId: string | undefined;
  stateName: string | undefined;
  /** Tickets only. */
  typeId: string | undefined;
  /**
   * Tickets only, and **not documented to exist**: `research/ship-api.md` §3.3
   * lists no state-plan reference on the ticket schema. It is read here under
   * the three plausible spellings anyway, because if the wire does carry one it
   * saves an O(all plans) scan — and if it does not, `findTicketStatePlanId`
   * takes over. No plan id is ever invented.
   */
  statePlanId: string | undefined;
};

/**
 * Resolve `<idea>` / `<ticket>` to a real id.
 *
 * **No ship endpoint accepts `identifier` or `short_id` as a lookup key**
 * (ship §25), so an identifier such as `SLC-1` has to go through
 * `POST …/search` — `keywords` matches identifier *or* title, so the result is
 * filtered down to an exact, case-insensitive `identifier` match afterwards.
 *
 * A pasted `html_url` ends in the `short_id`, which is not a lookup key either;
 * its trailing segment is therefore passed through as an id and will fail
 * honestly rather than being silently mangled.
 */
export async function resolveShipRef(
  ctx: Ctx,
  kind: ShipRefKind,
  input: string,
): Promise<ShipLocator> {
  const trimmed = input.trim();
  if (trimmed === '') throw new UsageError(`a ${kind} id, identifier or URL is required`);

  const value = trailingSegment(trimmed, kind);
  const searchPath = kind === 'idea' ? ENDPOINTS.shipIdeasSearch : ENDPOINTS.shipTicketsSearch;
  const detailPath = kind === 'idea' ? ENDPOINTS.shipIdea(value) : ENDPOINTS.shipTicket(value);

  if (IDENTIFIER_RE.test(value)) {
    const page = await fetchSearchPage<unknown>(
      ctx,
      searchPath,
      { keywords: value },
      { pageIndex: 0, pageSize: 20 },
    );
    const matches = page.values.filter((row) => {
      const identifier = str(refRecord(row)?.identifier);
      return identifier?.toLowerCase() === value.toLowerCase();
    });
    if (matches.length === 0) {
      throw new NotFoundError(`no ${kind} has identifier "${value}"`, {
        hint: `identifiers look like SLC-1 and are product-prefixed; ship cannot look one up directly, so this went through ${kind} search`,
      });
    }
    if (matches.length > 1) {
      const ids = matches.map((row) => shipLocatorOf(row).id).join(', ');
      throw new UsageError(`identifier "${value}" matched ${matches.length} ${kind}s: ${ids}`, {
        hint: 'pass the id instead',
      });
    }
    return shipLocatorOf(matches[0]);
  }

  const raw = await request<unknown>(ctx, { method: 'GET', path: detailPath });
  return shipLocatorOf(raw);
}

function trailingSegment(input: string, kind: ShipRefKind): string {
  if (!/^https?:\/\//i.test(input)) return input;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new UsageError(`cannot read a ${kind} reference from "${input}"`);
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (last === undefined) throw new UsageError(`cannot read a ${kind} reference from "${input}"`);
  return decodeURIComponent(last);
}

function shipLocatorOf(raw: unknown): ShipLocator {
  const record = refRecord(raw) ?? {};
  const state = refRecord(record.state);
  return {
    id: str(record.id) ?? '',
    identifier: str(record.identifier),
    title: str(record.title),
    productId: str(refRecord(record.product)?.id),
    stateId: str(state?.id),
    stateName: str(state?.name),
    typeId: str(refRecord(record.type)?.id),
    statePlanId:
      str(refRecord(record.state_plan)?.id) ??
      str(refRecord(record.ticket_state_plan)?.id) ??
      str(record.state_plan_id),
  };
}

// ---------------------------------------------------------------------------
// testhub (测试管理) resolvers — design §5
// ---------------------------------------------------------------------------

/**
 * Testhub repeats ship's shape with one substitution: the parent is a
 * **library**, not a product. `state_id`, `type_id`, `status_id`, the suite tree
 * and the plan list are all library-scoped (testhub §5), so they are cached
 * under the library id and never shared across libraries.
 *
 * Two things differ from ship and both are load-bearing:
 *
 *  - **The lookups are split across three URL shapes.** `case/states`,
 *    `case/types` and `run/statuses` are *singular*-segment config views taking
 *    `?library_id=`; `case_important_levels` is an *underscored* org-level list
 *    taking nothing; suites and plans live *under* `/libraries/{id}/…`. The
 *    factory below only covers the first shape — the other two get their own
 *    resolvers rather than a factory parameter that would obscure the split.
 *  - **The scope requirement is not uniform** (GOTCHA #2). `case/types` needs
 *    `pcp:read:testhub:testcase`, but `case/states` and `run/statuses` need
 *    `pcp:read:testhub:configuration`. A token without it cannot resolve a
 *    `state_id` or a `status_id`, and therefore cannot perform **any** run
 *    write — so those two resolvers carry a hint that names the scope, because
 *    the server's bare 403 does not.
 *
 * Ids are never shape-validated here either. Testhub ids are 24-hex, but plan
 * and case `short_id`s are 8-char base62 and users are 32-hex, so every resolver
 * tries an exact id match first and passes the input through when it already is
 * one.
 */

const CONFIGURATION_SCOPE_HINT =
  'this lookup needs the pcp:read:testhub:configuration scope — a token granted only ' +
  'testcase+testplan cannot resolve state or status ids, and therefore cannot write a run at all';

/**
 * The bootstrap hop: nothing else in testhub is reachable without a
 * `library_id`, so every testhub command resolves this first and feeds the id to
 * the resolvers below (design §5).
 *
 * `GET /v1/testhub/libraries` searches **names only** ([th#12]), exactly as ship
 * products do, so the whole (small) list is loaded and the `identifier` is
 * matched client-side as an alias. That is what makes `--library LIB` work.
 *
 * No parent, so no `parentId` in the cache key.
 */
export async function resolveTestLibrary(ctx: Ctx, input: string): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'testhub-library',
    input,
    label: 'test library',
    cacheKey: scopedKey(ctx, 'testhub-library'),
    load: (c) => loadList(c, ENDPOINTS.testhubLibraries, {}, ['identifier']),
  });
}

/** The `?library_id=`-scoped config views. Mirrors ship's `productScoped`. */
function libraryScoped(
  kind: MetaKind,
  label: string,
  path_: string,
  hint?: string,
): (ctx: Ctx, libraryId: string, input: string) => Promise<ResolveResult> {
  return async (ctx, libraryId, input) =>
    await resolveWith(ctx, {
      kind,
      input,
      label,
      cacheKey: scopedKey(ctx, kind, libraryId),
      load: (c) => loadList(c, path_, { library_id: libraryId }),
      ...(hint === undefined ? {} : { hint }),
    });
}

/** Resolves `state_id` — the only route to changing a case's state ([th#25], [th#28]). */
export const resolveCaseState = libraryScoped(
  'testhub-case-state',
  'case state',
  ENDPOINTS.testhubCaseStates,
  `${CONFIGURATION_SCOPE_HINT}. A case's state can only be changed through PATCH /cases/{id}`,
);

/** Resolves `type_id`. The one config view in this group that needs no `configuration` scope. */
export const resolveCaseType = libraryScoped(
  'testhub-case-type',
  'case type',
  ENDPOINTS.testhubCaseTypes,
);

/**
 * Resolves `status_id` — the hard prerequisite for every run write
 * ([th#57], GOTCHA #5/#10).
 *
 * These items carry **no slug**: the English slug a run reports (`pass`) and the
 * id a write needs are joined only through the localized `name` (通过), a
 * correspondence the docs never state. Tenants can add their own statuses, whose
 * names appear in no table at all — which is exactly why this is name
 * resolution against the live list rather than a hardcoded map.
 */
export const resolveRunStatus = libraryScoped(
  'testhub-run-status',
  'run status',
  ENDPOINTS.testhubRunStatuses,
  `${CONFIGURATION_SCOPE_HINT}. Run statuses have no slug field, so they resolve by their ` +
    'localized name (通过 / 受阻 / 失败 / 跳过 / 未测), and a tenant may have added its own',
);

/**
 * Resolves `important_level_id`.
 *
 * **Org-level, and deliberately not library-scoped**: this is the one lookup in
 * the module with no `?library_id=` variant anywhere ([th#40], testhub §5).
 * Keying it per library would shard one identical list into N cache entries and
 * imply a scoping the API does not have.
 */
export async function resolveCaseImportantLevel(
  ctx: Ctx,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'testhub-case-important-level',
    input,
    label: 'important level',
    cacheKey: scopedKey(ctx, 'testhub-case-important-level'),
    load: (c) => loadList(c, ENDPOINTS.testhubCaseImportantLevels, {}),
    hint: 'importance levels are organisation-wide in testhub — there is no per-library variant',
  });
}

/**
 * Case modules (模块) — a tree served flat, joined by a **`parent` reference
 * object** ([th#9], [th#11]). The row's own `paths` string is not used: verified
 * live 2026-08-02, it holds the *parent* chain excluding the node itself (`""`
 * at a root), so it is not this node's path.
 *
 * Shares `loadSuiteTree` with ship, so a name that collides across branches is
 * an ambiguity error listing both full paths, never a silent pick. The typeable
 * spelling is the computed `Parent / Child`.
 *
 * The whole tree is loaded — no `?parent_id=` filter — because resolution has to
 * see every branch to detect a collision at all.
 */
export async function resolveTestSuite(
  ctx: Ctx,
  libraryId: string,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'testhub-suite',
    input,
    label: 'suite',
    cacheKey: scopedKey(ctx, 'testhub-suite', libraryId),
    load: (c) => loadSuiteTree(c, ENDPOINTS.testhubLibrarySuites(libraryId), {}),
    hint: 'two modules in different branches may share a name — pass the full path ("Parent / Child") or the id',
  });
}

/**
 * Plans are the only testhub resource addressed **under** their library in the
 * URL, so the library id goes in the path rather than the query ([th#59]).
 *
 * `short_id` is accepted as an alias: `GET …/plans/{plan_id}` takes one
 * ([th#53]) but `bulkRuns` needs the real id in its path and PATCH is id-only
 * (GOTCHA #19), so resolving a short_id to an id here is what lets the same
 * reference work on both a read and a write.
 *
 * Plan names are unique per library ([th#47]), so a name collision means two
 * libraries, not two plans — which the library-scoped cache key already keeps
 * apart.
 */
export async function resolveTestPlan(
  ctx: Ctx,
  libraryId: string,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'testhub-plan',
    input,
    label: 'test plan',
    cacheKey: scopedKey(ctx, 'testhub-plan', libraryId),
    load: (c) => loadList(c, ENDPOINTS.testhubLibraryPlans(libraryId), {}, ['short_id']),
  });
}

/**
 * Plan types — the `type_id` that plan creation requires ([th#47], [th#60]).
 *
 * Addressed **under** the library like plans are, so the library id goes in the
 * path and the query stays empty; the `?library_id=` shape belongs to the
 * singular-segment config views, which these are not. That difference is also a
 * **scope** difference: plan types are `pcp:read:testhub:testplan`, not
 * `configuration`, so this resolver carries no configuration-scope hint — a
 * misplaced one would send a 403 investigation down the wrong path.
 *
 * A plan type has **no `kind` discriminator** (testhub §10.7), so nothing here
 * can tell the user that the type they named demands a `sprint_id` or a
 * `version_id`. Inferring it from the localized name is not an option — tenants
 * rename them — so the server's refusal is what surfaces instead.
 */
export async function resolveTestPlanType(
  ctx: Ctx,
  libraryId: string,
  input: string,
): Promise<ResolveResult> {
  return await resolveWith(ctx, {
    kind: 'testhub-plan-type',
    input,
    label: 'plan type',
    cacheKey: scopedKey(ctx, 'testhub-plan-type', libraryId),
    load: (c) => loadList(c, ENDPOINTS.testhubLibraryPlanTypes(libraryId), {}),
    hint: 'list the types configured for this library with `pingcode testhub meta plan-types --library <library>`',
  });
}

// ---------------------------------------------------------------------------
// invalidate-on-rejection
// ---------------------------------------------------------------------------

/**
 * Thrown by an `attempt` to say: *the retry would send an identical request, so
 * do not send it.* `withCacheInvalidation` answers by rethrowing the **original**
 * error untouched — nothing new went out, so there is nothing new to report.
 *
 * This is how the invariant "the CLI never sends the same mutating body twice in
 * one invocation" is enforced without asking the error what went wrong. Error
 * classification provably cannot do this job: ship returns `100702`
 * `工单状态不存在` both for a genuinely unknown state id and for a perfectly
 * existing state that the flow forbids (`research/s7-smoke.md` F5), so no code
 * allowlist can tell a stale cache from a refused transition. Whether *the id
 * changed* is a fact we own, and it is exact.
 */
export class RetryWouldBeIdentical extends Error {
  constructor() {
    super('retry skipped: re-resolution produced the same ids');
    this.name = 'RetryWouldBeIdentical';
  }
}

/**
 * Run a write that used cache-resolved ids. If the server rejects it, drop those
 * cache keys and retry **once** with the cache bypassed; if it fails again, the
 * message names the culprit — without this, a reconfigured project produces a
 * dead-end "your input is invalid" with no hint that a cache is involved
 * (design §6).
 *
 * The callback receives a context to resolve/send with: the second attempt gets
 * a `--no-cache` view. It may throw `RetryWouldBeIdentical` to abort the retry
 * before sending (see `runWrite`, which does exactly that).
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
      // Nothing was re-sent, so the original failure is the whole truth.
      if (second instanceof RetryWouldBeIdentical) throw error;
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
