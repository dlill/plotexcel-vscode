import { drawText, measureText } from './font.ts';
import type { RasterImage } from './png.ts';

/** A crop window in percent of the image, as written in a layout cell. */
export interface CropWindow {
  readonly xmin: number;
  readonly xmax: number;
  readonly ymin: number;
  readonly ymax: number;
}

/**
 * Cut a percentage window out of an image.
 *
 * Percentages rather than pixels is what makes a crop survive a change of
 * resolution: the same `xmax 85` keeps meaning the same part of the plot when
 * the dpi doubles.
 */
export function cropImage(image: RasterImage, window: CropWindow): RasterImage {
  const left = clamp(Math.round((window.xmin / 100) * image.width), 0, image.width - 1);
  const top = clamp(Math.round((window.ymin / 100) * image.height), 0, image.height - 1);
  const right = clamp(Math.round((window.xmax / 100) * image.width), left + 1, image.width);
  const bottom = clamp(Math.round((window.ymax / 100) * image.height), top + 1, image.height);

  const width = right - left;
  const height = bottom - top;

  if (width === image.width && height === image.height) return image;

  const data = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((top + y) * image.width + left) * 4;
    image.data.copy(data, y * width * 4, from, from + width * 4);
  }

  return { width, height, data, dpi: image.dpi };
}

export interface DiffOptions {
  /**
   * How different two pixels must be before they count, 0–1. The same scale
   * pixelmatch uses; 0.1 is its default and ignores compression noise.
   */
  readonly threshold?: number;
  /** Show the unchanged parts of the first image, faded, behind the marks. */
  readonly showContext?: boolean;
}

export interface DiffResult {
  readonly image: RasterImage;
  readonly changedPixels: number;
  readonly totalPixels: number;
  /** True when the two inputs are not the same size, which is itself a finding. */
  readonly sizeMismatch: boolean;
}

const CHANGED: readonly [number, number, number] = [220, 38, 38];
const OUTSIDE: readonly [number, number, number] = [250, 204, 21];

/**
 * Compare two rendered pages and mark what moved.
 *
 * ImageMagick's `image_compare`, which the R package used, produces its own
 * composite that this deliberately does not imitate: unchanged pixels are
 * faded so the plot stays recognisable, changed pixels are red, and areas
 * present in only one of the two images are amber — the case that matters most
 * when a figure gains a panel and everything below it shifts.
 */
export function diffImages(first: RasterImage, second: RasterImage, options: DiffOptions = {}): DiffResult {
  const threshold = options.threshold ?? 0.1;
  const showContext = options.showContext ?? true;
  const maxDelta = 35215 * threshold * threshold;

  const width = Math.max(first.width, second.width);
  const height = Math.max(first.height, second.height);
  const data = Buffer.allocUnsafe(width * height * 4);
  let changedPixels = 0;

  // Written out flat rather than through pixel(), blend() and fade(), which
  // between them allocated five arrays per pixel — two and a half million for
  // a page-sized comparison. The arithmetic is unchanged, so the images this
  // produces are byte-for-byte what they were.
  const dataA = first.data;
  const dataB = second.data;

  for (let y = 0; y < height; y += 1) {
    const rowA = y * first.width * 4;
    const rowB = y * second.width * 4;
    const inRowA = y < first.height;
    const inRowB = y < second.height;

    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;

      if (!inRowA || !inRowB || x >= first.width || x >= second.width) {
        changedPixels += 1;
        data[target] = OUTSIDE[0];
        data[target + 1] = OUTSIDE[1];
        data[target + 2] = OUTSIDE[2];
        data[target + 3] = 255;
        continue;
      }

      const atA = rowA + x * 4;
      const atB = rowB + x * 4;

      const ar = dataA[atA]!;
      const ag = dataA[atA + 1]!;
      const ab = dataA[atA + 2]!;
      const aa = dataA[atA + 3]!;

      const br = dataB[atB]!;
      const bg = dataB[atB + 1]!;
      const bb = dataB[atB + 2]!;
      const ba = dataB[atB + 3]!;

      // Identical pixels are the common case and their delta is zero, so the
      // colour-space conversion is skipped entirely.
      const same = ar === br && ag === bg && ab === bb && aa === ba;

      if (!same) {
        const alphaA = aa / 255;
        const alphaB = ba / 255;

        const ra = 255 + (ar - 255) * alphaA;
        const ga = 255 + (ag - 255) * alphaA;
        const ba2 = 255 + (ab - 255) * alphaA;

        const rb = 255 + (br - 255) * alphaB;
        const gb = 255 + (bg - 255) * alphaB;
        const bb2 = 255 + (bb - 255) * alphaB;

        const deltaY = rgb2y(ra, ga, ba2) - rgb2y(rb, gb, bb2);
        const deltaI = rgb2i(ra, ga, ba2) - rgb2i(rb, gb, bb2);
        const deltaQ = rgb2q(ra, ga, ba2) - rgb2q(rb, gb, bb2);

        if (0.5053 * deltaY * deltaY + 0.299 * deltaI * deltaI + 0.1957 * deltaQ * deltaQ > maxDelta) {
          changedPixels += 1;
          data[target] = CHANGED[0];
          data[target + 1] = CHANGED[1];
          data[target + 2] = CHANGED[2];
          data[target + 3] = 255;
          continue;
        }
      }

      if (showContext) {
        const alpha = aa / 255;
        const grey = rgb2y(255 + (ar - 255) * alpha, 255 + (ag - 255) * alpha, 255 + (ab - 255) * alpha);
        const mixed = Math.round(grey * 0.25 + 255 * 0.75);

        data[target] = mixed;
        data[target + 1] = mixed;
        data[target + 2] = mixed;
      } else {
        data[target] = 255;
        data[target + 1] = 255;
        data[target + 2] = 255;
      }

      data[target + 3] = 255;
    }
  }

  return {
    image: { width, height, data, dpi: first.dpi ?? second.dpi },
    changedPixels,
    totalPixels: width * height,
    sizeMismatch: first.width !== second.width || first.height !== second.height,
  };
}

