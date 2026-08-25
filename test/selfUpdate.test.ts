import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillTarget } from '../src/core/paths';
import {
  atomicReplace,
  cleanStaging,
  dirExists,
  downloadReleaseAsset,
  fetchLatestRelease,
  removeFile,
  syncSkills,
  validateStaging,
  verifyInstall,
} from '../src/core/update';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TEMP_ROOT = path.join(import.meta.dirname ?? '.', '.tmp-self-update');

function tempDir(name: string): string {
  return path.join(TEMP_ROOT, name);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Build a fake fetch that returns a JSON response. */
function jsonFetch(data: unknown): typeof globalThis.fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => data,
  })) as unknown as typeof globalThis.fetch;
}

/** Build a fake fetch that returns an error status. */
function errorFetch(status: number): typeof globalThis.fetch {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
  })) as unknown as typeof globalThis.fetch;
}

/**
 * Create a fake fetch that returns a binary body (for download tests).
 * Also accepts an optional non-2xx status to test error paths.
 */
function binaryFetch(data: Buffer, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    }),
  })) as unknown as typeof globalThis.fetch;
}

/** Build a fake fetch that throws on call. */
function throwingFetch(): typeof globalThis.fetch {
  return vi.fn(async () => {
    throw new Error('network down');
  }) as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true });
  ensureDir(TEMP_ROOT);
});

afterEach(() => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true });
  vi.unstubAllGlobals();
});

// ===========================================================================
// fetchLatestRelease
// ===========================================================================

describe('fetchLatestRelease', () => {
  it('parses a valid release response', async () => {
    const release = await fetchLatestRelease(
      jsonFetch({
        tag_name: 'v1.5.2',
        assets: [
          { name: 'pingcode-cli-v1.5.2-linux-x64.zip', browser_download_url: 'https://dl/linux.zip' },
          { name: 'pingcode-cli-v1.5.2-darwin-arm64.zip', browser_download_url: 'https://dl/darwin.zip' },
        ],
      }),
    );

    expect(release).toEqual({
      tag: 'v1.5.2',
      version: '1.5.2',
      assets: [
        { name: 'pingcode-cli-v1.5.2-linux-x64.zip', browser_download_url: 'https://dl/linux.zip' },
        { name: 'pingcode-cli-v1.5.2-darwin-arm64.zip', browser_download_url: 'https://dl/darwin.zip' },
      ],
    });
  });

  it('strips leading v from tag', async () => {
    const release = await fetchLatestRelease(
      jsonFetch({ tag_name: 'v2.0.0', assets: [] }),
    );
    expect(release.version).toBe('2.0.0');
    expect(release.tag).toBe('v2.0.0');
  });

  it('handles missing v prefix', async () => {
    const release = await fetchLatestRelease(
      jsonFetch({ tag_name: '2.0.0', assets: [] }),
    );
    expect(release.version).toBe('2.0.0');
  });

  it('handles release with no assets', async () => {
    const release = await fetchLatestRelease(
      jsonFetch({ tag_name: 'v1.5.2', assets: [] }),
    );
    expect(release.assets).toEqual([]);
  });

  it('filters assets with missing fields', async () => {
    const release = await fetchLatestRelease(
      jsonFetch({
        tag_name: 'v1.5.2',
        assets: [
          { name: 'valid.zip', browser_download_url: 'https://dl/valid.zip' },
          { name: 'no-url.zip' },
          { browser_download_url: 'https://dl/no-name.zip' },
          'not-an-object',
        ],
      }),
    );
    expect(release.assets).toHaveLength(1);
    expect(release.assets[0]?.name).toBe('valid.zip');
  });

  it('throws TransportError on non-2xx', async () => {
    await expect(fetchLatestRelease(errorFetch(404))).rejects.toThrow(/HTTP 404/);
  });

  it('throws TransportError on network failure', async () => {
    await expect(fetchLatestRelease(throwingFetch())).rejects.toThrow(/failed to fetch/);
  });

  it('throws on missing tag_name', async () => {
    await expect(fetchLatestRelease(jsonFetch({ assets: [] }))).rejects.toThrow(/tag_name/);
  });

  it('throws on non-object response', async () => {
    await expect(
      fetchLatestRelease(jsonFetch('not an object') as never),
    ).rejects.toThrow(/unexpected response/);
  });
});

// ===========================================================================
// downloadReleaseAsset
// ===========================================================================

