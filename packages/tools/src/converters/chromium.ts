import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DocumentConverter } from '../../../core/src/pipeline/ports.ts';
import { run, runningAsRoot, withScratchDir } from '../exec.ts';

/**
 * Render HTML plots to PDF with a browser that is already installed.
 *
 * The R package used pagedown, which drives headless Chrome over the debugging
 * protocol. Chrome's own `--print-to-pdf` does the same job without a
 * protocol client, a websocket or a package — and on the target machines Edge
 * is always present, which makes HTML plots work with nothing to install.
 *
 * `--virtual-time-budget` is what makes a plot rendered by JavaScript come out
 * drawn rather than blank: it lets the page's timers run to completion before
 * printing.
 */
export function createChromiumConverter(command: string, virtualTimeBudgetMs = 8000): DocumentConverter {
  return {
    name: 'Chromium',

    canConvert(extension) {
      return ['html', 'htm'].includes(extension.toLowerCase());
    },

    async toPdf({ bytes, extension }) {
      const lower = extension.toLowerCase();
      if (!['html', 'htm'].includes(lower)) {
        throw new Error(`A browser is not used for .${extension} files.`);
      }

      return withScratchDir('plotexcel-chromium', async (directory) => {
        const input = path.join(directory, `input.${lower}`);
        const output = path.join(directory, 'output.pdf');
        const profile = path.join(directory, 'profile');
        await writeFile(input, bytes);

        const result = await run(
          command,
          [
            '--headless=new',
            // Chromium will not start as root with its sandbox on, which is
            // the situation inside a container and never on a real desktop.
            ...(runningAsRoot() ? ['--no-sandbox'] : []),
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            `--user-data-dir=${profile}`,
            `--virtual-time-budget=${virtualTimeBudgetMs}`,
            '--no-pdf-header-footer',
            `--print-to-pdf=${output}`,
            pathToFileURL(input).href,
          ],
          { timeoutMs: 90_000, discardOutput: true },
        );

        const pdf = await readFile(output).catch(() => undefined);
        if (pdf === undefined) {
          const detail = result.stderr.trim().split('\n').filter((line) => line.length > 0).pop() ?? `exit ${result.code}`;
          throw new Error(`The browser did not produce a PDF: ${detail}`);
        }

        return pdf;
      });
    },
  };
}
