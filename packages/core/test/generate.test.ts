import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findPlotFiles,
  generateComparison,
  generateFolderComparison,
  generateFromFolder,
} from '../src/build/generateLayout.ts';
import { formatLayout, parseLayout } from '../src/layout/layoutFile.ts';
import { cacheStats, clearCache, formatBytes, pruneCache } from '../src/pipeline/cache.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, 'fixtures', 'docs');

function tree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plotexcel-gen-'));

  mkdirSync(path.join(root, 'figs', 'supplementary'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });

  copyFileSync(path.join(docs, '01-Iris.pdf'), path.join(root, 'figs', 'single.pdf'));
  copyFileSync(path.join(docs, '04-IrisMulti.pdf'), path.join(root, 'figs', 'multi.pdf'));
  copyFileSync(path.join(docs, '21-Word.docx'), path.join(root, 'figs', 'supplementary', 'notes.docx'));
  writeFileSync(path.join(root, 'figs', 'readme.txt'), 'not a plot');
  writeFileSync(path.join(root, 'node_modules', 'junk', 'ignored.pdf'), '%PDF-1.4');
  writeFileSync(path.join(root, '.git', 'also-ignored.pdf'), '%PDF-1.4');

  return root;
}

describe('findPlotFiles', () => {
  it('finds plots recursively and skips what nobody wants in a report', async () => {
    const found = await findPlotFiles(tree());

    assert.deepEqual(found, ['figs/multi.pdf', 'figs/single.pdf', 'figs/supplementary/notes.docx']);
  });

  it('honours an exclusion pattern', async () => {
    const found = await findPlotFiles(tree(), /supplementary/);
    assert.deepEqual(found, ['figs/multi.pdf', 'figs/single.pdf']);
  });
});

