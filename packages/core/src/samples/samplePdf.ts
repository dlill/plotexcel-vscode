/**
 * A small, real PDF, written by hand.
 *
 * The sample project needs plots, and plots that ship as fixtures are plots
 * someone has to keep. Generating them means the sample is always consistent
 * with whatever the extension currently does — and, more usefully, it means
 * opening the sample exercises the actual PDF path: a converter, a
 * rasteriser, page extraction, the lot. A sample made of PNGs would prove
 * nothing about the part most likely to be missing on a given machine.
 *
 * PDF is a simple enough container to write directly. Objects go in order,
 * their byte offsets are recorded as they are written, and the table at the
 * end points back at them.
 */

export interface SamplePage {
  readonly title: string;
  readonly subtitle: string;
  /** Values in 0..1, drawn as a line or as bars. */
  readonly series: readonly number[];
  readonly kind: 'line' | 'bars';
}

export interface SamplePdfOptions {
  readonly pages: readonly SamplePage[];
  /** Page size in points. A4 landscape by default, which suits a plot. */
  readonly width?: number;
  readonly height?: number;
}

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 300;

/** Build a complete, valid PDF containing one drawn chart per page. */
export function samplePdf(options: SamplePdfOptions): Uint8Array {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const pages = options.pages;

  if (pages.length === 0) throw new Error('A PDF needs at least one page.');

  // Object numbering: 1 catalog, 2 page tree, 3 font, then two objects per
  // page — the page itself and its content stream.
  const firstPageObject = 4;
  const pageObjectNumbers = pages.map((_, index) => firstPageObject + index * 2);

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  for (const [index, page] of pages.entries()) {
    const stream = contentStream(page, width, height);
    const contentNumber = pageObjectNumbers[index]! + 1;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`,
      `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }

  return assemble(objects);
}

// ------------------------------------------------------------------------- //
// Drawing
// ------------------------------------------------------------------------- //

function contentStream(page: SamplePage, width: number, height: number): string {
  const margin = 46;
  const plotLeft = margin;
  const plotRight = width - margin;
  const plotBottom = margin;
  const plotTop = height - margin - 34;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotTop - plotBottom;

  const out: string[] = [];

  // Paper.
  out.push('q', '1 1 1 rg', `0 0 ${width} ${height} re`, 'f', 'Q');

  // Title and subtitle, in the one font the file carries.
  out.push(
    'q',
    '0.09 0.11 0.09 rg',
    'BT',
    '/F1 15 Tf',
    `${margin} ${height - margin + 4} Td`,
    `(${escapeText(page.title)}) Tj`,
    'ET',
    '0.36 0.39 0.36 rg',
    'BT',
    '/F1 9 Tf',
    `${margin} ${height - margin - 12} Td`,
    `(${escapeText(page.subtitle)}) Tj`,
    'ET',
    'Q',
  );

  // Axes.
  out.push(
    'q',
    '0.72 0.75 0.71 RG',
    '1 w',
    `${plotLeft} ${plotTop} m ${plotLeft} ${plotBottom} l ${plotRight} ${plotBottom} l`,
    'S',
    'Q',
  );

  // Gridlines, faint, so the plot has some depth when rasterised.
  out.push('q', '0.90 0.92 0.89 RG', '0.6 w');
  for (let step = 1; step <= 3; step++) {
    const y = plotBottom + (plotHeight * step) / 4;
    out.push(`${plotLeft} ${y.toFixed(2)} m ${plotRight} ${y.toFixed(2)} l`, 'S');
  }
  out.push('Q');

  const points = page.series.map((value, index) => ({
    x: plotLeft + (plotWidth * index) / Math.max(1, page.series.length - 1),
    y: plotBottom + plotHeight * clamp(value),
  }));

  if (page.kind === 'line') {
    out.push('q', '0.12 0.44 0.32 RG', '2 w', '1 J', '1 j');
    out.push(points.map((point, index) => `${point.x.toFixed(2)} ${point.y.toFixed(2)} ${index === 0 ? 'm' : 'l'}`).join(' '));
    out.push('S', 'Q');

    // A marker on the highest point, so a crop of the right-hand side is
    // visibly different from a crop of the left.
    const peak = points.reduce((best, point) => (point.y > best.y ? point : best), points[0]!);
    out.push(
      'q',
      '0.78 0.48 0.18 rg',
      `${(peak.x - 3.5).toFixed(2)} ${(peak.y - 3.5).toFixed(2)} 7 7 re`,
      'f',
      'Q',
    );
  } else {
    const barWidth = (plotWidth / page.series.length) * 0.62;

    out.push('q');
    for (const [index, value] of page.series.entries()) {
      const x = plotLeft + (plotWidth * (index + 0.5)) / page.series.length - barWidth / 2;
      const barHeight = plotHeight * clamp(value);

      out.push(index === 3 ? '0.78 0.48 0.18 rg' : '0.12 0.44 0.32 rg');
      out.push(`${x.toFixed(2)} ${plotBottom.toFixed(2)} ${barWidth.toFixed(2)} ${barHeight.toFixed(2)} re`, 'f');
    }
    out.push('Q');
  }

  return out.join('\n');
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Parentheses and backslashes end a string literal early if left alone. */
function escapeText(value: string): string {
  return value.replace(/[\\()]/g, (character) => `\\${character}`);
}

// ------------------------------------------------------------------------- //
// The file around the objects
// ------------------------------------------------------------------------- //

function assemble(objects: readonly string[]): Uint8Array {
  const parts: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [];
  let offset = byteLength(parts[0]!);

  for (const [index, body] of objects.entries()) {
    const text = `${index + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(offset);
    parts.push(text);
    offset += byteLength(text);
  }

  const xrefStart = offset;
  const rows = [
    '0000000000 65535 f \n',
    ...offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`),
  ];

  parts.push(
    `xref\n0 ${objects.length + 1}\n${rows.join('')}`,
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return new TextEncoder().encode(parts.join(''));
}

/** The PDF's own offsets are in bytes, and the text here is not all ASCII. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
