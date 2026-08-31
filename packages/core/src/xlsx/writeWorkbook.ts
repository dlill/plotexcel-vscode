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

/** Build the .xlsx file. Returns the bytes; writing them out is the caller's job. */
export function writeWorkbook(input: WorkbookInput): Uint8Array {
  return createZip(buildWorkbookParts(input), { modifiedAt: input.createdAt ?? new Date() });
}
