import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DocumentConverter } from '../../../core/src/pipeline/ports.ts';
import { run, withScratchDir } from '../exec.ts';

const SUPPORTED = ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xlsm', 'xls'];

/**
 * Convert Office documents with the Office applications themselves.
 *
 * On the machines this extension is aimed at — Windows with Microsoft Office —
 * this is both the highest-fidelity conversion available and the only one that
 * needs nothing installed. The PowerShell below is carried over from the R
 * package, where it was already platform-tested; the additions are a
 * per-format timeout and the check that the PDF actually appeared.
 *
 * It fails in ways worth naming: Office refuses to automate while a modal
 * dialog is open, and a machine with Office 365 in web-only mode has no COM
 * server at all. Both surface as a clear message rather than a hang, because
 * the run is bounded.
 */
export function createMicrosoftOfficeConverter(powershell = 'powershell.exe'): DocumentConverter {
  return {
    name: 'Microsoft Office',

    canConvert(extension) {
      return process.platform === 'win32' && SUPPORTED.includes(extension.toLowerCase());
    },

    async toPdf({ bytes, extension, pageSize }) {
      const lower = extension.toLowerCase();
      const kind = lower.startsWith('doc') ? 'word' : lower.startsWith('ppt') ? 'powerpoint' : 'excel';

      return withScratchDir('plotexcel-office', async (directory) => {
        const input = path.join(directory, `input.${lower}`);
        const output = path.join(directory, 'output.pdf');
        const script = path.join(directory, 'convert.ps1');

        await writeFile(input, bytes);
        await writeFile(script, POWERSHELL, 'utf8');

        const result = await run(
          powershell,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, input, output, kind, pageSize ?? 'single'],
          { timeoutMs: 300_000 },
        );

        const pdf = await readFile(output).catch(() => undefined);
        if (pdf === undefined) {
          const detail = result.stderr.trim().split('\n')[0] ?? `exit ${result.code}`;
          throw new Error(`Office did not produce a PDF: ${detail}`);
        }

        return pdf;
      });
    },
  };
}

const POWERSHELL = [
  'param([string]$inPath, [string]$outPath, [string]$kind, [string]$pageSize)',
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  $inFull  = [System.IO.Path]::GetFullPath($inPath)',
  '  $outFull = [System.IO.Path]::GetFullPath($outPath)',
  '  if ($kind -eq "word") {',
  '    $app = New-Object -ComObject Word.Application',
  '    $app.Visible = $false',
  '    try {',
  '      $doc = $app.Documents.Open($inFull, $false, $true)',
  '      $doc.SaveAs([ref]$outFull, [ref]17)  # wdFormatPDF',
  '    } finally {',
  '      if ($doc) { $doc.Close([ref]$false) }',
  '      if ($app) { $app.Quit() }',
  '    }',
  '  } elseif ($kind -eq "powerpoint") {',
  '    $app = New-Object -ComObject PowerPoint.Application',
  '    try {',
  '      $pres = $app.Presentations.Open($inFull, $true, $true, $false)',
  '      $pres.SaveAs($outFull, 32)  # ppSaveAsPDF',
  '    } finally {',
  '      if ($pres) { $pres.Close() }',
  '      if ($app) { $app.Quit() }',
  '    }',
  '  } else {',
  '    $app = New-Object -ComObject Excel.Application',
  '    $app.Visible = $false',
  '    $app.DisplayAlerts = $false',
  '    try {',
  '      $book = $app.Workbooks.Open($inFull, 0, $true)',
  '      foreach ($sheet in $book.Worksheets) {',
  '        $sheet.PageSetup.PaperSize = 9  # xlPaperA4',
  '        if ($pageSize -eq "single") {',
  '          $sheet.PageSetup.Zoom = $false',
  '          $sheet.PageSetup.FitToPagesWide = 1',
  '          $sheet.PageSetup.FitToPagesTall = 1',
  '        } else {',
  '          $sheet.PageSetup.Zoom = 100',
  '          $sheet.PageSetup.FitToPagesWide = $false',
  '          $sheet.PageSetup.FitToPagesTall = $false',
  '        }',
  '      }',
  '      $book.ExportAsFixedFormat(0, $outFull)  # xlTypePDF',
  '    } finally {',
  '      if ($book) { $book.Close($false) }',
  '      if ($app) { $app.Quit() }',
  '    }',
  '  }',
  '  exit 0',
  '} catch {',
  '  Write-Error $_.Exception.Message',
  '  exit 3',
  '}',
].join('\n');
