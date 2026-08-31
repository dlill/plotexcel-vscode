import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readPngHeader } from '../../../core/src/image/png.ts';
import type { PdfRenderer } from '../../../core/src/pipeline/ports.ts';
import { run, withScratchDir } from '../exec.ts';

/**
 * Rasterise PDF pages with Ghostscript.
 *
 * This is the renderer the R package used, and on the machines this port is
 * aimed at it is often already there — Ghostscript ships with several R and
 * LaTeX installations. Preferring it when present means the extension can
 * render real plots on day one, before any bundled renderer is in place.
 */
export function createGhostscriptRenderer(command: string): PdfRenderer {
  return {
    name: 'Ghostscript',

    async renderPage({ pdf, page, dpi }) {
      return withScratchDir('plotexcel-gs', async (directory) => {
        const input = path.join(directory, 'input.pdf');
        const output = path.join(directory, 'page.png');
        await writeFile(input, pdf);

        const result = await run(
          command,
          [
            '-q',
            '-dNOPAUSE',
            '-dBATCH',
            '-dSAFER',
            '-sDEVICE=pngalpha',
            `-dFirstPage=${page}`,
            `-dLastPage=${page}`,
            `-r${dpi}`,
            // Without this the PNG carries no resolution, which is the
            // metadata gap the R package worked around downstream.
            '-dPngUsePhysicalDimensions=true',
            `-sOutputFile=${output}`,
            input,
          ],
          { timeoutMs: 120_000 },
        );

        if (result.code !== 0) {
          throw new Error(`Ghostscript could not render page ${page}: ${result.stderr.trim().split('\n')[0] ?? ''}`);
        }

        const bytes = await readFile(output).catch(() => undefined);
        if (bytes === undefined) {
          throw new Error(`Ghostscript produced no output for page ${page}. The page may not exist.`);
        }

        // The header is enough: the pipeline wants the bytes, and decodes
        // them only if the cell asks for a crop.
        const header = readPngHeader(bytes);
        return { png: bytes, width: header.width, height: header.height, dpi: header.dpi ?? dpi };
      });
    },
  };
}
