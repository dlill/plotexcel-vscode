/**
 * Everything that can be checked without an extension host.
 *
 *     npm run verify
 *
 * One command, because "did I break anything" should not require remembering
 * five. Runs in order of how fast a failure comes back, so a typo is reported
 * in three seconds rather than after the slow end-to-end render.
 *
 * Add `--quick` to stop before the slow ones.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');

const steps = [
  {
    name: 'tests',
    detail: 'every package',
    command: [
      process.execPath,
      [
        '--test',
        'packages/core/test/*.test.ts',
        'packages/tools/test/*.test.ts',
        'packages/browser/test/*.test.ts',
        'packages/extension/test/*.test.ts',
        'packages/cli/test/*.test.ts',
      ],
    ],
  },
  {
    name: 'extension',
    detail: 'sources load, manifest agrees with the code',
    command: [process.execPath, ['tools/load-extension-sources.mjs']],
  },
  {
    name: 'browser bundle',
    detail: 'one file, nothing to fetch',
    command: [process.execPath, ['tools/bundle-browser.mjs', 'dist/plotexcel.html']],
    slow: true,
  },
  {
    name: 'typecheck',
    detail: 'four projects; needs npm install',
    command: ['npx', ['--no-install', 'tsc', '-p', 'packages/core']],
    // Skipped rather than failed when the devtools are not installed: the
    // tests themselves need nothing, so a fresh clone can check most of this
    // before npm install has ever run.
    needs: ['node_modules/typescript', 'node_modules/@types/node'],
    slow: true,
    then: [
      ['npx', ['--no-install', 'tsc', '-p', 'packages/tools']],
      ['npx', ['--no-install', 'tsc', '-p', 'packages/cli']],
      ['npx', ['--no-install', 'tsc', '-p', 'packages/extension']],
    ],
  },
];

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });

    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', () => resolve({ code: 127, output }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const width = Math.max(...steps.map((step) => step.name.length));
let failed = 0;
let skipped = 0;

for (const step of steps) {
  if (quick && step.slow === true) {
    process.stdout.write(`${step.name.padEnd(width)}  skipped (--quick)\n`);
    continue;
  }

  const missing = (step.needs ?? []).filter((where) => !existsSync(path.join(root, where)));
  if (missing.length > 0) {
    process.stdout.write(`${step.name.padEnd(width)}  skipped       needs npm install (${missing[0]})\n`);
    skipped += 1;
    continue;
  }

  const started = Date.now();
  let result = await run(...step.command);

  for (const next of result.code === 0 ? (step.then ?? []) : []) {
    result = await run(...next);
    if (result.code !== 0) break;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.code === 0) {
    process.stdout.write(`${step.name.padEnd(width)}  ok      ${seconds}s  ${step.detail}\n`);
    continue;
  }

  failed += 1;
  process.stdout.write(`${step.name.padEnd(width)}  FAILED  ${seconds}s\n\n${result.output}\n`);
}

process.stdout.write(
  failed === 0
    ? `\nAll good${skipped > 0 ? `, ${skipped} skipped` : ''}. Not covered: the extension in a real host, and the two workflows.\n`
    : `\n${failed} failed.\n`,
);

process.exit(failed === 0 ? 0 : 1);
