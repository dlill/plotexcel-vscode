import * as vscode from 'vscode';

import { countPages } from '../../../core/src/documents/pageCount.ts';
import { plotExtensionOf } from '../../../core/src/spec/classify.ts';
import { settings } from '../machine.ts';
import { headerLine } from './cells.ts';

/**
 * Drag a plot from the Explorer straight into a layout.
 *
 * The fastest way to add a row, and the one that never gets the path wrong.
 * Dropping onto an empty line writes a whole row — a description and a spec
 * per page — while dropping into a cell writes just the spec, so an existing
 * table can be extended a column at a time.
 */
export function registerDrop(context: vscode.ExtensionContext): void {
  const provider: vscode.DocumentDropEditProvider = {
    async provideDocumentDropEdits(document, position, dataTransfer) {
      const uris = await filesFrom(dataTransfer);
      if (uris.length === 0) return undefined;

      const layoutDir = vscode.Uri.joinPath(document.uri, '..');
      const resolution = settings().defaultResolution;
      const capacity = settings().nPagesMax;

      const line = document.lineAt(position.line).text;
      const intoEmptyLine = line.trim().length === 0;
      const inHeader = position.line === headerLine(document);

      const rows: string[] = [];

      for (const uri of uris) {
        const relative = relativePath(layoutDir, uri);
        const pages = pageCountOf(uri, capacity);

        for (const page of pages) {
          const spec = `${relative}::page ${page}::resolution ${resolution}`;
          rows.push(intoEmptyLine ? `${describe(relative, page)}::vcenter\t${spec}` : spec);
        }
      }

      if (rows.length === 0) return undefined;

      // Inside a table, one dropped page goes into the cell under the cursor;
      // anything more would silently overwrite the columns beside it.
      const text = intoEmptyLine || inHeader ? rows.join('\n') : rows[0]!;
      const edit = new vscode.DocumentDropEdit(text);
      edit.title = rows.length === 1 ? 'Insert plot' : `Insert ${rows.length} rows`;

      return edit;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentDropEditProvider({ language: 'plotexcel-layout' }, provider),
  );
}

async function filesFrom(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
  const list = await dataTransfer.get('text/uri-list')?.asString();
  if (list === undefined) return [];

  return list
    .split(/\r?\n/)
    .filter((entry) => entry.trim().length > 0 && !entry.startsWith('#'))
    .map((entry) => vscode.Uri.parse(entry))
    .filter((uri) => plotExtensionOf(uri.path) !== undefined);
}

function pageCountOf(uri: vscode.Uri, capacity: number): number[] {
  try {
    const count = countPages(uri.fsPath);
    return Array.from({ length: Math.min(count.pages, capacity) }, (_, index) => index + 1);
  } catch {
    return [1];
  }
}

function describe(relative: string, page: number): string {
  return `${relative.split('/').join(' / ')}, page ${page}`;
}

function relativePath(from: vscode.Uri, to: vscode.Uri): string {
  const base = from.path.replace(/\/+$/, '').split('/');
  const target = to.path.split('/');

  let shared = 0;
  while (shared < base.length && shared < target.length && base[shared] === target[shared]) shared += 1;

  const up = Array.from({ length: base.length - shared }, () => '..');
  return [...up, ...target.slice(shared)].join('/');
}
