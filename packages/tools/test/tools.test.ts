import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listZip, readZipEntry } from '../../core/src/zip/zip.ts';
import { fitWorkbookToOnePage } from '../src/converters/xlsxPageSetup.ts';
import { findExecutable, gitLookup } from '../src/detect.ts';
import { inspectMachine, summarise } from '../src/discover.ts';
import { MissingExecutableError, run } from '../src/exec.ts';
import { createGitRevisionReader } from '../src/git.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', 'core', 'test', 'fixtures');

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'plotexcel-tools-'));
}

// Fast checks: no heavy external programs are started here.

describe('run', () => {
  it('passes arguments without a shell, so spaces and quotes are safe', async () => {
    const result = await run('node', ['-e', 'console.log(process.argv[1])', 'a b & c "d"']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString().trim(), 'a b & c "d"');
  });

  it('reports a non-zero exit rather than throwing', async () => {
    const result = await run('node', ['-e', 'process.exit(3)']);
    assert.equal(result.code, 3);
  });

  it('says clearly when the program is not installed', async () => {
    await assert.rejects(run('definitely-not-a-real-program-xyz', []), MissingExecutableError);
  });

  it('stops a program that will not finish', async () => {
    await assert.rejects(
      run('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 }),
      /did not finish within 300ms/,
    );
  });
});

describe('detection', () => {
  it('finds git, which is on every developer machine', async () => {
    const git = await findExecutable('git-test', gitLookup());
    assert.ok(git, 'git should be found');
    assert.match(git.version ?? '', /git version/);
  });

  it('returns undefined rather than throwing for a tool that is absent', async () => {
    const missing = await findExecutable('nope-test', { names: ['definitely-not-installed-xyz'] });
    assert.equal(missing, undefined);
  });
});

describe('git revisions', () => {
  it('reads a file as it was in an earlier commit', async () => {
    const repository = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });

    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    const plot = path.join(repository, 'figs', 'plot.png');
    execFileSync('mkdir', ['-p', path.dirname(plot)]);
    writeFileSync(plot, 'first version');
    git('add', '.');
    git('commit', '-q', '-m', 'first plot');

    writeFileSync(plot, 'second version');
    git('add', '.');
    git('commit', '-q', '-m', 'update plot');

    const reader = createGitRevisionReader();

    assert.equal((await reader.read({ path: plot, revision: 'HEAD' }))?.toString(), 'second version');
    assert.equal((await reader.read({ path: plot, revision: 'HEAD~1' }))?.toString(), 'first version');
    assert.equal(await reader.isTracked(plot), true);
  });

  it('returns undefined for a file that did not exist yet', async () => {
    const repository = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });

    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(repository, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'first');

    const later = path.join(repository, 'later.png');
    writeFileSync(later, 'new file');
    git('add', '.');
    git('commit', '-q', '-m', 'second');

    const reader = createGitRevisionReader();
    assert.equal(await reader.read({ path: later, revision: 'HEAD~1' }), undefined);
  });

  it('lists revisions for the quick pick, newest first', async () => {
    const repository = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });

    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    const plot = path.join(repository, 'plot.pdf');
    for (const message of ['add plot', 'tweak axis labels', 'recolour points']) {
      writeFileSync(plot, message);
      git('add', '.');
      git('commit', '-q', '-m', message);
    }

    const revisions = await createGitRevisionReader().listRevisions(plot);
    assert.equal(revisions.length, 3);
    assert.equal(revisions[0]?.subject, 'recolour points');
    assert.match(revisions[0]?.shortHash ?? '', /^[0-9a-f]{7,}$/);
    assert.match(revisions[0]?.date ?? '', /^\d{4}-\d{2}-\d{2}$/);
  });

  it('says a file outside a repository is not tracked', async () => {
    const outside = path.join(scratch(), 'loose.png');
    writeFileSync(outside, 'x');
    assert.equal(await createGitRevisionReader().isTracked(outside), false);
  });

  it('lists what a folder held at a revision, relative to that folder', async () => {
    const repository = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });

    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    const figures = path.join(repository, 'figs');
    execFileSync('mkdir', ['-p', path.join(figures, 'supplementary')]);
    writeFileSync(path.join(figures, 'one.png'), 'one');
    writeFileSync(path.join(figures, 'supplementary', 'two.png'), 'two');
    writeFileSync(path.join(repository, 'outside.png'), 'not in figs');
    git('add', '.');
    git('commit', '-q', '-m', 'first');

    writeFileSync(path.join(figures, 'three.png'), 'added later');
    git('add', '.');
    git('commit', '-q', '-m', 'second');

    const reader = createGitRevisionReader();

    // Paths come back relative to the folder asked about, and a file that sits
    // beside it rather than inside it is not part of the answer.
    assert.deepEqual((await reader.listFiles(figures, 'HEAD~1'))?.sort(), ['one.png', 'supplementary/two.png']);
    assert.deepEqual((await reader.listFiles(figures, 'HEAD'))?.sort(), [
      'one.png',
      'supplementary/two.png',
      'three.png',
    ]);
  });

  it('answers undefined for a folder with no repository, rather than an empty list', async () => {
    // The two mean different things: nothing there yet, versus no history at
    // all. A caller that confused them would show every plot as newly added.
    const loose = scratch();
    writeFileSync(path.join(loose, 'plot.png'), 'x');

    assert.equal(await createGitRevisionReader().listFiles(loose, 'HEAD'), undefined);
  });
});

