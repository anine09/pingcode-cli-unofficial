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
  downloadReleaseAsset,
  fetchLatestRelease,
  removeFile,
  syncSkills,
  validateStaging,
  verifyInstall,
} from '../../core/update';
import { TransportError } from '../../core/errors';
import { extractZip } from '../../core/zip';
import { detectArch, detectPlatform, installDir, skillTargets } from '../../core/paths';
import { contextFor, modeOf } from './common';
import { errLine, paint, printJson } from '../output';
import { addGlobalOptions } from '../globals';

/**
 * `pingcode self-update` — download the latest GitHub Release and atomically
 * replace the current installation.
 *
 * The command is a thin orchestrator: it checks for an update, resolves the
 * correct platform asset, downloads and unpacks it, swaps the install
 * directory, syncs bundled skill docs, and verifies the new binary.
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
    .description('update the CLI to the latest GitHub Release')
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

  // Could not determine version (network error, rate limit, no cache) and not forcing.
  if (check.status === 'unknown' && !flags.force) {
    if (mode.json) {
      printJson({ status: 'unknown', error: 'could not check for updates' });
    } else {
      errLine(paint.yellow('Could not check for updates (network error or rate limit)'));
      errLine(paint.dim('  try again later, or use --force to skip the check'));
    }
    return;
  }

  // 2-3. Fetch release metadata (needed for asset name + download URL).
  const release = await fetchLatestRelease();

  // If the fetched version matches current and we're not forcing, still up-to-date.
  if (release.version === VERSION && !flags.force) {
    if (mode.json) {
      printJson({ status: 'up-to-date', version: VERSION });
    } else {
      errLine(paint.green(`Already up to date (v${VERSION})`));
    }
    return;
  }

  const oldVersion = VERSION;
  const newVersion = release.version;

  // 4. Build asset name from platform/arch.
  const platform = detectPlatform();
  const arch = detectArch();
  const assetName = `pingcode-cli-v${newVersion}-${platform}-${arch}.zip`;

  // 5. Find matching asset.
  const asset = release.assets.find((a) => a.name === assetName);
  if (asset === undefined) {
    throw new TransportError(`no release asset found: ${assetName}`, {
      hint: `available assets: ${release.assets.map((a) => a.name).join(', ') || '(none)'}`,
    });
  }

  const install = installDir();
  const stagingDir = path.join(install, '.staging');

  // 6. --dry-run: print plan and exit.
  if (ctx.dryRun) {
    printDryRunPlan({
      oldVersion,
      newVersion,
      assetName: asset.name,
      downloadUrl: asset.browser_download_url,
      install,
      stagingDir,
      json: mode.json,
    });
    return;
  }

  // 7. Download to temp.
  const tmpZip = path.join(os.tmpdir(), asset.name);
  try {
    errLine(paint.dim(`Downloading ${asset.name}...`));
    await downloadReleaseAsset(asset.browser_download_url, tmpZip);

    // 8. Extract to staging.
    errLine(paint.dim('Extracting to staging...'));
    cleanStaging(stagingDir);
    await extractZip(tmpZip, stagingDir);

    // 9. Validate staging.
    if (!validateStaging(stagingDir)) {
      cleanStaging(stagingDir);
      throw new TransportError(
        'invalid release archive: dist/bin/pingcode.js not found',
      );
    }

    // 10. Atomic replace.
    errLine(paint.dim(`Installing v${newVersion}...`));
    await atomicReplace(install, stagingDir);

    // 11. Sync skills.
    const skillSource = path.join(install, 'skills', 'pingcode');
    if (dirExists(skillSource)) {
      errLine(paint.dim('Syncing skills...'));
      await syncSkills(skillSource, skillTargets());
    }

    // 12. Verify.
    errLine(paint.dim('Verifying...'));
    const verified = verifyInstall(install, (file, args) =>
      String(execFileSync(file, args, { encoding: 'utf8' })),
    );

    // 13. Report.
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
    // Clean up temp zip regardless of success or failure.
    removeFile(tmpZip);
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
      errLine(paint.yellow('Could not check for updates (network error or rate limit)'));
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
