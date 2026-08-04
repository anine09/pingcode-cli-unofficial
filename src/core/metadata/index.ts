import type { Ctx } from '../context';
import { ENDPOINTS } from '../endpoints';
import { NotFoundError, UsageError } from '../errors';
import { request } from '../http';
import { fetchSearchPage } from '../paginate';
import { pathOf, specOf, type MetaKind } from './registry';
import {
  loadRows,
  readCache,
  refRecord,
  resolveKind,
  scopedKey,
  str,
  writeCache,
  type Candidate,
  type ResolveResult,
} from './resolve';

/**
 * Name→id resolution — the door every other layer imports (design §6, D4.2).
 *
 * `core/metadata.ts` used to be one 1457-line file. It is now a directory with the
 * same module specifier, so **no import anywhere changed**: `from '../../core/metadata'`
 * resolves to this `index.ts`. The split is `./registry.ts` (the `RESOLVERS` table and
 * the `MetaKind` union derived from it), `./resolve.ts` (the engine, the cache and the
 * candidate loaders), and this file: the typed public surface — the generic resolvers,
 * one line each now that the row holds what they used to repeat, plus the hand-written
 * ones that are not name→id lookups at all (design D4.3).
 *
 * Adding a lookup is a row in `./registry.ts` plus, if a command wants a typed helper,
 * one line here. `pingcode resolve <kind>` needs neither: it reads the table.
 *
 * The re-export is a **wildcard** on purpose: the hard acceptance of this refactor is
 * that no import anywhere changed, and a wildcard cannot forget a symbol the way a
 * hand-written list can.
 */
export * from './registry';
export * from './resolve';

// ---------------------------------------------------------------------------
// table-driven resolvers
// ---------------------------------------------------------------------------
//
// Each of these was 12–18 lines of cache-key arithmetic and query building. All of
// that comes from the row now, so what is left is the **signature** — which is the
// only part that ever differed, and worth keeping in the type system: a parented kind
// takes its parent id positionally, so a product id cannot be passed where a library
// id belongs.

/** A lookup with no parent scope: projects, products, libraries, users. */
type RootResolver = (ctx: Ctx, input: string) => Promise<ResolveResult>;

/** A lookup scoped by an upstream id: `(ctx, parentId, input)`. */
type ScopedResolver = (ctx: Ctx, parentId: string, input: string) => Promise<ResolveResult>;

function root(kind: MetaKind): RootResolver {
  return async (ctx, input) => await resolveKind(ctx, kind, input);
}

function scoped(kind: MetaKind): ScopedResolver {
  return async (ctx, parentId, input) => await resolveKind(ctx, kind, input, { parentId });
}

// pjm (项目管理)
export const resolveProject: RootResolver = root('project');
export const resolveWorkItemType: ScopedResolver = scoped('work_item_type');
export const resolveWorkItemPriority: ScopedResolver = scoped('work_item_priority');
export const resolveSprint: ScopedResolver = scoped('sprint');
/** 发布 — the project-scoped release plan, not a wiki revision or a config scheme. */
export const resolveProjectVersion: ScopedResolver = scoped('pjm-version');
/**
 * 工作项关联类型 — org-level, so no parent. Resolves the localized name (关联) or the
 * stable `category` slug (`relate`) to the per-tenant id that
 * `POST /v1/pjm/work_items/{id}/relations` needs. There is deliberately **no**
 * resolver for work-item tags — see the note in `registry.ts`.
 */
export const resolveRelationType: RootResolver = root('pjm-relation-type');
export const resolveUser: RootResolver = root('user');

// ship (产品管理) — the parent is a product
export const resolveProduct: RootResolver = root('ship-product');
export const resolveProductMember: ScopedResolver = scoped('ship-product-member');
export const resolveIdeaState: ScopedResolver = scoped('ship-idea-state');
export const resolveIdeaPriority: ScopedResolver = scoped('ship-idea-priority');
export const resolveIdeaSuite: ScopedResolver = scoped('ship-idea-suite');
export const resolveIdeaProperty: ScopedResolver = scoped('ship-idea-property');
export const resolveTicketState: ScopedResolver = scoped('ship-ticket-state');
export const resolveTicketPriority: ScopedResolver = scoped('ship-ticket-priority');
export const resolveTicketType: ScopedResolver = scoped('ship-ticket-type');
export const resolveTicketChannel: ScopedResolver = scoped('ship-ticket-channel');
export const resolveTicketProperty: ScopedResolver = scoped('ship-ticket-property');

