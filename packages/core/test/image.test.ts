import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { crc32 } from '../src/bytes/crc32.ts';

import { cropImage, diffImages, diffPercentage, placeholderImage } from '../src/image/ops.ts';
import { decodePng, encodePng, PngError, readPngHeader, type RasterImage } from '../src/image/png.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'png');

interface Expectation {
  width: number;
  height: number;
  pixels: [number, number, number, number][];
  dpi?: number;
}

const expected: Record<string, Expectation> = JSON.parse(
  readFileSync(path.join(fixtures, 'expected.json'), 'utf8'),
);

function makeImage(width: number, height: number, colour: (x: number, y: number) => [number, number, number, number]) {
  const data = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = colour(x, y);
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = a;
    }
  }
  return { width, height, data } satisfies RasterImage;
}

function pixelAt(image: RasterImage, x: number, y: number): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!, image.data[at + 3]!];
}

describe('decodePng, against files written by another encoder', () => {
  for (const [name, expectation] of Object.entries(expected)) {
    it(`decodes ${name}`, () => {
      const image = decodePng(readFileSync(path.join(fixtures, name)));

      assert.equal(image.width, expectation.width);
      assert.equal(image.height, expectation.height);
      if (expectation.dpi !== undefined) assert.equal(image.dpi, expectation.dpi);

      const actual: number[][] = [];
      for (let i = 0; i < expectation.pixels.length; i += 1) {
        actual.push([...image.data.subarray(i * 4, i * 4 + 4)]);
      }
      assert.deepEqual(actual, expectation.pixels.map((pixel) => [...pixel]));
    });
  }

  it('reads the header without decoding the pixels', () => {
    const header = readPngHeader(readFileSync(path.join(fixtures, 'phys-150dpi.png')));
    assert.deepEqual(header, { width: 4, height: 4, dpi: 150 });
  });

  it('rejects a file that is not a PNG', () => {
    assert.throws(() => decodePng(Buffer.from('not a png at all')), PngError);
  });
});

/**
 * A PNG header is dimensions that came out of the file, and the pixel buffer
 * is four bytes a pixel. Both of these are a few dozen bytes that ask for
 * gigabytes, and the decoder runs on whatever the layout file points at.
 */
describe('decodePng, against a file built to be hostile', () => {
  it('refuses an image whose dimensions would not fit in memory', () => {
    // 30000 × 30000 is 900 megapixels: 3.6 GB of RGBA from a 70-byte file.
    const bomb = buildPng({ width: 30_000, height: 30_000 }, deflateSync(Buffer.alloc(64)));

    assert.throws(() => decodePng(bomb), (error: Error) => {
      assert.ok(error instanceof PngError);
      assert.match(error.message, /larger than plotExcel will decode/);
      return true;
    });
  });

  it('stops a stream that inflates far past what the header promises', () => {
    // The header describes 100 × 100 RGB — about 30 KB of scanlines — while
    // the stream expands to 64 MB. Compressed, the lie costs 64 KB.
    const bomb = buildPng({ width: 100, height: 100 }, deflateSync(Buffer.alloc(64 * 1024 * 1024)));
    assert.ok(bomb.length < 100_000, 'the bomb should be small; that is the point of it');

    assert.throws(() => decodePng(bomb), (error: Error) => {
      assert.ok(error instanceof PngError);
      assert.match(error.message, /expands to far more data/);
      return true;
    });
  });

  it('still decodes an image whose stream is exactly as long as promised', () => {
    // The same path as the bomb, one byte per row of filter plus the row: the
    // bound must not be so tight that an ordinary image trips it.
    const rows = Buffer.alloc(4 * (4 * 3 + 1));
    const image = decodePng(buildPng({ width: 4, height: 4 }, deflateSync(rows)));

    assert.equal(image.width, 4);
    assert.equal(image.height, 4);
  });
});

/** An 8-bit RGB PNG with whatever header and pixel stream a test wants. */
function buildPng({ width, height }: { width: number; height: number }, stream: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: RGB

  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, checksum]);
  };

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', stream),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('encodePng', () => {
  it('round-trips opaque pixels', () => {
    const image = makeImage(9, 7, (x, y) => [(x * 20) % 256, (y * 30) % 256, 64, 255]);
    const decoded = decodePng(encodePng(image));
    assert.deepEqual(decoded.data, image.data);
  });

  it('round-trips transparency', () => {
    const image = makeImage(5, 4, (x, y) => [10, 20, 30, (x * 60 + y) % 256]);
    const decoded = decodePng(encodePng(image));
    assert.deepEqual(decoded.data, image.data);
  });

  it('drops the alpha channel when nothing is transparent', () => {
    const opaque = encodePng(makeImage(40, 40, () => [1, 2, 3, 255]));
    const translucent = encodePng(makeImage(40, 40, (x) => [1, 2, 3, x === 0 ? 128 : 255]));
    assert.ok(opaque.length < translucent.length, 'RGB should be smaller than RGBA');
  });

  it('writes the resolution so Excel sizes the image correctly', () => {
    const encoded = encodePng(makeImage(3, 3, () => [0, 0, 0, 255]), { dpi: 150 });
    assert.equal(readPngHeader(encoded).dpi, 150);
    assert.equal(decodePng(encoded).dpi, 150);
  });

  it('refuses a pixel buffer of the wrong size', () => {
    assert.throws(
      () => encodePng({ width: 4, height: 4, data: Buffer.alloc(10) }),
      /expected 64/,
    );
  });
});

