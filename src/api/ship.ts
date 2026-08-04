import type { Ctx } from '../core/context';
import { ENDPOINTS } from '../core/endpoints';
import { request } from '../core/http';
import type {
  Page,
  PageRequest,
  PaginateOptions,
  SearchPayload,
} from '../core/paginate';
import type {
  ShipChannel,
  ShipIdea,
  ShipIdeaTransitionHistory,
  ShipPlan,
  ShipPlanSummary,
  ShipPriority,
  ShipProduct,
  ShipProductMember,
  ShipProperty,
  ShipState,
  ShipStateFlow,
  ShipStatePlan,
  ShipSuite,
  ShipTicket,
  ShipTicketType,
} from '../types/api';
import {
  compact,
  fetchPageOf,
  fetchSearchPageOf,
  iterateOf,
  iterateSearchOf,
  listAllOf,
  parseShipChannel,
  parseShipIdea,
  parseShipIdeaTransitionHistory,
  parseShipPlan,
  parseShipPlanSummary,
  parseShipPriority,
  parseShipProduct,
  parseShipProductMember,
  parseShipProperty,
  parseShipState,
  parseShipStateFlow,
  parseShipStatePlan,
  parseShipSuite,
  parseShipTicket,
  parseShipTicketType,
} from './parse';

/**
 * `/v1/ship/**` — the Ship (产品管理) surface: products, ideas (需求) and tickets
 * (工单), plus the product-scoped metadata every write needs (ship §A/§J/§K).
 *
 * Three facts shape this file:
 *
 *  - **Search is the read path.** `GET /v1/ship/{ideas,tickets}` exists but has no
 *    assignee, date or custom-property filter, so the CLI only ever calls
 *    `POST …/search` (PRD D2/D10). There is no second, weaker code path.
 *  - **Everything is product-scoped.** `state_id`, `priority_id`, `suite_id`,
 *    `type_id`, `channel_id`, the `properties` keys and the assignee candidate
 *    set are all resolved per product, never per org (ship §5).
 *  - **Nothing here formats or resolves.** Names become ids in
 *    `core/metadata.ts`; rendering happens in `cli/`.
 *
 * There is **no DELETE for any ship business object** (ship GOTCHA #17), so no
 * delete wrapper exists — and none can be added later either.
 */

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

export type ProductListQuery = {
  /** Matches the **name only** — `identifier` is not searchable (ship §5). */
  keywords?: string | undefined;
  scope_type?: 'organization' | 'user_group' | string | undefined;
  scope_id?: string | undefined;
  /** Must be supplied **together** with `member_id` (ship GOTCHA #13). */
  member_type?: string | undefined;
  member_id?: string | undefined;
  /** `"startTs,endTs"` in unix seconds. */
  created_between?: string | undefined;
  updated_between?: string | undefined;
  include_archived?: boolean | undefined;
  include_deleted?: boolean | undefined;
};

export async function listProducts(
  ctx: Ctx,
  query: ProductListQuery = {},
  page: PageRequest = {},
): Promise<Page<ShipProduct>> {
  return await fetchPageOf(ctx, ENDPOINTS.shipProducts, { ...query }, page, parseShipProduct);
}

export function iterateProducts(
  ctx: Ctx,
  query: ProductListQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<ShipProduct, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.shipProducts, { ...query }, options, parseShipProduct);
}

/** `include_deleted` / `include_archived` exist **only** on products (ship GOTCHA #18). */
export async function getProduct(
  ctx: Ctx,
  productId: string,
  options: { include_archived?: boolean | undefined; include_deleted?: boolean | undefined } = {},
): Promise<ShipProduct> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.shipProduct(productId),
    query: { ...options },
  });
  return parseShipProduct(raw);
}

/** The `assignee_id` candidate set. A member's `id` **is** the user id (ship §B). */
export async function listProductMembers(
  ctx: Ctx,
  productId: string,
): Promise<ShipProductMember[]> {
  return await listAllOf(ctx, ENDPOINTS.shipProductMembers(productId), {}, parseShipProductMember);
}

// ---------------------------------------------------------------------------
// 需求排期 requirement schedules (ship §E) — read-only, and provably so
// ---------------------------------------------------------------------------