// testhub (测试管理) — the parent is a library
export const resolveTestLibrary: RootResolver = root('testhub-library');
export const resolveTestSuite: ScopedResolver = scoped('testhub-suite');
export const resolveCaseState: ScopedResolver = scoped('testhub-case-state');
export const resolveCaseType: ScopedResolver = scoped('testhub-case-type');
export const resolveRunStatus: ScopedResolver = scoped('testhub-run-status');
export const resolveTestPlan: ScopedResolver = scoped('testhub-plan');
export const resolveTestPlanType: ScopedResolver = scoped('testhub-plan-type');

/**
 * The two org-level testhub lookups. Importance levels have no `?library_id=`
 * variant anywhere ([th#40]); plan states take no parameters at all, and their ids
 * are what a plan PATCH accepts as `state_id` (live 2026-08-04). Everything else in
 * the module is library-scoped.
 */
export const resolveCaseImportantLevel: RootResolver = root('testhub-case-important-level');
export const resolveTestPlanState: RootResolver = root('testhub-plan-state');

// scm (源码管理) — the parent is a hosting platform, **not** a ship product
export const resolvePlatform: RootResolver = root('scm-platform');
export const resolveRepository: ScopedResolver = scoped('scm-repo');

/**
 * release (部署) — organisation-level, so a root lookup. The one DevOps collection
 * outside scm that a name can address: environment names are unique per organisation
 * and stable, while build records and deploys have no usable name at all (see the
 * registry's `release-env` row).
 */
export const resolveEnvironment: RootResolver = root('release-env');

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
 * The one two-key lookup keeps a hand-written head: `GET /v1/pjm/work_item/states`
 * requires **both** `project_id` and `work_item_type_id` (research §4), so
 * `--state <name>` without `--type` cannot be resolved at all — a `UsageError`
 * (exit 2), not a guess. The resolution itself is the table's.
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

  return await resolveKind(ctx, 'work_item_state', input, { parentId: projectId, scope: typeId });
}

// ---------------------------------------------------------------------------
// work-item references: id | short_id | identifier | pasted URL
// ---------------------------------------------------------------------------
//
// Design D4.3: the next four functions stay hand-written, because none of them is a
// name→id lookup. They recognise a *reference form*, return a locator rather than a
// `ResolveResult`, and have their own zero/many wording. Forcing them into the
// table would only mean opening a `if (kind === 'work_item')` hole in the engine.

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

  const value = /^https?:\/\//i.test(trimmed)
    ? trailingSegment(trimmed, `cannot read a work item reference from "${input}"`)
    : trimmed;

  return IDENTIFIER_RE.test(value)
    ? { kind: 'identifier', value }
    : { kind: 'id_or_short_id', value };
}

