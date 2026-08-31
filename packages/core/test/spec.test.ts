import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyCell, plotExtensionOf } from '../src/spec/classify.ts';
import { parseDiffSpec } from '../src/spec/diffSpec.ts';
import { parsePlotSpec } from '../src/spec/plotSpec.ts';
import { parseTextSpec } from '../src/spec/textSpec.ts';
import { SpecError } from '../src/types.ts';

describe('parsePlotSpec', () => {
  it('applies defaults when only a path is given', () => {
    assert.deepEqual(parsePlotSpec('figs/01-Iris.pdf'), {
      path: 'figs/01-Iris.pdf',
      commit: 'HEAD',
      page: 1,
      xmin: 0,
      xmax: 100,
      ymin: 0,
      ymax: 100,
      resolution: 100,
    });
  });

  it('reads decorators in any order', () => {
    const spec = parsePlotSpec('a.pdf::xmax 85::page 2::commit HEAD~1::resolution 150');
    assert.equal(spec.page, 2);
    assert.equal(spec.xmax, 85);
    assert.equal(spec.commit, 'HEAD~1');
    assert.equal(spec.resolution, 150);
  });

  it('keeps Windows paths intact', () => {
    assert.equal(parsePlotSpec('C:\\Projects\\plots\\a.pdf::page 3').path, 'C:\\Projects\\plots\\a.pdf');
    assert.equal(parsePlotSpec('C:/Projects/plots/a.pdf').path, 'C:/Projects/plots/a.pdf');
  });

  it('takes layout-level defaults for keys the cell omits', () => {
    const spec = parsePlotSpec('a.pdf::page 2', { defaults: { resolution: 150 } });
    assert.equal(spec.resolution, 150);
    assert.equal(spec.page, 2);
  });

  it('does not prefix-match keys the way the R version did', () => {
    // "xmax" must not be matched by a lookup for "xmin", and vice versa.
    const spec = parsePlotSpec('a.pdf::xmin 10::xmax 90');
    assert.equal(spec.xmin, 10);
    assert.equal(spec.xmax, 90);
  });

  it('rejects an unknown option and says which are valid', () => {
    assert.throws(() => parsePlotSpec('a.pdf::pages 2'), (error: SpecError) => {
      assert.match(error.message, /Unknown option "pages"/);
      assert.match(error.detail?.hint ?? '', /commit, page, xmin/);
      return true;
    });
  });

  it('rejects a repeated option', () => {
    assert.throws(() => parsePlotSpec('a.pdf::page 1::page 2'), /set twice/);
  });

  it('rejects an option with no value', () => {
    assert.throws(() => parsePlotSpec('a.pdf::page'), /needs a value/);
  });

  it('rejects a non-numeric page', () => {
    assert.throws(() => parsePlotSpec('a.pdf::page two'), /must be a number/);
  });

  it('rejects an empty or inverted crop', () => {
    assert.throws(() => parsePlotSpec('a.pdf::xmin 80::xmax 20'), /xmin \(80\) must be smaller/);
    assert.throws(() => parsePlotSpec('a.pdf::ymin 50::ymax 50'), /ymin \(50\) must be smaller/);
  });

  it('rejects crop bounds outside 0-100', () => {
    assert.throws(() => parsePlotSpec('a.pdf::xmax 140'), /between 0 and 100/);
  });

  it('rounds crop bounds so cache keys stay stable', () => {
    const spec = parsePlotSpec('a.pdf::xmin 12.4::xmax 87.6');
    assert.equal(spec.xmin, 12);
    assert.equal(spec.xmax, 88);
  });
});

describe('parseTextSpec', () => {
  it('defaults to the left style', () => {
    assert.deepEqual(parseTextSpec('Iris'), { text: 'Iris', style: 'left' });
  });

  it('accepts a style by name and by number', () => {
    assert.deepEqual(parseTextSpec('Iris::vcenter'), { text: 'Iris', style: 'vcenter' });
    assert.deepEqual(parseTextSpec('Iris::3'), { text: 'Iris', style: 'vcenter' });
  });

  it('keeps commas in the text, which generated descriptions contain', () => {
    assert.deepEqual(parseTextSpec('figs / 01-Iris.pdf, page 2::vcenter'), {
      text: 'figs / 01-Iris.pdf, page 2',
      style: 'vcenter',
    });
  });

  it('keeps text that contains :: when the tail is not a style', () => {
    // R took the second segment unconditionally and lost the rest.
    assert.deepEqual(parseTextSpec('Ratio A::B over time'), { text: 'Ratio A::B over time', style: 'left' });
  });

  it('uses the last :: when the text itself contains one', () => {
    assert.deepEqual(parseTextSpec('Ratio A::B::center'), { text: 'Ratio A::B', style: 'center' });
  });

  it('treats an out-of-range style number as ordinary text', () => {
    assert.deepEqual(parseTextSpec('Iris::99'), { text: 'Iris::99', style: 'left' });
  });
});

