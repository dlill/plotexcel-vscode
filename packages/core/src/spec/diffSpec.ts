import { SpecError, type DiffSpec } from '../types.ts';

/** The same separator a plot cell uses, so there is one thing to learn. */
const DECORATOR_SEPARATOR = '::';

const DIFF_PREFIX = /^\s*diff\s*\(/i;

/** True when a cell asks for an image diff of two other columns in its row. */
export function isDiffCell(raw: string): boolean {
  return DIFF_PREFIX.test(raw);
}

/**
 * Parse `diff(Current, Baseline)` into the two column names it references.
 *
 * Column names may be wrapped in backticks, which is how a name containing a
 * comma or a space is written: ``diff(`Plots 1`, `Plots 2`)``. R parsed this by
 * handing the string to the R parser and pulling out SYMBOL tokens; a small
 * scanner does the same job without depending on a language runtime.
 */
export function parseDiffSpec(raw: string): DiffSpec {
  const match = DIFF_PREFIX.exec(raw);
  if (!match) {
    throw new SpecError(`Not a diff cell: "${raw}".`, { hint: 'A diff cell looks like diff(Column A, Column B).' });
  }

  const open = match[0].length;
  // Neither the first `)` nor the last will do. A backticked column name may
  // contain one — diff(`Run (a)`, `Run (b)`) — and a decorator after the call
  // may too, so the bracket has to be found by walking the string.
  const close = findClose(raw, open);
  if (close < open) {
    throw new SpecError('A diff cell is missing its closing bracket.', {
      value: raw,
      hint: 'Write it as diff(Column A, Column B).',
    });
  }

  const names = splitTopLevel(raw.slice(open, close)).map(unquote);
  if (names.length !== 2 || names.some((name) => name.length === 0)) {
    throw new SpecError(`A diff cell needs exactly two column names, found ${names.length}.`, {
      value: raw,
      hint: 'Write it as diff(Column A, Column B). Use backticks around a name that contains a comma.',
    });
  }

  return { column1: names[0]!, column2: names[1]!, ...decorators(raw.slice(close + 1), raw) };
}

/**
 * `::tolerance 0.2` and `::context off`, after the closing bracket.
 *
 * The same `::` shape as a plot cell, so there is one thing to learn rather
 * than two. Anything else after the bracket is a mistake worth naming: a
 * misspelt decorator that is quietly ignored is a comparison that looks
 * right and is not.
 */
function decorators(tail: string, whole: string): { tolerance?: number; context?: boolean } {
  const out: { tolerance?: number; context?: boolean } = {};
  const trimmed = tail.trim();
  if (trimmed === '') return out;

  if (!trimmed.startsWith(DECORATOR_SEPARATOR)) {
    throw new SpecError(`A diff cell has "${trimmed}" after its closing bracket.`, {
      value: whole,
      hint: 'Write decorators as diff(A, B)::tolerance 0.2.',
    });
  }

  for (const part of trimmed.slice(DECORATOR_SEPARATOR.length).split(DECORATOR_SEPARATOR)) {
    const [key = '', ...words] = part.trim().split(/\s+/);
    const value = words.join(' ');

    if (key === 'tolerance') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new SpecError(`"${value}" is not a tolerance.`, {
          value: whole,
          hint: 'Tolerance is between 0 and 1. 0.1 is the default; 0.3 ignores anti-aliasing.',
        });
      }
      out.tolerance = parsed;
      continue;
    }

    if (key === 'context') {
      if (value !== 'on' && value !== 'off') {
        throw new SpecError(`"${value}" is not on or off.`, {
          value: whole,
          hint: 'Write ::context off to drop the faded background and show only what changed.',
        });
      }
      out.context = value === 'on';
      continue;
    }

    throw new SpecError(`A diff cell has no "${key}" option.`, {
      value: whole,
      hint: 'A diff cell takes ::tolerance and ::context.',
    });
  }

  return out;
}

/** Split on commas that are not inside backticks or quotes. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let fence: string | undefined;

  for (const char of inner) {
    if (fence !== undefined) {
      if (char === fence) fence = undefined;
      else current += char;
      continue;
    }
    if (char === '`' || char === '"' || char === "'") {
      fence = char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map((part) => part.trim());
}

/** The `)` that closes the call, ignoring any inside backticks or quotes. */
function findClose(raw: string, open: number): number {
  let fence: string | undefined;

  for (let index = open; index < raw.length; index += 1) {
    const char = raw[index]!;

    if (fence !== undefined) {
      if (char === fence) fence = undefined;
      continue;
    }

    if (char === '`' || char === '"' || char === "'") {
      fence = char;
      continue;
    }

    if (char === ')') return index;
  }

  return -1;
}

function unquote(name: string): string {
  return name.replace(/^[`"']|[`"']$/g, '').trim();
}
