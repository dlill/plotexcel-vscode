import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DocumentConverter } from '../../../core/src/pipeline/ports.ts';
import { run, withScratchDir } from '../exec.ts';
import { fitWorkbookToOnePage } from './xlsxPageSetup.ts';

const SUPPORTED = ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xlsm', 'xls', 'odt', 'odp', 'ods'];

/**
 * Convert Office documents with headless LibreOffice.
 *
 * Two details make this reliable enough to run several at once. Each
 * conversion gets its own `-env:UserInstallation` profile, because LibreOffice
 * otherwise refuses to start a second instance while one is running — the
 * failure the R package hit whenever a conversion was already in flight. And
 * spreadsheets have their page setup rewritten first, so a wide sheet becomes
 * one page rather than a dozen fragments.
 */
export function createLibreOfficeConverter(command: string): DocumentConverter {
  return {
    name: 'LibreOffice',

    canConvert(extension) {
      return SUPPORTED.includes(extension.toLowerCase());
    },

    async toPdf({ bytes, extension, pageSize }) {
      const lower = extension.toLowerCase();
      if (!SUPPORTED.includes(lower)) {
        throw new Error(`LibreOffice is not used for .${extension} files.`);
      }

      const prepared =
        ['xlsx', 'xlsm'].includes(lower) && (pageSize ?? 'single') === 'single' ? fitWorkbookToOnePage(bytes) : bytes;

      return withScratchDir('plotexcel-soffice', async (directory) => {
        const input = path.join(directory, `input.${lower}`);
        const outDir = path.join(directory, 'out');
        const profile = path.join(directory, 'profile');
        await writeFile(input, prepared);

        const result = await run(
          command,
          [
            `-env:UserInstallation=${pathToFileURL(profile).href}`,
            '--headless',
            '--norestore',
            '--convert-to',
            'pdf',
            '--outdir',
            outDir,
            input,
          ],
          { timeoutMs: 180_000 },
        );

        const produced = path.join(outDir, 'input.pdf');
        const pdf = await readFile(produced).catch(() => undefined);

        if (pdf === undefined) {
          const detail = result.stderr.trim().split('\n')[0] ?? `exit ${result.code}`;
          throw new Error(`LibreOffice did not produce a PDF: ${detail}`);
        }

        return pdf;
      });
    },
  };
}
