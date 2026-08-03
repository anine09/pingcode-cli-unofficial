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
  ShipPriority,
  ShipProduct,
  ShipProductMember,
  ShipProperty,
  ShipPropertyOption,
  ShipState,
  ShipStateFlow,
  ShipStatePlan,
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

export function parseShipStatePlan(raw: unknown): ShipStatePlan {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    // Nullable: `null` means the org-level default plan (ship GOTCHA #23).
    product: parseRef(record.product),
  };
}

/**
 * State flows spell the source state **`form_state`** in the docs while
 * transition histories spell it `from_state`, and no response example exists to
 * settle which reaches the wire (ship GOTCHA #2). Both are accepted; the
 * normalised value is `from_state`.
 */
export function parseShipStateFlow(raw: unknown): ShipStateFlow {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    from_state: parseRef(record.from_state) ?? parseRef(record.form_state),
    to_state: parseRef(record.to_state),
    state_plan: parseRef(record.state_plan),
  };
}
