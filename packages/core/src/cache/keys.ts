import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { convertedExtension, plotExtensionOf } from '../spec/classify.ts';
import type { PlotSpec } from '../types.ts';

/**
 * Every intermediate the PNG pipeline writes, for one plot cell.
 *
 * The names encode the whole input: change the revision, the page, the
 * resolution or the crop and you get a different path, which is what makes the
 * pipeline idempotent. Nothing here is written to the user's project — see
 * {@link defaultCacheRoot}.
 */
export interface PipelinePaths {
  /** The absolute source path, as resolved from the layout file. */
  readonly source: string;
  /** Stage 1: the file at the requested revision. */
  readonly checkout: string;
  /** Stage 2: the same file converted to PDF, or copied through. */
  readonly converted: string;
  /** Stage 3: one page rasterised to PNG. */
  readonly page: string;
  /** Stage 4: that page cropped. This is what goes into the workbook. */
  readonly cropped: string;
}

export interface CacheKeyOptions {
  /** Root under which all intermediates live. Defaults to {@link defaultCacheRoot}. */
  readonly cacheRoot?: string;
  /** Directory the layout file lives in; relative plot paths resolve against it. */
  readonly baseDir?: string;
  /** Override for tests. */
  readonly platform?: NodeJS.Platform;
}

/** All pipeline intermediates live under one directory in the OS temp tree. */
export function defaultCacheRoot(): string {
  return path.join(os.tmpdir(), 'plotexcel');
}

/** Resolve a layout cell's path against the directory of the layout file. */
export function resolvePlotPath(specPath: string, baseDir?: string): string {
  return path.resolve(baseDir ?? process.cwd(), specPath);
}

/**
 * Build the four intermediate paths for a plot cell.
 *
 * Source files are grouped by a hash of their *directory*, so one folder of
 * plots shares one cache directory and the file names stay readable when you
 * go looking. The hash is of the normalised directory, so `C:\Plots` and
 * `c:/plots` are the same entry on Windows.
 */
export function pipelinePaths(spec: PlotSpec, options: CacheKeyOptions = {}): PipelinePaths {
  const platform = options.platform ?? process.platform;
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();

  const source = resolvePlotPath(spec.path, options.baseDir);
  const directoryKey = shortHash(normalizePath(path.dirname(source), platform));

  const sourceExtension = plotExtensionOf(spec.path) ?? path.extname(source).replace(/^\./, '').toLowerCase();
  const stem = path.basename(source, path.extname(source));
  const directory = path.join(cacheRoot, directoryKey);

  const checkoutStem = `${stem}-commit-${revisionSlug(spec.commit)}`;
  const convertedStem = `${checkoutStem}-topdf`;
  const pageStem = `${convertedStem}-page-${pad(spec.page, 2)}-res-${pad(spec.resolution, 2)}`;
  const croppedStem =
    `${pageStem}-crop-${pad(spec.xmin, 3)}-${pad(spec.xmax, 3)}-${pad(spec.ymin, 3)}-${pad(spec.ymax, 3)}`;

  return {
    source,
    checkout: path.join(directory, `${checkoutStem}.${sourceExtension}`),
    converted: path.join(directory, `${convertedStem}.${convertedExtension(spec)}`),
    page: path.join(directory, `${pageStem}.png`),
    cropped: path.join(directory, `${croppedStem}.png`),
  };
}

/**
 * Where the diff of two rendered pages is cached.
 *
 * The settings are part of the key. They change the picture, so a comparison
 * re-run at a different tolerance must not be answered from a cache filled at
 * the old one — which is exactly the sort of staleness nobody suspects,
 * because the image looks perfectly plausible.
 */
export function diffPath(
  first: string,
  second: string,
  cacheRoot = defaultCacheRoot(),
  settings: { readonly tolerance?: number | undefined; readonly context?: boolean | undefined } = {},
): string {
  const key = [first, second, settings.tolerance ?? 'default', settings.context ?? 'default'].join('\u0000');
  return path.join(cacheRoot, 'diff', `${shortHash(key)}.png`);
}

/**
 * A file name that is safe on every filesystem but still recognisable.
 *
 * Branch names and `HEAD~1` contain characters Windows rejects, so anything
 * outside a conservative set is replaced — and a hash of the original is
 * appended, so `feature/a` and `feature-a` cannot collide.
 */
export function revisionSlug(revision: string): string {
  const safe = revision.replace(/[^A-Za-z0-9._-]/g, '_');
  const truncated = safe.length > 32 ? safe.slice(0, 32) : safe;
  return safe === revision && truncated === safe ? safe : `${truncated}-${shortHash(revision, 8)}`;
}

function normalizePath(value: string, platform: NodeJS.Platform): string {
  const slashed = value.replace(/\\/g, '/');
  // Windows and macOS default to case-insensitive filesystems; folding the case
  // there keeps one directory from occupying two cache entries.
  return platform === 'win32' || platform === 'darwin' ? slashed.toLowerCase() : slashed;
}

function shortHash(value: string, length = 12): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);
}

function pad(value: number, width: number): string {
  return String(Math.trunc(value)).padStart(width, '0');
}
