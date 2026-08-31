import { createZip } from '../zip/zip.ts';
import { buildWorkbookParts, type WorkbookInput } from './workbookParts.ts';

/**
 * Package the workbook parts into the file.
 *
 * This is the whole of the workbook writer that touches a platform: the ZIP
 * writer underneath it runs on `node:zlib`. Everything that decides what the
 * workbook contains lives in `workbookParts.ts`, which imports nothing but
 * arithmetic — and so runs unchanged in a browser, where a different ZIP
 * writer does this last step.
 */

export * from './workbookParts.ts';

/**
 * Build the .xlsx file. Returns the bytes; writing them out is the caller's job.
 *
 * A `Buffer` rather than a `Uint8Array`: this half of the writer is the Node
 * half — it reaches `node:zlib` through the ZIP writer — and saying so lets
 * callers use the reader in this package on what comes back. The browser
 * imports `workbookParts.ts` and never this file.
 */
export function writeWorkbook(input: WorkbookInput): Buffer {
  return createZip(buildWorkbookParts(input), { modifiedAt: input.createdAt ?? new Date() });
}
