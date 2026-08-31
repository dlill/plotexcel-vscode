import os from 'node:os';

import type { DocumentConverter, PdfRenderer, RevisionReader, Tools } from '../../core/src/pipeline/ports.ts';
import { createChromiumConverter } from './converters/chromium.ts';
import { createLibreOfficeConverter } from './converters/libreoffice.ts';
import { createMicrosoftOfficeConverter } from './converters/msoffice.ts';
import {
  chromiumLookup,
  findExecutable,
  findMicrosoftOffice,
  ghostscriptLookup,
  gitLookup,
  libreOfficeLookup,
  popplerLookup,
  powerShellLookup,
} from './detect.ts';
import { createGitRevisionReader } from './git.ts';
import { createGhostscriptRenderer } from './renderers/ghostscript.ts';
import { createMupdfRenderer } from './renderers/mupdf.ts';
import { createPopplerRenderer } from './renderers/poppler.ts';

/**
 * Work out what this machine can do, and assemble the tools for it.
 *
 * This is the data behind the "Check my setup" command. Every capability is
 * reported whether or not it is available, with the reason and what to do —
 * a person on a locked-down laptop should learn that PowerPoint plots need
 * Office *before* they build a workbook full of placeholders, not after.
 */

export type Capability = 'plots' | 'office' | 'html' | 'git';

export interface CapabilityReport {
  readonly capability: Capability;
  /** A short phrase for a list: "PowerPoint, Word and Excel plots". */
  readonly title: string;
  readonly status: 'ready' | 'missing';
  /** What is providing it, when something is. */
  readonly provider?: string | undefined;
  readonly version?: string | undefined;
  /** What the person can do about it, when it is missing. */
  readonly advice?: string | undefined;
}

export interface Machine {
  readonly tools: Tools;
  readonly report: readonly CapabilityReport[];
}

export interface DiscoverOptions {
  /** Force a particular Office backend, or turn Office conversion off. */
  readonly officeConverter?: 'auto' | 'msoffice' | 'libreoffice' | 'off' | undefined;
  /** An explicit browser path from settings, used before any detection. */
  readonly browserPath?: string | undefined;
}

export async function inspectMachine(options: DiscoverOptions = {}): Promise<Machine> {
  const [renderer, office, browser, git] = await Promise.all([
    findRenderer(),
    findOfficeConverter(options.officeConverter ?? 'auto'),
    findBrowserConverter(options.browserPath),
    findGit(),
  ]);

  const converters = [office?.converter, browser?.converter].filter(
    (converter): converter is DocumentConverter => converter !== undefined,
  );

  const tools: Tools = {
    ...(renderer?.renderer === undefined ? {} : { renderer: renderer.renderer }),
    ...(converters.length === 0 ? {} : { converter: combineConverters(converters) }),
    ...(git?.reader === undefined ? {} : { revisions: git.reader }),
  };

  const report: CapabilityReport[] = [
    {
      capability: 'plots',
      title: 'PDF and image plots',
      status: renderer === undefined ? 'missing' : 'ready',
      ...(renderer === undefined
        ? { advice: 'Install Ghostscript or poppler, or use a build of the extension that bundles a renderer.' }
        : { provider: renderer.renderer.name, version: renderer.version }),
    },
    {
      capability: 'office',
      title: 'Word, PowerPoint and Excel plots',
      status: office === undefined ? 'missing' : 'ready',
      ...(office === undefined
        ? {
            advice:
              process.platform === 'win32'
                ? 'Microsoft Office was not found. Install it, or install LibreOffice, to use Office files as plots.'
                : 'Install LibreOffice to use Word, PowerPoint or Excel files as plots.',
          }
        : { provider: office.converter.name, version: office.version }),
    },
    {
      capability: 'html',
      title: 'HTML plots',
      status: browser === undefined ? 'missing' : 'ready',
      ...(browser === undefined
        ? { advice: 'Install Microsoft Edge, Google Chrome or another Chromium browser to render HTML plots.' }
        : { provider: browser.converter.name, version: browser.version }),
    },
    {
      capability: 'git',
      title: 'Comparing against earlier revisions',
      status: git === undefined ? 'missing' : 'ready',
      ...(git === undefined
        ? { advice: 'Install git to compare a plot against a committed version.' }
        : { provider: 'git', version: git.version }),
    },
  ];

  return { tools, report };
}