/**
 * The **full** 排期 records of a product. Paged and faithful (`page_index` /
 * `page_size` echoed, out-of-range answers the requested index with zero rows).
 *
 * No filter is offered because none is documented and none was observed to work: an
 * undeclared `?name=` changed nothing. See `endpoints.ts` for the three unrelated
 * things this API calls a "plan".
 */
export async function listProductPlans(
  ctx: Ctx,
  productId: string,
  page: PageRequest = {},
): Promise<Page<ShipPlan>> {
  return await fetchPageOf(ctx, ENDPOINTS.shipProductPlans(productId), {}, page, parseShipPlan);
}

export function iterateProductPlans(
  ctx: Ctx,
  productId: string,
  options: PaginateOptions = {},
): AsyncGenerator<ShipPlan, void, undefined> {
  return iterateOf(ctx, ENDPOINTS.shipProductPlans(productId), {}, options, parseShipPlan);
}

/** An unknown plan answers 400 `100721`, an unknown product 400 `100701`. */
export async function getProductPlan(
  ctx: Ctx,
  productId: string,
  planId: string,
): Promise<ShipPlan> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.shipProductPlan(productId, planId),
  });
  return parseShipPlan(raw);
}

/**
 * The same rows through the idea-side lookup: `{id, url, name}` only, hence the
 * separate parser (ship GOTCHA #12). This is the list `idea update --plan-id` draws
 * from, which is why it belongs with the other nine `product meta` lookups.
 */
export async function listIdeaPlans(ctx: Ctx, productId: string): Promise<ShipPlanSummary[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipIdeaPlans,
    { product_id: productId },
    parseShipPlanSummary,
  );
}

// ---------------------------------------------------------------------------
// ideas (需求)
// ---------------------------------------------------------------------------

/** Required: `product_id`, `title` (≤255). No `state_id` at create (ship §J). */
export type CreateIdeaInput = {
  product_id: string;
  title: string;
  description?: string | undefined;
  assignee_id?: string | undefined;
  suite_id?: string | undefined;
  priority_id?: string | undefined;
  /** Keys are property ids; **replaces** wholesale, never merges. */
  properties?: Record<string, unknown> | undefined;
};

/** Any subset. **No `product_id`** — an idea cannot move products (ship §J). */
export type UpdateIdeaInput = {
  title?: string | undefined;
  description?: string | undefined;
  state_id?: string | undefined;
  priority_id?: string | undefined;
  assignee_id?: string | undefined;
  suite_id?: string | undefined;
  plan_id?: string | undefined;
  /** 0–1, two decimal places. */
  progress?: number | undefined;
  properties?: Record<string, unknown> | undefined;
};

export async function searchIdeas(
  ctx: Ctx,
  payload: SearchPayload = {},
  page: PageRequest = {},
): Promise<Page<ShipIdea>> {
  return await fetchSearchPageOf(ctx, ENDPOINTS.shipIdeasSearch, payload, page, parseShipIdea);
}

export function iterateIdeas(
  ctx: Ctx,
  payload: SearchPayload = {},
  options: PaginateOptions = {},
): AsyncGenerator<ShipIdea, void, undefined> {
  return iterateSearchOf(ctx, ENDPOINTS.shipIdeasSearch, payload, options, parseShipIdea);
}

/** Accepts the 24-hex `id` only — never `identifier` or `short_id` (ship §25). */
export async function getIdea(
  ctx: Ctx,
  ideaId: string,
  options: { include_public_image_token?: string | string[] | undefined } = {},
): Promise<ShipIdea> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.shipIdea(ideaId),
    query: { ...options },
  });
  return parseShipIdea(raw);
}

/**
 * Both idea write endpoints are the only 2 of 101 ship records with **no
 * documented response schema** (ship GOTCHA #30), and the create example is not
 * even valid JSON. The response is parsed as an idea on the strength of the GET
 * schema; unknown fields survive regardless.
 */
export async function createIdea(ctx: Ctx, input: CreateIdeaInput): Promise<ShipIdea> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.shipIdeas,
    body: compact(input),
  });
  return parseShipIdea(raw);
}

