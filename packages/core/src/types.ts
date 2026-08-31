/**
 * Shared types for the plotExcel core.
 *
 * The core never imports `vscode` and never touches the network. Everything in
 * this package is either a pure function or takes an explicit filesystem-like
 * dependency, so it can be unit tested in plain Node.
 */

/** Input formats a plot cell may point at. */
export const SUPPORTED_PLOT_EXTENSIONS = [
  'pdf',
  'png',
  'docx',
  'pptx',
  'xlsx',
  'html',
  'htm',
] as const;

export type PlotExtension = (typeof SUPPORTED_PLOT_EXTENSIONS)[number];

/**
 * Formats that must be converted to PDF before a page can be rasterised.
 * `pdf` and `png` pass through the convert stage untouched.
 */
export const EXTERNAL_EXTENSIONS = ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xlsm', 'xls', 'html', 'htm'] as const;

/** A fully resolved plot cell: a file, a revision, a page, a crop, a resolution. */
export interface PlotSpec {
  /** Path exactly as written in the layout file. Resolve with `resolvePlotPath`. */
  readonly path: string;
  /** Git revision to read the file at. `HEAD` means the working-tree copy. */
  readonly commit: string;
  /** 1-based page (or slide) number. */
  readonly page: number;
  /** Crop window in percent of the rendered page, 0–100. */
  readonly xmin: number;
  readonly xmax: number;
  readonly ymin: number;
  readonly ymax: number;
  /** Rasterisation resolution in dpi. */
  readonly resolution: number;
}

/** Defaults applied to any decorator key a plot cell leaves out. */
export const PLOT_SPEC_DEFAULTS: Omit<PlotSpec, 'path'> = {
  commit: 'HEAD',
  page: 1,
  xmin: 0,
  xmax: 100,
  ymin: 0,
  ymax: 100,
  resolution: 100,
};

/** A text cell: content plus one of the named styles. */
export interface TextSpec {
  readonly text: string;
  readonly style: string;
}

/** A diff cell: the two columns of the same row whose images are compared. */
export interface DiffSpec {
  readonly column1: string;
  readonly column2: string;
  /**
   * How different two pixels must be before they count as changed, 0 to 1.
   * Anti-aliasing and font hinting move pixels slightly between two renders of
   * the same figure; raising this is how a comparison stops reporting them.
   */
  readonly tolerance?: number | undefined;
  /** Whether unchanged content is kept, faded, behind the marks. */
  readonly context?: boolean | undefined;
}

/**
 * What a layout cell turned out to be.
 *
 * Unlike the R package — which decides by calling `file.exists()`, and so
 * behaves differently on different machines — classification here is a pure
 * function of the cell text. A path that does not exist is still a plot cell;
 * it fails later, visibly, with a placeholder.
 */
export type Cell =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly spec: TextSpec }
  | { readonly kind: 'plot'; readonly spec: PlotSpec }
  | { readonly kind: 'diff'; readonly spec: DiffSpec };

/** Raised for anything the user can fix by editing their layout file. */
export class SpecError extends Error {
  /** The cell text that could not be understood, and how to fix it. */
  readonly detail: { readonly value?: string; readonly hint?: string } | undefined;

  constructor(message: string, detail?: { readonly value?: string; readonly hint?: string }) {
    super(message);
    this.name = 'SpecError';
    this.detail = detail;
  }
}

/** Severity of a layout-file diagnostic. */
export type Severity = 'error' | 'warning';

/** A problem found while reading a layout file, addressed to the person editing it. */
export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  /** 1-based line in the layout file. */
  readonly line: number;
  /** 1-based column index within the row, when the problem is one cell. */
  readonly column?: number;
}
