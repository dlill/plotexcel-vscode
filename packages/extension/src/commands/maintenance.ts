import * as vscode from 'vscode';

import { cacheStats, clearCache, formatBytes } from '../../../core/src/pipeline/cache.ts';
import { summarise } from '../../../tools/src/discover.ts';
import { forgetMachine, machine } from '../machine.ts';
import { log, show } from '../output.ts';

/**
 * Clear Cache, and Check My Setup.
 *
 * These two exist because of how people actually get stuck: a workbook that
 * will not update, and a workbook full of placeholders. The first is almost
 * always a stale cache; the second is always a missing tool. Both deserve a
 * command that says plainly what happened.
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
