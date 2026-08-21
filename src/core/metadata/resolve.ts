import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cacheDirPath, CONFIG_DIR_MODE, CONFIG_FILE_MODE } from '../config';
import type { Ctx } from '../context';
import { PingcodeError, UsageError, type PingcodeErrorOptions } from '../errors';
import { collect, paginate } from '../paginate';
import { pathOf, specOf, type MetaKind, type ResolverSpec } from './registry';

/**
 * The resolution engine and its on-disk cache (design §6, D4.2).
 *
 * All resolution *semantics* live here, in exactly one copy, and are driven by the
 * rows in `./registry.ts`:
 *
 *  1. exact **id** match against the candidate list — ids pass through untouched,
 *     whatever their shape (24-hex, 32-hex users, bare slugs; research §6.8);
 *  2. **case-insensitive exact** name or alias equality — never fuzzy, because
 *     `keywords` is fuzzy and `GET /v1/pjm/projects` has no exact-name filter
 *     (research §4);
 *  3. **exactly one** match required: zero or many is a `UsageError` listing the
 *     candidates, never a silent pick of the first;
 *  4. one **cache-invalidating retry** when the miss came from a cached list;
 *  5. `passThroughWhenEmpty` for the keyword-scoped, unbounded sets.
 *
 * This module lives in `core` and therefore talks to `core/http.ts` directly (with
 * paths from `core/endpoints.ts`) rather than importing the `api` layer, which the
 * layering rule forbids.
 */

export const CACHE_TTL_MS = 24 * 3600 * 1000;

/** How many candidates an error message lists before it gives up. */
const MAX_LISTED_CANDIDATES = 20;

