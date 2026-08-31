import * as vscode from 'vscode';

import { CELL_SEPARATOR } from '../../../core/src/layout/layoutFile.ts';

/**
 * Working out which cell the cursor is in.
 *
 * A layout is tab-separated text, so every editor feature — diagnostics,
 * completion, hover, drop — needs the same two answers: where does each cell
 * start and end on this line, and which one is the cursor in. Doing it once
 * here keeps those four features from disagreeing.
 */

export interface CellSpan {
  readonly index: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function cellsOf(line: string): CellSpan[] {
  const spans: CellSpan[] = [];
  let start = 0;
  let index = 0;

  for (const part of line.split(CELL_SEPARATOR)) {
    spans.push({ index, text: part, start, end: start + part.length });
    start += part.length + 1;
    index += 1;
  }

  return spans;
}

export function cellAt(line: string, character: number): CellSpan | undefined {
  return cellsOf(line).find((cell) => character >= cell.start && character <= cell.end);
}

export function rangeOf(line: number, cell: CellSpan): vscode.Range {
  return new vscode.Range(line, cell.start, line, Math.max(cell.start + 1, cell.end));
}

/** True for a line that is a comment or blank, and so holds no cells. */
export function isPreamble(line: string): boolean {
  return line.trim().length === 0 || line.startsWith('#');
}

/** The line index of the header row, or -1 when the file has none. */
export function headerLine(document: vscode.TextDocument): number {
  for (let line = 0; line < document.lineCount; line += 1) {
    if (!isPreamble(document.lineAt(line).text)) return line;
  }
  return -1;
}

/** Column names from the header row, for diff cells and completion. */
export function columnNames(document: vscode.TextDocument): string[] {
  const header = headerLine(document);
  return header === -1 ? [] : cellsOf(document.lineAt(header).text).map((cell) => cell.text.trim());
}
