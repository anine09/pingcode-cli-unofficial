import { Command } from 'commander';
import { VERSION } from '../version';
import { addGlobalOptions } from './globals';
import { GROUPS } from './registry';

/**
 * Global flags, as parsed by commander. `--no-cache` yields `cache: false`.
 * Resolution into a runtime context happens in `cli/globals.ts`.
 */
export type RawGlobalOptions = {
  host?: string | undefined;
  json?: boolean | undefined;
  dryRun?: boolean | undefined;
  cache?: boolean | undefined;
  verbose?: boolean | undefined;
};

/** A fixed help width keeps `--help` output identical everywhere (and snapshottable). */
export const HELP_WIDTH = 100;

/**
 * Build the root program, with every command group registered.
 *
 * `exitOverride()` makes commander throw a `CommanderError` instead of calling
 * `process.exit()`, so `bin/pingcode.ts` owns every exit code (design §5.2).
 * The setting is inherited by subcommands via commander's `copyInheritedSettings`.
 *
 * The group list itself lives in `cli/registry.ts` and is iterated here, so adding a
 * command group is one row in that file and touches nothing else (design D6.2).
 * Registration order is `GROUPS` order, and it is the order `--help` prints.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('pingcode')
    .description('Command-line client for the PingCode Open API')
    .version(VERSION, '--version', 'output the CLI version')
    .configureHelp({ helpWidth: HELP_WIDTH })
    .showHelpAfterError()
    .exitOverride();

  addGlobalOptions(program);

  program.addHelpText(
    'after',
    '\nGlobal flags may be given before or after the subcommand.\n' +
      'Agents: prefer --json (stdout is JSON only) and run --dry-run before any write.\n',
  );

  for (const [, register] of GROUPS) register(program);

  return program;
}
