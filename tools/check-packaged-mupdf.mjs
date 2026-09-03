/**
 * Check the built .vsix can actually rasterise a PDF.
 *
 *     node tools/check-packaged-mupdf.mjs [dist/plotexcel.vsix]
 *
 * This exists because the one thing no test can reach is the bundler. MuPDF is
 * imported through `new Function('s', 'return import(s)')` for the sole reason
 * that esbuild rewrites any dynamic `import()` it can see into a `require()`,
 * and `require()` of an ESM package that resolves its own `.wasm` fails at run
 * time — after installation, on a user's machine, as "no PDF renderer". A
 * green test suite says nothing about it, because the suite never builds.
 *
 * So: open the archive, confirm the bundler left the indirection alone, and
 * render a page with the files that are actually in there.
 *
 * Reads the archive with the repository's own ZIP reader rather than `unzip`,
 * for the same reason everything else here is hand-written.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tempScratchRoot } from '../packages/core/src/cache/keys.ts';
import { listZip, readZipEntry } from '../packages/core/src/zip/zip.ts';
import { sampleProject } from '../packages/core/src/samples/sampleProject.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.resolve(root, process.argv[2] ?? path.join('dist', 'plotexcel.vsix'));

const bytes = await readFile(archive);
const entries = listZip(bytes);

console.log(`${path.relative(root, archive)}  ${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${entries.length} entries`);

let failures = 0;

function check(condition, ok, bad) {
  if (condition) {
    console.log(`ok    ${ok}`);
    return true;
  }
  failures += 1;
  console.log(`FAIL  ${bad}`);
  return false;
}

// ------------------------------------------------------------------ the bundle

const bundlePath = 'extension/dist/extension.js';
const hasBundle = check(
  entries.some((entry) => entry.name === bundlePath),
  'the bundle is in the archive',
  `${bundlePath} is missing`,
);

if (hasBundle) {
  const bundle = readZipEntry(bytes, bundlePath).toString('utf8');

  // The indirection must survive minification. esbuild keeps the string as a
  // string, so the words are still there even with every name mangled.
  check(
    bundle.includes('return import('),
    'the dynamic import survived bundling',
    'the bundle has no `return import(` — esbuild rewrote the MuPDF import, ' +
      'which fails at run time as "no PDF renderer"',
  );

  check(
    !/require\(\s*["']mupdf["']\s*\)/.test(bundle),
    'the bundle does not require("mupdf")',
    'the bundle contains require("mupdf"), which cannot load an ESM package',
  );
}

// -------------------------------------------------------------------- the wasm

const shipped = ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm', 'package.json'];
const present = shipped.filter((name) => entries.some((entry) => entry.name === `extension/dist/mupdf/${name}`));

const complete = check(
  present.length === shipped.length,
  `all ${shipped.length} MuPDF files are in the archive`,
  `MuPDF is incomplete: missing ${shipped.filter((name) => !present.includes(name)).join(', ')}`,
);

// ------------------------------------------------------------------ the render

if (complete) {
  // Under the one temp root, so that a run interrupted before the tidy-up below
  // leaves its staging directory somewhere Clear Cache can find it.
  await mkdir(tempScratchRoot(), { recursive: true });

  const staging = await mkdtemp(path.join(tempScratchRoot(), 'vsix-'));
  const where = path.join(staging, 'mupdf');
  await mkdir(where, { recursive: true });

  for (const name of shipped) {
    await writeFile(path.join(where, name), readZipEntry(bytes, `extension/dist/mupdf/${name}`));
  }

  // The same indirection the extension uses, for the same reason.
  const importModule = new Function('specifier', 'return import(specifier);');
  const mupdf = await importModule(pathToFileURL(path.join(where, 'mupdf.js')).href);

  const pdf = sampleProject().files.find((file) => file.path.endsWith('.pdf'));
  const document = mupdf.Document.openDocument(pdf.bytes, 'application/pdf');
  const zoom = 150 / 72;
  const pixmap = document
    .loadPage(0)
    .toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = Buffer.from(pixmap.asPNG());

  check(
    png.length > 1000 && png.subarray(1, 4).toString() === 'PNG',
    `rendered a page from the packaged MuPDF, ${png.length} bytes of PNG`,
    `the packaged MuPDF produced ${png.length} bytes, which is not a PNG`,
  );

  // The wasm module has the files open, so a failure to remove them is not a
  // reason to fail the check.
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failures === 0 ? '\nThe package can render a PDF.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