describe('cropImage', () => {
  const image = makeImage(100, 50, (x, y) => [x, y, 0, 255]);

  it('cuts the requested percentage window', () => {
    const cropped = cropImage(image, { xmin: 10, xmax: 60, ymin: 0, ymax: 100 });
    assert.equal(cropped.width, 50);
    assert.equal(cropped.height, 50);
    assert.deepEqual(pixelAt(cropped, 0, 0), [10, 0, 0, 255]);
    assert.deepEqual(pixelAt(cropped, 49, 49), [59, 49, 0, 255]);
  });

  it('returns the same object for a full-frame crop', () => {
    assert.equal(cropImage(image, { xmin: 0, xmax: 100, ymin: 0, ymax: 100 }), image);
  });

  it('keeps at least one pixel and stays inside the image', () => {
    const sliver = cropImage(image, { xmin: 99, xmax: 100, ymin: 99, ymax: 100 });
    assert.ok(sliver.width >= 1 && sliver.height >= 1);
  });

  it('keeps the resolution, so the physical size shrinks with the crop', () => {
    const cropped = cropImage({ ...image, dpi: 150 }, { xmin: 0, xmax: 50, ymin: 0, ymax: 100 });
    assert.equal(cropped.dpi, 150);
  });
});

describe('diffImages', () => {
  const base = makeImage(20, 10, () => [255, 255, 255, 255]);

  it('finds no difference between identical images', () => {
    const result = diffImages(base, base);
    assert.equal(result.changedPixels, 0);
    assert.equal(result.sizeMismatch, false);
    assert.equal(diffPercentage(result), 0);
  });

  it('marks the pixels that changed', () => {
    const changed = makeImage(20, 10, (x, y) => (x === 5 && y === 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const result = diffImages(base, changed);

    assert.equal(result.changedPixels, 1);
    assert.deepEqual(pixelAt(result.image, 5, 5), [220, 38, 38, 255]);
  });

  it('ignores differences below the threshold', () => {
    const noisy = makeImage(20, 10, () => [253, 253, 253, 255]);
    assert.equal(diffImages(base, noisy).changedPixels, 0);
    assert.ok(diffImages(base, noisy, { threshold: 0 }).changedPixels > 0);
  });

  it('marks the area only one image covers, and says the sizes differ', () => {
    const taller = makeImage(20, 14, () => [255, 255, 255, 255]);
    const result = diffImages(base, taller);

    assert.equal(result.sizeMismatch, true);
    assert.equal(result.image.height, 14);
    assert.deepEqual(pixelAt(result.image, 0, 12), [250, 204, 21, 255]);
    assert.equal(result.changedPixels, 20 * 4);
  });

  it('keeps unchanged content visible but faded', () => {
    const dark = makeImage(20, 10, () => [0, 0, 0, 255]);
    const result = diffImages(dark, dark);
    const [r] = pixelAt(result.image, 0, 0);
    assert.ok(r > 180 && r < 255, `expected a faded grey, got ${r}`);
  });
});

describe('placeholderImage', () => {
  it('produces an image that says what went wrong', () => {
    const image = placeholderImage({
      kind: 'missing-tool',
      headline: 'PowerPoint conversion unavailable',
      details: ['Install LibreOffice or Microsoft Office, then render again.'],
      widthPx: 600,
      heightPx: 400,
    });

    assert.equal(image.width, 600);
    assert.equal(image.height, 400);
    assert.equal(image.dpi, 150);

    // The text has to actually be drawn: some pixels must differ from the ground.
    const background = pixelAt(image, 300, 20);
    let inked = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i] !== background[0]) inked += 1;
    }
    assert.ok(inked > 200, `expected drawn text, found ${inked} ink pixels`);
  });

  it('survives an empty message and unknown characters', () => {
    const image = placeholderImage({ kind: 'error', headline: '', details: ['ünïcödé ☃'] });
    assert.ok(image.data.length > 0);
  });

  it('round-trips through the encoder', () => {
    const image = placeholderImage({ kind: 'missing-file', headline: 'File not found' });
    const decoded = decodePng(encodePng(image));
    assert.deepEqual(decoded.data, image.data);
  });
});
