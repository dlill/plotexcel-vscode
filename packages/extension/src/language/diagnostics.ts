import * as vscode from 'vscode';

import { isLayoutFile, parseLayout } from '../../../core/src/layout/layoutFile.ts';
import { classifyCell } from '../../../core/src/spec/classify.ts';
import { SpecError } from '../../../core/src/types.ts';
import { cellsOf, headerLine, isPreamble, rangeOf } from './cells.ts';

/**
 * Problems in a layout file, shown where they are.
 *
 * Two kinds. The file's own structure — a duplicate column, a stray tab, an
 * option that is not a number — comes from the parser. Then every cell is
 * classified, which is where `::page two` and a diff naming a column that does
 * not exist turn up. Both land in the Problems panel with a range, so a
 * fifty-row table can be fixed by clicking rather than by counting tabs.
 */
export function registerDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('plotexcel');
  context.subscriptions.push(collection);

  const refresh = (document: vscode.TextDocument) => {
    if (!isLayoutFile(document.uri.fsPath)) return;
    collection.set(document.uri, analyse(document));
  };

  for (const document of vscode.workspace.textDocuments) refresh(document);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
  );
}

function analyse(document: vscode.TextDocument): vscode.Diagnostic[] {
  const text = document.getText();
  const { layout, diagnostics } = parseLayout(text);
  const found: vscode.Diagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const line = Math.max(0, diagnostic.line - 1);
    const cells = cellsOf(document.lineAt(Math.min(line, document.lineCount - 1)).text);
    const cell = diagnostic.column === undefined ? undefined : cells[diagnostic.column - 1];

    found.push(
      new vscode.Diagnostic(
        cell === undefined ? document.lineAt(Math.min(line, document.lineCount - 1)).range : rangeOf(line, cell),
        diagnostic.message,
        diagnostic.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      ),
    );
  }

  const header = headerLine(document);
  if (header === -1) return found;

  const columns = layout.columns;
  const defaults = layout.options.resolution === undefined ? {} : { resolution: layout.options.resolution };

  for (let line = header + 1; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    if (isPreamble(text)) continue;

    for (const cell of cellsOf(text)) {
      if (cell.text.trim().length === 0) continue;

      try {
        const classified = classifyCell(cell.text, { defaults });

        if (classified.kind === 'diff') {
          for (const name of [classified.spec.column1, classified.spec.column2]) {
            if (columns.some((column) => column.toLowerCase() === name.toLowerCase())) continue;

            found.push(
              new vscode.Diagnostic(
                rangeOf(line, cell),
                `This layout has no column called "${name}". Columns: ${columns.join(', ')}.`,
                vscode.DiagnosticSeverity.Error,
              ),
            );
          }
        }
      } catch (error) {
        const message = error instanceof SpecError ? messageOf(error) : String(error);
        found.push(new vscode.Diagnostic(rangeOf(line, cell), message, vscode.DiagnosticSeverity.Error));
      }
    }
  }

  return found;
}

function messageOf(error: SpecError): string {
  return error.detail?.hint === undefined ? error.message : `${error.message} ${error.detail.hint}`;
}
