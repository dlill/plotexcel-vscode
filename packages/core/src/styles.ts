/**
 * The named cell styles, ported 1:1 from `styleList` in R/plotExcel.R.
 *
 * Order matters: layout files may refer to a style by its 1-based index, which
 * is how the R package's `availableStyles()` numbers them. Keep additions at
 * the end so existing numbers keep meaning the same thing.
 */

export type HorizontalAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

export interface CellStyle {
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly wrapText?: boolean;
  readonly horizontal?: HorizontalAlign;
  readonly vertical?: VerticalAlign;
  /** Degrees, positive is counter-clockwise, as in Excel. */
  readonly textRotation?: number;
}

/**
 * R's `valign = "center"` and `halign = "center"` map to ExcelJS's
 * `vertical: 'middle'` / `horizontal: 'center'`.
 */
export const STYLES: Readonly<Record<string, CellStyle>> = {
  left: { fontSize: 18, bold: true, wrapText: true },
  center: { fontSize: 18, bold: true, wrapText: true, horizontal: 'center' },
  vcenter: { fontSize: 18, bold: true, wrapText: true, vertical: 'middle' },
  hvcenter: { fontSize: 18, bold: true, wrapText: true, horizontal: 'center', vertical: 'middle' },
  rotateUp: { fontSize: 18, bold: true, wrapText: true, horizontal: 'right', vertical: 'middle', textRotation: 90 },
  rotateDown: { fontSize: 18, bold: true, wrapText: true, horizontal: 'left', vertical: 'middle', textRotation: -90 },
  leftSize48: { fontSize: 48, bold: true, wrapText: true },
  centerSize48: { fontSize: 48, bold: true, wrapText: true, horizontal: 'center' },
  vcenterSize48: { fontSize: 48, bold: true, wrapText: true, vertical: 'middle' },
  plain: {},
};

/** Style names in their documented order; the index + 1 is the numeric alias. */
export const STYLE_NAMES: readonly string[] = Object.keys(STYLES);

/** The style a text cell gets when it carries no `::style` decorator. */
export const DEFAULT_TEXT_STYLE = 'left';

/** The style the generated header row gets unless the layout overrides it. */
export const DEFAULT_HEADER_STYLE = 'center';

/** True if `name` is a style name or a valid 1-based style number. */
export function isStyleReference(name: string): boolean {
  if (Object.hasOwn(STYLES, name)) return true;
  const index = Number(name);
  return Number.isInteger(index) && index >= 1 && index <= STYLE_NAMES.length;
}

/**
 * Resolve a style name or 1-based index to a style name.
 * Throws a message that lists the alternatives, since this is user input.
 */
export function resolveStyle(reference: string): string {
  if (Object.hasOwn(STYLES, reference)) return reference;

  const index = Number(reference);
  if (Number.isInteger(index) && index >= 1 && index <= STYLE_NAMES.length) {
    return STYLE_NAMES[index - 1]!;
  }

  throw new Error(
    `Unknown text style "${reference}". Available styles: ` +
      STYLE_NAMES.map((name, i) => `${i + 1} ${name}`).join(', '),
  );
}
