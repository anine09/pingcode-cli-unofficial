import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installViaNpm,
  readInstalledVersion,
  resolveNpm,
  runAutoUpdate,
  syncSkills,
  packageSkillDir,
} from '../../src/core/update';
import { checkForUpdate } from '../../src/core/update-check';
import type { ExecFn } from '../../src/core/update';
import { TransportError } from '../../src/core/errors';
import type { SkillTarget } from '../../src/core/paths';
import { VERSION } from '../../src/version';

/**
 * `self-update` is a version check plus one npm invocation.
 *
 * The bug that started this was never "it picked the wrong directory" — it was
 * **reporting success without having succeeded**. So every case here asserts the
 * negative as hard as the positive: for each way the install can go wrong, the
 * result must carry no `updated`.
 */

const TEMP_ROOT = path.join(import.meta.dirname ?? '.', '.tmp-npm-install');

/** A directory that looks like a node bin dir, optionally holding an npm sibling. */
function fakeBinDir(name: string, withNpm = true, windowsNpm = false): string {
  const dir = path.join(TEMP_ROOT, name);
  mkdirSync(dir, { recursive: true });
  if (withNpm) {
    const target = windowsNpm ? path.join(dir, 'npm.cmd') : path.join(dir, 'npm');
    writeFileSync(target, '#!/bin/sh\n');
  }
  return dir;
}

/** Point `resolveNpm` at a synthetic bin dir for the duration of `fn`. */
async function withExecPath<T>(binDir: string, fn: () => T | Promise<T>): Promise<T> {
  const real = process.execPath;
  process.execPath = path.join(binDir, 'node');
  try {
    return await fn();
  } finally {
    process.execPath = real;
  }
}

