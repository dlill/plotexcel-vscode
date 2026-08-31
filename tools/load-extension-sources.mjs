/**
 * Load every extension source against a stand-in for the VS Code API.
 *
 *     node tools/load-extension-sources.mjs
 *
 * The extension package cannot be typechecked until `@types/vscode` is
 * installed, and it cannot be run at all outside an extension host. This is
 * the check that remains available in between: every file is imported with a
 * stub in place of `vscode`, which catches a syntax error, a bad import path
 * and a typo in a module specifier — the three things most likely to be wrong
 * in code nobody has been able to compile yet.
 *
 * It proves nothing about behaviour. It is a smoke alarm, not a test suite.
 */

import { readdir, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const sources = path.join(root, 'packages', 'extension', 'src');

await ensureStub();

const files = await collect(sources);
let failures = 0;

for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
    console.log(`ok    ${path.relative(root, file)}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${path.relative(root, file)}`);
    console.log(`      ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
  }
}

console.log(`\n${files.length - failures}/${files.length} extension sources load.`);
process.exitCode = failures === 0 ? 0 : 1;

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(full)));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }

  return found;
}

/** A module that answers to any shape of use without doing anything. */
async function ensureStub() {
  const directory = path.join(root, 'node_modules', 'vscode');
  const entry = path.join(directory, 'index.cjs');

  try {
    await access(entry);
    return;
  } catch {
    // Not there yet.
  }

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'vscode', version: '0.0.0-stub', main: 'index.cjs' }, null, 2));
  await writeFile(
    entry,
    [
      '// Written by tools/load-extension-sources.mjs. Not the real API: it',
      '// answers to any property, call and construction with more of itself,',
      '// which is enough for a module to finish loading.',
      'const stub = new Proxy(function () {}, {',
      "  get: (target, key) => (key === 'prototype' ? target.prototype : stub),",
      '  apply: () => stub,',
      '  construct: () => stub,',
      '});',
      'module.exports = new Proxy({}, { get: () => stub });',
      '',
    ].join('\n'),
  );
}
