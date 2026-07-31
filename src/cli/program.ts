import { Command } from 'commander';
import { VERSION } from '../version';

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

/**
 * Build the root program. Commands are registered by `cli/commands/*`.
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
    .option(
      '--host <url>',
      'PingCode host (default https://open.pingcode.com; self-hosted: https://pingcode.example.com)',
    )
    .option('--json', 'emit machine-readable JSON on stdout')
    .option('--dry-run', 'preview mutating requests without sending them')
    .option('--no-cache', 'bypass the on-disk metadata cache')
    .option('--verbose', 'log requests to stderr (secrets redacted)')
    .showHelpAfterError()
    .exitOverride();

  return program;
}
