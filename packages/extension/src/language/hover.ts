import * as vscode from 'vscode';

import { countPages } from '../../../core/src/documents/pageCount.ts';
import { parseLayout } from '../../../core/src/layout/layoutFile.ts';
import { classifyCell } from '../../../core/src/spec/classify.ts';
import { cellAt, headerLine, rangeOf } from './cells.ts';

/**
 * What a cell actually refers to, on hover.
 *
 * A layout is full of relative paths and page numbers, and the two questions
 * that come up over and over are "which file is this?" and "does that page
 * exist?". Both are answerable without rendering anything, so they are
 * answered here — including the unwelcome one, that the file is not there.
 */
export function registerHover(context: vscode.ExtensionContext): void {
  const provider: vscode.HoverProvider = {
    async provideHover(document, position) {
      const line = document.lineAt(position.line).text;
      if (line.startsWith('#') || position.line === headerLine(document)) return undefined;

      const cell = cellAt(line, position.character);
      if (cell === undefined || cell.text.trim().length === 0) return undefined;

      const { layout } = parseLayout(document.getText());
      const defaults = layout.options.resolution === undefined ? {} : { resolution: layout.options.resolution };

      let classified;
      try {
        classified = classifyCell(cell.text, { defaults });
      } catch (error) {
        return new vscode.Hover(
          new vscode.MarkdownString(`**Cannot read this cell.** ${error instanceof Error ? error.message : ''}`),
          rangeOf(position.line, cell),
        );
      }

      if (classified.kind !== 'plot') return undefined;

      const spec = classified.spec;
      const target = vscode.Uri.joinPath(vscode.Uri.joinPath(document.uri, '..'), ...spec.path.split(/[\\/]/));
      const lines: string[] = [`\`${target.fsPath}\``];

      try {
        await vscode.workspace.fs.stat(target);
        const count = countPages(target.fsPath);

        lines.push(
          '',
          count.confidence === 'exact'
            ? `${count.pages} page${count.pages === 1 ? '' : 's'}`
            : `about ${count.pages} page${count.pages === 1 ? '' : 's'} — ${count.reason ?? 'estimated'}`,
        );

        if (spec.page > count.pages && count.confidence === 'exact') {
          lines.push('', `⚠ This cell asks for page ${spec.page}, which does not exist.`);
        }
      } catch {
        lines.push('', '⚠ This file does not exist. The cell will render as a placeholder.');
      }

      const crop =
        spec.xmin === 0 && spec.xmax === 100 && spec.ymin === 0 && spec.ymax === 100
          ? 'whole page'
          : `cropped to x ${spec.xmin}–${spec.xmax}%, y ${spec.ymin}–${spec.ymax}%`;

      lines.push('', `page ${spec.page}, ${spec.resolution} dpi, ${crop}`);
      if (spec.commit !== 'HEAD') lines.push('', `from revision \`${spec.commit}\``);

      return new vscode.Hover(new vscode.MarkdownString(lines.join('\n')), rangeOf(position.line, cell));
    },
  };

  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'plotexcel-layout' }, provider));
}
