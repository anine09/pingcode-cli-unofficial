/**
 * Pure-Node.js ZIP reader/extractor — zero runtime dependencies.
 *
 * Used by the self-update command to unpack GitHub release archives. Only
 * two compression methods are supported because release zips are produced by
 * our own `scripts/package-release.ts` and contain small, known files:
 *
 *  - **stored** (method 0) — data copied verbatim
 *  - **deflate** (method 8) — decompressed with `zlib.inflateRawSync`
 *
 * Directories, symlinks, and any other compression method are skipped with a
 * warning rather than treated as an error, so an unexpected entry never
 * aborts an otherwise-valid archive.
 *
 * The whole archive is read into memory; release zips are well under 5 MB so
 * this is cheap and keeps the implementation small.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// ZIP signatures
// ---------------------------------------------------------------------------

/** Local file header preceding each entry's data. */
const LOCAL_SIG = 0x04034b50; // "PK\x03\x04"
/** Central directory file header. */
const CENTRAL_SIG = 0x02014b50; // "PK\x01\x02"
/** End of central directory record. */
const EOCD_SIG = 0x06054b50; // "PK\x05\x06"

// ---------------------------------------------------------------------------
// compression methods
// ---------------------------------------------------------------------------

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// ---------------------------------------------------------------------------
// small buffer reader (little-endian, tolerant of noUncheckedIndexedAccess)
// ---------------------------------------------------------------------------

function u16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function u32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

// ---------------------------------------------------------------------------
// central directory entry
// ---------------------------------------------------------------------------

/** Metadata for a single ZIP entry, parsed from the central directory. */
interface CentralEntry {
  /** Entry path, using forward slashes. */
  name: string;
  /** Compression method (0 = stored, 8 = deflate). */
  method: number;
  /** Compressed size in bytes. */
  compressedSize: number;
  /** Uncompressed size in bytes. */
  uncompressedSize: number;
  /** Offset of the local file header from the start of the archive. */
  localOffset: number;
  /** External attributes (high 16 bits hold Unix mode when host is Unix). */
  externalAttrs: number;
  /** True when the entry is a directory (trailing slash in name). */
  isDirectory: boolean;
  /** True when the entry is a Unix symlink. */
  isSymlink: boolean;
}

// ---------------------------------------------------------------------------
// archive parsing
// ---------------------------------------------------------------------------

/**
 * Locate the End of Central Directory record by scanning backwards from EOF.
 * Returns the offset of the EOCD signature, or -1 if not found.
 */
function findEOCD(buf: Buffer): number {
  // EOCD is at least 22 bytes; the comment is at most 65535 bytes, so we only
  // need to scan the tail of the file.
  const maxBack = Math.min(buf.length, 22 + 0xffff);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (u32(buf, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Parse all central directory entries. The EOCD gives us the start of the
 * central directory and the total entry count.
 */
function parseCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocdOffset = findEOCD(buf);
  if (eocdOffset < 0) {
    throw new Error('not a valid ZIP file: End of Central Directory record not found');
  }

  const cdOffset = u32(buf, eocdOffset + 16);
  const entryCount = u16(buf, eocdOffset + 10);

  const entries: CentralEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (u32(buf, pos) !== CENTRAL_SIG) {
      throw new Error(`corrupt ZIP: central directory entry ${i} has bad signature`);
    }

    const method = u16(buf, pos + 10);
    const compressedSize = u32(buf, pos + 20);
    const uncompressedSize = u32(buf, pos + 24);
    const nameLen = u16(buf, pos + 28);
    const extraLen = u16(buf, pos + 30);
    const commentLen = u16(buf, pos + 32);
    const externalAttrs = u32(buf, pos + 38);
    const localOffset = u32(buf, pos + 42);

    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    const isDirectory = name.endsWith('/');
    const isSymlink = (externalAttrs >>> 16 & 0o170000) === 0o120000;

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      externalAttrs,
      isDirectory,
      isSymlink,
    });

    // Advance past this central directory entry (46-byte fixed + variable fields).
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Extract a single file entry's data from the archive. Reads the local file
 * header to locate the data offset, then decompresses (or copies) the bytes.
 */
function extractEntryData(buf: Buffer, entry: CentralEntry): Buffer {
  const off = entry.localOffset;
  if (u32(buf, off) !== LOCAL_SIG) {
    throw new Error(`corrupt ZIP: local header for "${entry.name}" has bad signature`);
  }

  const nameLen = u16(buf, off + 26);
  const extraLen = u16(buf, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;

  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);

  switch (entry.method) {
    case METHOD_STORED:
      return Buffer.from(compressed);
    case METHOD_DEFLATE:
      return inflateRawSync(compressed);
    default:
      throw new Error(`unsupported compression method ${entry.method} for "${entry.name}"`);
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Extract a ZIP archive into `destDir`.
 *
 * Returns the list of extracted paths **relative to `destDir`**. Directories,
 * symlinks, and entries using unsupported compression methods are skipped
 * with a warning to stderr (never abort the extraction).
 *
 * @param zipPath  Absolute or relative path to the `.zip` file.
 * @param destDir  Destination directory (created recursively if missing).
 * @returns        Relative paths of every extracted file.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  const buf = readFileSync(zipPath);
  const entries = parseCentralDirectory(buf);

  mkdirSync(destDir, { recursive: true });

  const extracted: string[] = [];

  for (const entry of entries) {
    // Skip directories.
    if (entry.isDirectory) continue;

    // Skip symlinks (we can't safely recreate them cross-platform).
    if (entry.isSymlink) {
      process.stderr.write(`warning: skipping symlink "${entry.name}" in archive\n`);
      continue;
    }

    // Skip unsupported compression methods.
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      process.stderr.write(
        `warning: skipping "${entry.name}" (unsupported compression method ${entry.method})\n`,
      );
      continue;
    }

    const data = extractEntryData(buf, entry);
    const dest = path.join(destDir, entry.name);

    // Create any intermediate directories (e.g. "dist/bin/").
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    extracted.push(entry.name);
  }

  return extracted;
}
