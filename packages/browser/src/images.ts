/**
 * Images, done the way a browser already can.
 *
 * The extension carries its own PNG codec because Node has no idea what a PNG
 * is. A browser does: it decodes any image into a bitmap and encodes a canvas
 * back to PNG, both in C++ that is already there. So the browser build uses
 * none of the codec — it reads a PNG's size from its header, passes the file
 * through untouched, and draws anything it has to invent onto a canvas.
 */

export interface ImageBytes {
  readonly png: Uint8Array;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpi: number;
}

const METRES_PER_INCH = 0.0254;

/**
 * Width, height and resolution from a PNG's first two chunks.
 *
 * Twenty-four bytes of header, and the optional pHYs chunk after it. Reading
 * this rather than decoding the image means a hundred plots cost a hundred
 * header reads instead of a hundred megabytes of pixels.
 */
export function readPngHeader(bytes: Uint8Array): { width: number; height: number; dpi?: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return undefined; // "IHDR"

  const header = { width: view.getUint32(16), height: view.getUint32(20) };
  const dpi = findPhysicalDpi(bytes, view);

  return dpi === undefined ? header : { ...header, dpi };
}

function findPhysicalDpi(bytes: Uint8Array, view: DataView): number | undefined {
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));

    if (type === 'pHYs' && length >= 9 && view.getUint8(offset + 16) === 1) {
      const perMetre = view.getUint32(offset + 8);
      return perMetre > 0 ? Math.round(perMetre * METRES_PER_INCH) : undefined;
    }

    if (type === 'IDAT' || type === 'IEND') return undefined;
    offset += length + 12;
  }

  return undefined;
}

/** A PNG straight from disk needs nothing done to it. */
export async function imageFromFile(file: File, dpi: number): Promise<ImageBytes | undefined> {
  const png = new Uint8Array(await file.arrayBuffer());
  const header = readPngHeader(png);
  if (header === undefined) return undefined;

  return { png, widthPx: header.width, heightPx: header.height, dpi };
}

export type PlaceholderTone = 'missing' | 'unsupported';

/**
 * The picture a cell gets when the browser cannot render its plot.
 *
 * The same idea as the extension's placeholders, drawn with the canvas text
 * API instead of a bitmap font — because here there is one. It says which file
 * it stands for and why, so a workbook full of them is still a workbook that
 * explains itself.
 */
export async function drawPlaceholder(options: {
  readonly headline: string;
  readonly lines: readonly string[];
  readonly tone: PlaceholderTone;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly dpi?: number;
}): Promise<ImageBytes> {
  const width = options.widthPx ?? 900;
  const height = options.heightPx ?? 600;
  const dpi = options.dpi ?? 150;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (context === null) throw new Error('This browser would not give us a canvas to draw on.');

  const palette =
    options.tone === 'missing'
      ? { background: '#f4f4f5', ink: '#52525b' }
      : { background: '#fef9e7', ink: '#854d0e' };

  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = palette.ink;
  context.lineWidth = 6;
  context.strokeRect(3, 3, width - 6, height - 6);

  context.fillStyle = palette.ink;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const headlineSize = Math.round(width / 22);
  const bodySize = Math.round(headlineSize * 0.55);
  const middle = height / 2 - (options.lines.length * bodySize * 1.6) / 2;

  context.font = `600 ${headlineSize}px system-ui, sans-serif`;
  context.fillText(options.headline, width / 2, middle, width - 60);

  context.font = `${bodySize}px system-ui, sans-serif`;
  options.lines.forEach((line, index) => {
    context.fillText(line, width / 2, middle + headlineSize + (index + 0.5) * bodySize * 1.6, width - 80);
  });

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('The canvas could not be turned into a PNG.');

  return { png: new Uint8Array(await blob.arrayBuffer()), widthPx: width, heightPx: height, dpi };
}

/** Physical size of an image, from its pixels and the resolution asked for. */
export function centimetres(pixels: number, dpi: number): number {
  return (pixels / dpi) * 2.54;
}