beforeEach(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// resolveNpm
// ---------------------------------------------------------------------------

describe('resolveNpm', () => {
  it('resolves npm as the sibling of the running node binary', async () => {
    const binDir = fakeBinDir('posix');

    await withExecPath(binDir, () => {
      expect(resolveNpm()).toBe(path.join(binDir, 'npm'));
    });
  });

  it('returns undefined when the sibling is absent', async () => {
    const binDir = fakeBinDir('empty', false);

    await withExecPath(binDir, () => {
      expect(resolveNpm()).toBeUndefined();
    });
  });

  /**
   * The one platform-sensitive decision in this change. On Windows npm is
   * installed as `npm.cmd`; a bare `npm` there is either a shell shim without an
   * extension or a Unix lookalike, and only `.cmd` is directly spawnable. So
   * win32 prefers `npm.cmd` and still falls back to `npm` if that is all a
   * given environment ships.
   */
  it('prefers npm.cmd on win32, falling back to a bare npm', async () => {
    const cmdOnly = fakeBinDir('win-cmd', true, true);
    await withExecPath(cmdOnly, () => {
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        expect(resolveNpm()).toBe(path.join(cmdOnly, 'npm.cmd'));
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
    });

    const bareOnly = fakeBinDir('win-bare');
    await withExecPath(bareOnly, () => {
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        expect(resolveNpm()).toBe(path.join(bareOnly, 'npm'));
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
    });
  });

  it('is undefined when neither sibling exists on win32', async () => {
    const binDir = fakeBinDir('win-none', false);
    await withExecPath(binDir, () => {
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        expect(resolveNpm()).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// readInstalledVersion
// ---------------------------------------------------------------------------

describe('readInstalledVersion', () => {
  it('reads the version of the running package', () => {
    // The running module is the package itself, so this is the version npm just
    // wrote to that directory on disk.
    expect(readInstalledVersion()).toBe(VERSION);
  });
});

// ---------------------------------------------------------------------------
// installViaNpm — the invariant
// ---------------------------------------------------------------------------

describe('installViaNpm', () => {
  it('spawns npm install --global <package>@<version>', async () => {
    const binDir = fakeBinDir('spawn');
    const calls: string[][] = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, ...args]);
      return '';
    };

    await withExecPath(binDir, () => installViaNpm(exec, VERSION));

    expect(calls).toEqual([
      [path.join(binDir, 'npm'), 'install', '--global', `pingcode-cli-unofficial@${VERSION}`],
    ]);
  });

  it('resolves when npm exits 0 and the installed version matches', async () => {
    const binDir = fakeBinDir('ok');
    // `readInstalledVersion()` is VERSION here, so installing VERSION is the
    // verified-success case.
    await expect(withExecPath(binDir, () => installViaNpm(() => '', VERSION))).resolves.toBeUndefined();
  });

  it('refuses when npm cannot be found, naming the path it tried', async () => {
    const binDir = fakeBinDir('missing', false);

    await expect(
      withExecPath(binDir, () => installViaNpm(() => '', VERSION)),
    ).rejects.toThrow(new RegExp(`no npm binary found.*${path.join(binDir, 'npm')}`, 's'));
  });

  it('does not spawn anything when npm cannot be found', async () => {
    const binDir = fakeBinDir('missing-nospawn', false);
    let spawned = false;
    const exec: ExecFn = () => {
      spawned = true;
      return '';
    };

    await expect(withExecPath(binDir, () => installViaNpm(exec, VERSION))).rejects.toThrow();
    expect(spawned).toBe(false);
  });

  it('refuses on a non-zero exit and attaches npm output', async () => {
    const binDir = fakeBinDir('nonzero');
    const error = Object.assign(new Error('Command failed'), {
      status: 1,
      stderr: 'npm ERR! code EACCES\nnpm ERR! syscall open',
      stdout: '',
    });
    const exec: ExecFn = () => {
      throw error;
    };

    // The message carries the exit status; npm's own output goes in the hint,
    // which `runSelfUpdate` renders after the message. Both must survive.
    let thrown: unknown;
    try {
      await withExecPath(binDir, () => installViaNpm(exec, VERSION));
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(TransportError);
    const err = thrown as TransportError;
    expect(err.message).toMatch(/failed \(exit 1\)/);
    expect(err.hint).toContain('npm ERR! code EACCES');
  });

  /**
   * The third failure mode, and the reason this module exists. npm exiting 0
   * proves nothing about what landed on disk — a wrapper, a proxy or a silent
   * no-op all produce exit 0. Only the read-back proves the install.
   */
  it('refuses when npm exits 0 but the installed version does not match, naming both', async () => {
    const binDir = fakeBinDir('wrongversion');

    await expect(withExecPath(binDir, () => installViaNpm(() => 'added 1 package', '0.0.0-nowhere')))
      .rejects.toThrow(/exited 0 but the installed version is .* expected 0\.0\.0-nowhere/);
  });

  it('refuses when npm exits 0 and the installed version is unreadable', async () => {
    const binDir = fakeBinDir('unreadable');

    // A version that cannot match, so the read-back branch is reached even if
    // `readInstalledVersion` ever returned undefined.
    await expect(withExecPath(binDir, () => installViaNpm(() => '', '9.9.9')))
      .rejects.toThrow(/exited 0 but the installed version is .* expected 9\.9\.9/);
  });
});

// ---------------------------------------------------------------------------
// runAutoUpdate — delegation, and the shapes that must never appear
// ---------------------------------------------------------------------------

describe('runAutoUpdate — npm delegation', () => {
  const REMOTE = '8.8.8';

  function registry(version: string): typeof globalThis.fetch {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        'dist-tags': { latest: version },
        versions: { [version]: { dist: { tarball: `https://example.com/x-${version}.tgz` } } },
      }),
    })) as unknown as typeof globalThis.fetch;
  }

  it('does not spawn npm when the remote is not newer', async () => {
    const env = {
      PINGCODE_CONFIG_DIR: path.join(TEMP_ROOT, 'cfg-uptodate'),
      XDG_DATA_HOME: path.join(TEMP_ROOT, 'data-uptodate'),
    };
    let spawned = false;
    const exec: ExecFn = () => {
      spawned = true;
      return '';
    };

    const result = await runAutoUpdate(env, registry(VERSION), exec);

    expect(result).toEqual({ status: 'up-to-date' });
    expect(spawned).toBe(false);
  });

  it('reaches npm with the requested version, then refuses because the read-back cannot match', async () => {
    const env = {
      PINGCODE_CONFIG_DIR: path.join(TEMP_ROOT, 'cfg-npm'),
      XDG_DATA_HOME: path.join(TEMP_ROOT, 'data-npm'),
    };
    const calls: string[][] = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, ...args]);
      return '';
    };

    const result = await runAutoUpdate(env, registry(REMOTE), exec);

    // The install was attempted, correctly addressed — the whole point of the
    // delegation is that *this* is the command npm receives.
    expect(calls).toEqual([
      [
        path.join(path.dirname(process.execPath), 'npm'),
        'install',
        '--global',
        `pingcode-cli-unofficial@${REMOTE}`,
      ],
    ]);
    // And it did not claim success: the version on disk is VERSION, not REMOTE.
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('version');
    if (result.status === 'failed') {
      expect(result.error).toMatch(new RegExp(`exited 0 but the installed version is .* expected ${REMOTE}`));
    }
  });

  it('never downloads a tarball and never creates a .staging directory', async () => {
    const env = {
      PINGCODE_CONFIG_DIR: path.join(TEMP_ROOT, 'cfg-nodl'),
      XDG_DATA_HOME: path.join(TEMP_ROOT, 'data-nodl'),
    };
    const fetched: string[] = [];
    const exec: ExecFn = () => '';

    // Count and record every request. The registry metadata call is the only one
    // there should be — a tarball download would mean the old path came back.
    const tracking = vi.fn(async (input: unknown) => {
      fetched.push(String(input));
      return (await registry(REMOTE)(input as string)) as Response;
    }) as unknown as typeof globalThis.fetch;

    const result = await runAutoUpdate(env, tracking, exec);

    // The remote is newer so npm runs, then refuses because the read-back cannot
    // match in a test environment. Either way: one HTTP call, no staging dir.
    expect(result.status).toBe('failed');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('registry.npmjs.org');
    expect(existsSync(path.join(env.XDG_DATA_HOME, 'pingcode-cli'))).toBe(false);
  });

  it('never reports updated when npm is missing', async () => {
    const env = {
      PINGCODE_CONFIG_DIR: path.join(TEMP_ROOT, 'cfg-nonpm'),
      XDG_DATA_HOME: path.join(TEMP_ROOT, 'data-nonpm'),
    };
    const binDir = fakeBinDir('nonpm', false);
    const exec: ExecFn = () => '';

    const result = await withExecPath(binDir, () => runAutoUpdate(env, registry(REMOTE), exec));

    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('version');
  });

  it('still honours lock, cooldown and hint on the npm path', async () => {
    const env = {
      PINGCODE_CONFIG_DIR: path.join(TEMP_ROOT, 'cfg-shell'),
      XDG_DATA_HOME: path.join(TEMP_ROOT, 'data-shell'),
    };
    mkdirSync(env.PINGCODE_CONFIG_DIR, { recursive: true });

    // Lock held by a live PID → no install is attempted at all.
    writeFileSync(path.join(env.PINGCODE_CONFIG_DIR, 'update.lock'), String(process.pid));
    let spawned = false;
    const exec: ExecFn = () => {
      spawned = true;
      return '';
    };

    const locked = await runAutoUpdate(env, registry(REMOTE), exec);
    expect(locked).toEqual({ status: 'failed', error: 'update already in progress' });
    expect(spawned).toBe(false);

    // With the lock free, a failing install still writes the hint and releases it.
    rmSync(path.join(env.PINGCODE_CONFIG_DIR, 'update.lock'));
    const failing: ExecFn = () => {
      throw new Error('npm ERR! code EACCES');
    };
    const failed = await runAutoUpdate(env, registry(REMOTE), failing);
    expect(failed.status).toBe('failed');
    expect(existsSync(path.join(env.PINGCODE_CONFIG_DIR, 'update.lock'))).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(env.PINGCODE_CONFIG_DIR, 'update-available'), 'utf8')),
    ).toEqual({ version: REMOTE });
  });
});

