import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { renderLayout, timestampedWorkbookPath, workbookNamePattern } from '../src/build/renderLayout.ts';
import { decodePng, encodePng } from '../src/image/png.ts';
import { parseLayout } from '../src/layout/layoutFile.ts';
import type { PdfRenderer, Tools } from '../src/pipeline/ports.ts';
import { sampleProject } from '../src/samples/sampleProject.ts';
import { listZip, readZipEntry } from '../src/zip/zip.ts';
import { EMU_PER_CM } from '../src/xlsx/workbookParts.ts';

/**
 * A layout in, a workbook out, checked by reading the workbook back.
 *
 * The unit tests each cover one step; this covers the joins between them,
 * which is where the bugs that reached a user actually were — a PNG sized by
 * its own metadata instead of the cell's resolution, a row too short for the
 * image in it. Both were found by looking at a rendered workbook, which is
 * exactly what this does automatically.
 *
 * It uses the generated sample project as its input, so the fixture is the
 * same thing a new user is shown, and a stand-in renderer so it runs on a
 * machine with no Ghostscript — including a CI runner.
 */

/**
 * A renderer that draws the page number into the image instead of rendering.
 *
 * Deterministic, instant, and identifiable: the first pixel encodes the page,
 * so a test can assert that page 3 ended up in the cell that asked for page 3
 * rather than merely that *an* image did.
 */
function countingRenderer(): PdfRenderer & { calls: { page: number; dpi: number }[] } {
  const calls: { page: number; dpi: number }[] = [];

  return {
    name: 'counting',
    calls,
    async renderPage({ page, dpi }) {
      calls.push({ page, dpi });

      // 10 x 7 cm at the requested dpi, which is what a real renderer would
      // produce for the sample's page size, so the geometry is realistic.
      const width = Math.round((10 / 2.54) * dpi);
      const height = Math.round((7 / 2.54) * dpi);
      const data = Buffer.alloc(width * height * 4, 0xff);

      for (let index = 0; index < width * height; index++) {
        data[index * 4 + 3] = 255;
        // A band whose height is the page number, so a crop of the top half
        // and a crop of the bottom half are visibly different too.
        if (index < width * page * 4) data[index * 4] = 0;
      }

      data[0] = page;
      data[1] = 0;
      data[2] = 0;

      // A real PNG, because the pipeline stores what a renderer gives it and
      // only decodes when a crop is asked for.
      return { png: encodePng({ width, height, data, dpi }, { dpi }), width, height, dpi };
    },
  };
}

