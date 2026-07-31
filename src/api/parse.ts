import type { Ctx } from '../core/context';
import {
  collect,
  fetchPage,
  paginate,
  type Page,
  type PageRequest,
  type PaginateOptions,
} from '../core/paginate';
import type {
  Project,
  Ref,
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

/** Drop `undefined` values so they never reach a JSON request body. */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
