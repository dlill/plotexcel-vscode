import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countPdfPagesInText } from '../src/documents/pdfPages.ts';
import { decodePng } from '../src/image/png.ts';
import { parseLayout } from '../src/layout/layoutFile.ts';
import { classifyCell } from '../src/spec/classify.ts';
import { samplePdf } from '../src/samples/samplePdf.ts';
import { sampleProject } from '../src/samples/sampleProject.ts';

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('the sample PDF', () => {
  const page = {
    title: 'Model fit',
    subtitle: 'observed against predicted',
    series: [0.1, 0.5, 0.3, 0.9],
    kind: 'line',
  } as const;

  it('is a PDF', () => {
    const text = latin1(samplePdf({ pages: [page] }));

    assert.ok(text.startsWith('%PDF-1.'), 'should start with the header');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'should end with the trailer');
  });

  it('has a cross-reference table pointing at real objects', () => {
    const bytes = samplePdf({ pages: [page, { ...page, kind: 'bars' }] });
    const text = latin1(bytes);

    const startxref = /startxref\s+(\d+)/.exec(text);
    assert.ok(startxref, 'should declare where the table starts');
    assert.ok(text.slice(Number(startxref[1])).startsWith('xref'), 'startxref should point at the table');

    // Every offset in the table should land exactly on its object header —
    // the one thing a hand-written PDF gets wrong, and the one thing a
    // reader will not forgive.
    const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text);
    assert.ok(table, 'should have a table');

    const rows = (table[2] ?? '').trimEnd().split('\n');
    assert.equal(rows.length, Number(table[1]), 'a row per object, plus the free one');

    for (const [index, row] of rows.slice(1).entries()) {
      const at = Number(row.slice(0, 10));
      assert.ok(text.startsWith(`${index + 1} 0 obj`, at), `object ${index + 1} is not at offset ${at}`);
    }
  });

  it('counts its own pages', () => {
    for (const count of [1, 2, 5]) {
      const bytes = samplePdf({ pages: Array.from({ length: count }, () => page) });
      assert.deepEqual(countPdfPagesInText(latin1(bytes)), { pages: count, confidence: 'exact' });
    }
  });

  it('declares the true length of each content stream', () => {
    const text = latin1(samplePdf({ pages: [page] }));

    for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
      const declared = Number(match[1]);
      const actual = new TextEncoder().encode(match[2] ?? '').length;
      assert.equal(actual, declared, 'a wrong /Length is how a reader loses the rest of the file');
    }
  });

  it('refuses to make a PDF with no pages', () => {
    assert.throws(() => samplePdf({ pages: [] }), /at least one page/);
  });
});

describe('the sample project', () => {
  const project = sampleProject();

  it('writes a layout with no complaints about it', () => {
    const { diagnostics } = parseLayout(project.layoutText);
    assert.deepEqual(diagnostics, [], 'the sample must not be the first thing to show an error');
  });

  it('references only files it also provides', () => {
    const { layout } = parseLayout(project.layoutText);
    const provided = new Set(project.files.map((file) => file.path));

    for (const row of layout.rows) {
      for (const raw of row) {
        const cell = classifyCell(raw);
        if (cell.kind !== 'plot') continue;

        assert.ok(provided.has(cell.spec.path), `${cell.spec.path} is referenced but not generated`);
      }
    }
  });

  it('shows off the features worth knowing about', () => {
    const text = project.layoutText;

    assert.match(text, /::page 2/, 'a page other than the first');
    assert.match(text, /::xmin /, 'a crop');
    assert.match(text, /::vcenter/, 'a caption style');
    assert.match(text, /diff\(/, 'a comparison column');
  });

  it('includes an image that needs no renderer at all', () => {
    const png = project.files.find((file) => file.path.endsWith('.png'));
    assert.ok(png, 'there should be one PNG, for machines with nothing installed');

    const image = decodePng(Buffer.from(png.bytes));
    assert.equal(image.width, 620);
    assert.equal(image.height, 440);
    assert.equal(image.dpi, 150);
  });

  it('is the same every time', () => {
    const again = sampleProject();

    for (const [index, file] of project.files.entries()) {
      assert.equal(file.path, again.files[index]?.path);
      assert.ok(Buffer.from(file.bytes).equals(Buffer.from(again.files[index]!.bytes)), `${file.path} differs`);
    }
  });
});
