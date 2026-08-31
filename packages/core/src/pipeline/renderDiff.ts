import { createHash } from 'node:crypto';

import { diffPath } from '../cache/keys.ts';
import { diffImages, diffPercentage, placeholderImage } from '../image/ops.ts';
import { decodePng, encodePng, readPngHeader } from '../image/png.ts';
import { pixelsToCm } from '../units.ts';
import { isFresh, readFileOrUndefined, writeFileAtomic } from './files.ts';
import type { RenderedPlot } from './renderPlot.ts';

export interface RenderedDiff {
  readonly png: Buffer;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpi: number;
  readonly widthCm: number;
  readonly heightCm: number;
  /** Percentage of pixels that differ, one decimal place. */
  readonly changed: number;
  readonly sizeMismatch: boolean;
  readonly fromCache: boolean;
  readonly elapsedMs: number;
}

export interface RenderDiffOptions {
  readonly cacheRoot?: string | undefined;
  readonly threshold?: number | undefined;
  /** Whether unchanged content is kept, faded, behind the marks. */
  readonly showContext?: boolean | undefined;
  readonly force?: boolean | undefined;
}

/**
 * Compare two already-rendered pages.
 *
 * Both sides come out of {@link renderPlot}, so they are cropped, at the same
 * dpi, and cached. The diff is cached too, keyed on the two inputs, and it is
 * only reused while both remain older than it.
 *
 * A diff of a placeholder is deliberately not cached: those images describe the
 * machine, not the plots, and would otherwise outlive the problem.
 */
export async function renderDiff(
  first: RenderedPlot,
  second: RenderedPlot,
  options: RenderDiffOptions = {},
): Promise<RenderedDiff> {
  const startedAt = Date.now();
  const cacheable = first.issue === undefined && second.issue === undefined && first.cachePath !== undefined && second.cachePath !== undefined;
  const target = cacheable
    ? diffPath(first.cachePath!, second.cachePath!, options.cacheRoot, {
        tolerance: options.threshold,
        context: options.showContext,
      })
    : undefined;

  if (target !== undefined && options.force !== true) {
    const fresh = await isFresh(target, [first.cachePath!, second.cachePath!], false);
    const cached = fresh ? await readFileOrUndefined(target) : undefined;

    if (cached !== undefined) {
      try {
        const header = readPngHeader(cached);
        const meta = await readDiffMeta(target);
        return {
          png: cached,
          widthPx: header.width,
          heightPx: header.height,
          dpi: header.dpi ?? first.dpi,
          widthCm: pixelsToCm(header.width, header.dpi ?? first.dpi),
          heightCm: pixelsToCm(header.height, header.dpi ?? first.dpi),
          changed: meta.changed,
          sizeMismatch: meta.sizeMismatch,
          fromCache: true,
          elapsedMs: Date.now() - startedAt,
        };
      } catch {
        // Rebuild rather than trust a damaged cache entry.
      }
    }
  }

  const result = diffImages(decodePng(first.png), decodePng(second.png), {
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.showContext === undefined ? {} : { showContext: options.showContext }),
  });
  const dpi = result.image.dpi ?? first.dpi;
  const changed = diffPercentage(result);
  const png = encodePng(result.image, { dpi });

  if (target !== undefined) {
    await writeFileAtomic(target, png).catch(() => undefined);
    await writeFileAtomic(`${target}.json`, Buffer.from(JSON.stringify({ changed, sizeMismatch: result.sizeMismatch }))).catch(
      () => undefined,
    );
  }

  return {
    png,
    widthPx: result.image.width,
    heightPx: result.image.height,
    dpi,
    widthCm: pixelsToCm(result.image.width, dpi),
    heightCm: pixelsToCm(result.image.height, dpi),
    changed,
    sizeMismatch: result.sizeMismatch,
    fromCache: false,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * The percentage that changed is written beside the cached image, so a cache
 * hit can report it without counting every pixel again. A missing or damaged
 * sidecar is not an error - the image is still the answer.
 */
async function readDiffMeta(target: string): Promise<{ changed: number; sizeMismatch: boolean }> {
  const raw = await readFileOrUndefined(`${target}.json`);
  if (raw === undefined) return { changed: Number.NaN, sizeMismatch: false };

  try {
    const parsed = JSON.parse(raw.toString('utf8')) as { changed?: unknown; sizeMismatch?: unknown };
    return {
      changed: typeof parsed.changed === 'number' ? parsed.changed : Number.NaN,
      sizeMismatch: parsed.sizeMismatch === true,
    };
  } catch {
    return { changed: Number.NaN, sizeMismatch: false };
  }
}

/** An image for a diff cell that could not be computed, with the reason on it. */
export function diffPlaceholder(headline: string, details: readonly string[], dpi = 150): RenderedDiff {
  const image = placeholderImage({ kind: 'error', headline, details, widthPx: 900, heightPx: 300, dpi });

  return {
    png: encodePng(image, { dpi }),
    widthPx: image.width,
    heightPx: image.height,
    dpi,
    widthCm: pixelsToCm(image.width, dpi),
    heightCm: pixelsToCm(image.height, dpi),
    changed: Number.NaN,
    sizeMismatch: false,
    fromCache: false,
    elapsedMs: 0,
  };
}

/** Stable identity for a pair of images, used when neither side has a cache path. */
export function diffIdentity(first: Buffer, second: Buffer): string {
  return createHash('sha256').update(first).update(second).digest('hex').slice(0, 12);
}
