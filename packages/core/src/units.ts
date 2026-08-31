/**
 * Unit conversions between centimetres, points, pixels and Excel's own units.
 *
 * The two magic numbers below are lifted from the R package, where they were
 * tuned against openxlsx's output. ExcelJS may need different ones — measuring
 * them against a reference workbook is the P0 spike, and it is the single most
 * likely reason a ported workbook looks subtly wrong. Everything that needs
 * them goes through this module so there is exactly one place to correct.
 */

export const CM_PER_INCH = 2.54;
export const POINTS_PER_INCH = 72;

/** Excel positions and sizes images in pixels at a nominal 96 dpi. */
export const EXCEL_IMAGE_DPI = 96;

/**
 * Excel column widths are measured in characters of the default font, not in
 * length. R multiplies centimetres by this to get openxlsx's width.
 * @see verify in P0 against a reference workbook
 */
export const COLUMN_WIDTH_PER_CM = 5.3;

/**
 * R adds 5% to row heights so a row is never a hair shorter than its image,
 * which would clip it.
 * @see verify in P0
 */
export const ROW_HEIGHT_SLACK = 1.05;

/** Physical size of a rasterised image, from its pixel size and the dpi it was rendered at. */
export function pixelsToCm(pixels: number, dpi: number): number {
  return (pixels / dpi) * CM_PER_INCH;
}

export function cmToPixels(cm: number, dpi: number): number {
  return (cm / CM_PER_INCH) * dpi;
}

/** Image extent for ExcelJS, which wants pixels at 96 dpi. */
export function cmToImagePixels(cm: number): number {
  return cmToPixels(cm, EXCEL_IMAGE_DPI);
}

/** Column width in Excel's character units. */
export function cmToColumnWidth(cm: number): number {
  return cm * COLUMN_WIDTH_PER_CM;
}

/** Row height in points, with R's 5% slack. */
export function cmToRowHeight(cm: number): number {
  return (cm / CM_PER_INCH) * POINTS_PER_INCH * ROW_HEIGHT_SLACK;
}

/** An image already placed on the sheet, with its physical size. */
export interface PlacedImage {
  /** 1-based row. */
  readonly row: number;
  /** 1-based column. */
  readonly column: number;
  readonly widthCm: number;
  readonly heightCm: number;
}

export interface GeometryOptions {
  /** Width given to a column that holds no images. R's `textColWidth`, in cm. */
  readonly textColumnWidthCm?: number;
  /** Height given to a row that holds no images, in cm. */
  readonly textRowHeightCm?: number;
}

export interface SheetGeometry {
  /** Column index (1-based) to width in Excel character units. */
  readonly columnWidths: ReadonlyMap<number, number>;
  /** Row index (1-based) to height in points. */
  readonly rowHeights: ReadonlyMap<number, number>;
  /** The same, in centimetres, for tests and for the geometry report. */
  readonly columnWidthsCm: ReadonlyMap<number, number>;
  readonly rowHeightsCm: ReadonlyMap<number, number>;
}

/**
 * Size every column and row to its largest image, exactly as R does: the
 * widest image in a column sets that column's width, the tallest image in a
 * row sets that row's height, and anything with no image falls back to the
 * text defaults.
 */
export function computeGeometry(
  images: readonly PlacedImage[],
  extent: { readonly columns: readonly number[]; readonly rows: readonly number[] },
  options: GeometryOptions = {},
): SheetGeometry {
  const textColumnWidthCm = options.textColumnWidthCm ?? 5;
  const textRowHeightCm = options.textRowHeightCm ?? 2;

  const widestByColumn = new Map<number, number>();
  const tallestByRow = new Map<number, number>();

  for (const image of images) {
    widestByColumn.set(image.column, Math.max(widestByColumn.get(image.column) ?? 0, image.widthCm));
    tallestByRow.set(image.row, Math.max(tallestByRow.get(image.row) ?? 0, image.heightCm));
  }

  const columnWidthsCm = new Map<number, number>();
  const columnWidths = new Map<number, number>();
  for (const column of extent.columns) {
    const cm = widestByColumn.get(column) ?? textColumnWidthCm;
    columnWidthsCm.set(column, cm);
    columnWidths.set(column, cmToColumnWidth(cm));
  }

  const rowHeightsCm = new Map<number, number>();
  const rowHeights = new Map<number, number>();
  for (const row of extent.rows) {
    const cm = tallestByRow.get(row) ?? textRowHeightCm;
    rowHeightsCm.set(row, cm);
    rowHeights.set(row, cmToRowHeight(cm));
  }

  return { columnWidths, rowHeights, columnWidthsCm, rowHeightsCm };
}
