import path from 'node:path';

import { defaultCacheRoot } from '../cache/keys.ts';
import type { LayoutFile } from '../layout/layoutFile.ts';
import { LAYOUT_FILE_SUFFIX } from '../layout/layoutFile.ts';
import { mapWithLimit } from '../pipeline/limit.ts';
import type { Tools } from '../pipeline/ports.ts';
import { diffPlaceholder, renderDiff, type RenderedDiff } from '../pipeline/renderDiff.ts';
import { renderPlot, type PipelineIssue, type RenderedPlot, type Stage } from '../pipeline/renderPlot.ts';
import { classifyCell } from '../spec/classify.ts';
import { DEFAULT_HEADER_STYLE } from '../styles.ts';
import { SpecError, type Cell } from '../types.ts';
import { computeGeometry, type PlacedImage } from '../units.ts';
import {
  writeWorkbook,
  type ColumnWidthModel,
  type WorkbookCellInput,
  type WorkbookImageInput,
} from '../xlsx/writeWorkbook.ts';

/**
 * Turn a layout file into a workbook.
 *
 * This is the port of `plotExcel()`: classify every cell, run the plot
 * pipeline over the ones that are plots, compare the ones that are diffs, size
 * every row and column to what ended up in it, and write the file.
 *
 * It never throws for anything the user can fix. A malformed cell, a missing
 * file, an absent converter — each becomes an image that says so, plus an entry
 * in `issues` for the extension to surface. A layout with forty plots and one
 * problem still produces a workbook with thirty-nine plots and one explanation.
 */

export interface ProgressEvent {
  readonly completed: number;
  readonly total: number;
  /** Something short enough for a progress bar: "01-Iris.pdf page 2". */
  readonly label: string;
  readonly stage?: Stage | undefined;
  readonly fromCache?: boolean | undefined;
  readonly elapsedMs?: number | undefined;
}

export interface LayoutIssue {
  /** 1-based position in the workbook, so it matches what the user sees. */
  readonly row: number;
  readonly column: number;
  readonly columnName: string;
  readonly cell: string;
  readonly issue: PipelineIssue;
}

export interface RenderLayoutOptions {
  /** Path of the layout file. Relative plot paths resolve against its folder. */
  readonly layoutPath: string;
  readonly outputPath?: string | undefined;
  readonly tools?: Tools | undefined;
  readonly cacheRoot?: string | undefined;
  readonly concurrency?: number | undefined;
  readonly force?: boolean | undefined;
  readonly widthModel?: ColumnWidthModel | undefined;
  readonly sheetName?: string | undefined;
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
  /** Stop between cells. The workbook is not written when this fires. */
  readonly signal?: AbortSignal | undefined;
  /**
   * The timestamp written into the workbook, for a build that can be compared
   * byte for byte. Left out, it is the moment of the render — which lands in
   * `docProps/core.xml` and in every ZIP entry, so two runs a second apart
   * produce different files.
   */
  readonly createdAt?: Date | undefined;
}

export interface RenderLayoutResult {
  readonly workbook: Buffer;
  readonly outputPath: string;
  readonly textCells: number;
  readonly images: number;
  readonly diffs: number;
  readonly placeholders: number;
  readonly cacheHits: number;
  readonly issues: readonly LayoutIssue[];
  readonly elapsedMs: number;
}

interface PlotJob {
  readonly row: number;
  readonly column: number;
  readonly cell: Cell & { kind: 'plot' };
  readonly text: string;
}

interface DiffJob {
  readonly row: number;
  readonly column: number;
  readonly cell: Cell & { kind: 'diff' };
  readonly text: string;
}

/** Row 1 holds the column names, so the first data row is row 2. */
const FIRST_DATA_ROW = 2;

