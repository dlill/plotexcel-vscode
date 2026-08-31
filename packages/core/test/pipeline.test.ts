import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderLayout } from '../src/build/renderLayout.ts';
import { decodePng, encodePng } from '../src/image/png.ts';
import { parseLayout } from '../src/layout/layoutFile.ts';
import { mapWithLimit } from '../src/pipeline/limit.ts';
import type { DocumentConverter, PdfRenderer, RevisionReader } from '../src/pipeline/ports.ts';
import { renderDiff } from '../src/pipeline/renderDiff.ts';
import { renderPlot } from '../src/pipeline/renderPlot.ts';
import { parsePlotSpec } from '../src/spec/plotSpec.ts';
import { listZip, readZipEntry } from '../src/zip/zip.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

function workspace(): { dir: string; cacheRoot: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'plotexcel-test-'));
  return { dir, cacheRoot: path.join(dir, 'cache') };
}

/**
 * A stand-in renderer: a gradient whose size follows the requested dpi.
 *
 * It returns PNG bytes because that is what a renderer produces; the pipeline
 * keeps them and decodes only when a cell asks for a crop.
 */
function stubRenderer(calls: { count: number } = { count: 0 }): PdfRenderer {
  return {
    name: 'stub',
    async renderPage({ page, dpi }) {
      calls.count += 1;
      const width = Math.round(dpi / 2);
      const height = Math.round(dpi / 4);
      const data = Buffer.allocUnsafe(width * height * 4);
      for (let index = 0; index < width * height; index += 1) {
        data[index * 4] = (index + page * 40) % 256;
        data[index * 4 + 1] = page * 20;
        data[index * 4 + 2] = 128;
        data[index * 4 + 3] = 255;
      }
      return { png: encodePng({ width, height, data, dpi }, { dpi }), width, height, dpi };
    },
  };
}

const stubConverter: DocumentConverter = {
  name: 'stub office',
  canConvert: (extension) => ['docx', 'pptx'].includes(extension),
  async toPdf() {
    return Buffer.from('%PDF-1.4 pretend');
  },
};

function stubRevisions(contents: Record<string, Buffer | undefined>): RevisionReader {
  return {
    name: 'stub git',
    async read({ revision }) {
      return contents[revision];
    },
    async isTracked() {
      return true;
    },
  };
}

const samplePng = readFileSync(path.join(fixtures, 'png', 'rgb-all-filters.png'));

describe('mapWithLimit', () => {
  it('keeps results in input order', async () => {
    const results = await mapWithLimit([5, 1, 3], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 2;
    });
    assert.deepEqual(results, [10, 2, 6]);
  });

  it('never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;

    await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });

    assert.equal(peak, 3);
  });
});