/** Share of pixels that differ, as a percentage with one decimal. */
export function diffPercentage(result: DiffResult): number {
  return Math.round((result.changedPixels / Math.max(1, result.totalPixels)) * 1000) / 10;
}

export type PlaceholderKind = 'missing-file' | 'missing-tool' | 'error';

export interface PlaceholderOptions {
  readonly kind: PlaceholderKind;
  /** One short line, drawn large. */
  readonly headline: string;
  /** Wrapped and drawn underneath. Say what to do, not only what went wrong. */
  readonly details?: readonly string[];
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly dpi?: number;
}

const PALETTE: Record<PlaceholderKind, { background: [number, number, number]; ink: [number, number, number] }> = {
  'missing-file': { background: [244, 244, 245], ink: [82, 82, 91] },
  'missing-tool': { background: [254, 249, 231], ink: [133, 77, 14] },
  error: { background: [254, 242, 242], ink: [153, 27, 27] },
};

/**
 * Draw the image a cell gets when its plot could not be produced.
 *
 * A blank cell tells the reader nothing and a missing row tells them less, so
 * the workbook carries the explanation itself: what failed, and what to
 * install or fix. This is the reason the font in `font.ts` exists.
 */
export function placeholderImage(options: PlaceholderOptions): RasterImage {
  const width = options.widthPx ?? 900;
  const height = options.heightPx ?? 600;
  const { background, ink } = PALETTE[options.kind];
  const data = Buffer.allocUnsafe(width * height * 4);

  for (let i = 0; i < width * height; i += 1) write(data, i * 4, background, 255);

  const border = 4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onEdge = x < border || y < border || x >= width - border || y >= height - border;
      if (onEdge) write(data, (y * width + x) * 4, ink, 255);
    }
  }

  const headlineScale = Math.max(2, Math.floor(width / 220));
  const detailScale = Math.max(1, Math.floor(headlineScale / 2));
  const lineGap = Math.round(6 * detailScale);

  const wrapped = (options.details ?? []).flatMap((line) => wrapText(line, detailScale, width - 80));
  const headlineHeight = 7 * headlineScale;
  const detailHeight = wrapped.length * (7 * detailScale + lineGap);
  let cursorY = Math.max(border + 10, Math.round((height - headlineHeight - detailHeight - lineGap * 2) / 2));

  drawInto(data, width, height, options.headline, headlineScale, cursorY, ink);
  cursorY += headlineHeight + lineGap * 2;

  for (const line of wrapped) {
    drawInto(data, width, height, line, detailScale, cursorY, ink);
    cursorY += 7 * detailScale + lineGap;
  }

  return { width, height, data, dpi: options.dpi ?? 150 };
}

function drawInto(
  data: Buffer,
  width: number,
  height: number,
  text: string,
  scale: number,
  top: number,
  ink: readonly [number, number, number],
): void {
  const left = Math.max(0, Math.round((width - measureText(text, scale)) / 2));

  drawText(text, scale, (x, y) => {
    const px = left + x;
    const py = top + y;
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    write(data, (py * width + px) * 4, ink, 255);
  });
}

function wrapText(text: string, scale: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (measureText(candidate, scale) > maxWidth && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line.length > 0) lines.push(line);
  return lines;
}

const rgb2y = (r: number, g: number, b: number) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const rgb2i = (r: number, g: number, b: number) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
const rgb2q = (r: number, g: number, b: number) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;

function write(data: Buffer, at: number, colour: readonly [number, number, number], alpha: number): void {
  data[at] = colour[0];
  data[at + 1] = colour[1];
  data[at + 2] = colour[2];
  data[at + 3] = alpha;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
