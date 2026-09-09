import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreBackup, verifyBundle } from '../src/core/update';
import { TransportError } from '../src/core/errors';
import type { ExecFn } from '../src/core/update';

/**
 * Unit coverage for the two new `core/update.ts` primitives that make the
 * self-update safe: proving a bundle *runs* (and reports the version we asked
 * for), and putting the previous install back when it does not.
 *
 * These are the pieces the 1.8.1/1.8.2 bug needed and did not have: the shipped
 * tarball has no `node_modules/`, so "the file exists" was never proof the
 * binary could start, and the rollback path rolled back onto a backup that had
 * already been deleted.
 */

const TEMP_ROOT = path.join(import.meta.dirname ?? '.', '.tmp-update-artifact');

function tempDir(name: string): string {
  return path.join(TEMP_ROOT, name);
}

/** A directory shaped like an install dir, with a bin at the expected path. */
function installWithBundle(dir: string, content = '#!/usr/bin/env node'): string {
  const bin = path.join(dir, 'dist', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'pingcode.js'), content);
  return dir;
}

beforeEach(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// verifyBundle
// ---------------------------------------------------------------------------

describe('verifyBundle', () => {
  const EXPECTED = '1.8.3';

  it('returns the trimmed version output', () => {
    const dir = installWithBundle(tempDir('ok'));

    const exec: ExecFn = () => `${EXPECTED}\n`;
    expect(verifyBundle(dir, exec, EXPECTED)).toBe(EXPECTED);
  });

  it('runs `node <dir>/dist/bin/pingcode.js --version`', () => {
    const dir = installWithBundle(tempDir('args'));
    const calls: string[][] = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, ...args]);
      return `${EXPECTED}\n`;
    };

    verifyBundle(dir, exec, EXPECTED);

    expect(calls).toEqual([['node', path.join(dir, 'dist', 'bin', 'pingcode.js'), '--version']]);
  });

  it('throws TransportError naming the binary when it cannot start', () => {
    const dir = installWithBundle(tempDir('crash'));

    const exec: ExecFn = () => {
      throw new Error('spawn ENOENT');
    };

    let thrown: unknown;
    try {
      verifyBundle(dir, exec, EXPECTED);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransportError);
    expect((thrown as Error).message).toMatch(/failed to verify new installation: spawn ENOENT/);
    // The hint is the same one `verifyInstall` carried: it is what a user with
    // a dead install can actually act on.
    expect((thrown as TransportError).hint).toBe(
      `try running manually: node "${path.join(dir, 'dist', 'bin', 'pingcode.js')}" --version`,
    );
  });

  it('rejects a bundle that reports a different version', () => {
    const dir = installWithBundle(tempDir('wrong-version'));

    let thrown: unknown;
    try {
      verifyBundle(dir, () => '9.9.9\n', EXPECTED);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransportError);
    // The message must name both versions, or the failure is undiagnosable.
    expect((thrown as Error).message).toBe(
      `installed bundle reports version 9.9.9, expected ${EXPECTED}`,
    );
  });

  it('trims surrounding whitespace before comparing', () => {
    const dir = installWithBundle(tempDir('whitespace'));

    // A trailing newline is what `node --version` actually emits.
    expect(verifyBundle(dir, () => `\n  ${EXPECTED}\n\n`, EXPECTED)).toBe(EXPECTED);
  });

  it('carries a hint on the version mismatch too', () => {
    const dir = installWithBundle(tempDir('mismatch-hint'));

    let thrown: unknown;
    try {
      verifyBundle(dir, () => '9.9.9', EXPECTED);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as TransportError).hint).toContain('try running manually');
  });
});

// ---------------------------------------------------------------------------
// restoreBackup
// ---------------------------------------------------------------------------

describe('restoreBackup', () => {
  it('moves the backup back over the install dir', () => {
    const install = tempDir('restore-install');
    const backup = `${install}.backup`;
    installWithBundle(install, 'BROKEN BUNDLE');
    installWithBundle(backup, 'PREVIOUS BUNDLE');

    restoreBackup(install);

    expect(existsSync(install)).toBe(true);
    expect(readFileSync(path.join(install, 'dist', 'bin', 'pingcode.js'), 'utf8'))
      .toBe('PREVIOUS BUNDLE');
    // The backup is spent, so a later update starts clean.
    expect(existsSync(backup)).toBe(false);
  });

  it('replaces the install dir even when it still holds the broken bundle', () => {
    const install = tempDir('restore-over');
    const backup = `${install}.backup`;
    installWithBundle(install);
    installWithBundle(backup);
    writeFileSync(path.join(install, 'junk.txt'), 'junk');

    // This is the real call sequence: `atomicReplace` has already swapped the
    // dirs, so `install` is non-empty when the restore runs.
    restoreBackup(install);

    expect(existsSync(path.join(install, 'junk.txt'))).toBe(false);
    expect(existsSync(path.join(install, 'dist', 'bin', 'pingcode.js'))).toBe(true);
  });

  it('throws a TransportError naming the manual restore command', () => {
    // No backup exists, so the rename cannot succeed.
    const install = tempDir('restore-missing');
    installWithBundle(install);

    let thrown: unknown;
    try {
      restoreBackup(install);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransportError);
    expect((thrown as Error).message).toMatch(/failed to restore the previous install/);
    // The hint is the last resort: a user left with a dead install and no backup.
    expect((thrown as TransportError).hint).toBe(
      `restore manually: mv "${install}.backup" "${install}"`,
    );
  });
});