describe('renderPlot', () => {
  it('renders a PNG plot and reports its physical size', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'plot.png'), samplePng);

    const result = await renderPlot(parsePlotSpec('plot.png::resolution 150'), { baseDir: dir, cacheRoot });

    assert.equal(result.issue, undefined);
    assert.equal(result.widthPx, 12);
    assert.equal(result.heightPx, 10);
    assert.ok(Math.abs(result.widthCm - (12 / 150) * 2.54) < 1e-9);
    assert.equal(result.fromCache, false);
  });

  it('serves the second render from the cache', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'plot.png'), samplePng);
    const spec = parsePlotSpec('plot.png');

    const first = await renderPlot(spec, { baseDir: dir, cacheRoot });
    const second = await renderPlot(spec, { baseDir: dir, cacheRoot });
    const forced = await renderPlot(spec, { baseDir: dir, cacheRoot, force: true });

    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true);
    assert.equal(forced.fromCache, false);
    assert.deepEqual(second.png, first.png);
  });

  it('re-renders when the source file changes', async () => {
    const { dir, cacheRoot } = workspace();
    const file = path.join(dir, 'plot.png');
    writeFileSync(file, samplePng);
    const spec = parsePlotSpec('plot.png');

    await renderPlot(spec, { baseDir: dir, cacheRoot });

    const image = decodePng(samplePng);
    image.data.fill(7);
    const future = new Date(Date.now() + 5000);
    writeFileSync(file, encodePng(image));
    const { utimesSync } = await import('node:fs');
    utimesSync(file, future, future);

    const again = await renderPlot(spec, { baseDir: dir, cacheRoot });
    assert.equal(again.fromCache, false);
  });

  it('crops in percent of the rendered page', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'plot.png'), samplePng);

    const full = await renderPlot(parsePlotSpec('plot.png'), { baseDir: dir, cacheRoot });
    const half = await renderPlot(parsePlotSpec('plot.png::xmax 50'), { baseDir: dir, cacheRoot });

    assert.equal(full.widthPx, 12);
    assert.equal(half.widthPx, 6);
  });

  it('renders a PDF page through the renderer, at the requested dpi', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'plot.pdf'), readFileSync(path.join(fixtures, 'docs', '01-Iris.pdf')));
    const calls = { count: 0 };

    const result = await renderPlot(parsePlotSpec('plot.pdf::page 2::resolution 300'), {
      baseDir: dir,
      cacheRoot,
      tools: { renderer: stubRenderer(calls) },
    });

    assert.equal(result.issue, undefined);
    assert.equal(result.widthPx, 150);
    assert.equal(result.dpi, 300);
    assert.equal(calls.count, 1);
  });

  it('explains a missing file instead of failing', async () => {
    const { dir, cacheRoot } = workspace();
    const result = await renderPlot(parsePlotSpec('nowhere.pdf'), { baseDir: dir, cacheRoot });

    assert.equal(result.issue?.kind, 'missing-file');
    assert.match(result.issue?.headline ?? '', /not found/i);
    assert.ok(result.png.length > 0, 'a placeholder image is still produced');
    assert.equal(result.cachePath, undefined, 'placeholders are never cached');
  });

  it('explains a missing renderer', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'plot.pdf'), Buffer.from('%PDF-1.4'));

    const result = await renderPlot(parsePlotSpec('plot.pdf'), { baseDir: dir, cacheRoot });
    assert.equal(result.issue?.kind, 'no-renderer');
  });

  it('explains a missing converter, naming what to install', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'deck.pptx'), Buffer.from('PK'));

    const result = await renderPlot(parsePlotSpec('deck.pptx'), { baseDir: dir, cacheRoot });
    assert.equal(result.issue?.kind, 'no-converter');
    assert.match(result.issue?.details.join(' ') ?? '', /Microsoft Office or LibreOffice/);
  });

  it('converts an Office file when a converter is available', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'deck.pptx'), Buffer.from('PK'));

    const result = await renderPlot(parsePlotSpec('deck.pptx'), {
      baseDir: dir,
      cacheRoot,
      tools: { converter: stubConverter, renderer: stubRenderer() },
    });

    assert.equal(result.issue, undefined);
  });

  it('reads a plot from a revision, and says when it was not there', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'plot.png'), samplePng);
    const revisions = stubRevisions({ 'HEAD~1': samplePng, 'HEAD~9': undefined });

    const present = await renderPlot(parsePlotSpec('plot.png::commit HEAD~1'), {
      baseDir: dir,
      cacheRoot,
      tools: { revisions },
    });
    const absent = await renderPlot(parsePlotSpec('plot.png::commit HEAD~9'), {
      baseDir: dir,
      cacheRoot,
      tools: { revisions },
    });

    assert.equal(present.issue, undefined);
    assert.equal(absent.issue?.kind, 'missing-revision');
  });

  it('needs no git for the working-tree copy', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'plot.png'), samplePng);

    const result = await renderPlot(parsePlotSpec('plot.png'), { baseDir: dir, cacheRoot });
    assert.equal(result.issue, undefined);
  });

  it('reports every stage it goes through', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'plot.png'), samplePng);
    const stages: string[] = [];

    await renderPlot(parsePlotSpec('plot.png'), {
      baseDir: dir,
      cacheRoot,
      onStage: (stage) => stages.push(stage),
    });

    assert.deepEqual(stages, ['cache', 'checkout', 'convert', 'rasterise', 'crop', 'write']);
  });
});

describe('renderDiff', () => {
  it('compares two rendered plots and caches the result', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'a.png'), samplePng);

    const image = decodePng(samplePng);
    image.data.fill(9, 0, 40);
    writeFileSync(path.join(dir, 'b.png'), encodePng(image));

    const first = await renderPlot(parsePlotSpec('a.png'), { baseDir: dir, cacheRoot });
    const second = await renderPlot(parsePlotSpec('b.png'), { baseDir: dir, cacheRoot });

    const diff = await renderDiff(first, second, { cacheRoot });
    assert.ok(diff.changed > 0);
    assert.equal(diff.fromCache, false);

    const again = await renderDiff(first, second, { cacheRoot });
    assert.equal(again.fromCache, true);
    assert.equal(again.changed, diff.changed, 'the percentage survives a cache hit');
  });

  it('does not cache a diff of a placeholder', async () => {
    const { dir, cacheRoot } = workspace();
    const missing = await renderPlot(parsePlotSpec('nope.png'), { baseDir: dir, cacheRoot });

    const diff = await renderDiff(missing, missing, { cacheRoot });
    const again = await renderDiff(missing, missing, { cacheRoot });

    assert.equal(diff.fromCache, false);
    assert.equal(again.fromCache, false);
  });
});

