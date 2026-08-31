import { createZip, listZip, readZipEntry } from '../../../core/src/zip/zip.ts';

/**
 * Make every sheet of a workbook print onto one page.
 *
 * An Excel plot converted to PDF at its natural size spills across a dozen
 * sheets of A4, and a dozen pages of a fragment is not a plot. The R package
 * solved this by loading the workbook in openxlsx and rewriting its page setup
 * before handing it to LibreOffice; the same edit is a small XML change, so it
 * is done directly here.
 *
 * Every failure falls back to the original bytes: a workbook that converts
 * across several pages is a much better outcome than one that will not open.
 */
export function fitWorkbookToOnePage(bytes: Buffer): Buffer {
  try {
    let changed = false;

    const patched = listZip(bytes).map((entry) => {
      const data = readZipEntry(bytes, entry.name);
      if (data === undefined) throw new Error(`could not read ${entry.name}`);

      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)) {
        return { name: entry.name, data };
      }

      const before = data.toString('utf8');
      const after = fitSheet(before);
      if (after !== before) changed = true;

      return { name: entry.name, data: Buffer.from(after, 'utf8') };
    });

    // Anything that is not a workbook - or is one that already prints to a
    // single page - comes back byte for byte as it arrived. Rewriting a file
    // nothing was wrong with is how a converter loses a signature or a part it
    // did not understand.
    return changed ? createZip(patched) : bytes;
  } catch {
    return bytes;
  }
}

function fitSheet(xml: string): string {
  let result = xml;

  // Tell Excel and LibreOffice that the scaling below is meant to fit pages.
  if (/<sheetPr\b/.test(result)) {
    if (!/<pageSetUpPr\b/.test(result)) {
      result = result.replace(/<sheetPr([^>]*)>/, '<sheetPr$1><pageSetUpPr fitToPage="1"/>');
      result = result.replace(/<sheetPr([^>]*)\/>/, '<sheetPr$1><pageSetUpPr fitToPage="1"/></sheetPr>');
    } else if (!/fitToPage="1"/.test(result)) {
      result = result.replace(/<pageSetUpPr([^>]*)\/>/, '<pageSetUpPr$1 fitToPage="1"/>');
    }
  } else {
    result = result.replace(/(<worksheet\b[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
  }

  const pageSetup = '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="1"/>';

  if (/<pageSetup\b/.test(result)) {
    return result.replace(/<pageSetup\b[^>]*\/>/, pageSetup);
  }

  // pageSetup must follow pageMargins, which the schema requires before it.
  if (/<pageMargins\b[^>]*\/>/.test(result)) {
    return result.replace(/(<pageMargins\b[^>]*\/>)/, `$1${pageSetup}`);
  }

  return result.replace(
    '</worksheet>',
    `<pageMargins left="0.25" right="0.25" top="0.25" bottom="0.25" header="0.3" footer="0.3"/>${pageSetup}</worksheet>`,
  );
}
