import { Command } from 'commander';
import { VERSION } from '../version';
import { registerAuthCommands } from './commands/auth';
import { registerIdeaCommands } from './commands/idea';
import { registerMetaCommands } from './commands/meta';
import { registerProductCommands } from './commands/product';
import { registerProjectCommands } from './commands/project';
import { registerWorkItemCommands } from './commands/workItem';
import { addGlobalOptions } from './globals';

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

  registerAuthCommands(program);
  registerProjectCommands(program);
  registerWorkItemCommands(program);
  registerProductCommands(program);
  registerIdeaCommands(program);
  registerMetaCommands(program);

  return program;
}
