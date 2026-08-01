import type { Ctx } from '../core/context';
import {
  collect,
  fetchPage,
  fetchSearchPage,
  paginate,
  searchPaginate,
  type Page,
  type PageRequest,
  type PaginateOptions,
  type SearchPayload,
} from '../core/paginate';
import type {
  Project,
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
  Sprint,
  User,
  WorkItem,
  WorkItemPriority,
  WorkItemState,
  WorkItemType,
} from '../types/api';

/**
 * Parsing / normalisation for the API layer.
 *
 * This is the **only** place where the two documented inconsistencies are handled
 * (design §8): `is_archived`/`is_deleted` arriving as numbers `0/1`
 * (research §6.10), and `versions` (array, list responses) vs `version` (object,
 * single GET) (research §4.2). Call sites never repeat this.
 *
 * Unknown fields are preserved so `--json` stays faithful to the API and custom
 * `properties` are never silently dropped. Nothing here formats output.
 */

export function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** `is_archived` / `is_deleted` are numbers `0/1`, not booleans (research §6.10). */
export function asBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== '0' && value !== 'false';
  return false;
}

export function parseRef(raw: unknown): Ref | undefined {
  const record = asRecord(raw);
  const id = asString(record.id);
  if (id === undefined) return undefined;
  const ref: Ref = { ...record, id };
  const name = asString(record.name);
  ref.name = name;
  const url = asString(record.url);
  ref.url = url;
  return ref;
}

export function parseRefList(raw: unknown): Ref[] {
  if (!Array.isArray(raw)) return [];
  const refs: Ref[] = [];
  for (const item of raw) {
    const ref = parseRef(item);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

export function parseProject(raw: unknown): Project {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    identifier: asString(record.identifier),
    type: asString(record.type),
    description: asString(record.description),
    url: asString(record.url),
    html_url: asString(record.html_url),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseWorkItem(raw: unknown): WorkItem {
  const record = asRecord(raw);

  // `versions` (array) on list responses vs `version` (object) on single GET.
  let versions = parseRefList(record.versions);
  if (versions.length === 0) {
    const single = parseRef(record.version);
    if (single !== undefined) versions = [single];
  }

  const properties =
    typeof record.properties === 'object' && record.properties !== null && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;

  return {
    ...record,
    id: asString(record.id) ?? '',
    identifier: asString(record.identifier),
    short_id: asString(record.short_id),
    url: asString(record.url),
    html_url: asString(record.html_url),
    title: asString(record.title),
    description: asString(record.description),
    type: parseRef(record.type),
    state: parseRef(record.state),
    priority: parseRef(record.priority),
    assignee: parseRef(record.assignee),
    project: parseRef(record.project),
    parent: parseRef(record.parent),
    sprint: parseRef(record.sprint),
    board: parseRef(record.board),
    entry: parseRef(record.entry),
    swimlane: parseRef(record.swimlane),
    phase: parseRef(record.phase),
    versions,
    tags: parseRefList(record.tags),
    participants: parseRefList(record.participants),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
    completed_at: asNumber(record.completed_at),
    created_at: asNumber(record.created_at),
    updated_at: asNumber(record.updated_at),
    created_by: parseRef(record.created_by),
    updated_by: parseRef(record.updated_by),
    story_points: asNumber(record.story_points),
    estimated_workload: asNumber(record.estimated_workload),
    remaining_workload: asNumber(record.remaining_workload),
    properties,
    is_archived: asBooleanFlag(record.is_archived),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

export function parseWorkItemType(raw: unknown): WorkItemType {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    description: asString(record.description),
  };
}

export function parseWorkItemState(raw: unknown): WorkItemState {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    type: asString(record.type),
  };
}

export function parseWorkItemPriority(raw: unknown): WorkItemPriority {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    color: asString(record.color),
  };
}

export function parseSprint(raw: unknown): Sprint {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    status: asString(record.status),
    start_at: asNumber(record.start_at),
    end_at: asNumber(record.end_at),
  };
}

export function parseUser(raw: unknown): User {
  const record = asRecord(raw);
  return {
    ...record,
    id: asString(record.id) ?? '',
    name: asString(record.name),
    display_name: asString(record.display_name),
    username: asString(record.username),
    email: asString(record.email),
    is_deleted: asBooleanFlag(record.is_deleted),
  };
}

// ---------------------------------------------------------------------------
// ship (产品管理) — ship research §3
// ---------------------------------------------------------------------------

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

function parseProperties(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
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

// ---------------------------------------------------------------------------
// list plumbing
// ---------------------------------------------------------------------------

export type Parser<T> = (raw: unknown) => T;

/** One page of a list endpoint, parsed. */
export async function fetchPageOf<T>(
  ctx: Ctx,
  path: string,
  query: Record<string, unknown>,
  page: PageRequest,
  parse: Parser<T>,
): Promise<Page<T>> {
  const raw = await fetchPage<unknown>(ctx, path, query, page);
  return { ...raw, values: raw.values.map(parse) };
}

/** Walk a list endpoint, parsing as we go. */
export async function* iterateOf<T>(
  ctx: Ctx,
  path: string,
  query: Record<string, unknown>,
  options: PaginateOptions,
  parse: Parser<T>,
): AsyncGenerator<T, void, undefined> {
  for await (const raw of paginate<unknown>(ctx, path, query, options)) {
    yield parse(raw);
  }
}

/** Collect every row of a (small, config-shaped) list endpoint. */
export async function listAllOf<T>(
  ctx: Ctx,
  path: string,
  query: Record<string, unknown>,
  parse: Parser<T>,
  options: PaginateOptions = {},
): Promise<T[]> {
  return await collect(
    iterateOf(ctx, path, query, { pageSize: 100, limit: 1000, ...options }, parse),
  );
}

/** One page of a `POST …/search` endpoint, parsed (ship §4). */
export async function fetchSearchPageOf<T>(
  ctx: Ctx,
  path: string,
  payload: SearchPayload,
  page: PageRequest,
  parse: Parser<T>,
): Promise<Page<T>> {
  const raw = await fetchSearchPage<unknown>(ctx, path, payload, page);
  return { ...raw, values: raw.values.map(parse) };
}

/** Walk a `POST …/search` endpoint, parsing as we go. */
export async function* iterateSearchOf<T>(
  ctx: Ctx,
  path: string,
  payload: SearchPayload,
  options: PaginateOptions,
  parse: Parser<T>,
): AsyncGenerator<T, void, undefined> {
  for await (const raw of searchPaginate<unknown>(ctx, path, payload, options)) {
    yield parse(raw);
  }
}

/** Drop `undefined` values so they never reach a JSON request body. */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
