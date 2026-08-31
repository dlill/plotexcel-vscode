import path from 'node:path';

import * as vscode from 'vscode';

import { resolveOutputPath, workbookNamePattern } from '../../../core/src/build/renderLayout.ts';
import { countPages } from '../../../core/src/documents/pageCount.ts';
import { removeOption, renumberCaption, setOption } from '../../../core/src/layout/editCell.ts';
import { formatLayout, isLayoutFile, parseLayout, type LayoutFile } from '../../../core/src/layout/layoutFile.ts';
import { plotExtensionOf } from '../../../core/src/spec/classify.ts';
import { columnNames } from '../language/cells.ts';
import { resolveLayoutUri } from '../layouts.ts';
import { settings } from '../machine.ts';
import { log } from '../output.ts';
import { plotCellUnderCursor } from './preview.ts';

/**
 * Editing a layout without typing the syntax.
 *
 * The format is deliberately plain text, and plain text is only pleasant to
 * edit once the tedious parts are automated. Each of these does something that
 * is obvious to want and irritating to do by hand: add a file that lives three
 * folders away, give every row a comparison column, expand a multi-page PDF
 * into one row per page.
 *
 * They all work through the parser and the writer, so a layout that survives
 * one of these commands is a layout the renderer can read.
 */

/** Insert a plot from anywhere in the workspace, at the cursor. */
export async function insertPlotCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || !isLayoutFile(editor.document.uri.fsPath)) {
    void vscode.window.showInformationMessage('Open a layout file first.');
    return;
  }

  const picked = await pickPlots('Which plot should be inserted?');
  if (picked.length === 0) return;

  const layoutDir = vscode.Uri.joinPath(editor.document.uri, '..');
  const configuration = settings();
  const lines: string[] = [];

  for (const uri of picked) {
    const relative = relativePath(layoutDir, uri);
    for (const page of pagesOf(uri, configuration.nPagesMax)) {
      lines.push(
        `${relative.split('/').join(' / ')}, page ${page}::vcenter\t` +
          `${relative}::page ${page}::resolution ${configuration.defaultResolution}`,
      );
    }
  }

  const at = editor.selection.active;
  const onBlankLine = editor.document.lineAt(at.line).text.trim().length === 0;

  await editor.edit((builder) => {
    const text = lines.join('\n');
    if (onBlankLine) builder.replace(editor.document.lineAt(at.line).range, text);
    else builder.insert(new vscode.Position(at.line + 1, 0), `${text}\n`);
  });
}

/** From the Explorer: append a file or folder to a layout that already exists. */
export async function addToLayoutCommand(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const targets = (uris ?? (uri === undefined ? [] : [uri])).filter(
    (candidate) => plotExtensionOf(candidate.fsPath) !== undefined,
  );

  if (targets.length === 0) {
    void vscode.window.showWarningMessage('Select one or more plot files to add.');
    return;
  }

  const layoutUri = await resolveLayoutUri();
  if (layoutUri === undefined) return;

  const document = await vscode.workspace.openTextDocument(layoutUri);
  const { layout } = parseLayout(document.getText());
  const layoutDir = vscode.Uri.joinPath(layoutUri, '..');
  const configuration = settings();

  const rows = layout.rows.map((row) => [...row]);

  for (const target of targets) {
    const relative = relativePath(layoutDir, target);
    for (const page of pagesOf(target, configuration.nPagesMax)) {
      const row = new Array(Math.max(1, layout.columns.length)).fill('');
      row[0] = `${relative.split('/').join(' / ')}, page ${page}::vcenter`;
      if (row.length > 1) row[1] = `${relative}::page ${page}::resolution ${configuration.defaultResolution}`;
      rows.push(row);
    }
  }

  await replaceLayout(document, { ...layout, rows });
  await vscode.window.showTextDocument(document);
  log().info(`Added ${targets.length} file(s) to ${vscode.workspace.asRelativePath(layoutUri)}.`);
}

