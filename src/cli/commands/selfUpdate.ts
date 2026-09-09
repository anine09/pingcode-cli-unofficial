import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from '../../version';
import { checkForUpdate } from '../../core/update-check';
import {
  atomicReplace,
  cleanStaging,
  dirExists,
  downloadTarball,
  ensureDir,
  fetchLatestInfo,
  removeFile,
  restoreBackup,
  syncSkills,
  validateStaging,
  verifyBundle,
  writeBufferToFile,
} from '../../core/update';
import { TransportError } from '../../core/errors';
import { extractTarball } from '../../core/update';
import type { ExecFn } from '../../core/update';
import { contextFor, modeOf } from './common';
import { errLine, paint, printJson } from '../output';
import { addGlobalOptions } from '../globals';
import { installDir, skillTargets } from '../../core/paths';

/**
 * `pingcode self-update` — download the latest version from npm registry and
 * atomically replace the current installation.
 *
 * The command is a thin orchestrator: it checks for an update, fetches the
 * latest version info from npm, downloads and unpacks the tarball, verifies the
 * staged bundle actually runs, swaps the install directory, syncs bundled
 * skill docs, and verifies the installed bundle — restoring the previous
 * install if it does not.
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
    .option('--check-only', 'check for updates without downloading')
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

  // 3. Download tarball.
  const tarballBuffer = await downloadTarball(info.tarballUrl);

  // 4. Build display name for tarball URL.
  const tarballName = path.basename(new URL(info.tarballUrl).pathname);

  const install = installDir();
  const stagingDir = path.join(install, '.staging');

  // 5. --dry-run: print plan and exit.
  if (ctx.dryRun) {
    printDryRunPlan({
      oldVersion,
      newVersion,
      assetName: tarballName,
      downloadUrl: info.tarballUrl,
      install,
      stagingDir,
      json: mode.json,
    });
    return;
  }

  // 6. Extract to staging.
  errLine(paint.dim(`Downloading ${tarballName}...`));
  errLine(paint.dim('Extracting to staging...'));
  const tmpTarball = path.join(os.tmpdir(), `pingcode-cli-${newVersion}.tgz`);
  try {
    writeBufferToFile(tmpTarball, tarballBuffer);
    cleanStaging(stagingDir);
    ensureDir(stagingDir);
    extractTarball(tarballBuffer, stagingDir);

    // 7. Validate staging.
    if (!validateStaging(stagingDir)) {
      cleanStaging(stagingDir);
      throw new TransportError(
        'invalid tarball: dist/bin/pingcode.js not found',
      );
    }

    // 8. Verify the staged bundle runs before we touch the live install.
    errLine(paint.dim('Verifying...'));
    const exec: ExecFn = (file, args) =>
      String(execFileSync(file, args, { encoding: 'utf8' }));
    verifyBundle(stagingDir, exec, newVersion);

    // 9. Atomic replace.
    errLine(paint.dim(`Installing v${newVersion}...`));
    await atomicReplace(install, stagingDir);

    // 10. Sync skills.
    const skillSource = path.join(install, 'skills', 'pingcode');
    if (dirExists(skillSource)) {
      errLine(paint.dim('Syncing skills...'));
      await syncSkills(skillSource, skillTargets());
    }

    // 11. Verify the installed bundle. The swap kept the backup, and a dead
    // binary here would strand the user — put the previous install back rather
    // than leaving nothing runnable on disk.
    let verified: string;
    try {
      verified = verifyBundle(install, exec, newVersion);
    } catch (error) {
      restoreBackup(install);
      throw new TransportError(
        `installed bundle failed verification: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          hint: `restore manually: mv "${install}.backup" "${install}"`,
          cause: error,
        },
      );
    }

    // The previous install is only dropped once the new one is proven good.
    removeFile(`${install}.backup`);

    // 12. Report.
    if (mode.json) {
      printJson({
        status: 'updated',
        previous_version: oldVersion,
        new_version: verified,
      });
    } else {
      errLine(paint.green(`updated v${oldVersion} → v${verified}`));
    }
  } finally {
    // Clean up temp tarball regardless of success or failure.
    removeFile(tmpTarball);
  }
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
  install: string;
  stagingDir: string;
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
      install_dir: plan.install,
      staging_dir: plan.stagingDir,
      skill_targets: skillTargets().map((t) => t.dir),
    });
    return;
  }

  errLine(paint.yellow('dry run — nothing will be changed'));
  errLine(`  current:  v${plan.oldVersion}`);
  errLine(`  target:   v${plan.newVersion}`);
  errLine(`  asset:    ${plan.assetName}`);
  errLine(`  install:  ${plan.install}`);
  errLine(`  staging:  ${plan.stagingDir}`);
  errLine(`  skills:   ${skillTargets().map((t) => t.dir).join(', ')}`);
}
