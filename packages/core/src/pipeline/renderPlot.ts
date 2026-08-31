import path from 'node:path';

import { pipelinePaths, type CacheKeyOptions } from '../cache/keys.ts';
import { cropImage, placeholderImage, type PlaceholderKind } from '../image/ops.ts';
import { decodePng, encodePng, readPngHeader, retagPngDpi, type RasterImage } from '../image/png.ts';
import { convertedExtension, plotExtensionOf } from '../spec/classify.ts';
import { pixelsToCm } from '../units.ts';
import type { PlotSpec } from '../types.ts';
import { isFresh, readFileOrUndefined, statOrUndefined, writeFileAtomic } from './files.ts';
import type { PageSize, RenderedPage, Tools } from './ports.ts';

/**
 * Turn one layout cell into the PNG that goes into the workbook.
 *
 * The stages are the R package's, and so is the idempotency: each stage writes
 * a file whose name encodes every input, and a stage whose output is already
 * current does nothing. Re-rendering a forty-plot layout after changing one
 * caption costs almost nothing, which is what makes the workbook something you
 * rebuild casually rather than a batch job.
 *
 * What is different is what happens when a stage cannot run. Nothing throws:
 * a missing file, a missing renderer or a converter that is not installed
 * produce an image that says so, and the workbook still builds.
 */

export type IssueKind =
  | 'missing-file'
  | 'missing-revision'
  | 'no-renderer'
  | 'no-converter'
  | 'no-revision-reader'
  | 'render-failed'
  | 'convert-failed'
  | 'unsupported';

export interface PipelineIssue {
  readonly kind: IssueKind;
  /** One line, drawn large on the placeholder. */
  readonly headline: string;
  /** What the person should do about it. */
  readonly details: readonly string[];
  /** The underlying error, for the log rather than the workbook. */
  readonly cause?: string | undefined;
}

export interface RenderedPlot {
  readonly png: Buffer;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpi: number;
  readonly widthCm: number;
  readonly heightCm: number;
  /** Where the result is cached, when it was cacheable. */
  readonly cachePath?: string | undefined;
  readonly fromCache: boolean;
  /** Present when this is a placeholder rather than the real plot. */
  readonly issue?: PipelineIssue | undefined;
  readonly elapsedMs: number;
}

export type Stage = 'cache' | 'checkout' | 'convert' | 'rasterise' | 'crop' | 'write';

export interface RenderPlotOptions extends CacheKeyOptions {
  readonly tools?: Tools | undefined;
  readonly pageSize?: PageSize | undefined;
  /** Called as each stage starts, for progress reporting. */
  readonly onStage?: ((stage: Stage, spec: PlotSpec) => void) | undefined;
  /** Ignore cached output and redo every stage. */
  readonly force?: boolean | undefined;
}

const PLACEHOLDER_WIDTH_CM = 10;
const PLACEHOLDER_HEIGHT_CM = 7;
const PLACEHOLDER_MAX_PX = 1200;

export async function renderPlot(spec: PlotSpec, options: RenderPlotOptions = {}): Promise<RenderedPlot> {
  const startedAt = Date.now();
  const paths = pipelinePaths(spec, options);
  const immutable = spec.commit !== 'HEAD';
  const report = (stage: Stage) => options.onStage?.(stage, spec);

  report('cache');
  if (options.force !== true && (await isFresh(paths.cropped, [paths.source], immutable))) {
    const cached = await readFileOrUndefined(paths.cropped);
    if (cached !== undefined) {
      try {
        const header = readPngHeader(cached);
        return measured(cached, header.width, header.height, spec.resolution, {
          cachePath: paths.cropped,
          fromCache: true,
          elapsedMs: Date.now() - startedAt,
        });
      } catch {
        // A truncated cache entry is worth nothing; fall through and rebuild.
      }
    }
  }

  const extension = plotExtensionOf(spec.path);
  if (extension === undefined) {
    return placeholder(spec, startedAt, {
      kind: 'unsupported',
      headline: 'Unsupported file type',
      details: [`${path.basename(spec.path)} is not a kind of plot this extension can read.`],
    });
  }

  report('checkout');
  const checkout = await readSource(spec, paths.source, options);
  if ('issue' in checkout) return placeholder(spec, startedAt, checkout.issue);

  report('convert');
  const converted = await toRenderable(spec, checkout.bytes, extension, options);
  if ('issue' in converted) return placeholder(spec, startedAt, converted.issue);

  report('rasterise');
  const rasterised = await rasterise(spec, converted, options);
  if ('issue' in rasterised) return placeholder(spec, startedAt, rasterised.issue);

  report('crop');
  // Physical size is pixels over the requested dpi, for every input format.
  const dpi = spec.resolution;
  const placed = place(rasterised.page, spec, dpi);

  report('write');
  await writeFileAtomic(paths.cropped, placed.png).catch(() => undefined);

  return measured(placed.png, placed.width, placed.height, dpi, {
    cachePath: paths.cropped,
    fromCache: false,
    elapsedMs: Date.now() - startedAt,
  });
}

