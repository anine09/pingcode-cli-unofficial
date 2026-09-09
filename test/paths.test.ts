import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillTargets } from '../src/core/paths';

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
