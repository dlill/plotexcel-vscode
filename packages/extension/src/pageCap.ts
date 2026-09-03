import * as vscode from 'vscode';

import { settings } from './machine.ts';
import { log, show } from './output.ts';

/**
 * Saying out loud that the page cap fired.
 *
 * `plotexcel.nPagesMax` is the one setting that can quietly make a layout
 * wrong: a seven-page report came out as four rows, which looks exactly like
 * plotExcel having misread the file. The count was right all along and the cap
 * was doing its job — in silence, which is the bug.
 *
 * So every command that caps says how many of how many it took, names the
 * setting, and offers to open it. The commands that generate a whole layout can
 * also offer to do it again with no cap at all, because there the answer is one
 * click away rather than a setting change and a re-run.
 *
 * `DiscoveredFile` from the layout generator satisfies this shape, so a
 * generated layout's `truncated` list can be passed straight in.
 */
export interface CappedFile {
  readonly relativePath: string;
  /** Pages actually taken. */
  readonly included: number;
  /** Pages the file really has. */
  readonly pages: number;
}

const SETTING = 'plotexcel.nPagesMax';

/** Answers true when the person asked for every page after all. */
export async function offerAllPages(capped: readonly CappedFile[], offerRetake: boolean): Promise<boolean> {
  if (capped.length === 0) return false;

  // In the log unconditionally: a notification holds one sentence, and this can
  // be twenty files.
  log().warn(`The ${SETTING} setting cut ${capped.length} file(s) short:`);
  for (const file of capped) log().warn(`    ${file.relativePath}: took ${file.included} of ${file.pages} pages`);

  const first = capped[0]!;
  const rest =
    capped.length === 1 ? '' : ` (and ${capped.length - 1} more file${capped.length === 2 ? '' : 's'})`;

  const takeAll = 'Take all pages';
  const change = 'Change the setting';
  const details = 'Show details';

  const choice = await vscode.window.showWarningMessage(
    `plotExcel: took ${first.included} of ${first.pages} pages from ${first.relativePath}${rest}, ` +
      `because ${SETTING} is ${settings().nPagesMax}. Change that setting to keep every page from now on.`,
    ...(offerRetake ? [takeAll] : []),
    change,
    details,
  );

  if (choice === change) await vscode.commands.executeCommand('workbench.action.openSettings', SETTING);
  if (choice === details) show();

  return choice === takeAll;
}
