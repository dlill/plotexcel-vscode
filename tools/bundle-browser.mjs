/**
 * Bundle the browser build into one double-clickable HTML file.
 *
 *     node tools/bundle-browser.mjs [outfile]
 *
 * There is no bundler here and no build tooling to install. Node strips the
 * TypeScript types, and the module graph is small, regular and acyclic, so
 * inlining it is a matter of ordering the files and giving each one its own
 * scope. Every module becomes an entry in a registry object; imports become a
 * destructure from that registry.
 *
 * The output is a single file with no network dependencies at all, which is
 * the point: it works from `file://`, off a USB stick, out of an email
 * attachment, on a machine where nothing may be installed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const entry = path.join(root, 'packages/browser/src/app.ts');
const html = path.join(root, 'packages/browser/index.html');
const out = path.resolve(process.argv[2] ?? path.join(root, 'dist/plotexcel.html'));

/** Every relative import in a file, as absolute paths, in source order. */
function importsOf(source) {
  return [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1]);
}

const modules = new Map();
const order = [];
const visiting = new Set();

async function collect(file) {
  if (modules.has(file)) return;
  if (visiting.has(file)) throw new Error(`Import cycle at ${path.relative(root, file)}`);
  visiting.add(file);

  const source = await readFile(file, 'utf8');
  for (const specifier of importsOf(source)) {
    await collect(path.resolve(path.dirname(file), specifier));
  }

  visiting.delete(file);
  modules.set(file, source);
  order.push(file);
}

await collect(entry);

const id = (file) => path.relative(root, file).replaceAll('\\', '/');

/** Turn one module's source into a registry entry. */
function wrap(file, source) {
  // Types first: `import type` lines and inline `type` specifiers disappear,
  // leaving only imports that carry real values.
  const stripped = stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false });

  const bindings = [];
  const body = stripped
    .replace(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"];?/gs, (_all, names, specifier) => {
      const target = id(path.resolve(path.dirname(file), specifier));
      const fields = names
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => {
          const parts = name.split(/\s+as\s+/);
          return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : name;
        });

      if (fields.length > 0) bindings.push(`const { ${fields.join(', ')} } = __m[${JSON.stringify(target)}];`);
      return '';
    })
    .replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');

  const exported = [
    ...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm),
  ].map((match) => match[1]);

  return [
    `__m[${JSON.stringify(id(file))}] = (() => {`,
    ...bindings,
    body.trim(),
    `return { ${exported.join(', ')} };`,
    '})();',
  ].join('\n');
}

const registry = [
  '// plotExcel — one file, no network, nothing installed.',
  'const __m = Object.create(null);',
  ...order.map((file) => wrap(file, modules.get(file))),
].join('\n\n');

const page = await readFile(html, 'utf8');
const inlined = page.replace(
  /<script type="module" src="[^"]*"><\/script>/,
  `<script type="module">\n${registry}\n</script>`,
);

if (inlined === page) throw new Error('Could not find the module script tag in index.html');

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, inlined, 'utf8');

const kb = Math.round(Buffer.byteLength(inlined) / 1024);
console.log(`${path.relative(process.cwd(), out)} — ${order.length} modules, ${kb} KB, no dependencies.`);
