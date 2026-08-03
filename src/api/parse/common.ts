/**
 * Parsing primitives shared by every module, plus the list/search pagination plumbing.
 *
 * Split out of the former single 897-line `src/api/parse.ts` by F1 (design D6.5).
 * `src/api/parse.ts` re-exports every name below, so **no existing import path
 * changed**; the move is mechanical and behaviour-free.
 *
 * The module-wide rule still holds: this layer is the **only** place wire quirks are
 * normalised (`0/1` booleans, `versions[]` vs `version`), unknown fields are always
 * preserved so `--json` stays faithful, and nothing here formats output.
 */

import type { Ctx } from '../../core/context';
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
} from '../../core/paginate';
import type { Ref } from '../../types/api';

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

/**
 * A free-form property bag: an object, never an array, otherwise `undefined`.
 *
 * Was a private helper in the old single-file `parse.ts`; F1 exported it because
 * **ship and testhub both call it** (`parseShipIdea`, `parseShipTicket`,
 * `parseTestCase`) and duplicating five lines per module is exactly the divergence
 * the code-reuse guide warns about.
 */
export function parseProperties(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
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