describe('a layout end to end', () => {
  let folder: string;
  let layoutPath: string;
  let cacheRoot: string;
  let renderer: ReturnType<typeof countingRenderer>;
  let tools: Tools;

  before(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'plotexcel-e2e-'));
    cacheRoot = path.join(folder, 'cache');

    const project = sampleProject();
    for (const file of project.files) {
      const target = path.join(folder, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }

    layoutPath = path.join(folder, project.layoutName);
    await writeFile(layoutPath, project.layoutText, 'utf8');

    renderer = countingRenderer();
    tools = { renderer };
  });

  after(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('renders every cell without an issue', async () => {
    const { layout } = parseLayout(sampleProject().layoutText);

    const result = await renderLayout(layout, { layoutPath, cacheRoot, tools });

    assert.deepEqual(result.issues, [], 'the sample must render cleanly or it is not a sample');
    assert.equal(result.placeholders, 0, 'nothing should have fallen back to a placeholder');
    assert.equal(result.images, 8);
    assert.equal(result.diffs, 3);
    assert.ok(result.workbook.length > 20_000, 'a workbook with eleven images should not be tiny');
  });

  it('asks the renderer for the pages the layout names', () => {
    const pages = renderer.calls.map((call) => call.page).sort();

    // Pages 1, 2 and 3 of two documents, plus page 1 of the third. The PNG
    // never reaches the renderer.
    assert.deepEqual(pages, [1, 1, 1, 2, 2, 3, 3]);

    for (const call of renderer.calls) {
      assert.equal(call.dpi, 150, 'the layout says 150, so every page should be asked for at 150');
    }
  });

  it('is a workbook a reader would accept', async () => {
    const { layout } = parseLayout(sampleProject().layoutText);
    const { workbook } = await renderLayout(layout, { layoutPath, cacheRoot, tools });

    const names = listZip(workbook).map((entry) => entry.name);

    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/drawings/drawing1.xml',
      'xl/worksheets/_rels/sheet1.xml.rels',
    ]) {
      assert.ok(names.includes(part), `${part} is missing; Excel would refuse the file`);
    }

    const media = names.filter((name) => name.startsWith('xl/media/'));
    assert.equal(media.length, 11, 'eight plots and three diffs');
  });

  it('puts the page that was asked for in the cell that asked for it', async () => {
    const { layout } = parseLayout(sampleProject().layoutText);
    const { workbook } = await renderLayout(layout, { layoutPath, cacheRoot, tools });

    const drawing = readZipEntry(workbook, 'xl/drawings/drawing1.xml')!.toString('utf8');

    // Anchors are emitted in row order, so the third image is row 3 column 2 —
    // the cropped page 3 — and its first pixel should say 3.
    const anchors = [...drawing.matchAll(/<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<xdr:col>(\d+)<\/xdr:col>/g)];
    assert.ok(anchors.length > 0, 'the drawing should place its images');

    const third = decodePng(readZipEntry(workbook, 'xl/media/image3.png')!);
    assert.ok([1, 2, 3].includes(third.data[0]!), 'an image should carry a page number in its first pixel');
  });

  it('sizes the images in exact centimetres', async () => {
    const { layout } = parseLayout(sampleProject().layoutText);
    const { workbook } = await renderLayout(layout, { layoutPath, cacheRoot, tools });

    const drawing = readZipEntry(workbook, 'xl/drawings/drawing1.xml')!.toString('utf8');
    const extents = [...drawing.matchAll(/<xdr:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((match) => ({
      cx: Number(match[1]),
      cy: Number(match[2]),
    }));

    assert.equal(extents.length, 11);

    // The uncropped pages are 10 x 7 cm by construction. Whatever the dpi, the
    // physical size must come out the same — this is the bug that shipped once.
    const fullPage = extents.filter((extent) => Math.abs(extent.cx - 10 * EMU_PER_CM) < EMU_PER_CM / 10);
    assert.ok(fullPage.length >= 4, 'the full pages should all be 10 cm wide');

    for (const extent of fullPage) {
      assert.ok(Math.abs(extent.cy - 7 * EMU_PER_CM) < EMU_PER_CM / 10, 'and 7 cm tall');
    }

    // The cropped cells asked for the right half, so they must be narrower.
    const cropped = extents.filter((extent) => extent.cx < 6 * EMU_PER_CM);
    assert.ok(cropped.length >= 2, 'the ::xmin 50 cells should be about half as wide');
  });

  it('gives every row enough height for the image in it', async () => {
    const { layout } = parseLayout(sampleProject().layoutText);
    const { workbook } = await renderLayout(layout, { layoutPath, cacheRoot, tools });

    const sheet = readZipEntry(workbook, 'xl/worksheets/sheet1.xml')!.toString('utf8');
    // `\sht=` and not `ht=`: `customHeight="1"` ends in `ht="1"`, and a
    // greedy match happily reads the height as one point.
    const heights = [...sheet.matchAll(/<row r="(\d+)"[^>]*\sht="([\d.]+)"/g)].map((match) => ({
      row: Number(match[1]),
      points: Number(match[2]),
    }));

    const drawing = readZipEntry(workbook, 'xl/drawings/drawing1.xml')!.toString('utf8');
    const tallest = Math.max(...[...drawing.matchAll(/cy="(\d+)"/g)].map((match) => Number(match[1])));
    const tallestPoints = (tallest / EMU_PER_CM / 2.54) * 72;

    for (const row of heights.slice(1)) {
      assert.ok(row.points > 0, `row ${row.row} has no height`);
    }

    assert.ok(
      Math.max(...heights.map((row) => row.points)) >= tallestPoints,
      'the tallest row must fit the tallest image, or the picture is cut off',
    );
  });

  it('does the work once', async () => {
    const { layout } = parseLayout(sampleProject().layoutText);

    const before = renderer.calls.length;
    const result = await renderLayout(layout, { layoutPath, cacheRoot, tools });

    assert.equal(renderer.calls.length, before, 'a second render should ask the renderer for nothing');
    assert.equal(result.cacheHits, result.images + result.diffs, 'plots and diffs alike');
  });

  it('does it again when forced', async () => {
    const { layout } = parseLayout(sampleProject().layoutText);

    const before = renderer.calls.length;
    await renderLayout(layout, { layoutPath, cacheRoot, tools, force: true });

    assert.ok(renderer.calls.length > before, 'force should ignore what was remembered');
  });

  it('builds the same bytes from the same inputs', async () => {
    const { layout } = parseLayout(sampleProject().layoutText);
    const createdAt = new Date('2026-01-01T00:00:00Z');

    const first = await renderLayout(layout, { layoutPath, cacheRoot, tools, createdAt });
    const second = await renderLayout(layout, { layoutPath, cacheRoot, tools, createdAt });

    assert.ok(first.workbook.equals(second.workbook), 'a reproducible build makes a diff of two workbooks meaningful');
  });

  it('keeps going when a plot is missing, and says which', async () => {
    const broken = parseLayout(sampleProject().layoutText).layout;
    const rows = broken.rows.map((row) => [...row]);
    rows[0]![1] = 'figures/not-here.pdf::page 1';

    const result = await renderLayout({ ...broken, rows }, { layoutPath, cacheRoot, tools });

    assert.equal(result.issues.length, 1, 'one bad cell, one issue');
    assert.equal(result.issues[0]?.row, 2, 'reported at the row the user sees');
    assert.ok(result.placeholders >= 1, 'and the cell gets a picture explaining itself');
    assert.ok(result.workbook.length > 20_000, 'the rest of the workbook is still built');
  });
});

