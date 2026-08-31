# Changelog

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