export async function updateIdea(
  ctx: Ctx,
  ideaId: string,
  patch: UpdateIdeaInput,
): Promise<ShipIdea> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.shipIdea(ideaId),
    body: compact(patch),
  });
  return parseShipIdea(raw);
}

// ---------------------------------------------------------------------------
// 需求流转记录 idea state history (ship §J2) — state changes only
// ---------------------------------------------------------------------------

/**
 * List one 需求's state changes, oldest first as the API orders them.
 *
 * This list **validates its parent** (400 `100725` for an unknown idea, already mapped
 * to exit 5), so an empty result really means "no rows" — unlike pjm's work-item link
 * list, which hides a bad parent behind 200 + zero rows. `ideaId` must be the 24-hex
 * id: this sub-collection rejects `short_id` and `identifier` with a real HTTP 404
 * (live 2026-08-05, S4).
 *
 * No filter is offered: `?name=`, `?state_id=` and `?keywords=` were all accepted and
 * silently ignored, returning the full list every time.
 */
export async function listIdeaTransitionHistories(
  ctx: Ctx,
  ideaId: string,
  page: PageRequest = {},
): Promise<Page<ShipIdeaTransitionHistory>> {
  return await fetchPageOf(
    ctx,
    ENDPOINTS.shipIdeaTransitionHistories(ideaId),
    {},
    page,
    parseShipIdeaTransitionHistory,
  );
}

export function iterateIdeaTransitionHistories(
  ctx: Ctx,
  ideaId: string,
  options: PaginateOptions = {},
): AsyncGenerator<ShipIdeaTransitionHistory, void, undefined> {
  return iterateOf(
    ctx,
    ENDPOINTS.shipIdeaTransitionHistories(ideaId),
    {},
    options,
    parseShipIdeaTransitionHistory,
  );
}

/**
 * One state change. An unknown history id **and** a real history id that hangs off a
 * different idea both answer 400 `100740` — the idea segment is genuinely enforced, so
 * both are "no record at this address" and both exit 5.
 */
export async function getIdeaTransitionHistory(
  ctx: Ctx,
  ideaId: string,
  historyId: string,
): Promise<ShipIdeaTransitionHistory> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.shipIdeaTransitionHistory(ideaId, historyId),
  });
  return parseShipIdeaTransitionHistory(raw);
}

// ---------------------------------------------------------------------------
// tickets (工单)
// ---------------------------------------------------------------------------

/** Required: `product_id`, `title`, **`type_id`** (ship §K, PRD D12). */
export type CreateTicketInput = {
  product_id: string;
  title: string;
  type_id: string;
  description?: string | undefined;
  assignee_id?: string | undefined;
  priority_id?: string | undefined;
  customer_id?: string | undefined;
  /** Set-once: there is no `channel_id` on PATCH (ship GOTCHA #16). */
  channel_id?: string | undefined;
  /** Silently ignored under a personal token (ship GOTCHA #14). */
  submitter_id?: string | undefined;
  properties?: Record<string, unknown> | undefined;
};

/** Any subset. No `channel_id`, no `product_id`, no `tags` (ship §K). */
export type UpdateTicketInput = {
  title?: string | undefined;
  description?: string | undefined;
  type_id?: string | undefined;
  state_id?: string | undefined;
  priority_id?: string | undefined;
  assignee_id?: string | undefined;
  customer_id?: string | undefined;
  solution_id?: string | undefined;
  properties?: Record<string, unknown> | undefined;
};

export async function searchTickets(
  ctx: Ctx,
  payload: SearchPayload = {},
  page: PageRequest = {},
): Promise<Page<ShipTicket>> {
  return await fetchSearchPageOf(ctx, ENDPOINTS.shipTicketsSearch, payload, page, parseShipTicket);
}

export function iterateTickets(
  ctx: Ctx,
  payload: SearchPayload = {},
  options: PaginateOptions = {},
): AsyncGenerator<ShipTicket, void, undefined> {
  return iterateSearchOf(ctx, ENDPOINTS.shipTicketsSearch, payload, options, parseShipTicket);
}

