/**
 * Copy the MuPDF build in beside the extension bundle.
 *
 *     node tools/copy-mupdf.mjs
 *
 * MuPDF is the one thing the extension ships that it did not write, and it
 * cannot go through esbuild: the package is ESM-only and its glue locates
 * `mupdf-wasm.wasm` with `import.meta.url`, so flattening it into the
 * CommonJS bundle breaks both. It travels as three files in `dist/mupdf/`
 * instead, and `machine.ts` tells the renderer where they are.
 *
 * Only these, plus MuPDF's own licence text, which AGPL requires travel with
 * the binary. The `.br` copies are for a web server that can serve
 * pre-compressed responses, and the `.d.ts` files are types — a `.vsix` is a
 * zip, so the plain `.wasm` compresses on the way in regardless.
 *
 * Loud on failure on purpose. A silent skip here produces a `.vsix` that
 * installs, activates, and then cannot render a single PDF.
 */

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'node_modules', 'mupdf', 'dist');
const to = path.join(root, 'packages', 'extension', 'dist', 'mupdf');

const files = ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm', '../LICENSE'];

try {
  await stat(from);
} catch {
  console.error(`mupdf is not installed: ${path.relative(root, from)} does not exist.`);
  console.error('Run npm install first — the extension cannot render PDFs without it.');
  process.exit(1);
}

await mkdir(to, { recursive: true });

let total = 0;

for (const file of files) {
  const source = path.join(from, file);
  const name = path.basename(file);

  try {
    const { size } = await stat(source);
    await copyFile(source, path.join(to, name));
    total += size;
    console.log(`copied  ${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  } catch (error) {
    console.error(`Could not copy ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Without this, the nearest package.json above mupdf.js is the extension
// manifest, which has no "type" — so Node parses the file as CommonJS, fails,
// warns about it and reparses as ESM. It works, and it puts
// MODULE_TYPELESS_PACKAGE_JSON in the extension host log on every render.
await writeFile(path.join(to, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

console.log(`\nMuPDF in place, ${(total / 1024 / 1024).toFixed(1)} MB before the zip.`);