/** The last path segment of a pasted URL, decoded. Shared by pjm and ship refs. */
function trailingSegment(input: string, failure: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new UsageError(failure);
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (last === undefined) throw new UsageError(failure);
  return decodeURIComponent(last);
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
  const record = refRecord(raw) ?? {};
  const state = refRecord(record.state);
  return {
    id: str(record.id) ?? '',
    identifier: str(record.identifier),
    shortId: str(record.short_id),
    title: str(record.title),
    projectId: str(refRecord(record.project)?.id),
    // A work item reports its `type` as a **bare slug string** (`"task"`), not as a
    // reference object — live 2026-08-04, contradicting `research/s8-smoke.md` F1,
    // which recorded the field as absent. Only `refRecord(...)?.id` was read here, so
    // the type was silently lost and `--state <name>` needed `--type` even though the
    // item had just told us. The slug *is* the `work_item_type_id` the state lookup
    // wants (system types use slugs as ids, research §6.8); a custom type reports a
    // 24-hex id here and works the same way. The object branch stays for safety.
    typeId: str(record.type) ?? str(refRecord(record.type)?.id),
    stateId: str(state?.id),
    stateName: str(state?.name),
  };
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
   * Tickets only, and **not documented to exist**: `research/ship-api.md` §3.3 lists no
   * state-plan reference on the ticket schema. Read here under the three plausible
   * spellings anyway — if the wire does carry one it saves an O(all plans) scan, and if
   * it does not, `findTicketStatePlanId` takes over. No plan id is ever invented.
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

  const value = /^https?:\/\//i.test(trimmed)
    ? trailingSegment(trimmed, `cannot read a ${kind} reference from "${input}"`)
    : trimmed;
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
// ticket state plans and flows (transition pre-validation, design §13.2)
// ---------------------------------------------------------------------------

/**
 * Find the state plan a product uses — **for advisory use only**.
 *
 * The plan list has **no `?product_id=` filter** and neither the product nor the
 * ticket exposes a plan id, so the only documented route is to list every plan and
 * match the embedded `product.id` (ship GOTCHA #23, §9.11). That is why the
 * `ship-ticket-state-plan` row is `cacheOnly`: no name resolves it, there is only an
 * answer to cache.
 *
 * The docs say to skip `product: null` rows, because `null` means "the org-level
 * template", not "this product". Live, that rule leaves nothing at all: a default org
 * has **exactly one** plan and it is that `null` row, whose flows are nonetheless the
 * ones the server enforces (`research/s7-smoke.md` F5). So after failing to match a
 * product we fall back to the lone org-default plan.
 *
 * That fallback is sound **because the answer is never authoritative**: since S7b
 * nothing refuses a transition locally, so a guessed plan can only make a suggestion
 * inside an already-failing message slightly wrong, never refuse a write (design
 * §13.2, §14.3). More than one `null` plan is ambiguous and yields `undefined` rather
 * than a coin flip, and a plan we cannot find returns `undefined` rather than throwing.
 */
export async function findTicketStatePlanId(
  ctx: Ctx,
  productId: string,
): Promise<string | undefined> {
  const kind: MetaKind = 'ship-ticket-state-plan';
  const key = scopedKey(ctx, kind, productId);
  const cached = readCache(ctx, key);
  if (cached !== undefined) return cached[0]?.id;

  const rows = await loadRows(ctx, pathOf(specOf(kind), productId), {});

  const orgDefaults: string[] = [];
  for (const row of rows) {
    const record = refRecord(row);
    if (record === undefined) continue;
    const planProductId = str(refRecord(record.product)?.id);
    const id = str(record.id);
    if (id === undefined) continue;
    if (planProductId === productId) {
      writeCache(ctx, key, kind, [{ id, name: undefined }]);
      return id;
    }
    if (planProductId === undefined) orgDefaults.push(id);
  }

  const orgDefault = orgDefaults.length === 1 ? orgDefaults[0] : undefined;
  if (orgDefault !== undefined) {
    writeCache(ctx, key, kind, [{ id: orgDefault, name: undefined }]);
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
  const kind: MetaKind = 'ship-ticket-state-flow';
  const cacheKey = scopedKey(ctx, kind, statePlanId);
  const cached = readCache(ctx, cacheKey);
  if (cached !== undefined) {
    return { edges: cached.map(decodeEdge), cacheKey, fromCache: true };
  }

  const rows = await loadRows(ctx, pathOf(specOf(kind), statePlanId), {});

  const edges: StateFlowEdge[] = [];
  for (const row of rows) {
    const record = refRecord(row);
    if (record === undefined) continue;
    // The docs spell it `form_state` on state flows and `from_state` on
    // transition histories, with no example to settle it (ship GOTCHA #2).
    const from = refRecord(record.from_state) ?? refRecord(record.form_state);
    const to = refRecord(record.to_state);
    const toId = str(to?.id);
    if (toId === undefined) continue;
    edges.push({ fromId: str(from?.id), toId, toName: str(to?.name) });
  }

  writeCache(ctx, cacheKey, kind, edges.map(encodeEdge));
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