export type Candidate = {
  id: string;
  name: string | undefined;
  /** Extra names a user may reasonably type (username, email, display name). */
  aliases?: string[] | undefined;
  /**
   * A disambiguating label shown instead of `name` in error messages — the suite tree
   * uses it, where only the full path tells two same-named modules apart (design §5).
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
 * Cache identity (design §6) is `(apiBase, clientId, parent, kind, scope)` — two
 * `client_id`s against one host must never share a cache, because visibility depends
 * on the app's scopes, and a parent-scoped list is only valid inside its parent.
 *
 * `projectId` and `parentId` occupy the **same slot**: pjm's parent is a project,
 * ship's a product (or a state plan for flows) and testhub's a library, so the keys
 * are byte-identical whichever name a caller uses. `scope` is the extra
 * discriminator two rows need — the work-item type for states, the keywords for users.
 */
export type CacheKeyParts = {
  apiBase: string;
  clientId?: string | undefined;
  projectId?: string | undefined;
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

/**
 * The one key form every kind uses. `parentId` is simply omitted for the rows that
 * declare no `parent` (the bootstrap lookups, and the org-level importance levels).
 */
export function scopedKey(ctx: Ctx, kind: MetaKind, parentId?: string, scope?: string): string {
  return cacheKeyFor({
    apiBase: ctx.apiBase,
    clientId: ctx.credentials.clientId,
    ...(parentId === undefined ? {} : { parentId }),
    kind,
    ...(scope === undefined ? {} : { scope }),
  });
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

/** The two readers every row-shape decoder here and in `./index.ts` is built from. */
export function refRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------
// candidate loading (raw, minimal shapes — parsing lives in `api/parse.ts`)
// ---------------------------------------------------------------------------

function toCandidate(raw: unknown, aliasKeys: readonly string[] = []): Candidate | undefined {
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

/** Every row of a paged list endpoint, as raw records. */
export async function loadRows(
  ctx: Ctx,
  path_: string,
  query: Record<string, unknown>,
): Promise<unknown[]> {
  return await collect(paginate<unknown>(ctx, path_, query, { pageSize: 100, limit: 1000 }));
}

async function loadList(
  ctx: Ctx,
  path_: string,
  query: Record<string, unknown>,
  aliasKeys: readonly string[] = [],
): Promise<Candidate[]> {
  const rows = await loadRows(ctx, path_, query);
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const candidate = toCandidate(row, aliasKeys);
    if (candidate !== undefined) candidates.push(candidate);
  }
  return candidates;
}

export const SUITE_PATH_SEPARATOR = ' / ';

/**
 * Flatten a **tree served as a flat list** into resolver candidates.
 *
 * Shared by ship requirement modules (`GET /v1/ship/idea/suites?product_id=`,
 * ship §D) and testhub case modules
 * (`GET /v1/testhub/libraries/{id}/suites`, [th#9]/[th#11]) — the two are the
 * same shape and must not grow two implementations. Only the path and query
 * differ, so they come from the row.
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
 * The server's own `paths` string is deliberately **not** registered as an alias.
 * Verified live 2026-08-02 against testhub: it is the *parent chain, excluding the node
 * itself* (`""` at a root), so registering it verbatim would alias a child to its
 * parent's name — the child `短信验证码` under root `登录` would claim the alias `登录`
 * and turn that unambiguous root name into an "ambiguous suite" exit 2.
 */
async function loadSuiteTree(
  ctx: Ctx,
  path_: string,
  query: Record<string, unknown>,
): Promise<Candidate[]> {
  const rows = await loadRows(ctx, path_, query);

  const nodes = new Map<string, { name: string | undefined; parentId: string | undefined }>();
  for (const row of rows) {
    const record = refRecord(row);
    if (record === undefined) continue;
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
 * Product members: the row `id` **is** the user or group id and there is no top-level
 * `name` — it lives inside `user` / `user_group` (ship §3.6), so `toCandidate` cannot
 * read it.
 */
async function loadProductMembers(
  ctx: Ctx,
  path_: string,
  query: Record<string, unknown>,
): Promise<Candidate[]> {
  const rows = await loadRows(ctx, path_, query);

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const record = refRecord(row);
    if (record === undefined) continue;
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
// generic resolution
// ---------------------------------------------------------------------------

/** One resolution, as the engine sees it: a row's facts with the call site's filled in. */
type ResolveSpec = {
  kind: MetaKind;
  input: string;
  label: string;
  cacheKey: string | null;
  load: (ctx: Ctx) => Promise<Candidate[]>;
  passThroughWhenEmpty?: boolean;
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
// the table-driven entry point
// ---------------------------------------------------------------------------

/** `parentId` is required iff the row has a `parent`; `scope` iff it has a `scopeQuery`. */
export type ResolveKindOptions = {
  parentId?: string | undefined;
  scope?: string | undefined;
};

/**
 * Resolve `input` as one `kind`, with everything but the parent id read from the
 * registry row (design D4.2).
 *
 * This is the *whole* body of every generic resolver: the exported
 * `resolveProject` / `resolveIdeaState` / `resolveRunStatus` / … in `./index.ts`
 * are one line each on top of it, and `pingcode resolve <kind>` calls it directly
 * with a kind chosen at runtime (design D4.4). Adding a lookup is therefore a row
 * in the table, not a function.
 */
export async function resolveKind(
  ctx: Ctx,
  kind: MetaKind,
  input: string,
  options: ResolveKindOptions = {},
): Promise<ResolveResult> {
  const spec = specOf(kind);
  if (spec.cacheOnly === true) {
    // Unreachable through the typed exports; possible through `pingcode resolve`
    // only if the command surface stopped following `RESOLVABLE_KINDS`.
    throw new UsageError(`${kind} is not resolved by name`);
  }

  const parentId = options.parentId;
  const scope = options.scope;
  const trimmedInput = input.trim();
  const path_ = pathOf(spec, parentId);

  const query: Record<string, unknown> = {
    ...(spec.parentQuery === undefined || parentId === undefined
      ? {}
      : { [spec.parentQuery]: parentId }),
    ...(spec.scopeQuery === undefined || scope === undefined ? {} : { [spec.scopeQuery]: scope }),
    ...(spec.inputQuery === undefined ? {} : { [spec.inputQuery]: trimmedInput }),
  };

  // A keyword-scoped list is only valid for the keywords that fetched it, so the
  // input itself becomes the cache discriminator.
  const keyScope = spec.inputQuery === undefined ? scope : trimmedInput.toLowerCase();

  return await resolveWith(ctx, {
    kind,
    input,
    label: spec.label,
    cacheKey: scopedKey(ctx, kind, parentId, keyScope),
    load: (c) => loadCandidates(c, spec, path_, query),
    ...(spec.hint === undefined ? {} : { hint: spec.hint }),
    ...(spec.passThroughWhenEmpty === undefined
      ? {}
      : { passThroughWhenEmpty: spec.passThroughWhenEmpty }),
  });
}

/**
 * Board children (entries or swimlanes): a two-level fetch. The API has no
 * project-level list for these — `GET …/boards/{board_id}/entries` is
 * board-scoped — so the loader lists every board of the project, then lists the
 * children of each. The project id rides in `parentQuery` (`project_id`),
 * which `resolveKind` puts in the query.
 *
 * `path_` is the boards list path (the spec's `path`), and `spec.boardChildPath`
 * builds the per-board child-list path from `(projectId, boardId)`.
 */
async function loadBoardChildren(
  ctx: Ctx,
  spec: ResolverSpec,
  path_: string,
  query: Record<string, unknown>,
): Promise<Candidate[]> {
  const projectId = typeof query['project_id'] === 'string' ? query['project_id'] : undefined;
  if (projectId === undefined || spec.boardChildPath === undefined) return [];

  const boards = await loadRows(ctx, path_, {});
  const boardIds: string[] = [];
  for (const board of boards) {
    const record = refRecord(board);
    const id = str(record?.id);
    if (id !== undefined) boardIds.push(id);
  }

  const candidates: Candidate[] = [];
  for (const boardId of boardIds) {
    const childPath = spec.boardChildPath(projectId, boardId);
    const childCandidates = await loadList(ctx, childPath, {}, spec.aliases ?? []);
    candidates.push(...childCandidates);
  }
  return candidates;
}

function loadCandidates(
  ctx: Ctx,
  spec: ResolverSpec,
  path_: string,
  query: Record<string, unknown>,
): Promise<Candidate[]> {
  if (spec.load === 'suiteTree') return loadSuiteTree(ctx, path_, query);
  if (spec.load === 'productMembers') return loadProductMembers(ctx, path_, query);
  if (spec.load === 'boardChildren') return loadBoardChildren(ctx, spec, path_, query);
  return loadList(ctx, path_, query, spec.aliases ?? []);
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
      'the server rejected a write that used ids from the metadata cache; refreshing it and retrying once',
    );

    try {
      return await attempt(withoutCache(ctx));
    } catch (second) {
      // Nothing was re-sent, so the original failure is the whole truth — and
      // re-resolution proving the ids unchanged is itself the evidence that the
      // cache was never the cause. Say so, rather than leaving the warning above
      // as the last word: on a caller-input rejection (a duplicate name, a bad
      // id the user typed) it would otherwise read as a cache diagnosis.
      if (second instanceof RetryWouldBeIdentical) {
        ctx.logger.warn(
          're-resolution produced the same ids, so the metadata cache was not the cause; nothing was re-sent',
        );
        throw error;
      }
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