export async function getTicket(
  ctx: Ctx,
  ticketId: string,
  options: { include_public_image_token?: string | string[] | undefined } = {},
): Promise<ShipTicket> {
  const raw = await request<unknown>(ctx, {
    method: 'GET',
    path: ENDPOINTS.shipTicket(ticketId),
    query: { ...options },
  });
  return parseShipTicket(raw);
}

export async function createTicket(ctx: Ctx, input: CreateTicketInput): Promise<ShipTicket> {
  const raw = await request<unknown>(ctx, {
    method: 'POST',
    path: ENDPOINTS.shipTickets,
    body: compact(input),
  });
  return parseShipTicket(raw);
}

export async function updateTicket(
  ctx: Ctx,
  ticketId: string,
  patch: UpdateTicketInput,
): Promise<ShipTicket> {
  const raw = await request<unknown>(ctx, {
    method: 'PATCH',
    path: ENDPOINTS.shipTicket(ticketId),
    body: compact(patch),
  });
  return parseShipTicket(raw);
}

// ---------------------------------------------------------------------------
// product-scoped metadata (ship §J3, §K3)
// ---------------------------------------------------------------------------

/**
 * All ten lookups take `?product_id=` and are **required** to: the same metadata
 * is reachable org-wide, but a product's property view / state plan decides which
 * subset is actually valid there, so an org-level list must never be cached and
 * reused (ship §5).
 */

export async function listIdeaStates(ctx: Ctx, productId: string): Promise<ShipState[]> {
  return await listAllOf(ctx, ENDPOINTS.shipIdeaStates, { product_id: productId }, parseShipState);
}

export async function listIdeaPriorities(ctx: Ctx, productId: string): Promise<ShipPriority[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipIdeaPriorities,
    { product_id: productId },
    parseShipPriority,
  );
}

/** A tree served flat, with `parent` references (ship §D). */
export async function listIdeaSuites(ctx: Ctx, productId: string): Promise<ShipSuite[]> {
  return await listAllOf(ctx, ENDPOINTS.shipIdeaSuites, { product_id: productId }, parseShipSuite);
}

export async function listIdeaProperties(ctx: Ctx, productId: string): Promise<ShipProperty[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipIdeaProperties,
    { product_id: productId },
    parseShipProperty,
  );
}

export async function listTicketStates(ctx: Ctx, productId: string): Promise<ShipState[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipTicketStates,
    { product_id: productId },
    parseShipState,
  );
}

export async function listTicketPriorities(ctx: Ctx, productId: string): Promise<ShipPriority[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipTicketPriorities,
    { product_id: productId },
    parseShipPriority,
  );
}

/** `type_id` is **required** on ticket create, so this is load-bearing (PRD D12). */
export async function listTicketTypes(ctx: Ctx, productId: string): Promise<ShipTicketType[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipTicketTypes,
    { product_id: productId },
    parseShipTicketType,
  );
}

export async function listTicketChannels(ctx: Ctx, productId: string): Promise<ShipChannel[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipTicketChannels,
    { product_id: productId },
    parseShipChannel,
  );
}

export async function listTicketProperties(ctx: Ctx, productId: string): Promise<ShipProperty[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipTicketProperties,
    { product_id: productId },
    parseShipProperty,
  );
}

// ---------------------------------------------------------------------------
// ticket state plans + flows (transition pre-validation, PRD D11)
// ---------------------------------------------------------------------------

/**
 * There is **no `?product_id=` filter** on the plan list and the product resource
 * exposes no plan id, so "which plan does product X use" is an O(all plans)
 * client-side scan over the embedded `product.id` — the only route the docs
 * describe (ship GOTCHA #23, §9.11). Plans with `product: null` are the org-level
 * default and are skipped by the caller.
 */
export async function listTicketStatePlans(ctx: Ctx): Promise<ShipStatePlan[]> {
  return await listAllOf(ctx, ENDPOINTS.shipTicketStatePlans, {}, parseShipStatePlan);
}

/** The legal `from → to` edges of a state plan — this is what makes a transition legal. */
export async function listTicketStateFlows(
  ctx: Ctx,
  statePlanId: string,
): Promise<ShipStateFlow[]> {
  return await listAllOf(
    ctx,
    ENDPOINTS.shipTicketStateFlows(statePlanId),
    {},
    parseShipStateFlow,
  );
}
