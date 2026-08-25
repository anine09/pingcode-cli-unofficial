import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectArch, detectPlatform, installDir, skillTargets, binShimPath } from '../src/core/paths';

// ---------------------------------------------------------------------------
// platform / arch detection
// ---------------------------------------------------------------------------

describe('detectPlatform', () => {
  it('returns the current platform mapped to a release target', () => {
    const expected: 'linux' | 'darwin' | 'win32' =
      process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
    expect(detectPlatform()).toBe(expected);
  });

  it('reports darwin and win32 verbatim, everything else as linux', () => {
    const spy = vi.spyOn(process, 'platform', 'get');
    try {
      spy.mockReturnValue('darwin' as NodeJS.Platform);
      expect(detectPlatform()).toBe('darwin');
      spy.mockReturnValue('win32' as NodeJS.Platform);
      expect(detectPlatform()).toBe('win32');
      spy.mockReturnValue('freebsd' as NodeJS.Platform);
      expect(detectPlatform()).toBe('linux');
      spy.mockReturnValue('aix' as NodeJS.Platform);
      expect(detectPlatform()).toBe('linux');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('detectArch', () => {
  it('returns the current architecture mapped to a release target', () => {
    const expected: 'x64' | 'arm64' = process.arch === 'arm64' ? 'arm64' : 'x64';
    expect(detectArch()).toBe(expected);
  });

  it('reports arm64 verbatim, everything else as x64', () => {
    const spy = vi.spyOn(process, 'arch', 'get');
    try {
      spy.mockReturnValue('arm64' as NodeJS.Architecture);
      expect(detectArch()).toBe('arm64');
      spy.mockReturnValue('x64' as NodeJS.Architecture);
      expect(detectArch()).toBe('x64');
      spy.mockReturnValue('ia32' as NodeJS.Architecture);
      expect(detectArch()).toBe('x64');
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// installDir
// ---------------------------------------------------------------------------

describe('installDir', () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    platformSpy = vi.spyOn(process, 'platform', 'get');
  });

  afterEach(() => {
    platformSpy.mockRestore();
  });

  it('uses XDG_DATA_HOME on linux', () => {
    platformSpy.mockReturnValue('linux');
    expect(installDir({ XDG_DATA_HOME: '/data' })).toBe(path.join('/data', 'pingcode-cli'));
  });

  it('defaults to ~/.local/share on linux when XDG_DATA_HOME is unset', () => {
    platformSpy.mockReturnValue('linux');
    expect(installDir({})).toBe(path.join(os.homedir(), '.local', 'share', 'pingcode-cli'));
  });

  it('treats an empty XDG_DATA_HOME as unset', () => {
    platformSpy.mockReturnValue('linux');
    expect(installDir({ XDG_DATA_HOME: '' })).toBe(
      path.join(os.homedir(), '.local', 'share', 'pingcode-cli'),
    );
  });

  it('uses XDG_DATA_HOME on macOS too', () => {
    platformSpy.mockReturnValue('darwin');
    expect(installDir({ XDG_DATA_HOME: '/data' })).toBe(path.join('/data', 'pingcode-cli'));
  });

  it('uses LOCALAPPDATA on windows', () => {
    platformSpy.mockReturnValue('win32');
    expect(installDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toBe(
      path.join('C:\\Users\\me\\AppData\\Local', 'pingcode-cli'),
    );
  });

  it('falls back to ~/AppData/Local on windows when LOCALAPPDATA is unset', () => {
    platformSpy.mockReturnValue('win32');
    expect(installDir({})).toBe(path.join(os.homedir(), 'AppData', 'Local', 'pingcode-cli'));
  });

  it('treats an empty LOCALAPPDATA as unset', () => {
    platformSpy.mockReturnValue('win32');
    expect(installDir({ LOCALAPPDATA: '' })).toBe(
      path.join(os.homedir(), 'AppData', 'Local', 'pingcode-cli'),
    );
  });
});

// ---------------------------------------------------------------------------
// skillTargets
// ---------------------------------------------------------------------------

describe('skillTargets', () => {
  it('returns both claude and opencode directories', () => {
    const targets = skillTargets({});
    expect(targets.map((t) => t.name)).toEqual(['claude', 'opencode']);

    const claude = targets.find((t) => t.name === 'claude');
    expect(claude).toEqual({
      name: 'claude',
      label: 'Claude Code (global)',
      dir: path.join(os.homedir(), '.claude', 'skills', 'pingcode'),
    });

    const opencode = targets.find((t) => t.name === 'opencode');
    expect(opencode?.label).toBe('OpenCode (global)');
  });

  it('defaults opencode to ~/.config/opencode when XDG_CONFIG_HOME is unset', () => {
    const targets = skillTargets({});
    const opencode = targets.find((t) => t.name === 'opencode');
    expect(opencode?.dir).toBe(
      path.join(os.homedir(), '.config', 'opencode', 'skills', 'pingcode'),
    );
  });

  it('respects XDG_CONFIG_HOME for the opencode target', () => {
    const targets = skillTargets({ XDG_CONFIG_HOME: '/cfg' });
    const opencode = targets.find((t) => t.name === 'opencode');
    expect(opencode?.dir).toBe(path.join('/cfg', 'opencode', 'skills', 'pingcode'));
  });

  it('treats an empty XDG_CONFIG_HOME as unset', () => {
    const targets = skillTargets({ XDG_CONFIG_HOME: '' });
    const opencode = targets.find((t) => t.name === 'opencode');
    expect(opencode?.dir).toBe(
      path.join(os.homedir(), '.config', 'opencode', 'skills', 'pingcode'),
    );
  });
});

// ---------------------------------------------------------------------------
// binShimPath
// ---------------------------------------------------------------------------

describe('binShimPath', () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    platformSpy = vi.spyOn(process, 'platform', 'get');
  });

  afterEach(() => {
    platformSpy.mockRestore();
  });

  it('points to ~/.local/bin/pingcode on linux', () => {
    platformSpy.mockReturnValue('linux');
    expect(binShimPath({})).toBe(path.join(os.homedir(), '.local', 'bin', 'pingcode'));
  });

  it('points to ~/.local/bin/pingcode on macOS', () => {
    platformSpy.mockReturnValue('darwin');
    expect(binShimPath({})).toBe(path.join(os.homedir(), '.local', 'bin', 'pingcode'));
  });

  it('points to the WindowsApps shim on windows', () => {
    platformSpy.mockReturnValue('win32');
    expect(binShimPath({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toBe(
      path.join('C:\\Users\\me\\AppData\\Local', 'Microsoft', 'WindowsApps', 'pingcode.cmd'),
    );
  });
});
