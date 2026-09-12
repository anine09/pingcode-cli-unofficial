/**
 * Interactive target selection (design D3).
 *
 * Lives in the `cli/` layer because `core/` never renders. `@clack/prompts` is
 * pulled in through a dynamic import so the non-interactive fast paths (`--json`,
 * pipes, CI) never load it, and it writes to stderr itself — nothing here writes
 * to stdout.
 */

import { detectCurrentAgent } from '../../core/agent-detect';
import type { SkillTarget } from '../../core/paths';
import { listSkillStatus } from '../../core/skill-ops';

/** Injectable prompt surface, so tests never need a TTY. */
export interface TargetPromptIO {
  /** False when stdout is not a terminal, or prompting was switched off. */
  canPrompt(): boolean;
  /**
   * Show `labels` (searchable — typing filters the list), pre-selecting
   * `defaults` (agent ids), and resolve to the chosen ids — or `'aborted'`
   * when the user cancels.
   */
  select(
    labels: readonly string[],
    defaults: readonly string[],
  ): Promise<string[] | 'aborted'>;
}

/**
 * What starts checked: every agent already holding the skill, plus whichever
 * agent we appear to be running inside. Deliberately *not* all 48 — a bare
 * Enter should mean "the ones I already have", not "write to every agent on
 * this machine".
 */
function defaultChecked(targets: readonly SkillTarget[]): string[] {
  const installed = new Set(
    listSkillStatus(targets as SkillTarget[])
      .filter((status) => status.installed)
      .map((status) => status.target.name),
  );
  const detected = detectCurrentAgent();
  return targets
    .filter((target) => installed.has(target.name) || target.name === detected)
    .map((target) => target.name);
}

/**
 * Map a selection back to targets.
 *
 * `null` means the user backed out (Ctrl-C). An empty array means they confirmed
 * an empty selection — also nothing to write, but a different story, so the two
 * are kept apart.
 */
export async function chooseTargets(
  targets: readonly SkillTarget[],
  io: TargetPromptIO,
): Promise<SkillTarget[] | null> {
  const chosen = await io.select(
    targets.map((target) => target.label),
    defaultChecked(targets),
  );
  if (chosen === 'aborted') return null;

  // Unknown names are dropped defensively: the caller owns the catalog.
  return targets.filter((target) => chosen.includes(target.name));
}

/** An env var counts as set only when it holds a non-empty value. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

/**
 * The default IO. A factory rather than a constant because the option hint (the
 * target directory) is not part of the `select` contract — only this
 * implementation needs it.
 */
export function defaultTargetPromptIO(targets: readonly SkillTarget[]): TargetPromptIO {
  return {
    canPrompt: () => Boolean(process.stdout.isTTY) && !isSet(process.env['CI']),
    select: async (labels, defaults) => {
      const { isCancel, autocompleteMultiselect } = await import('@clack/prompts');
      const result = await autocompleteMultiselect<string>({
        message: 'Search and select target agent(s):',
        placeholder: 'Type to search...',
        options: targets.map((target, index) => ({
          value: target.name,
          // `Name (id)`, not `Name (global)`: the id is what the user has to type
          // to get the same agent via `--target`, and every entry is global.
          label: labels[index]?.replace(/ \(global\)$/, ` (${target.name})`) ?? target.name,
          hint: target.dir,
        })),
        initialValues: [...defaults],
        required: false,
      });
      if (isCancel(result)) return 'aborted';
      // `isCancel` narrows to `string[]` in prose but not in types, since the
      // cancel symbol is a unique symbol inside the wider `symbol` union.
      return result as string[];
    },
  };
}