export async function renderLayout(layout: LayoutFile, options: RenderLayoutOptions): Promise<RenderLayoutResult> {
  const startedAt = Date.now();
  const baseDir = path.dirname(path.resolve(options.layoutPath));
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
  const headerStyle = layout.options.headerRowStyle ?? DEFAULT_HEADER_STYLE;
  const parseOptions = {
    defaults: layout.options.resolution === undefined ? {} : { resolution: layout.options.resolution },
  };

  const textCells: WorkbookCellInput[] = layout.columns.map((name, index) => ({
    row: 1,
    column: index + 1,
    text: name,
    style: headerStyle,
  }));

  const plots: PlotJob[] = [];
  const diffs: DiffJob[] = [];
  const issues: LayoutIssue[] = [];
  const placeholders: { row: number; column: number; png: Buffer; widthCm: number; heightCm: number }[] = [];

  layout.rows.forEach((row, rowIndex) => {
    row.forEach((text, columnIndex) => {
      const at = { row: rowIndex + FIRST_DATA_ROW, column: columnIndex + 1 };

      let cell: Cell;
      try {
        cell = classifyCell(text, parseOptions);
      } catch (error) {
        const issue: PipelineIssue = {
          kind: 'unsupported',
          headline: 'This cell could not be read',
          details: [error instanceof SpecError ? error.message : String(error)],
        };
        issues.push({ ...at, columnName: layout.columns[columnIndex] ?? '', cell: text, issue });
        placeholders.push({ ...at, ...errorImage(issue) });
        return;
      }

      switch (cell.kind) {
        case 'empty':
          return;
        case 'text':
          textCells.push({ ...at, text: cell.spec.text, style: cell.spec.style });
          return;
        case 'plot':
          plots.push({ ...at, cell, text });
          return;
        default:
          diffs.push({ ...at, cell, text });
      }
    });
  });

  // ----------------------------------------------------------------------- //
  // Plots
  // ----------------------------------------------------------------------- //

  const total = plots.length + diffs.length;
  let completed = 0;

  const rendered = await mapWithLimit(plots, options.concurrency ?? 4, async (job) => {
    const result = await renderPlot(job.cell.spec, {
      baseDir,
      cacheRoot,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(layout.options.pdfPageSize === undefined ? {} : { pageSize: layout.options.pdfPageSize }),
    });

    completed += 1;
    options.onProgress?.({
      completed,
      total,
      label: describe(job.cell.spec.path, job.cell.spec.page),
      fromCache: result.fromCache,
      elapsedMs: result.elapsedMs,
    });

    return { job, result };
  }, { ...(options.signal === undefined ? {} : { signal: options.signal }) });

  const byPosition = new Map<string, RenderedPlot>();
  for (const { job, result } of rendered) {
    byPosition.set(key(job.row, job.column), result);
    if (result.issue !== undefined) {
      issues.push({
        row: job.row,
        column: job.column,
        columnName: layout.columns[job.column - 1] ?? '',
        cell: job.text,
        issue: result.issue,
      });
    }
  }

  // ----------------------------------------------------------------------- //
  // Diffs
  // ----------------------------------------------------------------------- //

  const diffResults = await mapWithLimit(diffs, options.concurrency ?? 4, async (job) => {
    const first = findColumn(layout.columns, job.cell.spec.column1);
    const second = findColumn(layout.columns, job.cell.spec.column2);
    const missing = [
      first === undefined ? job.cell.spec.column1 : undefined,
      second === undefined ? job.cell.spec.column2 : undefined,
    ].filter((name): name is string => name !== undefined);

    completed += 1;

    if (missing.length > 0) {
      const issue: PipelineIssue = {
        kind: 'unsupported',
        headline: 'Unknown column in diff',
        details: [`This layout has no column called ${missing.map((name) => `"${name}"`).join(' or ')}.`],
      };
      issues.push({ ...position(job), columnName: layout.columns[job.column - 1] ?? '', cell: job.text, issue });
      return { job, diff: diffPlaceholder(issue.headline, issue.details) };
    }

    const left = byPosition.get(key(job.row, first! + 1));
    const right = byPosition.get(key(job.row, second! + 1));

    if (left === undefined || right === undefined) {
      const issue: PipelineIssue = {
        kind: 'unsupported',
        headline: 'Nothing to compare',
        details: ['One of the two columns has no plot in this row.'],
      };
      issues.push({ ...position(job), columnName: layout.columns[job.column - 1] ?? '', cell: job.text, issue });
      return { job, diff: diffPlaceholder(issue.headline, issue.details) };
    }

    const diff = await renderDiff(left, right, {
      cacheRoot,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(job.cell.spec.tolerance === undefined ? {} : { threshold: job.cell.spec.tolerance }),
      ...(job.cell.spec.context === undefined ? {} : { showContext: job.cell.spec.context }),
    });

    options.onProgress?.({
      completed,
      total,
      label: `diff of ${layout.columns[first!]} and ${layout.columns[second!]}`,
      fromCache: diff.fromCache,
      elapsedMs: diff.elapsedMs,
    });

    return { job, diff };
  }, { ...(options.signal === undefined ? {} : { signal: options.signal }) });

  // ----------------------------------------------------------------------- //
  // Assemble
  // ----------------------------------------------------------------------- //

  const images: WorkbookImageInput[] = [];
  const placed: PlacedImage[] = [];

  const add = (row: number, column: number, png: Buffer, widthCm: number, heightCm: number, description: string) => {
    images.push({ row, column, png, widthCm, heightCm, description });
    placed.push({ row, column, widthCm, heightCm });
  };

  for (const { job, result } of rendered) {
    add(job.row, job.column, result.png, result.widthCm, result.heightCm, describe(job.cell.spec.path, job.cell.spec.page));
  }
  for (const { job, diff } of diffResults) {
    add(job.row, job.column, diff.png, diff.widthCm, diff.heightCm, diffDescription(diff));
  }
  for (const item of placeholders) {
    add(item.row, item.column, item.png, item.widthCm, item.heightCm, 'Could not be rendered');
  }

  const lastRow = Math.max(1, layout.rows.length + FIRST_DATA_ROW - 1);
  const geometry = computeGeometry(
    placed,
    {
      columns: range(1, Math.max(1, layout.columns.length)),
      rows: range(1, lastRow),
    },
    {
      textColumnWidthCm: layout.options.textColWidth ?? 5,
      textRowHeightCm: 2,
    },
  );

  const workbook = writeWorkbook({
    sheetName: options.sheetName ?? sheetNameFor(options.layoutPath),
    title: path.basename(options.layoutPath),
    cells: textCells,
    images,
    columnWidthsCm: geometry.columnWidthsCm,
    rowHeightsCm: geometry.rowHeightsCm,
    freeze: { rows: 1, columns: 1 },
    addBorders: layout.options.addBorders === true,
    fitToPage: true,
    ...(options.widthModel === undefined ? {} : { widthModel: options.widthModel }),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  });

  return {
    workbook,
    outputPath: resolveOutputPath(layout, options.layoutPath, options.outputPath),
    textCells: textCells.length,
    images: rendered.length,
    diffs: diffResults.length,
    placeholders: issues.length,
    cacheHits:
      rendered.filter(({ result }) => result.fromCache).length + diffResults.filter(({ diff }) => diff.fromCache).length,
    issues,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * The same workbook, named so a copy open in Excel cannot block the write.
 *
 * Windows only, and this is why: Excel holds an exclusive lock on an open
 * workbook, so rendering again while the last one is still on screen fails at
 * the final step — after every page has been rasterised, which is the part
 * that took the time. A fresh name each render costs a tidy-up later and
 * saves losing the work now. Nothing locks the file on macOS or Linux, so
 * they keep the clean name and overwrite in place.
 *
 * Deliberately separate from {@link resolveOutputPath}, which has to stay
 * deterministic: it is also how "Open the Workbook" works out where to look,
 * and a name containing the current time would never be found twice.
 */
export function timestampedWorkbookPath(
  outputPath: string,
  options: { readonly platform?: NodeJS.Platform; readonly now?: Date } = {},
): string {
  if ((options.platform ?? process.platform) !== 'win32') return outputPath;

  const extension = path.extname(outputPath);
  const stem = path.basename(outputPath, extension);
  return path.join(path.dirname(outputPath), `${stem}-${stamp(options.now ?? new Date())}${extension}`);
}

/** Matches the clean workbook name and every timestamped one beside it. */
export function workbookNamePattern(stem: string): RegExp {
  return new RegExp(`^${escapeRegExp(stem)}(-\\d{8}-\\d{6})?\\.xlsx$`, 'i');
}

/** Sortable, and free of the characters Windows will not put in a file name. */
function stamp(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  );
}

/** Where the workbook goes: the layout's own `#output:`, or a sibling .xlsx. */
export function resolveOutputPath(layout: LayoutFile, layoutPath: string, override?: string): string {
  if (override !== undefined) return path.resolve(override);

  const baseDir = path.dirname(path.resolve(layoutPath));
  if (layout.options.output !== undefined) return path.resolve(baseDir, layout.options.output);

  const stem = path.basename(layoutPath).replace(new RegExp(`${escapeRegExp(LAYOUT_FILE_SUFFIX)}$`, 'i'), '');
  return path.join(baseDir, `${stem || 'plots'}.xlsx`);
}

function sheetNameFor(layoutPath: string): string {
  const stem = path.basename(layoutPath).replace(new RegExp(`${escapeRegExp(LAYOUT_FILE_SUFFIX)}$`, 'i'), '');
  return stem.length > 0 ? stem : 'Plots';
}

function findColumn(columns: readonly string[], name: string): number | undefined {
  const exact = columns.indexOf(name);
  if (exact !== -1) return exact;

  const lowered = name.toLowerCase();
  const loose = columns.findIndex((column) => column.toLowerCase() === lowered);
  return loose === -1 ? undefined : loose;
}

function errorImage(issue: PipelineIssue): { png: Buffer; widthCm: number; heightCm: number } {
  const placeholder = diffPlaceholder(issue.headline, issue.details);
  return { png: placeholder.png, widthCm: placeholder.widthCm, heightCm: placeholder.heightCm };
}

function diffDescription(diff: RenderedDiff): string {
  if (Number.isNaN(diff.changed)) return 'Visual difference';
  const mismatch = diff.sizeMismatch ? ', page sizes differ' : '';
  return `Visual difference: ${diff.changed}% of pixels${mismatch}`;
}

function describe(plotPath: string, page: number): string {
  return `${path.basename(plotPath)} page ${page}`;
}

function position(job: { row: number; column: number }): { row: number; column: number } {
  return { row: job.row, column: job.column };
}

function key(row: number, column: number): string {
  return `${row}:${column}`;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
