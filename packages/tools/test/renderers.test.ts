import assert from 'node:assert/strict';

import { decodePng } from '../../core/src/image/png.ts';
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

// Integration: needs a PDF rasteriser. Its own file so the process starts clean.

describe('PDF renderers', { concurrency: false }, () => {
  it('renders a page with pdftoppm when poppler is installed', async (t) => {
    const poppler = await findExecutable('poppler-test', popplerLookup());
    if (poppler === undefined) return t.skip('poppler is not installed here');

    const renderer = createPopplerRenderer(poppler.command);
    const image = await renderer.renderPage({ pdf: irisPdf, page: 1, dpi: 100 });

    assert.ok(image.width > 300 && image.width < 2000, `unexpected width ${image.width}`);
    assert.equal(decodePng(image.png).data.length, image.width * image.height * 4);
    assert.equal(image.dpi, 100);
  });

  it('renders the requested page, not always the first', async (t) => {
    const poppler = await findExecutable('poppler-test', popplerLookup());
    if (poppler === undefined) return t.skip('poppler is not installed here');

    const renderer = createPopplerRenderer(poppler.command);
    const first = decodePng((await renderer.renderPage({ pdf: multiPdf, page: 1, dpi: 60 })).png);
    const second = decodePng((await renderer.renderPage({ pdf: multiPdf, page: 2, dpi: 60 })).png);

    assert.notDeepEqual(first.data, second.data, 'two pages of a multi-page PDF should differ');
  });

  it('scales with the requested resolution', async (t) => {
    const poppler = await findExecutable('poppler-test', popplerLookup());
    if (poppler === undefined) return t.skip('poppler is not installed here');

    const renderer = createPopplerRenderer(poppler.command);
    const low = await renderer.renderPage({ pdf: irisPdf, page: 1, dpi: 50 });
    const high = await renderer.renderPage({ pdf: irisPdf, page: 1, dpi: 100 });

    assert.ok(Math.abs(high.width / low.width - 2) < 0.05, `${low.width} -> ${high.width}`);
  });

  it('explains a page that does not exist', async (t) => {
    const poppler = await findExecutable('poppler-test', popplerLookup());
    if (poppler === undefined) return t.skip('poppler is not installed here');

    await assert.rejects(createPopplerRenderer(poppler.command).renderPage({ pdf: irisPdf, page: 9, dpi: 50 }));
  });

  it('renders with Ghostscript when it is installed', async (t) => {
    const ghostscript = await findExecutable('gs-test', ghostscriptLookup());
    if (ghostscript === undefined) return t.skip('Ghostscript is not installed here');

    const image = await createGhostscriptRenderer(ghostscript.command).renderPage({ pdf: irisPdf, page: 1, dpi: 72 });
    assert.ok(image.width > 100);
  });
});
