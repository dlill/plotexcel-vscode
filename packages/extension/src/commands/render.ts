import * as vscode from 'vscode';

import { NoPdfExporterError, pdfPathFor, workbookToPdf } from '../../../core/src/build/exportPdf.ts';
import { renderLayout, resolveOutputPath } from '../../../core/src/build/renderLayout.ts';
import { CancelledError } from '../../../core/src/pipeline/limit.ts';
import { formatBytes, pruneCache } from '../../../core/src/pipeline/cache.ts';
import { warnIfCacheIsFilling } from './maintenance.ts';
import { countPlanned, loadLayout, resolveLayoutUri } from '../layouts.ts';
import { concurrency, machine, requireTrust, settings } from '../machine.ts';
import { log, logRender, show } from '../output.ts';
import { chooseFolder, defaultOutputFor, ensureProjectFolder } from '../storage.ts';

/**
 * Render a layout into a workbook.
 *
 * The command everything else leads to. Three things it does that are easy to
 * leave out and painful to add later: it asks before a run that will take
 * minutes, it can be cancelled, and when cells fail it says so in a
 * notification rather than only in a log nobody opens.
 */
export async function renderCommand(uri?: vscode.Uri, options: { readonly force?: boolean } = {}): Promise<void> {
  if (!(await requireTrust())) return;

  const layoutUri = await resolveLayoutUri(uri);
  if (layoutUri === undefined) return;

  const loaded = await loadLayout(layoutUri);
  if (loaded === undefined) return;

  const configuration = settings();
  const planned = countPlanned(loaded.layout);

  if (planned > configuration.confirmAbovePageCount) {
    const go = 'Render anyway';
    const choice = await vscode.window.showWarningMessage(
      `This layout has ${planned} cells to render, which will take a while.`,
      { modal: false },
      go,
    );
    if (choice !== go) return;
  }

  const folder = await chooseFolder(layoutUri);
  const paths = folder === undefined ? undefined : await ensureProjectFolder(folder);

  const declaredOutput = resolveOutputPath(loaded.layout, layoutUri.fsPath);
  const usesDefault = loaded.layout.options.output === undefined;
  const outputPath =
    usesDefault && paths !== undefined
      ? defaultOutputFor(paths, basename(layoutUri)).fsPath
      : declaredOutput;

  const { tools, report } = await machine();
  const controller = new AbortController();

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `plotExcel: ${basename(layoutUri)}`,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());

        return renderLayout(loaded.layout, {
          layoutPath: layoutUri.fsPath,
          outputPath,
          tools,
          concurrency: concurrency(),
          force: options.force === true,
          signal: controller.signal,
          onProgress: (event) => {
            progress.report({
              increment: 100 / Math.max(1, event.total),
              message: `${event.completed}/${event.total} ${event.label}${event.fromCache === true ? ' (cached)' : ''}`,
            });
          },
        });
      },
    );

    await vscode.workspace.fs.writeFile(vscode.Uri.file(result.outputPath), result.workbook);
    logRender(vscode.workspace.asRelativePath(layoutUri), result);

    if (loaded.layout.options.pdf === true) {
      await alsoExportPdf(result.outputPath, result.workbook, tools, loaded.layout.options.pdfPageSize ?? 'single');
    }

    void pruneCache(configuration.cacheSizeLimitMB * 1024 * 1024)
      .then(({ removed, freed }) => {
        if (removed > 0) log().debug(`Pruned ${removed} cache files, freeing ${formatBytes(freed)}.`);
      })
      // After pruning, not before: the number in the notice should be the one
      // that is actually on disk now.
      .then(() => warnIfCacheIsFilling(configuration.cacheSizeLimitMB, configuration.cacheWarnAtPercent));

    await announce(result.outputPath, result.images + result.diffs, result.issues.length, report, configuration);
  } catch (error) {
    if (error instanceof CancelledError) {
      void vscode.window.showInformationMessage('plotExcel: render cancelled. Nothing was written.');
      return;
    }

    log().error(error instanceof Error ? error : String(error));
    const details = 'Show details';
    const choice = await vscode.window.showErrorMessage(
      `plotExcel could not finish: ${error instanceof Error ? error.message : String(error)}`,
      details,
    );
    if (choice === details) show();
  }
}

/**
 * The R package's FLAGpdf: a whole-sheet view while drafting, because a
 * spreadsheet is a poor way to look at forty plots at once.
 */
async function alsoExportPdf(
  workbookPath: string,
  workbook: Buffer,
  tools: Parameters<typeof workbookToPdf>[1],
  pageSize: 'single' | 'A4',
): Promise<void> {
  try {
    const pdf = await workbookToPdf(workbook, tools, pageSize);
    const target = vscode.Uri.file(pdfPathFor(workbookPath));
    await vscode.workspace.fs.writeFile(target, pdf);
    log().info(`Also wrote ${target.fsPath}`);
    await vscode.env.openExternal(target);
  } catch (error) {
    if (error instanceof NoPdfExporterError) {
      void vscode.window.showWarningMessage(`plotExcel: ${error.message}`);
      return;
    }
    log().warn(`PDF export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function announce(
  outputPath: string,
  images: number,
  issues: number,
  report: readonly { status: string; title: string }[],
  configuration: ReturnType<typeof settings>,
): Promise<void> {
  const target = vscode.Uri.file(outputPath);
  const missing = report.filter((entry) => entry.status === 'missing').length;

  const open = 'Open';
  const reveal = 'Reveal in File Explorer';
  const details = 'Show details';

  const actions = issues > 0 ? [open, details] : [open, reveal];
  const summary =
    issues > 0
      ? `Rendered ${images} cells, ${issues} could not be produced.`
      : `Rendered ${images} cells into ${basenameOf(outputPath)}.`;

  if (configuration.openAfterRender && issues === 0) {
    await vscode.env.openExternal(target);
  }

  const choice = await vscode.window.showInformationMessage(
    missing > 0 && issues > 0 ? `${summary} Some tools are missing on this machine.` : summary,
    ...actions,
  );

  if (choice === open) await vscode.env.openExternal(target);
  else if (choice === reveal) await vscode.commands.executeCommand('revealFileInOS', target);
  else if (choice === details) show();
}

function basename(uri: vscode.Uri): string {
  return basenameOf(uri.path);
}

function basenameOf(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}
