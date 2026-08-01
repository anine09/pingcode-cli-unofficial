import { describe, expect, it } from 'vitest';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { ENDPOINTS } from '../src/core/endpoints';
import { UsageError } from '../src/core/errors';
import { collect, fetchSearchPage, searchPaginate } from '../src/core/paginate';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

/**
 * Gate G1: body pagination for `POST …/search` (design §3, ship §4).
 *
 * `paginate` and `searchPaginate` share one walk, so the interesting assertions
 * here are the ones that differ — the cursor lands in `payload`, `mode` is
 * `"query"` — plus the Q2 defence: a **missing** `page_index` in the envelope
 * must not stop the walk, only a **mismatching** one.
 *
 * `test/paginate.test.ts` is intentionally untouched by the refactor.
 */

const NOW = 1_700_000_000_000;

type Envelope = { page_index?: number; page_size?: number; total?: number; values: unknown[] };

function ctxFor(pages: Envelope[], options: { dryRun?: boolean } = {}) {
  const fake = createFakeFetch(pages.map((page) => () => jsonResponse(page)));
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { ctx, fake };
}

const item = (id: string) => ({ id, title: id });

function bodyOf(fake: ReturnType<typeof createFakeFetch>, index: number): Record<string, unknown> {
  return (fake.calls[index]?.body ?? {}) as Record<string, unknown>;
}

function payloadOf(
  fake: ReturnType<typeof createFakeFetch>,
  index: number,
): Record<string, unknown> {
  return (bodyOf(fake, index).payload ?? {}) as Record<string, unknown>;
}

