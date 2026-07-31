/**
 * Diagnostic channel. Everything a logger emits goes to **stderr** so the
 * `--json` stdout-purity contract (design §7.3) can never be broken by a log line.
 */
export type Logger = {
  /** Always emitted. */
  warn(message: string): void;
  /** Emitted only with `--verbose`. */
  debug(message: string): void;
};

export type LoggerOptions = {
  verbose?: boolean | undefined;
  /** Sink override, used by tests. Defaults to `process.stderr`. */
  write?: ((chunk: string) => void) | undefined;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((chunk: string) => void process.stderr.write(chunk));
  const verbose = options.verbose === true;
  return {
    warn(message) {
      write(`warning: ${message}\n`);
    },
    debug(message) {
      if (verbose) write(`${message}\n`);
    },
  };
}

/** A logger that swallows everything — handy in tests. */
export const silentLogger: Logger = {
  warn() {},
  debug() {},
};

/** Collects messages instead of writing them — handy in tests. */
export function createMemoryLogger(verbose = true): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    warn(message) {
      lines.push(`warning: ${message}`);
    },
    debug(message) {
      if (verbose) lines.push(message);
    },
  };
}
