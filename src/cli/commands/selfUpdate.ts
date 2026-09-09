import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import path from 'node:path';
import { VERSION } from '../../version';
import { checkForUpdate } from '../../core/update-check';
import {
  dirExists,
  fetchLatestInfo,
  installViaNpm,
  packageSkillDir,
  syncSkills,
} from '../../core/update';
import { TransportError } from '../../core/errors';
import type { ExecFn } from '../../core/update';
import { contextFor, modeOf } from './common';
import { errLine, paint, printJson } from '../output';
import { addGlobalOptions } from '../globals';
import { skillTargets } from '../../core/paths';

/**
 * `pingcode self-update` — update the CLI to the latest npm-published version.
 *
 * A thin orchestrator: it checks for an update, fetches the latest version from
 * npm, asks npm to install it globally, re-syncs the bundled skill docs, and
 * reports the version npm actually installed.
 *
 * There is no download, staging, swap or rollback here — npm owns all of that,
 * including its own registry cache. What is *not* delegated is the check that
 * the install happened: `installViaNpm` reads the installed version back, so
 * `updated` is reported only when npm exited 0 **and** the version matches.
 *
 * All file-system work is delegated to `core/update.ts` because the layering
 * rule forbids `cli/` from importing `node:fs`.
 */

type SelfUpdateFlags = {
  checkOnly?: boolean;
  force?: boolean;
};

export function registerSelfUpdateCommands(program: Command): void {
  const cmd = program
    .command('self-update')
    .description('update the CLI to the latest npm-published version')
    .option('--check-only', 'check for updates without installing')
    .option('--force', 'force update even if already up to date');

  addGlobalOptions(cmd).action(async (flags: SelfUpdateFlags, command: Command) => {
    await runSelfUpdate(flags, command);
  });
}

// ---------------------------------------------------------------------------
// action
// ---------------------------------------------------------------------------

async function runSelfUpdate(flags: SelfUpdateFlags, command: Command): Promise<void> {
  const { ctx } = contextFor(command);
  const mode = modeOf(ctx);

  // 1. Check for update.  --check-only bypasses cache so it always queries the network.
  //    This path is plain HTTP and touches npm nowhere, so it works on a box with
  //    no npm at all (prd R3).
  const check = await checkForUpdate(undefined, flags.checkOnly ? { skipCache: true } : undefined);

  // --check-only: print result and exit.
  if (flags.checkOnly) {
    printCheckResult(check, mode.json);
    return;
  }

  // Already up-to-date and not forcing.
  if (check.status === 'up-to-date' && !flags.force) {
    if (mode.json) {
      printJson({ status: 'up-to-date', version: VERSION });
    } else {
      errLine(paint.green(`Already up to date (v${VERSION})`));
    }
    return;
  }

  // Check skipped (PINGCODE_NO_UPDATE_CHECK) and not forcing.
  if (check.status === 'skipped' && !flags.force) {
    if (mode.json) {
      printJson({ status: 'skipped' });
    } else {
      errLine(paint.dim('Update check skipped (PINGCODE_NO_UPDATE_CHECK is set)'));
    }
    return;
  }

  // Could not determine version (network error, no cache) and not forcing.
  if (check.status === 'unknown' && !flags.force) {
    if (mode.json) {
      printJson({ status: 'unknown', error: 'could not check for updates' });
    } else {
      errLine(paint.yellow('Could not check for updates (network error)'));
      errLine(paint.dim('  try again later, or use --force to skip the check'));
    }
    return;
  }

  // 2. Fetch registry info (version + tarball URL).
  const info = await fetchLatestInfo();

  // If the fetched version matches current and we're not forcing, still up-to-date.
  if (info.version === VERSION && !flags.force) {
    if (mode.json) {
      printJson({ status: 'up-to-date', version: VERSION });
    } else {
      errLine(paint.green(`Already up to date (v${VERSION})`));
    }
    return;
  }

  const oldVersion = VERSION;
  const newVersion = info.version;

  // 3. --dry-run: print plan and exit.
  if (ctx.dryRun) {
    printDryRunPlan({
      oldVersion,
      newVersion,
      assetName: path.basename(new URL(info.tarballUrl).pathname),
      downloadUrl: info.tarballUrl,
      json: mode.json,
    });
    return;
  }

  // 4. Install with npm. Throws on missing npm, non-zero exit, or a version that
  //    does not read back — none of those may report `updated`.
  errLine(paint.dim(`Installing v${newVersion}...`));
  try {
    await installViaNpm(cliExec, newVersion);
  } catch (error) {
    // Diagnostics to stderr; stdout stays JSON-only under --json.
    if (!mode.json) {
      errLine(paint.red(`update failed: ${errorMessageOf(error)}`));
      const hint = error instanceof TransportError ? error.hint : undefined;
      if (hint !== undefined && hint !== '') errLine(paint.dim(`  ${hint}`));
    }
    throw error;
  }

  // 5. Sync skills from the package's own directory.
  const skillSource = packageSkillDir();
  if (dirExists(skillSource)) {
    errLine(paint.dim('Syncing skills...'));
    await syncSkills(skillSource, skillTargets());
  }

  // 6. Report.
  if (mode.json) {
    printJson({
      status: 'updated',
      previous_version: oldVersion,
      new_version: newVersion,
    });
  } else {
    errLine(paint.green(`updated v${oldVersion} → v${newVersion}`));
  }
}

/** npm invocation for the interactive command — inherits the terminal's stdin. */
const cliExec: ExecFn = (file, args) => execFileSync(file, args, { encoding: 'utf8' });

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function printCheckResult(
  check: Awaited<ReturnType<typeof checkForUpdate>>,
  json: boolean,
): void {
  if (json) {
    printJson({
      status: check.status,
      current: VERSION,
      ...(check.status === 'update-available' ? { latest: check.latest } : {}),
    });
    return;
  }

  switch (check.status) {
    case 'update-available':
      errLine(paint.yellow(`Update available: v${check.current} → v${check.latest}`));
      break;
    case 'up-to-date':
      errLine(paint.green(`Already up to date (v${VERSION})`));
      break;
    case 'skipped':
      errLine(paint.dim('Update check skipped (PINGCODE_NO_UPDATE_CHECK is set)'));
      break;
    case 'unknown':
      errLine(paint.yellow('Could not check for updates (network error)'));
      break;
  }
}

interface DryRunPlan {
  oldVersion: string;
  newVersion: string;
  assetName: string;
  downloadUrl: string;
  json: boolean;
}

function printDryRunPlan(plan: DryRunPlan): void {
  if (plan.json) {
    printJson({
      dry_run: true,
      current_version: plan.oldVersion,
      target_version: plan.newVersion,
      asset: plan.assetName,
      download_url: plan.downloadUrl,
      skill_targets: skillTargets().map((t) => t.dir),
    });
    return;
  }

  errLine(paint.yellow('dry run — nothing will be changed'));
  errLine(`  current:  v${plan.oldVersion}`);
  errLine(`  target:   v${plan.newVersion}`);
  errLine(`  asset:    ${plan.assetName}`);
  errLine(`  skills:   ${skillTargets().map((t) => t.dir).join(', ')}`);
}
