import { DEFAULT_TEXT_STYLE, isStyleReference, resolveStyle } from '../styles.ts';
import type { TextSpec } from '../types.ts';

/**
 * Parse `some text::style` into a {@link TextSpec}.
 *
 * The style is taken from the last `::` segment, and only when that segment is
 * actually a style name or number. R took the *second* segment unconditionally,
 * so a description containing `::` silently lost everything after it — the
 * failure this rule removes. Text with no recognisable trailing style is kept
 * whole and gets the default style.
 */
export function parseTextSpec(raw: string): TextSpec {
  const lastSeparator = raw.lastIndexOf('::');

  if (lastSeparator === -1) {
    return { text: raw, style: DEFAULT_TEXT_STYLE };
  }

  const candidate = raw.slice(lastSeparator + 2).trim();
  if (!isStyleReference(candidate)) {
    return { text: raw, style: DEFAULT_TEXT_STYLE };
  }

  return { text: raw.slice(0, lastSeparator), style: resolveStyle(candidate) };
}
