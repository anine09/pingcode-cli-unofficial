import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommanderError } from 'commander';
import { captureOutput } from '../../src/cli/output';
import { buildProgram } from '../../src/cli/program';
import { THIRTY_DAYS_MS } from '../../src/core/auth';
import { DryRunHalt, exitCodeFor } from '../../src/core/errors';
import { createFakeFetch, type FakeCall } from './fake';

/**
 * Run one `pingcode …` invocation exactly as `bin/pingcode.ts` does, with `fetch`
 * replaced at the global boundary and the config directory redirected to a temp dir.
 *
 * **Why this is a helper and not a sixth copy.** Five command-test files
 * (`apiCommand`, `resolveCommand`, `crosscutting`, `scmCommands`, `shipCommands`,
 * `testhubCommands`) each carry their own ~90-line version of this. S1d needed two more,
 * which would have made seven — well past the "same code three times" threshold in
 * `code-reuse-thinking-guide.md`. So the two new suites share this one, and the existing
 * five are deliberately **left alone**: rewiring six files another child may be editing
 * is scope this task does not own. This is the landing spot for that consolidation
 * whenever someone has a reason to touch them anyway.
 *
 * It also fixes, for its two callers, the harness defect D12.9 recorded: the hand-rolled
 * copies build their own root `Command` and therefore miss root-level settings that
 * propagate downwards (`allowExcessArguments(false)` was the one that mattered — a bare
 * `--yes false` was accepted in those harnesses while the real binary rejected it). This
 * helper calls `buildProgram()`, so what it tests is the tree the binary actually runs.
 */

export type CliRun = {
  stdout: string;
  stderr: string;
  exit: number;
  calls: FakeCall[];
  /** Only the requests that would change server state. */
  writes: FakeCall[];
};

export type CliHarness = {
  run: (argv: string[], responses?: Array<() => Response>) => Promise<CliRun>;
  /** The temp config directory, for a test that wants to inspect it. */
  dir: () => string;
};

const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

/**
 * Create the harness and register the `beforeEach`/`afterEach` that own the temp config
 * directory.
 *
 * The hooks are passed in rather than imported so this file stays a plain module: a test
 * helper that registers global hooks on import is a helper that cannot be read locally.
 */
export function createCliHarness(hooks: {
  beforeEach: (fn: () => void) => void;
  afterEach: (fn: () => void) => void;
}): CliHarness {
  let dir = '';
  let previousConfigDir: string | undefined;

  hooks.beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-cli-test-'));
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        clientId: 'test-client',
        clientSecret: 'test-secret',
        token: {
          accessToken: 'test-token',
          expiresAtMs: Date.now() + THIRTY_DAYS_MS,
          obtainedAtMs: Date.now(),
        },
      }),
      { mode: 0o600 },
    );
    previousConfigDir = process.env.PINGCODE_CONFIG_DIR;
    // Every suite must do this before running a leaf: an unguarded run would use the
    // developer's real `~/.pingcode`, and `auth logout` would wipe their credentials.
    process.env.PINGCODE_CONFIG_DIR = dir;
  });

  hooks.afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.PINGCODE_CONFIG_DIR;
    else process.env.PINGCODE_CONFIG_DIR = previousConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(argv: string[], responses: Array<() => Response> = []): Promise<CliRun> {
    const fake = createFakeFetch(responses.length === 0 ? [() => new Response('{}')] : responses);
    let stdout = '';
    let stderr = '';

    const restoreOutput = captureOutput(
      (chunk) => {
        stdout += chunk;
      },
      (chunk) => {
        stderr += chunk;
      },
    );
    // `core/logger.ts` writes straight to process.stderr, bypassing captureOutput.
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch as unknown as typeof globalThis.fetch;

    let exit = 0;
    try {
      const program = buildProgram();
      await program.parseAsync(['node', 'pingcode', ...argv]);
    } catch (error) {
      if (error instanceof DryRunHalt) {
        const { printDryRun } = await import('../../src/cli/output');
        printDryRun(error.plan, { json: argv.includes('--json') });
        exit = 0;
      } else if (error instanceof CommanderError) {
        exit = error.exitCode === 0 ? 0 : 2;
      } else {
        const { printError } = await import('../../src/cli/output');
        printError(error, { json: argv.includes('--json') });
        exit = exitCodeFor(error);
      }
    } finally {
      globalThis.fetch = realFetch;
      process.stderr.write = realStderrWrite;
      restoreOutput();
    }

    const writes = fake.calls.filter((call) => WRITE_METHODS.includes(call.method));
    return { stdout, stderr, exit, calls: fake.calls, writes };
  }

  return { run, dir: () => dir };
}
