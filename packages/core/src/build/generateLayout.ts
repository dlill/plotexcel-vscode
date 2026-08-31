import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { countPages, type PageCount } from '../documents/pageCount.ts';
import type { LayoutFile, LayoutOptions } from '../layout/layoutFile.ts';
import { plotExtensionOf } from '../spec/classify.ts';
import { SUPPORTED_PLOT_EXTENSIONS } from '../types.ts';

/**
 * Building a layout from files, rather than by hand.
 *
 * This is the front door for anyone who has not written one before: point at a
 * folder, get a table with every plot and page already in it, then edit. The
 * generated file is ordinary text — rows can be deleted, reordered, cropped or
 * captioned — which is the whole reason a file is generated instead of a
 * workbook being rendered directly.
 */

export interface DiscoveredFile {
  /** Path relative to the folder that was scanned. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly pages: number;
  /** Pages actually included, after the per-file cap. */
  readonly included: number;
  readonly confidence: PageCount['confidence'];
  readonly reason?: string | undefined;
}

export interface GeneratedLayout {
  readonly layout: LayoutFile;
  readonly files: readonly DiscoveredFile[];
  /** Files whose page count had to be guessed, worth telling the user about. */
  readonly uncertain: readonly DiscoveredFile[];
  readonly totalImages: number;
}

export interface GenerateFromFolderOptions {
  /** Folder to scan, recursively. */
  readonly folder: string;
  /** Directory the layout file will live in; plot paths are relative to it. */
  readonly layoutDir: string;
  readonly resolution?: number | undefined;
  /** Most pages to take from any one file. */
  readonly nPagesMax?: number | undefined;
  /** Only these relative paths, in this order. */
  readonly include?: readonly string[] | undefined;
  /** Drop paths matching this. */
  readonly exclude?: RegExp | undefined;
  /** Add a column showing each plot at this revision, plus a diff column. */
  readonly compareToCommit?: string | undefined;
  readonly options?: LayoutOptions | undefined;
  /** How to count pages. Without it, only formats that carry a count get one. */
  readonly pageCounter?: PageCounter | undefined;
}

const DEFAULT_PAGES_MAX = 4;

/**
 * How a caller counts a file's pages.
 *
 * Injected rather than imported so that `core` stays unaware of `tools`: an
 * HTML file has no page count until a browser has laid it out, and the caller
 * is the one holding the browser. Pass `countSourcePages` from
 * `pipeline/sourcePages.ts` to get real counts; leave it out and every format
 * that cannot be counted from its own structure comes back as one page, which
 * is what happened before this existed.
 */
export type PageCounter = (absolutePath: string) => Promise<PageCount>;

async function countWith(counter: PageCounter | undefined, absolutePath: string): Promise<PageCount> {
  if (counter === undefined) return countSafely(absolutePath);

  try {
    return await counter(absolutePath);
  } catch {
    // A counter that throws is not a reason to abandon the whole folder.
    return countSafely(absolutePath);
  }
}

