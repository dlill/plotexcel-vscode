import * as vscode from 'vscode';

import { formatLayout, parseLayout } from '../../../core/src/layout/layoutFile.ts';

/**
 * Format Document on a layout file.
 *
 * Tab-separated text drifts: a row loses a trailing empty cell, options end up
 * below the header, a hand-typed row has one tab too few. Formatting rewrites
 * the file through the same parser and writer the renderer uses, so anything
 * that survives it is something the renderer will read the same way.
 *
 * It refuses to touch a file with errors in it. Reformatting a broken layout
 * would rearrange the very thing the person is trying to fix.
 */
export function registerFormatting(context: vscode.ExtensionContext): void {
  const provider: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(document) {
      const text = document.getText();
      const { layout, diagnostics } = parseLayout(text);

      if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return [];

      const formatted = formatLayout(layout);
      if (formatted === text) return [];

      const whole = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      return [vscode.TextEdit.replace(whole, formatted)];
    },
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'plotexcel-layout' }, provider),
  );
}