describe('fetchSearchPage', () => {
  it('POSTs mode=query with the cursor inside payload, not the query string', async () => {
    const { ctx, fake } = ctxFor([{ page_index: 1, page_size: 5, total: 42, values: [item('a')] }]);
    const page = await fetchSearchPage(
      ctx,
      ENDPOINTS.shipIdeasSearch,
      { filter: { 'product.id': { in: ['prod-1'] } }, keywords: 'SLC-1' },
      { pageIndex: 1, pageSize: 5 },
    );

    expect(fake.calls[0]?.method).toBe('POST');
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/ship/ideas/search');
    // the cursor must NOT leak into the query string
    expect(url.searchParams.get('page_index')).toBeNull();
    expect(url.searchParams.get('page_size')).toBeNull();

    expect(bodyOf(fake, 0).mode).toBe('query');
    expect(payloadOf(fake, 0)).toEqual({
      filter: { 'product.id': { in: ['prod-1'] } },
      keywords: 'SLC-1',
      page_index: 1,
      page_size: 5,
    });
    expect(page.total).toBe(42);
  });

  it('defaults to page 0 / size 30 and omits an empty filter', async () => {
    const { ctx, fake } = ctxFor([{ values: [] }]);
    await fetchSearchPage(ctx, ENDPOINTS.shipTicketsSearch, { filter: {}, keywords: undefined });
    expect(payloadOf(fake, 0)).toEqual({ page_index: 0, page_size: 30 });
  });

  it('rejects a page size above the API cap of 100 before sending anything', async () => {
    const { ctx, fake } = ctxFor([{ values: [] }]);
    await expect(
      fetchSearchPage(ctx, ENDPOINTS.shipIdeasSearch, {}, { pageSize: 500 }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects a negative page index before sending anything', async () => {
    const { ctx, fake } = ctxFor([{ values: [] }]);
    await expect(
      fetchSearchPage(ctx, ENDPOINTS.shipIdeasSearch, {}, { pageIndex: -1 }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(fake.calls).toHaveLength(0);
  });

  it('still runs under --dry-run: a search is a read wearing a POST (design §3)', async () => {
    const { ctx, fake } = ctxFor([{ page_index: 0, page_size: 30, total: 1, values: [item('a')] }], {
      dryRun: true,
    });
    const page = await fetchSearchPage(ctx, ENDPOINTS.shipIdeasSearch, {});
    expect(page.values).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('searchPaginate', () => {
  it('walks 0-based pages, advancing the cursor in the body', async () => {
    const { ctx, fake } = ctxFor([
      { page_index: 0, page_size: 2, total: 3, values: [item('a'), item('b')] },
      { page_index: 1, page_size: 2, total: 3, values: [item('c')] },
    ]);
    const all = await collect(
      searchPaginate(ctx, ENDPOINTS.shipIdeasSearch, {}, { pageSize: 2 }),
    );
    expect(all.map((row) => (row as { id: string }).id)).toEqual(['a', 'b', 'c']);
    expect(payloadOf(fake, 0).page_index).toBe(0);
    expect(payloadOf(fake, 1).page_index).toBe(1);
    expect(fake.calls).toHaveLength(2);
  });

  it('dedupes by id across pages (ship has no sorting at all)', async () => {
    const { ctx } = ctxFor([
      { page_index: 0, page_size: 2, values: [item('a'), item('b')] },
      { page_index: 1, page_size: 2, values: [item('b'), item('c')] },
      { page_index: 2, page_size: 2, values: [item('d')] },
    ]);
    const all = await collect(searchPaginate(ctx, ENDPOINTS.shipIdeasSearch, {}, { pageSize: 2 }));
    expect(all.map((row) => (row as { id: string }).id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('stops on a short page and at --limit', async () => {
    const short = ctxFor([{ page_index: 0, page_size: 2, values: [item('a')] }]);
    expect(
      await collect(searchPaginate(short.ctx, ENDPOINTS.shipIdeasSearch, {}, { pageSize: 2 })),
    ).toHaveLength(1);
    expect(short.fake.calls).toHaveLength(1);

    const limited = ctxFor([
      { page_index: 0, page_size: 2, values: [item('a'), item('b')] },
      { page_index: 1, page_size: 2, values: [item('c'), item('d')] },
    ]);
    expect(
      await collect(
        searchPaginate(limited.ctx, ENDPOINTS.shipIdeasSearch, {}, { pageSize: 2, limit: 3 }),
      ),
    ).toHaveLength(3);
  });

  it('starts from an explicit page', async () => {
    const { ctx, fake } = ctxFor([{ page_index: 4, page_size: 2, values: [item('z')] }]);
    const all = await collect(
      searchPaginate(ctx, ENDPOINTS.shipIdeasSearch, {}, { pageSize: 2, startPage: 4 }),
    );
    expect(all).toHaveLength(1);
    expect(payloadOf(fake, 0).page_index).toBe(4);
  });

  it('warns and stops when the envelope echoes a different page_index', async () => {
    const { ctx, fake } = ctxFor([
      { page_index: 0, page_size: 2, values: [item('a'), item('b')] },
      // the server ignored payload.page_index and returned page 0 again
      { page_index: 0, page_size: 2, values: [item('a'), item('b')] },
    ]);
    const all = await collect(searchPaginate(ctx, ENDPOINTS.shipIdeasSearch, {}, { pageSize: 2 }));
    expect(all.map((row) => (row as { id: string }).id)).toEqual(['a', 'b']);
    expect(fake.calls).toHaveLength(2);
    expect(ctx.logLines.join('\n')).toContain('search paging appears to be ignored');
  });

  it('keeps walking when the envelope omits page_index entirely (Q2 defence)', async () => {
    // Q2: it is unknown whether `…/search` echoes `page_index`. Missing must mean
    // "no signal" — treating it as a mismatch would truncate every --all walk.
    const { ctx, fake } = ctxFor([
      { page_size: 2, total: 3, values: [item('a'), item('b')] },
      { page_size: 2, total: 3, values: [item('c'), item('d')] },
      { page_size: 2, total: 3, values: [item('e')] },
    ]);
    const all = await collect(searchPaginate(ctx, ENDPOINTS.shipIdeasSearch, {}, { pageSize: 2 }));
    expect(all.map((row) => (row as { id: string }).id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fake.calls).toHaveLength(3);
    expect(ctx.logLines.join('\n')).not.toContain('paging appears to be ignored');
  });

  it('carries the filter and keywords unchanged on every page', async () => {
    const { ctx, fake } = ctxFor([
      { page_index: 0, page_size: 1, values: [item('a')] },
      { page_index: 1, page_size: 1, values: [] },
    ]);
    const payload = { filter: { 'state.id': { in: ['s1'] } }, keywords: 'login' };
    await collect(searchPaginate(ctx, ENDPOINTS.shipTicketsSearch, payload, { pageSize: 1 }));
    for (const index of [0, 1]) {
      expect(payloadOf(fake, index).filter).toEqual({ 'state.id': { in: ['s1'] } });
      expect(payloadOf(fake, index).keywords).toBe('login');
    }
  });
});
