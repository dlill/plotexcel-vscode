import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { crc32 } from '../bytes/crc32.ts';

/**
 * A small ZIP reader and writer.
 *
 * Two things in this project are ZIP archives: the .xlsx this extension
 * writes, and the .docx and .pptx files it counts pages in. Both are reachable
 * with `node:zlib` and about two hundred lines of container format, which is a
 * better trade than a dependency for each.
 *
 * Not supported, deliberately: ZIP64, encryption, multi-disk archives and data
 * descriptors. None can occur in an Office document of a sane size, and each
 * is refused with a message rather than mis-read.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const MAX_UINT32 = 0xffffffff;
/** Ceiling on what a single entry may inflate to, however large it claims to be. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** A file to put into an archive. */
export interface ZipInput {
  readonly name: string;
  readonly data: Uint8Array;
  /** Store without compressing. Useful for data that is already compressed. */
  readonly store?: boolean;
}

/** A file found in an archive. */
export interface ZipEntry {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly offset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface CreateZipOptions {
  /**
   * Timestamp written into every entry. Fixed by default, so building the same
   * workbook twice produces byte-identical output — which is what lets a test
   * compare archives, and what keeps a committed .xlsx from churning in git.
   */
  readonly modifiedAt?: Date;
}

/** Build a ZIP archive in memory. */
export function createZip(entries: readonly ZipInput[], options: CreateZipOptions = {}): Buffer {
  const stamp = dosTimestamp(options.modifiedAt ?? new Date(Date.UTC(1980, 0, 1)));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  if (entries.length > 0xfffe) {
    throw new ZipError(`A ZIP archive here may hold at most 65534 files, got ${entries.length}.`);
  }

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const stored = entry.store === true;
    const body = stored ? entry.data : deflateRawSync(entry.data, { level: 6 });
    const method = stored ? 0 : 8;
    const checksum = crc32(entry.data);

    if (entry.data.length > MAX_UINT32 || body.length > MAX_UINT32) {
      throw new ZipError(`"${entry.name}" is too large for a ZIP archive without ZIP64.`);
    }

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Flag(entry.name), 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8Flag(entry.name), 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** List an archive's files, from its central directory. */
export function listZip(bytes: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new ZipError('Damaged archive: the central directory ends early.');
    }

    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);

    entries.push({
      name: bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: bytes.readUInt16LE(cursor + 10),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      size: bytes.readUInt32LE(cursor + 24),
      offset: bytes.readUInt32LE(cursor + 42),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Read one file out of an archive. Returns undefined when it is not there. */
export function readZipEntry(bytes: Buffer, name: string): Buffer | undefined {
  const entry = listZip(bytes).find((candidate) => candidate.name === name);
  return entry ? extract(bytes, entry) : undefined;
}

/** Read a file whose name matches a pattern — for parts whose name varies. */
export function readZipEntries(bytes: Buffer, pattern: RegExp): { name: string; data: Buffer }[] {
  return listZip(bytes)
    .filter((entry) => pattern.test(entry.name))
    .map((entry) => ({ name: entry.name, data: extract(bytes, entry) }));
}

function extract(bytes: Buffer, entry: ZipEntry): Buffer {
  if (bytes.readUInt32LE(entry.offset) !== LOCAL_HEADER) {
    throw new ZipError(`Damaged archive: "${entry.name}" has no local header.`);
  }

  const flags = bytes.readUInt16LE(entry.offset + 6);
  if ((flags & 0x1) !== 0) throw new ZipError(`"${entry.name}" is encrypted.`);

  const nameLength = bytes.readUInt16LE(entry.offset + 26);
  const extraLength = bytes.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const body = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return inflateBounded(body, entry);
  throw new ZipError(`"${entry.name}" uses compression method ${entry.method}, which is not supported.`);
}

/**
 * Inflate one entry, refusing to let it expand without limit.
 *
 * The central directory declares the uncompressed size, which makes the bound
 * exact for an archive that is telling the truth. {@link MAX_ENTRY_BYTES}
 * covers the case where that declaration is itself the lie — an `.xlsx` is a
 * ZIP like any other, and the parts read here are XML that never approaches
 * it.
 */
function inflateBounded(body: Buffer, entry: ZipEntry): Buffer {
  const declared = entry.size > 0 ? entry.size : MAX_ENTRY_BYTES;

  try {
    return inflateRawSync(body, { maxOutputLength: Math.min(declared, MAX_ENTRY_BYTES) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') throw error;
    throw new ZipError(
      `"${entry.name}" expands to more data than the archive declares, so it was not read. ` +
        'The file is damaged, or was built to exhaust memory.',
    );
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  // The record sits at the very end unless the archive has a comment, so scan
  // backwards over the largest comment a 16-bit length can describe.
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let cursor = bytes.length - 22; cursor >= earliest; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === END_OF_CENTRAL) return cursor;
  }
  throw new ZipError('This file is not a ZIP archive: no end-of-central-directory record.');
}

function utf8Flag(name: string): number {
  // Bit 11 tells the reader the name is UTF-8 rather than the legacy code page.
  return /^[\x20-\x7e]*$/.test(name) ? 0 : 0x800;
}

function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getUTCFullYear());
  return {
    time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
  };
}
