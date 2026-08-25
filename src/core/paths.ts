/**
 * Platform detection and install / skill / bin path resolution.
 *
 * Zero runtime dependencies — only `node:os` and `node:path`. Used by the
 * self-update / npm-publish flow to decide which release asset to download,
 * where to install the CLI, which agent skill directories to populate, and
 * where to drop the bin shim.
 */
import os from 'node:os';
import path from 'node:path';

/** Application directory name, reused in every install path. */
const APP_NAME = 'pingcode-cli';

// ---------------------------------------------------------------------------
// platform / architecture detection
// ---------------------------------------------------------------------------

/**
 * Detect the current platform for release-asset matching.
 *
 * Maps Node's `process.platform` to the small set the release matrix ships:
 * `darwin` and `win32` pass through, and every other platform (linux plus the
 * rarer `aix`/`freebsd`/...) collapses to `linux`.
 */
export function detectPlatform(): 'linux' | 'darwin' | 'win32' {
  switch (process.platform) {
    case 'darwin':
      return 'darwin';
    case 'win32':
      return 'win32';
    default:
      return 'linux';
  }
}

/**
 * Detect the current CPU architecture for release-asset matching.
 *
 * Maps Node's `process.arch` to the two architectures we publish: `arm64`
 * passes through, and everything else (`x64`, `ia32`, `arm`, ...) collapses
 * to `x64`.
 */
export function detectArch(): 'x64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

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

// ---------------------------------------------------------------------------
// install directory
// ---------------------------------------------------------------------------

/**
 * XDG-compliant install directory for the CLI.
 *
 * - **Windows**: `%LOCALAPPDATA%/pingcode-cli`, falling back to
 *   `~/AppData/Local/pingcode-cli` when `LOCALAPPDATA` is unset or empty.
 * - **Linux + macOS**: `$XDG_DATA_HOME/pingcode-cli`, falling back to
 *   `~/.local/share/pingcode-cli`.
 */
export function installDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const base = env['LOCALAPPDATA'];
    const root = base !== undefined && base !== '' ? base : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, APP_NAME);
  }
  const xdg = env['XDG_DATA_HOME'];
  const root = xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(root, APP_NAME);
}

// ---------------------------------------------------------------------------
// bin shim
// ---------------------------------------------------------------------------

/**
 * Where the `pingcode` bin shim is installed.
 *
 * - **Linux + macOS**: `~/.local/bin/pingcode`.
 * - **Windows**: `%LOCALAPPDATA%/Microsoft/WindowsApps/pingcode.cmd` (the
 *   user-level `PATH` entry), falling back to
 *   `~/AppData/Local/Microsoft/WindowsApps/pingcode.cmd` when `LOCALAPPDATA`
 *   is unset or empty.
 */
export function binShimPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const base = env['LOCALAPPDATA'];
    const root = base !== undefined && base !== '' ? base : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'Microsoft', 'WindowsApps', 'pingcode.cmd');
  }
  return path.join(os.homedir(), '.local', 'bin', 'pingcode');
}
