import * as vscode from 'vscode';

import { parseLayout } from '../../core/src/layout/layoutFile.ts';
import { classifyCell } from '../../core/src/spec/classify.ts';
import { requireTrust } from './machine.ts';
import { log } from './output.ts';

/**
 * Keep a workbook in step with the plots it is made of.
 *
 * The loop this replaces is: regenerate a figure in R, switch to VS Code,
 * render, switch to Excel, look. Watching collapses it to: regenerate the
 * figure, look at Excel. That is the difference between a report you rebuild
 * at the end and one that is simply always current.
 *
 * It watches the layout and every file the layout points at, debounced, and
 * stops as soon as the layout is closed or the command is run again.
 */

interface Session {
  readonly layout: vscode.Uri;
  readonly disposables: vscode.Disposable[];
  timer: NodeJS.Timeout | undefined;
  rendering: boolean;
  pending: boolean;
}

const sessions = new Map<string, Session>();
let status: vscode.StatusBarItem | undefined;

const SETTLE_MS = 400;

export async function toggleWatchCommand(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (target === undefined) return;

  const key = target.toString();
  const existing = sessions.get(key);

  if (existing !== undefined) {
    stop(key);
    void vscode.window.showInformationMessage(`plotExcel: no longer watching ${basename(target)}.`);
    return;
  }

  if (!(await requireTrust())) return;

  await start(target);
}

async function start(layoutUri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(layoutUri);
  const sources = sourcesOf(document);

  const session: Session = { layout: layoutUri, disposables: [], timer: undefined, rendering: false, pending: false };
  sessions.set(layoutUri.toString(), session);

  const schedule = (why: string) => {
    log().debug(`Watch: ${why} changed.`);
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = setTimeout(() => void render(session), SETTLE_MS);
  };

  // The layout itself: re-render when it is saved, not on every keystroke.
  session.disposables.push(
    vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() === layoutUri.toString()) schedule('the layout');
    }),
    vscode.workspace.onDidCloseTextDocument((closed) => {
      if (closed.uri.toString() === layoutUri.toString()) stop(layoutUri.toString());
    }),
  );

  // And each plot it points at, watched by name so an R script rewriting a
  // figure triggers a rebuild without watching the whole workspace.
  for (const source of sources) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(source, '..'), basename(source)),
    );

    watcher.onDidChange(() => schedule(basename(source)));
    watcher.onDidCreate(() => schedule(basename(source)));
    session.disposables.push(watcher);
  }

  showStatus(sessions.size);
  log().info(`Watching ${vscode.workspace.asRelativePath(layoutUri)} and ${sources.length} plot(s).`);

  void vscode.window.showInformationMessage(
    `plotExcel is watching ${basename(layoutUri)} and ${sources.length} plot${sources.length === 1 ? '' : 's'}. ` +
      'Run the command again to stop.',
  );

  await render(session);
}

async function render(session: Session): Promise<void> {
  // A render triggered while one is running becomes one render afterwards,
  // rather than a queue of them.
  if (session.rendering) {
    session.pending = true;
    return;
  }

  session.rendering = true;
  try {
    await vscode.commands.executeCommand('plotexcel.render', session.layout);
  } finally {
    session.rendering = false;
    if (session.pending) {
      session.pending = false;
      await render(session);
    }
  }
}

function stop(key: string): void {
  const session = sessions.get(key);
  if (session === undefined) return;

  if (session.timer !== undefined) clearTimeout(session.timer);
  for (const disposable of session.disposables) disposable.dispose();

  sessions.delete(key);
  showStatus(sessions.size);
}

export function stopAllWatches(): void {
  for (const key of [...sessions.keys()]) stop(key);
}

/** Every distinct file the layout's plot cells point at. */
function sourcesOf(document: vscode.TextDocument): vscode.Uri[] {
  const { layout } = parseLayout(document.getText());
  const base = vscode.Uri.joinPath(document.uri, '..');
  const found = new Map<string, vscode.Uri>();

  for (const row of layout.rows) {
    for (const cell of row) {
      try {
        const classified = classifyCell(cell);
        if (classified.kind !== 'plot') continue;

        const uri = vscode.Uri.joinPath(base, ...classified.spec.path.split(/[\\/]/));
        found.set(uri.toString(), uri);
      } catch {
        // A cell that will not parse is a problem for the renderer to report.
      }
    }
  }

  return [...found.values()];
}

function showStatus(count: number): void {
  if (count === 0) {
    status?.dispose();
    status = undefined;
    return;
  }

  status ??= vscode.window.createStatusBarItem('plotexcel.watch', vscode.StatusBarAlignment.Left, 99);
  status.command = 'plotexcel.watch';
  status.name = 'plotExcel watch';
  status.text = `$(eye) plotExcel${count > 1 ? ` ×${count}` : ''}`;
  status.tooltip = 'Watching for changes. Click to stop.';
  status.show();
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] ?? uri.path;
}
