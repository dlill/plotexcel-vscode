import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readPngHeader } from '../../../core/src/image/png.ts';
import type { PdfRenderer } from '../../../core/src/pipeline/ports.ts';
import { run, withScratchDir } from '../exec.ts';

/**
 * Rasterise PDF pages with poppler's pdftoppm.
 *
 * The usual renderer on Linux and macOS, and generally faster than
 * Ghostscript. `-singlefile` is what makes the output name predictable:
 * without it pdftoppm appends the page number in a width that depends on the
 * document's length.
 */
export function createPopplerRenderer(command: string): PdfRenderer {
  return {
    name: 'pdftoppm',

    async renderPage({ pdf, page, dpi }) {
      return withScratchDir('plotexcel-poppler', async (directory) => {
        const input = path.join(directory, 'input.pdf');
        const prefix = path.join(directory, 'page');
        await writeFile(input, pdf);

        const result = await run(
          command,
          ['-png', '-singlefile', '-r', String(dpi), '-f', String(page), '-l', String(page), input, prefix],
          { timeoutMs: 120_000 },
        );

        if (result.code !== 0) {
          throw new Error(`pdftoppm could not render page ${page}: ${result.stderr.trim().split('\n')[0] ?? ''}`);
        }

        const bytes = await readFile(`${prefix}.png`).catch(() => undefined);
        if (bytes === undefined) {
          throw new Error(`pdftoppm produced no output for page ${page}. The page may not exist.`);
        }

        // The header is enough: the pipeline wants the bytes, and decodes
        // them only if the cell asks for a crop.
        const header = readPngHeader(bytes);
        return { png: bytes, width: header.width, height: header.height, dpi: header.dpi ?? dpi };
      });
    },
  };
}
