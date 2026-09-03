import * as vscode from 'vscode';

import { cacheStats, clearCache, formatBytes } from '../../../core/src/pipeline/cache.ts';
import { summarise } from '../../../tools/src/discover.ts';
import { forgetMachine, machine } from '../machine.ts';
import { log, show } from '../output.ts';
import { chooseFolder, filesUnder, PLOTEXCEL_DIR, projectPaths, totalSize } from '../storage.ts';

/**
 * Clear Cache, Clean Up the Project Folder, and Check My Setup.
 *
 * These exist because of how people actually get stuck: a workbook that will
 * not update, a folder Windows will not delete, and a workbook full of
 * placeholders. The first is almost always a stale cache; the second is a
 * workbook still open in Excel; the third is always a missing tool. Each
 * deserves a command that says plainly what happened.
 */

/**
 * Whether the "your cache is filling up" notice has already been shown.
 *
 * Once per window, not once per render. At steady state the cache sits just
 * under its limit — that is what a size-capped cache does — so a notice that
 * fired every time would be a notice nobody reads.
 */
let toldAboutSize = false;

export async function clearCacheCommand(): Promise<void> {
  const before = await cacheStats();

  if (before.files === 0) {
    toldAboutSize = false;
    void vscode.window.showInformationMessage('plotExcel: the cache is already empty.');
    return;
  }

  const confirm = `Clear ${formatBytes(before.bytes)}`;
  const choice = await vscode.window.showWarningMessage(
    `Clear the plotExcel cache? ${before.files} files, ${formatBytes(before.bytes)}. ` +
      'Everything is rebuilt from the plots the next time you render.',
    { modal: true },
    confirm,
  );

  if (choice !== confirm) return;

  const { files, bytes } = await clearCache();
  toldAboutSize = false;
  log().info(`Cleared ${files} cache files, freeing ${formatBytes(bytes)}.`);
  void vscode.window.showInformationMessage(`plotExcel: cleared ${files} files, freeing ${formatBytes(bytes)}.`);
}

/**
 * Delete what plotExcel has written into the workspace.
 *
 * This exists because of a report that `.plotexcel` could not be deleted at
 * all: Windows answered "you'll need to provide administrator permission",
 * which sounds like a permissions problem and is not one. The extension writes
 * everything there through the ordinary filesystem API and sets no ACLs. What
 * happens is that rendering opens the workbook — `openAfterRender` is on by
 * default — Excel takes an exclusive lock on it and drops a hidden `~$` file
 * beside it, and Explorer, asked to delete a whole tree with a locked Office
 * file inside, reports it as needing an administrator rather than as a lock.
 *
 * So: delete it from in here, one file at a time, and when a file will not go,
 * name it and say why. That is the whole value of the command — a message
 * someone can act on instead of a dialog that blames the wrong thing.
 */
