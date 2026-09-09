import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillTarget } from '../src/core/paths';
import {
  acquireLock,
  atomicReplace,
  cleanStaging,
  dirExists,
  downloadTarball,
  fetchLatestInfo,
  isCooldownActive,
  readHint,
  removeFile,
  removeHint,
  runAutoUpdate,
  syncSkills,
  touchCooldown,
  validateStaging,
  verifyInstall,
  writeHint,
  type ExecFn,
} from '../src/core/update';
import { VERSION } from '../src/version';

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
// fetchLatestInfo
// ===========================================================================

describe('fetchLatestInfo', () => {
  it('parses a valid registry response', async () => {
    const info = await fetchLatestInfo(
      jsonFetch({
        'dist-tags': { latest: '1.5.2' },
        versions: {
          '1.5.2': { dist: { tarball: 'https://registry.npmjs.org/package-1.5.2.tgz' } },
        },
      }),
    );

    expect(info).toEqual({
      version: '1.5.2',
      tarballUrl: 'https://registry.npmjs.org/package-1.5.2.tgz',
    });
  });

  it('returns the latest version from dist-tags', async () => {
    const info = await fetchLatestInfo(
      jsonFetch({
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '2.0.0': { dist: { tarball: 'https://registry.npmjs.org/package-2.0.0.tgz' } },
        },
      }),
    );

    expect(info.version).toBe('2.0.0');
    expect(info.tarballUrl).toBe('https://registry.npmjs.org/package-2.0.0.tgz');
  });

  it('throws on missing dist-tags', async () => {
    await expect(fetchLatestInfo(jsonFetch({}))).rejects.toThrow(/dist-tags/);
  });

  it('throws TransportError on non-2xx', async () => {
    await expect(fetchLatestInfo(errorFetch(404))).rejects.toThrow(/npm registry returned HTTP 404/);
  });

  it('throws TransportError on network failure', async () => {
    await expect(fetchLatestInfo(throwingFetch())).rejects.toThrow(/failed to fetch npm registry/);
  });

  it('throws on non-object response', async () => {
    await expect(
      fetchLatestInfo(jsonFetch('not an object') as never),
    ).rejects.toThrow(/registry response missing dist-tags/);
  });

  it('throws on missing versions', async () => {
    await expect(
      fetchLatestInfo(
        jsonFetch({
          'dist-tags': { latest: '1.0.0' },
        }) as never,
      ),
    ).rejects.toThrow(/registry response missing versions/);
  });
});

// ===========================================================================
// downloadTarball
// ===========================================================================

