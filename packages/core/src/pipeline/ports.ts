

/**
 * The three things the pipeline cannot do by itself.
 *
 * Everything else in this package is pure computation over bytes. Rendering a
 * PDF page, converting an Office document and reading a file out of git all
 * need something outside the process, so each is an interface with a name.
 * That is what makes "this machine has no LibreOffice" an ordinary state the
 * pipeline reports rather than an exception it dies on — and what lets the
 * tests run the whole pipeline with stand-ins.
 */

/**
 * One rasterised page, as PNG bytes plus the two numbers describing them.
 *
 * Bytes rather than pixels, because a renderer produces a PNG and the pipeline
 * usually wants to store one. Decoding to pixels and encoding them again is
 * two hundred milliseconds a page, and for an uncropped cell it changes
 * nothing — so the pipeline decodes only when there is a crop to apply.
 */
export interface RenderedPage {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  /** Resolution the page was rendered at. */
  readonly dpi: number;
}

export interface PdfRenderer {
  /** Shown to the user when a render fails: "MuPDF could not read page 3". */
  readonly name: string;
  renderPage(input: { readonly pdf: Buffer; readonly page: number; readonly dpi: number }): Promise<RenderedPage>;
}

export type PageSize = 'single' | 'A4';

export interface DocumentConverter {
  readonly name: string;
  /** True when this converter handles the given lower-case extension. */
  canConvert(extension: string): boolean;
  toPdf(input: {
    readonly bytes: Buffer;
    readonly extension: string;
    readonly pageSize?: PageSize;
    /** Some converters need a real file; this is a directory they may use. */
    readonly scratchDir?: string;
  }): Promise<Buffer>;
}

export interface RevisionReader {
  readonly name: string;
  /**
   * The contents of `path` at `revision`, or undefined when the file did not
   * exist there — which is a normal answer, not a failure: a plot added last
   * week has no version in last month's commit.
   */
  read(input: { readonly path: string; readonly revision: string }): Promise<Buffer | undefined>;
  /** True when the path is inside a repository this reader can serve. */
  isTracked(path: string): Promise<boolean>;
}

/** Whatever this machine turned out to have. Every field is optional. */
export interface Tools {
  readonly renderer?: PdfRenderer | undefined;
  readonly converter?: DocumentConverter | undefined;
  readonly revisions?: RevisionReader | undefined;
}