// ------------------------------------------------------------------------- //
// Stages
// ------------------------------------------------------------------------- //

type StageResult<T> = T | { readonly issue: PipelineIssue };

async function readSource(
  spec: PlotSpec,
  source: string,
  options: RenderPlotOptions,
): Promise<StageResult<{ bytes: Buffer }>> {
  if (spec.commit === 'HEAD') {
    const bytes = await readFileOrUndefined(source);
    if (bytes === undefined) {
      return {
        issue: {
          kind: 'missing-file',
          headline: 'File not found',
          details: [path.basename(source), 'Check the path in the layout file.'],
          cause: source,
        },
      };
    }
    return { bytes };
  }

  const reader = options.tools?.revisions;
  if (reader === undefined) {
    return {
      issue: {
        kind: 'no-revision-reader',
        headline: 'Cannot read from git',
        details: [`Reading ${spec.commit} needs git, which was not found on this machine.`],
      },
    };
  }

  try {
    const bytes = await reader.read({ path: source, revision: spec.commit });
    if (bytes === undefined) {
      return {
        issue: {
          kind: 'missing-revision',
          headline: `Not in ${spec.commit}`,
          details: [`${path.basename(source)} does not exist at that revision.`],
        },
      };
    }
    return { bytes };
  } catch (error) {
    return {
      issue: {
        kind: 'missing-revision',
        headline: `Could not read ${spec.commit}`,
        details: [`${path.basename(source)} could not be read at that revision.`],
        cause: messageOf(error),
      },
    };
  }
}

interface Renderable {
  readonly bytes: Buffer;
  readonly extension: string;
}

async function toRenderable(
  spec: PlotSpec,
  bytes: Buffer,
  extension: string,
  options: RenderPlotOptions,
): Promise<StageResult<Renderable>> {
  const target = convertedExtension(spec);
  if (target === extension) return { bytes, extension };

  const converter = options.tools?.converter;
  if (converter === undefined || !converter.canConvert(extension)) {
    return {
      issue: {
        kind: 'no-converter',
        headline: `Cannot read .${extension} files here`,
        details: converterAdvice(extension),
      },
    };
  }

  try {
    const pdf = await converter.toPdf({
      bytes,
      extension,
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    });
    return { bytes: pdf, extension: 'pdf' };
  } catch (error) {
    return {
      issue: {
        kind: 'convert-failed',
        headline: `${converter.name} could not convert this file`,
        details: [path.basename(spec.path), 'Open it in its own application to check that it is not damaged.'],
        cause: messageOf(error),
      },
    };
  }
}

function converterAdvice(extension: string): string[] {
  if (['html', 'htm'].includes(extension)) {
    return ['Rendering an HTML plot needs Chrome, Edge or another Chromium browser.'];
  }
  return [
    `Converting .${extension} needs Microsoft Office or LibreOffice.`,
    'Everything else in this layout still rendered.',
  ];
}

