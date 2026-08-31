import { deflateSync, inflateSync } from 'node:zlib';

import { crc32 } from '../bytes/crc32.ts';

/**
 * A PNG reader and writer built on `node:zlib`.
 *
 * PNG is a container of length-prefixed chunks around a zlib stream, which
 * means the whole format is reachable from Node's standard library. That
 * matters here: the pipeline has to crop, diff and measure images on machines
 * where installing a native image library is exactly the kind of friction this
 * port exists to remove.
 *
 * Reading supports every non-interlaced PNG: greyscale, RGB, palette and
 * alpha variants at 1, 2, 4, 8 and 16 bits per sample. Writing always produces
 * 8-bit RGB or RGBA, whichever the image needs.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const METRES_PER_INCH = 0.0254;

/** An image in memory: 8-bit RGBA, four bytes per pixel, top row first. */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
  /** Resolution recorded in the file, when it had one. */
  readonly dpi?: number | undefined;
}

/** What a PNG header says, without decoding the pixels. */
export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly dpi?: number | undefined;
}

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngError';
  }
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * The largest image this decoder will allocate for.
 *
 * A PNG header is eight bytes of dimensions that came from the file, and the
 * pixel buffer is four bytes a pixel: without a ceiling, a forty-byte file can
 * ask for a 64 GB allocation and take the extension host with it. A3 at 600
 * dpi — the largest page the resolution setting can ask for at a plausible
 * size — is about 70 megapixels, so this admits everything the pipeline can
 * legitimately produce.
 */
const MAX_PIXELS = 100_000_000;

interface Chunk {
  readonly type: string;
  readonly data: Buffer;
}

function* chunks(bytes: Buffer): Generator<Chunk> {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('Not a PNG file: the signature is missing.');
  }

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;

    if (end + 4 > bytes.length) {
      throw new PngError(`PNG chunk "${type}" runs past the end of the file.`);
    }

    yield { type, data: bytes.subarray(start, end) };
    if (type === 'IEND') return;
    offset = end + 4;
  }
}

/** Read width, height and resolution without decoding the image. */
export function readPngHeader(bytes: Buffer): PngHeader {
  let header: PngHeader | undefined;
  let dpi: number | undefined;

  for (const chunk of chunks(bytes)) {
    if (chunk.type === 'IHDR') {
      header = { width: chunk.data.readUInt32BE(0), height: chunk.data.readUInt32BE(4) };
    } else if (chunk.type === 'pHYs') {
      dpi = physToDpi(chunk.data);
    } else if (chunk.type === 'IDAT') {
      break;
    }
  }

  if (!header) throw new PngError('PNG has no header chunk.');
  return { ...header, dpi };
}

/**
 * Set the resolution recorded in a PNG, without touching its pixels.
 *
 * The pipeline used to reach the same end by decoding and re-encoding, which
 * for a page-sized image is two hundred milliseconds spent rewriting bytes
 * that were already correct. A `pHYs` chunk is nine bytes; replacing it is
 * copying two slices and computing one checksum.
 */
export function retagPngDpi(bytes: Buffer, dpi: number): Buffer {
  const perMetre = Math.round(dpi / METRES_PER_INCH);

  const existing = [...chunks(bytes)].find((entry) => entry.type === 'pHYs');
  if (existing !== undefined && existing.data.readUInt32BE(0) === perMetre) return bytes;

  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(perMetre, 0);
  phys.writeUInt32BE(perMetre, 4);
  phys.writeUInt8(1, 8);

  const out: Buffer[] = [SIGNATURE];
  let written = false;

  for (const entry of chunks(bytes)) {
    if (entry.type === 'pHYs') continue;

    // pHYs must precede the first IDAT, which is the only ordering rule that
    // matters here.
    if (entry.type === 'IDAT' && !written) {
      out.push(chunk('pHYs', phys));
      written = true;
    }

    out.push(chunk(entry.type, entry.data));
  }

  if (!written) out.push(chunk('pHYs', phys));
  return Buffer.concat(out);
}

