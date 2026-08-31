import { formatLayout, type LayoutFile } from '../../core/src/layout/layoutFile.ts';
import { DEFAULT_HEADER_STYLE } from '../../core/src/styles.ts';
import { computeGeometry, type PlacedImage } from '../../core/src/units.ts';
import {
  buildWorkbookParts,
  type WorkbookCellInput,
  type WorkbookImageInput,
} from '../../core/src/xlsx/workbookParts.ts';
import type { FolderFile } from './folder.ts';
import { centimetres, drawPlaceholder, imageFromFile, type ImageBytes } from './images.ts';
import { createStoredZip } from './zip.ts';

/**
 * A folder of plots into a workbook, in the browser.
 *
 * Everything that decides what the workbook looks like — the layout, the
 * styles, the geometry, the OOXML — is the same code the extension runs. What
 * differs is only where the bytes come from: the browser reads files through a
 * directory handle, uses PNGs as they are, and has no PDF renderer, so PDF
 * pages become placeholders that say so.
 *
 * The layout file is produced too, and it is the real thing: rendering it with
 * the extension or the command line gives the full-fidelity workbook, with the
 * PDF pages actually drawn.
 */

export interface BuildOptions {
  readonly resolution: number;
  readonly nPagesMax: number;
  readonly addBorders: boolean;
  readonly textColumnWidthCm: number;
  readonly sheetName: string;
}

export interface BuildResult {
  readonly workbook: Uint8Array;
  readonly layoutText: string;
  readonly images: number;
  readonly placeholders: number;
  readonly notes: readonly string[];
}

const FIRST_DATA_ROW = 2;

export async function buildFromFolder(
  files: readonly FolderFile[],
  options: BuildOptions,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<BuildResult> {
  const rows: string[][] = [];
  const cells: WorkbookCellInput[] = [
    { row: 1, column: 1, text: 'Description', style: DEFAULT_HEADER_STYLE },
    { row: 1, column: 2, text: 'Plot', style: DEFAULT_HEADER_STYLE },
  ];
  const images: WorkbookImageInput[] = [];
  const placed: PlacedImage[] = [];
  const notes: string[] = [];

  const planned = files.flatMap((file) =>
    Array.from({ length: Math.min(file.pages.pages, options.nPagesMax) }, (_, index) => ({
      file,
      page: index + 1,
    })),
  );

  let placeholders = 0;

  for (const [index, { file, page }] of planned.entries()) {
    const row = index + FIRST_DATA_ROW;
    const description = `${file.path.split('/').join(' / ')}, page ${page}`;

    onProgress?.(index + 1, planned.length, description);

    cells.push({ row, column: 1, text: description, style: 'vcenter' });
    rows.push([
      `${description}::vcenter`,
      `${file.path}::page ${page}::resolution ${options.resolution}`,
    ]);

    const image = await imageFor(file, page, options.resolution);
    if (image.placeholder) placeholders += 1;

    const widthCm = centimetres(image.widthPx, image.dpi);
    const heightCm = centimetres(image.heightPx, image.dpi);

    images.push({ row, column: 2, png: image.png, widthCm, heightCm, description });
    placed.push({ row, column: 2, widthCm, heightCm });
  }

  const unsupported = new Set(
    files.filter((file) => file.extension !== 'png' && file.extension !== 'pdf').map((file) => file.extension),
  );
  if (unsupported.size > 0) {
    notes.push(
      `${[...unsupported].map((extension) => `.${extension}`).join(', ')} files need Office or LibreOffice, ` +
        'which a browser cannot reach. Render the layout with the extension to include them.',
    );
  }
  if (files.some((file) => file.extension === 'pdf')) {
    notes.push('PDF pages are placeholders here. Rendering the layout file gives the real pages.');
  }

  const geometry = computeGeometry(
    placed,
    {
      columns: [1, 2],
      rows: Array.from({ length: planned.length + 1 }, (_, index) => index + 1),
    },
    { textColumnWidthCm: options.textColumnWidthCm, textRowHeightCm: 2 },
  );

  const layout: LayoutFile = {
    options: { resolution: options.resolution, textColWidth: options.textColumnWidthCm, addBorders: options.addBorders },
    comments: ['# Generated in the browser. Render this with the plotExcel extension for full fidelity.'],
    columns: ['Description', 'Plot'],
    rows,
  };

  const parts = buildWorkbookParts({
    sheetName: options.sheetName,
    title: options.sheetName,
    cells,
    images,
    columnWidthsCm: geometry.columnWidthsCm,
    rowHeightsCm: geometry.rowHeightsCm,
    freeze: { rows: 1, columns: 1 },
    addBorders: options.addBorders,
    fitToPage: true,
  });

  return {
    workbook: createStoredZip(parts),
    layoutText: formatLayout(layout),
    images: planned.length - placeholders,
    placeholders,
    notes,
  };
}

async function imageFor(
  file: FolderFile,
  page: number,
  resolution: number,
): Promise<ImageBytes & { placeholder: boolean }> {
  if (file.extension === 'png') {
    const real = await imageFromFile(await file.handle.getFile(), resolution);
    if (real !== undefined) return { ...real, placeholder: false };
  }

  const headline = file.extension === 'pdf' ? `${basename(file.path)} · page ${page}` : basename(file.path);
  const lines =
    file.extension === 'pdf'
      ? ['PDF pages are not rendered in the browser build.', 'Render the layout file to draw this page.']
      : [`.${file.extension} files need Microsoft Office or LibreOffice.`];

  const drawn = await drawPlaceholder({
    headline,
    lines,
    tone: file.extension === 'pdf' ? 'unsupported' : 'missing',
    widthPx: Math.round((10 / 2.54) * resolution),
    heightPx: Math.round((7 / 2.54) * resolution),
    dpi: resolution,
  });

  return { ...drawn, placeholder: true };
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}
