import * as vscode from 'vscode';

import { defaultCacheRoot } from '../../../core/src/cache/keys.ts';
import { setCrop } from '../../../core/src/layout/editCell.ts';
import { parseLayout } from '../../../core/src/layout/layoutFile.ts';
import { renderPlot } from '../../../core/src/pipeline/renderPlot.ts';
import { classifyCell, plotExtensionOf } from '../../../core/src/spec/classify.ts';
import { parsePlotSpec } from '../../../core/src/spec/plotSpec.ts';
import type { PlotSpec } from '../../../core/src/types.ts';
import { cellAt, headerLine, rangeOf } from '../language/cells.ts';
import { machine, requireTrust, settings } from '../machine.ts';
import { log } from '../output.ts';

/**
 * Seeing a plot before it reaches a workbook.
 *
 * Every question while writing a layout is visual — is this the right page,
 * did the crop take the legend with it — and the slowest possible way to
 * answer one is to render the whole workbook and open Excel. These commands
 * render a single cell, which is nearly always already cached, and show it.
 */

/** Right-click a plot file: render its first page and open it. */
export async function quickLookCommand(uri?: vscode.Uri): Promise<void> {
  if (uri === undefined) return;
  if (plotExtensionOf(uri.fsPath) === undefined) {
    void vscode.window.showWarningMessage('plotExcel does not know how to render that kind of file.');
    return;
  }

  const spec = parsePlotSpec(`${uri.fsPath}::resolution ${settings().defaultResolution}`);
  await previewSpec(spec, undefined);
}

/** With the cursor in a plot cell: render exactly that cell, crop and all. */
export async function previewCellCommand(): Promise<void> {
  const found = plotCellUnderCursor();
  if (found === undefined) return;

  await previewSpec(found.spec, found.baseDir);
}

async function previewSpec(spec: PlotSpec, baseDir: string | undefined): Promise<void> {
  if (!(await requireTrust())) return;

  const { tools } = await machine();

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'plotExcel: rendering…' },
    async () =>
      renderPlot(spec, {
        cacheRoot: defaultCacheRoot(),
        tools,
        ...(baseDir === undefined ? {} : { baseDir }),
      }),
  );

  if (result.issue !== undefined) {
    void vscode.window.showWarningMessage(`plotExcel: ${result.issue.headline}. ${result.issue.details.join(' ')}`);
    return;
  }

  // The cached PNG is a real file on disk, so the built-in image viewer can
  // open it — no webview, no copy, and it is the same pixels the workbook gets.
  const target = result.cachePath === undefined ? await scratchCopy(result.png) : vscode.Uri.file(result.cachePath);
  await vscode.commands.executeCommand('vscode.open', target, { preview: true, viewColumn: vscode.ViewColumn.Beside });

  log().info(
    `Preview: ${spec.path} page ${spec.page} at ${result.dpi} dpi, ` +
      `${result.widthCm.toFixed(1)} × ${result.heightCm.toFixed(1)} cm${result.fromCache ? ' (cached)' : ''}`,
  );
}

async function scratchCopy(png: Buffer): Promise<vscode.Uri> {
  const target = vscode.Uri.joinPath(vscode.Uri.file(defaultCacheRoot()), 'preview', `${Date.now()}.png`);
  await vscode.workspace.fs.writeFile(target, png);
  return target;
}

// ------------------------------------------------------------------------- //
// Crop assistant
// ------------------------------------------------------------------------- //

/**
 * Crop by dragging, rather than by guessing percentages.
 *
 * `::xmin 12::xmax 88` is exact, reproducible and completely opaque to write
 * by hand — you crop by rendering, squinting, and adjusting. This renders the
 * page once, lets you drag a rectangle over it, and writes the four numbers
 * back into the cell. The layout file stays the source of truth; the panel is
 * only a nicer way to type into it.
 */
