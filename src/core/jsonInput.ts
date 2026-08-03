import { readFile } from 'node:fs/promises';
import { UsageError } from './errors';

/**
 * Reading a JSON document the caller pointed at — a file path or stdin.
 *
 * **Why this lives in `core/` rather than in the command that needs it.** The
 * layering rule (design §2, asserted by `test/layering.test.ts`) is that `cli/`
 * never touches the filesystem: file IO belongs to `core`, which is where
 * `core/config.ts` reads the config file and `core/metadata.ts` reads the cache.
 * `pingcode api … --body-file page.json` is the first flag whose *value is a path*,
 * so the same rule sends it here instead of putting a `node:fs` import in a command.
 *
 * The module is deliberately tiny and knows nothing about endpoints: it turns a
 * path or stdin into parsed JSON, and turns every way that can fail into a
 * `UsageError` (exit 2) naming the source. It does **not** validate the shape —
 * the generic executor sends bodies through untouched, and guessing what a body
 * should look like is exactly the kind of semantics that layer must not have.
 */

/** Parse JSON, blaming `source` (a flag name or a path) rather than the parser. */
export function parseJsonDocument(text: string, source: string): unknown {
  if (text.trim() === '') {
    throw new UsageError(`${source} is empty`, { hint: 'a request body must be a JSON document' });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Read and parse a JSON file. A missing/unreadable file is a usage error, not a crash. */
export async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new UsageError(
      `--body-file ${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseJsonDocument(text, `--body-file ${filePath}`);
}

/**
 * Read all of stdin and parse it as JSON — what `--body -` means.
 *
 * Streaming rather than `readFileSync(0)`: a pipe is not seekable, and this is also
 * how `cli/commands/auth.ts` already consumes stdin for a secret.
 */
export async function readJsonStdin(
  stream: AsyncIterable<string | Uint8Array> = process.stdin,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return parseJsonDocument(Buffer.concat(chunks).toString('utf8'), 'the body read from stdin');
}
