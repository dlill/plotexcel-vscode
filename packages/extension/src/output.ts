import * as vscode from 'vscode';

import type { RenderLayoutResult } from '../../core/src/build/renderLayout.ts';

/**
 * The output channel.
 *
 * Two rules keep it useful. Everything that failed is written here in full,
 * because a notification can hold one sentence and a run can have twenty
 * problems. And nothing that failed is written *only* here — the channel is
 * where someone goes for detail, never how they find out.
 */

let channel: vscode.LogOutputChannel | undefined;

export function log(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('plotExcel', { log: true });
  return channel;
}

export function show(): void {
  log().show(true);
}

/** Write everything worth keeping about a render, in the order it happened. */
export function logRender(layoutPath: string, result: RenderLayoutResult): void {
  const out = log();

  out.info(
    `${layoutPath}: ${result.images} plots, ${result.diffs} diffs, ${result.cacheHits} from cache, ` +
      `${(result.elapsedMs / 1000).toFixed(1)}s -> ${result.outputPath}`,
  );

  for (const issue of result.issues) {
    const where = `row ${issue.row}, ${issue.columnName.length > 0 ? issue.columnName : `column ${issue.column}`}`;
    out.warn(`${where}: ${issue.issue.headline}`);
    for (const detail of issue.issue.details) out.warn(`    ${detail}`);
    if (issue.issue.cause !== undefined) out.debug(`    (${issue.issue.cause})`);
    out.debug(`    cell: ${issue.cell}`);
  }
}
