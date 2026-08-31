import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readOption, readPage, removeOption, renumberCaption, setCrop, setOption } from '../src/layout/editCell.ts';
import { parsePlotSpec } from '../src/spec/plotSpec.ts';

describe('editing a cell', () => {
  const cell = 'figs/01-Iris.pdf::page 2::resolution 150';

  it('replaces an option in place, keeping the order', () => {
    assert.equal(setOption(cell, 'page', 5), 'figs/01-Iris.pdf::page 5::resolution 150');
  });

  it('appends an option that was not there', () => {
    assert.equal(setOption(cell, 'commit', 'HEAD~1'), `${cell}::commit HEAD~1`);
  });

  it('removes an option and leaves the rest alone', () => {
    assert.equal(removeOption(cell, 'resolution'), 'figs/01-Iris.pdf::page 2');
    assert.equal(removeOption(cell, 'commit'), cell);
  });

  it('reads what an option is set to', () => {
    assert.equal(readOption(cell, 'resolution'), '150');
    assert.equal(readOption(cell, 'xmax'), undefined);
    assert.equal(readPage(cell), 2);
    assert.equal(readPage('figs/a.pdf'), 1);
  });

  it('never mistakes part of a path for an option', () => {
    const awkward = 'figs/page 3/resolution study.pdf::page 4';
    assert.equal(readOption(awkward, 'page'), '4');
    assert.equal(removeOption(awkward, 'page'), 'figs/page 3/resolution study.pdf');
  });
});

describe('setCrop', () => {
  it('writes only the bounds that cut something', () => {
    assert.equal(setCrop('a.pdf', { xmin: 0, xmax: 85, ymin: 0, ymax: 100 }), 'a.pdf::xmax 85');
    assert.equal(
      setCrop('a.pdf', { xmin: 10, xmax: 90, ymin: 5, ymax: 95 }),
      'a.pdf::xmin 10::xmax 90::ymin 5::ymax 95',
    );
  });

  it('clears the crop when the window is the whole page', () => {
    assert.equal(setCrop('a.pdf::xmin 10::xmax 90', { xmin: 0, xmax: 100, ymin: 0, ymax: 100 }), 'a.pdf');
  });

  it('replaces an existing crop rather than adding to it', () => {
    const before = 'a.pdf::page 2::xmin 10::xmax 90::resolution 150';
    const after = setCrop(before, { xmin: 20, xmax: 80, ymin: 0, ymax: 100 });

    assert.equal(after, 'a.pdf::page 2::resolution 150::xmin 20::xmax 80');
    const spec = parsePlotSpec(after);
    assert.equal(spec.page, 2);
    assert.equal(spec.resolution, 150);
    assert.equal(spec.xmin, 20);
    assert.equal(spec.xmax, 80);
  });

  it('produces something the parser accepts, for any window', () => {
    for (const window of [
      { xmin: 0, xmax: 100, ymin: 0, ymax: 100 },
      { xmin: 1, xmax: 99, ymin: 1, ymax: 99 },
      { xmin: 49, xmax: 51, ymin: 0, ymax: 3 },
      { xmin: -5, xmax: 140, ymin: 0, ymax: 100 },
    ]) {
      const text = setCrop('a.pdf', window);
      assert.doesNotThrow(() => parsePlotSpec(text), text);
    }
  });
});

describe('renumberCaption', () => {
  it('follows the page it describes', () => {
    assert.equal(renumberCaption('figs / a.pdf, page 1::vcenter', 4), 'figs / a.pdf, page 4::vcenter');
    assert.equal(renumberCaption('A caption::vcenter', 4), 'A caption::vcenter');
  });
});