// ---------------------------------------------------------------------------
// --check-only stays npm-free (prd R3)
// ---------------------------------------------------------------------------

describe('check-only stays npm-free', () => {
  /**
   * prd R3: `--check-only` is plain HTTP against the registry and must work on a
   * machine with no npm at all. The opt-out env var makes this deterministic and
   * network-free: the check short-circuits before any request, so the only thing
   * under test is that it reached an answer while `resolveNpm()` was undefined.
   */
  it('--check-only succeeds with no npm binary present at all', async () => {
    const binDir = fakeBinDir('checkonly', false);

    await withExecPath(binDir, async () => {
      // The seam is explicit: no npm on this box.
      expect(resolveNpm()).toBeUndefined();

      const result = await checkForUpdate(
        { PINGCODE_NO_UPDATE_CHECK: '1' },
        { skipCache: true },
      );

      expect(result).toEqual({ status: 'skipped' });
    });
  });
});

// ---------------------------------------------------------------------------
// skills come from the package directory (prd R6)
// ---------------------------------------------------------------------------

describe('syncSkills reads from the package directory', () => {
  it('resolves skills/pingcode relative to the running module', () => {
    const source = packageSkillDir();
    expect(source).toMatch(/skills[\\/]pingcode$/);
    expect(existsSync(path.join(source, 'SKILL.md'))).toBe(true);
    // Not an install directory, and not staging.
    expect(source).not.toContain('.staging');
  });

  it('copies the package skill payload into a target dir', async () => {
    const target: SkillTarget = {
      name: 'claude',
      label: 'Claude',
      dir: path.join(TEMP_ROOT, 'skill-target'),
    };
    mkdirSync(target.dir, { recursive: true });

    const written = await syncSkills(packageSkillDir(), [target]);

    expect(written).toContain(path.join(target.dir, 'SKILL.md'));
    expect(readFileSync(path.join(target.dir, 'SKILL.md'), 'utf8').length).toBeGreaterThan(0);
  });
});
