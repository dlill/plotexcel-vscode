/**
 * Counting the pages of a PDF from its text, with nothing else.
 *
 * The page tree of a PDF written by R, matplotlib or a TeX engine sits in the
 * file in the clear, so counting its pages is a search rather than a parse.
 * That matters twice over: it is fast enough to run over a folder of hundreds
 * of files, and it needs no zlib, no filesystem and no platform — so the same
 * code answers the question inside a browser.
 */

export interface PageCount {
  readonly pages: number;
  /** `exact` when the file states it; `estimated` when it had to be inferred. */
  readonly confidence: 'exact' | 'estimated';
  /** Why the count is an estimate, phrased for the person who has to act on it. */
  readonly reason?: string;
}

const PAGES_NODE = /\/Type\s*\/Pages\b/g;
const COUNT_ENTRY = /\/Count\s+(\d+)/;
const PAGE_NODE = /\/Type\s*\/Page[^s]/g;

/**
 * The part of PDF page counting that needs nothing but the file as text.
 *
 * Pass the bytes decoded as latin1, so that every byte is one character.
 */
export function countPdfPagesInText(text: string): PageCount {
  const direct = largestPageTreeCount(text);
  if (direct !== undefined) return { pages: direct, confidence: 'exact' };

  const leaves = countMatches(text, PAGE_NODE);
  if (leaves > 0) {
    return {
      pages: leaves,
      confidence: 'estimated',
      reason: 'This PDF has no page tree, so its pages were counted one by one.',
    };
  }

  return {
    pages: 1,
    confidence: 'estimated',
    reason: 'This PDF could not be read as a page tree. It may be damaged or encrypted.',
  };
}

/** The largest `/Count` belonging to a page-tree node, which is the root's. */
export function largestPageTreeCount(text: string): number | undefined {
  let best: number | undefined;
  PAGES_NODE.lastIndex = 0;

  for (let match = PAGES_NODE.exec(text); match !== null; match = PAGES_NODE.exec(text)) {
    // The /Count entry belongs to the same dictionary, so it sits close by on
    // either side of the /Type entry depending on how the writer ordered keys.
    const window = text.slice(Math.max(0, match.index - 400), match.index + 400);
    const count = COUNT_ENTRY.exec(window);
    if (count === null) continue;

    const value = Number(count[1]);
    if (Number.isFinite(value) && value > 0 && (best === undefined || value > best)) best = value;
  }

  return best;
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}
