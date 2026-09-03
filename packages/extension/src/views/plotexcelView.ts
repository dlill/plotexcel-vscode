import * as vscode from 'vscode';

import { parseLayout } from '../../../core/src/layout/layoutFile.ts';
import { cacheStats, formatBytes } from '../../../core/src/pipeline/cache.ts';
import { findLayouts } from '../layouts.ts';
import { machine, settings } from '../machine.ts';
import { filesUnder, folderFor, PLOTEXCEL_DIR, projectPaths, totalSize } from '../storage.ts';

/**
 * A panel in the Explorer, for the people who will never find a command.
 *
 * Everything here is reachable from the palette and the right-click menu
 * already. It exists because the target audience does not know the palette
 * exists, and because "what can this machine do" and "what layouts are in this
 * project" are the two questions worth answering without being asked.
 */

type Node =
  | { readonly kind: 'section'; readonly id: 'layouts' | 'setup'; readonly label: string }
  | { readonly kind: 'layout'; readonly uri: vscode.Uri; readonly rows: number; readonly columns: number }
  | { readonly kind: 'empty'; readonly label: string; readonly command?: vscode.Command }
  | { readonly kind: 'capability'; readonly label: string; readonly detail: string; readonly ready: boolean }
  | { readonly kind: 'cache'; readonly label: string; readonly detail: string; readonly full: boolean }
  | { readonly kind: 'project'; readonly label: string; readonly detail: string };

export class PlotExcelView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = `plotexcel.${node.id}`;
        item.iconPath = new vscode.ThemeIcon(node.id === 'layouts' ? 'table' : 'settings-gear');
        return item;
      }

      case 'layout': {
        const item = new vscode.TreeItem(basename(node.uri), vscode.TreeItemCollapsibleState.None);
        item.description = `${node.rows} row${node.rows === 1 ? '' : 's'}, ${node.columns} columns`;
        item.resourceUri = node.uri;
        item.iconPath = new vscode.ThemeIcon('list-flat');
        item.contextValue = 'plotexcel.layout';
        item.tooltip = vscode.workspace.asRelativePath(node.uri);
        // Clicking opens it; rendering is a button on the row.
        item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
        return item;
      }

      case 'capability': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.detail;
        item.iconPath = new vscode.ThemeIcon(
          node.ready ? 'pass-filled' : 'warning',
          new vscode.ThemeColor(node.ready ? 'testing.iconPassed' : 'problemsWarningIcon.foreground'),
        );
        item.tooltip = node.detail;
        return item;
      }

      case 'cache': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.detail;
        item.iconPath = new vscode.ThemeIcon(
          'database',
          node.full ? new vscode.ThemeColor('problemsWarningIcon.foreground') : undefined,
        );
        item.command = { command: 'plotexcel.clearCache', title: 'Clear cache' };
        item.tooltip = node.full
          ? 'The cache is near its limit and the oldest entries are being dropped. Click to empty it.'
          : 'Click to empty the cache';
        return item;
      }

      case 'project': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.detail;
        item.iconPath = new vscode.ThemeIcon('folder-opened');
        item.command = { command: 'plotexcel.cleanProject', title: 'Clean up the project folder' };
        item.tooltip =
          'Click to delete what plotExcel has written here. Excel keeps a lock on a workbook while it is ' +
          'open, which is why Explorer can refuse to delete this folder and blame permissions.';
        return item;
      }

      default: {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('add');
        if (node.command !== undefined) item.command = node.command;
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) {
      return [
        { kind: 'section', id: 'layouts', label: 'Layouts' },
        { kind: 'section', id: 'setup', label: 'This computer' },
      ];
    }

    if (node.kind !== 'section') return [];
    return node.id === 'layouts' ? this.layouts() : this.setup();
  }

  private async layouts(): Promise<Node[]> {
    const found = await findLayouts();

    if (found.length === 0) {
      return [
        {
          kind: 'empty',
          label: 'Generate one from a folder of plots',
          command: { command: 'plotexcel.generateLayout', title: 'Generate Table Layout' },
        },
      ];
    }

    const nodes: Node[] = [];

    for (const uri of found.sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const { layout } = parseLayout(Buffer.from(bytes).toString('utf8'));
        nodes.push({ kind: 'layout', uri, rows: layout.rows.length, columns: layout.columns.length });
      } catch {
        nodes.push({ kind: 'layout', uri, rows: 0, columns: 0 });
      }
    }

    return nodes;
  }

  private async setup(): Promise<Node[]> {
    const { report } = await machine();
    const cache = await cacheStats();
    const limitBytes = settings().cacheSizeLimitMB * 1024 * 1024;

    return [
      ...report.map(
        (entry): Node => ({
          kind: 'capability',
          label: entry.title,
          detail:
            entry.status === 'ready'
              ? `${entry.provider}${entry.version === undefined ? '' : ` · ${entry.version}`}`
              : (entry.advice ?? 'not available'),
          ready: entry.status === 'ready',
        }),
      ),
      {
        kind: 'cache',
        label: `Cache: ${formatBytes(cache.bytes)} of ${formatBytes(limitBytes)}`,
        detail: `${cache.files} file${cache.files === 1 ? '' : 's'}`,
        full: cache.bytes >= limitBytes * 0.8,
      },
      ...(await this.projectFolder()),
    ];
  }

  /**
   * What plotExcel has written into the workspace, and one click to remove it.
   *
   * Shown only when there is something there — a row saying "0 B" is a row
   * nobody needs. It is the workbooks that are worth reporting: they are the
   * large files, and they are the ones Excel locks.
   */
  private async projectFolder(): Promise<Node[]> {
    const folder = folderFor();
    if (folder === undefined) return [];

    const workbooks = await filesUnder(projectPaths(folder).out);
    if (workbooks.length === 0) return [];

    return [
      {
        kind: 'project',
        label: `${PLOTEXCEL_DIR}: ${formatBytes(await totalSize(workbooks))}`,
        detail: `${workbooks.length} workbook${workbooks.length === 1 ? '' : 's'}`,
      },
    ];
  }
}

export function registerView(context: vscode.ExtensionContext): PlotExcelView {
  const view = new PlotExcelView();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('plotexcel.view', view),
    // The list is derived from files, so it follows them.
    watchLayouts(() => view.refresh()),
  );

  return view;
}

function watchLayouts(refresh: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.plotexcel.tsv');

  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);
  watcher.onDidChange(refresh);

  return watcher;
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return (parts[parts.length - 1] ?? uri.path).replace(/\.plotexcel\.tsv$/i, '');
}
