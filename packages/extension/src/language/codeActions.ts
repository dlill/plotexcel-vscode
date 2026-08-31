import * as vscode from 'vscode';

import { parseLayout } from '../../../core/src/layout/layoutFile.ts';
import { classifyCell } from '../../../core/src/spec/classify.ts';
import { PLOT_DECORATOR_KEYS } from '../../../core/src/spec/plotSpec.ts';
import { cellAt, columnNames, headerLine, rangeOf } from './cells.ts';

/**
 * Fixes offered where the problem is, and actions offered where the cell is.
 *
 * Two different things behind one lightbulb. A diagnostic about a column that
 * does not exist knows the columns that do, so it can offer them — the fix is
 * a click rather than a scroll to the header row. And a plot cell can offer
 * what you would want to do with it next: look at it, or crop it. Discovering
 * a command by finding it is worth more than discovering it by searching.
 */
export function registerCodeActions(context: vscode.ExtensionContext): void {
  const provider: vscode.CodeActionProvider = {
    provideCodeActions(document, range, context_) {
      const actions: vscode.CodeAction[] = [];

      for (const diagnostic of context_.diagnostics) {
        actions.push(...fixesFor(document, diagnostic));
      }

      actions.push(...cellActions(document, range));
      return actions;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ language: 'plotexcel-layout' }, provider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty],
    }),
  );
}

function fixesFor(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction[] {
  const unknownColumn = /no column called "([^"]+)"/.exec(diagnostic.message);
  if (unknownColumn !== null) {
    const wrong = unknownColumn[1]!;
    return rank(wrong, columnNames(document).filter((name) => name.length > 0)).map((name) =>
      replacement(document, diagnostic, wrong, name, `Use column "${name}"`),
    );
  }

  const unknownOption = /Unknown option "([^"]+)"/.exec(diagnostic.message);
  if (unknownOption !== null) {
    const wrong = unknownOption[1]!;
    return rank(wrong, [...PLOT_DECORATOR_KEYS]).map((key) =>
      replacement(document, diagnostic, wrong, key, `Change to "${key}"`),
    );
  }

  return [];
}

function replacement(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  wrong: string,
  right: string,
  title: string,
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  const text = document.getText(diagnostic.range);

  action.diagnostics = [diagnostic];
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(document.uri, diagnostic.range, text.replace(wrong, right));

  return action;
}

/** What you can do with the cell under the cursor, offered where it is. */
function cellActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
  const line = document.lineAt(range.start.line).text;
  if (line.startsWith('#') || range.start.line === headerLine(document)) return [];

  const cell = cellAt(line, range.start.character);
  if (cell === undefined || cell.text.trim().length === 0) return [];

  const { layout } = parseLayout(document.getText());
  const defaults = layout.options.resolution === undefined ? {} : { resolution: layout.options.resolution };

  try {
    if (classifyCell(cell.text, { defaults }).kind !== 'plot') return [];
  } catch {
    return [];
  }

  const preview = new vscode.CodeAction('Preview this plot', vscode.CodeActionKind.Empty);
  preview.command = { command: 'plotexcel.previewCell', title: 'Preview this plot' };

  const crop = new vscode.CodeAction('Crop this plot…', vscode.CodeActionKind.Empty);
  crop.command = { command: 'plotexcel.cropAssistant', title: 'Crop this plot' };

  const expand = new vscode.CodeAction('One row per page', vscode.CodeActionKind.Empty);
  expand.command = { command: 'plotexcel.expandPages', title: 'One row per page' };

  // The cell is the anchor for all three, so the lightbulb appears on it.
  for (const action of [preview, crop, expand]) action.isPreferred = false;
  void rangeOf(range.start.line, cell);

  return [preview, crop, expand];
}

/**
 * Candidates ordered by how close they are to what was typed.
 *
 * Cheap edit distance, capped at three suggestions: a list of every column in
 * the file is not a fix, it is a menu.
 */
function rank(wrong: string, candidates: readonly string[]): string[] {
  return [...candidates]
    .map((candidate) => ({ candidate, distance: distance(wrong.toLowerCase(), candidate.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

function distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    let corner = previous[0]!;
    previous[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        corner + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      corner = above;
    }
  }

  return previous[b.length]!;
}
