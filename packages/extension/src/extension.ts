import * as vscode from 'vscode';

import {
  addColumnFromFilesCommand,
  addDiffColumnCommand,
  addToLayoutCommand,
  copyCellCommand,
  expandPagesCommand,
  insertPlotCommand,
  openWorkbookCommand,
  setResolutionCommand,
  sortRowsCommand,
} from './commands/edit.ts';
import {
  compareTwoSelectedCommand,
  compareWithRevisionCommand,
  compareWithSelectedCommand,
  selectForDiffCommand,
} from './commands/compare.ts';
import { generateLayoutCommand, layoutSideBySideCommand } from './commands/generate.ts';
import { checkSetupCommand, clearCacheCommand } from './commands/maintenance.ts';
import { cropAssistantCommand, previewCellCommand, quickLookCommand } from './commands/preview.ts';
import { renderCommand } from './commands/render.ts';
import { openSampleCommand, openWalkthroughCommand } from './commands/sample.ts';
import { registerCodeActions } from './language/codeActions.ts';
import { registerCodeLens } from './language/codelens.ts';
import { registerCompletion } from './language/completion.ts';
import { registerDiagnostics } from './language/diagnostics.ts';
import { registerDrop } from './language/drop.ts';
import { registerFormatting } from './language/format.ts';
import { registerHover } from './language/hover.ts';
import { findLayouts } from './layouts.ts';
import { isTrusted, useBundledMupdf, watchSettings, watchTrust } from './machine.ts';
import { log } from './output.ts';
import { SelectionState } from './selection.ts';
import { registerView } from './views/plotexcelView.ts';
import { stopAllWatches, toggleWatchCommand } from './watch.ts';

/**
 * Wiring.
 *
 * Activation does as little as possible: register the commands and the editor
 * features, set the context keys the menus depend on, and look at nothing on
 * disk unless someone asks for something. Detecting tools, reading layouts and
 * rendering all happen on demand.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Only a path, no loading: MuPDF is read on the first render, not here.
  useBundledMupdf(vscode.Uri.joinPath(context.extensionUri, 'dist', 'mupdf', 'mupdf.js').fsPath);

  const selection = new SelectionState();
  context.subscriptions.push(selection, watchSettings(), watchTrust());

  const view = registerView(context);

  const register = (id: string, handler: (...args: never[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  // Rendering
  register('plotexcel.render', (uri?: vscode.Uri) => renderCommand(uri));
  register('plotexcel.rebuildAll', (uri?: vscode.Uri) => renderCommand(uri, { force: true }));
  register('plotexcel.watch', (uri?: vscode.Uri) => toggleWatchCommand(uri));
  register('plotexcel.openWorkbook', (uri?: vscode.Uri) => openWorkbookCommand(uri));

  // Making layouts
  register('plotexcel.generateLayout', (uri?: vscode.Uri, uris?: vscode.Uri[]) => generateLayoutCommand(uri, uris));
  register('plotexcel.layoutSideBySide', (uri?: vscode.Uri, uris?: vscode.Uri[]) => layoutSideBySideCommand(uri, uris));
  register('plotexcel.addToLayout', (uri?: vscode.Uri, uris?: vscode.Uri[]) => addToLayoutCommand(uri, uris));
  register('plotexcel.addColumnFromFiles', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
    addColumnFromFilesCommand(uri, uris),
  );
  register('plotexcel.insertPlot', () => insertPlotCommand());
  register('plotexcel.copyCell', (uri?: vscode.Uri, uris?: vscode.Uri[]) => copyCellCommand(uri, uris));

  // Editing them
  register('plotexcel.setResolution', () => setResolutionCommand());
  register('plotexcel.addDiffColumn', () => addDiffColumnCommand());
  register('plotexcel.expandPages', () => expandPagesCommand());
  register('plotexcel.sortRows', () => sortRowsCommand());

  // Looking at plots
  register('plotexcel.quickLook', (uri?: vscode.Uri) => quickLookCommand(uri));
  register('plotexcel.previewCell', () => previewCellCommand());
  register('plotexcel.cropAssistant', () => cropAssistantCommand(context));

  // Comparing
  register('plotexcel.selectForDiff', (uri?: vscode.Uri) => selectForDiffCommand(selection, uri));
  register('plotexcel.compareWithSelected', (uri?: vscode.Uri) => compareWithSelectedCommand(selection, uri));
  register('plotexcel.compareTwoSelected', (uri?: vscode.Uri, uris?: vscode.Uri[]) => compareTwoSelectedCommand(uri, uris));
  register('plotexcel.compareWithRevision', (uri?: vscode.Uri) => compareWithRevisionCommand(selection, uri));
  register('plotexcel.clearDiffSelection', () => selection.clear());

  // Housekeeping
  register('plotexcel.clearCache', async () => {
    await clearCacheCommand();
    view.refresh();
  });
  register('plotexcel.checkSetup', async () => {
    await checkSetupCommand();
    view.refresh();
  });
  register('plotexcel.refreshView', () => view.refresh());

  // Learning it
  register('plotexcel.openSample', async () => {
    await openSampleCommand();
    view.refresh();
  });
  register('plotexcel.openWalkthrough', () => openWalkthroughCommand());

  registerDiagnostics(context);
  registerCompletion(context);
  registerCodeLens(context);
  registerCodeActions(context);
  registerFormatting(context);
  registerHover(context);
  registerDrop(context);

  await updateLayoutContext();
  context.subscriptions.push(watchForLayouts());

  // No `plotexcel.supported` key here on purpose. It used to be set at the end
  // of activation and the Explorer menu and the tree view were gated on it,
  // which was circular: browsing the Explorer does not activate the extension,
  // so the key did not exist, so the menu stayed hidden — until something else
  // activated it, at which point the menu appeared for the rest of the session.
  // It only ever meant "a folder is open", which VS Code answers itself with
  // `workspaceFolderCount != 0`. The menus ask VS Code instead.

  await firstRun(context);
  log().info('plotExcel is ready.');
}

export function deactivate(): void {
  // Watches hold timers and file watchers that are not in the subscription
  // list, because they come and go with the command rather than the session.
  stopAllWatches();
}

/**
 * On the very first activation, say what this machine can do.
 *
 * The limits are worth knowing before the first workbook full of placeholders,
 * not after it. It happens once per install, and quietly when nothing is
 * missing.
 *
 * An untrusted folder detects nothing, so introducing the extension there
 * would report every capability as missing and then never ask again. It waits
 * for the first trusted activation instead.
 */
async function firstRun(context: vscode.ExtensionContext): Promise<void> {
  const key = 'plotexcel.introduced';
  if (!isTrusted() || context.globalState.get<boolean>(key) === true) return;

  await context.globalState.update(key, true);
  await checkSetupCommand({ quiet: true });
}

async function updateLayoutContext(): Promise<void> {
  const layouts = await findLayouts();
  await vscode.commands.executeCommand('setContext', 'plotexcel.hasLayout', layouts.length > 0);
}

/** Keep the palette entries honest as layouts appear and disappear. */
function watchForLayouts(): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.plotexcel.tsv');
  const refresh = () => void updateLayoutContext();

  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);

  return watcher;
}
