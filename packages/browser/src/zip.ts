import { crc32 } from '../../core/src/bytes/crc32.ts';
import type { WorkbookPart } from '../../core/src/xlsx/workbookParts.ts';

/**
 * A ZIP writer for the browser, storing rather than compressing.
 *
 * The Node writer reaches for `node:zlib`, which a browser does not have — its
 * `CompressionStream` is asynchronous, and threading that through a format
 * this synchronous buys very little here. What a workbook actually contains is
 * a handful of small XML parts and a pile of PNGs, and PNGs are compressed
 * already. Storing everything makes the XML about twice its size, which on a
 * real workbook is a rounding error against the images.
 */
export function createStoredZip(parts: readonly WorkbookPart[], modifiedAt = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const stamp = dosTimestamp(modifiedAt);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const part of parts) {
    const name = encoder.encode(part.name);
    const checksum = crc32(part.data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, ascii(part.name) ? 0 : 0x800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, part.data.length, true);
    localView.setUint32(22, part.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, ascii(part.name) ? 0 : 0x800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, stamp.time, true);
    centralView.setUint16(14, stamp.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, part.data.length, true);
    centralView.setUint32(24, part.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, part.data);
    centrals.push(central);
    offset += local.length + part.data.length;
  }

  const directorySize = centrals.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, parts.length, true);
  endView.setUint16(10, parts.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  return concat([...locals, ...centrals, end]);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;

  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }

  return out;
}

function ascii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getUTCFullYear());
  return {
    time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
  };
}