/** Copy a ready-made cell to the clipboard, for pasting into any layout. */
export async function copyCellCommand(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const targets = (uris ?? (uri === undefined ? [] : [uri])).filter(
    (candidate) => plotExtensionOf(candidate.fsPath) !== undefined,
  );
  if (targets.length === 0) return;

  const active = vscode.window.activeTextEditor?.document.uri;
  const layoutDir =
    active !== undefined && isLayoutFile(active.fsPath) ? vscode.Uri.joinPath(active, '..') : undefined;

  const resolution = settings().defaultResolution;
  const cells = targets.map((target) => {
    const reference = layoutDir === undefined ? target.fsPath : relativePath(layoutDir, target);
    return `${reference}::page 1::resolution ${resolution}`;
  });

  await vscode.env.clipboard.writeText(cells.join('\t'));
  void vscode.window.showInformationMessage(
    cells.length === 1 ? 'Copied a plotExcel cell to the clipboard.' : `Copied ${cells.length} cells to the clipboard.`,
  );
}

/** Change the resolution of the whole layout in one step. */
export async function setResolutionCommand(): Promise<void> {
  const document = await activeLayout();
  if (document === undefined) return;

  const { layout } = parseLayout(document.getText());
  const choices = [
    { label: '96 dpi', description: 'screen — small files, quick drafts', value: 96 },
    { label: '150 dpi', description: 'the usual choice', value: 150 },
    { label: '300 dpi', description: 'print — large files, slow', value: 300 },
    { label: 'Something else…', description: 'type a number', value: 0 },
  ];

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: `Resolution for ${vscode.workspace.asRelativePath(document.uri)} (currently ${layout.options.resolution ?? 100})`,
  });
  if (picked === undefined) return;

  let resolution = picked.value;
  if (resolution === 0) {
    const typed = await vscode.window.showInputBox({
      prompt: 'Resolution in dpi',
      value: String(layout.options.resolution ?? 150),
      validateInput: (value) => (Number(value) > 0 && Number(value) <= 1200 ? undefined : 'A number between 1 and 1200.'),
    });
    if (typed === undefined) return;
    resolution = Number(typed);
  }

  // Cells carrying their own resolution would quietly ignore the new setting,
  // which looks exactly like the command not working.
  const perCell = layout.rows.flat().filter((cell) => /::resolution\s/.test(cell)).length;
  let rows = layout.rows;

  if (perCell > 0) {
    const strip = `Use ${resolution} everywhere`;
    const keep = 'Keep the per-cell values';
    const choice = await vscode.window.showQuickPick([strip, keep], {
      placeHolder: `${perCell} cells set their own resolution.`,
    });
    if (choice === undefined) return;

    if (choice === strip) {
      rows = layout.rows.map((row) => row.map((cell) => removeOption(cell, 'resolution')));
    }
  }

  await replaceLayout(document, { ...layout, options: { ...layout.options, resolution }, rows });
}

/** Give every row a comparison of two of its columns. */
export async function addDiffColumnCommand(): Promise<void> {
  const document = await activeLayout();
  if (document === undefined) return;

  const { layout } = parseLayout(document.getText());
  const columns = columnNames(document).filter((name) => name.length > 0);

  if (columns.length < 2) {
    void vscode.window.showWarningMessage('A comparison needs two columns of plots to compare.');
    return;
  }

  const first = await vscode.window.showQuickPick(columns, { placeHolder: 'Compare which column…' });
  if (first === undefined) return;

  const second = await vscode.window.showQuickPick(
    columns.filter((name) => name !== first),
    { placeHolder: `…against which? (comparing ${first})` },
  );
  if (second === undefined) return;

  const name = await vscode.window.showInputBox({ prompt: 'Name for the new column', value: 'Difference' });
  if (name === undefined || name.trim().length === 0) return;

  const quote = (column: string) => (/[,\s]/.test(column) ? `\`${column}\`` : column);
  const expression = `diff(${quote(first)}, ${quote(second)})`;

  await replaceLayout(document, {
    ...layout,
    columns: [...layout.columns, name.trim()],
    // A row with nothing in either column has nothing to compare, and an empty
    // cell there is better than a diff that renders an explanation.
    rows: layout.rows.map((row) => {
      const left = row[layout.columns.indexOf(first)] ?? '';
      const right = row[layout.columns.indexOf(second)] ?? '';
      return [...row, left.trim().length > 0 && right.trim().length > 0 ? expression : ''];
    }),
  });
}

