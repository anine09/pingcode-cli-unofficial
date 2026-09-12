import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_SPECS, skillTargets } from '../src/core/paths';

// ---------------------------------------------------------------------------
// skillTargets
// ---------------------------------------------------------------------------

describe('skillTargets', () => {
  it('returns every agent in the catalog, in catalog order', () => {
    const targets = skillTargets({});
    expect(targets).toHaveLength(AGENT_SPECS.length);
    expect(targets.map((t) => t.name)).toEqual(AGENT_SPECS.map((spec) => spec.id));
    // The id is the canonical `--target` spelling, so it is usable directly.
    expect(targets[0]!.name).toBe('github-copilot');
    expect(targets[1]!.name).toBe('claude-code');
  });

  it('resolves claude-code to ~/.claude/skills/pingcode', () => {
    const claude = skillTargets({}).find((t) => t.name === 'claude-code');
    expect(claude).toEqual({
      name: 'claude-code',
      label: 'Claude Code (global)',
      dir: path.join(os.homedir(), '.claude', 'skills', 'pingcode'),
    });
  });

  it('labels every target `Name (global)`', () => {
    // Only the `Name` half is the display name; the `(global)` suffix is what the
    // prompt IO rewrites into `(id)` for the interactive list.
    const targets = skillTargets({});
    expect(targets.find((t) => t.name === 'claude-code')!.label).toBe('Claude Code (global)');
    expect(targets.find((t) => t.name === 'cursor')!.label).toBe('Cursor (global)');
  });

  it('defaults opencode to ~/.config/opencode when XDG_CONFIG_HOME is unset', () => {
    const opencode = skillTargets({}).find((t) => t.name === 'opencode');
    expect(opencode?.dir).toBe(
      path.join(os.homedir(), '.config', 'opencode', 'skills', 'pingcode'),
    );
  });

  it('respects XDG_CONFIG_HOME for the opencode target', () => {
    const opencode = skillTargets({ XDG_CONFIG_HOME: '/cfg' }).find((t) => t.name === 'opencode');
    expect(opencode?.dir).toBe(path.join('/cfg', 'opencode', 'skills', 'pingcode'));
  });

  it('treats an empty XDG_CONFIG_HOME as unset', () => {
    const opencode = skillTargets({ XDG_CONFIG_HOME: '' }).find((t) => t.name === 'opencode');
    expect(opencode?.dir).toBe(
      path.join(os.homedir(), '.config', 'opencode', 'skills', 'pingcode'),
    );
  });

  it('leaves every non-opencode target alone when XDG_CONFIG_HOME changes', () => {
    // XDG only scopes opencode; the rest stay under $HOME.
    const targets = skillTargets({ XDG_CONFIG_HOME: '/cfg' });
    expect(targets).toHaveLength(AGENT_SPECS.length);
    expect(targets.find((t) => t.name === 'cursor')!.dir).toBe(
      path.join(os.homedir(), '.cursor', 'skills', 'pingcode'),
    );
  });

  it('returns absolute, distinct directories', () => {
    const dirs = skillTargets({}).map((t) => t.dir);
    for (const dir of dirs) expect(path.isAbsolute(dir)).toBe(true);
  });
});
