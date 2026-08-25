import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readBulkEntries,
  readSharedRefs,
  resolveBulkEntry,
  type RawBulkEntry,
} from '../src/cli/commands/_shared/bulkEntries';
import type { Ctx } from '../src/core/context';
import { UsageError } from '../src/core/errors';
import type { ResolveResult } from '../src/core/metadata/resolve';
import { createTestContext } from './helpers/fake';

/**
 * A plain-text document under a flag is unusual, but `readTextFile` in the stdin path
 * does the real I/O; these temp files keep the suite offline and hermetic.
 */
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop();
    if (dispose !== undefined) await dispose();
  }
});

async function withTempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pingcode-bulk-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'entries.json');
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

/** A fully-valid single entry, so each test only overrides what it cares about. */
function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Sprint A', start: '2026-08-01', end: '2026-08-31', ...overrides };
}

const WRAPPER = 'sprints';
const EXTRA_KEYS: readonly string[] = [];

function rr(id: string, input: string, kind: 'project' | 'user' = 'project'): ResolveResult {
  return { kind, input, id, name: input, fromCache: false, cacheKey: null };
}

// ---------------------------------------------------------------------------
// readBulkEntries — the reading + validation pipeline
// ---------------------------------------------------------------------------

describe('readBulkEntries', () => {
  it('rejects an empty --file before touching the disk', async () => {
    const error = await readBulkEntries({ file: '   ' }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('--file <path|-> is required');
  });

  it('rejects a missing --file key', async () => {
    const error = await readBulkEntries({ file: undefined }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('is required');
  });

  it('reads a bare JSON array from a file', async () => {
    const file = await withTempFile(JSON.stringify([validEntry()]));
    const result = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Sprint A');
  });

  it('reads a wrapped {"sprints":[…]} document from a file', async () => {
    const file = await withTempFile(JSON.stringify({ sprints: [validEntry()] }));
    const result = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS });
    expect(result).toHaveLength(1);
  });

  it('reads "-" as stdin', async () => {
    const data = JSON.stringify([validEntry()]);
    const restore = replaceStdin(data);
    try {
      const result = await readBulkEntries({ file: '-' }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS });
      expect(result).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('rejects an empty array with a flag-naming hint', async () => {
    const file = await withTempFile('[]');
    const error = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS }).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('contained no entries');
  });

  it('rejects an empty wrapped array', async () => {
    const file = await withTempFile(JSON.stringify({ sprints: [] }));
    const error = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS }).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('contained no entries');
  });

  it('rejects a document that is neither an array nor the wrapper', async () => {
    const file = await withTempFile(JSON.stringify({ not_sprints: [validEntry()] }));
    const error = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS }).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('must contain a JSON array');
  });

  it('rejects a scalar document', async () => {
    const file = await withTempFile('42');
    const error = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS }).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('must contain a JSON array');
  });

  it('rejects invalid JSON from a file', async () => {
    const file = await withTempFile('{bad json');
    const error = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS }).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('is not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// readEntry — key validation, field parsing, the project/assignee pair
// ---------------------------------------------------------------------------

describe('readEntry (via readBulkEntries)', () => {
  const opts = () => ({ wrapperKey: WRAPPER, extraKeys: EXTRA_KEYS });

  it('rejects an entry that is not an object', async () => {
    const file = await withTempFile(JSON.stringify(['a string']));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('entry 0 is not a JSON object');
  });

  it('rejects a null entry', async () => {
    const file = await withTempFile(JSON.stringify([null]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('is not a JSON object');
  });

  it('rejects an entry that is an array', async () => {
    const file = await withTempFile(JSON.stringify([[]]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('is not a JSON object');
  });

  it('rejects unknown keys, listing the accepted set', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ typo_field: 1 })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('unknown field(s): typo_field');
    expect(error.hint).toContain('accepted keys:');
  });

  it('reports the entry index in error messages', async () => {
    const file = await withTempFile(JSON.stringify([validEntry(), validEntry({ typo: true })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('entry 1');
  });

  it('requires a non-empty name', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ name: '   ' })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('entry 0.name must be a non-empty string');
  });

  it('requires name to be a string', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ name: 42 })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('must be a non-empty string');
  });

  it('accepts start/end as a calendar date and computes the boundary seconds', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ start: '2026-08-01', end: '2026-08-31' })]));
    const [entry] = await readBulkEntries({ file }, opts());
    const start = new Date(2026, 7, 1, 0, 0, 0, 0).getTime() / 1000;
    const end = new Date(2026, 7, 31, 23, 59, 59, 0).getTime() / 1000;
    expect(entry?.start).toBe(Math.floor(start));
    expect(entry?.end).toBe(Math.floor(end));
  });

  it('accepts start/end as a 10-digit unix-seconds number', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ start: 1790784000, end: 1793376000 })]));
    const [entry] = await readBulkEntries({ file }, opts());
    expect(entry?.start).toBe(1790784000);
    expect(entry?.end).toBe(1793376000);
  });

  it('rejects a start that is neither a date nor a finite number', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ start: {} })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('entry 0.start must be a date');
  });

  it('rejects an infinite-number start', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ start: Infinity })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('entry 0.start must be a date');
  });

  it('rejects a non-calendar end value', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ end: 'not-a-date' })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('entry 0.end');
  });

  it('rejects an impossible calendar date', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ start: '2026-02-30' })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('is not a real date');
  });

  it('reads project_id verbatim into projectId', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ project_id: 'abc123' })]));
    const [entry] = await readBulkEntries({ file }, opts());
    expect(entry?.projectId).toBe('abc123');
    expect(entry?.project).toBeUndefined();
  });

  it('reads a project name into project', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ project: 'Acme' })]));
    const [entry] = await readBulkEntries({ file }, opts());
    expect(entry?.project).toBe('Acme');
    expect(entry?.projectId).toBeUndefined();
  });

  it('reads assignee_id verbatim into assigneeId', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ assignee_id: 'u42' })]));
    const [entry] = await readBulkEntries({ file }, opts());
    expect(entry?.assigneeId).toBe('u42');
  });

  it('reads an assignee name into assignee', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ assignee: 'Bob' })]));
    const [entry] = await readBulkEntries({ file }, opts());
    expect(entry?.assignee).toBe('Bob');
  });

  it('rejects setting both project and project_id', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ project: 'Acme', project_id: 'abc' })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('sets both project and project_id');
  });

  it('rejects setting both assignee and assignee_id', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ assignee: 'Bob', assignee_id: 'u' })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('sets both assignee and assignee_id');
  });

  it('requires project_id to be a non-empty string', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ project_id: '  ' })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('entry 0.project_id must be a non-empty string');
  });

  it('requires assignee_id to be a non-empty string', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ assignee_id: 9 })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('entry 0.assignee_id must be a non-empty string');
  });

  it('reads categories into categoryIds', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ categories: ['c1', 'c2'] })]));
    const [entry] = await readBulkEntries({ file }, opts());
    expect(entry?.categoryIds).toEqual(['c1', 'c2']);
  });

  it('falls back to category_ids when categories is absent', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ category_ids: ['c1'] })]));
    const [entry] = await readBulkEntries({ file }, opts());
    expect(entry?.categoryIds).toEqual(['c1']);
  });

  it('requires categories to be an array of strings', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ categories: 'c1' })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('entry 0.categories must be an array of id strings');
  });

  it('requires categories entries to be strings', async () => {
    const file = await withTempFile(JSON.stringify([validEntry({ categories: ['c1', 2] })]));
    const error = await readBulkEntries({ file }, opts()).catch((e) => e);
    expect(error.message).toContain('must be an array of id strings');
  });

  it('omits categoryIds when neither categories nor category_ids is present', async () => {
    const file = await withTempFile(JSON.stringify([validEntry()]));
    const [entry] = await readBulkEntries({ file }, opts());
    expect(entry?.categoryIds).toBeUndefined();
  });

  it('passes declared extra keys through verbatim into extra', async () => {
    const extra = ['goal'] as const;
    const file = await withTempFile(
      JSON.stringify([validEntry({ goal: 'ship it' })]),
    );
    const [entry] = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: extra });
    expect(entry?.extra).toEqual({ goal: 'ship it' });
  });

  it('omits undefined extra keys from extra', async () => {
    const extra = ['goal'] as const;
    const file = await withTempFile(JSON.stringify([validEntry()]));
    const [entry] = await readBulkEntries({ file }, { wrapperKey: WRAPPER, extraKeys: extra });
    expect(entry?.extra).toEqual({});
  });

  it('maps multiple entries preserving order', async () => {
    const file = await withTempFile(
      JSON.stringify([validEntry({ name: 'A' }), validEntry({ name: 'B' })]),
    );
    const result = await readBulkEntries({ file }, opts());
    expect(result.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('surfaces an unreadable file path as a usage error', async () => {
    const missing = join(tmpdir(), `pingcode-bulk-missing-${process.pid}.json`);
    const error = await readBulkEntries({ file: missing }, opts()).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('could not be read');
  });
});

// ---------------------------------------------------------------------------
// resolveBulkEntry — per-entry project/assignee resolution
// ---------------------------------------------------------------------------

describe('resolveBulkEntry', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = createTestContext();
  });

  function entry(overrides: Partial<RawBulkEntry> = {}): RawBulkEntry {
    return {
      name: 'S',
      start: 1,
      end: 2,
      extra: {},
      ...overrides,
    };
  }

  const resolvers = () => ({
    resolveProject: async (_c: Ctx, input: string) => rr('proj-' + input, input, 'project'),
    resolveAssignee: async (_c: Ctx, input: string) => rr('user-' + input, input, 'user'),
  });

  it('uses verbatim ids when the entry supplies both project_id and assignee_id', async () => {
    const result = await resolveBulkEntry(ctx, entry({ projectId: 'p1', assigneeId: 'a1' }), {
      project: undefined,
      assignee: undefined,
      ...resolvers(),
      at: 'entry 0',
    });
    expect(result.projectId).toBe('p1');
    expect(result.assigneeId).toBe('a1');
    expect(result.resolutions).toEqual([]);
  });

  it('resolves a project name through the injected resolver', async () => {
    const result = await resolveBulkEntry(ctx, entry({ project: 'Acme', assigneeId: 'a1' }), {
      project: undefined,
      assignee: undefined,
      ...resolvers(),
      at: 'entry 0',
    });
    expect(result.projectId).toBe('proj-Acme');
    expect(result.resolutions.map((r) => r.id)).toEqual(['proj-Acme']);
  });

  it('resolves an assignee name through the injected resolver', async () => {
    const result = await resolveBulkEntry(ctx, entry({ projectId: 'p1', assignee: 'Bob' }), {
      project: undefined,
      assignee: undefined,
      ...resolvers(),
      at: 'entry 0',
    });
    expect(result.assigneeId).toBe('user-Bob');
    expect(result.resolutions.map((r) => r.id)).toEqual(['user-Bob']);
  });

  it('resolves both a project and an assignee name', async () => {
    const result = await resolveBulkEntry(ctx, entry({ project: 'Acme', assignee: 'Bob' }), {
      project: undefined,
      assignee: undefined,
      ...resolvers(),
      at: 'entry 0',
    });
    expect(result.projectId).toBe('proj-Acme');
    expect(result.assigneeId).toBe('user-Bob');
    expect(result.resolutions.map((r) => r.id)).toEqual(['proj-Acme', 'user-Bob']);
  });

  it('falls back to the shared project when the entry names none', async () => {
    const result = await resolveBulkEntry(ctx, entry({ assigneeId: 'a1' }), {
      project: rr('shared-p', 'Shared', 'project'),
      assignee: undefined,
      ...resolvers(),
      at: 'entry 0',
    });
    expect(result.projectId).toBe('shared-p');
    // the shared resolution is reused, not re-collected.
    expect(result.resolutions.map((r) => r.id)).toEqual([]);
  });

  it('falls back to the shared assignee when the entry names none', async () => {
    const result = await resolveBulkEntry(ctx, entry({ projectId: 'p1' }), {
      project: undefined,
      assignee: rr('shared-a', 'Shared', 'user'),
      ...resolvers(),
      at: 'entry 0',
    });
    expect(result.assigneeId).toBe('shared-a');
    expect(result.resolutions.map((r) => r.id)).toEqual([]);
  });

  it('prefers the entry project over the shared one', async () => {
    const calls: string[] = [];
    const result = await resolveBulkEntry(ctx, entry({ project: 'PerEntry', assigneeId: 'a1' }), {
      project: rr('shared-p', 'Shared', 'project'),
      assignee: undefined,
      resolveProject: async (_c, input) => {
        calls.push(input);
        return rr('proj-' + input, input, 'project');
      },
      resolveAssignee: async (_c, input) => rr('user-' + input, input, 'user'),
      at: 'entry 0',
    });
    expect(result.projectId).toBe('proj-PerEntry');
    expect(calls).toEqual(['PerEntry']);
  });

  it('throws a naming hint when no project is available anywhere', async () => {
    const error = await resolveBulkEntry(ctx, entry({ assigneeId: 'a1' }), {
      project: undefined,
      assignee: undefined,
      ...resolvers(),
      at: 'entry 0',
    }).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('names no project');
    expect(error.hint).toContain('--project');
  });

  it('throws a naming hint when no assignee is available anywhere', async () => {
    const error = await resolveBulkEntry(ctx, entry({ projectId: 'p1' }), {
      project: undefined,
      assignee: undefined,
      ...resolvers(),
      at: 'entry 0',
    }).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('names no assignee');
    expect(error.hint).toContain('assignee_id');
  });
});

