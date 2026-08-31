import { SUPPORTED_PLOT_EXTENSIONS, type Cell, type PlotSpec } from '../types.ts';
import { isDiffCell, parseDiffSpec } from './diffSpec.ts';
import { parsePlotSpec, type ParsePlotSpecOptions } from './plotSpec.ts';
import { parseTextSpec } from './textSpec.ts';

/**
 * Decide what a layout cell is, from its text alone.
 *
 * Order matters: a diff cell is recognised first, then a plot cell by its file
 * extension, and everything else is text. Because nothing here touches the
 * filesystem, the same layout classifies identically on every machine — the R
 * package used `file.exists()` here, so a missing file silently became a text
 * cell containing a path.
 */
export function classifyCell(raw: string, options: ParsePlotSpecOptions = {}): Cell {
  const trimmed = raw.trim();

  if (trimmed.length === 0) return { kind: 'empty' };
  if (isDiffCell(trimmed)) return { kind: 'diff', spec: parseDiffSpec(trimmed) };
  if (looksLikePlotPath(trimmed)) return { kind: 'plot', spec: parsePlotSpec(trimmed, options) };

  return { kind: 'text', spec: parseTextSpec(raw) };
}

/** True when the first `::` segment ends in a supported plot extension. */
export function looksLikePlotPath(raw: string): boolean {
  return plotExtensionOf(raw) !== undefined;
}

/**
 * The lower-cased extension of a cell's path, if it is one we can render.
 *
 * Deliberately strict: the extension is the text after the last dot of the last
 * path segment, and must contain no whitespace. That keeps a sentence like
 * "see results.pdf below" classified as text rather than as a broken plot.
 */
export function plotExtensionOf(raw: string): string | undefined {
  const path = raw.split('::', 1)[0]!.trim();
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;

  const extension = base.slice(dot + 1).toLowerCase();
  if (/\s/.test(extension)) return undefined;

  return (SUPPORTED_PLOT_EXTENSIONS as readonly string[]).includes(extension) ? extension : undefined;
}

/** The extension the convert stage will produce for this spec's input. */
export function convertedExtension(spec: PlotSpec): string {
  const extension = plotExtensionOf(spec.path);
  if (extension === undefined) return 'pdf';
  return extension === 'pdf' || extension === 'png' ? extension : 'pdf';
}
