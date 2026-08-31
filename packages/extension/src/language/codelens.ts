import * as vscode from 'vscode';

import { parseLayout } from '../../../core/src/layout/layoutFile.ts';
import { headerLine } from './cells.ts';

/**
 * The two buttons that belong on a layout file.
 *
 * Render, and rebuild everything. The second exists because a stale cache is
 * the single most common way this extension appears broken — the plot changed
 * but the file's timestamp did not — and hunting for a command in the palette
 * is not what someone does when they think the tool is lying to them.
 */
export function registerCodeLens(context: vscode.ExtensionContext): void {
  const emitter = new vscode.EventEmitter<void>();

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: emitter.event,

    provideCodeLenses(document) {
      const header = headerLine(document);
      if (header === -1) return [];

      const { layout } = parseLayout(document.getText());
      const cells = layout.rows.reduce(
        (total, row) => total + row.filter((cell) => cell.trim().length > 0).length,
        0,
      );

      const range = new vscode.Range(header, 0, header, 0);

      return [
        new vscode.CodeLens(range, {
          title: `$(table) Render ${layout.rows.length} rows`,
          command: 'plotexcel.render',
          arguments: [document.uri],
          tooltip: `${cells} cells across ${layout.columns.length} columns`,
        }),
        new vscode.CodeLens(range, {
          title: '$(refresh) Rebuild everything',
          command: 'plotexcel.rebuildAll',
          arguments: [document.uri],
          tooltip: 'Ignore everything cached and render each plot again',
        }),
      ];
    },
  };

  context.subscriptions.push(
    emitter,
    vscode.languages.registerCodeLensProvider({ language: 'plotexcel-layout' }, provider),
    vscode.workspace.onDidChangeTextDocument(() => emitter.fire()),
  );
}
