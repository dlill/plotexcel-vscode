import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { listZip } from '../../core/src/zip/zip.ts';
import { parseLayout } from '../../core/src/layout/layoutFile.ts';
import { sampleProject } from '../../core/src/samples/sampleProject.ts';

/**
 * The command line, run as a command line.
 *
 * Every one of these starts a real process and reads what it printed, because
 * the bugs this catches are not in the functions underneath — they are in the
 * argument parsing, the exit codes and the messages. `cache --clear` once
 * rejected its own flag; nothing but running it would have found that.
 *
 * It is deliberately slow-ish and deliberately shallow: the rendering itself
 * is covered thoroughly elsewhere.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '../src/main.ts');
const run = promisify(execFile);

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function plotexcel(args: readonly string[], cwd?: string): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, PLOTEXCEL_CACHE: undefined },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('the command line', () => {
  let folder: string;

  before(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'plotexcel-cli-'));

    const project = sampleProject();
    for (const file of project.files) {
      const target = path.join(folder, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }
    await writeFile(path.join(folder, project.layoutName), project.layoutText, 'utf8');
  });

  after(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  describe('when it cannot do what was asked', () => {
    it('prints the usage and fails on an unknown command', async () => {
      const result = await plotexcel(['frobnicate']);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unknown command/);
      assert.match(result.stderr, /plotexcel render/, 'the usage should come with the complaint');
    });

    it('prints the usage for --help, and succeeds', async () => {
      const result = await plotexcel(['--help']);

      assert.equal(result.code, 0, 'asking for help is not an error');
      assert.match(result.stdout, /plotexcel render/);
    });

    it('says which file it could not find', async () => {
      const result = await plotexcel(['render', 'nowhere.plotexcel.tsv'], folder);

      assert.notEqual(result.code, 0);
      assert.match(`${result.stderr}${result.stdout}`, /nowhere\.plotexcel\.tsv/);
    });

    it('refuses to generate from a folder with no plots in it', async () => {
      const empty = path.join(folder, 'empty');
      await mkdir(empty, { recursive: true });

      const result = await plotexcel(['generate', empty], folder);

      assert.notEqual(result.code, 0, 'silently writing an empty layout is worse than failing');
      assert.match(result.stderr, /no plots|No plots/);
    });
  });

  describe('cache', () => {
    it('reports what it holds', async () => {
      const result = await plotexcel(['cache']);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /files/);
    });

    it('accepts --clear, which it once did not', async () => {
      const result = await plotexcel(['cache', '--clear']);

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /cleared/i);
    });

    it('accepts clear as a word too', async () => {
      const result = await plotexcel(['cache', 'clear']);
      assert.equal(result.code, 0, result.stderr);
    });
  });

  describe('check', () => {
    it('describes the machine in words', async () => {
      const result = await plotexcel(['check']);

      // The exit code says whether plots can be rendered at all, so it is not
      // asserted here — a machine with no renderer is a legitimate answer.
      assert.match(result.stdout, /PDF|plots|git/i);
    });
  });

  describe('generate', () => {
    it('writes a layout for a folder', async () => {
      const out = path.join(folder, 'generated.plotexcel.tsv');
      const result = await plotexcel(['generate', path.join(folder, 'figures'), '-o', out], folder);

      assert.equal(result.code, 0, result.stderr);

      const { layout, diagnostics } = parseLayout(await readFile(out, 'utf8'));
      assert.deepEqual(diagnostics, []);
      assert.ok(layout.rows.length >= 4, 'four files, several pages');
    });

    it('honours --resolution and --max-pages', async () => {
      const out = path.join(folder, 'coarse.plotexcel.tsv');
      const result = await plotexcel(
        ['generate', path.join(folder, 'figures'), '-o', out, '-r', '72', '-m', '1'],
        folder,
      );

      assert.equal(result.code, 0, result.stderr);

      const text = await readFile(out, 'utf8');
      assert.match(text, /#resolution: 72/);
      assert.doesNotMatch(text, /::page 2/, 'one page per file was asked for');
    });
  });

  describe('render', () => {
    it('produces a workbook, and says what it did', async () => {
      const project = sampleProject();
      const out = path.join(folder, 'out.xlsx');

      const result = await plotexcel(['render', project.layoutName, '-o', out], folder);

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /text cells/);

      const workbook = await readFile(out);
      const names = listZip(workbook).map((entry) => entry.name);

      assert.ok(names.includes('xl/worksheets/sheet1.xml'));
      assert.ok(names.some((name) => name.startsWith('xl/media/')), 'a workbook with no images means nothing rendered');
    });

    it('says less when asked to be quiet', async () => {
      const project = sampleProject();
      const out = path.join(folder, 'quiet.xlsx');

      const loud = await plotexcel(['render', project.layoutName, '-o', out], folder);
      const quiet = await plotexcel(['render', project.layoutName, '-o', out, '--quiet'], folder);

      assert.equal(quiet.code, 0, quiet.stderr);
      assert.ok(quiet.stdout.length < loud.stdout.length, '--quiet should print less, not the same');
    });
  });
});