describe('fitWorkbookToOnePage', () => {
  it('hands back anything that is not a workbook, byte for byte', () => {
    const original = readFileSync(path.join(fixtures, 'docs', '21-Word.docx'));
    const result = fitWorkbookToOnePage(original);
    assert.ok(result.equals(original), 'a document with no worksheets must not be rewritten');
    assert.ok(fitWorkbookToOnePage(Buffer.from('not a zip')).equals(Buffer.from('not a zip')));
  });

  it('rewrites the page setup of a real workbook', async () => {
    const { writeWorkbook } = await import('../../core/src/xlsx/writeWorkbook.ts');
    const workbook = writeWorkbook({
      cells: [{ row: 1, column: 1, text: 'wide' }],
      images: [],
      columnWidthsCm: new Map([[1, 40]]),
      rowHeightsCm: new Map([[1, 2]]),
      fitToPage: false,
    });

    const patched = fitWorkbookToOnePage(workbook);
    const sheet = readZipEntry(patched, 'xl/worksheets/sheet1.xml')!.toString('utf8');

    assert.match(sheet, /<pageSetUpPr fitToPage="1"\/>/);
    assert.match(sheet, /fitToWidth="1" fitToHeight="1"/);
    assert.equal(listZip(patched).length, listZip(workbook).length, 'no parts lost');
    assert.ok(!patched.equals(workbook), 'a workbook that needed the change is rewritten');
  });
});

describe('inspectMachine', () => {
  it('reports every capability, ready or not', async () => {
    const { report } = await inspectMachine();

    assert.deepEqual(
      report.map((entry) => entry.capability),
      ['plots', 'office', 'html', 'git'],
    );

    for (const entry of report) {
      if (entry.status === 'ready') assert.ok(entry.provider, `${entry.capability} should name its provider`);
      else assert.ok(entry.advice, `${entry.capability} should say what to install`);
    }
  });

  it('can be turned off for Office, for a machine where it hangs', async () => {
    const { report } = await inspectMachine({ officeConverter: 'off' });
    assert.equal(report.find((entry) => entry.capability === 'office')?.status, 'missing');
  });

  it('summarises into something a person can read', async () => {
    const { report } = await inspectMachine();
    const text = summarise(report);

    assert.match(text, /PDF and image plots/);
    assert.equal(text.split('\n').length, 4);
  });
});
