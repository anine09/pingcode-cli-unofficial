/**
 * `--target` parsing (design D2).
 *
 * Pure resolution: an unknown value is *returned*, never thrown, because exit
 * codes belong to the `cli/` layer (`test/layering.test.ts`). The command layer
 * turns `ok: false` into a `UsageError`, which `exitCodeFor` maps to 2.
 */

import { AGENT_SPECS, skillTargets } from './paths';
import type { AgentSpec, SkillTarget } from './paths';

/** The one non-agent token accepted; every other token is an id or an alias. */
const ALL_TOKEN = 'all';

export type TargetResolution =
  | { ok: true; targets: SkillTarget[] }
  | { ok: false; unknown: string[]; valid: string[] };

/**
 * Split `--target` into lowercase tokens: comma-separated, trimmed, empties
 * dropped, first-seen order preserved with duplicates collapsed.
 */
function tokenize(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (token !== '') seen.add(token);
  }
  return [...seen];
}

/** The catalog spec a token names, by id first and then by legacy alias. */
function specFor(token: string): AgentSpec | undefined {
  return AGENT_SPECS.find(
    (spec) => spec.id === token || spec.aliases?.includes(token) === true,
  );
}

/** Everything `--target` accepts, in catalog order, for error messages. */
function validTokens(): string[] {
  const tokens = AGENT_SPECS.flatMap((spec) => [spec.id, ...(spec.aliases ?? [])]);
  tokens.push(ALL_TOKEN);
  return tokens;
}

/**
 * Resolve a `--target` value to the targets it selects.
 *
 * `all` (any case, and only as the whole value) and an empty value both mean
 * "every agent" — an empty `--target` is indistinguishable from "not given",
 * which is what keeps the interactive and non-interactive paths in agreement.
 */
export function resolveTargetList(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): TargetResolution {
  const targets = skillTargets(env);
  const byName = new Map(targets.map((target) => [target.name, target]));

  if (raw.trim().toLowerCase() === ALL_TOKEN) return { ok: true, targets };

  const tokens = tokenize(raw);
  if (tokens.length === 0) return { ok: true, targets };

  const unknown: string[] = [];
  const chosen: SkillTarget[] = [];

  for (const token of tokens) {
    const spec = specFor(token);
    if (spec === undefined) {
      unknown.push(token);
      continue;
    }
    // An alias and its id name the same target (`claude` / `claude-code`), so
    // collapse them rather than installing twice.
    const target = byName.get(spec.id);
    if (target !== undefined && !chosen.includes(target)) chosen.push(target);
  }

  if (unknown.length > 0) return { ok: false, unknown, valid: validTokens() };
  return { ok: true, targets: chosen };
}
