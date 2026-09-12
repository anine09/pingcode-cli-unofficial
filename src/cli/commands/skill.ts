/**
 * `pingcode skill …` — manage the bundled pingcode skill across agent targets.
 *
 * Thin orchestrator: all file-system work lives in `core/skill-ops.ts`
 * because the `cli/` layer is forbidden from importing `node:fs`.
 */

import type { Command } from 'commander';
import path from 'node:path';
import { UsageError } from '../../core/errors';
import { skillTargets } from '../../core/paths';
import type { SkillTarget } from '../../core/paths';
import { resolveTargetList } from '../../core/skill-targets';
import { packageSkillDir } from '../../core/update';
import {
  type InstallResult,
  type SkillStatus,
  installSkill,
  listSkillStatus,
  uninstallSkill,
} from '../../core/skill-ops';
import { addGlobalOptions } from '../globals';
import { errLine, outLine, paint, printJson, printTable } from '../output';
import { chooseTargets, defaultTargetPromptIO } from '../prompts/target-select';
import { contextFor, modeOf } from './common';

/**
 * The root `installSkill` expects: the directory that holds `skills/pingcode`.
 *
 * There is no install directory any more. npm owns where the package lives, so
 * the payload is the one inside the *running* package — the same source
 * `core/update.ts#syncSkills` copies from after an update, resolved relative to
 * `import.meta.url` so it is the repo checkout in development and the published
 * `skills/` directory in an installed package. Deriving it from
 * `packageSkillDir()` rather than re-deriving the URL keeps the two consumers
 * provably on the same directory.
 *
 * The old `installDir()` layout — `~/.local/share/pingcode-cli`, which the standalone
 * installer used to populate — is deliberately *not* the source: nothing creates that
 * directory any more, so reading it made `skill install` report `not-found` for every
 * target while an older copy sat there untouched.
 */
