import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseJsonDocument,
  readJsonFile,
  readJsonStdin,
  readTextFile,
} from '../src/core/jsonInput';
import { UsageError } from '../src/core/errors';

/** An error that leaves a PINGCODE_CONFIG_DIR-scoped temp file behind. */
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  // LIFO, so nested mkdtemp dirs come down cleanly.
  while (cleanup.length > 0) {
    const dispose = cleanup.pop();
    if (dispose !== undefined) {
      await dispose();
    }
  }
});

/**
 * Write a JSON-ish document into a fresh mkdtemp dir and return the path.
 * The dir is disposed in afterEach.
 */
async function withTempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pingcode-jsoninput-'));
  cleanup.push(async () => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'body.txt');
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

describe('parseJsonDocument', () => {
  it('parses every JSON scalar and composite value', () => {
    expect(parseJsonDocument('{"a":1}', 'body')).toEqual({ a: 1 });
    expect(parseJsonDocument('[1, 2, 3]', 'body')).toEqual([1, 2, 3]);
    expect(parseJsonDocument('42', 'body')).toBe(42);
    expect(parseJsonDocument('"hi"', 'body')).toBe('hi');
    expect(parseJsonDocument('true', 'body')).toBe(true);
    expect(parseJsonDocument('false', 'body')).toBe(false);
    expect(parseJsonDocument('null', 'body')).toBe(null);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseJsonDocument('  \n\t{"a":1}\n  ', 'body')).toEqual({ a: 1 });
  });

  it('rejects an empty document with a usage error naming the source', () => {
    const error = catchUsage(() => parseJsonDocument('', '--body-file page.json'));
    expect(error.message).toBe('--body-file page.json is empty');
    expect(error.hint).toBe('a request body must be a JSON document');
    expect(error.kind).toBe('usage');
    expect(error.exitCode).toBe(2);
  });

  it('rejects whitespace-only text as empty', () => {
    const error = catchUsage(() => parseJsonDocument('   \n\t  ', 'stdin'));
    expect(error.message).toBe('stdin is empty');
  });

  it('rejects invalid JSON with a message naming the source and carrying the cause', () => {
    let thrown: unknown;
    try {
      parseJsonDocument('{not json', '--body-file body.json');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    const error = thrown as UsageError;
    expect(error.message).toContain('--body-file body.json is not valid JSON');
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.kind).toBe('usage');
  });

  it('uses the source verbatim, so the flag the user typed is in the message', () => {
    const error = catchUsage(() => parseJsonDocument('', '--content-file snippet.txt'));
    expect(error.message).toContain('--content-file snippet.txt is empty');
  });
});

describe('readTextFile', () => {
  it('returns the file contents verbatim (no JSON interpretation)', async () => {
    const filePath = await withTempFile('this is NOT json');
    expect(await readTextFile(filePath)).toBe('this is NOT json');
  });

  it('names the flag that pointed at the file when the read fails', async () => {
    const missing = join(tmpdir(), `pingcode-jsoninput-missing-${process.pid}.txt`);
    const error = await catchUsageAsync(() => readTextFile(missing, '--content-file'));
    expect(error.message).toContain('--content-file');
    expect(error.message).toContain('could not be read');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('defaults the flag name to --body-file', async () => {
    const missing = join(tmpdir(), `pingcode-jsoninput-missing-${process.pid}.txt`);
    const error = await catchUsageAsync(() => readTextFile(missing));
    expect(error.message).toContain('--body-file');
    expect(error.message).toContain('could not be read');
  });
});

describe('readJsonFile', () => {
  it('reads and parses a JSON document on disk', async () => {
    const filePath = await withTempFile('{"a":1,"b":["x"]}');
    expect(await readJsonFile(filePath)).toEqual({ a: 1, b: ['x'] });
  });

  it('throws a usage error for an empty file, naming the flag and path', async () => {
    const filePath = await withTempFile('   ');
    const error = await catchUsageAsync(() => readJsonFile(filePath));
    expect(error.message).toContain(`--body-file ${filePath} is empty`);
    expect(error.hint).toBe('a request body must be a JSON document');
  });

  it('throws a usage error for an invalid JSON file, naming the flag and path', async () => {
    const filePath = await withTempFile('{bad');
    const error = await catchUsageAsync(() => readJsonFile(filePath));
    expect(error.message).toContain(`--body-file ${filePath} is not valid JSON`);
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it('surfaces an unreadable path as a usage error rather than crashing', async () => {
    const missing = join(tmpdir(), `pingcode-jsoninput-missing-${process.pid}.json`);
    const error = await catchUsageAsync(() => readJsonFile(missing));
    expect(error.message).toContain('--body-file');
    expect(error.message).toContain('could not be read');
  });
});

describe('readJsonStdin', () => {
  it('reads a single string chunk and parses it', async () => {
    const stream = Readable.from(['{"a":1}']);
    expect(await readJsonStdin(stream)).toEqual({ a: 1 });
  });

  it('reads a single Uint8Array chunk and parses it', async () => {
    const stream = Readable.from([Buffer.from('{"b":2}')]);
    expect(await readJsonStdin(stream)).toEqual({ b: 2 });
  });

  it('concatenates a mix of string and Uint8Array chunks into one document', async () => {
    const stream = Readable.from(['{"a":', Buffer.from('1}')]);
    expect(await readJsonStdin(stream)).toEqual({ a: 1 });
  });

  it('concatenates many chunks', async () => {
    const stream = Readable.from(['[', '1', ',', ' 2', ',', '3', ']']);
    expect(await readJsonStdin(stream)).toEqual([1, 2, 3]);
  });

  it('throws a usage error for empty stdin', async () => {
    const stream = Readable.from([]);
    const error = await catchUsageAsync(() => readJsonStdin(stream));
    expect(error.message).toContain('the body read from stdin is empty');
  });

  it('throws a usage error for invalid stdin, carrying the cause', async () => {
    const stream = Readable.from(['{not json']);
    const error = await catchUsageAsync(() => readJsonStdin(stream));
    expect(error.message).toContain('the body read from stdin is not valid JSON');
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });
});

/** Run a throwing function and return the UsageError it must have thrown. */
function catchUsage(fn: () => unknown): UsageError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  return thrown as UsageError;
}

/** Await a rejecting function and return the UsageError it must have thrown. */
async function catchUsageAsync(fn: () => Promise<unknown>): Promise<UsageError> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  return thrown as UsageError;
}
