/**
 * Detect which coding agent is hosting us, via its env ladder (design D4).
 *
 * A port of `gh internal/agents/detect.go` mapped onto our agent ids. Pure and
 * side-effect free: it reads `env` only, `PATH` included. The result pre-selects
 * an agent in the interactive prompt — it never makes an install decision.
 */

import path from 'node:path';

/**
 * One rung of the ladder. Matchers run in order and the first hit wins, so the
 * order below is the specification, not a convenience.
 */
interface AgentMatcher {
  /** Env vars to test, in order. Empty when the rung is PATH-based. */
  envs: readonly string[];
  /** When set, the env var must equal this value to match. */
  equals?: string;
  /** Agent id to report; omit to report the env var's own value. */
  agent?: string;
  /** PATH segment that implies this agent, checked instead of env vars. */
  pathSegment?: string;
}

const AGENT_MATCHERS: readonly AgentMatcher[] = [
  // Wrappers set this to their own id; gh reports it unvalidated so an agent
  // newer than this catalog still gets pre-selected instead of being ignored.
  { envs: ['AI_AGENT'] },
  { envs: ['AGENT'], equals: 'amp', agent: 'amp' },
  { envs: ['CODEX_SANDBOX', 'CODEX_CI', 'CODEX_THREAD_ID'], agent: 'codex' },
  { envs: ['GEMINI_CLI'], agent: 'gemini-cli' },
  { envs: ['COPILOT_CLI'], agent: 'github-copilot' },
  { envs: ['OPENCODE'], agent: 'opencode' },
  { envs: ['ANTIGRAVITY_AGENT'], agent: 'antigravity' },
  { envs: ['AUGMENT_AGENT'], agent: 'augment' },
  { envs: ['REPL_ID'], agent: 'replit' },
  { envs: ['CLAUDE_CODE_IS_COWORK', 'CLAUDECODE', 'CLAUDE_CODE'], agent: 'claude-code' },
  { envs: ['CURSOR_TRACE_ID', 'CURSOR_AGENT'], agent: 'cursor' },
  // `pi` announces itself on PATH rather than through an env var.
  { envs: [], pathSegment: '/.pi/agent', agent: 'pi' },
  { envs: ['TERM_PROGRAM'], equals: 'kiro', agent: 'kiro-cli' },
  // Last resort: `GOOSE_PROVIDER` survives in shells long after Goose is gone.
  { envs: ['GOOSE_PROVIDER'], agent: 'goose' },
];

/** An env var counts as set only when it holds a non-empty value. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

function pathHas(env: NodeJS.ProcessEnv, segment: string): boolean {
  const raw = env['PATH'];
  if (raw === undefined || raw === '') return false;
  // Backslashes normalized so a Windows PATH entry matches too. The segment must
  // land on a path-component boundary: `~/.pi/agent/bin` matches, but
  // `/.pi/agent-not-really/bin` does not — `pi` ships its own directory.
  return raw
    .split(path.delimiter)
    .some((entry) => {
      const normalized = entry.replace(/\\/g, '/');
      return normalized.includes(`${segment}/`) || normalized.endsWith(segment);
    });
}

export function detectCurrentAgent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const matcher of AGENT_MATCHERS) {
    if (matcher.pathSegment !== undefined) {
      if (pathHas(env, matcher.pathSegment)) return matcher.agent;
      continue;
    }

    for (const name of matcher.envs) {
      const value = env[name];
      if (!isSet(value)) continue;
      if (matcher.equals !== undefined && value !== matcher.equals) continue;
      return matcher.agent ?? value;
    }
  }

  return undefined;
}