/** Walk a folder and turn every plot it holds into rows. */
export async function generateFromFolder(options: GenerateFromFolderOptions): Promise<GeneratedLayout> {
  const folder = path.resolve(options.folder);
  const cap = options.nPagesMax ?? DEFAULT_PAGES_MAX;
  const resolution = options.resolution ?? 150;

  const found = await findPlotFiles(folder, options.exclude);
  const ordered = options.include === undefined ? found : orderBy(found, options.include);

  // Sequentially, not with Promise.all: counting may mean starting
  // LibreOffice or a browser, and a folder of thirty documents must not try to
  // start thirty of them at once.
  const files: DiscoveredFile[] = [];

  for (const relativePath of ordered) {
    const absolutePath = path.join(folder, relativePath);
    const count = await countWith(options.pageCounter, absolutePath);

    files.push({
      relativePath,
      absolutePath,
      pages: count.pages,
      included: Math.min(count.pages, cap),
      confidence: count.confidence,
      reason: count.reason,
    });
  }

  const columns = options.compareToCommit === undefined
    ? ['Description', 'Plot']
    : ['Description', 'Now', `At ${options.compareToCommit}`, 'Difference'];

  const rows: string[][] = [];

  for (const file of files) {
    for (let page = 1; page <= file.included; page += 1) {
      const relative = toPosix(path.relative(options.layoutDir, file.absolutePath));
      const description = `${file.relativePath.split(/[\\/]/).join(' / ')}, page ${page}::vcenter`;
      const spec = `${relative}::page ${page}::resolution ${resolution}`;

      rows.push(
        options.compareToCommit === undefined
          ? [description, spec]
          : [description, spec, `${spec}::commit ${options.compareToCommit}`, `diff(${columns[1]}, ${columns[2]})`],
      );
    }
  }

  return {
    layout: {
      options: { resolution, textColWidth: 8, ...options.options },
      comments: [`# Generated from ${toPosix(path.relative(options.layoutDir, folder)) || '.'} — edit freely.`],
      columns,
      rows,
    },
    files,
    uncertain: files.filter((file) => file.confidence === 'estimated'),
    totalImages: rows.length * (options.compareToCommit === undefined ? 1 : 3),
  };
}

export interface GenerateComparisonOptions {
  readonly first: string;
  readonly second?: string | undefined;
  /** Compare `first` against itself at this revision, instead of a second file. */
  readonly commit?: string | undefined;
  readonly layoutDir: string;
  readonly resolution?: number | undefined;
  /** Output rows to leave blank for each side, so pages line up again. */
  readonly skipFirst?: readonly number[] | undefined;
  readonly skipSecond?: readonly number[] | undefined;
  /** How to count pages. Without it, only formats that carry a count get one. */
  readonly pageCounter?: PageCounter | undefined;
}

/**
 * Two files side by side, page by page, with a difference column.
 *
 * When the two have different page counts the rows still line up one to one —
 * `skipFirst` and `skipSecond` push one side down so that pages meant to
 * correspond sit on the same row. That is a job for a person looking at the
 * output, which is why the answer is an editable file rather than a workbook.
 */
export async function generateComparison(options: GenerateComparisonOptions): Promise<GeneratedLayout> {
  const resolution = options.resolution ?? 150;
  const first = path.resolve(options.first);
  const comparingRevisions = options.second === undefined;

  if (comparingRevisions && options.commit === undefined) {
    throw new Error('Comparing one file needs a revision to compare it against.');
  }

  const second = comparingRevisions ? first : path.resolve(options.second!);
  const firstCount = await countWith(options.pageCounter, first);
  // Comparing a file against its own earlier revision: one file, one count.
  const secondCount = comparingRevisions ? firstCount : await countWith(options.pageCounter, second);

  const relativeFirst = toPosix(path.relative(options.layoutDir, first));
  const relativeSecond = toPosix(path.relative(options.layoutDir, second));
  const suffix = comparingRevisions ? `::commit ${options.commit}` : '';

  const left = column(relativeFirst, firstCount.pages, options.skipFirst ?? [], resolution, '');
  const right = column(relativeSecond, secondCount.pages, options.skipSecond ?? [], resolution, suffix);
  const height = Math.max(left.length, right.length);

  const columns = ['Page', path.basename(first), comparingRevisions ? `${path.basename(first)} at ${options.commit}` : path.basename(second), 'Difference'];
  const rows: string[][] = [];

  for (let index = 0; index < height; index += 1) {
    const a = left[index] ?? '';
    const b = right[index] ?? '';
    const diff =
      a.length > 0 && b.length > 0
        ? `diff(\`${columns[1]}\`, \`${columns[2]}\`)`
        : 'Only one side has a page here::center';

    rows.push([`${index + 1}::vcenter`, a, b, diff]);
  }

  const files: DiscoveredFile[] = [
    describeFile(first, firstCount, options.layoutDir),
    ...(comparingRevisions ? [] : [describeFile(second, secondCount, options.layoutDir)]),
  ];

  return {
    layout: {
      options: { resolution, textColWidth: 4 },
      comments: [
        `# Comparison generated by plotExcel — edit the skip pattern if pages do not line up.`,
        ...(firstCount.pages === secondCount.pages
          ? []
          : [`# Page counts differ: ${firstCount.pages} and ${secondCount.pages}.`]),
      ],
      columns,
      rows,
    },
    files,
    uncertain: files.filter((file) => file.confidence === 'estimated'),
    totalImages: rows.length * 3,
  };
}