describe('downloadReleaseAsset', () => {
  it('downloads asset to file', async () => {
    const data = Buffer.from('hello world');
    const dest = path.join(tempDir('download'), 'asset.zip');
    ensureDir(path.dirname(dest));

    await downloadReleaseAsset('https://example.com/asset.zip', dest, binaryFetch(data));

    expect(readFileSync(dest).toString()).toBe('hello world');
  });

  it('throws on non-2xx response', async () => {
    const dest = path.join(tempDir('download-err'), 'asset.zip');
    const data = Buffer.from('x');
    await expect(
      downloadReleaseAsset('https://example.com/asset.zip', dest, binaryFetch(data, 500)),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws on network failure', async () => {
    const dest = path.join(tempDir('download-throw'), 'asset.zip');
    await expect(
      downloadReleaseAsset('https://example.com/asset.zip', dest, throwingFetch()),
    ).rejects.toThrow(/failed to download/);
  });

  it('cleans up partial file on write failure', async () => {
    const dest = path.join(tempDir('download-cleanup'), 'asset.zip');
    // Use a fetch that returns null body
    const nullBodyFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: null,
    })) as unknown as typeof globalThis.fetch;

    await expect(
      downloadReleaseAsset('https://example.com/asset.zip', dest, nullBodyFetch),
    ).rejects.toThrow(/empty body/);

    expect(existsSync(dest)).toBe(false);
  });
});

// ===========================================================================
// atomicReplace
// ===========================================================================

describe('atomicReplace', () => {
  it('replaces staging with install dir', async () => {
    const install = tempDir('install');
    const staging = tempDir('staging');
    ensureDir(install);
    ensureDir(staging);
    writeFileSync(path.join(install, 'old.txt'), 'old');
    writeFileSync(path.join(staging, 'new.txt'), 'new');

    await atomicReplace(install, staging);

    expect(existsSync(path.join(install, 'new.txt'))).toBe(true);
    expect(existsSync(path.join(install, 'old.txt'))).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });

  it('creates install dir when none exists', async () => {
    const install = tempDir('new-install');
    const staging = tempDir('new-staging');
    ensureDir(staging);
    writeFileSync(path.join(staging, 'bin.js'), '#!/usr/bin/env node');

    await atomicReplace(install, staging);

    expect(existsSync(path.join(install, 'bin.js'))).toBe(true);
  });

  it('removes backup on success', async () => {
    const install = tempDir('backup-install');
    const staging = tempDir('backup-staging');
    ensureDir(install);
    ensureDir(staging);
    writeFileSync(path.join(staging, 'v2.txt'), 'v2');

    await atomicReplace(install, staging);

    expect(existsSync(`${install}.backup`)).toBe(false);
  });
});

// ===========================================================================
// staging helpers
// ===========================================================================