async function rasterise(
  spec: PlotSpec,
  source: Renderable,
  options: RenderPlotOptions,
): Promise<StageResult<{ page: RenderedPage }>> {
  if (source.extension === 'png') {
    try {
      // Only the header, so a PNG that is placed uncropped is never decoded
      // at all. The cell's own resolution wins over whatever the file claims:
      // a PNG carrying 300 dpi metadata would otherwise come out at half the
      // size of the same figure exported as a PDF, in the same column - and
      // `::resolution` would silently do nothing for images.
      const header = readPngHeader(source.bytes);
      return { page: { png: source.bytes, width: header.width, height: header.height, dpi: spec.resolution } };
    } catch (error) {
      return {
        issue: {
          kind: 'render-failed',
          headline: 'This PNG could not be read',
          details: [path.basename(spec.path)],
          cause: messageOf(error),
        },
      };
    }
  }

  const renderer = options.tools?.renderer;
  if (renderer === undefined) {
    return {
      issue: {
        kind: 'no-renderer',
        headline: 'No PDF renderer available',
        details: ['This build of the extension cannot rasterise PDF pages yet.'],
      },
    };
  }

  try {
    const page = await renderer.renderPage({ pdf: source.bytes, page: spec.page, dpi: spec.resolution });
    return { page: { ...page, dpi: page.dpi ?? spec.resolution } };
  } catch (error) {
    return {
      issue: {
        kind: 'render-failed',
        headline: `Page ${spec.page} could not be rendered`,
        details: [path.basename(spec.path), `${renderer.name} reported a problem.`],
        cause: messageOf(error),
      },
    };
  }
}

// ------------------------------------------------------------------------- //
// Results
// ------------------------------------------------------------------------- //

/**
 * The bytes that go into the workbook.
 *
 * The whole reason this is not simply decode-crop-encode: for a cell with no
 * crop — which is most of them — the renderer's PNG is already the answer, and
 * the only thing that needs changing is the resolution recorded in it. That is
 * a nine-byte chunk. Decoding and re-encoding a page-sized image to achieve
 * the same thing costs about two hundred milliseconds, every page, every time.
 */
function place(page: RenderedPage, spec: PlotSpec, dpi: number): { png: Buffer; width: number; height: number } {
  const untouched = spec.xmin <= 0 && spec.ymin <= 0 && spec.xmax >= 100 && spec.ymax >= 100;

  if (untouched) {
    return { png: retagPngDpi(page.png, dpi), width: page.width, height: page.height };
  }

  const cropped = cropImage(decodePng(page.png), spec);
  return { png: encodePng(cropped, { dpi }), width: cropped.width, height: cropped.height };
}

function measured(
  png: Buffer,
  widthPx: number,
  heightPx: number,
  dpi: number,
  extra: { cachePath?: string; fromCache: boolean; elapsedMs: number; issue?: PipelineIssue },
): RenderedPlot {
  return {
    png,
    widthPx,
    heightPx,
    dpi,
    widthCm: pixelsToCm(widthPx, dpi),
    heightCm: pixelsToCm(heightPx, dpi),
    ...extra,
  };
}

const PLACEHOLDER_KINDS: Record<IssueKind, PlaceholderKind> = {
  'missing-file': 'missing-file',
  'missing-revision': 'missing-file',
  'no-renderer': 'missing-tool',
  'no-converter': 'missing-tool',
  'no-revision-reader': 'missing-tool',
  'render-failed': 'error',
  'convert-failed': 'error',
  unsupported: 'error',
};

/**
 * Placeholders are never written to the cache.
 *
 * The reason a cell failed is usually a fact about the machine rather than
 * about the plot — no converter installed, git not on the path. Caching that
 * would mean the workbook still showed "install LibreOffice" the day after
 * LibreOffice was installed.
 */
function placeholder(spec: PlotSpec, startedAt: number, issue: PipelineIssue): RenderedPlot {
  const dpi = spec.resolution;
  const widthPx = Math.min(PLACEHOLDER_MAX_PX, Math.round((PLACEHOLDER_WIDTH_CM / 2.54) * dpi));
  const heightPx = Math.round(widthPx * (PLACEHOLDER_HEIGHT_CM / PLACEHOLDER_WIDTH_CM));

  const image = placeholderImage({
    kind: PLACEHOLDER_KINDS[issue.kind],
    headline: issue.headline,
    details: issue.details,
    widthPx,
    heightPx,
    dpi,
  });

  return measured(encodePng(image, { dpi }), widthPx, heightPx, dpi, {
    fromCache: false,
    elapsedMs: Date.now() - startedAt,
    issue,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Exposed for the cache-size report and for tests. */
export async function cacheEntrySize(filePath: string): Promise<number> {
  return (await statOrUndefined(filePath))?.size ?? 0;
}
