import * as vscode from 'vscode';

import { generateFromFolder, type GeneratedLayout } from '../../../core/src/build/generateLayout.ts';
import { countPages } from '../../../core/src/documents/pageCount.ts';
import { formatLayout } from '../../../core/src/layout/layoutFile.ts';
import { LAYOUT_FILE_SUFFIX } from '../../../core/src/layout/layoutFile.ts';
import { pageCounter, settings } from '../machine.ts';
import { log } from '../output.ts';
import { chooseFolder, ensureProjectFolder, layoutUriFor } from '../storage.ts';

/**
 * Generate a layout from a folder of plots.
 *
 * The front door. Nobody should meet `::page 2::xmax 85` on a blank line —
 * they should meet it in a file that already works, next to fifty rows that
 * show what it does.
 */
export async function generateLayoutCommand(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const target = uri ?? uris?.[0] ?? (await pickFolder());
  if (target === undefined) return;

  const folder = await chooseFolder(target);
  if (folder === undefined) return;

  const stat = await vscode.workspace.fs.stat(target);
  const isFolder = stat.type === vscode.FileType.Directory;
  const scanned = isFolder ? target : parentOf(target);

  const configuration = settings();
  const paths = await ensureProjectFolder(folder);
  const destination = await layoutUriFor(paths, basename(scanned));

  const layoutDir = parentOf(destination).fsPath;
  const counter = await pageCounter(layoutDir);

  // Cancellable and per-file, because counting is no longer instant: an HTML or
  // Word plot has to be converted before anything can say how many pages it
  // has. Cancelling does not abandon the layout — the files not yet counted
  // fall back to what their own structure says, which is one page for the
  // formats that cannot answer. A layout is editable, so a short one is a
  // nuisance rather than a loss.
  const generated = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'plotExcel: reading plots', cancellable: true },
    async (progress, token) =>
      generateFromFolder({
        folder: scanned.fsPath,
        layoutDir,
        resolution: configuration.defaultResolution,
        nPagesMax: configuration.nPagesMax,
        ...(isFolder ? {} : { include: [basename(target)] }),
        pageCounter: async (absolutePath) => {
          if (token.isCancellationRequested) return countPages(absolutePath);

          progress.report({ message: absolutePath.split(/[\\/]/).pop() });
          return counter(absolutePath);
        },
      }),
  );

  if (generated.layout.rows.length === 0) {
    void vscode.window.showWarningMessage(
      `No plots found in ${basename(scanned)}. plotExcel reads PDF, PNG, Word, PowerPoint, Excel and HTML files.`,
    );
    return;
  }

  await vscode.workspace.fs.writeFile(destination, Buffer.from(formatLayout(generated.layout), 'utf8'));
  log().info(`Generated ${vscode.workspace.asRelativePath(destination)} from ${generated.files.length} files.`);

  const document = await vscode.window.showTextDocument(destination);
  await warnAboutEstimates(generated);

  const render = 'Render it';
  const choice = await vscode.window.showInformationMessage(
    `${generated.layout.rows.length} rows from ${generated.files.length} files. Edit the table, then render.`,
    render,
  );

  if (choice === render) await vscode.commands.executeCommand('plotexcel.render', document.document.uri);
}

async function warnAboutEstimates(generated: GeneratedLayout): Promise<void> {
  if (generated.uncertain.length === 0) return;

  // Worth saying out loud: a wrong page count is the difference between a row
  // that is missing and a row nobody notices is missing.
  const names = generated.uncertain.slice(0, 3).map((file) => file.relativePath).join(', ');
  const more = generated.uncertain.length > 3 ? ` and ${generated.uncertain.length - 3} more` : '';

  log().warn(`Page counts estimated for: ${names}${more}`);
  for (const file of generated.uncertain) log().warn(`    ${file.relativePath}: ${file.reason ?? 'reason unknown'}`);

  void vscode.window.showWarningMessage(
    `Could not read the page count of ${generated.uncertain.length} file${generated.uncertain.length === 1 ? '' : 's'} ` +
      `(${names}${more}). Add or remove rows by hand if pages are missing.`,
  );
}

async function pickFolder(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use this folder',
    title: 'Which folder holds the plots?',
  });

  return picked?.[0];
}

function parentOf(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? 'plots';
}

export { LAYOUT_FILE_SUFFIX };
