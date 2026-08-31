import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cmToColumnWidth, cmToImagePixels, cmToRowHeight, computeGeometry, pixelsToCm } from '../src/units.ts';

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

describe('unit conversions', () => {
  it('turns rendered pixels into a physical size', () => {
    close(pixelsToCm(300, 150), 5.08);
    close(pixelsToCm(96, 96), 2.54);
  });

  it('round-trips centimetres through pixels at a given dpi', () => {
    close(pixelsToCm(cmToImagePixels(7.3), 96), 7.3);
  });

  it('matches the R constants for column width and row height', () => {
    close(cmToColumnWidth(10), 53);
    close(cmToRowHeight(2.54), 72 * 1.05);
  });
});

describe('computeGeometry', () => {
  const images = [
    { row: 2, column: 2, widthCm: 8, heightCm: 6 },
    { row: 2, column: 3, widthCm: 12, heightCm: 4 },
    { row: 3, column: 2, widthCm: 9, heightCm: 5 },
  ];
  const extent = { columns: [1, 2, 3], rows: [1, 2, 3] };

  it('sizes each column to its widest image and each row to its tallest', () => {
    const geometry = computeGeometry(images, extent);
    assert.equal(geometry.columnWidthsCm.get(2), 9);
    assert.equal(geometry.columnWidthsCm.get(3), 12);
    assert.equal(geometry.rowHeightsCm.get(2), 6);
    assert.equal(geometry.rowHeightsCm.get(3), 5);
  });

  it('falls back to the text defaults where a column or row holds no image', () => {
    const geometry = computeGeometry(images, extent, { textColumnWidthCm: 10, textRowHeightCm: 2 });
    assert.equal(geometry.columnWidthsCm.get(1), 10);
    assert.equal(geometry.rowHeightsCm.get(1), 2);
  });

  it('reports the converted units alongside the centimetres', () => {
    const geometry = computeGeometry(images, extent);
    close(geometry.columnWidths.get(3)!, cmToColumnWidth(12));
    close(geometry.rowHeights.get(2)!, cmToRowHeight(6));
  });
});
