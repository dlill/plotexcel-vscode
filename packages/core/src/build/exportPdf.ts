import path from 'node:path';

import type { PageSize, Tools } from '../pipeline/ports.ts';

/**
 * Export the finished workbook to PDF.
 *
 * The R package's `FLAGpdf`, and it exists for the same reason: while drafting
 * a report you want to see the whole sheet at once, and a spreadsheet is a bad
 * way to look at forty plots. The conversion is the same one used for Office
 * inputs, pointed the other way.
 */

export class NoPdfExporterError extends Error {
  constructor() {
    super('Exporting to PDF needs Microsoft Office or LibreOffice, and neither was found on this machine.');
    this.name = 'NoPdfExporterError';
  }
}

export async function workbookToPdf(
  workbook: Buffer,
  tools: Tools,
  pageSize: PageSize = 'single',
): Promise<Buffer> {
  const converter = tools.converter;
  if (converter === undefined || !converter.canConvert('xlsx')) throw new NoPdfExporterError();

  return converter.toPdf({ bytes: workbook, extension: 'xlsx', pageSize });
}

/** The PDF that belongs beside a workbook: same name, different extension. */
export function pdfPathFor(workbookPath: string): string {
  const extension = path.extname(workbookPath);
  return `${workbookPath.slice(0, workbookPath.length - extension.length)}.pdf`;
}
