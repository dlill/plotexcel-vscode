import * as vscode from 'vscode';

import { isLayoutFile, parseLayout, type LayoutFile } from '../../core/src/layout/layoutFile.ts';

/**
 * Finding the layout a command should act on.
 *
 * The rule, in order: the file that was right-clicked, the file in the active
 * editor, the only layout in the workspace, or a pick between them. It is
 * written down here once and documented in the README, because a command whose
 * target is ambiguous reads as a command that is broken.
 */

export interface LoadedLayout {
  readonly uri: vscode.Uri;
  readonly layout: LayoutFile;
  readonly text: string;
}

export async function findLayouts(): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles('**/*.plotexcel.tsv', '**/{node_modules,.git}/**', 200);
}

export async function resolveLayoutUri(preferred?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (preferred !== undefined && isLayoutFile(preferred.fsPath)) return preferred;

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active !== undefined && isLayoutFile(active.fsPath)) return active;

  const found = await findLayouts();
  if (found.length === 1) return found[0];

  if (found.length === 0) {
    const generate = 'Generate one from a folder';
    const choice = await vscode.window.showInformationMessage(
      'This workspace has no plotExcel layout yet.',
      generate,
    );
    if (choice === generate) await vscode.commands.executeCommand('plotexcel.generateLayout');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    found.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { placeHolder: 'Which layout should be rendered?' },
  );

  return picked?.uri;
}

/** Read and parse a layout, reporting anything wrong with it. */
export async function loadLayout(uri: vscode.Uri): Promise<LoadedLayout | undefined> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  const { layout, diagnostics } = parseLayout(text);

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    const open = 'Open the layout';
    const choice = await vscode.window.showErrorMessage(
      `${vscode.workspace.asRelativePath(uri)} has ${errors.length} problem${errors.length === 1 ? '' : 's'}: ` +
        `${errors[0]!.message}`,
      open,
    );
    if (choice === open) await vscode.window.showTextDocument(uri);
    return undefined;
  }

  return { uri, layout, text };
}

/** How many images a layout will produce, for the "this is a big run" check. */
export function countPlanned(layout: LayoutFile): number {
  return layout.rows.reduce(
    (total, row) => total + row.filter((cell) => cell.trim().length > 0).length,
    0,
  );
}
