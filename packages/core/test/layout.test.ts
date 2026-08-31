import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatLayout, isLayoutFile, parseLayout } from '../src/layout/layoutFile.ts';

const sample = [
  '# generated from figs/, then edited',
  '#output: reports/plots.xlsx',
  '#resolution: 150',
  '#headerRowStyle: center',
  'Description\tCurrent\tBaseline\tDiff',
  'Iris, page 1::vcenter\tfigs/01.pdf::page 1\tfigs/01.pdf::page 1::commit HEAD~1\tdiff(Current, Baseline)',
  'Iris, page 2::vcenter\tfigs/01.pdf::page 2\tfigs/01.pdf::page 2::commit HEAD~1\tdiff(Current, Baseline)',
].join('\n');

describe('parseLayout', () => {
  it('reads options, comments, columns and rows', () => {
    const { layout, diagnostics } = parseLayout(sample);

    assert.deepEqual(diagnostics, []);
    assert.deepEqual(layout.options, {
      output: 'reports/plots.xlsx',
      resolution: 150,
      headerRowStyle: 'center',
    });
    assert.deepEqual(layout.comments, ['# generated from figs/, then edited']);
    assert.deepEqual(layout.columns, ['Description', 'Current', 'Baseline', 'Diff']);
    assert.equal(layout.rows.length, 2);
    assert.equal(layout.rows[0]?.[3], 'diff(Current, Baseline)');
  });

  it('keeps commas unquoted, which is the whole reason for tabs', () => {
    const { layout } = parseLayout(sample);
    assert.equal(layout.rows[0]?.[0], 'Iris, page 1::vcenter');
  });

  it('pads short rows to the width of the header', () => {
    const { layout, diagnostics } = parseLayout('A\tB\tC\nonly one');
    assert.deepEqual(layout.rows[0], ['only one', '', '']);
    assert.deepEqual(diagnostics, []);
  });

  it('flags a row with more cells than the header', () => {
    const { diagnostics } = parseLayout('A\tB\none\ttwo\tthree');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.severity, 'error');
    assert.match(diagnostics[0]?.message ?? '', /stray tab/);
    assert.equal(diagnostics[0]?.line, 2);
  });

  it('flags duplicate and empty column names', () => {
    const duplicate = parseLayout('A\tA\nx\ty').diagnostics;
    assert.match(duplicate[0]?.message ?? '', /appears more than once/);

    const empty = parseLayout('A\t\nx\ty').diagnostics;
    assert.match(empty[0]?.message ?? '', /Every column needs a name/);
  });

  it('warns about an unknown option instead of failing', () => {
    const { layout, diagnostics } = parseLayout('#resolutions: 150\nA\nx');
    assert.equal(diagnostics[0]?.severity, 'warning');
    assert.match(diagnostics[0]?.message ?? '', /Known options: output, resolution/);
    assert.deepEqual(layout.options, {});
  });

  it('rejects an option value of the wrong type', () => {
    assert.match(parseLayout('#resolution: high\nA\nx').diagnostics[0]?.message ?? '', /positive number/);
    assert.match(parseLayout('#addBorders: maybe\nA\nx').diagnostics[0]?.message ?? '', /true or false/);
    assert.match(parseLayout('#pdfPageSize: A3\nA\nx').diagnostics[0]?.message ?? '', /"single" or "A4"/);
  });

  it('reports a file with no header row', () => {
    assert.match(parseLayout('#output: a.xlsx\n').diagnostics[0]?.message ?? '', /no header row/);
  });

  it('ignores blank lines and tolerates CRLF', () => {
    const { layout, diagnostics } = parseLayout('A\tB\r\n\r\nx\ty\r\n');
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(layout.rows, [['x', 'y']]);
  });
});

describe('formatLayout', () => {
  it('round-trips a layout unchanged', () => {
    const { layout } = parseLayout(sample);
    const { layout: again } = parseLayout(formatLayout(layout));
    assert.deepEqual(again, layout);
  });

  it('refuses a cell that would break the format', () => {
    assert.throws(
      () => formatLayout({ options: {}, comments: [], columns: ['A'], rows: [['has\ttab']] }),
      /contains a tab or newline/,
    );
  });
});

describe('isLayoutFile', () => {
  it('matches the double extension anywhere, not just in .plotexcel/', () => {
    assert.ok(isLayoutFile('/w/.plotexcel/layouts/figs.plotexcel.tsv'));
    assert.ok(isLayoutFile('C:\\work\\report.PlotExcel.TSV'));
    assert.ok(!isLayoutFile('/w/data.tsv'));
  });
});
