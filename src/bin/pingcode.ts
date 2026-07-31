#!/usr/bin/env node
import { CommanderError, type Command } from 'commander';
import { printDryRun, printError } from '../cli/output';
import { buildProgram, type RawGlobalOptions } from '../cli/program';
import { DryRunHalt, exitCodeFor } from '../core/errors';

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
