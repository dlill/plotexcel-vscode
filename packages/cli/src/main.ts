#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  generateComparison,
  generateFolderComparison,
  generateFromFolder,
  type PageCounter,
} from '../../core/src/build/generateLayout.ts';
import { countSourcePages } from '../../core/src/pipeline/sourcePages.ts';
import { NoPdfExporterError, pdfPathFor, workbookToPdf } from '../../core/src/build/exportPdf.ts';
import {
  renderLayout,
  timestampedWorkbookPath,
  type RenderLayoutResult,
} from '../../core/src/build/renderLayout.ts';
import { defaultCacheRoot } from '../../core/src/cache/keys.ts';
import { formatLayout, parseLayout, LAYOUT_FILE_SUFFIX, type LayoutFile } from '../../core/src/layout/layoutFile.ts';
import { cacheStats, clearCache, formatBytes } from '../../core/src/pipeline/cache.ts';
import { inspectMachine, suggestedConcurrency, summarise } from '../../tools/src/discover.ts';

/**
 * plotExcel from the command line.
 *
 * The extension is the product, but everything it does happens in the core and
 * the adapters — so the same work is available without VS Code. That is useful
 * three ways: it is how the pipeline gets exercised on a machine with no
 * editor, it lets a workbook be rebuilt from a script or a CI job, and it is
 * far easier to debug than an extension host.
 */

const USAGE = `plotExcel — arrange plots into an Excel workbook

  plotexcel render <layout.plotexcel.tsv> [options]
      Render a layout into a workbook.

  plotexcel generate <folder> [options]
      Scan a folder and write a layout for everything in it.

  plotexcel compare <first> [second] [options]
      Compare two plot files, or one file against a revision (--commit).

  plotexcel compare-folders <left> <right> [options]
      Compare two folders, pairing files by their path inside each.

  plotexcel check
      Report what this machine can render, convert and read.

  plotexcel cache [--clear]
      Show the size of the pipeline cache, or empty it.

Options
  -o, --out <path>       Where to write the layout or workbook
  -r, --resolution <dpi> Rasterisation resolution (default 150)
  -m, --max-pages <n>    Pages to take from any one file (default 4)
  -c, --commit <rev>     Revision to compare against
      --render           Render the layout as soon as it is generated
      --force            Ignore cached intermediates
      --concurrency <n>  How many plots to render at once
      --quiet            Only print the result
`;