describe('renderLayout', () => {
  function layoutIn(dir: string, body: string) {
    const layoutPath = path.join(dir, 'plots.plotexcel.tsv');
    writeFileSync(layoutPath, body);
    return { layoutPath, layout: parseLayout(body).layout };
  }

  it('builds a workbook from text, plots and a diff', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'a.png'), samplePng);
    const changed = decodePng(samplePng);
    changed.data.fill(3, 0, 60);
    writeFileSync(path.join(dir, 'b.png'), encodePng(changed));

    const { layoutPath, layout } = layoutIn(
      dir,
      ['#resolution: 150', 'Description\tCurrent\tBaseline\tDiff', 'Row one::vcenter\ta.png\tb.png\tdiff(Current, Baseline)'].join('\n'),
    );

    const result = await renderLayout(layout, { layoutPath, cacheRoot });

    assert.deepEqual(result.issues, []);
    assert.equal(result.images, 2);
    assert.equal(result.diffs, 1);
    assert.equal(result.textCells, 5, 'four headers and one description');
    assert.equal(result.outputPath, path.join(dir, 'plots.xlsx'));

    const parts = listZip(result.workbook).map((entry) => entry.name);
    assert.equal(parts.filter((name) => name.startsWith('xl/media/')).length, 3);

    const sheet = readZipEntry(result.workbook, 'xl/worksheets/sheet1.xml')!.toString('utf8');
    assert.match(sheet, /<t xml:space="preserve">Description<\/t>/);
    assert.match(sheet, /<t xml:space="preserve">Row one<\/t>/);
  });

  it('honours #output and puts the workbook where it says', async () => {
    const { dir, cacheRoot } = workspace();
    const { layoutPath, layout } = layoutIn(dir, ['#output: reports/final.xlsx', 'A', 'text'].join('\n'));

    const result = await renderLayout(layout, { layoutPath, cacheRoot });
    assert.equal(result.outputPath, path.join(dir, 'reports', 'final.xlsx'));
  });

  it('reports a bad cell as an issue and still builds', async () => {
    const { dir, cacheRoot } = workspace();
    const { layoutPath, layout } = layoutIn(dir, ['Description\tPlot', 'row\tplot.pdf::page zero'].join('\n'));

    const result = await renderLayout(layout, { layoutPath, cacheRoot });

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.row, 2);
    assert.equal(result.issues[0]?.column, 2);
    assert.match(result.issues[0]?.issue.details.join(' ') ?? '', /must be a number/);
    assert.ok(result.workbook.length > 0);
  });

  it('names the column a diff cannot find', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'a.png'), samplePng);
    const { layoutPath, layout } = layoutIn(dir, ['Current\tDiff', 'a.png\tdiff(Current, Missing)'].join('\n'));

    const result = await renderLayout(layout, { layoutPath, cacheRoot });

    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0]?.issue.details.join(' ') ?? '', /no column called "Missing"/);
  });

  it('reports progress for every rendered cell', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'a.png'), samplePng);
    const events: string[] = [];

    const { layoutPath, layout } = layoutIn(dir, ['Plot', 'a.png', 'a.png::page 1::xmax 50'].join('\n'));
    await renderLayout(layout, { layoutPath, cacheRoot, onProgress: (event) => events.push(event.label) });

    assert.equal(events.length, 2);
    assert.match(events[0]!, /a\.png page 1/);
  });

  it('sizes columns and rows to the images in them', async () => {
    const { dir, cacheRoot } = workspace();
    writeFileSync(path.join(dir, 'a.png'), samplePng);
    const { layoutPath, layout } = layoutIn(dir, ['#textColWidth: 3', 'Description\tPlot', 'text\ta.png::resolution 96'].join('\n'));

    const result = await renderLayout(layout, { layoutPath, cacheRoot });
    const sheet = readZipEntry(result.workbook, 'xl/worksheets/sheet1.xml')!.toString('utf8');

    // 12 px at 96 dpi is 0.3175 cm; the text column keeps its 3 cm.
    assert.match(sheet, /<col min="1" max="1" width="16\.1/);
    assert.match(sheet, /<col min="2" max="2" width="1\.7/);
  });
});

describe('physical size', () => {
  it('sizes an image from the cell resolution, not the file metadata', async () => {
    const { dir, cacheRoot } = workspace();

    // A PNG that claims 300 dpi. The cell asks for 150, and the cell wins:
    // otherwise the same figure exported as PNG and as PDF would appear at
    // different sizes in the same column.
    const image = decodePng(samplePng);
    writeFileSync(path.join(dir, 'claims-300dpi.png'), encodePng(image, { dpi: 300 }));

    const result = await renderPlot(parsePlotSpec('claims-300dpi.png::resolution 150'), {
      baseDir: dir,
      cacheRoot,
    });

    assert.equal(result.dpi, 150);
    assert.ok(Math.abs(result.widthCm - (12 / 150) * 2.54) < 1e-9);
  });
});
