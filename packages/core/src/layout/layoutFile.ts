import type { Diagnostic } from '../types.ts';

/** Layout files carry a double extension so they can be recognised anywhere. */
export const LAYOUT_FILE_SUFFIX = '.plotexcel.tsv';

/** Cells are separated by tabs, so no cell may contain one. */
export const CELL_SEPARATOR = '\t';

/** Options a layout file may set in its `#key: value` preamble. */
export interface LayoutOptions {
  /** Where the workbook is written, relative to the layout file. */
  output?: string;
  /** Default rasterisation dpi for cells that do not set their own. */
  resolution?: number;
  /** Width of columns that hold no images, in cm. */
  textColWidth?: number;
  /** Style applied to the generated header row. */
  headerRowStyle?: string;
  /** Draw borders around every cell. */
  addBorders?: boolean;
  /** Also export the workbook to PDF and open it. */
  pdf?: boolean;
  /** Pagination used for that PDF export. */
  pdfPageSize?: 'single' | 'A4';
}

export interface LayoutFile {
  readonly options: LayoutOptions;
  /** Free-form `#` comment lines from the preamble, preserved on write. */
  readonly comments: readonly string[];
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface ParsedLayout {
  readonly layout: LayoutFile;
  readonly diagnostics: readonly Diagnostic[];
}

type OptionKind = 'string' | 'number' | 'boolean' | 'pageSize' | 'style';

const OPTION_KINDS: Readonly<Record<keyof LayoutOptions, OptionKind>> = {
  output: 'string',
  resolution: 'number',
  textColWidth: 'number',
  headerRowStyle: 'style',
  addBorders: 'boolean',
  pdf: 'boolean',
  pdfPageSize: 'pageSize',
};

const OPTION_ORDER = Object.keys(OPTION_KINDS) as (keyof LayoutOptions)[];

const OPTION_LINE = /^#\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/;

/** True for a path that names a plotExcel layout file. */
export function isLayoutFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(LAYOUT_FILE_SUFFIX);
}

/**
 * Read a layout file.
 *
 * Always returns a layout — as much of one as could be read — plus the
 * diagnostics for whatever was wrong, so an editor can show every problem at
 * once instead of stopping at the first.
 */
export function parseLayout(text: string): ParsedLayout {
  const diagnostics: Diagnostic[] = [];
  const options: LayoutOptions = {};
  const comments: string[] = [];
  const rows: string[][] = [];

  let columns: string[] = [];
  let seenHeader = false;

  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (line.trim().length === 0) return;

    if (line.startsWith('#')) {
      readPreambleLine(line, lineNumber, options, comments, diagnostics, seenHeader);
      return;
    }

    const cells = line.split(CELL_SEPARATOR).map((cell) => cell.trim());

    if (!seenHeader) {
      seenHeader = true;
      columns = cells;
      checkHeader(columns, lineNumber, diagnostics);
      return;
    }

    if (cells.length > columns.length) {
      diagnostics.push({
        severity: 'error',
        line: lineNumber,
        column: columns.length + 1,
        message:
          `This row has ${cells.length} cells but the table has ${columns.length} columns. ` +
          'Extra cells are ignored — check for a stray tab.',
      });
    }

    const row = Array.from({ length: columns.length }, (_, column) => cells[column] ?? '');
    rows.push(row);
  });

  if (!seenHeader) {
    diagnostics.push({
      severity: 'error',
      line: lines.length,
      message: 'This layout has no header row. The first line that is not a # comment names the columns.',
    });
  }

  return { layout: { options, comments, columns, rows }, diagnostics };
}

function readPreambleLine(
  line: string,
  lineNumber: number,
  options: LayoutOptions,
  comments: string[],
  diagnostics: Diagnostic[],
  seenHeader: boolean,
): void {
  const match = OPTION_LINE.exec(line);
  if (!match) {
    comments.push(line);
    return;
  }

  const [, rawKey = '', rawValue = ''] = match;
  const key = OPTION_ORDER.find((candidate) => candidate.toLowerCase() === rawKey.toLowerCase());

  if (key === undefined) {
    comments.push(line);
    diagnostics.push({
      severity: 'warning',
      line: lineNumber,
      message: `Unknown option "${rawKey}" — it will be ignored. Known options: ${OPTION_ORDER.join(', ')}.`,
    });
    return;
  }

  if (seenHeader) {
    diagnostics.push({
      severity: 'warning',
      line: lineNumber,
      message: `Option "${rawKey}" appears after the table and will be ignored. Move it above the header row.`,
    });
    return;
  }

  const value = rawValue.trim();
  const fail = (message: string) => diagnostics.push({ severity: 'error', line: lineNumber, message });

  switch (key) {
    case 'resolution':
    case 'textColWidth': {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        fail(`Option "${rawKey}" must be a positive number, but is "${value}".`);
        return;
      }
      options[key] = parsed;
      return;
    }
    case 'addBorders':
    case 'pdf': {
      const lowered = value.toLowerCase();
      const truthy = ['true', 'yes', '1'];
      const falsy = ['false', 'no', '0'];
      if (!truthy.includes(lowered) && !falsy.includes(lowered)) {
        fail(`Option "${rawKey}" must be true or false, but is "${value}".`);
        return;
      }
      options[key] = truthy.includes(lowered);
      return;
    }
    case 'pdfPageSize': {
      if (value !== 'single' && value !== 'A4') {
        fail(`Option "${rawKey}" must be "single" or "A4", but is "${value}".`);
        return;
      }
      options.pdfPageSize = value;
      return;
    }
    case 'output':
    case 'headerRowStyle': {
      if (value.length === 0) {
        fail(`Option "${rawKey}" has no value.`);
        return;
      }
      options[key] = value;
      return;
    }
  }
}

function checkHeader(columns: readonly string[], lineNumber: number, diagnostics: Diagnostic[]): void {
  const seen = new Set<string>();

  columns.forEach((name, index) => {
    if (name.length === 0) {
      diagnostics.push({
        severity: 'error',
        line: lineNumber,
        column: index + 1,
        message: 'Every column needs a name — diff cells refer to columns by name.',
      });
      return;
    }
    if (seen.has(name)) {
      diagnostics.push({
        severity: 'error',
        line: lineNumber,
        column: index + 1,
        message: `Column "${name}" appears more than once. Column names must be unique.`,
      });
    }
    seen.add(name);
  });
}

/**
 * Write a layout file back out.
 *
 * Throws rather than silently mangling a cell that contains a tab or a newline;
 * a layout that cannot round-trip is a bug in whatever produced the cell.
 */
export function formatLayout(layout: LayoutFile): string {
  const lines: string[] = [...layout.comments];

  for (const key of OPTION_ORDER) {
    const value = layout.options[key];
    if (value === undefined) continue;
    lines.push(`#${key}: ${value}`);
  }

  lines.push(checkedRow(layout.columns, 'header'));
  layout.rows.forEach((row, index) => {
    const padded = Array.from({ length: layout.columns.length }, (_, column) => row[column] ?? '');
    lines.push(checkedRow(padded, `row ${index + 1}`));
  });

  return `${lines.join('\n')}\n`;
}

function checkedRow(cells: readonly string[], where: string): string {
  cells.forEach((cell, index) => {
    if (cell.includes(CELL_SEPARATOR) || cell.includes('\n')) {
      throw new Error(`Cell ${index + 1} of ${where} contains a tab or newline, which a layout file cannot hold.`);
    }
  });
  return cells.join(CELL_SEPARATOR);
}
