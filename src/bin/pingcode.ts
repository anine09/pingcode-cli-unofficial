#!/usr/bin/env node
import { CommanderError, type Command } from 'commander';
import { printDryRun, printError, errLine, paint } from '../cli/output';
import { buildProgram, type RawGlobalOptions } from '../cli/program';
import { DryRunHalt, exitCodeFor } from '../core/errors';
import { checkForUpdate, ENV_NO_UPDATE_CHECK } from '../core/update-check';

/**
 * Fire-and-forget version check. Prints a stderr hint if a newer GitHub
 * Release exists. Never blocks or throws — the check is best-effort.
 *
 * Skipped when:
 * - `--json` is active (stdout purity contract)
 * - `PINGCODE_NO_UPDATE_CHECK=1` is set
 */
function notifyUpdateCheck(jsonMode: boolean): void {
  if (jsonMode) return;
  if (process.env[ENV_NO_UPDATE_CHECK] === '1') return;
  // Fire-and-forget — don't await, don't block CLI startup.
  void checkForUpdate().then((result) => {
    if (result.status === 'update-available') {
      errLine(
        paint.yellow(
          `Update available: ${result.current} → ${result.latest}`,
        ),
      );
      errLine(paint.dim('Run: pingcode self-update'));
    }
  });
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

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    printError(error, { json: process.argv.includes('--json') });
    process.exitCode = exitCodeFor(error);
  },
);