export async function cropAssistantCommand(context: vscode.ExtensionContext): Promise<void> {
  if (!(await requireTrust())) return;

  const found = plotCellUnderCursor();
  if (found === undefined) return;

  const { tools } = await machine();

  // Render the whole page, uncropped: the rectangle is drawn on the full page
  // even when the cell already carries a crop.
  const full = { ...found.spec, xmin: 0, xmax: 100, ymin: 0, ymax: 100 };

  const rendered = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'plotExcel: rendering the page…' },
    async () => renderPlot(full, { cacheRoot: defaultCacheRoot(), tools, baseDir: found.baseDir }),
  );

  if (rendered.issue !== undefined) {
    void vscode.window.showWarningMessage(`plotExcel: ${rendered.issue.headline}. ${rendered.issue.details.join(' ')}`);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'plotexcel.crop',
    `Crop ${basename(found.spec.path)}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  );

  context.subscriptions.push(panel);
  panel.webview.html = cropPage(panel.webview, rendered.png.toString('base64'), found.spec);

  panel.webview.onDidReceiveMessage(async (message: { type: string; crop?: Crop }) => {
    if (message.type !== 'apply' || message.crop === undefined) {
      if (message.type === 'close') panel.dispose();
      return;
    }

    await applyCrop(found.document, found.line, found.column, message.crop);
    panel.dispose();
  });
}

interface Crop {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/** Rewrite the cell's crop options, leaving everything else in it alone. */
async function applyCrop(
  document: vscode.TextDocument,
  line: number,
  column: number,
  crop: Crop,
): Promise<void> {
  const cell = cellAt(document.lineAt(line).text, column);
  if (cell === undefined) return;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, rangeOf(line, cell), setCrop(cell.text, crop));
  await vscode.workspace.applyEdit(edit);
}

/** Exported so the panel can be rendered and looked at outside VS Code. */
export function cropPage(webview: vscode.Webview, base64: string, spec: PlotSpec): string {
  const nonce = String(Date.now());
  const start = JSON.stringify({ xmin: spec.xmin, xmax: spec.xmax, ymin: spec.ymin, ymax: spec.ymax });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    margin: 0; padding: 12px; font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    display: flex; flex-direction: column; gap: 10px; height: 100vh; box-sizing: border-box;
  }
  #stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
  #frame { position: relative; line-height: 0; box-shadow: 0 0 0 1px var(--vscode-panel-border); }
  img { max-width: 100%; max-height: 100%; display: block; user-select: none; -webkit-user-drag: none; }
  #window {
    position: absolute; border: 1px solid var(--vscode-focusBorder);
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.45); cursor: move;
  }
  .grip {
    position: absolute; width: 12px; height: 12px; background: var(--vscode-focusBorder);
    border-radius: 2px;
  }
  .grip.nw { left: -6px; top: -6px; cursor: nwse-resize; }
  .grip.ne { right: -6px; top: -6px; cursor: nesw-resize; }
  .grip.sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
  .grip.se { right: -6px; bottom: -6px; cursor: nwse-resize; }
  footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  code {
    font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background);
    padding: 2px 6px; border-radius: 3px; font-size: 12px;
  }
  button {
    font-family: inherit; font-size: 13px; padding: 4px 12px; border: none; border-radius: 2px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .hint { opacity: 0.7; font-size: 12px; }
</style>
</head>
<body>
  <div id="stage"><div id="frame">
    <img id="page" src="data:image/png;base64,${base64}" alt="page">
    <div id="window"><div class="grip nw"></div><div class="grip ne"></div><div class="grip sw"></div><div class="grip se"></div></div>
  </div></div>
  <footer>
    <code id="readout"></code>
    <span class="hint">Drag inside to move, corners to resize. Double-click to reset.</span>
    <span style="flex:1"></span>
    <button class="secondary" id="cancel">Cancel</button>
    <button id="apply">Apply crop</button>
  </footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  const box = document.getElementById('window');
  const readout = document.getElementById('readout');
  let crop = ${start};

  const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));

  function draw() {
    box.style.left = crop.xmin + '%';
    box.style.top = crop.ymin + '%';
    box.style.width = (crop.xmax - crop.xmin) + '%';
    box.style.height = (crop.ymax - crop.ymin) + '%';
    readout.textContent = '::xmin ' + crop.xmin + '::xmax ' + crop.xmax + '::ymin ' + crop.ymin + '::ymax ' + crop.ymax;
  }

  function percentOf(event) {
    const rect = frame.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 100),
      y: clamp(((event.clientY - rect.top) / rect.height) * 100),
    };
  }

  let drag = null;

  box.addEventListener('pointerdown', (event) => {
    const grip = event.target.classList.contains('grip') ? event.target.classList[1] : 'move';
    drag = { grip, from: percentOf(event), start: { ...crop } };
    box.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  // Starting a drag on the page itself draws a new window, which is what you
  // want when the current one is somewhere unhelpful.
  frame.addEventListener('pointerdown', (event) => {
    if (event.target === box || event.target.classList.contains('grip')) return;
    const at = percentOf(event);
    crop = { xmin: at.x, xmax: at.x, ymin: at.y, ymax: at.y };
    drag = { grip: 'se', from: at, start: { ...crop } };
    frame.setPointerCapture(event.pointerId);
    draw();
  });

  function move(event) {
    if (drag === null) return;
    const at = percentOf(event);
    const dx = at.x - drag.from.x;
    const dy = at.y - drag.from.y;
    const s = drag.start;

    if (drag.grip === 'move') {
      const width = s.xmax - s.xmin;
      const height = s.ymax - s.ymin;
      const left = clamp(Math.min(100 - width, s.xmin + dx));
      const top = clamp(Math.min(100 - height, s.ymin + dy));
      crop = { xmin: left, xmax: left + width, ymin: top, ymax: top + height };
    } else {
      const left = drag.grip.includes('w') ? clamp(s.xmin + dx) : s.xmin;
      const right = drag.grip.includes('e') ? clamp(s.xmax + dx) : s.xmax;
      const top = drag.grip.includes('n') ? clamp(s.ymin + dy) : s.ymin;
      const bottom = drag.grip.includes('s') ? clamp(s.ymax + dy) : s.ymax;
      crop = {
        xmin: Math.min(left, right), xmax: Math.max(left, right),
        ymin: Math.min(top, bottom), ymax: Math.max(top, bottom),
      };
    }

    draw();
  }

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', () => { drag = null; });
  frame.addEventListener('dblclick', () => { crop = { xmin: 0, xmax: 100, ymin: 0, ymax: 100 }; draw(); });

  document.getElementById('apply').addEventListener('click', () => {
    // A zero-width window is a mis-click, not a crop.
    if (crop.xmax - crop.xmin < 1 || crop.ymax - crop.ymin < 1) return;
    vscode.postMessage({ type: 'apply', crop });
  });
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'close' }));

  draw();
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------------- //

interface CellUnderCursor {
  readonly document: vscode.TextDocument;
  readonly line: number;
  readonly column: number;
  readonly spec: PlotSpec;
  readonly baseDir: string;
}

/** The plot cell the cursor is in, with a message rather than silence if not. */
export function plotCellUnderCursor(): CellUnderCursor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return undefined;

  const document = editor.document;
  const position = editor.selection.active;
  const line = document.lineAt(position.line).text;

  if (line.startsWith('#') || position.line === headerLine(document)) {
    void vscode.window.showInformationMessage('Put the cursor in a cell that holds a plot.');
    return undefined;
  }

  const cell = cellAt(line, position.character);
  if (cell === undefined) return undefined;

  const { layout } = parseLayout(document.getText());
  const defaults = layout.options.resolution === undefined ? {} : { resolution: layout.options.resolution };

  try {
    const classified = classifyCell(cell.text, { defaults });
    if (classified.kind !== 'plot') {
      void vscode.window.showInformationMessage('That cell does not hold a plot.');
      return undefined;
    }

    return {
      document,
      line: position.line,
      column: position.character,
      spec: classified.spec,
      baseDir: vscode.Uri.joinPath(document.uri, '..').fsPath,
    };
  } catch (error) {
    void vscode.window.showWarningMessage(`plotExcel: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}
