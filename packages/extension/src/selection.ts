import * as vscode from 'vscode';

/**
 * The "selected for visual diff" state, and the status bar item that makes it
 * visible.
 *
 * VS Code's own compare selection is invisible once made, which is exactly why
 * people forget what they picked and get a baffling comparison. This one shows
 * what is selected, offers to clear it in one click, and is deliberately not
 * restored across window reloads: a selection from three days ago is never
 * what anybody meant.
 */

export interface DiffSelection {
  readonly uri: vscode.Uri;
  readonly isFolder: boolean;
}

export class SelectionState {
  private current: DiffSelection | undefined;
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('plotexcel.selection', vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'plotexcel.clearDiffSelection';
    this.item.name = 'plotExcel diff selection';
    void this.publish();
  }

  get value(): DiffSelection | undefined {
    return this.current;
  }

  async set(selection: DiffSelection): Promise<void> {
    this.current = selection;
    await this.publish();
  }

  async clear(): Promise<void> {
    this.current = undefined;
    await this.publish();
  }

  dispose(): void {
    this.item.dispose();
  }

  /**
   * Context keys drive which menu entries appear. Keeping them in one place
   * means the menu can never disagree with the state it is describing.
   */
  private async publish(): Promise<void> {
    const selection = this.current;

    await vscode.commands.executeCommand('setContext', 'plotexcel.hasSelection', selection !== undefined);
    await vscode.commands.executeCommand('setContext', 'plotexcel.selectionIsFolder', selection?.isFolder ?? false);

    if (selection === undefined) {
      this.item.hide();
      return;
    }

    const name = basename(selection.uri);
    this.item.text = `$(diff) ${name}`;
    this.item.tooltip = new vscode.MarkdownString(
      `Selected for visual diff: \`${vscode.workspace.asRelativePath(selection.uri)}\`\n\n` +
        `Right-click ${selection.isFolder ? 'another folder' : 'another file'} and choose ` +
        '**Compare Visually with Selected**, or click here to clear.',
    );
    this.item.show();
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] ?? uri.path;
}
