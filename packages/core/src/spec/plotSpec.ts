import { PLOT_SPEC_DEFAULTS, SpecError, type PlotSpec } from '../types.ts';

/**
 * Decorator keys a plot cell may carry after its path.
 *
 * The R implementation matched these with `grep("^<key>")` over the `::`
 * segments, which prefix-matches and can pick up the wrong segment. Here the
 * key is the text up to the first space and must match exactly, so a value
 * containing a key name is never mistaken for a key.
 */
export const PLOT_DECORATOR_KEYS = ['commit', 'page', 'xmin', 'xmax', 'ymin', 'ymax', 'resolution'] as const;
export type PlotDecoratorKey = (typeof PLOT_DECORATOR_KEYS)[number];

/**
 * Every decorator but `commit` carries a number. Saying so in the type rather
 * than only in the array is what lets the defaults be read as numbers below:
 * `commit` is the one string among them, and a plain `PlotDecoratorKey[]`
 * drags it into every lookup.
 */
type NumericDecoratorKey = Exclude<PlotDecoratorKey, 'commit'>;

const NUMERIC_KEYS: readonly NumericDecoratorKey[] = ['page', 'xmin', 'xmax', 'ymin', 'ymax', 'resolution'];

export interface ParsePlotSpecOptions {
  /** Layout-level defaults, e.g. a `#resolution:` set for the whole file. */
  readonly defaults?: Partial<Omit<PlotSpec, 'path'>>;
}

/**
 * Parse `path::key value::key2 value2` into a {@link PlotSpec}.
 *
 * Windows paths are safe: the separator is a double colon, so `C:/plots/a.pdf`
 * and `C:\plots\a.pdf` both survive. A path may not itself contain `::`.
 */
export function parsePlotSpec(raw: string, options: ParsePlotSpecOptions = {}): PlotSpec {
  const segments = raw.split('::').map((segment) => segment.trim());
  const path = segments[0] ?? '';

  if (path.length === 0) {
    throw new SpecError('A plot cell must start with a file path.', { value: raw });
  }

  const values: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    if (segment.length === 0) continue;

    const spaceAt = segment.search(/\s/);
    const key = spaceAt === -1 ? segment : segment.slice(0, spaceAt);
    const value = spaceAt === -1 ? '' : segment.slice(spaceAt + 1).trim();

    if (!(PLOT_DECORATOR_KEYS as readonly string[]).includes(key)) {
      throw new SpecError(`Unknown option "${key}" in plot cell.`, {
        value: raw,
        hint: `Valid options are: ${PLOT_DECORATOR_KEYS.join(', ')}.`,
      });
    }
    if (value.length === 0) {
      throw new SpecError(`Option "${key}" needs a value, as in "${key} 2".`, { value: raw });
    }
    if (Object.hasOwn(values, key)) {
      throw new SpecError(`Option "${key}" is set twice in the same cell.`, { value: raw });
    }
    values[key] = value;
  }

  const defaults = { ...PLOT_SPEC_DEFAULTS, ...options.defaults };
  const numeric: Record<string, number> = {};
  for (const key of NUMERIC_KEYS) {
    const written = values[key];
    if (written === undefined) {
      numeric[key] = defaults[key];
      continue;
    }
    const parsed = Number(written);
    if (!Number.isFinite(parsed)) {
      throw new SpecError(`Option "${key}" must be a number, but is "${written}".`, { value: raw });
    }
    numeric[key] = parsed;
  }

  const spec: PlotSpec = {
    path,
    commit: values['commit'] ?? defaults.commit,
    page: numeric['page']!,
    // R rounds crop bounds to whole percent; keeping that makes cache keys stable.
    xmin: Math.round(numeric['xmin']!),
    xmax: Math.round(numeric['xmax']!),
    ymin: Math.round(numeric['ymin']!),
    ymax: Math.round(numeric['ymax']!),
    resolution: numeric['resolution']!,
  };

  validate(spec, raw);
  return spec;
}

function validate(spec: PlotSpec, raw: string): void {
  if (!Number.isInteger(spec.page) || spec.page < 1) {
    throw new SpecError(`Page must be a whole number of 1 or more, but is ${spec.page}.`, { value: raw });
  }
  if (spec.resolution <= 0) {
    throw new SpecError(`Resolution must be greater than 0 dpi, but is ${spec.resolution}.`, { value: raw });
  }

  for (const key of ['xmin', 'xmax', 'ymin', 'ymax'] as const) {
    const value = spec[key];
    if (value < 0 || value > 100) {
      throw new SpecError(`Crop bound "${key}" is a percentage and must be between 0 and 100, but is ${value}.`, {
        value: raw,
      });
    }
  }
  if (spec.xmin >= spec.xmax) {
    throw new SpecError(`Crop is empty: xmin (${spec.xmin}) must be smaller than xmax (${spec.xmax}).`, { value: raw });
  }
  if (spec.ymin >= spec.ymax) {
    throw new SpecError(`Crop is empty: ymin (${spec.ymin}) must be smaller than ymax (${spec.ymax}).`, { value: raw });
  }
}

/** True when the spec asks for a revision rather than the working-tree file. */
export function needsGit(spec: PlotSpec): boolean {
  return spec.commit !== PLOT_SPEC_DEFAULTS.commit;
}
