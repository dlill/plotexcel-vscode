# Changelog

## 0.0.1 — unreleased

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
