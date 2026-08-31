import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { countPdfPages } from '../../core/src/documents/pageCount.ts';
import { listZip, readZipEntry } from '../../core/src/zip/zip.ts';
import { createChromiumConverter } from '../src/converters/chromium.ts';
import { createLibreOfficeConverter } from '../src/converters/libreoffice.ts';
import { fitWorkbookToOnePage } from '../src/converters/xlsxPageSetup.ts';
import {
  chromiumLookup,
  findExecutable,
  ghostscriptLookup,
  gitLookup,
  libreOfficeLookup,
  popplerLookup,
} from '../src/detect.ts';
import { combineConverters, inspectMachine, summarise } from '../src/discover.ts';
import { MissingExecutableError, run } from '../src/exec.ts';
import { createGitRevisionReader } from '../src/git.ts';
import { createGhostscriptRenderer } from '../src/renderers/ghostscript.ts';
import { createPopplerRenderer } from '../src/renderers/poppler.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', 'core', 'test', 'fixtures');
const irisPdf = readFileSync(path.join(fixtures, 'docs', '01-Iris.pdf'));
const multiPdf = readFileSync(path.join(fixtures, 'docs', '04-IrisMulti.pdf'));
const wordDocx = readFileSync(path.join(fixtures, 'docs', '21-Word.docx'));

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'plotexcel-tools-'));
}

// Integration: starts LibreOffice and a browser, each of which is heavy enough
// to deserve a process of its own.

describe('converters', { concurrency: false }, () => {
  it('converts a Word document with LibreOffice', async (t) => {
    const libre = await findExecutable('libre-test', libreOfficeLookup());
    if (libre === undefined) return t.skip('LibreOffice is not installed here');

    const pdf = await createLibreOfficeConverter(libre.command).toPdf({ bytes: wordDocx, extension: 'docx' });

    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(countPdfPages(pdf).pages >= 1);
  });

  it('renders an HTML plot with a browser', async (t) => {
    const fromEnvironment = process.env['PLOTEXCEL_BROWSER'];
    const browser =
      fromEnvironment === undefined || fromEnvironment.length === 0
        ? await findExecutable('chromium-test', chromiumLookup())
        : { command: fromEnvironment };
    if (browser === undefined) return t.skip('no Chromium browser is installed here');

    const html = Buffer.from(
      '<html><body style="font-family:sans-serif"><h1>Plot</h1><svg width="200" height="100">' +
        '<rect width="200" height="100" fill="#1f6f52"/></svg></body></html>',
      'utf8',
    );

    const pdf = await createChromiumConverter(browser.command, 2000).toPdf({ bytes: html, extension: 'html' });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  });

  it('routes each format to whichever converter claims it', async () => {
    const office = { name: 'office', canConvert: (e: string) => e === 'docx', toPdf: async () => Buffer.from('office') };
    const browser = { name: 'browser', canConvert: (e: string) => e === 'html', toPdf: async () => Buffer.from('browser') };
    const combined = combineConverters([office, browser]);

    assert.equal((await combined.toPdf({ bytes: Buffer.alloc(0), extension: 'docx' })).toString(), 'office');
    assert.equal((await combined.toPdf({ bytes: Buffer.alloc(0), extension: 'html' })).toString(), 'browser');
    assert.equal(combined.canConvert('pptx'), false);
    await assert.rejects(combined.toPdf({ bytes: Buffer.alloc(0), extension: 'pptx' }), /Nothing on this machine/);
  });
});
