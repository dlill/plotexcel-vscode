import { countPages, countPdfPages, type PageCount } from '../documents/pageCount.ts';
import { plotExtensionOf } from '../spec/classify.ts';
import { PLOT_SPEC_DEFAULTS, type PlotSpec } from '../types.ts';
import { convertToPdfCached, NoConverterError, type ConvertOptions } from './convert.ts';
import { readFileOrUndefined } from './files.ts';

/**
 * How many pages a plot really has, converting it when that is the only way.
 *
 * `countPages` reads a file's own structure, which is exact for a PDF, a PNG
 * and a PowerPoint deck, and cannot work at all for HTML: an HTML page has no
 * pages until a browser lays it out. It answered 1, honestly labelled as an
 * estimate — and every layout generated from a folder of HTML plots therefore
 * asked for page 1 and nothing else. The pages rendered perfectly; the layout
 * never requested them.
 *
 * So when the structural count is only an estimate, convert and count for real.
 * The conversion goes through the pipeline's cache, which is what makes this
 * affordable: the PDF produced to count the pages is the same PDF, at the same
 * cache path, that the render will want moments later. Counting now makes the
 * render cheaper rather than more expensive.
 */

export type SourcePagesOptions = ConvertOptions;

export async function countSourcePages(filePath: string, options: SourcePagesOptions = {}): Promise<PageCount> {
  const structural = safely(filePath);

  // Exact is exact — a PDF's page tree and a .pptx's slide parts are not worth
  // second-guessing, and converting them would be pure cost.
  if (structural.confidence === 'exact') return structural;

  const extension = plotExtensionOf(filePath);
  if (extension === undefined) return structural;

  const bytes = await readFileOrUndefined(filePath);
  if (bytes === undefined) return structural;

  const spec: PlotSpec = { ...PLOT_SPEC_DEFAULTS, path: filePath };

  try {
    const converted = await convertToPdfCached(spec, bytes, extension, options);

    // Unconverted formats come back as themselves; only a PDF can be counted.
    if (converted.extension !== 'pdf') return structural;

    const counted = countPdfPages(converted.bytes);
    return counted.confidence === 'exact' ? counted : structural;
  } catch (error) {
    if (error instanceof NoConverterError) {
      return {
        ...structural,
        reason: `Counting the pages of a .${extension} file needs a converter, which was not found.`,
      };
    }

    // A file that cannot be converted still belongs in the layout, as one row
    // that will render a placeholder saying why.
    return structural;
  }
}

function safely(filePath: string): PageCount {
  try {
    return countPages(filePath);
  } catch (error) {
    return {
      pages: 1,
      confidence: 'estimated',
      reason: `Could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
