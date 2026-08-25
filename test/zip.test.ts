import { deflateRawSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractZip } from '../src/core/zip';

// ---------------------------------------------------------------------------
// zip builder — constructs a minimal valid ZIP in memory
// ---------------------------------------------------------------------------

/** A file entry to pack into the in-memory zip. */
interface ZipEntry {
  /** Path inside the archive (use trailing '/' for directories). */
  name: string;
  /** File data (ignored for directories). */
  data?: Buffer;
  /** Compression method: 0 = stored, 8 = deflate. Defaults to deflate. */
  method?: number;
  /** Mark as a Unix symlink (external attributes). */
  symlink?: boolean;
}

/**
 * Build a minimal but valid ZIP archive as a Buffer.
 *
 * Constructs local file headers, central directory, and EOCD record from
 * scratch — no external tools needed.
 */
function buildZip(entries: ZipEntry[]): Buffer {
  const LOCAL_SIG = 0x04034b50;
  const CENTRAL_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;

  const chunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const isDirectory = entry.name.endsWith('/');
    const method = entry.method ?? 8;
    const raw = entry.data ?? Buffer.alloc(0);
    const data = method === 8 && !isDirectory ? deflateRawSync(raw) : raw;

    // --- local file header ---
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed (2.0)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(0, 14); // crc-32 (we don't validate)
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBuf, data);

    // --- central directory entry ---
    // Unix external attributes: mode bits in high 16 bits.
    const mode = isDirectory ? 0o040755 : entry.symlink ? 0o120777 : 0o100644;
    const externalAttrs = (mode << 16) >>> 0;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by (2.0)
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(0, 16); // crc-32
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(raw.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(externalAttrs, 38);
    central.writeUInt32LE(localOffset, 42); // local header offset

    centralChunks.push(central, nameBuf);

    localOffset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(centralChunks);
  const cdSize = cdBuf.length;
  const cdOffset = localOffset;

  // --- EOCD ---
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // CD size
  eocd.writeUInt32LE(cdOffset, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pingcode-zip-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeZip(entries: ZipEntry[]): string {
  const zipPath = path.join(tmpDir, 'test.zip');
  writeFileSync(zipPath, buildZip(entries));
  return zipPath;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('extractZip', () => {
  it('extracts a single deflated file', async () => {
    const zipPath = writeZip([
      { name: 'hello.txt', data: Buffer.from('Hello, world!') },
    ]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual(['hello.txt']);
    expect(readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('Hello, world!');
  });

  it('extracts a single stored (uncompressed) file', async () => {
    const zipPath = writeZip([
      { name: 'raw.bin', data: Buffer.from([0x00, 0x01, 0x02, 0xff]), method: 0 },
    ]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual(['raw.bin']);
    expect(readFileSync(path.join(dest, 'raw.bin'))).toEqual(Buffer.from([0x00, 0x01, 0x02, 0xff]));
  });

  it('extracts multiple files', async () => {
    const zipPath = writeZip([
      { name: 'a.txt', data: Buffer.from('aaa') },
      { name: 'b.txt', data: Buffer.from('bbb') },
      { name: 'c.txt', data: Buffer.from('ccc'), method: 0 },
    ]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('aaa');
    expect(readFileSync(path.join(dest, 'b.txt'), 'utf8')).toBe('bbb');
    expect(readFileSync(path.join(dest, 'c.txt'), 'utf8')).toBe('ccc');
  });

  it('creates nested directories for file paths', async () => {
    const zipPath = writeZip([
      { name: 'dist/bin/pingcode.js', data: Buffer.from('#!/usr/bin/env node') },
      { name: 'skills/pingcode/SKILL.md', data: Buffer.from('# PingCode') },
    ]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual(['dist/bin/pingcode.js', 'skills/pingcode/SKILL.md']);
    expect(readFileSync(path.join(dest, 'dist', 'bin', 'pingcode.js'), 'utf8')).toBe(
      '#!/usr/bin/env node',
    );
    expect(readFileSync(path.join(dest, 'skills', 'pingcode', 'SKILL.md'), 'utf8')).toBe(
      '# PingCode',
    );
  });

  it('skips directory entries (trailing slash)', async () => {
    const zipPath = writeZip([
      { name: 'subdir/' },
      { name: 'subdir/file.txt', data: Buffer.from('content') },
    ]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual(['subdir/file.txt']);
  });

  it('skips symlink entries with a warning', async () => {
    const zipPath = writeZip([
      { name: 'link.txt', data: Buffer.from('/target'), symlink: true },
      { name: 'real.txt', data: Buffer.from('real content') },
    ]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual(['real.txt']);
    expect(readFileSync(path.join(dest, 'real.txt'), 'utf8')).toBe('real content');
  });

  it('skips unsupported compression methods with a warning', async () => {
    // Method 12 = BZIP2 (not supported by our extractor).
    const zipPath = writeZip([
      { name: 'compressed.bz2', data: Buffer.from('data'), method: 12 },
      { name: 'normal.txt', data: Buffer.from('normal') },
    ]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual(['normal.txt']);
  });

  it('overwrites existing files', async () => {
    const dest = path.join(tmpDir, 'out');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'file.txt'), 'old content');

    const zipPath = writeZip([
      { name: 'file.txt', data: Buffer.from('new content') },
    ]);

    await extractZip(zipPath, dest);

    expect(readFileSync(path.join(dest, 'file.txt'), 'utf8')).toBe('new content');
  });

  it('creates the destination directory if it does not exist', async () => {
    const zipPath = writeZip([
      { name: 'file.txt', data: Buffer.from('data') },
    ]);

    const dest = path.join(tmpDir, 'nested', 'output');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual(['file.txt']);
    expect(readFileSync(path.join(dest, 'file.txt'), 'utf8')).toBe('data');
  });

  it('handles an empty archive (no entries)', async () => {
    const zipPath = writeZip([]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual([]);
  });

  it('throws for invalid (non-zip) files', async () => {
    const zipPath = path.join(tmpDir, 'bad.zip');
    writeFileSync(zipPath, Buffer.from('this is not a zip file'));

    const dest = path.join(tmpDir, 'out');
    await expect(extractZip(zipPath, dest)).rejects.toThrow(/End of Central Directory/);
  });

  it('throws for buffers shorter than the EOCD record', async () => {
    const zipPath = path.join(tmpDir, 'tiny.zip');
    writeFileSync(zipPath, Buffer.from('PK\x05\x06')); // 6 bytes, well under 22

    const dest = path.join(tmpDir, 'out');
    await expect(extractZip(zipPath, dest)).rejects.toThrow(/End of Central Directory/);
  });

  it('rejects path traversal entries (zip slip)', async () => {
    const zipPath = writeZip([
      { name: '../../etc/passwd', data: Buffer.from('evil') },
    ]);

    const dest = path.join(tmpDir, 'out');
    await expect(extractZip(zipPath, dest)).rejects.toThrow(/path traversal/);
  });

  it('rejects path traversal with nested prefix', async () => {
    const zipPath = writeZip([
      { name: '../../../tmp/evil.sh', data: Buffer.from('evil') },
      { name: 'safe.txt', data: Buffer.from('safe') },
    ]);

    const dest = path.join(tmpDir, 'out');
    await expect(extractZip(zipPath, dest)).rejects.toThrow(/path traversal/);
  });

  it('allows legitimate nested paths', async () => {
    const zipPath = writeZip([
      { name: 'dist/bin/pingcode.js', data: Buffer.from('#!/usr/bin/env node') },
      { name: 'skills/pingcode/SKILL.md', data: Buffer.from('# Skill') },
    ]);

    const dest = path.join(tmpDir, 'out');
    const result = await extractZip(zipPath, dest);
    expect(result).toEqual(['dist/bin/pingcode.js', 'skills/pingcode/SKILL.md']);
  });

  it('extracts binary data correctly (deflate)', async () => {
    const binary = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binary[i] = i;

    const zipPath = writeZip([
      { name: 'binary.dat', data: binary },
    ]);

    const dest = path.join(tmpDir, 'out');
    await extractZip(zipPath, dest);

    expect(readFileSync(path.join(dest, 'binary.dat'))).toEqual(binary);
  });

  it('extracts binary data correctly (stored)', async () => {
    const binary = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binary[i] = 255 - i;

    const zipPath = writeZip([
      { name: 'binary.dat', data: binary, method: 0 },
    ]);

    const dest = path.join(tmpDir, 'out');
    await extractZip(zipPath, dest);

    expect(readFileSync(path.join(dest, 'binary.dat'))).toEqual(binary);
  });
});