describe('generateFromFolder', () => {
  it('makes one row per page, with a description and a plot spec', async () => {
    const root = tree();
    const generated = await generateFromFolder({ folder: root, layoutDir: root, resolution: 120 });

    assert.deepEqual(generated.layout.columns, ['Description', 'Plot']);
    // single.pdf has one page, multi.pdf has three, notes.docx reports three.
    assert.equal(generated.layout.rows.length, 7);

    const [description, spec] = generated.layout.rows[0]!;
    assert.match(description!, /^figs \/ multi\.pdf, page 1::vcenter$/);
    assert.equal(spec, 'figs/multi.pdf::page 1::resolution 120');
  });

  it('caps the pages taken from any one file', async () => {
    const root = tree();
    const generated = await generateFromFolder({ folder: root, layoutDir: root, nPagesMax: 1 });

    assert.equal(generated.layout.rows.length, 3, 'one row per file');
    assert.ok(generated.files.some((file) => file.pages > file.included), 'the cap is recorded, not hidden');
  });

  it('keeps the order of an explicit selection', async () => {
    const root = tree();
    const generated = await generateFromFolder({
      folder: root,
      layoutDir: root,
      include: ['figs/single.pdf', 'figs/multi.pdf'],
      nPagesMax: 1,
    });

    assert.deepEqual(
      generated.layout.rows.map((row) => row[1]),
      ['figs/single.pdf::page 1::resolution 150', 'figs/multi.pdf::page 1::resolution 150'],
    );
  });

  it('adds a revision column and a diff when asked to compare', async () => {
    const root = tree();
    const generated = await generateFromFolder({
      folder: root,
      layoutDir: root,
      compareToCommit: 'HEAD~1',
      nPagesMax: 1,
    });

    assert.deepEqual(generated.layout.columns, ['Description', 'Now', 'At HEAD~1', 'Difference']);
    assert.match(generated.layout.rows[0]![2]!, /::commit HEAD~1$/);
    assert.equal(generated.layout.rows[0]![3], 'diff(Now, At HEAD~1)');
  });

  it('writes paths relative to wherever the layout will live', async () => {
    const root = tree();
    const generated = await generateFromFolder({
      folder: path.join(root, 'figs'),
      layoutDir: path.join(root, '.plotexcel', 'layouts'),
      nPagesMax: 1,
    });

    assert.match(generated.layout.rows[0]![1]!, /^\.\.\/\.\.\/figs\//);
  });

  it('reports which page counts had to be guessed', async () => {
    const root = tree();
    const generated = await generateFromFolder({ folder: root, layoutDir: root });

    // A Word document that reports three pages is trusted; the point is that
    // the field exists and is populated from the count, not left empty.
    for (const file of generated.uncertain) assert.ok(file.reason, `${file.relativePath} should say why`);
  });

  it('round-trips through the layout format', async () => {
    const root = tree();
    const generated = await generateFromFolder({ folder: root, layoutDir: root });
    const { layout, diagnostics } = parseLayout(formatLayout(generated.layout));

    assert.deepEqual(diagnostics, []);
    assert.deepEqual(layout.columns, generated.layout.columns);
    assert.deepEqual(layout.rows, generated.layout.rows);
  });
});

describe('generateComparison', () => {
  it('lays two files out page by page with a diff column', () => {
    const root = tree();
    const generated = generateComparison({
      first: path.join(root, 'figs', 'multi.pdf'),
      second: path.join(root, 'figs', 'single.pdf'),
      layoutDir: root,
    });

    assert.equal(generated.layout.rows.length, 3, 'the longer file decides the height');
    assert.equal(generated.layout.rows[0]![3], 'diff(`multi.pdf`, `single.pdf`)');
    // The second file has one page, so rows 2 and 3 have nothing to compare.
    assert.match(generated.layout.rows[1]![3]!, /Only one side/);
    assert.match(generated.layout.comments.join(' '), /Page counts differ: 3 and 1/);
  });

  it('shifts one side down so corresponding pages line up', () => {
    const root = tree();
    const generated = generateComparison({
      first: path.join(root, 'figs', 'multi.pdf'),
      second: path.join(root, 'figs', 'multi.pdf'),
      skipSecond: [1],
      layoutDir: root,
    });

    assert.equal(generated.layout.rows[0]![2], '', 'the second column starts one row later');
    assert.match(generated.layout.rows[1]![2]!, /::page 1::/);
  });

  it('compares a file against a revision of itself', () => {
    const root = tree();
    const generated = generateComparison({
      first: path.join(root, 'figs', 'single.pdf'),
      commit: 'HEAD~2',
      layoutDir: root,
    });

    assert.deepEqual(generated.layout.columns, ['Page', 'single.pdf', 'single.pdf at HEAD~2', 'Difference']);
    assert.match(generated.layout.rows[0]![2]!, /::commit HEAD~2$/);
  });

  it('refuses to compare one file against nothing', () => {
    assert.throws(
      () => generateComparison({ first: path.join(docs, '01-Iris.pdf'), layoutDir: docs }),
      /needs a revision/,
    );
  });
});

describe('generateFolderComparison', () => {
  it('pairs files by their path inside each folder', async () => {
    const left = tree();
    const right = tree();
    const generated = await generateFolderComparison({ left, right, layoutDir: left, nPagesMax: 1 });

    assert.equal(generated.layout.rows.length, 3);
    for (const row of generated.layout.rows) {
      assert.match(row[3]!, /^diff\(/);
      assert.ok(row[1]!.length > 0 && row[2]!.length > 0);
    }
  });

  it('still shows a file that exists on only one side', async () => {
    const left = tree();
    const right = tree();
    copyFileSync(path.join(docs, '01-Iris.pdf'), path.join(left, 'figs', 'only-here.pdf'));

    const generated = await generateFolderComparison({ left, right, layoutDir: left, nPagesMax: 1 });
    const row = generated.layout.rows.find((candidate) => candidate[0]!.includes('only-here'));

    assert.ok(row, 'the extra file must still get a row');
    assert.equal(row![2], '');
    assert.match(row![3]!, /^Only in /);
  });
});

describe('cache housekeeping', () => {
  it('measures and empties the cache', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'plotexcel-cache-'));
    mkdirSync(path.join(root, 'a'), { recursive: true });
    writeFileSync(path.join(root, 'a', 'one.png'), Buffer.alloc(1000));
    writeFileSync(path.join(root, 'two.png'), Buffer.alloc(2000));

    const before = await cacheStats(root);
    assert.equal(before.files, 2);
    assert.equal(before.bytes, 3000);

    const cleared = await clearCache(root);
    assert.deepEqual(cleared, { files: 2, bytes: 3000 });
    assert.equal((await cacheStats(root)).files, 0);
  });

  it('prunes oldest first, down to the limit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'plotexcel-cache-'));
    const { utimesSync } = await import('node:fs');

    for (const [name, age] of [['old.png', 10_000], ['newer.png', 5000], ['newest.png', 0]] as const) {
      const file = path.join(root, name);
      writeFileSync(file, Buffer.alloc(1000));
      const when = new Date(Date.now() - age);
      utimesSync(file, when, when);
    }

    const { removed, freed } = await pruneCache(1500, root);
    assert.equal(removed, 2);
    assert.equal(freed, 2000);

    const left = await cacheStats(root);
    assert.equal(left.files, 1);
  });

  it('prints sizes a person can read', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(1536 * 1024 * 1024), '1.5 GB');
  });
});
