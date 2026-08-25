import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_ENTRY_LIMIT,
  checkBulkLimit,
  entryPair,
  entryProperties,
  entrySteps,
  entryString,
  optionalEntryString,
  readEntryFile,
  type EntrySchema,
  type RawEntry,
} from '../src/cli/commands/testhub/entries';
import { UsageError } from '../src/core/errors';
import { createCliHarness } from './helpers/cli';
import { jsonResponse } from './helpers/fake';

/**
 * Coverage for `src/cli/commands/testhub/entries.ts` — the shared reader and
 * validator behind `cases bulk-create`, `cases bulk-update` and `runs bulk-update`.
 *
 * Two layers are exercised:
 *  - the exported pure helpers are called **directly**, so every validation
 *    branch is asserted in isolation — the refused key, the unknown field, the
 *    `--x`/`--x-id` conflict, a malformed `properties`/`steps` shape, and the
 *    batch cap;
 *  - the real command tree is driven through `createCliHarness`, proving the
 *    `--file` flows end to end: `--json` keeps stdout pure, `--dry-run` writes
 *    nothing, and a bad entry is exit 2 before any request leaves the box.
 *
 * No network: the harness injects a fake `fetch`, and the direct tests touch
 * only temp files and a mocked stdin.
 */

// The end-to-end half owns a temp config dir per test via this harness.
const h = createCliHarness({ beforeEach, afterEach });