/** Decode any non-interlaced PNG to 8-bit RGBA. */
export function decodePng(bytes: Buffer): RasterImage {
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colourType = 6;
  let dpi: number | undefined;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const idat: Buffer[] = [];

  for (const chunk of chunks(bytes)) {
    switch (chunk.type) {
      case 'IHDR': {
        width = chunk.data.readUInt32BE(0);
        height = chunk.data.readUInt32BE(4);
        bitDepth = chunk.data.readUInt8(8);
        colourType = chunk.data.readUInt8(9);
        if (chunk.data.readUInt8(10) !== 0) throw new PngError('Unsupported PNG compression method.');
        if (chunk.data.readUInt8(11) !== 0) throw new PngError('Unsupported PNG filter method.');
        if (chunk.data.readUInt8(12) !== 0) {
          throw new PngError('This PNG is interlaced, which is not supported. Re-save it without interlacing.');
        }
        break;
      }
      case 'PLTE':
        palette = Buffer.from(chunk.data);
        break;
      case 'tRNS':
        transparency = Buffer.from(chunk.data);
        break;
      case 'pHYs':
        dpi = physToDpi(chunk.data);
        break;
      case 'IDAT':
        idat.push(chunk.data);
        break;
      default:
        break;
    }
  }

  if (width === 0 || height === 0) throw new PngError('PNG reports a zero-sized image.');
  const channels = CHANNELS[colourType];
  if (channels === undefined) throw new PngError(`Unsupported PNG colour type ${colourType}.`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new PngError(`Unsupported PNG bit depth ${bitDepth}.`);
  if (colourType === 3 && palette === undefined) throw new PngError('Palette PNG has no palette.');

  if (width * height > MAX_PIXELS) {
    throw new PngError(
      `This PNG is ${width}×${height} pixels, which is larger than plotExcel will decode. ` +
        'Re-save it at a smaller size, or render the page at a lower resolution.',
    );
  }

  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const bytesPerRow = Math.ceil((bitsPerPixel * width) / 8);
  // The stream holds one filter byte per row plus the row itself, so its size
  // is known from the header before a byte is inflated. Anything wanting to
  // produce more than that is a decompression bomb rather than an image.
  const expected = height * (bytesPerRow + 1);
  const raw = inflateBounded(Buffer.concat(idat), expected);

  if (raw.length < expected) {
    throw new PngError('PNG image data is shorter than its header promises.');
  }

  const unfiltered = unfilter(raw, height, bytesPerRow, bytesPerPixel);
  const data = toRgba({ unfiltered, width, height, bytesPerRow, bitDepth, colourType, channels, palette, transparency });

  return { width, height, data, dpi };
}

/** Inflate a stream that must not exceed a size the header already told us. */
function inflateBounded(stream: Buffer, maxOutputLength: number): Buffer {
  try {
    return inflateSync(stream, { maxOutputLength });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') throw error;
    throw new PngError(
      'This PNG expands to far more data than its header describes, so it was not decoded. ' +
        'It is damaged, or was built to exhaust memory.',
    );
  }
}

/** Encode 8-bit RGBA pixels as a PNG, dropping the alpha channel when it is unused. */
export function encodePng(image: RasterImage, options: { readonly dpi?: number | undefined } = {}): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new PngError(`Pixel buffer is ${data.length} bytes, expected ${width * height * 4}.`);
  }

  const opaque = isOpaque(data);
  const channels = opaque ? 3 : 4;
  const bytesPerRow = width * channels;
  const rows = Buffer.allocUnsafe(height * (bytesPerRow + 1));

  // Three scratch buffers, reused for every row. The straightforward version
  // allocated five filtered candidates and copied the previous row on each
  // pass, which on a page-sized image is a few thousand allocations for no
  // reason.
  let previous = Buffer.alloc(bytesPerRow);
  let current = Buffer.allocUnsafe(bytesPerRow);
  const candidate = Buffer.allocUnsafe(bytesPerRow);
  const best = Buffer.allocUnsafe(bytesPerRow);

  for (let y = 0; y < height; y += 1) {
    if (opaque) {
      let to = 0;
      for (let from = y * width * 4, end = from + width * 4; from < end; from += 4) {
        current[to] = data[from]!;
        current[to + 1] = data[from + 1]!;
        current[to + 2] = data[from + 2]!;
        to += 3;
      }
    } else {
      data.copy(current, 0, y * width * 4, (y + 1) * width * 4);
    }

    const type = chooseFilter(current, previous, channels, candidate, best);

    const target = y * (bytesPerRow + 1);
    rows[target] = type;
    best.copy(rows, target + 1);

    // Swap rather than copy: this row is the next row's `previous`, and the
    // buffer it displaces is free to be overwritten.
    const spare = previous;
    previous = current;
    current = spare;
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(opaque ? 2 : 6, 9);

  const dpi = options.dpi ?? image.dpi;
  const parts = [SIGNATURE, chunk('IHDR', header)];

  if (dpi !== undefined && dpi > 0) {
    const phys = Buffer.alloc(9);
    const perMetre = Math.round(dpi / METRES_PER_INCH);
    phys.writeUInt32BE(perMetre, 0);
    phys.writeUInt32BE(perMetre, 4);
    phys.writeUInt8(1, 8);
    parts.push(chunk('pHYs', phys));
  }

  parts.push(chunk('IDAT', deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function isOpaque(data: Buffer): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return false;
  }
  return true;
}

/**
 * Pick the filter that compresses best, by the usual sum-of-absolute-values
 * heuristic. Writes the winner into `best` and returns its type.
 */
function chooseFilter(
  line: Buffer,
  previous: Buffer,
  bytesPerPixel: number,
  candidate: Buffer,
  best: Buffer,
): number {
  let bestType = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let type = 0; type <= 4; type += 1) {
    applyFilterInto(candidate, type, line, previous, bytesPerPixel);

    let score = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      const byte = candidate[index]!;
      score += byte < 128 ? byte : 256 - byte;
      // Nothing below can win once the total is already worse.
      if (score >= bestScore) break;
    }

    if (score < bestScore) {
      bestScore = score;
      bestType = type;
      candidate.copy(best);
    }
  }

  return bestType;
}