describe('parseDiffSpec', () => {
  it('reads two column names', () => {
    assert.deepEqual(parseDiffSpec('diff(Current, Baseline)'), { column1: 'Current', column2: 'Baseline' });
  });

  it('reads backticked names, including ones with commas', () => {
    assert.deepEqual(parseDiffSpec('diff(`Plots 1`, `Plots, 2`)'), { column1: 'Plots 1', column2: 'Plots, 2' });
  });

  it('tolerates missing spaces and odd casing', () => {
    assert.deepEqual(parseDiffSpec('Diff(A,B)'), { column1: 'A', column2: 'B' });
  });

  it('rejects the wrong number of columns', () => {
    assert.throws(() => parseDiffSpec('diff(A)'), /exactly two column names/);
    assert.throws(() => parseDiffSpec('diff(A, B, C)'), /exactly two column names/);
  });

  it('rejects a missing bracket', () => {
    assert.throws(() => parseDiffSpec('diff(A, B'), /closing bracket/);
  });
});

describe('classifyCell', () => {
  it('recognises plots by extension, without touching the filesystem', () => {
    const cell = classifyCell('does/not/exist.pdf::page 2');
    assert.equal(cell.kind, 'plot');
  });

  it('recognises every supported input format', () => {
    for (const extension of ['pdf', 'png', 'docx', 'pptx', 'xlsx', 'html', 'htm']) {
      assert.equal(classifyCell(`a.${extension}`).kind, 'plot', extension);
    }
  });

  it('does not mistake prose that mentions a file for a plot', () => {
    assert.equal(classifyCell('see results.pdf below::center').kind, 'text');
    assert.equal(plotExtensionOf('see results.pdf below'), undefined);
  });

  it('recognises diffs and empty cells', () => {
    assert.equal(classifyCell('diff(A, B)').kind, 'diff');
    assert.equal(classifyCell('   ').kind, 'empty');
  });

  it('treats an unsupported extension as text', () => {
    assert.equal(classifyCell('notes.txt').kind, 'text');
  });
});

describe('a diff cell with options', () => {
  it('reads a tolerance', () => {
    assert.deepEqual(parseDiffSpec('diff(A, B)::tolerance 0.3'), {
      column1: 'A',
      column2: 'B',
      tolerance: 0.3,
    });
  });

  it('reads context on and off', () => {
    assert.equal(parseDiffSpec('diff(A, B)::context off').context, false);
    assert.equal(parseDiffSpec('diff(A, B)::context on').context, true);
  });

  it('takes both, in either order', () => {
    const spec = parseDiffSpec('diff(A, B)::context off::tolerance 0.25');
    assert.equal(spec.tolerance, 0.25);
    assert.equal(spec.context, false);
  });

  it('still reads a bracket inside a backticked column name', () => {
    const spec = parseDiffSpec('diff(`Run (a)`, `Run (b)`)::tolerance 0.2');
    assert.equal(spec.column1, 'Run (a)');
    assert.equal(spec.tolerance, 0.2);
  });

  it('refuses a tolerance outside 0 to 1', () => {
    assert.throws(() => parseDiffSpec('diff(A, B)::tolerance 5'), /not a tolerance/);
    assert.throws(() => parseDiffSpec('diff(A, B)::tolerance -1'), /not a tolerance/);
    assert.throws(() => parseDiffSpec('diff(A, B)::tolerance loose'), /not a tolerance/);
  });

  it('names a decorator it does not have, rather than ignoring it', () => {
    // A misspelt option that is silently dropped is a comparison that looks
    // right and is not.
    assert.throws(() => parseDiffSpec('diff(A, B)::tolerence 0.2'), /no "tolerence" option/);
  });

  it('complains about anything else after the bracket', () => {
    assert.throws(() => parseDiffSpec('diff(A, B) 0.2'), /after its closing bracket/);
  });
});
