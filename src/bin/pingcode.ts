#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { CommanderError, type Command } from 'commander';
import { printDryRun, printError, errLine, paint } from '../cli/output';
import { buildProgram, type RawGlobalOptions } from '../cli/program';
import { DryRunHalt, exitCodeFor } from '../core/errors';
import { configDir } from '../core/config';
import { ENV_NO_UPDATE_CHECK } from '../core/update-check';
import { isCooldownActive, readHint, removeHint, runAutoUpdate } from '../core/update';
import { VERSION } from '../version';

/**
 * Background update check. On every CLI startup:
 *
 * 1. If a hint file exists (left by a previous failed auto-update), print
 *    the update message to stderr and remove the hint.
 * 2. Unless disabled or on cooldown, spawn a detached `__auto-update` child
 *    process that checks for + installs updates in the background.
 *
 * Skipped when:
 * - `--json` is active (stdout purity contract)
 * - `PINGCODE_NO_UPDATE_CHECK=1` is set
 */
function notifyUpdateCheck(jsonMode: boolean): void {
  if (jsonMode) return;
  if (process.env[ENV_NO_UPDATE_CHECK] === '1') return;

  const dir = configDir();

  // a) Check hint file — if a previous auto-update failed, tell the user.
  const hint = readHint(dir);
  if (hint !== undefined) {
    errLine(paint.yellow(`Update available: ${VERSION} → ${hint.version}`));
    errLine(paint.dim('Run: pingcode self-update'));
    try { removeHint(dir); } catch { /* best-effort */ }
  }

  // b) Spawn detached auto-update (unless running as auto-update or on cooldown).
  if (process.argv[2] !== '__auto-update' && !isCooldownActive(dir)) {
    const child = spawn(process.execPath, [process.argv[1]!, '__auto-update'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [ENV_NO_UPDATE_CHECK]: '1' },
    });
    child.unref();
  }
}

function detectJsonMode(program: Command, argv: string[]): boolean {
  try {
    if (program.opts<RawGlobalOptions>().json === true) return true;
  } catch {
    // Options may be unparsed if the failure happened early.
  }
  return argv.includes('--json');
}

async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  const jsonMode = argv.includes('--json');
  notifyUpdateCheck(jsonMode);
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    const mode = { json: detectJsonMode(program, argv) };

    // A refused mutation under --dry-run is a success (design D8).
    if (error instanceof DryRunHalt) {
      printDryRun(error.plan, mode);
      return 0;
    }

    // `--help` / `--version` exit 0; commander's own usage errors exit 2 (design §5.2).
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }

    printError(error, mode);
    return exitCodeFor(error);
  }
}

// Handle hidden __auto-update command (spawned as a detached child process).
if (process.argv[2] === '__auto-update') {
  runAutoUpdate().then(
    () => process.exit(0),
    () => process.exit(1),
  );
} else {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      printError(error, { json: process.argv.includes('--json') });
      process.exitCode = exitCodeFor(error);
    },
  );
}
