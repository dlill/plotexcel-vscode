/**
 * Serve the browser build straight from source, with no bundler.
 *
 *     node tools/serve-browser.mjs [port]
 *
 * Node 22 can strip TypeScript types itself, so a `.ts` file can be handed to
 * a browser as JavaScript on the way out. That is enough to run the real core
 * modules in a page — no build step, no packages, and nothing between the code
 * being read and the code being run.
 *
 * For distribution the same sources get bundled into one HTML file. This is
 * for developing and for proving the thing works.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const port = Number(process.argv[2] ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);

  // A redirect rather than serving the page at `/`, so that the relative
  // `./src/app.ts` in the HTML resolves against the folder it actually lives
  // in. Serving it at the root silently breaks every relative import.
  if (url.pathname === '/') {
    response.writeHead(302, { location: '/packages/browser/index.html' }).end();
    return;
  }

  const file = path.join(root, url.pathname);

  // Nothing outside the repository is servable, whatever the path says.
  if (!file.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const extension = path.extname(file);
    const bytes = await readFile(file);

    const body =
      extension === '.ts'
        ? stripTypeScriptTypes(bytes.toString('utf8'), { mode: 'transform', sourceMap: false })
        : bytes;

    response.writeHead(200, {
      'content-type': TYPES[extension] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    response.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : String(error));
  }
});

server.listen(port, () => {
  console.log(`plotExcel browser build: http://localhost:${port}/`);
  console.log('Serving TypeScript as JavaScript, stripped on the way out.');
});
