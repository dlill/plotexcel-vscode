import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { run } from './exec.ts';

/**
 * Finding the programs this machine happens to have.
 *
 * The extension bundles no converters and downloads nothing, so every optional
 * capability starts here. Detection walks the PATH itself and then looks in
 * the handful of places installers actually use — on Windows especially, where
 * almost nothing puts itself on the PATH.
 *
 * Nothing is started to find out whether it exists. Asking LibreOffice for its
 * version means launching LibreOffice, which on a cold machine takes seconds
 * and leaves a daemon behind; asking whether a file exists costs nothing.
 * Version strings are collected only from tools that print one and exit —
 * git, Ghostscript, pdftoppm — and are decoration in any case.
 *
 * Results are cached for the session: the answer does not change while VS Code
 * is open often enough to matter, and "Check my setup" clears the cache.
 */

export interface Found {
  readonly command: string;
  /** First line of the tool's version output, for tools cheap enough to ask. */
  readonly version?: string | undefined;
}

const cache = new Map<string, Found | undefined>();

export function clearDetectionCache(): void {
  cache.clear();
}

export interface LookupSpec {
  /** Names to look for on the PATH, in order of preference. */
  readonly names: readonly string[];
  /** Absolute paths to try if the PATH has nothing. */
  readonly candidates?: readonly string[];
  /** Directories whose subdirectories are scanned, e.g. C:\Program Files\gs\*. */
  readonly scanUnder?: readonly { readonly directory: string; readonly relative: string }[];
  /**
   * Arguments that make the tool print its version and exit. Only set these
   * for tools that really do exit — never for an office suite or a browser.
   */
  readonly versionArgs?: readonly string[];
}

/** Find one tool, or return undefined if this machine does not have it. */
export async function findExecutable(key: string, spec: LookupSpec): Promise<Found | undefined> {
  if (cache.has(key)) return cache.get(key);

  const found = await search(spec);
  cache.set(key, found);
  return found;
}

async function search(spec: LookupSpec): Promise<Found | undefined> {
  for (const name of spec.names) {
    const resolved = await resolveOnPath(name);
    if (resolved !== undefined) return describe(resolved, spec);
  }

  for (const candidate of spec.candidates ?? []) {
    if (await isExecutable(candidate)) return describe(candidate, spec);
  }

  for (const { directory, relative } of spec.scanUnder ?? []) {
    for (const child of await subdirectories(directory)) {
      const candidate = path.join(directory, child, relative);
      if (await isExecutable(candidate)) return describe(candidate, spec);
    }
  }

  return undefined;
}

async function describe(command: string, spec: LookupSpec): Promise<Found> {
  if (spec.versionArgs === undefined) return { command };

  try {
    const result = await run(command, spec.versionArgs, { timeoutMs: 10_000 });
    const first = result.stdout.toString('utf8').split('\n')[0]?.trim() ?? '';
    return { command, version: first.length > 0 ? first : undefined };
  } catch {
    // A tool that will not answer is still a tool that exists.
    return { command };
  }
}

/**
 * Resolve a bare name against the PATH, the way a shell would.
 *
 * Done here rather than by spawning `which` or `where`, both so it works the
 * same on every platform and so detection never starts a process.
 */
export async function resolveOnPath(name: string): Promise<string | undefined> {
  if (name.includes('/') || name.includes('\\')) {
    return (await isExecutable(name)) ? name : undefined;
  }

  const directories = (process.env['PATH'] ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  const suffixes =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((entry) => entry.length > 0)]
      : [''];

  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, name + suffix);
      if (await isExecutable(candidate)) return candidate;
    }
  }

  return undefined;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function subdirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------------- //
// Where things actually live
// ------------------------------------------------------------------------- //

const WINDOWS = process.platform === 'win32';
const MAC = process.platform === 'darwin';

const programFiles = [
  process.env['ProgramFiles'] ?? 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  process.env['LOCALAPPDATA'] ?? '',
].filter((directory) => directory.length > 0);

/** LibreOffice. No version probe: asking costs a full application start. */
export function libreOfficeLookup(): LookupSpec {
  if (WINDOWS) {
    return {
      names: ['soffice.com', 'soffice.exe'],
      candidates: programFiles.map((base) => path.join(base, 'LibreOffice', 'program', 'soffice.exe')),
    };
  }
  return {
    names: ['libreoffice', 'soffice'],
    candidates: MAC
      ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
      : ['/usr/bin/libreoffice', '/usr/bin/soffice', '/snap/bin/libreoffice'],
  };
}

/**
 * Chromium for HTML plots. Edge first on Windows: it is installed on every
 * machine the target audience uses, and its print-to-PDF is Chrome's.
 */
export function chromiumLookup(): LookupSpec {
  if (WINDOWS) {
    return {
      names: ['msedge.exe', 'chrome.exe'],
      candidates: programFiles.flatMap((base) => [
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]),
    };
  }
  if (MAC) {
    return {
      names: ['google-chrome', 'chromium'],
      candidates: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ],
    };
  }
  return {
    names: ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'],
    candidates: ['/usr/bin/google-chrome', '/usr/bin/chromium'],
  };
}

/** Ghostscript: the renderer the R package used, and common on Windows. */
export function ghostscriptLookup(): LookupSpec {
  if (WINDOWS) {
    return {
      names: ['gswin64c.exe', 'gswin32c.exe'],
      scanUnder: programFiles.map((base) => ({
        directory: path.join(base, 'gs'),
        relative: path.join('bin', 'gswin64c.exe'),
      })),
      versionArgs: ['--version'],
    };
  }
  return { names: ['gs'], candidates: ['/usr/bin/gs', '/usr/local/bin/gs'], versionArgs: ['--version'] };
}

/** Poppler's pdftoppm, the other common PDF rasteriser. */
export function popplerLookup(): LookupSpec {
  return {
    names: ['pdftoppm'],
    candidates: WINDOWS ? [] : ['/usr/bin/pdftoppm', '/opt/homebrew/bin/pdftoppm'],
    versionArgs: ['-v'],
  };
}

export function gitLookup(): LookupSpec {
  return {
    names: ['git'],
    candidates: WINDOWS ? programFiles.map((base) => path.join(base, 'Git', 'cmd', 'git.exe')) : ['/usr/bin/git'],
    versionArgs: ['--version'],
  };
}

export function powerShellLookup(): LookupSpec {
  return { names: ['pwsh.exe', 'powershell.exe'] };
}

/** Microsoft Office, found by its executables rather than by starting it. */
export async function findMicrosoftOffice(): Promise<Found | undefined> {
  if (!WINDOWS) return undefined;

  const candidates = programFiles.flatMap((base) => [
    path.join(base, 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'),
    path.join(base, 'Microsoft Office', 'Office16', 'WINWORD.EXE'),
    path.join(base, 'Microsoft Office', 'Office15', 'WINWORD.EXE'),
  ]);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return { command: candidate };
  }

  return undefined;
}