/** One line per capability, for an output channel or a notification. */
export function summarise(report: readonly CapabilityReport[]): string {
  return report
    .map((entry) => {
      const mark = entry.status === 'ready' ? 'ready  ' : 'missing';
      const detail =
        entry.status === 'ready'
          ? `${entry.provider}${entry.version === undefined ? '' : ` (${entry.version})`}`
          : entry.advice ?? '';
      return `${mark}  ${entry.title}: ${detail}`;
    })
    .join('\n');
}

async function findRenderer(): Promise<{ renderer: PdfRenderer; version?: string | undefined } | undefined> {
  const bundled = await createMupdfRenderer();
  if (bundled !== undefined) return { renderer: bundled };

  const ghostscript = await findExecutable('ghostscript', ghostscriptLookup());
  if (ghostscript !== undefined) {
    return { renderer: createGhostscriptRenderer(ghostscript.command), version: ghostscript.version };
  }

  const poppler = await findExecutable('poppler', popplerLookup());
  if (poppler !== undefined) {
    return { renderer: createPopplerRenderer(poppler.command), version: poppler.version };
  }

  return undefined;
}

async function findOfficeConverter(
  preference: NonNullable<DiscoverOptions['officeConverter']>,
): Promise<{ converter: DocumentConverter; version?: string | undefined } | undefined> {
  if (preference === 'off') return undefined;

  const wantsOffice = preference === 'auto' || preference === 'msoffice';
  if (wantsOffice && process.platform === 'win32') {
    const [office, shell] = await Promise.all([findMicrosoftOffice(), findExecutable('powershell', powerShellLookup())]);
    if (office !== undefined && shell !== undefined) {
      return { converter: createMicrosoftOfficeConverter(shell.command), version: 'via PowerShell' };
    }
    if (preference === 'msoffice') return undefined;
  }

  if (preference === 'auto' || preference === 'libreoffice') {
    const libre = await findExecutable('libreoffice', libreOfficeLookup());
    if (libre !== undefined) return { converter: createLibreOfficeConverter(libre.command), version: libre.version };
  }

  return undefined;
}

async function findBrowserConverter(
  explicitPath: string | undefined,
): Promise<{ converter: DocumentConverter; version?: string | undefined } | undefined> {
  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    return { converter: createChromiumConverter(explicitPath.trim()), version: 'from settings' };
  }

  // An escape hatch for a browser in an unusual place - a portable install, a
  // container image - without having to open settings.
  const fromEnvironment = process.env['PLOTEXCEL_BROWSER'];
  if (fromEnvironment !== undefined && fromEnvironment.trim().length > 0) {
    return { converter: createChromiumConverter(fromEnvironment.trim()), version: 'from PLOTEXCEL_BROWSER' };
  }

  const browser = await findExecutable('chromium', chromiumLookup());
  return browser === undefined
    ? undefined
    : { converter: createChromiumConverter(browser.command), version: browser.version };
}

async function findGit(): Promise<{ reader: RevisionReader; version?: string | undefined } | undefined> {
  const git = await findExecutable('git', gitLookup());
  return git === undefined ? undefined : { reader: createGitRevisionReader(git.command), version: git.version };
}

/** Route each extension to whichever converter claims it. */
export function combineConverters(converters: readonly DocumentConverter[]): DocumentConverter {
  return {
    name: converters.map((converter) => converter.name).join(' and '),

    canConvert(extension) {
      return converters.some((converter) => converter.canConvert(extension));
    },

    async toPdf(input) {
      const converter = converters.find((candidate) => candidate.canConvert(input.extension));
      if (converter === undefined) {
        throw new Error(`Nothing on this machine converts .${input.extension} files.`);
      }
      return converter.toPdf(input);
    },
  };
}

/** How many renders to run at once on this machine. */
export function suggestedConcurrency(): number {
  return Math.max(2, Math.min(6, os.cpus().length - 1));
}
