import * as vscode from 'vscode';

import { generateComparison, generateFolderComparison } from '../../../core/src/build/generateLayout.ts';
import { formatLayout, type LayoutFile } from '../../../core/src/layout/layoutFile.ts';
import { createGitRevisionReader } from '../../../tools/src/git.ts';
import { isTrusted, requireTrust, settings } from '../machine.ts';
import { log } from '../output.ts';
import type { SelectionState } from '../selection.ts';
import { chooseFolder, ensureProjectFolder, layoutUriFor } from '../storage.ts';

/**
 * The visual diff commands.
 *
 * Select one thing, then compare a second thing against it — the same gesture
 * as VS Code's own compare, and it sits in the same menu group. Each command
 * writes a layout and then renders it, rather than rendering directly: same
 * code path as everything else, and it leaves behind a file the user can edit
 * when the pages do not line up.
 */

export async function selectForDiffCommand(state: SelectionState, uri?: vscode.Uri): Promise<void> {
  if (uri === undefined) return;

  const stat = await vscode.workspace.fs.stat(uri);
  const isFolder = stat.type === vscode.FileType.Directory;
  // Asking whether a file is tracked means starting git. Recording a selection
  // is too small a gesture to interrupt with a trust prompt, so an untrusted
  // folder simply offers no revision comparison.
  const inRepository = isFolder || !isTrusted() ? false : await createGitRevisionReader().isTracked(uri.fsPath);

  await state.set({ uri, isFolder, inRepository });
}

export async function compareWithSelectedCommand(state: SelectionState, uri?: vscode.Uri): Promise<void> {
  if (!(await requireTrust())) return;

  const selection = state.value;
  if (selection === undefined || uri === undefined) return;

  const stat = await vscode.workspace.fs.stat(uri);
  const isFolder = stat.type === vscode.FileType.Directory;

  if (isFolder !== selection.isFolder) {
    void vscode.window.showWarningMessage(
      'plotExcel compares a file with a file, or a folder with a folder — not one of each.',
    );
    return;
  }

  await buildAndRender(
    isFolder
      ? async (layoutDir) =>
          generateFolderComparison({
            left: selection.uri.fsPath,
            right: uri.fsPath,
            layoutDir,
            resolution: settings().defaultResolution,
            nPagesMax: settings().nPagesMax,
          })
      : async (layoutDir) =>
          generateComparison({
            first: selection.uri.fsPath,
            second: uri.fsPath,
            layoutDir,
            resolution: settings().defaultResolution,
          }),
    uri,
    `${basename(selection.uri)}-vs-${basename(uri)}`,
  );

  await state.clear();
}

/** Two files picked together in the Explorer: no stored selection needed. */
export async function compareTwoSelectedCommand(_uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  if (!(await requireTrust())) return;

  const [first, second] = uris ?? [];
  if (first === undefined || second === undefined) {
    void vscode.window.showWarningMessage('Select exactly two files to compare them.');
    return;
  }

  await buildAndRender(
    async (layoutDir) =>
      generateComparison({
        first: first.fsPath,
        second: second.fsPath,
        layoutDir,
        resolution: settings().defaultResolution,
      }),
    first,
    `${basename(first)}-vs-${basename(second)}`,
  );
}

export async function compareWithRevisionCommand(state: SelectionState, uri?: vscode.Uri): Promise<void> {
  if (!(await requireTrust())) return;

  const target = uri ?? state.value?.uri;
  if (target === undefined) {
    void vscode.window.showWarningMessage('Select a plot first: right-click it and choose Select for Visual Diff.');
    return;
  }

  const git = createGitRevisionReader();
  const revisions = await git.listRevisions(target.fsPath, 40);

  if (revisions.length === 0) {
    void vscode.window.showWarningMessage(
      `${basename(target)} has no history in git, so there is no earlier version to compare against.`,
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    revisions.map((revision) => ({
      label: revision.subject,
      description: `${revision.shortHash}  ${revision.date}`,
      detail: revision.author,
      revision,
    })),
    { placeHolder: `Compare ${basename(target)} against which version?`, matchOnDescription: true },
  );

  if (picked === undefined) return;

  await buildAndRender(
    async (layoutDir) =>
      generateComparison({
        first: target.fsPath,
        commit: picked.revision.hash,
        layoutDir,
        resolution: settings().defaultResolution,
      }),
    target,
    `${basename(target)}-vs-${picked.revision.shortHash}`,
  );

  await state.clear();
}

// ------------------------------------------------------------------------- //

async function buildAndRender(
  build: (layoutDir: string) => Promise<{ layout: LayoutFile }> | { layout: LayoutFile },
  near: vscode.Uri,
  name: string,
): Promise<void> {
  const folder = await chooseFolder(near);
  if (folder === undefined) return;

  const paths = await ensureProjectFolder(folder);
  const destination = await layoutUriFor(paths, name);
  const layoutDir = vscode.Uri.joinPath(destination, '..').fsPath;

  const generated = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'plotExcel: preparing comparison…' },
    async () => build(layoutDir),
  );

  await vscode.workspace.fs.writeFile(destination, Buffer.from(formatLayout(generated.layout), 'utf8'));
  log().info(`Comparison layout written to ${vscode.workspace.asRelativePath(destination)}.`);

  await vscode.commands.executeCommand('plotexcel.render', destination);
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/').filter((part) => part.length > 0);
  const last = parts[parts.length - 1] ?? 'plot';
  return last.replace(/\.[^.]+$/, '');
}
