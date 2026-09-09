import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillTarget } from '../src/core/paths';
import {
  acquireLock,
  dirExists,
  fetchLatestInfo,
  isCooldownActive,
  packageSkillDir,
  readHint,
  removeFile,
  removeHint,
  runAutoUpdate,
  syncSkills,
  touchCooldown,
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

/** Build a fake fetch that throws on call. */
function throwingFetch(): typeof globalThis.fetch {
  return vi.fn(async () => {
    throw new Error('network down');
  }) as unknown as typeof globalThis.fetch;
}

/** Env pointing at throwaway config + data dirs. */
function makeEnv(): Record<string, string | undefined> {
  return {
    PINGCODE_CONFIG_DIR: tempDir('rau-config'),
    XDG_DATA_HOME: tempDir('rau-data'),
  };
}

/** A registry response advertising `version` as latest. */
function registryFor(version: string): unknown {
  return {
    'dist-tags': { latest: version },
    versions: {
      [version]: { dist: { tarball: `https://example.com/pingcode-cli-unofficial-${version}.tgz` } },
    },
  };
}

/** An exec that must never be reached by the caller. */
const explodingExec: ExecFn = () => {
  throw new Error('exec should not be called in this test');
};

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
// small filesystem helpers
// ===========================================================================

describe('filesystem helpers', () => {
  it('dirExists returns correct boolean', () => {
    const dir = tempDir('exists-check');
    ensureDir(dir);
    expect(dirExists(dir)).toBe(true);
    expect(dirExists(tempDir('nope'))).toBe(false);
  });

  it('removeFile removes file without throwing', () => {
    const file = path.join(tempDir('rm-file'), 'update.lock');
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

    expect(written).toContain(path.join(targets[0]!.dir, 'SKILL.md'));
    expect(written).toContain(path.join(targets[0]!.dir, 'modules', 'api.md'));
    expect(written).toContain(path.join(targets[0]!.dir, 'modules', 'scm.md'));
    expect(written).toContain(path.join(targets[0]!.dir, 'modules', 'testhub.md'));
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

    const targetDir = path.join(tempDir('nonexistent-target'), 'skills', 'pingcode');
    const target: SkillTarget = { name: 'claude', label: 'Claude', dir: targetDir };

    const written = await syncSkills(source, [target]);

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

  /**
   * prd R6: with no install directory the skills come from the package itself,
   * resolved relative to the running module — the npm tarball still ships
   * `skills/`, so the payload is present, only the lookup moved.
   */
  it('resolves the skill source to the package directory, not an install dir', () => {
    const source = packageSkillDir();
    expect(source).toMatch(/skills[\\/]pingcode$/);
    // The repository's own skill payload is what an update will sync from.
    expect(existsSync(path.join(source, 'SKILL.md'))).toBe(true);
    // And it is genuinely outside any install directory.
    expect(source).not.toContain('.local');
    expect(source).not.toContain('.staging');
  });

  it('syncs from the package directory into a target', async () => {
    const targetDir = tempDir('package-sync-target');
    ensureDir(targetDir);
    const target: SkillTarget = { name: 'claude', label: 'Claude', dir: targetDir };

    const written = await syncSkills(packageSkillDir(), [target]);

    expect(written).toContain(path.join(targetDir, 'SKILL.md'));
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8').length).toBeGreaterThan(0);
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
  it('returns up-to-date when local version >= remote', async () => {
    const result = await runAutoUpdate(makeEnv(), jsonFetch(registryFor(VERSION)), explodingExec);
    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('returns failed when lock not acquired', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;
    ensureDir(configDir);
    writeFileSync(path.join(configDir, 'update.lock'), String(process.pid));

    const result = await runAutoUpdate(env, jsonFetch(registryFor('2.0.0')), explodingExec);
    expect(result).toEqual({ status: 'failed', error: 'update already in progress' });
  });

  it('writes hint file when the install fails', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;

    const exec: ExecFn = () => {
      throw new Error('npm install --global pingcode-cli-unofficial@2.0.0 failed');
    };
    const result = await runAutoUpdate(env, jsonFetch(registryFor('2.0.0')), exec);

    expect(result.status).toBe('failed');
    expect(readHint(configDir)).toEqual({ version: '2.0.0' });
  });

  it('removes hint file on up-to-date', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;
    ensureDir(configDir);
    writeHint(configDir, '2.0.0');

    const result = await runAutoUpdate(makeEnv(), jsonFetch(registryFor(VERSION)), explodingExec);

    expect(result).toEqual({ status: 'up-to-date' });
    expect(readHint(configDir)).toBeUndefined();
  });

  it('touches cooldown on every call', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;

    await runAutoUpdate(env, jsonFetch(registryFor(VERSION)), explodingExec);

    expect(isCooldownActive(configDir)).toBe(true);
  });

  it('releases the lock when the install throws', async () => {
    const env = makeEnv();
    const configDir = env.PINGCODE_CONFIG_DIR!;

    const exec: ExecFn = () => {
      throw new Error('npm exploded');
    };
    await runAutoUpdate(env, jsonFetch(registryFor('2.0.0')), exec);

    expect(existsSync(path.join(configDir, 'update.lock'))).toBe(false);
  });
});

/**
 * The invariant, stated as a test: `updated` is reachable only through
 * `installViaNpm`, which re-reads the installed version. So the shapes below are
 * the ones that must never appear — no download, no staging directory, and no
 * claim of success on a path that did not install.
 */
describe('runAutoUpdate — npm delegation', () => {
  const REMOTE = '9.9.9';

  /**
   * `installViaNpm` proves success by reading back the installed version, and the
   * only version it can ever read back in this environment is the running one
   * (`VERSION`). `runAutoUpdate` only reaches npm when the remote is *newer* than
   * that, so its happy path is structurally unreachable here — it is covered at
   * the `installViaNpm` level in `test/core/npm-install.test.ts`. What these
   * tests pin is the delegation shape and every way it can go wrong.
   */
  it('does not spawn npm when already up to date', async () => {
    const env = makeEnv();
    let spawned = false;
    const exec: ExecFn = () => {
      spawned = true;
      return '';
    };

    const result = await runAutoUpdate(env, jsonFetch(registryFor(VERSION)), exec);

    expect(result).toEqual({ status: 'up-to-date' });
    expect(spawned).toBe(false);
  });

  it('reaches npm with the requested version, and refuses because the read-back cannot match', async () => {
    const env = makeEnv();
    const calls: string[][] = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, ...args]);
      return '';
    };

    const result = await runAutoUpdate(env, jsonFetch(registryFor(REMOTE)), exec);

    // The install was attempted, correctly addressed...
    expect(calls).toEqual([
      [
        path.join(path.dirname(process.execPath), 'npm'),
        'install',
        '--global',
        `pingcode-cli-unofficial@${REMOTE}`,
      ],
    ]);
    // ...and it did not claim success, because the version on disk is not REMOTE.
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('version');
    if (result.status === 'failed') {
      expect(result.error).toMatch(new RegExp(`exited 0 but the installed version is .* expected ${REMOTE}`));
    }
  });

  it('never downloads a tarball and never creates a .staging directory', async () => {
    const env = makeEnv();
    const urls: string[] = [];
    const exec: ExecFn = () => '';

    // Count and record every request. The registry metadata call is the only
    // one there should be — a tarball download would mean the old path came back.
    const trackingFetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return (await jsonFetch(registryFor(REMOTE))(input as string)) as Response;
    }) as unknown as typeof globalThis.fetch;

    const result = await runAutoUpdate(env, trackingFetch, exec);

    // The remote is newer, so npm runs — and then refuses, because the read-back
    // cannot match in a test environment. Either way: one HTTP call, no staging.
    expect(result.status).toBe('failed');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('registry.npmjs.org');

    const installRoot = path.join(env.XDG_DATA_HOME!, 'pingcode-cli');
    expect(existsSync(path.join(installRoot, '.staging'))).toBe(false);
    expect(existsSync(installRoot)).toBe(false);
  });

  it('does not report updated when npm exits non-zero', async () => {
    const env = makeEnv();
    const exec: ExecFn = () => {
      throw new Error('npm ERR! code EACCES');
    };

    const result = await runAutoUpdate(env, jsonFetch(registryFor(REMOTE)), exec);

    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('version');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/npm ERR! code EACCES/);
    }
  });

  it('does not report updated when npm exits 0 but the version does not match', async () => {
    const env = makeEnv();
    // npm "succeeds" — but the requested version is not what is on disk.
    const exec: ExecFn = () => 'added 1 package';

    const result = await runAutoUpdate(env, jsonFetch(registryFor(REMOTE)), exec);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(new RegExp(`exited 0 but the installed version is .* expected ${REMOTE}`));
    }
  });

  it('does not report updated when npm cannot be found', async () => {
    const env = makeEnv();
    const exec: ExecFn = () => '';

    // Point `process.execPath` at a directory with no npm sibling.
    const realExecPath = process.execPath;
    process.execPath = tempDir('no-npm-here');
    ensureDir(process.execPath);
    try {
      const result = await runAutoUpdate(env, jsonFetch(registryFor(REMOTE)), exec);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/no npm binary found/);
      }
    } finally {
      process.execPath = realExecPath;
    }
  });
});
