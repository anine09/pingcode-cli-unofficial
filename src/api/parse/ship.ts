/**
 * ship (产品管理 / 需求 / 工单) parsers — ship research §3.
 *
 * Split out of the former single 897-line `src/api/parse.ts` by F1 (design D6.5).
 * `src/api/parse.ts` re-exports every name below, so **no existing import path
 * changed**; the move is mechanical and behaviour-free.
 *
 * The module-wide rule still holds: this layer is the **only** place wire quirks are
 * normalised (`0/1` booleans, `versions[]` vs `version`), unknown fields are always
 * preserved so `--json` stays faithful, and nothing here formats output.
 */

import type {
  Ref,
  ShipChannel,
  ShipDateRange,
  ShipIdea,
  ShipIdeaTransitionHistory,
  ShipPlan,
  ShipPlanSummary,
  ShipPriority,
  ShipProduct,
  ShipProductMember,
  ShipProperty,
  ShipPropertyOption,
  ShipState,
  ShipSuite,
  ShipTicket,
  ShipTicketType,
} from '../../types/api';
import {
  asBooleanFlag,
  asNumber,
  asRecord,
  asString,
  parseProperties,
  parseRef,
  parseRefList,
} from './common';

/** `plan_at` / `real_at` / `estimated_at` — written all-or-nothing (ship GOTCHA #9). */
export function parseDateRange(raw: unknown): ShipDateRange | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    ...record,
    from: asNumber(record.from),
    to: asNumber(record.to),
    granularity: asString(record.granularity),
  };
}

export function parseShipProductMember(raw: unknown): ShipProductMember {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    type: asString(record.type),
    user: parseRef(record.user),
    user_group: parseRef(record.user_group),
    role: parseRef(record.role),
    product: parseRef(record.product),
  };
}

export function parseShipProduct(raw: unknown): ShipProduct {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    name: asString(record.name),
    url: asString(record.url),
    scope_type: asString(record.scope_type),
    scope_id: asString(record.scope_id),
    visibility: asString(record.visibility),
    color: asString(record.color),
    description: asString(record.description),
    members: Array.isArray(record.members) ? record.members.map(parseShipProductMember) : [],
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseShipIdea(raw: unknown): ShipIdea {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    short_id: asString(record.short_id),
    url: asString(record.url),
    html_url: asString(record.html_url),
    title: asString(record.title),
    description: asString(record.description),
    product: parseRef(record.product),
    assignee: parseRef(record.assignee),
    state: parseRef(record.state),
    priority: parseRef(record.priority),
    plan: parseRef(record.plan),
    suite: parseRef(record.suite),
    plan_at: parseDateRange(record.plan_at),
    real_at: parseDateRange(record.real_at),
    score: asNumber(record.score),
    progress: asNumber(record.progress),
    properties: parseProperties(record.properties),
    participants: parseRefList(record.participants),
    completed_at: asNumber(record.completed_at),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

/**
 * `ticket.channel` is documented as `Object/String`: a reference for externally
 * submitted tickets, the bare string `"internal"` otherwise (ship GOTCHA #3).
 * Naive `channel.name` access throws on internal tickets, so the union is kept.
 */
export function parseTicketChannel(raw: unknown): Ref | string | undefined {
  if (typeof raw === 'string') return raw === '' ? undefined : raw;
  return parseRef(raw);
}

export function parseShipTicket(raw: unknown): ShipTicket {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    short_id: asString(record.short_id),
    url: asString(record.url),
    html_url: asString(record.html_url),
    title: asString(record.title),
    description: asString(record.description),
    product: parseRef(record.product),
    assignee: parseRef(record.assignee),
    state: parseRef(record.state),
    type: parseRef(record.type),
    customer: parseRef(record.customer),
    solution: parseRef(record.solution),
    priority: parseRef(record.priority),
    channel: parseTicketChannel(record.channel),
    estimated_at: parseDateRange(record.estimated_at),
    properties: parseProperties(record.properties),
    tags: parseRefList(record.tags),
    participants: parseRefList(record.participants),
    submitted_at: asNumber(record.submitted_at),
    submitted_by: parseRef(record.submitted_by),
    completed_at: asNumber(record.completed_at),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseShipState(raw: unknown): ShipState {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
    color: asString(record.color),
  };
}

export function parseShipPriority(raw: unknown): ShipPriority {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    color: asString(record.color),
  };
}

export function parseShipSuite(raw: unknown): ShipSuite {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
    parent: parseRef(record.parent),
    product: parseRef(record.product),
  };
}

