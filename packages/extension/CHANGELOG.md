# Changelog

## 0.4.0 — 2026-09-04

- **A layout no longer quietly stops at four pages.** `plotexcel.nPagesMax`
  capped every file at 4, which was invisible: a seven-page HTML report came out
  as four rows and looked like plotExcel having misread the file. The default is
  now 25, and whenever the cap does apply, plotExcel says which files it cut
  short — "took 4 of 7 pages from report.html" — with **Take all pages** to do it
  again with no cap, and a button that opens the setting so it stays changed. The
  command line prints the same, and says to raise `--max-pages`.
- **Clean Up the Project Folder.** `.plotexcel` could not be deleted from
  Explorer: Windows claimed it needed administrator permission. It does not —
  a workbook opened after a render is locked by Excel for as long as it stays
  open, and Explorer reports a locked file inside a folder as a permissions
  problem. The new command deletes what plotExcel wrote, one file at a time, and
  names the workbook that is still open instead of blaming permissions. The
  panel in the Explorer shows what the folder holds and runs it in one click.
  Workbooks and layouts are offered separately, because a generated layout is
  usually one you have since edited.
- **`.plotexcel/logs/` is not created any more.** It was made on every setup and
  never written to once — the log is an output channel, not a file.
- **Everything temporary is in one folder, and Clear Cache accounts for all of
  it.** The cache was in `%TEMP%\plotexcel`, but converter working directories
  and the project's own test fixtures each took a folder of their own beside it
  — `plotexcel-gen-a1b2c3` and hundreds more — which Clear Cache neither
  counted nor removed. Now everything lives under `%TEMP%\plotexcel`, the
  reported size is the whole of it, and clearing also sweeps up the stray
  folders left by earlier versions.

- **Lay Out Side by Side.** Select several plots, or several folders, right-click
  and get a layout with one column each — page 3 of every one of them on the
  same row. For folders, the files are paired by the path they have inside each
  folder, so one row is one file and one page. It is the table for a handful of
  things that are nearly the same: one folder per run, one export per week. No
  difference column; **Compare** is still the way to get one of those, and
  **Add a Comparison Column** adds one afterwards.
- **Add to Layout as New Column.** The other half of adding to a layout: a plot
  from the next run goes beside what is already there rather than underneath
  it. Its pages fill downwards, page 1 in the first row, and a file with more
  pages than the table has rows extends it.
- **Add to plotExcel Layout is now Add to Layout Below**, because there are two
  of them and the old name no longer said where.

## 0.3.1 — 2026-08-31

Nothing you can see. 0.3.0 shipped with a type error in the layout generator's
progress reporting, which failed the test workflow but not the build — esbuild
strips types without checking them, so the 0.3.0 download behaves identically.
This is 0.3.0 with a green build, and is the one to install.

## 0.3.0 — 2026-08-31

- **The plotExcel right-click menu appears straight away.** It used to be
  missing until something else had woken the extension up, so it arrived only
  after running a command such as **Check My Setup** — and then stayed for the
  rest of the session.
- **HTML plots get all of their pages.** An HTML file has no page count until a
  browser has laid it out, so **Generate Table Layout** only ever gave it one
  row and the other pages were never asked for. It is now converted and counted
  properly, which also fixes **One Row per Page** and **Add to Layout** for HTML.
  Generating is cancellable, since it may have to start a browser per file.
- **Word, PowerPoint, Excel and HTML plots convert once instead of once per
  page.** The converted PDF is cached and shared by every page and every
  resolution of the same file, so a six-page HTML plot starts one browser rather
  than six — and after generating a layout, rendering it starts none at all.
  Changing `#resolution:` or adding a page no longer re-runs the converter.

## 0.2.0 — 2026-08-31

- **PDF plots work with nothing installed.** MuPDF ships inside the extension,
  so rendering no longer waits on Ghostscript or poppler being present — which
  on a machine managed by somebody else could mean waiting on a ticket.
  Ghostscript and poppler are still used when they are there and still named in
  **Check My Setup**; the difference is that PDF rendering is never missing.
  This makes the download about 4 MB rather than 64 KB.

## 0.1.0 — 2026-08-31

First version. A port of the R package [plotExcel](https://github.com/dlill/plotExcel)
that does not require R.

- Layout files (`.plotexcel.tsv`) with completions, hover, diagnostics,
  quick fixes, CodeLens, drag-and-drop and a formatter
- Render to `.xlsx` with exact image geometry in EMU, page extraction,
  cropping and the ten styles from the R package
- Visual diffs between two files, two folders, a file and a git revision, or
  a whole folder and a git revision. **Compare with Revision** is on the
  right-click menu of any plot or folder, with no need to select anything
  first; a plot added or deleted since that revision gets a row saying so
  rather than a rendering failure
- PDF rendering through Ghostscript, Poppler or MuPDF; Office documents
  through Microsoft Office or LibreOffice; HTML through Chrome or Edge —
  each optional, each detected, none required
- A cache in the system temp folder, capped and self-pruning
- Everything plotExcel adds to a right-click sits in one **plotExcel**
  submenu, rather than scattered through the Explorer's own groups
- On Windows the workbook name carries the time it was rendered, so a copy
  left open in Excel cannot fail the write after all the rendering is done.
  macOS and Linux keep the clean name and overwrite in place, and a layout
  that names its own `#output:` is left alone on every platform
- Rendering, previewing, watching and comparing wait for the workspace to be
  trusted, since they run converters over files the folder chose. An untrusted
  folder detects nothing and starts nothing; the notification offers Manage
  Trust.
- `plotexcel.browserPath` is a user setting rather than a workspace one, so a
  repository cannot name the program that renders its HTML plots
- Malformed or hostile PNG and Office files are refused with a message instead
  of being allowed to exhaust memory
