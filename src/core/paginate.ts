import type { Ctx } from './context';
import { UsageError } from './errors';
import { request } from './http';

/**
 * Pagination (design §5.1). Every list endpoint returns the same envelope
 * (research §2.2):
 *
 *   { "page_size": 30, "page_index": 0, "total": 100, "values": [] }
 *
 * `page_index` is **0-based**, the default size is 30, the max is 100, paging is
 * offset-only, and the envelope **echoes back the requested `page_index`**.
 *
 * There is no sort guarantee on any business endpoint (research §6.20), so
 * offset paging over mutating data can duplicate and skip rows. Hence: dedupe by
 * `id`, stop on a short page, and bail when the echoed `page_index` does not
 * match what we asked for. `--all` is therefore **best effort, not a snapshot**.
 *
 * Two transports, one walk. Ship's only filtering read is
 * `POST /v1/ship/{ideas,tickets}/search`, which carries the cursor in
 * `payload.page_index` instead of the query string (ship §4). The cursor
 * placement is the *only* difference, so `paginate` and `searchPaginate` share
 * `walkPages` rather than forking the dedupe/short-page/echo-guard logic.
 */

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;
/** Safety cap for `--all` so it cannot silently burn the 200 req/min budget. */
export const DEFAULT_LIMIT = 500;

/** The raw envelope, as it arrives. */
export type PageEnvelope<T> = {
  page_size?: unknown;
  page_index?: unknown;
  total?: unknown;
  values?: T[] | undefined;
};

/** The envelope after normalisation. */
export type Page<T> = {
  pageIndex: number;
  pageSize: number;
  total: number;
  values: T[];
};

export function validatePageSize(value: unknown): number {
  const n = Number(value ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
    throw new UsageError(`--page-size must be an integer between 1 and ${MAX_PAGE_SIZE}`, {
      hint: `the API caps page_size at ${MAX_PAGE_SIZE} (research §2.2)`,
    });
  }
  return n;
}

/** Page numbers are 0-based on the wire; this is what the CLI passes through. */
export function validatePageIndex(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError('--page must be an integer >= 0 (paging is 0-based)');
  }
  return n;
}

export function validateLimit(value: unknown): number {
  const n = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError('--limit must be an integer >= 1');
  }
  return n;
}

export function normalizeEnvelope<T>(
  raw: PageEnvelope<T> | undefined,
  requested: { pageIndex: number; pageSize: number },
): Page<T> {
  const values = Array.isArray(raw?.values) ? (raw?.values as T[]) : [];
  return {
    pageIndex: asInteger(raw?.page_index) ?? requested.pageIndex,
    pageSize: asInteger(raw?.page_size) ?? requested.pageSize,
    total: asInteger(raw?.total) ?? values.length,
    values,
  };
}

export type PageRequest = {
  pageIndex?: number | undefined;
  pageSize?: number | undefined;
};

/** Fetch exactly one page of a `GET` list endpoint. */
export async function fetchPage<T>(
  ctx: Ctx,
  path: string,
  query: Record<string, unknown> = {},
  page: PageRequest = {},
): Promise<Page<T>> {
  const pageIndex = validatePageIndex(page.pageIndex ?? 0);
  const pageSize = validatePageSize(page.pageSize ?? DEFAULT_PAGE_SIZE);
  const raw = await request<PageEnvelope<T> | undefined>(ctx, {
    method: 'GET',
    path,
    query: { ...query, page_index: pageIndex, page_size: pageSize },
  });
  return normalizeEnvelope<T>(raw, { pageIndex, pageSize });
}

export type PaginateOptions = {
  pageSize?: number | undefined;
  /** 0-based. */
  startPage?: number | undefined;
  /** Hard cap on yielded items. */
  limit?: number | undefined;
};

/** Fetch page `n`. The two implementations differ only in where the cursor goes. */
export type PageFetcher<T> = (page: { pageIndex: number; pageSize: number }) => Promise<Page<T>>;

/**
 * The shared page walk: 0-based cursor, dedupe on `id`, stop on a short page,
 * respect `--limit`, and bail when the envelope echoes a **different**
 * `page_index` than the one requested.
 *
 * A **missing** `page_index` is not a mismatch: `normalizeEnvelope` falls back to
 * the requested value, so an envelope that simply omits the field is treated as
 * "no signal" and the walk continues (PRD Q2 — search may not echo it).
 */
