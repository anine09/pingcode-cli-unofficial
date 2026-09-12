import { describe, expect, it } from 'vitest';
import { AGENT_SPECS } from '../../src/core/paths';

/**
 * The catalog is the single source of truth for the `skill` commands, so it is
 * pinned here: order (gh parity), id/dir uniqueness, and the two shared
 * directories that make 48 agents collapse to 43 install directories.
 */

const IDS = AGENT_SPECS.map((spec) => spec.id);

/** The relative skill dirs, deduped. */
const DIRS = [...new Set(AGENT_SPECS.map((spec) => spec.dir))];

/** Agent ids sharing one directory, sorted for readability. */
function sharers(dir: string): string[] {
  return AGENT_SPECS.filter((spec) => spec.dir === dir)
    .map((spec) => spec.id)
    .sort();
}

describe('AGENT_SPECS', () => {
  it('has 48 agents, matching gh skill install', () => {
    expect(AGENT_SPECS).toHaveLength(48);
  });

  it('is in gh order: five popular agents first, then the rest as gh lists them', () => {
    expect(IDS).toEqual([
      'github-copilot',
      'claude-code',
      'cursor',
      'codex',
      'gemini-cli',
      'antigravity',
      'antigravity-cli',
      'antigravity2.0',
      'adal',
      'amp',
      'augment',
      'bob',
      'cline',
      'codebuddy',
      'command-code',
      'continue',
      'cortex',
      'crush',
      'deepagents',
      'devin',
      'droid',
      'firebender',
      'goose',
      'grok',
      'iflow-cli',
      'junie',
      'kilo',
      'kimi-cli',
      'kiro-cli',
      'kode',
      'mcpjam',
      'mistral-vibe',
      'mux',
      'neovate',
      'openclaw',
      'opencode',
      'openhands',
      'pi',
      'pochi',
      'qoder',
      'qwen-code',
      'replit',
      'roo',
      'trae',
      'trae-cn',
      'universal',
      'warp',
      'zencoder',
    ]);
  });

  it('has unique ids and unique display names', () => {
    expect(new Set(IDS).size).toBe(IDS.length);
    expect(new Set(AGENT_SPECS.map((spec) => spec.name)).size).toBe(48);
  });

  it('uses lowercase, --target-safe ids', () => {
    for (const id of IDS) expect(id).toMatch(/^[a-z0-9][a-z0-9.\-]*$/);
  });

  it('only opencode is env-scoped, with a config-dir-relative path', () => {
    const scoped = AGENT_SPECS.filter((spec) => spec.envScoped === true);
    expect(scoped.map((spec) => spec.id)).toEqual(['opencode']);
    // Every other dir is relative to $HOME and dotted-shaped.
    for (const spec of AGENT_SPECS) {
      if (spec.id === 'opencode') continue;
      expect(spec.dir).toMatch(/^\./);
    }
    // `opencodeConfigDir()` already ends in `opencode`, so the entry is the tail.
    const opencode = AGENT_SPECS.find((spec) => spec.id === 'opencode')!;
    expect(opencode.dir).toBe('skills/pingcode');
  });

  it('aliases the legacy `claude` spelling to claude-code', () => {
    expect(AGENT_SPECS.find((spec) => spec.id === 'claude-code')!.aliases).toEqual(['claude']);
  });

  it('gives no other agent an alias', () => {
    const aliased = AGENT_SPECS.filter((spec) => spec.aliases !== undefined);
    expect(aliased.map((spec) => spec.id)).toEqual(['claude-code']);
  });

  it('collapses to 43 distinct skill directories', () => {
    expect(DIRS).toHaveLength(43);
  });

  it('shares .agents/skills across codex, cline, universal and warp', () => {
    expect(sharers('.agents/skills/pingcode')).toEqual(['cline', 'codex', 'universal', 'warp']);
  });

  it('shares .config/agents/skills across amp, kimi-cli and replit', () => {
    expect(sharers('.config/agents/skills/pingcode')).toEqual(['amp', 'kimi-cli', 'replit']);
  });

  it('puts every dir under a `skills/pingcode` leaf', () => {
    for (const dir of DIRS) {
      expect(dir.split('/').slice(-2)).toEqual(['skills', 'pingcode']);
    }
  });
});
