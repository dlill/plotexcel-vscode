/** Minimal helpers for hand-writing the XML parts of an .xlsx. */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Escape text for an XML node or attribute.
 *
 * Control characters are dropped rather than escaped: XML 1.0 cannot carry
 * them at all, and a stray form feed in a plot caption should not produce a
 * workbook Excel refuses to open.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/**
 * Join an XML document and return it as UTF-8 bytes.
 *
 * `TextEncoder` rather than `Buffer` deliberately: everything that builds the
 * parts of a workbook is then free of Node, which is what lets the same code
 * produce a workbook in a browser.
 */
export function xmlDocument(...parts: string[]): Uint8Array {
  return new TextEncoder().encode(`${XML_DECLARATION}\n${parts.join('')}`);
}

/**
 * Spreadsheet column name for a 1-based index: 1 is A, 27 is AA.
 */
export function columnName(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`Column index must be 1 or more, got ${index}.`);
  }

  let remaining = index;
  let name = '';

  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return name;
}

/** A1-style reference for a 1-based row and column. */
export function cellReference(row: number, column: number): string {
  return `${columnName(column)}${row}`;
}
