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
 *
 * Mirrors the logic in `scripts/install-skill.ts:opencodeConfigDir()`.
 */
function opencodeConfigDir(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

/** A coding-agent skill install destination. */
export interface SkillTarget {
  /** Short name (e.g. `claude`, `opencode`) — usable as a `--target` value. */
  name: string;
  /** Human-readable label for prompts / logs. */
  label: string;
  /** Directory the skill files are copied into. */
  dir: string;
}

/**
 * The two agent skill directories the CLI installs its `pingcode` skill into.
 * Both are **global (user-level)** — see `scripts/install-skill.ts:targets()`.
 */
export function skillTargets(env: NodeJS.ProcessEnv = process.env): SkillTarget[] {
  return [
    {
      name: 'claude',
      label: 'Claude Code (global)',
      dir: path.join(os.homedir(), '.claude', 'skills', 'pingcode'),
    },
    {
      name: 'opencode',
      label: 'OpenCode (global)',
      dir: path.join(opencodeConfigDir(env), 'skills', 'pingcode'),
    },
  ];
}