async function main(argv: readonly string[]): Promise<number> {
  // A leading flag is not a command. Without this, `plotexcel --help` — the
  // first thing anyone types — is reported as an unknown command, because the
  // flag has been eaten as the command name before parseArgs ever sees it.
  const [first, ...rest] = argv;
  const command = first !== undefined && !first.startsWith('-') ? first : undefined;

  const { values, positionals } = parseArgs({
    args: command === undefined ? [...argv] : [...rest],
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      resolution: { type: 'string', short: 'r' },
      'max-pages': { type: 'string', short: 'm' },
      commit: { type: 'string', short: 'c' },
      render: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      clear: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (command === undefined || values.help === true || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const quiet = values.quiet === true;
  const say = (line = '') => {
    if (!quiet) process.stdout.write(`${line}\n`);
  };

  switch (command) {
    case 'render': {
      const layoutPath = requirePositional(positionals, 0, 'a layout file');
      const layout = await readLayout(layoutPath, say);
      const result = await render(layout, layoutPath, values, say);
      say();
      say(summariseRender(result));
      return result.issues.length > 0 ? 1 : 0;
    }

    case 'generate': {
      const folder = requirePositional(positionals, 0, 'a folder to scan');
      const out = path.resolve(values.out ?? path.join(process.cwd(), `${path.basename(path.resolve(folder))}${LAYOUT_FILE_SUFFIX}`));

      const generated = await generateFromFolder({
        folder,
        layoutDir: path.dirname(out),
        pageCounter: await pageCounter(path.dirname(out)),
        ...(values.resolution === undefined ? {} : { resolution: Number(values.resolution) }),
        ...(values['max-pages'] === undefined ? {} : { nPagesMax: Number(values['max-pages']) }),
        ...(values.commit === undefined ? {} : { compareToCommit: values.commit }),
      });

      if (generated.layout.rows.length === 0) {
        process.stderr.write(
          `No plots found in ${path.resolve(folder)}. plotExcel reads pdf, png, docx, pptx, xlsx, html and htm files.\n`,
        );
        return 1;
      }

      await writeLayout(out, generated.layout);
      say(`${generated.files.length} files, ${generated.layout.rows.length} rows -> ${out}`);
      reportUncertainty(generated.uncertain, say);

      if (values.render === true) {
        const result = await render(generated.layout, out, values, say);
        say();
        say(summariseRender(result));
      }
      return 0;
    }

    case 'compare': {
      const first = requirePositional(positionals, 0, 'a plot file');
      const second = positionals[1];
      const out = path.resolve(values.out ?? path.join(process.cwd(), `comparison${LAYOUT_FILE_SUFFIX}`));

      const generated = await generateComparison({
        first,
        ...(second === undefined ? {} : { second }),
        ...(values.commit === undefined ? {} : { commit: values.commit }),
        layoutDir: path.dirname(out),
        ...(values.resolution === undefined ? {} : { resolution: Number(values.resolution) }),
        pageCounter: await pageCounter(path.dirname(out)),
      });

      await writeLayout(out, generated.layout);
      say(`${generated.layout.rows.length} rows -> ${out}`);

      if (values.render === true) {
        const result = await render(generated.layout, out, values, say);
        say();
        say(summariseRender(result));
      }
      return 0;
    }

    case 'compare-folders': {
      const left = requirePositional(positionals, 0, 'the first folder');
      const right = requirePositional(positionals, 1, 'the second folder');
      const out = path.resolve(values.out ?? path.join(process.cwd(), `folders${LAYOUT_FILE_SUFFIX}`));

      const generated = await generateFolderComparison({
        left,
        right,
        layoutDir: path.dirname(out),
        pageCounter: await pageCounter(path.dirname(out)),
        ...(values.resolution === undefined ? {} : { resolution: Number(values.resolution) }),
        ...(values['max-pages'] === undefined ? {} : { nPagesMax: Number(values['max-pages']) }),
      });

      await writeLayout(out, generated.layout);
      say(`${generated.files.length} files, ${generated.layout.rows.length} rows -> ${out}`);

      if (values.render === true) {
        const result = await render(generated.layout, out, values, say);
        say();
        say(summariseRender(result));
      }
      return 0;
    }

    case 'check': {
      const { report } = await inspectMachine();
      process.stdout.write(`${summarise(report)}\n`);
      return report.some((entry) => entry.capability === 'plots' && entry.status === 'missing') ? 1 : 0;
    }

    case 'cache': {
      const root = defaultCacheRoot();
      if (values.clear === true || positionals[0] === 'clear') {
        const { files, bytes } = await clearCache(root);
        process.stdout.write(`cleared ${files} files, ${formatBytes(bytes)} from ${root}\n`);
        return 0;
      }

      const stats = await cacheStats(root);
      process.stdout.write(`${stats.files} files, ${formatBytes(stats.bytes)} in ${root}\n`);
      return 0;
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

// ------------------------------------------------------------------------- //

type Values = Record<string, string | boolean | undefined>;

/**
 * A page counter backed by this machine's converters.
 *
 * Counting an HTML or Word plot means converting it, which the pipeline caches
 * at a path that does not depend on page or resolution — so the conversion
 * paid for here is the one the render would have paid for anyway.
 */
async function pageCounter(layoutDir: string): Promise<PageCounter> {
  const { tools } = await inspectMachine();
  return (absolutePath) => countSourcePages(absolutePath, { tools, baseDir: layoutDir });
}

async function render(
  layout: LayoutFile,
  layoutPath: string,
  values: Values,
  say: (line?: string) => void,
): Promise<RenderLayoutResult> {
  const { tools, report } = await inspectMachine();

  for (const entry of report) {
    if (entry.status === 'missing') say(`note: ${entry.title} unavailable — ${entry.advice}`);
  }

  const result = await renderLayout(layout, {
    layoutPath,
    tools,
    concurrency: values.concurrency === undefined ? suggestedConcurrency() : Number(values.concurrency),
    force: values.force === true,
    ...(typeof values.out === 'string' && values.out.endsWith('.xlsx') ? { outputPath: values.out } : {}),
    onProgress: (event) => {
      const cached = event.fromCache === true ? ' (cached)' : '';
      say(`  [${event.completed}/${event.total}] ${event.label}${cached} ${event.elapsedMs}ms`);
    },
  });

  // Only a name plotExcel chose itself gets a timestamp on Windows; --out and
  // the layout's own #output are answers to "call it this", not suggestions.
  const named = (typeof values.out === 'string' && values.out.endsWith('.xlsx')) || layout.options.output !== undefined;
  const outputPath = named ? result.outputPath : timestampedWorkbookPath(result.outputPath);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.workbook);

  if (layout.options.pdf === true) {
    try {
      const pdf = await workbookToPdf(result.workbook, tools, layout.options.pdfPageSize ?? 'single');
      const target = pdfPathFor(outputPath);
      await writeFile(target, pdf);
      say(`  also wrote ${target}`);
    } catch (error) {
      say(error instanceof NoPdfExporterError ? `note: ${error.message}` : `note: PDF export failed: ${String(error)}`);
    }
  }

  return { ...result, outputPath };
}

function summariseRender(result: RenderLayoutResult): string {
  const lines = [
    `${result.outputPath}`,
    `${result.images} plots, ${result.diffs} diffs, ${result.textCells} text cells, ` +
      `${result.cacheHits} from cache, ${(result.elapsedMs / 1000).toFixed(1)}s`,
  ];

  if (result.issues.length > 0) {
    lines.push('', `${result.issues.length} cell${result.issues.length === 1 ? '' : 's'} could not be rendered:`);
    for (const issue of result.issues) {
      lines.push(`  row ${issue.row}, ${issue.columnName || `column ${issue.column}`}: ${issue.issue.headline}`);
      for (const detail of issue.issue.details) lines.push(`      ${detail}`);
    }
  }

  return lines.join('\n');
}

async function readLayout(layoutPath: string, say: (line?: string) => void): Promise<LayoutFile> {
  const text = await readFile(layoutPath, 'utf8');
  const { layout, diagnostics } = parseLayout(text);

  for (const diagnostic of diagnostics) {
    const where = `${path.basename(layoutPath)}:${diagnostic.line}`;
    say(`${diagnostic.severity}: ${where} ${diagnostic.message}`);
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new Error('This layout has errors. Fix them and try again.');
  }

  return layout;
}

async function writeLayout(out: string, layout: LayoutFile): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, formatLayout(layout), 'utf8');
}

function reportUncertainty(uncertain: readonly { relativePath: string; reason?: string | undefined }[], say: (line?: string) => void): void {
  if (uncertain.length === 0) return;

  say();
  say(`${uncertain.length} file${uncertain.length === 1 ? "'s" : "s'"} page count had to be estimated:`);
  for (const file of uncertain) say(`  ${file.relativePath}: ${file.reason ?? 'reason unknown'}`);
}

function requirePositional(positionals: readonly string[], index: number, what: string): string {
  const value = positionals[index];
  if (value === undefined) throw new Error(`This command needs ${what}.`);
  return value;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
