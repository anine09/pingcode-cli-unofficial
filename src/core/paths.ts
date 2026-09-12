/**
 * Skill-directory path resolution.
 *
 * Zero runtime dependencies — only `node:os` and `node:path`.
 *
 * `skillTargets` is the live export: the `skill` commands use it to decide which
 * agent skill directories to populate. There is no install directory any more —
 * npm owns where the package lives, and the skill payload resolves relative to
 * the running module (`core/update.ts#packageSkillDir`).
 */
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// skill directories
// ---------------------------------------------------------------------------

/**
 * OpenCode reads global skills from `$XDG_CONFIG_HOME/opencode`, defaulting to
 * `~/.config/opencode`. An empty `XDG_CONFIG_HOME` is treated as unset.
 */
function opencodeConfigDir(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

/** A coding-agent skill install destination. */
export interface SkillTarget {
  /** Canonical agent id (e.g. `claude-code`, `opencode`) — usable as a `--target` value. */
  name: string;
  /** Human-readable label for prompts / logs. */
  label: string;
  /** Directory the skill files are copied into. */
  dir: string;
}

/**
 * One row of the agent catalog. Mirrors the fields of `gh skill install`'s
 * `AgentHost` that we consume; `ProjectDir` is intentionally absent because we
 * only ever install at the global (user) scope.
 */
export interface AgentSpec {
  /** canonical `--target` value */
  id: string;
  /** display name */
  name: string;
  /**
   * Skill directory relative to `$HOME` — or to the env-scoped config dir when
   * `envScoped`. Includes the trailing `pingcode` leaf, because that is the
   * directory `installSkill` copies into and `syncSkills` tests for.
   */
  dir: string;
  /** `opencode`: resolved against `$XDG_CONFIG_HOME` instead of `$HOME` */
  envScoped?: boolean;
  /** legacy `--target` spellings still accepted */
  aliases?: readonly string[];
}

/**
 * The full agent catalog, in `gh skill install` order: the five popular agents
 * first, the rest by id. One entry per known agent, no normalization — the same
 * order feeds the prompt list, the `skill list` rows and the unknown-target
 * error, so nothing derives a second table.
 */
export const AGENT_SPECS: readonly AgentSpec[] = [
  { id: 'github-copilot', name: 'GitHub Copilot', dir: '.copilot/skills/pingcode' },
  { id: 'claude-code', name: 'Claude Code', dir: '.claude/skills/pingcode', aliases: ['claude'] },
  { id: 'cursor', name: 'Cursor', dir: '.cursor/skills/pingcode' },
  { id: 'codex', name: 'Codex', dir: '.agents/skills/pingcode' },
  { id: 'gemini-cli', name: 'Gemini CLI', dir: '.gemini/skills/pingcode' },
  { id: 'antigravity', name: 'Antigravity', dir: '.gemini/antigravity/skills/pingcode' },
  { id: 'antigravity-cli', name: 'Antigravity CLI', dir: '.gemini/antigravity-cli/skills/pingcode' },
  { id: 'antigravity2.0', name: 'Antigravity 2.0', dir: '.gemini/config/skills/pingcode' },
  { id: 'adal', name: 'AdaL', dir: '.adal/skills/pingcode' },
  { id: 'amp', name: 'Amp', dir: '.config/agents/skills/pingcode' },
  { id: 'augment', name: 'Augment', dir: '.augment/skills/pingcode' },
  { id: 'bob', name: 'IBM Bob', dir: '.bob/skills/pingcode' },
  { id: 'cline', name: 'Cline', dir: '.agents/skills/pingcode' },
  { id: 'codebuddy', name: 'CodeBuddy', dir: '.codebuddy/skills/pingcode' },
  { id: 'command-code', name: 'Command Code', dir: '.commandcode/skills/pingcode' },
  { id: 'continue', name: 'Continue', dir: '.continue/skills/pingcode' },
  { id: 'cortex', name: 'Cortex Code', dir: '.snowflake/cortex/skills/pingcode' },
  { id: 'crush', name: 'Crush', dir: '.config/crush/skills/pingcode' },
  { id: 'deepagents', name: 'Deep Agents', dir: '.deepagents/agent/skills/pingcode' },
  { id: 'devin', name: 'Devin', dir: '.devin/skills/pingcode' },
  { id: 'droid', name: 'Droid', dir: '.factory/skills/pingcode' },
  { id: 'firebender', name: 'Firebender', dir: '.firebender/skills/pingcode' },
  { id: 'goose', name: 'Goose', dir: '.config/goose/skills/pingcode' },
  { id: 'grok', name: 'Grok', dir: '.grok/skills/pingcode' },
  { id: 'iflow-cli', name: 'iFlow CLI', dir: '.iflow/skills/pingcode' },
  { id: 'junie', name: 'Junie', dir: '.junie/skills/pingcode' },
  { id: 'kilo', name: 'Kilo Code', dir: '.kilocode/skills/pingcode' },
  { id: 'kimi-cli', name: 'Kimi Code CLI', dir: '.config/agents/skills/pingcode' },
  { id: 'kiro-cli', name: 'Kiro CLI', dir: '.kiro/skills/pingcode' },
  { id: 'kode', name: 'Kode', dir: '.kode/skills/pingcode' },
  { id: 'mcpjam', name: 'MCPJam', dir: '.mcpjam/skills/pingcode' },
  { id: 'mistral-vibe', name: 'Mistral Vibe', dir: '.vibe/skills/pingcode' },
  { id: 'mux', name: 'Mux', dir: '.mux/skills/pingcode' },
  { id: 'neovate', name: 'Neovate', dir: '.neovate/skills/pingcode' },
  { id: 'openclaw', name: 'OpenClaw', dir: '.openclaw/skills/pingcode' },
  // The only env-scoped entry: `opencodeConfigDir` already ends in `opencode`,
  // so this `dir` is the tail rather than `.config/opencode/skills/pingcode`.
  { id: 'opencode', name: 'OpenCode', dir: 'skills/pingcode', envScoped: true },
  { id: 'openhands', name: 'OpenHands', dir: '.openhands/skills/pingcode' },
  { id: 'pi', name: 'Pi', dir: '.pi/agent/skills/pingcode' },
  { id: 'pochi', name: 'Pochi', dir: '.pochi/skills/pingcode' },
  { id: 'qoder', name: 'Qoder', dir: '.qoder/skills/pingcode' },
  { id: 'qwen-code', name: 'Qwen Code', dir: '.qwen/skills/pingcode' },
  { id: 'replit', name: 'Replit', dir: '.config/agents/skills/pingcode' },
  { id: 'roo', name: 'Roo Code', dir: '.roo/skills/pingcode' },
  { id: 'trae', name: 'Trae', dir: '.trae/skills/pingcode' },
  { id: 'trae-cn', name: 'Trae CN', dir: '.trae-cn/skills/pingcode' },
  { id: 'universal', name: 'Universal', dir: '.agents/skills/pingcode' },
  { id: 'warp', name: 'Warp', dir: '.agents/skills/pingcode' },
  { id: 'zencoder', name: 'Zencoder', dir: '.zencoder/skills/pingcode' },
];

/**
 * Every agent skill directory the CLI can install its `pingcode` skill into.
 * All are **global (user-level)**.
 */
export function skillTargets(env: NodeJS.ProcessEnv = process.env): SkillTarget[] {
  return AGENT_SPECS.map((spec) => ({
    name: spec.id,
    label: `${spec.name} (global)`,
    dir: path.join(spec.envScoped === true ? opencodeConfigDir(env) : os.homedir(), spec.dir),
  }));
}
