import { PLOT_DECORATOR_KEYS, type PlotDecoratorKey } from '../spec/plotSpec.ts';

/**
 * Editing one cell's decorators, as text.
 *
 * Several commands change exactly one option in a cell and must leave the rest
 * of it alone — a crop tool writes four numbers, "one row per page" writes a
 * page number, changing the resolution of a layout strips a stale one. Doing
 * that by re-serialising a parsed spec would rewrite the whole cell, including
 * the parts the person typed and the order they typed them in.
 *
 * So it is done here, on the string, keeping everything that was not asked
 * about exactly where it was.
 */

export interface CropWindowPercent {
  readonly xmin: number;
  readonly xmax: number;
  readonly ymin: number;
  readonly ymax: number;
}

/** Set a decorator, replacing it in place if it is already there. */
export function setOption(cell: string, key: PlotDecoratorKey, value: string | number): string {
  const segments = cell.split('::');
  const at = segments.findIndex((segment, index) => index > 0 && keyOf(segment) === key);
  const written = `${key} ${value}`;

  if (at === -1) return [...segments, written].join('::');

  return segments.map((segment, index) => (index === at ? written : segment)).join('::');
}

/** Remove a decorator if it is present. */
export function removeOption(cell: string, key: PlotDecoratorKey): string {
  return cell
    .split('::')
    .filter((segment, index) => index === 0 || keyOf(segment) !== key)
    .join('::');
}

/** What a decorator is set to, or undefined when the cell does not say. */
export function readOption(cell: string, key: PlotDecoratorKey): string | undefined {
  const found = cell
    .split('::')
    .slice(1)
    .find((segment) => keyOf(segment) === key);

  return found === undefined ? undefined : found.trim().slice(key.length).trim();
}

/**
 * Apply a crop window, or clear it when the window is the whole page.
 *
 * A full-page crop is written as no crop at all rather than as four numbers
 * that happen to mean nothing: `plot.pdf` says what it means, and
 * `plot.pdf::xmin 0::xmax 100::ymin 0::ymax 100` makes a reader look twice.
 */
export function setCrop(cell: string, crop: CropWindowPercent): string {
  const cleared = (['xmin', 'xmax', 'ymin', 'ymax'] as const).reduce(
    (text, key) => removeOption(text, key),
    cell,
  );

  const whole = crop.xmin <= 0 && crop.xmax >= 100 && crop.ymin <= 0 && crop.ymax >= 100;
  if (whole) return cleared;

  // Only the bounds that actually cut something are written, so a crop of the
  // left edge alone stays one option rather than four.
  const parts: string[] = [];
  if (crop.xmin > 0) parts.push(`xmin ${round(crop.xmin)}`);
  if (crop.xmax < 100) parts.push(`xmax ${round(crop.xmax)}`);
  if (crop.ymin > 0) parts.push(`ymin ${round(crop.ymin)}`);
  if (crop.ymax < 100) parts.push(`ymax ${round(crop.ymax)}`);

  return [cleared, ...parts].join('::');
}

/** The page a cell asks for, defaulting to the first. */
export function readPage(cell: string): number {
  const written = readOption(cell, 'page');
  const page = Number(written);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

/** Keep a generated ", page N" caption in step with the page it describes. */
export function renumberCaption(description: string, page: number): string {
  return description.replace(/, page \d+/, `, page ${page}`);
}

function keyOf(segment: string): string | undefined {
  const trimmed = segment.trim();
  const space = trimmed.search(/\s/);
  const key = space === -1 ? trimmed : trimmed.slice(0, space);

  return (PLOT_DECORATOR_KEYS as readonly string[]).includes(key) ? key : undefined;
}

function round(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
