import { readPngHeader } from '../../../core/src/image/png.ts';
import type { PdfRenderer } from '../../../core/src/pipeline/ports.ts';

/**
 * Rasterise PDF pages with MuPDF's WebAssembly build.
 *
 * This is the renderer that makes the extension self-sufficient: no
 * Ghostscript, no poppler, nothing for the user to install. It is loaded
 * lazily because it is the one dependency the extension ships, and a broken
 * install should degrade to "no renderer" rather than break activation.
 *
 * Licence note: MuPDF is AGPL. That suits a project whose R original is
 * AGPL-3, but it does decide the extension's own licence — see docs/decisions.
 */

type MupdfModule = {
  Document: {
    openDocument(data: Uint8Array | ArrayBuffer, magic: string): {
      countPages(): number;
      loadPage(index: number): {
        toPixmap(matrix: unknown, colorspace: unknown, alpha: boolean, showExtras: boolean): { asPNG(): Uint8Array };
      };
    };
  };
  Matrix: { scale(x: number, y: number): unknown };
  ColorSpace: { DeviceRGB: unknown };
};

let cached: Promise<MupdfModule | undefined> | undefined;

/** Load the module once; undefined means it is not installed in this build. */
export async function loadMupdf(): Promise<MupdfModule | undefined> {
  cached ??= import('mupdf')
    .then((module) => module as unknown as MupdfModule)
    .catch(() => undefined);
  return cached;
}

export async function createMupdfRenderer(): Promise<PdfRenderer | undefined> {
  const mupdf = await loadMupdf();
  if (mupdf === undefined) return undefined;

  return {
    name: 'MuPDF',

    async renderPage({ pdf, page, dpi }) {
      const document = mupdf.Document.openDocument(pdf, 'application/pdf');
      const pageCount = document.countPages();

      if (page < 1 || page > pageCount) {
        throw new Error(`This file has ${pageCount} page${pageCount === 1 ? '' : 's'}, so page ${page} does not exist.`);
      }

      // PDF user space is 72 dpi, so the scale factor is the ratio.
      const zoom = dpi / 72;
      const pixmap = document.loadPage(page - 1).toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
      // MuPDF hands back a PNG too, so the pipeline can keep the bytes and
      // decode only if the cell asks for a crop.
      const png = Buffer.from(pixmap.asPNG());
      const header = readPngHeader(png);

      return { png, width: header.width, height: header.height, dpi };
    },
  };
}