// The direct half owns a temp dir for the JSON files `readEntryFile` reads.
let fileDir: string;
beforeEach(() => {
  fileDir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-entries-'));
});
afterEach(() => {
  rmSync(fileDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

/** A fully-valid single entry, so each test only overrides the field it probes. */
function entry(record: Record<string, unknown>, at = 'entry 0'): RawEntry {
  return { at, record };
}

/** A realistic schema matching what the real `cases bulk-create` leaf validates. */
const SCHEMA: EntrySchema = {
  wrapperKey: 'cases',
  allowed: [
    'title',
    'description',
    'precondition',
    'type',
    'type_id',
    'state',
    'state_id',
    'important_level',
    'important_level_id',
    'maintenance',
    'maintenance_id',
    'participant_ids',
    'properties',
    'steps',
  ],
  refused: {
    suite: 'use `cases update --suite` instead',
    suite_id: 'use `cases update --suite` instead',
    state: 'a bulk-created case always starts in the library default state',
    state_id: 'a bulk-created case always starts in the library default state',
  },
};

function writeEntries(content: string): string {
  const file = path.join(fileDir, `entries-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, content, 'utf8');
  return file;
}

/** Replace `process.stdin` so `readEntryFile({file:'-'})` reads `data`. */
function replaceStdin(data: string): () => void {
  const original = process.stdin;
  // Cast: only the async-iterable behaviour that `readJsonStdin` reads is needed.
  const fake = Readable.from([data]) as unknown as typeof process.stdin;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  return () => {
    Object.defineProperty(process, 'stdin', { value: original, configurable: true });
  };
}

function pathOf(call: { url: string } | undefined): string {
  return new URL(call?.url ?? 'https://x.invalid/').pathname;
}

// The bare array both `cases/bulk` halves answer with (research s7-smoke §3.6).
const caseBulkOk = () =>
  jsonResponse([
    { state: 'success', case: { id: 'case-9', identifier: 'LIB-9', title: 'imported', is_archived: 0 } },
  ]);

// ---------------------------------------------------------------------------
// BULK_ENTRY_LIMIT + checkBulkLimit
// ---------------------------------------------------------------------------

describe('the batch cap', () => {
  it('is 100 — the API’s own per-call limit', () => {
    expect(BULK_ENTRY_LIMIT).toBe(100);
  });

  it('accepts anything at or below the limit, sending nothing', () => {
    expect(() => checkBulkLimit(0, 'cases')).not.toThrow();
    expect(() => checkBulkLimit(100, 'cases')).not.toThrow();
  });

  it('refuses one over the limit, naming the count and the split hint', () => {
    const error = catchUsage(() => checkBulkLimit(101, 'cases'));
    expect(error.message).toContain('101 cases were given');
    expect(error.message).toContain('at most 100 per call');
    expect(error.hint).toContain('batches of 100 or fewer');
  });
});

// ---------------------------------------------------------------------------
// entryString — a required non-empty string field
// ---------------------------------------------------------------------------

describe('entryString', () => {
  it('returns a non-empty, trimmed string', () => {
    expect(entryString(entry({ title: 'hello' }), 'title')).toBe('hello');
    // whitespace-only is NOT empty after trim — the value is kept verbatim
    expect(entryString(entry({ title: '  hi  ' }), 'title')).toBe('  hi  ');
  });

  it('refuses an empty or whitespace-only string', () => {
    for (const value of ['', '   ', '\t']) {
      const error = catchUsage(() => entryString(entry({ title: value }), 'title'));
      expect(error.message, `for ${JSON.stringify(value)}`).toContain('entry 0.title must be a non-empty string');
    }
  });

  it('refuses a missing or non-string field', () => {
    expect(catchUsage(() => entryString(entry({}), 'title')).message).toContain('non-empty string');
    expect(catchUsage(() => entryString(entry({ title: 42 }), 'title')).message).toContain(
      'non-empty string',
    );
    expect(catchUsage(() => entryString(entry({ title: null }), 'title')).message).toContain(
      'non-empty string',
    );
  });
});

// ---------------------------------------------------------------------------
// optionalEntryString — an optional string field
// ---------------------------------------------------------------------------

describe('optionalEntryString', () => {
  it('returns undefined when the key is absent', () => {
    expect(optionalEntryString(entry({}), 'remark')).toBeUndefined();
  });

  it('returns the string when present', () => {
    expect(optionalEntryString(entry({ remark: 'ok' }), 'remark')).toBe('ok');
  });

  it('refuses a non-string value, but never an absent one', () => {
    const error = catchUsage(() => optionalEntryString(entry({ remark: 7 }), 'remark'));
    expect(error.message).toContain('entry 0.remark must be a string');
  });
});

// ---------------------------------------------------------------------------
// entryPair — the --x / --x-id pair inside one entry
// ---------------------------------------------------------------------------

describe('entryPair', () => {
  it('returns undefined when neither half is present', () => {
    expect(entryPair(entry({}), 'state')).toBeUndefined();
  });

  it('returns {byName} for a bare field and {byId} for its _id sibling', () => {
    expect(entryPair(entry({ state: '草稿' }), 'state')).toEqual({ byName: '草稿' });
    expect(entryPair(entry({ state_id: 'cs-1' }), 'state')).toEqual({ byId: 'cs-1' });
  });

  it('refuses both halves together — a name to resolve and an id are mutually exclusive', () => {
    const error = catchUsage(() => entryPair(entry({ state: '草稿', state_id: 'cs-1' }), 'state'));
    expect(error.message).toContain('entry 0 sets both state and state_id');
    expect(error.hint).toContain('use state for a name to resolve');
  });
});

// ---------------------------------------------------------------------------
// entryProperties — an optional custom properties map
// ---------------------------------------------------------------------------

describe('entryProperties', () => {
  it('returns undefined when absent', () => {
    expect(entryProperties(entry({}))).toBeUndefined();
  });

  it('passes an object map through untouched', () => {
    expect(entryProperties(entry({ properties: { risk: 'high' } }))).toEqual({ risk: 'high' });
  });

  it('refuses anything that is not a plain object', () => {
    for (const value of ['x', 42, null, []]) {
      const error = catchUsage(() => entryProperties(entry({ properties: value })));
      expect(error.message, `for ${JSON.stringify(value)}`).toContain(
        'entry 0.properties must be an object of key/value pairs',
      );
      expect(error.hint).toContain('testhub meta case-properties');
    }
  });
});

// ---------------------------------------------------------------------------
// entrySteps — an optional steps array
// ---------------------------------------------------------------------------

describe('entrySteps', () => {
  it('returns undefined when absent', () => {
    expect(entrySteps(entry({}))).toBeUndefined();
  });

  it('passes an array of step objects through untouched', () => {
    const steps = [{ description: 'click', expected_value: 'ok' }];
    expect(entrySteps(entry({ steps }))).toEqual(steps);
  });

  it('refuses a non-array', () => {
    const error = catchUsage(() => entrySteps(entry({ steps: 'x' })));
    expect(error.message).toContain('entry 0.steps must be an array of step objects');
  });

  it('refuses an array that contains a non-object step', () => {
    expect(catchUsage(() => entrySteps(entry({ steps: ['x'] }))).message).toContain(
      'array of step objects',
    );
    expect(catchUsage(() => entrySteps(entry({ steps: [null] }))).message).toContain(
      'array of step objects',
    );
    expect(catchUsage(() => entrySteps(entry({ steps: [42] }))).message).toContain(
      'array of step objects',
    );
  });
});

// ---------------------------------------------------------------------------
// readEntryFile — the reading + validation pipeline
// ---------------------------------------------------------------------------

describe('readEntryFile', () => {
  it('refuses when --file is absent or blank, naming the flag', async () => {
    for (const source of [{}, { file: undefined }, { file: '' }, { file: '   ' }]) {
      const error = await readEntryFile(source, SCHEMA, 'the hint').catch((e) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain('--file <path|-> is required');
    }
  });

  it('refuses a path that cannot be read, naming it', async () => {
    const error = await readEntryFile(
      { file: path.join(fileDir, 'does-not-exist.json') },
      SCHEMA,
      'h',
    ).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('could not be read');
  });

  it('refuses an empty file', async () => {
    const error = await readEntryFile({ file: writeEntries('') }, SCHEMA, 'h').catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('is empty');
  });

  it('refuses a file that is not valid JSON, carrying the cause', async () => {
    const error = await readEntryFile({ file: writeEntries('{bad') }, SCHEMA, 'h').catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('is not valid JSON');
  });

  it('refuses a scalar document that is neither an array nor the wrapper', async () => {
    for (const body of ['42', '"hi"', 'true']) {
      const error = await readEntryFile({ file: writeEntries(body) }, SCHEMA, 'h').catch((e) => e);
      expect(error, body).toBeInstanceOf(UsageError);
      expect(error.message, body).toContain('must contain a JSON array');
    }
  });

  it('refuses a wrapped object whose key is not the wrapper key', async () => {
    const error = await readEntryFile(
      { file: writeEntries(JSON.stringify({ items: [{ title: 'a' }] })) },
      SCHEMA,
      'h',
    ).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('must contain a JSON array');
  });

  it('accepts a bare array and tags each entry with its index', async () => {
    const result = await readEntryFile(
      { file: writeEntries(JSON.stringify([{ title: 'a' }, { title: 'b' }])) },
      SCHEMA,
      'h',
    );
    expect(result).toEqual([
      { at: 'entry 0', record: { title: 'a' } },
      { at: 'entry 1', record: { title: 'b' } },
    ]);
  });

  it('unwraps a {"<wrapperKey>": [...]} object the docs emit', async () => {
    const result = await readEntryFile(
      { file: writeEntries(JSON.stringify({ cases: [{ title: 'a' }] })) },
      SCHEMA,
      'h',
    );
    expect(result).toEqual([{ at: 'entry 0', record: { title: 'a' } }]);
  });

  it('passes properties and steps through untyped, since their keys are validated upstream', async () => {
    const result = await readEntryFile(
      {
        file: writeEntries(
          JSON.stringify([
            { title: 'a', properties: { risk: 'high' }, steps: [{ description: 'click' }] },
          ]),
        ),
      },
      SCHEMA,
      'h',
    );
    expect(result[0]?.record.properties).toEqual({ risk: 'high' });
    expect(result[0]?.record.steps).toEqual([{ description: 'click' }]);
  });

  it('refuses an empty array before any request is sent', async () => {
    const error = await readEntryFile({ file: writeEntries('[]') }, SCHEMA, 'h').catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('contained no entries');
    expect(error.hint).toContain('non-empty JSON array');
  });

  it('refuses an entry that is not a JSON object', async () => {
    for (const value of ['42', '"hi"', 'null', 'true', '[]']) {
      const error = await readEntryFile(
        { file: writeEntries(`[${value}]`) },
        SCHEMA,
        'h',
      ).catch((e) => e);
      expect(error, `for [${value}]`).toBeInstanceOf(UsageError);
      expect(error.message, `for [${value}]`).toContain('entry 0 is not a JSON object');
    }
  });

  it('refuses a refused key, naming the command that can do it', async () => {
    const error = await readEntryFile(
      { file: writeEntries(JSON.stringify([{ title: 'a', suite: '登录' }])) },
      SCHEMA,
      'h',
    ).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('entry 0 sets suite:');
    expect(error.message).toContain('use `cases update --suite` instead');
  });

  it('refuses an unknown field and lists the accepted keys', async () => {
    const error = await readEntryFile(
      { file: writeEntries(JSON.stringify([{ title: 'a', bogus: 1 }])) },
      SCHEMA,
      'h',
    ).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('entry 0 has unknown field(s): bogus');
    expect(error.hint).toContain('accepted keys:');
  });

  it('treats a schema with no refused keys as refusing nothing', async () => {
    const noRefused: EntrySchema = { wrapperKey: 'items', allowed: ['title'] };
    const result = await readEntryFile(
      { file: writeEntries(JSON.stringify([{ title: 'a' }])) },
      noRefused,
      'h',
    );
    expect(result).toEqual([{ at: 'entry 0', record: { title: 'a' } }]);
  });

  it('reads from stdin when --file is -', async () => {
    const restore = replaceStdin(JSON.stringify([{ title: 'from stdin' }]));
    try {
      const result = await readEntryFile({ file: '-' }, SCHEMA, 'h');
      expect(result).toEqual([{ at: 'entry 0', record: { title: 'from stdin' } }]);
    } finally {
      restore();
    }
  });

  it('unwraps a stdin document under the wrapper key too', async () => {
    const restore = replaceStdin(JSON.stringify({ cases: [{ title: 'wrapped' }] }));
    try {
      const result = await readEntryFile({ file: '-' }, SCHEMA, 'h');
      expect(result).toEqual([{ at: 'entry 0', record: { title: 'wrapped' } }]);
    } finally {
      restore();
    }
  });

  it('refuses empty stdin with a source-naming message', async () => {
    const restore = replaceStdin('   ');
    try {
      const error = await readEntryFile({ file: '-' }, SCHEMA, 'h').catch((e) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain('the body read from stdin is empty');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// end to end through the real command tree (createCliHarness)
// ---------------------------------------------------------------------------

describe('testhub cases bulk-create --file', () => {
  it('posts one cases array and renders the per-entry state on stdout', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.writes).toHaveLength(1);
    expect(pathOf(run.writes[0])).toBe('/v1/testhub/cases/bulk');
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.body).toEqual({ cases: [{ test_library_id: 'lib-1', title: 'hello' }] });
    const out = JSON.parse(run.stdout) as { count: number; values: Array<{ state: string }> };
    expect(out.count).toBe(1);
    expect(out.values[0]?.state).toBe('success');
  });

  it('prints the result table on stdout and the count on stderr in human mode', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('STATE');
    expect(run.stderr).toContain('created 1 case(s)');
  });

  it('--dry-run prints the plan on stdout and sends zero requests', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-create',
        '--library-id',
        'lib-1',
        '--file',
        file,
        '--dry-run',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as {
      dry_run: boolean;
      request: { method: string; url: string; body: unknown };
    };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.method).toBe('POST');
    expect(plan.request.url).toContain('/v1/testhub/cases/bulk');
    expect(plan.request.body).toEqual({ cases: [{ test_library_id: 'lib-1', title: 'hello' }] });
  });

  it('is exit 2 with no request when --file is missing', async () => {
    const run = await h.run(['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--file');
  });

  it('is exit 2 with no request when no --library was given', async () => {
    const file = writeEntries(JSON.stringify([{ title: 'hello' }]));
    const run = await h.run(['testhub', 'cases', 'bulk-create', '--file', file, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--library');
  });

  it('caps the batch at 100 before any request', async () => {
    const file = writeEntries(
      JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ title: `t${index}` }))),
    );
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    const payload = JSON.parse(run.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain('101');
    expect(payload.error.message).toContain('100');
  });

  it('refuses suite_id at the entry layer, before any request', async () => {
    const file = writeEntries(JSON.stringify([{ title: 't', suite_id: 'su-1' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('suite_id');
  });

  it('refuses an unknown entry key rather than letting the server drop it', async () => {
    const file = writeEntries(JSON.stringify([{ title: 't', titel: 'typo' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-create', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('titel');
  });
});

describe('testhub cases bulk-update --file', () => {
  it('patches each named case and keeps stdout JSON-only', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', title: 'new' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [caseBulkOk],
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.writes).toHaveLength(1);
    expect(pathOf(run.writes[0])).toBe('/v1/testhub/cases/bulk');
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.body).toEqual({ cases: [{ case_id: 'case-1', title: 'new' }] });
  });

  it('refuses suite here too — the API accepts it and lands nothing', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', suite: '登录' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('suite');
  });

  it('refuses an entry that names a case but no field to change', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1' }]));
    const run = await h.run(
      ['testhub', 'cases', 'bulk-update', '--library-id', 'lib-1', '--file', file, '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('no field to change');
  });

  it('--dry-run resolves nothing extra and writes nothing for an id-only entry', async () => {
    const file = writeEntries(JSON.stringify([{ case_id: 'case-1', title: 'new' }]));
    const run = await h.run(
      [
        'testhub',
        'cases',
        'bulk-update',
        '--library-id',
        'lib-1',
        '--file',
        file,
        '--dry-run',
        '--json',
      ],
      [],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ cases: [{ case_id: 'case-1', title: 'new' }] });
  });
});

describe('testhub runs bulk-update --file', () => {
  const runBulkOk = () =>
    jsonResponse([{ state: 'success', run: { id: 'run-9', short_id: 'r9', is_archived: 0 } }]);

  it('records one result per entry with no plan or library in the URL', async () => {
    const file = writeEntries(JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass' }]));
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--file', file, '--json'], [runBulkOk]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.writes).toHaveLength(1);
    expect(pathOf(run.writes[0])).toBe('/v1/testhub/runs/bulk');
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.body).toEqual({ runs: [{ run_id: 'run-1', status_id: 'rs-pass' }] });
  });

  it('applies an entry-level remark, since --file carries its own fields', async () => {
    const file = writeEntries(
      JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass', remark: 'per-entry' }]),
    );
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--file', file, '--json'], [runBulkOk]);
    expect(run.exit).toBe(0);
    expect(run.writes[0]?.body).toEqual({
      runs: [{ run_id: 'run-1', status_id: 'rs-pass', remark: 'per-entry' }],
    });
  });

  it('refuses --remark alongside --file, because each entry carries its own', async () => {
    const file = writeEntries(JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass' }]));
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--file', file, '--remark', 'batch', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--file carries its own status and remark');
  });

  it('refuses --status alongside --file for the same reason', async () => {
    const file = writeEntries(JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass' }]));
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--file', file, '--status', '通过', '--json'],
      [],
    );
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('--file carries its own status and remark');
  });

  it('--dry-run with id-only entries sends nothing and still prints the plan', async () => {
    const file = writeEntries(JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass' }]));
    const run = await h.run(
      ['testhub', 'runs', 'bulk-update', '--file', file, '--dry-run', '--json'],
      [],
    );
    expect(run.exit).toBe(0);
    expect(run.calls).toHaveLength(0);
    expect(run.writes).toHaveLength(0);
    const plan = JSON.parse(run.stdout) as { dry_run: boolean; request: { body: unknown } };
    expect(plan.dry_run).toBe(true);
    expect(plan.request.body).toEqual({ runs: [{ run_id: 'run-1', status_id: 'rs-pass' }] });
  });

  it('refuses steps — a step array replaces wholesale and is rejected here', async () => {
    const file = writeEntries(
      JSON.stringify([{ run_id: 'run-1', status_id: 'rs-pass', steps: [{ description: 'x' }] }]),
    );
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--file', file, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('steps');
  });

  it('refuses an entry that sets both run and run_id', async () => {
    const file = writeEntries(
      JSON.stringify([{ run: 'r1', run_id: 'run-1', status_id: 'rs-pass' }]),
    );
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--file', file, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('both run and run_id');
  });

  it('refuses an entry that names no run', async () => {
    const file = writeEntries(JSON.stringify([{ status_id: 'rs-pass' }]));
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--file', file, '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('names no run');
  });

  it('is exit 2 when --file is given with no entries and no --run/--run-id', async () => {
    const run = await h.run(['testhub', 'runs', 'bulk-update', '--json'], []);
    expect(run.exit).toBe(2);
    expect(run.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function catchUsage(fn: () => unknown): UsageError {
  try {
    fn();
  } catch (error) {
    expect(error, 'expected a UsageError to be thrown').toBeInstanceOf(UsageError);
    return error as UsageError;
  }
  throw new Error('expected a UsageError to be thrown');
}
