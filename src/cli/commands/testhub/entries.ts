import { UsageError } from '../../../core/errors';
import { parseJsonDocument, readJsonStdin, readTextFile } from '../../../core/jsonInput';

/**
 * Reading the entry list of a testhub `…/bulk` leaf, shared by
 * `cases bulk-create`, `cases bulk-update` and `runs bulk-update`.
 *
 * **Why a JSON document rather than repeatable flags.** Every entry of these
 * endpoints can carry its own title, state, remark or steps, and a repeatable flag
 * that packs four fields into one string is a private mini-language nobody can
 * guess. A JSON array is already the shape an agent produces and it composes with
 * `jq`. The two `bulk-update` leaves *also* accept the friendlier
 * `--case`/`--run` + shared-flag form, because "mark these twenty 就绪" needs no
 * file at all; the file is the expressive half, not the only half.
 *
 * The refined leaf earns its place over
 * `pingcode api POST /v1/testhub/cases/bulk --body-file` for four reasons, and the
 * third is the one that pays for this file:
 *
 *  1. **names resolve.** A state, type, importance level, executor or maintainer may
 *     be a name; the generic layer takes ids only.
 *  2. **the cap is checked before the request** — 100 entries, the server's own
 *     limit (live 2026-08-04), reported against the flag rather than the wire field.
 *  3. **fields the server accepts and throws away are refused.** `suite_id` on
 *     either `cases/bulk` half and `state_id` on the create half answer HTTP 200 and
 *     land nothing (live 2026-08-04). Without this check a 60-entry import would
 *     silently produce 60 cases in the wrong module, and the response would look
 *     perfect. A plain typo is caught the same way.
 *  4. per-element results are rendered, because `POST /runs/bulk` reports failures
 *     *inside* a 200 response.
 *
 * Same judgement `_shared/bulkEntries.ts` was written under — and deliberately not
 * that file: it is hard-wired to the `{name, start, end}` shape of the two pjm
 * planning bulks, and generalising it would mean touching a file another child owns
 * (`cli/commands/common.ts` is out of scope for the same reason).
 */

/** What one entry may contain, and what it must not. */
export type EntrySchema = {
  /** The wrapper key the wire itself uses, accepted as an alternative to a bare array. */
  wrapperKey: string;
  allowed: readonly string[];
  /**
   * Keys the API accepts and then ignores, or that this leaf cannot express safely.
   * Each maps to the explanation the user gets — naming the command that *can* do it.
   */
  refused?: Readonly<Record<string, string>>;
};

export type EntrySource = { file?: string | undefined };

/** One entry, still verbatim: values are validated by the caller that knows their types. */
export type RawEntry = { at: string; record: Record<string, unknown> };

export async function readEntryFile(
  source: EntrySource,
  schema: EntrySchema,
  hint: string,
): Promise<RawEntry[]> {
  const path = source.file?.trim() ?? '';
  if (path === '') {
    throw new UsageError('--file <path|-> is required', { hint });
  }

  const document =
    path === '-'
      ? await readJsonStdin()
      : parseJsonDocument(await readTextFile(path, '--file'), `--file ${path}`);

  const list = unwrap(document, schema.wrapperKey);
  if (list.length === 0) {
    // Upstream refuses an empty array too (400 `100039`), but doing it here costs no
    // request and names the flag rather than the wire field.
    throw new UsageError('--file contained no entries', {
      hint: `expected a non-empty JSON array, or {"${schema.wrapperKey}": [ … ]}`,
    });
  }

  return list.map((raw, index) => readEntry(raw, `entry ${index}`, schema));
}

function unwrap(document: unknown, wrapperKey: string): unknown[] {
  if (Array.isArray(document)) return document;
  if (typeof document === 'object' && document !== null) {
    const wrapped = (document as Record<string, unknown>)[wrapperKey];
    if (Array.isArray(wrapped)) return wrapped;
  }
  throw new UsageError('--file must contain a JSON array of entries', {
    hint: `either [ {…}, {…} ] or {"${wrapperKey}": [ {…}, {…} ]}`,
  });
}

