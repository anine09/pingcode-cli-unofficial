#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from '../cli/program';

async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` / `--version` exit 0; commander's own usage errors exit 2 (design §5.2).
      return error.exitCode === 0 ? 0 : 2;
    }
    throw error;
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
