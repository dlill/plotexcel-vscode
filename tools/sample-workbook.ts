/**
 * Build a workbook that exercises every feature of the writer, for checking
 * against a reader that is not ours.
 *
 *     node tools/sample-workbook.ts [outputPath]
 *     python3 tools/verify-workbook.py [outputPath]
 *
 * The second script opens the result with openpyxl and prints what it found.
 * Until a real Excel is available, an independent implementation agreeing
 * about widths, styles and images is the strongest evidence we can get.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { cropImage, placeholderImage } from '../packages/core/src/image/ops.ts';
import { decodePng, encodePng, type RasterImage } from '../packages/core/src/image/png.ts';
import { pixelsToCm } from '../packages/core/src/units.ts';
import { writeWorkbook, type WorkbookImageInput } from '../packages/core/src/xlsx/writeWorkbook.ts';

const output = process.argv[2] ?? '/tmp/plotexcel-sample.xlsx';
const source = process.argv[3];

function imageFor(cropPercent: number): RasterImage {
  if (source !== undefined) {
    const decoded = decodePng(readFileSync(source));
    return cropImage(decoded, { xmin: 0, xmax: cropPercent, ymin: 0, ymax: 100 });
  }
  return placeholderImage({
    kind: 'missing-file',
    headline: 'No source image given',
    details: ['Pass a PNG as the second argument to embed a real plot.'],
    widthPx: Math.round(900 * (cropPercent / 100)),
    heightPx: 600,
  });
}

const dpi = 150;
const images: WorkbookImageInput[] = [100, 60].map((crop, index) => {
  const image = imageFor(crop);
  return {
    row: index + 2,
    column: 2,
    widthCm: pixelsToCm(image.width, image.dpi ?? dpi),
    heightCm: pixelsToCm(image.height, image.dpi ?? dpi),
    png: encodePng(image, { dpi: image.dpi ?? dpi }),
    description: `Sample plot ${index + 1}, cropped to ${crop}%`,
  };
});

const workbook = writeWorkbook({
  sheetName: 'Sample',
  title: 'plotExcel writer sample',
  cells: [
    { row: 1, column: 1, text: 'Description', style: 'center' },
    { row: 1, column: 2, text: 'Plot', style: 'center' },
    { row: 2, column: 1, text: 'Full width, page 1', style: 'vcenter' },
    { row: 3, column: 1, text: 'Cropped to 60%', style: 'rotateUp' },
    { row: 4, column: 1, text: '42', style: 'plain' },
    { row: 4, column: 2, text: 'Ampersands & "quotes" <survive>', style: 'left' },
  ],
  images,
  columnWidthsCm: new Map([
    [1, 6],
    [2, Math.max(...images.map((image) => image.widthCm))],
  ]),
  rowHeightsCm: new Map([
    [1, 2],
    [2, images[0]!.heightCm],
    [3, images[1]!.heightCm],
    [4, 1.2],
  ]),
  freeze: { rows: 1, columns: 1 },
  addBorders: true,
  fitToPage: true,
  createdAt: new Date(Date.UTC(2026, 7, 29, 12, 0, 0)),
});

writeFileSync(output, workbook);
console.log(`wrote ${path.resolve(output)} (${(workbook.length / 1024).toFixed(1)} KB, ${images.length} images)`);