export async function cleanProjectCommand(): Promise<void> {
  const folder = await chooseFolder();
  if (folder === undefined) return;

  const paths = projectPaths(folder);
  const workbooks = await filesUnder(paths.out);
  const layouts = await filesUnder(paths.layouts);
  const loose = (await filesUnder(paths.base, false)).filter((file) => !file.path.endsWith('/.gitignore'));

  if (workbooks.length + layouts.length + loose.length === 0) {
    void vscode.window.showInformationMessage(
      `plotExcel: there is nothing to clean up in ${PLOTEXCEL_DIR}.`,
    );
    return;
  }

  const workbookSize = await totalSize(workbooks);
  const everything = 'Delete everything';
  const justWorkbooks = `Delete ${workbooks.length} workbook${workbooks.length === 1 ? '' : 's'}`;

  // Layouts are generated and then edited by hand, so they are never the
  // default thing to throw away — the workbooks are rebuilt by one render.
  const choice = await vscode.window.showWarningMessage(
    `${PLOTEXCEL_DIR} holds ${workbooks.length} workbook${workbooks.length === 1 ? '' : 's'} ` +
      `(${formatBytes(workbookSize)}) and ${layouts.length} layout${layouts.length === 1 ? '' : 's'}. ` +
      'Workbooks are rebuilt by rendering again; layouts are files you may have edited.',
    { modal: true },
    ...(workbooks.length > 0 ? [justWorkbooks] : []),
    everything,
  );

  if (choice === undefined) return;

  const targets = choice === everything ? [...workbooks, ...layouts, ...loose] : workbooks;
  const failures: { uri: vscode.Uri; reason: string }[] = [];
  let deleted = 0;

  // One at a time rather than one recursive delete of the folder: a recursive
  // delete fails as a whole and names nothing, and the file that is stuck is
  // the only thing worth knowing.
  for (const target of targets) {
    try {
      await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
      deleted += 1;
    } catch (error) {
      failures.push({ uri: target, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (choice === everything && failures.length === 0) {
    // Only once the files are gone, and never with `recursive` on a folder that
    // still holds something somebody wanted. The base goes last and takes the
    // `.gitignore` with it, because "delete everything" means the folder is not
    // there any more — the next render makes it again.
    for (const directory of [paths.out, paths.layouts, paths.base]) {
      await vscode.workspace.fs.delete(directory, { recursive: true, useTrash: false }).then(
        () => undefined,
        () => undefined,
      );
    }
  }

  log().info(`Cleaned ${deleted} file(s) from ${PLOTEXCEL_DIR}.`);
  await reportFailures(deleted, failures);
}

/**
 * Say what would not delete, and what that means.
 *
 * A hidden `~$plots.xlsx` is Excel's lock file and nobody recognises the name,
 * so it is reported as the workbook it belongs to.
 */
async function reportFailures(deleted: number, failures: readonly { uri: vscode.Uri; reason: string }[]): Promise<void> {
  if (failures.length === 0) {
    void vscode.window.showInformationMessage(`plotExcel: deleted ${deleted} file${deleted === 1 ? '' : 's'}.`);
    return;
  }

  for (const failure of failures) log().warn(`Could not delete ${failure.uri.fsPath}: ${failure.reason}`);

  const names = [...new Set(failures.map((failure) => ownerOf(basenameOf(failure.uri))))];
  const listed = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  const details = 'Show details';

  const choice = await vscode.window.showWarningMessage(
    `plotExcel: deleted ${deleted} file${deleted === 1 ? '' : 's'}, but ${listed}${more} ` +
      `${names.length === 1 ? 'is' : 'are'} still open in another program — Excel keeps a lock on a workbook ` +
      'for as long as it is open. Windows reports that as needing administrator permission, which is why ' +
      'Explorer will not delete the folder either. Close it and run this again.',
    details,
  );

  if (choice === details) show();
}

function basenameOf(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? uri.path;
}

function ownerOf(name: string): string {
  return name.startsWith('~$') ? name.slice(2) : name;
}

/**
 * Say when the cache is close to its limit, and offer the way out.
 *
 * The cache lives in the system temp folder, where nothing reliably cleans it:
 * Windows does not empty %TEMP% on reboot, and closing the editor does
 * nothing. The size cap means it cannot grow without bound, but a gigabyte of
 * someone's disk is still a gigabyte, and they should be the one deciding
 * whether to keep it. So: tell them where it stands, and put the command one
 * click away rather than asking them to find it.
 */
export async function warnIfCacheIsFilling(limitMB: number, warnAtPercent: number): Promise<void> {
  if (toldAboutSize || warnAtPercent <= 0 || limitMB <= 0) return;

  const limitBytes = limitMB * 1024 * 1024;
  const stats = await cacheStats();
  if (stats.bytes < limitBytes * (warnAtPercent / 100)) return;

  toldAboutSize = true;

  const clear = 'Clear cache';
  const settings = 'Change the limit';
  const never = "Don't tell me again";

  const choice = await vscode.window.showInformationMessage(
    `plotExcel: the render cache holds ${formatBytes(stats.bytes)} of its ${formatBytes(limitBytes)} limit ` +
      `in ${stats.root}. Clearing it frees that space; the next render is slower while it refills.`,
    clear,
    settings,
    never,
  );

  if (choice === clear) await clearCacheCommand();
  if (choice === settings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'plotexcel.cacheSizeLimitMB');
  }
  if (choice === never) {
    await vscode.workspace
      .getConfiguration('plotexcel')
      .update('cacheWarnAtPercent', 0, vscode.ConfigurationTarget.Global);
  }
}

/**
 * Report what this machine can do, in words rather than tool names.
 *
 * Run automatically the first time the extension is used, so the limits are
 * known before the first confused rebuild rather than after it.
 */
export async function checkSetupCommand(options: { readonly quiet?: boolean } = {}): Promise<void> {
  forgetMachine();
  const { report } = await machine();

  log().info('Setup:');
  for (const line of summarise(report).split('\n')) log().info(`  ${line}`);

  const missing = report.filter((entry) => entry.status === 'missing');
  const cache = await cacheStats();
  log().info(`  cache: ${cache.files} files, ${formatBytes(cache.bytes)} in ${cache.root}`);

  if (options.quiet === true && missing.length === 0) return;

  const details = 'Show details';

  if (missing.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'plotExcel: everything is available on this machine — PDF and image plots, Office documents, HTML and git.',
      details,
    );
    if (choice === details) show();
    return;
  }

  const first = missing[0]!;
  const rest = missing.length > 1 ? ` (and ${missing.length - 1} more)` : '';

  const choice = await vscode.window.showWarningMessage(
    `plotExcel: ${first.title} unavailable${rest}. ${first.advice ?? ''}`,
    details,
  );
  if (choice === details) show();
}
