import { describe, expect, it } from 'vitest';
import { THIRTY_DAYS_MS } from '../src/core/auth';
import { UsageError } from '../src/core/errors';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  collect,
  fetchPage,
  normalizeEnvelope,
  paginate,
  validateLimit,
  validatePageIndex,
  validatePageSize,
} from '../src/core/paginate';
import { createFakeFetch, createTestContext, jsonResponse } from './helpers/fake';

const NOW = 1_700_000_000_000;

function ctxFor(pages: Array<{ page_index?: number; page_size?: number; total?: number; values: unknown[] }>) {
  const fake = createFakeFetch(pages.map((page) => () => jsonResponse(page)));
  const ctx = createTestContext({
    fetch: fake.fetch,
    token: { accessToken: 'tok', expiresAtMs: NOW + THIRTY_DAYS_MS, obtainedAtMs: NOW },
    now: NOW,
  });
  return { ctx, fake };
}

const item = (id: string) => ({ id, name: id });

describe('page-size / page-index validation', () => {
  it('accepts 1..100 and rejects everything else', () => {
    expect(validatePageSize(1)).toBe(1);
    expect(validatePageSize(MAX_PAGE_SIZE)).toBe(100);
    expect(validatePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(validatePageSize('25')).toBe(25);
    for (const bad of [0, -1, 101, 1.5, 'abc']) {
      expect(() => validatePageSize(bad)).toThrow(UsageError);
    }
  });

  it('page numbers are 0-based', () => {
    expect(validatePageIndex(undefined)).toBe(0);
    expect(validatePageIndex(0)).toBe(0);
    expect(validatePageIndex(3)).toBe(3);
    expect(() => validatePageIndex(-1)).toThrow(UsageError);
    expect(() => validatePageIndex(1.2)).toThrow(UsageError);
  });

  it('validates --limit', () => {
    expect(validateLimit(undefined)).toBe(500);
    expect(validateLimit(10)).toBe(10);
    expect(() => validateLimit(0)).toThrow(UsageError);
  });
});

describe('normalizeEnvelope', () => {
  it('reads the uniform list envelope', () => {
    expect(
      normalizeEnvelope({ page_size: 30, page_index: 0, total: 100, values: [item('a')] }, {
        pageIndex: 0,
        pageSize: 30,
      }),
    ).toEqual({ pageIndex: 0, pageSize: 30, total: 100, values: [item('a')] });
  });

  it('falls back to the requested paging when the envelope omits it', () => {
    expect(normalizeEnvelope({ values: [] }, { pageIndex: 2, pageSize: 10 })).toEqual({
      pageIndex: 2,
      pageSize: 10,
      total: 0,
      values: [],
    });
    expect(normalizeEnvelope(undefined, { pageIndex: 0, pageSize: 30 }).values).toEqual([]);
  });

  it('ignores a non-array values field', () => {
    expect(normalizeEnvelope({ values: 'nope' } as never, { pageIndex: 0, pageSize: 30 }).values).toEqual(
      [],
    );
  });
});

describe('fetchPage', () => {
  it('sends 0-based page_index and page_size on the query string', async () => {
    const { ctx, fake } = ctxFor([{ page_index: 1, page_size: 5, total: 42, values: [item('a')] }]);
    const page = await fetchPage(ctx, '/v1/pjm/work_items', { project_id: 'p1' }, {
      pageIndex: 1,
      pageSize: 5,
    });
    const url = new URL(fake.urls()[0] ?? '');
    expect(url.searchParams.get('page_index')).toBe('1');
    expect(url.searchParams.get('page_size')).toBe('5');
    expect(url.searchParams.get('project_id')).toBe('p1');
    expect(page.total).toBe(42);
  });

  it('rejects an out-of-range page size before sending anything', async () => {
    const { ctx, fake } = ctxFor([{ values: [] }]);
    await expect(fetchPage(ctx, '/v1/pjm/projects', {}, { pageSize: 500 })).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe('paginate', () => {
  it('walks 0-based pages and stops on a short page', async () => {
    const { ctx, fake } = ctxFor([
      { page_index: 0, page_size: 2, total: 3, values: [item('a'), item('b')] },
      { page_index: 1, page_size: 2, total: 3, values: [item('c')] },
    ]);
    const all = await collect(paginate(ctx, '/v1/pjm/projects', {}, { pageSize: 2 }));
    expect(all.map((row) => (row as { id: string }).id)).toEqual(['a', 'b', 'c']);
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('page_index')).toBe('0');
    expect(new URL(fake.urls()[1] ?? '').searchParams.get('page_index')).toBe('1');
    expect(fake.calls).toHaveLength(2);
  });

  it('dedupes by id across pages (no sort guarantee, research §6.20)', async () => {
    const { ctx } = ctxFor([
      { page_index: 0, page_size: 2, values: [item('a'), item('b')] },
      { page_index: 1, page_size: 2, values: [item('b'), item('c')] },
      { page_index: 2, page_size: 2, values: [item('d')] },
    ]);
    const all = await collect(paginate(ctx, '/v1/pjm/projects', {}, { pageSize: 2 }));
    expect(all.map((row) => (row as { id: string }).id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('yields rows without an id rather than dropping them', async () => {
    const { ctx } = ctxFor([{ page_index: 0, page_size: 2, values: [{ name: 'x' }] }]);
    const all = await collect(paginate(ctx, '/v1/pjm/projects', {}, { pageSize: 2 }));
    expect(all).toEqual([{ name: 'x' }]);
  });

  it('stops at --limit', async () => {
    const { ctx, fake } = ctxFor([
      { page_index: 0, page_size: 2, values: [item('a'), item('b')] },
      { page_index: 1, page_size: 2, values: [item('c'), item('d')] },
    ]);
    const all = await collect(paginate(ctx, '/v1/pjm/projects', {}, { pageSize: 2, limit: 3 }));
    expect(all).toHaveLength(3);
    expect(fake.calls).toHaveLength(2);
  });

  it('starts from an explicit page', async () => {
    const { ctx, fake } = ctxFor([{ page_index: 4, page_size: 2, values: [item('z')] }]);
    const all = await collect(paginate(ctx, '/v1/pjm/projects', {}, { pageSize: 2, startPage: 4 }));
    expect(all).toHaveLength(1);
    expect(new URL(fake.urls()[0] ?? '').searchParams.get('page_index')).toBe('4');
  });

  it('bails out when the echoed page_index does not match the request', async () => {
    const { ctx, fake } = ctxFor([
      { page_index: 0, page_size: 2, values: [item('a'), item('b')] },
      // The server ignored page_index and returned page 0 again.
      { page_index: 0, page_size: 2, values: [item('a'), item('b')] },
    ]);
    const all = await collect(paginate(ctx, '/v1/pjm/projects', {}, { pageSize: 2 }));
    expect(all.map((row) => (row as { id: string }).id)).toEqual(['a', 'b']);
    expect(fake.calls).toHaveLength(2);
    expect(ctx.logLines.join('\n')).toContain('paging appears to be ignored');
  });

  it('bails immediately if even the first page echoes the wrong index', async () => {
    const { ctx } = ctxFor([{ page_index: 3, page_size: 2, values: [item('a'), item('b')] }]);
    const all = await collect(paginate(ctx, '/v1/pjm/projects', {}, { pageSize: 2 }));
    expect(all).toEqual([]);
  });
});
