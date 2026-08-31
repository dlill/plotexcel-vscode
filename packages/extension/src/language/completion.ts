import * as vscode from 'vscode';

import { PLOT_DECORATOR_KEYS } from '../../../core/src/spec/plotSpec.ts';
import { plotExtensionOf } from '../../../core/src/spec/classify.ts';
import { STYLES, STYLE_NAMES } from '../../../core/src/styles.ts';
import { cellAt, columnNames, headerLine } from './cells.ts';

/**
 * Completion inside a layout cell.
 *
 * The decorator syntax is the part of this format nobody remembers — which
 * option crops, whether it is `page` or `pages`, what the styles are called.
 * Typing `::` should answer all of it without a trip to the documentation,
 * and the suggestions differ by what the cell already holds: options for a
 * plot, styles for text, column names inside a diff.
 */
export function registerCompletion(context: vscode.ExtensionContext): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position) {
      const line = document.lineAt(position.line).text;
      if (line.startsWith('#')) return undefined;
      if (position.line === headerLine(document)) return undefined;

      const cell = cellAt(line, position.character);
      if (cell === undefined) return undefined;

      const before = cell.text.slice(0, position.character - cell.start);

      if (/diff\s*\([^)]*$/i.test(before)) return columnCompletions(document);
      if (!before.endsWith('::')) return undefined;

      // A diff cell takes its own two options, not the plot ones and not the
      // styles — offering `page` after `diff(A, B)::` would be a wrong answer.
      if (/^\s*diff\s*\(/i.test(cell.text)) return diffCompletions();

      return plotExtensionOf(cell.text) === undefined ? styleCompletions() : optionCompletions();
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'plotexcel-layout' }, provider, ':', ','),
  );
}

function optionCompletions(): vscode.CompletionItem[] {
  const documentation: Record<string, string> = {
    commit: 'Read this plot as it was at a git revision, e.g. `commit HEAD~1`.',
    page: 'Which page or slide to take, counting from 1.',
    xmin: 'Left edge of the crop, in percent of the page.',
    xmax: 'Right edge of the crop, in percent of the page.',
    ymin: 'Top edge of the crop, in percent of the page.',
    ymax: 'Bottom edge of the crop, in percent of the page.',
    resolution: 'Rendering resolution in dpi. This also sets how large the image is in the workbook.',
  };

  const placeholders: Record<string, string> = {
    commit: 'HEAD~1',
    page: '1',
    xmin: '0',
    xmax: '100',
    ymin: '0',
    ymax: '100',
    resolution: '150',
  };

  return PLOT_DECORATOR_KEYS.map((key) => {
    const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
    item.insertText = new vscode.SnippetString(`${key} \${1:${placeholders[key]}}`);
    item.documentation = new vscode.MarkdownString(documentation[key]);
    item.detail = 'plot option';
    return item;
  });
}

function diffCompletions(): vscode.CompletionItem[] {
  const options: { key: string; placeholder: string; documentation: string }[] = [
    {
      key: 'tolerance',
      placeholder: '0.2',
      documentation:
        'How different two pixels must be before they count as changed, from 0 to 1. ' +
        'The default is 0.1. Anti-aliasing and font hinting move pixels slightly between ' +
        'two renders of the same figure; raising this is how a comparison stops reporting them.',
    },
    {
      key: 'context',
      placeholder: 'off',
      documentation:
        'Whether unchanged content stays, faded, behind the marks. `off` leaves only what changed, ' +
        'which is easier to read when the difference is small.',
    },
  ];

  return options.map((option) => {
    const item = new vscode.CompletionItem(option.key, vscode.CompletionItemKind.Property);
    item.insertText = new vscode.SnippetString(`${option.key} \${1:${option.placeholder}}`);
    item.documentation = new vscode.MarkdownString(option.documentation);
    item.detail = 'comparison option';
    return item;
  });
}

function styleCompletions(): vscode.CompletionItem[] {
  return STYLE_NAMES.map((name, index) => {
    const style = STYLES[name]!;
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);

    item.detail = `style ${index + 1}`;
    item.documentation = new vscode.MarkdownString(
      [
        style.fontSize === undefined ? 'Default font' : `${style.fontSize}pt${style.bold === true ? ' bold' : ''}`,
        style.horizontal === undefined ? undefined : `aligned ${style.horizontal}`,
        style.vertical === undefined ? undefined : `vertically ${style.vertical}`,
        style.textRotation === undefined ? undefined : `rotated ${style.textRotation}°`,
      ]
        .filter((part) => part !== undefined)
        .join(', '),
    );

    // Keep the documented order rather than letting the list sort itself.
    item.sortText = String(index).padStart(2, '0');
    return item;
  });
}

function columnCompletions(document: vscode.TextDocument): vscode.CompletionItem[] {
  return columnNames(document)
    .filter((name) => name.length > 0)
    .map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
      item.detail = 'column';
      // A name with a comma or a space has to be quoted to survive parsing.
      item.insertText = /[,\s]/.test(name) ? `\`${name}\`` : name;
      return item;
    });
}
