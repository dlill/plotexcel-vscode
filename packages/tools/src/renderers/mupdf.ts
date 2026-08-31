import { pathToFileURL } from 'node:url';

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

/**
 * Import an ES module by specifier, out of esbuild's sight.
 *
 * The extension is bundled to CommonJS, and esbuild rewrites any dynamic
 * `import()` it can see into a `require()`. That cannot load MuPDF: the
 * package is ESM-only and its glue finds `mupdf-wasm.wasm` through
 * `import.meta.url`, neither of which survives being flattened into CJS.
 * Going through `new Function` leaves a genuine dynamic import in the bundle,
 * so the module is loaded by Node as the ESM it is.
 */
const importModule = new Function('specifier', 'return import(specifier);') as (
  specifier: string,
) => Promise<unknown>;

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
let cachedFor: string | undefined;

/**
 * Load the module once; undefined means it is not present in this build.
 *
 * `bundled` is the absolute path to `mupdf.js` inside the installed
 * extension, which only the host can know. Running from source — the CLI, the
 * tests — there is no bundle and the package resolves from node_modules like
 * anything else. The answer is remembered per path rather than outright,
 * because activation learns the bundle location after the first lookup may
 * already have failed.
 */
export async function loadMupdf(bundled?: string): Promise<MupdfModule | undefined> {
  const key = bundled ?? '';
  if (cached === undefined || cachedFor !== key) {
    cachedFor = key;
    cached = attempt(bundled);
  }
  return cached;
}

async function attempt(bundled: string | undefined): Promise<MupdfModule | undefined> {
  const specifiers = [...(bundled === undefined ? [] : [pathToFileURL(bundled).href]), 'mupdf'];

  for (const specifier of specifiers) {
    try {
      return (await importModule(specifier)) as MupdfModule;
    } catch {
      // A build with no MuPDF at all is a supported state, not an error: the
      // capability report says so and Ghostscript or poppler may still answer.
    }
  }

  return undefined;
}

export async function createMupdfRenderer(bundled?: string): Promise<PdfRenderer | undefined> {
  const mupdf = await loadMupdf(bundled);
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
