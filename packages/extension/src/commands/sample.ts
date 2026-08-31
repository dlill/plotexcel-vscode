import * as vscode from 'vscode';

import { SAMPLE_FOLDER, sampleProject } from '../../../core/src/samples/sampleProject.ts';
import { log } from '../output.ts';

/**
 * Write a small project that works, and open it.
 *
 * The first instruction anyone gives a new tool is "point it at your files",
 * and that is exactly the moment someone decides they will look at this later.
 * This removes it: a folder of plots, a layout that already uses page numbers,
 * a crop, a caption style and a comparison column, and a workbook about two
 * seconds later.
 *
 * It is also the most useful diagnostic in the extension. The plots are PDFs,
 * so if the sample renders, this machine can render anything.
 */
export async function openSampleCommand(): Promise<void> {
  const destination = await chooseDestination();
  if (destination === undefined) return;

  const project = sampleProject();

  const existing = await stat(destination);
  if (existing !== undefined) {
    const replace = 'Replace it';
    const choice = await vscode.window.showWarningMessage(
      `${vscode.workspace.asRelativePath(destination)} already exists. Its contents will be overwritten.`,
      { modal: true },
      replace,
    );
    if (choice !== replace) return;
  }

  await vscode.workspace.fs.createDirectory(destination);

  for (const file of project.files) {
    const target = vscode.Uri.joinPath(destination, ...file.path.split('/'));
    await vscode.workspace.fs.createDirectory(parentOf(target));
    await vscode.workspace.fs.writeFile(target, file.bytes);
  }

  const layout = vscode.Uri.joinPath(destination, project.layoutName);
  await vscode.workspace.fs.writeFile(layout, Buffer.from(project.layoutText, 'utf8'));

  log().info(`Wrote the sample project to ${destination.fsPath}.`);

  const document = await vscode.window.showTextDocument(layout, { preview: false });

  const render = 'Render it';
  const choice = await vscode.window.showInformationMessage(
    'A sample project, ready to render. Three documents, one image, and a column that compares two runs.',
    render,
  );

  if (choice === render) await vscode.commands.executeCommand('plotexcel.render', document.document.uri);
}

/**
 * Where the sample goes.
 *
 * Inside the workspace when there is one, because that is where the person
 * can find it again. Otherwise it has to be asked for — writing a folder of
 * files somewhere unannounced is not a thing to do quietly.
 */
async function chooseDestination(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (folders.length === 1) return vscode.Uri.joinPath(folders[0]!.uri, SAMPLE_FOLDER);

  if (folders.length > 1) {
    const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Where should the sample go?' });
    return picked === undefined ? undefined : vscode.Uri.joinPath(picked.uri, SAMPLE_FOLDER);
  }

  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Put the sample here',
    title: 'plotExcel sample project',
  });

  return chosen?.[0] === undefined ? undefined : vscode.Uri.joinPath(chosen[0], SAMPLE_FOLDER);
}

/** Open the walkthrough, which is otherwise only reachable from the Welcome page. */
export async function openWalkthroughCommand(): Promise<void> {
  await vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    'dlill.plotexcel#plotexcel.gettingStarted',
    false,
  );
}

async function stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

function parentOf(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}