function applyFilterInto(out: Buffer, type: number, line: Buffer, previous: Buffer, bpp: number): void {
  const length = line.length;

  // The switch is outside the loop: inside, it is a branch per byte over a
  // couple of million bytes an image.
  switch (type) {
    case 0:
      line.copy(out);
      return;

    case 1:
      for (let i = 0; i < bpp && i < length; i += 1) out[i] = line[i]!;
      for (let i = bpp; i < length; i += 1) out[i] = (line[i]! - line[i - bpp]!) & 0xff;
      return;

    case 2:
      for (let i = 0; i < length; i += 1) out[i] = (line[i]! - previous[i]!) & 0xff;
      return;

    case 3:
      for (let i = 0; i < bpp && i < length; i += 1) out[i] = (line[i]! - (previous[i]! >> 1)) & 0xff;
      for (let i = bpp; i < length; i += 1) {
        out[i] = (line[i]! - ((line[i - bpp]! + previous[i]!) >> 1)) & 0xff;
      }
      return;

    default:
      for (let i = 0; i < bpp && i < length; i += 1) out[i] = (line[i]! - paeth(0, previous[i]!, 0)) & 0xff;
      for (let i = bpp; i < length; i += 1) {
        out[i] = (line[i]! - paeth(line[i - bpp]!, previous[i]!, previous[i - bpp]!)) & 0xff;
      }
  }
}

/**
 * Undo the per-row filters.
 *
 * The switch is hoisted out of the byte loop and the first pixel of each row
 * is handled separately, because the alternative — a branch and three
 * conditionals per byte — costs more than the arithmetic it guards, over a
 * couple of million bytes an image.
 */
function unfilter(raw: Buffer, height: number, bytesPerRow: number, bytesPerPixel: number): Buffer {
  const out = Buffer.allocUnsafe(height * bytesPerRow);
  const bpp = bytesPerPixel;

  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (bytesPerRow + 1)]!;
    const from = y * (bytesPerRow + 1) + 1;
    const to = y * bytesPerRow;
    const up = to - bytesPerRow;
    const first = y === 0;
    const lead = Math.min(bpp, bytesPerRow);

    switch (type) {
      case 0:
        raw.copy(out, to, from, from + bytesPerRow);
        break;

      case 1:
        for (let i = 0; i < lead; i += 1) out[to + i] = raw[from + i]!;
        for (let i = bpp; i < bytesPerRow; i += 1) {
          out[to + i] = (raw[from + i]! + out[to + i - bpp]!) & 0xff;
        }
        break;

      case 2:
        if (first) raw.copy(out, to, from, from + bytesPerRow);
        else for (let i = 0; i < bytesPerRow; i += 1) out[to + i] = (raw[from + i]! + out[up + i]!) & 0xff;
        break;

      case 3:
        for (let i = 0; i < lead; i += 1) {
          out[to + i] = (raw[from + i]! + (first ? 0 : out[up + i]! >> 1)) & 0xff;
        }
        for (let i = bpp; i < bytesPerRow; i += 1) {
          const above = first ? 0 : out[up + i]!;
          out[to + i] = (raw[from + i]! + ((out[to + i - bpp]! + above) >> 1)) & 0xff;
        }
        break;

      case 4:
        for (let i = 0; i < lead; i += 1) {
          out[to + i] = (raw[from + i]! + (first ? 0 : out[up + i]!)) & 0xff;
        }
        if (first) {
          for (let i = bpp; i < bytesPerRow; i += 1) {
            out[to + i] = (raw[from + i]! + out[to + i - bpp]!) & 0xff;
          }
        } else {
          for (let i = bpp; i < bytesPerRow; i += 1) {
            out[to + i] = (raw[from + i]! + paeth(out[to + i - bpp]!, out[up + i]!, out[up + i - bpp]!)) & 0xff;
          }
        }
        break;

      default:
        throw new PngError(`Unknown PNG row filter ${type} on row ${y + 1}.`);
    }
  }

  return out;
}

