import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { diffPath, pipelinePaths, revisionSlug } from '../src/cache/keys.ts';
import { parsePlotSpec } from '../src/spec/plotSpec.ts';

const cacheRoot = '/tmp/plotexcel-test';
const baseDir = '/work/project';

function pathsFor(cell: string) {
  return pipelinePaths(parsePlotSpec(cell), { cacheRoot, baseDir, platform: 'linux' });
}

describe('pipelinePaths', () => {
  it('resolves the source against the layout file directory', () => {
    assert.equal(pathsFor('figs/a.pdf').source, '/work/project/figs/a.pdf');
  });

  it('names the four stages after the input that produced them', () => {
    const paths = pathsFor('figs/a.pdf::page 2::resolution 150::xmax 85');
    assert.equal(path.basename(paths.checkout), 'a-commit-HEAD.pdf');
    assert.equal(path.basename(paths.converted), 'a-commit-HEAD-topdf.pdf');
    assert.equal(path.basename(paths.page), 'a-commit-HEAD-topdf-page-02-res-150.png');
    assert.equal(path.basename(paths.cropped), 'a-commit-HEAD-topdf-page-02-res-150-crop-000-085-000-100.png');
  });

  it('converts external formats to pdf but passes png through', () => {
    assert.equal(path.extname(pathsFor('slides.pptx').converted), '.pdf');
    assert.equal(path.extname(pathsFor('figure.png').converted), '.png');
  });

  it('gives every distinct input a distinct cropped path', () => {
    const cells = [
      'figs/a.pdf',
      'figs/a.pdf::page 2',
      'figs/a.pdf::page 2::resolution 150',
      'figs/a.pdf::page 2::resolution 150::xmax 85',
      'figs/a.pdf::commit HEAD~1',
      'figs/b.pdf',
      'other/a.pdf',
    ];
    const cropped = new Set(cells.map((cell) => pathsFor(cell).cropped));
    assert.equal(cropped.size, cells.length);
  });

  it('is stable across calls, which is what makes the pipeline idempotent', () => {
    assert.deepEqual(pathsFor('figs/a.pdf::page 3'), pathsFor('figs/a.pdf::page 3'));
  });

  it('groups files of one folder into one cache directory', () => {
    assert.equal(path.dirname(pathsFor('figs/a.pdf').checkout), path.dirname(pathsFor('figs/b.pdf').checkout));
    assert.notEqual(path.dirname(pathsFor('figs/a.pdf').checkout), path.dirname(pathsFor('other/a.pdf').checkout));
  });

  it('folds case on Windows so one folder is not cached twice', () => {
    const spec = parsePlotSpec('C:\\Plots\\a.pdf');
    const upper = pipelinePaths(spec, { cacheRoot, platform: 'win32' });
    const lower = pipelinePaths(parsePlotSpec('c:\\plots\\a.pdf'), { cacheRoot, platform: 'win32' });
    assert.equal(path.dirname(upper.checkout), path.dirname(lower.checkout));
  });
});

describe('revisionSlug', () => {
  it('leaves an ordinary revision alone', () => {
    assert.equal(revisionSlug('HEAD'), 'HEAD');
    assert.equal(revisionSlug('a1b2c3d'), 'a1b2c3d');
  });

  it('makes branch names and HEAD~1 safe as file names', () => {
    for (const revision of ['HEAD~1', 'feature/new-plots', 'release/2026-01']) {
      const slug = revisionSlug(revision);
      assert.doesNotMatch(slug, /[^A-Za-z0-9._-]/, revision);
    }
  });

  it('does not let two different revisions collide', () => {
    assert.notEqual(revisionSlug('feature/a'), revisionSlug('feature-a'));
  });
});

describe('diffPath', () => {
  it('depends on both inputs and their order', () => {
    const a = diffPath('/x/one.png', '/x/two.png', cacheRoot);
    const b = diffPath('/x/two.png', '/x/one.png', cacheRoot);
    assert.notEqual(a, b);
    assert.equal(a, diffPath('/x/one.png', '/x/two.png', cacheRoot));
    assert.equal(path.dirname(a), path.join(cacheRoot, 'diff'));
  });
});