export function parseShipTicketType(raw: unknown): ShipTicketType {
  const record = asRecord(raw);
  const parsed: ShipTicketType = {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
  };
  // The product-scoped list omits `is_system` entirely (ship GOTCHA #12); an
  // absent flag must stay absent rather than become a confident `false`.
  parsed.is_system = record.is_system === undefined ? undefined : asBooleanFlag(record.is_system);
  return parsed;
}

export function parseShipChannel(raw: unknown): ShipChannel {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    description: asString(record.description),
  };
}

/**
 * 需求排期, the **full** record from `GET /v1/ship/products/{id}/plans[/{plan}]`.
 *
 * `start_at` / `end_at` are plain unix seconds here, not a `ShipDateRange` — a 排期
 * *is* the window, so it has no `granularity`.
 */
export function parseShipPlan(raw: unknown): ShipPlan {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    url: asString(record.url),
    product: parseRef(record.product),
    assignee: parseRef(record.assignee),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
  };
}

/**
 * The same rows from `GET /v1/ship/idea/plans?product_id=`, which documents only
 * `{id, url, name}`.
 *
 * Deliberately **not** `parseShipPlan`: ship returns two structures for one resource
 * depending on the endpoint (ship GOTCHA #12), and lifting `assignee` / `start_at` /
 * `end_at` here would assert fields this list does not promise. Anything the wire does
 * carry still survives into `--json` through the spread.
 */
export function parseShipPlanSummary(raw: unknown): ShipPlanSummary {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    url: asString(record.url),
  };
}

/**
 * One 需求 state change. The parent key is **`idea`**, not pjm's `work_item`, so this
 * is a third parser rather than a reuse (live 2026-08-05, S4): sharing pjm's would
 * leave `idea` unlifted and invent an always-`undefined` `work_item`.
 *
 * `from_state` is `null` on the creation row, which `parseRef` already reads as
 * `undefined`; the renderer prints `(new)` for it.
 */
export function parseShipIdeaTransitionHistory(raw: unknown): ShipIdeaTransitionHistory {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    url: asString(record.url),
    idea: parseRef(record.idea),
    from_state: parseRef(record.from_state),
    to_state: parseRef(record.to_state),
    created_by: parseRef(record.created_by),
    created_at: asNumber(record.created_at),
  };
}

export function parseShipPropertyOption(raw: unknown): ShipPropertyOption {
  const record = asRecord(raw);
  return {
    ...record,
    // The declared key is `_id`, but one documented PATCH example uses `id`
    // (ship GOTCHA #8), so both are read and normalised onto `_id`.
    _id: asString(record._id) ?? asString(record.id),
    text: asString(record.text),
    parent_id: asString(record.parent_id),
  };
}

export function parseShipProperty(raw: unknown): ShipProperty {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
    options: Array.isArray(record.options) ? record.options.map(parseShipPropertyOption) : [],
  };
}

/*
 * There is no `parseShipStatePlan` / `parseShipStateFlow` here. Both state-plan
 * endpoints are read only by the `cacheOnly` resolvers in `core/metadata`, which decode
 * rows with their own `refRecord` and carry the `form_state` / `from_state` spelling
 * fix (ship GOTCHA #2) in `core/metadata/index.ts`. The parsers that used to sit here
 * were the unexercised copy of that fix and went with the two dead `api/ship.ts`
 * wrappers in the G3 closeout (2026-08-05). See `src/api/ship.ts` for the full note.
 */