// ---------------------------------------------------------------------------
// readSharedRefs — the leaf's --project / --assignee, resolved once
// ---------------------------------------------------------------------------

describe('readSharedRefs', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('returns undefined for both when neither flag is given', async () => {
    const resolutions: ResolveResult[] = [];
    const result = await readSharedRefs(
      ctx,
      { project: undefined, assignee: undefined },
      resolutions,
      {
        project: async () => rr('p', 'P', 'project'),
        assignee: async () => rr('a', 'A', 'user'),
      },
    );
    expect(result.project).toBeUndefined();
    expect(result.assignee).toBeUndefined();
    expect(resolutions).toEqual([]);
  });

  it('resolves a --project and pushes it onto the resolutions list', async () => {
    const resolutions: ResolveResult[] = [];
    const result = await readSharedRefs(
      ctx,
      { project: 'Acme', assignee: undefined },
      resolutions,
      {
        project: async (_c, input) => rr('proj-' + input, input, 'project'),
        assignee: async (_c, input) => rr('user-' + input, input, 'user'),
      },
    );
    expect(result.project?.id).toBe('proj-Acme');
    expect(result.assignee).toBeUndefined();
    expect(resolutions.map((r) => r.id)).toEqual(['proj-Acme']);
  });

  it('resolves a --assignee and pushes it onto the resolutions list', async () => {
    const resolutions: ResolveResult[] = [];
    const result = await readSharedRefs(
      ctx,
      { project: undefined, assignee: 'Bob' },
      resolutions,
      {
        project: async (_c, input) => rr('proj-' + input, input, 'project'),
        assignee: async (_c, input) => rr('user-' + input, input, 'user'),
      },
    );
    expect(result.assignee?.id).toBe('user-Bob');
    expect(result.project).toBeUndefined();
    expect(resolutions.map((r) => r.id)).toEqual(['user-Bob']);
  });

  it('resolves both flags in order', async () => {
    const resolutions: ResolveResult[] = [];
    const result = await readSharedRefs(
      ctx,
      { project: 'Acme', assignee: 'Bob' },
      resolutions,
      {
        project: async (_c, input) => rr('proj-' + input, input, 'project'),
        assignee: async (_c, input) => rr('user-' + input, input, 'user'),
      },
    );
    expect(result.project?.id).toBe('proj-Acme');
    expect(result.assignee?.id).toBe('user-Bob');
    expect(resolutions.map((r) => r.id)).toEqual(['proj-Acme', 'user-Bob']);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Temporarily replace process.stdin so `readBulkEntries({file:'-'})` reads `data`. */
function replaceStdin(data: string): () => void {
  const original = process.stdin;
  // Cast: we only need the async-iterable behaviour that readJsonStdin uses.
  const fake = Readable.from([data]) as unknown as typeof process.stdin;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  return () => {
    Object.defineProperty(process, 'stdin', { value: original, configurable: true });
  };
}
