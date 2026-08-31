import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const entry = path.join(root, 'packages/browser/src/app.ts');

/**
 * The seam between the two builds is one import away from breaking.
 *
 * A browser cannot resolve `node:zlib`, and when it fails it fails silently:
 * the module graph stops loading and the page renders an empty shell. That is
 * a cheap mistake to make — importing a convenient helper that happens to sit
 * in a file that reads the filesystem — and an expensive one to notice, so it
 * is worth a test that walks the graph.
 */

async function moduleGraph(from: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  async function visit(file: string, chain: readonly string[]): Promise<void> {
    if (found.has(file)) return;

    const source = await readFile(file, 'utf8').catch(() => {
      throw new Error(`Missing module ${path.relative(root, file)}, imported by ${chain.at(-1)}`);
    });

    found.set(file, source);

    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      const here = path.relative(root, file);

      assert.ok(
        !specifier.startsWith('node:'),
        `${here} imports ${specifier}, which a browser cannot resolve.\n` +
          `  reached from: ${[...chain, here].join(' -> ')}`,
      );
      assert.ok(
        specifier.startsWith('.'),
        `${here} imports the package ${specifier}; the browser build has no dependencies.`,
      );

      await visit(path.resolve(path.dirname(file), specifier), [...chain, here]);
    }
  }

  await visit(from, []);
  return found;
}

describe('the browser build', () => {
  it('reaches no Node builtin and no package', async () => {
    const graph = await moduleGraph(entry);
    assert.ok(graph.size > 10, 'expected the graph to include the shared core');
  });

  it('shares the workbook writer with the extension', async () => {
    const graph = await moduleGraph(entry);
    const shared = [...graph.keys()].map((file) => path.relative(root, file));

    for (const module of [
      'packages/core/src/xlsx/workbookParts.ts',
      'packages/core/src/units.ts',
      'packages/core/src/styles.ts',
      'packages/core/src/layout/layoutFile.ts',
    ]) {
      assert.ok(shared.includes(module), `expected the page to use ${module} rather than its own copy`);
    }
  });

  it('bundles into one file with nothing left to fetch', async () => {
    const out = path.join(tmpdir(), `plotexcel-bundle-${process.pid}.html`);

    try {
      await run(process.execPath, [path.join(root, 'tools/bundle-browser.mjs'), out]);
      const html = await readFile(out, 'utf8');

      assert.match(html, /<script type="module">/);
      assert.doesNotMatch(html, /<script[^>]*\ssrc=/, 'a bundled page fetches nothing');
      assert.doesNotMatch(html, /^\s*import\s/m, 'imports should have become registry lookups');
      assert.doesNotMatch(html, /^\s*export\s/m, 'exports should have become registry entries');
      // OOXML namespace URIs look like links but are only identifiers; what
      // would actually cost a network round trip is a src or an href.
      assert.doesNotMatch(html, /\s(?:src|href)="https?:/, 'nothing may be loaded over the network');
      assert.ok(html.length > 40_000, 'the bundle looks too small to contain the core');
    } finally {
      await rm(out, { force: true });
    }
  });
});