describe('downloadTarball', () => {
  it('returns buffer on success', async () => {
    const data = Buffer.from('hello world');
    const result = await downloadTarball('https://example.com/package.tgz', binaryFetch(data));

    expect(result.toString()).toBe('hello world');
  });

  it('throws on non-2xx response', async () => {
    const data = Buffer.from('x');
    await expect(
      downloadTarball('https://example.com/package.tgz', binaryFetch(data, 500)),
    ).rejects.toThrow(/tarball download returned HTTP 500/);
  });

  it('throws on network failure', async () => {
    await expect(
      downloadTarball('https://example.com/package.tgz', throwingFetch()),
    ).rejects.toThrow(/failed to download tarball/);
  });

  it('throws on empty body', async () => {
    const nullBodyFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: null,
    })) as unknown as typeof globalThis.fetch;

    await expect(
      downloadTarball('https://example.com/package.tgz', nullBodyFetch),
    ).rejects.toThrow(/tarball download returned empty body/);
  });

  it('enforces maximum tarball size', async () => {
    const oversizedChunk = Buffer.alloc(51 * 1024 * 1024); // 51 MB
    const oversizedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(oversizedChunk));
          controller.close();
        },
      }),
    })) as unknown as typeof globalThis.fetch;

    await expect(
      downloadTarball('https://example.com/package.tgz', oversizedFetch),
    ).rejects.toThrow(/tarball exceeds maximum size/);
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

  it('handles staging nested under install dir', async () => {
    // When staging is `install/.staging`, the old code would rename
    // `install` → `install.backup` (carrying `.staging` along), then fail
    // to find the staging directory. The fix moves staging aside first.
    const install = tempDir('nested-install');
    const staging = path.join(install, '.staging');
    ensureDir(install);
    ensureDir(staging);
    writeFileSync(path.join(install, 'old.txt'), 'old');
    writeFileSync(path.join(staging, 'new.txt'), 'new');

    await atomicReplace(install, staging);

    expect(existsSync(path.join(install, 'new.txt'))).toBe(true);
    expect(existsSync(path.join(install, 'old.txt'))).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(`${install}.backup`)).toBe(false);
    expect(existsSync(`${install}.incoming`)).toBe(false);
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
    for (const t of targets) ensureDir(t.dir);

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

  it('skips targets whose skill directory does not exist', async () => {
    const source = tempDir('source-skip');
    setupSource(source);

    // target dir does NOT exist on disk
    const targetDir = path.join(tempDir('nonexistent-target'), 'skills', 'pingcode');
    const target: SkillTarget = { name: 'claude', label: 'Claude', dir: targetDir };

    const written = await syncSkills(source, [target]);

    // Nothing written, nothing created
    expect(written).toHaveLength(0);
    expect(existsSync(targetDir)).toBe(false);
  });

  it('only syncs to targets that already exist, skipping the rest', async () => {
    const source = tempDir('source-mixed');
    setupSource(source);

    const existingDir = tempDir('target-exists');
    ensureDir(existingDir);
    const missingDir = path.join(tempDir('target-missing'), 'nested', 'skills');

    const targets: SkillTarget[] = [
      { name: 'claude', label: 'Claude', dir: existingDir },
      { name: 'opencode', label: 'OpenCode', dir: missingDir },
    ];

    const written = await syncSkills(source, targets);

    // Only wrote to the existing target
    expect(written).toContain(path.join(existingDir, 'SKILL.md'));
    expect(written).not.toContain(path.join(missingDir, 'SKILL.md'));
    expect(existsSync(missingDir)).toBe(false);
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

    const targetDir = tempDir('filter-target');
    ensureDir(targetDir);
    const target: SkillTarget = { name: 'claude', label: 'Claude', dir: targetDir };
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

// ===========================================================================
// acquireLock
// ===========================================================================

describe('acquireLock', () => {
  it('acquires when no lock file exists', () => {
    const dir = tempDir('lock-new');
    ensureDir(dir);

    const lock = acquireLock(dir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(path.join(dir, 'update.lock'))).toBe(true);

    lock.release();
    expect(existsSync(path.join(dir, 'update.lock'))).toBe(false);
  });

  it('fails when lock file exists with alive PID', () => {
    const dir = tempDir('lock-alive');
    ensureDir(dir);
    writeFileSync(path.join(dir, 'update.lock'), String(process.pid));

    const lock = acquireLock(dir);
    expect(lock.acquired).toBe(false);
  });

  it('steals lock when holder PID is dead', () => {
    const dir = tempDir('lock-dead');
    ensureDir(dir);
    writeFileSync(path.join(dir, 'update.lock'), '999999');

    const lock = acquireLock(dir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(path.join(dir, 'update.lock'))).toBe(true);

    lock.release();
    expect(existsSync(path.join(dir, 'update.lock'))).toBe(false);
  });

  it('release() removes the lock file', () => {
    const dir = tempDir('lock-release');
    ensureDir(dir);

    const lock = acquireLock(dir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(path.join(dir, 'update.lock'))).toBe(true);

    lock.release();
    expect(existsSync(path.join(dir, 'update.lock'))).toBe(false);
  });
});

// ===========================================================================
// isCooldownActive / touchCooldown
// ===========================================================================

describe('isCooldownActive / touchCooldown', () => {
  it('returns false when cooldown file does not exist', () => {
    const dir = tempDir('cooldown-none');
    ensureDir(dir);
    expect(isCooldownActive(dir)).toBe(false);
  });

  it('returns true after touchCooldown()', () => {
    const dir = tempDir('cooldown-active');
    ensureDir(dir);
    touchCooldown(dir);
    expect(isCooldownActive(dir)).toBe(true);
  });

  it('returns false when cooldown file mtime is older than threshold', () => {
    const dir = tempDir('cooldown-old');
    ensureDir(dir);
    touchCooldown(dir);
    // Set mtime to 20 minutes ago
    const past = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(path.join(dir, 'auto-update-check'), past, past);
    expect(isCooldownActive(dir, 1000)).toBe(false);
  });
});

// ===========================================================================
// readHint / writeHint / removeHint
// ===========================================================================

describe('readHint / writeHint / removeHint', () => {
  it('writeHint creates file with { version } JSON', () => {
    const dir = tempDir('hint-write');
    ensureDir(dir);
    writeHint(dir, '1.6.3');

    const raw = JSON.parse(readFileSync(path.join(dir, 'update-available'), 'utf8'));
    expect(raw).toEqual({ version: '1.6.3' });
  });

  it('readHint returns parsed version', () => {
    const dir = tempDir('hint-read');
    ensureDir(dir);
    writeHint(dir, '1.6.3');

    expect(readHint(dir)).toEqual({ version: '1.6.3' });
  });

  it('readHint returns undefined for missing file', () => {
    const dir = tempDir('hint-missing');
    ensureDir(dir);
    expect(readHint(dir)).toBeUndefined();
  });

  it('readHint returns undefined for corrupt file', () => {
    const dir = tempDir('hint-corrupt');
    ensureDir(dir);
    writeFileSync(path.join(dir, 'update-available'), 'not json');

    expect(readHint(dir)).toBeUndefined();
  });

  it('removeHint removes the file', () => {
    const dir = tempDir('hint-remove');
    ensureDir(dir);
    writeHint(dir, '1.6.3');
    expect(existsSync(path.join(dir, 'update-available'))).toBe(true);

    removeHint(dir);
    expect(existsSync(path.join(dir, 'update-available'))).toBe(false);
  });

  it('removeHint is no-op if file is missing', () => {
    const dir = tempDir('hint-remove-missing');
    ensureDir(dir);
    expect(() => removeHint(dir)).not.toThrow();
  });
});

// ===========================================================================
// runAutoUpdate
// ===========================================================================

describe('runAutoUpdate', () => {
  function makeEnv(): Record<string, string | undefined> {
    return {
      PINGCODE_CONFIG_DIR: tempDir('rau-config'),
      XDG_DATA_HOME: tempDir('rau-data'),
    };
  }

  const mockExec: ExecFn = (_file: string, _args: string[]) => {
    throw new Error('exec should not be called in this test');
  };

  it('returns up-to-date when local version >= remote', async () => {
    const env = makeEnv();
    const result = await runAutoUpdate(
      env,
      jsonFetch({
        'dist-tags': { latest: VERSION },
        versions: {
          [VERSION]: { dist: { tarball: 'https://example.com/package.tgz' } },
        },
      }),
      mockExec,
    );
    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('returns failed when lock not acquired', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;
    ensureDir(configDir);
    writeFileSync(path.join(configDir, 'update.lock'), String(process.pid));

    const result = await runAutoUpdate(
      env,
      jsonFetch({
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '2.0.0': { dist: { tarball: 'https://example.com/package.tgz' } },
        },
      }),
      mockExec,
    );
    expect(result).toEqual({ status: 'failed', error: 'update already in progress' });
  });

  it('writes hint file on download failure', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;

    let callIndex = 0;
    const mixedFetch = vi.fn(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            'dist-tags': { latest: '2.0.0' },
            versions: {
              '2.0.0': { dist: { tarball: 'https://example.com/package.tgz' } },
            },
          }),
        } as Response;
      }
      return errorFetch(500) as unknown as Response;
    });

    const result = await runAutoUpdate(env, mixedFetch, mockExec);
    expect(result.status).toBe('failed');
    expect(readHint(configDir)).toEqual({ version: '2.0.0' });
  });

  it('removes hint file on up-to-date', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;
    ensureDir(configDir);
    writeHint(configDir, '2.0.0');

    const result = await runAutoUpdate(
      env,
      jsonFetch({
        'dist-tags': { latest: VERSION },
        versions: {
          [VERSION]: { dist: { tarball: 'https://example.com/package.tgz' } },
        },
      }),
      mockExec,
    );
    expect(result).toEqual({ status: 'up-to-date' });
    expect(readHint(configDir)).toBeUndefined();
  });

  it('touches cooldown on every call', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;

    await runAutoUpdate(
      env,
      jsonFetch({
        'dist-tags': { latest: VERSION },
        versions: {
          [VERSION]: { dist: { tarball: 'https://example.com/package.tgz' } },
        },
      }),
      mockExec,
    );
    expect(isCooldownActive(configDir)).toBe(true);
  });
});
