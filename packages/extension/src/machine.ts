import * as vscode from 'vscode';

import type { Tools } from '../../core/src/pipeline/ports.ts';
import { clearDetectionCache } from '../../tools/src/detect.ts';
import { inspectMachine, suggestedConcurrency, type CapabilityReport } from '../../tools/src/discover.ts';

/**
 * What this machine can do, looked up once and remembered.
 *
 * Detection is cheap — a PATH walk, no processes started — but it is still
 * work, and the answer does not change while VS Code is open unless someone
 * installs something. Changing the relevant settings, or running "Check my
 * setup", clears it.
 */

let cached: Promise<{ tools: Tools; report: readonly CapabilityReport[] }> | undefined;

let bundledMupdf: string | undefined;

/**
 * Where the MuPDF build landed inside the installed extension.
 *
 * It ships as files beside the bundle rather than inside it, because it is ESM
 * and finds its `.wasm` through `import.meta.url` — neither survives being
 * flattened into the CommonJS bundle. Only the host knows the install path, so
 * activation has to hand it over.
 */
export function useBundledMupdf(path: string): void {
  bundledMupdf = path;
}

export function settings() {
  const configuration = vscode.workspace.getConfiguration('plotexcel');

  return {
    layoutLocation: configuration.get<'projectFolder' | 'besideSource' | 'ask'>('layoutLocation', 'projectFolder'),
    defaultResolution: configuration.get<number>('defaultResolution', 150),
    nPagesMax: configuration.get<number>('nPagesMax', 4),
    confirmAbovePageCount: configuration.get<number>('confirmAbovePageCount', 120),
    cacheSizeLimitMB: configuration.get<number>('cacheSizeLimitMB', 1024),
    cacheWarnAtPercent: configuration.get<number>('cacheWarnAtPercent', 80),
    officeConverter: configuration.get<'auto' | 'msoffice' | 'libreoffice' | 'off'>('officeConverter', 'auto'),
    browserPath: configuration.get<string>('browserPath', ''),
    openAfterRender: configuration.get<boolean>('openAfterRender', true),
  };
}

/**
 * Whether this window may start external programs.
 *
 * Rendering runs converters — LibreOffice, PowerShell, a headless browser —
 * over files the workspace chose, and a layout file is a list of paths that
 * names them. Opening a repository must not be enough to cause any of that.
 *
 * The gate sits here rather than in each command because this is the one place
 * tools are assembled: a command that forgets to ask still comes away with
 * nothing that can run.
 */
export function isTrusted(): boolean {
  // Absent on hosts predating workspace trust, where every folder is trusted
  // and there is nothing to enforce.
  return vscode.workspace.isTrusted !== false;
}

const UNTRUSTED_ADVICE =
  'This folder is not trusted, so plotExcel will not start converters or read git. Trust the folder to enable it.';

const UNTRUSTED: readonly CapabilityReport[] = [
  { capability: 'plots', title: 'PDF and image plots', status: 'missing', advice: UNTRUSTED_ADVICE },
  { capability: 'office', title: 'Word, PowerPoint and Excel plots', status: 'missing', advice: UNTRUSTED_ADVICE },
  { capability: 'html', title: 'HTML plots', status: 'missing', advice: UNTRUSTED_ADVICE },
  { capability: 'git', title: 'Comparing against earlier revisions', status: 'missing', advice: UNTRUSTED_ADVICE },
];

export async function machine(): Promise<{ tools: Tools; report: readonly CapabilityReport[] }> {
  // Before detection, not after: finding the tools means running `gs --version`
  // and walking the PATH, which an untrusted folder should not provoke either.
  if (!isTrusted()) return { tools: {}, report: UNTRUSTED };

  const current = settings();

  cached ??= inspectMachine({
    officeConverter: current.officeConverter,
    browserPath: current.browserPath,
    bundledMupdf,
  });

  return cached;
}

/**
 * Stop a command that would need to start something, and offer the way out.
 *
 * Answers false when the folder is still untrusted, in which case the caller
 * does nothing more: the person has already been told why. Trust is not
 * re-checked afterwards on purpose — the trust editor opens alongside, and a
 * command that silently resumed minutes later would be a surprise.
 */
export async function requireTrust(): Promise<boolean> {
  if (isTrusted()) return true;

  const manage = 'Manage Trust';
  const choice = await vscode.window.showWarningMessage(
    'plotExcel does not render in a folder that is not trusted, because rendering runs converters such as ' +
      'LibreOffice and a browser over files from it.',
    manage,
  );
  if (choice === manage) await vscode.commands.executeCommand('workbench.trust.manage');

  return false;
}

/** Detection is gated on trust, so granting it has to invalidate what was cached. */
export function watchTrust(): vscode.Disposable {
  return vscode.workspace.onDidGrantWorkspaceTrust(() => forgetMachine());
}

/** Forget what was detected, so the next look starts again. */
export function forgetMachine(): void {
  cached = undefined;
  clearDetectionCache();
}

export function concurrency(): number {
  return suggestedConcurrency();
}

/** Watch the settings that change what was detected. */
export function watchSettings(): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('plotexcel.officeConverter') || event.affectsConfiguration('plotexcel.browserPath')) {
      forgetMachine();
    }
  });
}