function packageSkillRoot(): string {
  return path.dirname(path.dirname(packageSkillDir()));
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

// Global flags accepted by every skill subcommand.
interface SkillFlags {
  host?: string;
  json?: boolean;
  dryRun?: boolean;
  noCache?: boolean;
  verbose?: boolean;
  target?: string;
  force?: boolean;
  /** commander's `--no-interactive` inverts this to `false`. */
  interactive?: boolean;
}

/**
 * The `--target` option, shared by every command that writes. It carries no
 * default: an absent `--target` is what routes to the interactive selector,
 * which `resolveTargetList` then treats the same as `all` when it never runs.
 */
const TARGET_OPTION = '--target <name>';

const TARGET_HELP = 'agent id(s), comma-separated, or "all"';

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description('manage the pingcode skill across agent targets');

  skill
    .command('list')
    .description('show where the skill is installed')
    .action(async (flags: SkillFlags) => {
      await runList(flags);
    });

  skill
    .command('install')
    .description('install the skill into agent global skill directories')
    .option(TARGET_OPTION, TARGET_HELP)
    .option('--force', 'overwrite existing files')
    .option('--no-interactive', 'skip the interactive agent selector')
    .action(async (flags: SkillFlags) => {
      await runInstall(flags);
    });

  skill
    .command('remove')
    .description('remove the skill from agent global skill directories')
    .option(TARGET_OPTION, TARGET_HELP)
    .option('--no-interactive', 'skip the interactive agent selector')
    .action(async (flags: SkillFlags) => {
      await runRemove(flags);
    });

  skill
    .command('update')
    .description('update the skill (reinstall with --force)')
    .option(TARGET_OPTION, TARGET_HELP)
    .option('--no-interactive', 'skip the interactive agent selector')
    .action(async (flags: SkillFlags) => {
      await runUpdate(flags);
    });

  // Add global options to each leaf (commander requires this per-leaf; parent
  // must NOT have it, otherwise the flags collide).
  for (const leaf of skill.commands) {
    addGlobalOptions(leaf);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface TargetRow {
  target: string;
  installed: boolean;
  version: string;
  files: number;
  size: string;
}

async function runList(_flags: SkillFlags): Promise<void> {
  const command = (await import('../program')).buildProgram();
  const { ctx } = contextFor(command);
  const mode = modeOf(ctx);
  const targets = skillTargets();

  const statuses: SkillStatus[] = listSkillStatus(targets);

  if (mode.json) {
    printJson(
      statuses.map((s) => ({
        target: s.target.name,
        label: s.target.label,
        installed: s.installed,
        ...(s.info ? { version: s.info.version, files: s.info.fileCount, sizeBytes: s.info.sizeBytes } : {}),
      })),
    );
    return;
  }

  if (statuses.every((s) => !s.installed)) {
    errLine(paint.dim('skill is not installed anywhere'));
    return;
  }

  const rows: TargetRow[] = statuses.map((s) => ({
    target: s.target.label,
    installed: s.installed,
    version: s.info?.version ?? '—',
    files: s.info?.fileCount ?? 0,
    size: s.info ? formatBytes(s.info.sizeBytes) : '—',
  }));

  printTable(
    [
      { header: 'Target', value: (r) => r.target },
      { header: 'Installed', value: (r) => (r.installed ? 'yes' : 'no') },
      { header: 'Version', value: (r) => r.version },
      { header: 'Files', value: (r) => String(r.files) },
      { header: 'Size', value: (r) => r.size },
    ],
    rows,
  );
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function runInstall(flags: SkillFlags): Promise<void> {
  const command = (await import('../program')).buildProgram();
  const { ctx } = contextFor(command);
  const mode = modeOf(ctx);
  const targets = await selectTargets(flags, mode);
  if (targets === null) return;
  const sourceRoot = packageSkillRoot();

  const results: InstallResult[] = installSkill(
    sourceRoot,
    targets,
    flags.force ?? false,
    flags.dryRun === true,
  );
  renderResults(results, mode);
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function runRemove(flags: SkillFlags): Promise<void> {
  const command = (await import('../program')).buildProgram();
  const { ctx } = contextFor(command);
  const mode = modeOf(ctx);
  const targets = await selectTargets(flags, mode);
  if (targets === null) return;

  const results: InstallResult[] = uninstallSkill(targets, flags.dryRun === true);
  renderResults(results, mode);
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function runUpdate(flags: SkillFlags): Promise<void> {
  const command = (await import('../program')).buildProgram();
  const { ctx } = contextFor(command);
  const mode = modeOf(ctx);
  const targets = await selectTargets(flags, mode);
  if (targets === null) return;
  const sourceRoot = packageSkillRoot();

  const results: InstallResult[] = installSkill(
    sourceRoot,
    targets,
    true,
    flags.dryRun === true,
  );
  renderResults(results, mode);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `--target`, or prompt for it. An unknown value is a usage error
 * (exit 2) — the old code silently dropped it, which made a typo look like a
 * successful install of nothing.
 */
function resolveTargetListOrThrow(raw: string): SkillTarget[] {
  const resolution = resolveTargetList(raw);
  if (!resolution.ok) {
    throw new UsageError(`unknown --target value(s): ${resolution.unknown.join(', ')}`, {
      hint: `valid values: ${resolution.valid.join(', ')}`,
    });
  }
  return resolution.targets;
}

/**
 * Which agents a mutating command acts on.
 *
 * `--target` always wins. Without it, a human at a terminal is asked; anything
 * else — a pipe, `--json`, CI, `--no-interactive`, an empty selection — falls
 * back to the whole catalog, which is what the old default `'all'` did.
 *
 * `null` means the user cancelled the prompt, so the caller must write nothing
 * at all rather than installing to everywhere by accident.
 */
async function selectTargets(
  flags: SkillFlags,
  mode: { json: boolean },
): Promise<SkillTarget[] | null> {
  if (flags.target !== undefined) return resolveTargetListOrThrow(flags.target);
  if (flags.interactive === false || mode.json) return skillTargets();

  const catalog = skillTargets();
  const io = defaultTargetPromptIO(catalog);
  if (!io.canPrompt()) return catalog;

  const chosen = await chooseTargets(catalog, io);
  if (chosen === null) {
    errLine(paint.dim('cancelled — nothing was written'));
    return null;
  }
  if (chosen.length === 0) {
    errLine(paint.dim('no agents selected — nothing was written'));
    return null;
  }
  return chosen;
}

type InstallAction = InstallResult['action'];

function renderResults(results: InstallResult[], mode: { json: boolean }): void {
  if (mode.json) {
    printJson(results.map((r) => ({ target: r.target, action: r.action, path: r.path })));
    return;
  }

  const counts: Record<InstallAction, number> = {
    written: 0,
    overwritten: 0,
    skipped: 0,
    removed: 0,
    'not-found': 0,
  };
  for (const r of results) counts[r.action]++;

  for (const r of results) {
    const icon = actionIcon(r.action);
    const detail = r.path ? `  ${r.path}` : '';
    outLine(`${icon}  ${r.target}${detail}`);
  }

  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([a, n]) => `${n} ${a}`);
  if (parts.length > 0) errLine(paint.dim(parts.join(', ')));
}

function actionIcon(action: InstallAction): string {
  switch (action) {
    case 'written':
      return paint.green('✓');
    case 'overwritten':
      return paint.yellow('↻');
    case 'skipped':
      return paint.dim('–');
    case 'removed':
      return paint.red('✗');
    case 'not-found':
      return paint.dim('?');
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
