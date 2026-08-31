import { pipelinePaths, type CacheKeyOptions } from '../cache/keys.ts';
import { convertedExtension } from '../spec/classify.ts';
import type { PlotSpec } from '../types.ts';
import { isFresh, readFileOrUndefined, writeFileAtomic } from './files.ts';
import type { DocumentConverter, PageSize, Tools } from './ports.ts';

/**
 * The PDF for a plot, converted only when nothing has converted it already.
 *
 * This is the stage the pipeline always described and never implemented.
 * `pipelinePaths` has named a `converted` file since the beginning, but
 * `renderPlot` converted in memory and threw the result away, so a three-page
 * HTML plot meant three Chromium launches for one file and three identical
 * PDFs.
 *
 * The cache key is what makes this worth doing: `converted` is derived from the
 * file, its folder and its revision, and deliberately *not* from the page or
 * the resolution. One conversion therefore serves every page and every dpi of
 * the same source — so adding a page or changing `#resolution:` no longer pays
 * for LibreOffice or a browser again, and counting an HTML file's pages while
 * generating a layout leaves the render with nothing to do.
 *
 * Deduplication in flight matters as much as the cache on disk. The pages of
 * one file are rendered concurrently, so without it they all miss the cache in
 * the same instant and convert the same document at the same time.
 */

export interface ConvertOptions extends CacheKeyOptions {
  readonly tools?: Tools | undefined;
  readonly pageSize?: PageSize | undefined;
  /** Convert again even if a cached PDF looks current. */
  readonly force?: boolean | undefined;
}

/** No converter at all, or one that does not take this format. */
export class NoConverterError extends Error {
  readonly extension: string;

  constructor(extension: string) {
    super(`No converter available for .${extension} files.`);
    this.name = 'NoConverterError';
    this.extension = extension;
  }
}

/**
 * Conversions running right now, by the path their result will be written to.
 *
 * Keyed on the cache path rather than the source path because that is what
 * already encodes the file, the folder and the revision — two specs that would
 * write the same file are the same conversion.
 */
const inFlight = new Map<string, Promise<Buffer>>();

export async function convertToPdfCached(
  spec: PlotSpec,
  bytes: Buffer,
  extension: string,
  options: ConvertOptions = {},
): Promise<{ bytes: Buffer; extension: string }> {
  const target = convertedExtension(spec);
  if (target === extension) return { bytes, extension };

  const paths = pipelinePaths(spec, options);

  // This get and the set below are not separated by an `await`, so they run as
  // one step: two callers for the same file cannot both decide to convert it.
  const joined = inFlight.get(paths.converted);
  if (joined !== undefined) return { bytes: await joined, extension: target };

  const work = produce(spec, bytes, extension, paths.converted, paths.source, options);
  inFlight.set(paths.converted, work);

  try {
    return { bytes: await work, extension: target };
  } finally {
    inFlight.delete(paths.converted);
  }
}

async function produce(
  spec: PlotSpec,
  bytes: Buffer,
  extension: string,
  convertedPath: string,
  sourcePath: string,
  options: ConvertOptions,
): Promise<Buffer> {
  // A revision other than HEAD cannot change, so its conversion never goes
  // stale; HEAD is compared against the file it came from.
  const immutable = spec.commit !== 'HEAD';

  if (options.force !== true && (await isFresh(convertedPath, [sourcePath], immutable))) {
    const cached = await readFileOrUndefined(convertedPath);
    // An empty file is a half-written entry, not a document with no pages.
    if (cached !== undefined && cached.length > 0) return cached;
  }

  const converter = options.tools?.converter;
  if (converter === undefined || !converter.canConvert(extension)) throw new NoConverterError(extension);

  const pdf = await convert(converter, bytes, extension, options.pageSize);

  // Best effort: a cache that cannot be written is slower, not broken.
  await writeFileAtomic(convertedPath, pdf).catch(() => undefined);

  return pdf;
}

function convert(
  converter: DocumentConverter,
  bytes: Buffer,
  extension: string,
  pageSize: PageSize | undefined,
): Promise<Buffer> {
  return converter.toPdf({
    bytes,
    extension,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
}