/** Turn one row pointing at a multi-page file into one row per page. */
export async function expandPagesCommand(): Promise<void> {
  const found = plotCellUnderCursor();
  if (found === undefined) return;

  const document = found.document;
  const { layout } = parseLayout(document.getText());
  const source = vscode.Uri.joinPath(vscode.Uri.joinPath(document.uri, '..'), ...found.spec.path.split(/[\\/]/));

  let total: number;
  try {
    const count = countPages(source.fsPath);
    total = count.pages;
    if (count.confidence === 'estimated') {
      log().warn(`Page count for ${found.spec.path} is an estimate: ${count.reason ?? ''}`);
    }
  } catch {
    void vscode.window.showWarningMessage('That file could not be read, so its pages are unknown.');
    return;
  }

  if (total < 2) {
    void vscode.window.showInformationMessage('That file has only one page.');
    return;
  }

  // The cursor is on a data row; the header is row 0 of the parsed table.
  const rowIndex = dataRowIndexOf(document, found.line);
  if (rowIndex === undefined) return;

  const template = layout.rows[rowIndex];
  if (template === undefined) return;

  const columnIndex = template.findIndex((cell) => cell === cellTextAt(document, found.line, found.column));
  const expanded: string[][] = [];

  for (let page = 1; page <= total; page += 1) {
    expanded.push(
      template.map((cell, index) => {
        if (index === columnIndex) return setOption(cell, 'page', page);
        if (index === 0) return renumberCaption(cell, page);
        return cell;
      }),
    );
  }

  await replaceLayout(document, {
    ...layout,
    rows: [...layout.rows.slice(0, rowIndex), ...expanded, ...layout.rows.slice(rowIndex + 1)],
  });

  void vscode.window.showInformationMessage(`Expanded into ${total} rows, one per page.`);
}

/** Sort the rows by their first column, which is usually the description. */
export async function sortRowsCommand(): Promise<void> {
  const document = await activeLayout();
  if (document === undefined) return;

  const { layout } = parseLayout(document.getText());
  const sorted = [...layout.rows].sort((a, b) =>
    (a[0] ?? '').localeCompare(b[0] ?? '', undefined, { numeric: true, sensitivity: 'base' }),
  );

  await replaceLayout(document, { ...layout, rows: sorted });
}

/** Open the workbook this layout produces, if it has been rendered. */
export async function openWorkbookCommand(uri?: vscode.Uri): Promise<void> {
  const layoutUri = await resolveLayoutUri(uri);
  if (layoutUri === undefined) return;

  const document = await vscode.workspace.openTextDocument(layoutUri);
  const { layout } = parseLayout(document.getText());
  const declared = resolveOutputPath(layout, layoutUri.fsPath);
  const outFolder = vscode.Uri.joinPath(layoutUri, '..', '..', 'out');

  const candidates = [
    declared,
    vscode.Uri.joinPath(outFolder, `${stem(layoutUri)}.xlsx`).fsPath,
    // On Windows each render writes a new timestamped file, so the clean name
    // may never have existed. The newest one is the one just rendered.
    ...(await newestWorkbooks(vscode.Uri.joinPath(layoutUri, '..'), path.basename(declared, '.xlsx'))),
    ...(await newestWorkbooks(outFolder, stem(layoutUri))),
  ];

  for (const candidate of candidates) {
    const target = vscode.Uri.file(candidate);
    try {
      await vscode.workspace.fs.stat(target);
      await vscode.env.openExternal(target);
      return;
    } catch {
      // Try the next place it might be.
    }
  }

  const render = 'Render it now';
  const choice = await vscode.window.showInformationMessage('This layout has not been rendered yet.', render);
  if (choice === render) await vscode.commands.executeCommand('plotexcel.render', layoutUri);
}

