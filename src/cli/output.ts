import pc from 'picocolors';
import type { RequestPlan } from '../core/errors';
import { PingcodeError, exitCodeFor, kindOf } from '../core/errors';
import { maskIdentifier, redactHeaders, redactSnippet, redactUrl } from '../core/redact';

/**
 * Output discipline (design §7.3):
 * - `--json` ⇒ **stdout carries only JSON**; logs, warnings and errors go to stderr.
 * - colour is off when stdout is not a TTY or `NO_COLOR` is set; piping does *not*
 *   imply `--json`, it only drops decoration.
 * - truncation uses the terminal width on a TTY, otherwise a fixed 120 columns.
 *
 * `redactUrl` and friends are implemented in `core/redact.ts` (core cannot import
 * cli) and re-exported here so callers have a single obvious entry point.
 */
export { maskIdentifier, redactHeaders, redactSnippet, redactUrl };

export const FALLBACK_WIDTH = 120;

export type OutputMode = {
  json: boolean;
};

type Writer = (chunk: string) => void;

const defaultStdout: Writer = (chunk) => void process.stdout.write(chunk);
const defaultStderr: Writer = (chunk) => void process.stderr.write(chunk);

let stdoutWriter: Writer = defaultStdout;
let stderrWriter: Writer = defaultStderr;

/** Test seam: redirect output. Returns a restore function. */
export function captureOutput(out: Writer, err: Writer): () => void {
  stdoutWriter = out;
  stderrWriter = err;
  return () => {
    stdoutWriter = defaultStdout;
    stderrWriter = defaultStderr;
  };
}

export function writeOut(text: string): void {
  stdoutWriter(text);
}

export function writeErr(text: string): void {
  stderrWriter(text);
}

export function outLine(text = ''): void {
  writeOut(`${text}\n`);
}

export function errLine(text = ''): void {
  writeErr(`${text}\n`);
}

export function isColorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  return process.stdout.isTTY === true;
}

/** Colour helpers that become no-ops when colour is disabled. */
export const paint = {
  dim: (text: string): string => (isColorEnabled() ? pc.dim(text) : text),
  bold: (text: string): string => (isColorEnabled() ? pc.bold(text) : text),
  red: (text: string): string => (isColorEnabled() ? pc.red(text) : text),
  yellow: (text: string): string => (isColorEnabled() ? pc.yellow(text) : text),
  green: (text: string): string => (isColorEnabled() ? pc.green(text) : text),
};

export function outputWidth(): number {
  if (process.stdout.isTTY === true) {
    const columns = process.stdout.columns;
    if (typeof columns === 'number' && columns > 20) return columns;
  }
  return FALLBACK_WIDTH;
}

export function truncate(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max === 1) return '…';
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Render a 10-digit unix **seconds** timestamp for humans, in local time.
 * `--json` output keeps the raw seconds so agents parse deterministically
 * (research §7).
 */
export function formatTimestamp(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export function printJson(value: unknown): void {
  outLine(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

export type Column<T> = {
  header: string;
  value: (row: T) => string;
  /** Columns with a lower priority are shrunk first when the table is too wide. */
  flex?: boolean;
};

const GAP = '  ';
const MIN_COLUMN_WIDTH = 6;

export function renderTable<T>(columns: Column<T>[], rows: T[], width = outputWidth()): string {
  if (columns.length === 0) return '';
  const cells = rows.map((row) => columns.map((column) => sanitizeCell(column.value(row))));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((row) => (row[index] ?? '').length), 1),
  );

  shrinkToFit(columns, widths, width);

  const lines: string[] = [];
  lines.push(
    paint.bold(
      columns
        .map((column, index) => padOrTruncate(column.header, widths[index] ?? column.header.length))
        .join(GAP)
        .trimEnd(),
    ),
  );
  for (const row of cells) {
    lines.push(
      columns
        .map((_, index) => padOrTruncate(row[index] ?? '', widths[index] ?? 0))
        .join(GAP)
        .trimEnd(),
    );
  }
  return lines.join('\n');
}

export function printTable<T>(columns: Column<T>[], rows: T[]): void {
  if (rows.length === 0) {
    errLine(paint.dim('no results'));
    return;
  }
  outLine(renderTable(columns, rows));
}

function shrinkToFit<T>(columns: Column<T>[], widths: number[], width: number): void {
  const gaps = GAP.length * (columns.length - 1);
  const total = (): number => widths.reduce((sum, w) => sum + w, 0) + gaps;
  // Shrink the widest flexible column first, then the widest of any column.
  for (let guard = 0; total() > width && guard < 1000; guard += 1) {
    const candidates = columns
      .map((column, index) => ({ index, flex: column.flex === true, w: widths[index] ?? 0 }))
      .filter((entry) => entry.w > MIN_COLUMN_WIDTH);
    if (candidates.length === 0) break;
    const flexible = candidates.filter((entry) => entry.flex);
    const pool = flexible.length > 0 ? flexible : candidates;
    let target = pool[0];
    if (target === undefined) break;
    for (const entry of pool) if (entry.w > target.w) target = entry;
    widths[target.index] = target.w - 1;
  }
}

function padOrTruncate(value: string, width: number): string {
  const clipped = truncate(value, width);
  return clipped.padEnd(width, ' ');
}

function sanitizeCell(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ');
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export type ErrorPayload = {
  kind: string;
  message: string;
  code?: string;
  exit: number;
};

export function errorPayload(error: unknown): ErrorPayload {
  const exit = exitCodeFor(error);
  const kind = kindOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const payload: ErrorPayload = { kind, message: redactSnippet(redactUrl(message)), exit };
  if (error instanceof PingcodeError && error.code !== undefined) payload.code = error.code;
  return payload;
}

/**
 * Errors always go to **stderr**, in both modes, so the stdout-is-pure-JSON
 * contract survives the failure path (design §7.3).
 */
export function printError(error: unknown, mode: OutputMode): void {
  const payload = errorPayload(error);
  if (mode.json) {
    writeErr(`${JSON.stringify({ error: payload })}\n`);
    return;
  }
  errLine(`${paint.red('error')}: ${payload.message}`);
  if (error instanceof PingcodeError && error.hint !== undefined) {
    errLine(paint.dim(`hint: ${error.hint}`));
  }
  if (payload.code !== undefined) {
    errLine(paint.dim(`api code: ${payload.code}`));
  }
}

// ---------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------

/**
 * A dry run is a **result, not a log** (design §7.3): in `--json` mode the plan
 * goes to stdout so the mode agents are told to use still produces output.
 * The plan's url/headers are redacted by the transport layer before it is thrown.
 */
export function printDryRun(plan: RequestPlan, mode: OutputMode): void {
  const request: Record<string, unknown> = {
    method: plan.method,
    url: redactUrl(plan.url),
    headers: redactHeaders(plan.headers),
  };
  if (plan.body !== undefined) request.body = plan.body;

  if (mode.json) {
    printJson({ dry_run: true, request });
    return;
  }

  errLine(paint.yellow('dry run — nothing was sent'));
  errLine(`${plan.method} ${redactUrl(plan.url)}`);
  for (const [name, value] of Object.entries(redactHeaders(plan.headers))) {
    errLine(paint.dim(`${name}: ${value}`));
  }
  if (plan.body !== undefined) {
    errLine(JSON.stringify(plan.body, null, 2));
  }
}