function readEntry(raw: unknown, at: string, schema: EntrySchema): RawEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageError(`${at} is not a JSON object`);
  }
  const record = raw as Record<string, unknown>;

  for (const [key, why] of Object.entries(schema.refused ?? {})) {
    if (record[key] !== undefined) throw new UsageError(`${at} sets ${key}: ${why}`);
  }

  const allowed = new Set<string>(schema.allowed);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new UsageError(`${at} has unknown field(s): ${unknown.join(', ')}`, {
      hint: `accepted keys: ${[...allowed].sort().join(', ')} — this API silently ignores anything else, so a typo would land the row without the field`,
    });
  }

  return { at, record };
}

/** A required string field of one entry. */
export function entryString(entry: RawEntry, key: string): string {
  const value = entry.record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`${entry.at}.${key} must be a non-empty string`);
  }
  return value;
}

/** An optional string field of one entry. */
export function optionalEntryString(entry: RawEntry, key: string): string | undefined {
  const value = entry.record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new UsageError(`${entry.at}.${key} must be a string`);
  }
  return value;
}

/**
 * A `x` / `x_id` pair inside an entry, exactly as the `--x` / `--x-id` flags work:
 * one resolves by name, the other is sent verbatim, and both together is exit 2.
 */
export function entryPair(
  entry: RawEntry,
  field: string,
): { byName: string } | { byId: string } | undefined {
  const byName = optionalEntryString(entry, field);
  const byId = optionalEntryString(entry, `${field}_id`);
  if (byName !== undefined && byId !== undefined) {
    throw new UsageError(`${entry.at} sets both ${field} and ${field}_id`, {
      hint: `use ${field} for a name to resolve, or ${field}_id for an id sent unchanged`,
    });
  }
  if (byId !== undefined) return { byId };
  if (byName !== undefined) return { byName };
  return undefined;
}

/** An entry's `properties` map, passed through untyped — the keys are validated upstream. */
export function entryProperties(entry: RawEntry): Record<string, unknown> | undefined {
  const value = entry.record.properties;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(`${entry.at}.properties must be an object of key/value pairs`, {
      hint:
        'only genuinely custom properties belong here; the built-in fields listed by ' +
        '`pingcode testhub meta case-properties` are top-level fields, not properties',
    });
  }
  return value as Record<string, unknown>;
}

/**
 * An entry's `steps[]`, passed through as objects.
 *
 * Whole-array replacement, and a step without its `step_id` is re-created with a new
 * one (GOTCHA #9) — stated in `--help` rather than guessed at here, because a bulk
 * importer legitimately sends brand-new steps with no ids at all.
 */
export function entrySteps(entry: RawEntry): Record<string, unknown>[] | undefined {
  const value = entry.record.steps;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((step) => typeof step !== 'object' || step === null)) {
    throw new UsageError(`${entry.at}.steps must be an array of step objects`);
  }
  return value as Record<string, unknown>[];
}

/**
 * The client-side batch cap: **100**, which is the server's own limit.
 *
 * Live 2026-08-04: all four `cases/bulk` and `runs/bulk` halves answer 400 `100039`
 * `<field> 数组的长度必须小于等于 100` for 101 entries, *before* validating any
 * field — including the two halves the docs declare with no limit at all. The
 * client check exists to name the flag and to spend no request, not to be stricter
 * than the API: capping at the 50 that belongs to the plan-scoped
 * `…/plans/{id}/runs/bulk` would refuse 51–100 entries the server accepts.
 */
export const BULK_ENTRY_LIMIT = 100;

export function checkBulkLimit(count: number, what: string): void {
  if (count > BULK_ENTRY_LIMIT) {
    throw new UsageError(
      `${count} ${what} were given, but the API accepts at most ${BULK_ENTRY_LIMIT} per call`,
      { hint: `split the work into batches of ${BULK_ENTRY_LIMIT} or fewer` },
    );
  }
}