describe('staging helpers', () => {
  it('validateStaging returns true when binary exists', () => {
    const dir = tempDir('valid-staging');
    ensureDir(path.join(dir, 'dist', 'bin'));
    writeFileSync(path.join(dir, 'dist', 'bin', 'pingcode.js'), '#!/usr/bin/env node');
    expect(validateStaging(dir)).toBe(true);
  });

  it('validateStaging returns false when binary missing', () => {
    const dir = tempDir('invalid-staging');
    ensureDir(dir);
    expect(validateStaging(dir)).toBe(false);
  });

  it('cleanStaging removes directory', () => {
    const dir = tempDir('cleanup');
    ensureDir(dir);
    writeFileSync(path.join(dir, 'file.txt'), 'x');
    expect(existsSync(dir)).toBe(true);
    cleanStaging(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('cleanStaging does nothing if directory does not exist', () => {
    expect(() => cleanStaging(tempDir('nonexistent'))).not.toThrow();
  });

  it('dirExists returns correct boolean', () => {
    const dir = tempDir('exists-check');
    ensureDir(dir);
    expect(dirExists(dir)).toBe(true);
    expect(dirExists(tempDir('nope'))).toBe(false);
  });

  it('removeFile removes file without throwing', () => {
    const file = path.join(tempDir('rm-file'), 'temp.zip');
    ensureDir(path.dirname(file));
    writeFileSync(file, 'data');
    expect(existsSync(file)).toBe(true);
    removeFile(file);
    expect(existsSync(file)).toBe(false);
  });

  it('removeFile does not throw for missing file', () => {
    expect(() => removeFile(path.join(tempDir('rm-none'), 'nope.txt'))).not.toThrow();
  });
});

// ===========================================================================
// syncSkills
// ===========================================================================

describe('syncSkills', () => {
  function setupSource(dir: string): void {
    ensureDir(dir);
    writeFileSync(path.join(dir, 'SKILL.md'), '# PingCode Skill\n');
    const modulesDir = path.join(dir, 'modules');
    ensureDir(modulesDir);
    writeFileSync(path.join(modulesDir, 'api.md'), '# API\n');
    writeFileSync(path.join(modulesDir, 'scm.md'), '# SCM\n');
    writeFileSync(path.join(modulesDir, 'testhub.md'), '# TestHub\n');
  }

  it('copies SKILL.md and modules to all targets', async () => {
    const source = tempDir('source');
    setupSource(source);

    const targets: SkillTarget[] = [
      { name: 'claude', label: 'Claude', dir: tempDir('target-claude') },
      { name: 'opencode', label: 'OpenCode', dir: tempDir('target-opencode') },
    ];

    const written = await syncSkills(source, targets);

    // SKILL.md first, then modules sorted
    expect(written).toContain(path.join(targets[0]!.dir, 'SKILL.md'));
    expect(written).toContain(path.join(targets[0]!.dir, 'modules', 'api.md'));
    expect(written).toContain(path.join(targets[0]!.dir, 'modules', 'scm.md'));
    expect(written).toContain(path.join(targets[0]!.dir, 'modules', 'testhub.md'));

    // Same files in second target
    expect(written).toContain(path.join(targets[1]!.dir, 'SKILL.md'));
    expect(written).toContain(path.join(targets[1]!.dir, 'modules', 'api.md'));
  });

  it('force-overwrites existing files', async () => {
    const source = tempDir('source-overwrite');
    setupSource(source);

    const targetDir = tempDir('target-overwrite');
    const target: SkillTarget = { name: 'claude', label: 'Claude', dir: targetDir };
    ensureDir(targetDir);
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'OLD CONTENT');

    await syncSkills(source, [target]);

    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('# PingCode Skill\n');
  });

  it('creates target directories if they do not exist', async () => {
    const source = tempDir('source-create');
    setupSource(source);

    const targetDir = path.join(tempDir('deep-nested-target'), 'nested', 'target');
    const target: SkillTarget = { name: 'claude', label: 'Claude', dir: targetDir };

    await syncSkills(source, [target]);

    expect(existsSync(path.join(targetDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(targetDir, 'modules', 'api.md'))).toBe(true);
  });

  it('ignores non-md files in modules dir', async () => {
    const source = tempDir('source-filter');
    ensureDir(source);
    writeFileSync(path.join(source, 'SKILL.md'), '# Skill\n');
    const modulesDir = path.join(source, 'modules');
    ensureDir(modulesDir);
    writeFileSync(path.join(modulesDir, 'api.md'), '# API\n');
    writeFileSync(path.join(modulesDir, 'image.png'), 'not-markdown');
    writeFileSync(path.join(modulesDir, 'data.json'), '{}');

    const target: SkillTarget = { name: 'claude', label: 'Claude', dir: tempDir('filter-target') };
    const written = await syncSkills(source, [target]);

    const basenames = written.map((p) => path.basename(p));
    expect(basenames).not.toContain('image.png');
    expect(basenames).not.toContain('data.json');
    expect(basenames).toContain('api.md');
  });
});

// ===========================================================================
// verifyInstall
// ===========================================================================

describe('verifyInstall', () => {
  it('returns version output on success', () => {
    const dir = tempDir('verify-ok');
    ensureDir(path.join(dir, 'dist', 'bin'));
    writeFileSync(path.join(dir, 'dist', 'bin', 'pingcode.js'), '#!/usr/bin/env node');

    const mockExec = () => '1.5.2\n';
    const result = verifyInstall(dir, mockExec);
    expect(result).toBe('1.5.2');
  });

  it('throws TransportError when binary fails', () => {
    const dir = tempDir('verify-fail');
    ensureDir(path.join(dir, 'dist', 'bin'));
    writeFileSync(path.join(dir, 'dist', 'bin', 'pingcode.js'), 'bad');

    const mockExec = (): never => {
      throw new Error('spawn ENOENT');
    };

    expect(() => verifyInstall(dir, mockExec)).toThrow(/failed to verify/);
  });
});