// ------------------------------------------------------------------------- //

/**
 * Workbooks in a folder whose name matches this layout's, newest first.
 *
 * Sorted by the timestamp in the name rather than by mtime: the name is what
 * the render actually chose, and it survives a copy that mtime does not.
 */
async function newestWorkbooks(folder: vscode.Uri, stemName: string): Promise<string[]> {
  const pattern = workbookNamePattern(stemName);

  const entries = await vscode.workspace.fs.readDirectory(folder).then(
    (found) => found,
    () => [] as [string, vscode.FileType][],
  );

  return entries
    .filter(([name, type]) => type === vscode.FileType.File && pattern.test(name))
    .map(([name]) => name)
    .sort((a, b) => b.localeCompare(a))
    .map((name) => vscode.Uri.joinPath(folder, name).fsPath);
}

async function activeLayout(): Promise<vscode.TextDocument | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor !== undefined && isLayoutFile(editor.document.uri.fsPath)) return editor.document;

  const uri = await resolveLayoutUri();
  return uri === undefined ? undefined : vscode.workspace.openTextDocument(uri);
}

/** Rewrite the whole document from a layout, in one undoable step. */
async function replaceLayout(document: vscode.TextDocument, layout: LayoutFile): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));

  edit.replace(document.uri, whole, formatLayout(layout));
  await vscode.workspace.applyEdit(edit);
}

async function pickPlots(placeHolder: string): Promise<vscode.Uri[]> {
  const found = await vscode.workspace.findFiles(
    '**/*.{pdf,png,docx,pptx,xlsx,html,htm}',
    '**/{node_modules,.git,.plotexcel}/**',
    500,
  );

  if (found.length === 0) {
    void vscode.window.showWarningMessage('No plots found in this workspace.');
    return [];
  }

  const picked = await vscode.window.showQuickPick(
    found
      .map((uri) => ({ label: basename(uri), description: vscode.workspace.asRelativePath(uri), uri }))
      .sort((a, b) => a.description.localeCompare(b.description)),
    { placeHolder, canPickMany: true, matchOnDescription: true },
  );

  return (picked ?? []).map((item) => item.uri);
}

function pagesOf(uri: vscode.Uri, capacity: number): number[] {
  try {
    const count = countPages(uri.fsPath);
    return Array.from({ length: Math.min(count.pages, capacity) }, (_, index) => index + 1);
  } catch {
    return [1];
  }
}

function dataRowIndexOf(document: vscode.TextDocument, line: number): number | undefined {
  let seenHeader = false;
  let index = 0;

  for (let current = 0; current < document.lineCount; current += 1) {
    const text = document.lineAt(current).text;
    if (text.trim().length === 0 || text.startsWith('#')) continue;

    if (!seenHeader) {
      seenHeader = true;
      continue;
    }

    if (current === line) return index;
    index += 1;
  }

  return undefined;
}

function cellTextAt(document: vscode.TextDocument, line: number, character: number): string {
  const text = document.lineAt(line).text;
  let start = 0;

  for (const part of text.split('\t')) {
    if (character >= start && character <= start + part.length) return part.trim();
    start += part.length + 1;
  }

  return '';
}

function relativePath(from: vscode.Uri, to: vscode.Uri): string {
  const base = from.path.replace(/\/+$/, '').split('/');
  const target = to.path.split('/');

  let shared = 0;
  while (shared < base.length && shared < target.length && base[shared] === target[shared]) shared += 1;

  return [...Array.from({ length: base.length - shared }, () => '..'), ...target.slice(shared)].join('/');
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] ?? uri.path;
}

function stem(uri: vscode.Uri): string {
  return basename(uri).replace(/\.plotexcel\.tsv$/i, '');
}