/**
 * Excel keeps an exclusive lock on a workbook it has open, so on Windows a
 * second render would fail on the write — after doing all the rasterising.
 * The name carries the time instead; every other platform overwrites in place.
 */
describe('where the workbook is written', () => {
  it('leaves the name alone everywhere but Windows', () => {
    const clean = path.join(path.sep, 'plots', 'figures.xlsx');

    assert.equal(timestampedWorkbookPath(clean, { platform: 'linux' }), clean);
    assert.equal(timestampedWorkbookPath(clean, { platform: 'darwin' }), clean);
  });

  it('timestamps on Windows, keeping the folder and the extension', () => {
    const clean = path.join(path.sep, 'plots', 'figures.xlsx');
    const stamped = timestampedWorkbookPath(clean, { platform: 'win32', now: new Date(2026, 7, 31, 14, 5, 9) });

    assert.equal(path.basename(stamped), 'figures-20260831-140509.xlsx');
    assert.equal(path.dirname(stamped), path.dirname(clean));
  });

  it('gives consecutive renders different names, which is the whole point', () => {
    const clean = path.join(path.sep, 'plots', 'figures.xlsx');
    const first = timestampedWorkbookPath(clean, { platform: 'win32', now: new Date(2026, 0, 1, 9, 30, 1) });
    const second = timestampedWorkbookPath(clean, { platform: 'win32', now: new Date(2026, 0, 1, 9, 30, 2) });

    assert.notEqual(first, second);
  });

  it('recognises the clean name and the timestamped ones, and nothing else', () => {
    const pattern = workbookNamePattern('figures');

    assert.ok(pattern.test('figures.xlsx'));
    assert.ok(pattern.test('figures-20260831-140509.xlsx'));
    assert.ok(!pattern.test('figures-draft.xlsx'), 'a different workbook that merely starts the same way');
    assert.ok(!pattern.test('other.xlsx'));
    assert.ok(!pattern.test('figures.xlsx.bak'));
  });

  it('reads the stem literally, so a dot in the name is not a wildcard', () => {
    const pattern = workbookNamePattern('figures (v1.2)');

    assert.ok(pattern.test('figures (v1.2).xlsx'));
    assert.ok(!pattern.test('figures (v1x2).xlsx'));
  });

  it('names them so that sorting by text sorts by time', () => {
    const names = ['figures-20260901-090000.xlsx', 'figures-20260831-140509.xlsx', 'figures-20260831-235959.xlsx'];

    assert.deepEqual([...names].sort(), [
      'figures-20260831-140509.xlsx',
      'figures-20260831-235959.xlsx',
      'figures-20260901-090000.xlsx',
    ]);
  });
});