export interface GenerateFolderComparisonOptions {
  readonly left: string;
  readonly right?: string | undefined;
  /** Compare `left` against itself at this revision, instead of a second folder. */
  readonly commit?: string | undefined;
  /**
   * The plot files that existed at `commit`, relative to `left`. Core cannot
   * run git, so a caller that can supplies the list; without it the working
   * tree's files are assumed to be the revision's too, which is right until a
   * plot is added or deleted.
   */
  readonly commitFiles?: readonly string[] | undefined;
  readonly layoutDir: string;
  readonly resolution?: number | undefined;
  readonly nPagesMax?: number | undefined;
  readonly exclude?: RegExp | undefined;
  /** How to count pages. Without it, only formats that carry a count get one. */
  readonly pageCounter?: PageCounter | undefined;
}

/**
 * Two folders side by side, paired by the path each file has inside its own
 * folder. A file present in only one of them still gets a row, saying which
 * side is missing: a comparison that quietly drops what does not match is how
 * a deleted plot goes unnoticed.
 *
 * With `commit` in place of `right` the second side is the same folder at an
 * earlier revision, which is the same table with `::commit` on every cell of
 * the right-hand column. That keeps a plot added last week and a plot deleted
 * last week visible as exactly what they are, rather than as a rendering
 * failure.
 */
export async function generateFolderComparison(options: GenerateFolderComparisonOptions): Promise<GeneratedLayout> {
  const comparingRevisions = options.right === undefined;
  if (comparingRevisions && options.commit === undefined) {
    throw new Error('Comparing one folder needs a revision to compare it against.');
  }

  const left = path.resolve(options.left);
  const right = comparingRevisions ? left : path.resolve(options.right!);
  const cap = options.nPagesMax ?? DEFAULT_PAGES_MAX;
  const resolution = options.resolution ?? 150;

  const leftFiles = await findPlotFiles(left, options.exclude);
  const rightFiles = comparingRevisions
    ? revisionFiles(options.commitFiles, leftFiles, options.exclude)
    : await findPlotFiles(right, options.exclude);

  const everything = [...new Set([...leftFiles, ...rightFiles])].sort((a, b) => a.localeCompare(b));
  const rightLabel = comparingRevisions ? `${path.basename(left)} at ${options.commit}` : path.basename(right);
  const columns = ['Description', path.basename(left), rightLabel, 'Difference'];
  const suffix = comparingRevisions ? `::commit ${options.commit}` : '';
  const rows: string[][] = [];
  const files: DiscoveredFile[] = [];

  for (const relativePath of everything) {
    const inLeft = leftFiles.includes(relativePath);
    const inRight = rightFiles.includes(relativePath);
    // Only the working tree is on disk, so that is where pages are counted.
    // A file that exists solely in the revision falls back to one page.
    const reference = path.join(inLeft ? left : right, relativePath);
    const count = await countWith(options.pageCounter, reference);
    const pages = Math.min(count.pages, cap);

    files.push({
      relativePath,
      absolutePath: reference,
      pages: count.pages,
      included: pages,
      confidence: count.confidence,
      reason: count.reason,
    });

    for (let page = 1; page <= pages; page += 1) {
      const description = `${relativePath.split(/[\\/]/).join(' / ')}, page ${page}::vcenter`;
      const leftSpec = inLeft ? spec(options.layoutDir, path.join(left, relativePath), page, resolution) : '';
      const rightSpec = inRight ? spec(options.layoutDir, path.join(right, relativePath), page, resolution, suffix) : '';

      const difference = !inLeft
        ? `Only in ${columns[2]}::center`
        : !inRight
          ? `Only in ${columns[1]}::center`
          : `diff(\`${columns[1]}\`, \`${columns[2]}\`)`;

      rows.push([description, leftSpec, rightSpec, difference]);
    }
  }

  return {
    layout: {
      options: { resolution, textColWidth: 8 },
      comments: [
        comparingRevisions
          ? `# Folder compared against ${options.commit} — files are paired by their path inside the folder.`
          : '# Folder comparison generated by plotExcel — files are paired by their path inside each folder.',
      ],
      columns,
      rows,
    },
    files,
    uncertain: files.filter((file) => file.confidence === 'estimated'),
    totalImages: rows.length * 3,
  };
}