interface ToRgbaInput {
  readonly unfiltered: Buffer;
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly bitDepth: number;
  readonly colourType: number;
  readonly channels: number;
  readonly palette: Buffer | undefined;
  readonly transparency: Buffer | undefined;
}

function toRgba(input: ToRgbaInput): Buffer {
  const { unfiltered, width, height, bytesPerRow, bitDepth, colourType, channels, palette, transparency } = input;
  const out = Buffer.allocUnsafe(width * height * 4);
  const maximum = (1 << bitDepth) - 1;

  // Almost every PNG that reaches this is 8-bit RGB or RGBA with no
  // transparency chunk — everything a rasteriser produces. The general path
  // below allocates a samples array and a closure per pixel, which for a
  // page-sized image is half a million of each; these two loops do neither.
  if (bitDepth === 8 && transparency === undefined && (colourType === 2 || colourType === 6)) {
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * bytesPerRow;
      let to = y * width * 4;

      for (let x = 0, from = rowStart; x < width; x += 1, from += channels) {
        out[to] = unfiltered[from]!;
        out[to + 1] = unfiltered[from + 1]!;
        out[to + 2] = unfiltered[from + 2]!;
        out[to + 3] = colourType === 6 ? unfiltered[from + 3]! : 255;
        to += 4;
      }
    }

    return out;
  }

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * bytesPerRow;

    for (let x = 0; x < width; x += 1) {
      const samples: number[] = [];
      for (let channel = 0; channel < channels; channel += 1) {
        samples.push(readSample(unfiltered, rowStart, x * channels + channel, bitDepth));
      }

      const target = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      switch (colourType) {
        case 0: {
          const value = bitDepth === 16 ? samples[0]! >> 8 : Math.round((samples[0]! * 255) / maximum);
          r = value;
          g = value;
          b = value;
          if (transparency && transparency.length >= 2 && samples[0] === transparency.readUInt16BE(0)) a = 0;
          break;
        }
        case 2: {
          const scale = (value: number) => (bitDepth === 16 ? value >> 8 : Math.round((value * 255) / maximum));
          r = scale(samples[0]!);
          g = scale(samples[1]!);
          b = scale(samples[2]!);
          if (
            transparency &&
            transparency.length >= 6 &&
            samples[0] === transparency.readUInt16BE(0) &&
            samples[1] === transparency.readUInt16BE(2) &&
            samples[2] === transparency.readUInt16BE(4)
          ) {
            a = 0;
          }
          break;
        }
        case 3: {
          const index = samples[0]!;
          const at = index * 3;
          if (!palette || at + 2 >= palette.length) throw new PngError(`Palette index ${index} is out of range.`);
          r = palette[at]!;
          g = palette[at + 1]!;
          b = palette[at + 2]!;
          a = transparency && index < transparency.length ? transparency[index]! : 255;
          break;
        }
        case 4: {
          const value = bitDepth === 16 ? samples[0]! >> 8 : Math.round((samples[0]! * 255) / maximum);
          r = value;
          g = value;
          b = value;
          a = bitDepth === 16 ? samples[1]! >> 8 : Math.round((samples[1]! * 255) / maximum);
          break;
        }
        default: {
          const scale = (value: number) => (bitDepth === 16 ? value >> 8 : Math.round((value * 255) / maximum));
          r = scale(samples[0]!);
          g = scale(samples[1]!);
          b = scale(samples[2]!);
          a = scale(samples[3]!);
        }
      }

      out[target] = r;
      out[target + 1] = g;
      out[target + 2] = b;
      out[target + 3] = a;
    }
  }

  return out;
}

function readSample(row: Buffer, rowStart: number, index: number, bitDepth: number): number {
  if (bitDepth === 8) return row[rowStart + index]!;
  if (bitDepth === 16) return row.readUInt16BE(rowStart + index * 2);

  const bitOffset = index * bitDepth;
  const byte = row[rowStart + (bitOffset >> 3)]!;
  const shift = 8 - bitDepth - (bitOffset & 7);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function physToDpi(data: Buffer): number | undefined {
  if (data.length < 9 || data.readUInt8(8) !== 1) return undefined;
  const perMetre = data.readUInt32BE(0);
  return perMetre > 0 ? Math.round(perMetre * METRES_PER_INCH) : undefined;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