async function* walkPages<T>(
  ctx: Ctx,
  fetchOne: PageFetcher<T>,
  options: PaginateOptions,
  label: string,
): AsyncGenerator<T, void, undefined> {
  const pageSize = validatePageSize(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const limit = validateLimit(options.limit ?? DEFAULT_LIMIT);
  let pageIndex = validatePageIndex(options.startPage ?? 0);

  const seen = new Set<string>();
  let yielded = 0;

  for (;;) {
    const page = await fetchOne({ pageIndex, pageSize });

    if (page.pageIndex !== pageIndex) {
      // A precise signal that paging is being ignored (research §6.20):
      // continuing would loop over page 0 forever.
      ctx.logger.warn(
        `the API echoed page_index=${page.pageIndex} for a request with page_index=${pageIndex}; ` +
          `${label} paging appears to be ignored, so the result set is incomplete`,
      );
      return;
    }

    for (const item of page.values) {
      const id = idOf(item);
      if (id !== undefined) {
        if (seen.has(id)) continue; // dedupe: offset paging over unsorted, mutating data
        seen.add(id);
      }
      yield item;
      yielded += 1;
      if (yielded >= limit) return;
    }

    if (page.values.length < pageSize) return; // short page ⇒ the end
    pageIndex += 1;
  }
}

/** Walk a `GET` list endpoint. */
export async function* paginate<T>(
  ctx: Ctx,
  path: string,
  query: Record<string, unknown> = {},
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  yield* walkPages<T>(ctx, (page) => fetchPage<T>(ctx, path, query, page), options, 'GET-list');
}

// ---------------------------------------------------------------------------
// body pagination: POST …/search (ship §4)
// ---------------------------------------------------------------------------

/**
 * The `payload` of a `POST …/search` body, minus the paging fields this module
 * owns. `mode` is required and its only legal value is `"query"` (ship §4).
 *
 * `filter` holds **one operator per field**; there are no logical operators, so
 * multiple entries are implicitly AND-ed. `keywords` is a sibling of `filter`,
 * not an entry inside it.
 */
export type SearchPayload = {
  filter?: Record<string, unknown> | undefined;
  keywords?: string | undefined;
  include_public_image_token?: string | string[] | undefined;
  [key: string]: unknown;
};

/**
 * `POST …/search` is a **read** that happens to use a mutating verb, so the
 * dry-run gate in `core/http.ts` — which keys off the verb — must not swallow
 * it. Under `--dry-run` a search would otherwise print a request plan instead of
 * listing anything, and the documented contract is the opposite: *"read requests
 * still run, so ids are really resolved"*.
 *
 * This is deliberately scoped to the two `…/search` endpoints rather than
 * changed in the transport: the verb-based gate is the right default, and every
 * genuine ship write (`POST /v1/ship/ideas`, `POST /v1/ship/tickets`, both
 * PATCHes) still halts under `--dry-run`.
 */
function asReadContext(ctx: Ctx): Ctx {
  return ctx.dryRun ? { ...ctx, dryRun: false } : ctx;
}

function buildSearchBody(
  payload: SearchPayload,
  page: { pageIndex: number; pageSize: number },
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    // An empty filter is noise: send no `filter` key rather than `{}`.
    if (key === 'filter' && Object.keys(value as Record<string, unknown>).length === 0) continue;
    body[key] = value;
  }
  body.page_index = page.pageIndex;
  body.page_size = page.pageSize;
  return { mode: 'query', payload: body };
}

/** Fetch exactly one page of a `POST …/search` endpoint. */
export async function fetchSearchPage<T>(
  ctx: Ctx,
  path: string,
  payload: SearchPayload = {},
  page: PageRequest = {},
): Promise<Page<T>> {
  const pageIndex = validatePageIndex(page.pageIndex ?? 0);
  const pageSize = validatePageSize(page.pageSize ?? DEFAULT_PAGE_SIZE);
  const raw = await request<PageEnvelope<T> | undefined>(asReadContext(ctx), {
    method: 'POST',
    path,
    body: buildSearchBody(payload, { pageIndex, pageSize }),
  });
  return normalizeEnvelope<T>(raw, { pageIndex, pageSize });
}

/** Walk a `POST …/search` endpoint. Identical semantics to `paginate`. */
export async function* searchPaginate<T>(
  ctx: Ctx,
  path: string,
  payload: SearchPayload = {},
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  yield* walkPages<T>(
    ctx,
    (page) => fetchSearchPage<T>(ctx, path, payload, page),
    options,
    'search',
  );
}

/** Drain an async iterable into an array. */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

function idOf(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}
