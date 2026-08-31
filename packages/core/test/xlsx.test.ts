import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodePng } from '../src/image/png.ts';
import { placeholderImage } from '../src/image/ops.ts';
import { listZip, readZipEntry } from '../src/zip/zip.ts';
import { cellReference, columnName, escapeXml } from '../src/xlsx/xml.ts';
import { columnWidthFromCm, EMU_PER_CM, rowHeightFromCm, writeWorkbook } from '../src/xlsx/writeWorkbook.ts';

const png = encodePng(placeholderImage({ kind: 'missing-file', headline: 'Missing', widthPx: 60, heightPx: 40 }));

function simpleWorkbook(overrides: Partial<Parameters<typeof writeWorkbook>[0]> = {}) {
  return writeWorkbook({
    sheetName: 'Plots',
    cells: [
      { row: 1, column: 1, text: 'Description', style: 'center' },
      { row: 1, column: 2, text: 'Plot', style: 'center' },
      { row: 2, column: 1, text: 'Iris, page 1', style: 'vcenter' },
    ],
    images: [{ row: 2, column: 2, widthCm: 12.395, heightCm: 9.982, png, description: 'Iris page 1' }],
    columnWidthsCm: new Map([
      [1, 5],
      [2, 12.395],
    ]),
    rowHeightsCm: new Map([
      [1, 2],
      [2, 9.982],
    ]),
    freeze: { rows: 1, columns: 1 },
    createdAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    ...overrides,
  });
}

describe('xml helpers', () => {
  it('names columns the way a spreadsheet does', () => {
    assert.equal(columnName(1), 'A');
    assert.equal(columnName(26), 'Z');
    assert.equal(columnName(27), 'AA');
    assert.equal(columnName(702), 'ZZ');
    assert.equal(columnName(703), 'AAA');
    assert.equal(cellReference(12, 3), 'C12');
  });

  it('escapes markup and drops characters XML cannot hold', () => {
    assert.equal(escapeXml('a & b < c'), 'a &amp; b &lt; c');
    assert.equal(escapeXml('cleantext'), 'cleantext');
    assert.equal(escapeXml('keeps\ttabs\nand newlines'), 'keeps\ttabs\nand newlines');
  });
});

describe('geometry conversions', () => {
  it('sizes a column to hold its image', () => {
    // 1 cm is 37.795 px at 96 dpi, and one character is 7 px wide.
    assert.ok(Math.abs(columnWidthFromCm(1) - 5.3994) < 0.001);
  });

  it('can reproduce the R package constant for comparison', () => {
    assert.ok(Math.abs(columnWidthFromCm(10, 'openxlsx') - 53) < 1e-9);
  });

  it('matches the row heights openxlsx writes', () => {
    // Taken from a workbook produced by the R package: 9.982 cm became this.
    assert.ok(Math.abs(rowHeightFromCm(9.982) - 297.108) < 0.01);
    assert.ok(Math.abs(rowHeightFromCm(2) - 59.5275590551181) < 0.01);
  });

  it('uses the same EMU-per-centimetre as openxlsx', () => {
    assert.equal(EMU_PER_CM, 360000);
    assert.equal(Math.round(12.395 * EMU_PER_CM), 4462200);
  });
});

describe('writeWorkbook', () => {
  const workbook = simpleWorkbook();
  const names = listZip(workbook).map((entry) => entry.name);
  const sheet = readZipEntry(workbook, 'xl/worksheets/sheet1.xml')!.toString('utf8');
  const drawing = readZipEntry(workbook, 'xl/drawings/drawing1.xml')!.toString('utf8');

  it('contains every part a reader needs', () => {
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/_rels/sheet1.xml.rels',
      'xl/drawings/drawing1.xml',
      'xl/drawings/_rels/drawing1.xml.rels',
      'xl/media/image1.png',
      'docProps/core.xml',
      'docProps/app.xml',
    ]) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
  });

  it('stores the image bytes unchanged', () => {
    assert.deepEqual(readZipEntry(workbook, 'xl/media/image1.png'), png);
  });

  it('writes text as inline strings and plain numbers as numbers', () => {
    assert.match(sheet, /<is><t xml:space="preserve">Description<\/t><\/is>/);

    const numeric = simpleWorkbook({
      cells: [
        { row: 1, column: 1, text: '42' },
        { row: 1, column: 2, text: '007' },
      ],
      images: [],
    });
    const numericSheet = readZipEntry(numeric, 'xl/worksheets/sheet1.xml')!.toString('utf8');
    assert.match(numericSheet, /<v>42<\/v>/);
    assert.match(numericSheet, /<t xml:space="preserve">007<\/t>/);
  });

  it('sizes rows and columns from centimetres', () => {
    assert.match(sheet, /<col min="2" max="2" width="66\.9/);
    assert.match(sheet, /<row r="2" ht="297\.1\d" customHeight="1">/);
  });

  it('freezes the header row and first column', () => {
    assert.match(sheet, /<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/>/);
  });

  it('fits the sheet to one page, as the R package does', () => {
    assert.match(sheet, /<pageSetUpPr fitToPage="1"\/>/);
    assert.match(sheet, /fitToWidth="1" fitToHeight="1"/);
  });

  it('anchors the image to its cell and sizes it in EMU', () => {
    assert.match(drawing, /<xdr:col>1<\/xdr:col>/);
    assert.match(drawing, /<xdr:row>1<\/xdr:row>/);
    assert.match(drawing, /<xdr:ext cx="4462200" cy="3593520"\/>/);
    assert.match(drawing, /descr="Iris page 1"/);
  });

  it('is byte-identical when built twice from the same input', () => {
    assert.deepEqual(simpleWorkbook(), simpleWorkbook());
  });

  it('omits the drawing entirely when there are no images', () => {
    const textOnly = simpleWorkbook({ images: [] });
    const parts = listZip(textOnly).map((entry) => entry.name);
    assert.ok(!parts.some((name) => name.startsWith('xl/drawings/')));
    assert.ok(!readZipEntry(textOnly, 'xl/worksheets/sheet1.xml')!.toString().includes('<drawing'));
  });

  it('writes every cell of the used range when borders are on', () => {
    const bordered = simpleWorkbook({ addBorders: true });
    const borderedSheet = readZipEntry(bordered, 'xl/worksheets/sheet1.xml')!.toString('utf8');
    assert.match(borderedSheet, /<c r="B2" s="\d+"\/>/);
    assert.match(readZipEntry(bordered, 'xl/styles.xml')!.toString('utf8'), /borderId="1"/);
  });

  it('encodes rotation the way Excel expects', () => {
    const styles = readZipEntry(workbook, 'xl/styles.xml')!.toString('utf8');
    assert.match(styles, /textRotation="90"/);
    assert.match(styles, /textRotation="180"/);
  });

  it('cleans up an unusable sheet name', () => {
    const odd = simpleWorkbook({ sheetName: 'Q1/Q2 [draft]: plots for the quarterly review' });
    const name = readZipEntry(odd, 'xl/workbook.xml')!.toString('utf8').match(/name="([^"]*)"/)?.[1] ?? '';
    assert.ok(name.length <= 31, name);
    assert.doesNotMatch(name, /[\\/?*[\]:]/);
  });
});
