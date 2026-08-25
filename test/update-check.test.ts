import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '../src/version';

// We need to mock the configDir import to point to a temp directory.
// Since update-check.ts imports `configDir` directly, we'll mock the module.
vi.mock('../src/core/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/config')>();
  return { ...original, configDir: () => TEMP_CONFIG_DIR };
});

// Must import after mock setup.
const { checkForUpdate, ENV_NO_UPDATE_CHECK } = await import('../src/core/update-check');

const TEMP_CONFIG_DIR = path.join(import.meta.dirname ?? '.', '.tmp-update-check');
const CACHE_FILE = path.join(TEMP_CONFIG_DIR, 'update-check.json');

beforeEach(() => {
  if (existsSync(TEMP_CONFIG_DIR)) rmSync(TEMP_CONFIG_DIR, { recursive: true });
  mkdirSync(TEMP_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_CONFIG_DIR)) rmSync(TEMP_CONFIG_DIR, { recursive: true });
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// env-var opt-out
// ---------------------------------------------------------------------------

describe('checkForUpdate — opt-out', () => {
  it('returns skipped when PINGCODE_NO_UPDATE_CHECK=1', async () => {
    const result = await checkForUpdate({ PINGCODE_NO_UPDATE_CHECK: '1' });
    expect(result).toEqual({ status: 'skipped' });
  });

  it('returns skipped when PINGCODE_NO_UPDATE_CHECK=true (case-insensitive)', async () => {
    const result = await checkForUpdate({ PINGCODE_NO_UPDATE_CHECK: 'TRUE' });
    expect(result).toEqual({ status: 'skipped' });
  });

  it('does not skip when env var is unset', async () => {
    // Will hit network (no cache) — should resolve to up-to-date or whatever
    // GitHub returns. We just verify it doesn't return 'skipped'.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await checkForUpdate({});
    expect(result.status).not.toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// cache behaviour
// ---------------------------------------------------------------------------

describe('checkForUpdate — cache', () => {
  it('uses fresh cache and does not call fetch', async () => {
    const freshCache = {
      checkedAt: new Date().toISOString(),
      latestVersion: '99.99.99',
    };
    writeFileSync(CACHE_FILE, JSON.stringify(freshCache, null, 2));

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({});
    expect(result).toEqual({
      status: 'update-available',
      current: VERSION,
      latest: '99.99.99',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches when cache is stale', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    const staleCache = {
      checkedAt: staleDate.toISOString(),
      latestVersion: '99.99.99',
    };
    writeFileSync(CACHE_FILE, JSON.stringify(staleCache, null, 2));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v99.99.99' }),
      }),
    );

    const result = await checkForUpdate({});
    expect(result).toEqual({
      status: 'update-available',
      current: VERSION,
      latest: '99.99.99',
    });
  });

  it('fetches when no cache exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v99.99.99' }),
      }),
    );

    const result = await checkForUpdate({});
    expect(result).toEqual({
      status: 'update-available',
      current: VERSION,
      latest: '99.99.99',
    });

    // Verify cache was written.
    const written = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    expect(written.latestVersion).toBe('99.99.99');
  });
});

// ---------------------------------------------------------------------------
// network failure fallback
// ---------------------------------------------------------------------------

describe('checkForUpdate — network failures', () => {
  it('falls back to stale cache when network fails', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const staleCache = {
      checkedAt: staleDate.toISOString(),
      latestVersion: '99.99.99',
    };
    writeFileSync(CACHE_FILE, JSON.stringify(staleCache, null, 2));

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS fail')));

    const result = await checkForUpdate({});
    expect(result).toEqual({
      status: 'update-available',
      current: VERSION,
      latest: '99.99.99',
    });
  });

  it('returns unknown when no cache and network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const result = await checkForUpdate({});
    expect(result).toEqual({ status: 'unknown' });
  });

  it('returns unknown when GitHub returns non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }),
    );

    const result = await checkForUpdate({});
    expect(result).toEqual({ status: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// version comparison
// ---------------------------------------------------------------------------

describe('checkForUpdate — version comparison', () => {
  it('detects newer remote version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v99.99.99' }),
      }),
    );

    const result = await checkForUpdate({});
    expect(result.status).toBe('update-available');
  });

  it('returns up-to-date when remote equals local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: `v${VERSION}` }),
      }),
    );

    const result = await checkForUpdate({});
    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('returns up-to-date when remote is older', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v0.0.1' }),
      }),
    );

    const result = await checkForUpdate({});
    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('handles tags without leading v', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: '99.99.99' }),
      }),
    );

    const result = await checkForUpdate({});
    expect(result.status).toBe('update-available');
  });

  it('returns unknown when tag_name is missing from response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const result = await checkForUpdate({});
    expect(result).toEqual({ status: 'unknown' });
  });

  it('returns unknown when response JSON is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('bad json')),
      }),
    );

    const result = await checkForUpdate({});
    expect(result).toEqual({ status: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// skipCache option
// ---------------------------------------------------------------------------

describe('checkForUpdate — skipCache', () => {
  it('bypasses fresh cache when skipCache is true', async () => {
    // Write a fresh cache saying version 99.99.99.
    const freshCache = {
      checkedAt: new Date().toISOString(),
      latestVersion: '99.99.99',
    };
    writeFileSync(CACHE_FILE, JSON.stringify(freshCache, null, 2));

    // The network says a different newer version exists.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v88.88.88' }),
      }),
    );

    // Without skipCache: uses cache → 99.99.99
    const fromCache = await checkForUpdate({});
    expect(fromCache).toEqual({
      status: 'update-available',
      current: VERSION,
      latest: '99.99.99',
    });

    // With skipCache: ignores cache, fetches → 88.88.88
    const fresh = await checkForUpdate({}, { skipCache: true });
    expect(fresh).toEqual({
      status: 'update-available',
      current: VERSION,
      latest: '88.88.88',
    });
  });
});

// ---------------------------------------------------------------------------
// rate limit retry
// ---------------------------------------------------------------------------

describe('checkForUpdate — rate limit retry', () => {
  it('retries once on 403 and succeeds on second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 403, ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v99.99.99' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkForUpdate({});
    expect(result).toEqual({
      status: 'update-available',
      current: VERSION,
      latest: '99.99.99',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns unknown when both attempts get 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 403, ok: false }),
    );

    const result = await checkForUpdate({});
    expect(result).toEqual({ status: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// exported constant
// ---------------------------------------------------------------------------

describe('ENV_NO_UPDATE_CHECK', () => {
  it('equals PINGCODE_NO_UPDATE_CHECK', () => {
    expect(ENV_NO_UPDATE_CHECK).toBe('PINGCODE_NO_UPDATE_CHECK');
  });
});