/** What git listed, narrowed to the plots — it knows nothing about extensions. */
function revisionFiles(
  listed: readonly string[] | undefined,
  fallback: readonly string[],
  exclude?: RegExp,
): string[] {
  if (listed === undefined) return [...fallback];

  return listed
    .filter((relativePath) => {
      const extension = plotExtensionOf(relativePath);
      return extension !== undefined && SUPPORTED_PLOT_EXTENSIONS.includes(extension as never);
    })
    .filter((relativePath) => exclude?.test(relativePath) !== true)
    .sort((a, b) => a.localeCompare(b));
}

// ------------------------------------------------------------------------- //
// Helpers
// ------------------------------------------------------------------------- //

/** Every supported plot file under a folder, as paths relative to it. */
export async function findPlotFiles(folder: string, exclude?: RegExp): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Somewhere in every project is a folder of things nobody wants in a
      // report: the version control database, dependencies, and our own cache.
      if (entry.isDirectory()) {
        if (['.git', 'node_modules', '.plotexcel', '.Rproj.user', 'renv'].includes(entry.name)) continue;
        await walk(path.join(directory, entry.name), prefix === '' ? entry.name : `${prefix}/${entry.name}`);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = plotExtensionOf(entry.name);
      if (extension === undefined || !SUPPORTED_PLOT_EXTENSIONS.includes(extension as never)) continue;

      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (exclude?.test(relativePath) === true) continue;

      found.push(relativePath);
    }
  }

  await walk(path.resolve(folder), '');
  return found;
}

function orderBy(found: readonly string[], wanted: readonly string[]): string[] {
  const present = new Set(found);
  return wanted.filter((candidate) => present.has(candidate));
}

function countSafely(absolutePath: string): PageCount {
  try {
    return countPages(absolutePath);
  } catch (error) {
    return {
      pages: 1,
      confidence: 'estimated',
      reason: `Could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function describeFile(absolutePath: string, count: PageCount, layoutDir: string): DiscoveredFile {
  return {
    relativePath: toPosix(path.relative(layoutDir, absolutePath)),
    absolutePath,
    pages: count.pages,
    included: count.pages,
    confidence: count.confidence,
    reason: count.reason,
  };
}

function column(
  relativePath: string,
  pages: number,
  skip: readonly number[],
  resolution: number,
  suffix: string,
): string[] {
  if (pages === 0) return [];

  const skipped = new Set(skip);
  const rows: string[] = [];
  let page = 1;
  let row = 1;

  while (page <= pages) {
    if (skipped.has(row)) {
      rows.push('');
    } else {
      rows.push(`${relativePath}::page ${page}::resolution ${resolution}${suffix}`);
      page += 1;
    }
    row += 1;
  }

  return rows;
}

function spec(layoutDir: string, absolutePath: string, page: number, resolution: number, suffix = ''): string {
  return `${toPosix(path.relative(layoutDir, absolutePath))}::page ${page}::resolution ${resolution}${suffix}`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
