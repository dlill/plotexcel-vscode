# plotExcel

Turn a folder of plots into one Excel workbook — PDFs, PNGs, Word, PowerPoint
and HTML — with page extraction, cropping, git revisions and visual diffs.

A port of the R package [plotExcel](https://github.com/dlill/plotExcel).
**R is not required**, and neither is anything else: the extension does what it
can with what it finds on the machine, and says plainly what it cannot do.

## Installing

```
curl -LO https://github.com/dlill/plotexcel-vscode/releases/latest/download/plotexcel.vsix
code --install-extension plotexcel.vsix
```

Or: **Extensions** → the **…** menu → **Install from VSIX…** Updates are not
automatic — run it again when there is a new release.

## Getting started

Run **plotExcel: Open a Sample Project** from the command palette. It writes
four plots and a layout that already uses page numbers, a crop, a caption
style and a comparison column, then renders in about two seconds. The sample
plots are real PDFs, so if it comes out with pictures rather than grey notes,
this computer can render everything plotExcel handles.

Or start from your own folder:

1. Right-click a folder of plots → **Generate Table Layout**
2. A `.plotexcel.tsv` file opens. It is a plain table — edit it however you like
3. Press `Alt+R`, or run **plotExcel: Render plotExcel**

The workbook lands in `.plotexcel/out/` and opens.

## The layout file

One row per row of the workbook, one column per column. A cell is a path plus
decorators after `::`.

```
#resolution: 150
#textColWidth: 8
Description	Before	After	Change
Baseline fit::vcenter	figs/fit.pdf::page 1	figs/fit.pdf::commit HEAD~5	::diff Before After
Residuals::vcenter	figs/resid.png::xmin 0.1::xmax 0.9	figs/resid.png::commit main	::diff Before After
```

- `::page 2` — which page of a multi-page document
- `::resolution 300` — dpi, which also decides the physical size in the sheet
- `::xmin 0.1::xmax 0.9::ymin 0::ymax 0.5` — crop, as fractions of the page
- `::commit HEAD~5` — the file as it was at that revision
- ``diff(`Before`, `After`)`` — a visual difference of two other columns
- `::vcenter`, `::hvcenter`, `::rotateUp`, … — the ten styles from the R package

A comparison takes two options of its own. ``diff(`A`, `B`)::tolerance 0.3``
ignores pixels that differ only slightly, which is what anti-aliasing and font
hinting do between two renders of the same figure; `::context off` drops the
faded background and leaves only what changed.

Type `::` and completions appear; hover any cell to see what it resolves to.

## Several things side by side

For a handful of things that are nearly the same — one folder per run, one
export per week — select them all and right-click → **Lay Out Side by Side…**.
Each gets a column, and each row is one page, so page 3 of every one of them
sits on the same row. Folders are paired by the path each file has inside them,
so a file only some of them hold still gets a row with the gap visible.

To grow a layout afterwards: right-click a plot → **Add to Layout Below** for
another row, or **Add to Layout as New Column** for another column beside what
is already there.

## Comparing things

- Right-click a file or folder → **Select for Visual Diff**, then right-click a
  second one → **Compare Visually with Selected**
- Or select two files at once → **Visually Diff These Two**
- Or select one, then **plotExcel: Compare Selected with Revision…** to diff it
  against any git commit, tag or branch

Changed pixels come out red; area covered by only one of the two, amber.

## What it needs on the machine

Nothing, to install. What is available decides what can be rendered:

| To render | It uses | If missing |
|---|---|---|
| PDF pages | Ghostscript, Poppler or MuPDF | the cell explains what to install |
| PNG plots | nothing | always works |
| Word, PowerPoint, Excel | Microsoft Office or LibreOffice | placeholder with the reason |
| HTML | Chrome, Edge or Chromium | placeholder with the reason |
| `::commit` | git | placeholder with the reason |

Run **plotExcel: Check My Setup** to see where this machine stands. A missing
tool never fails a render: the cell becomes an image saying what is needed, and
the rest of the workbook builds normally.

## Where it puts things

`.plotexcel/` in the workspace root holds generated layouts and workbooks, and
carries its own `.gitignore` — the extension never edits a file you own.
Intermediate images go to `plotexcel` in the system temp folder, keyed on their
inputs, so a re-render after one edit is close to instant. Nothing plotExcel
writes to that folder lands anywhere else, so **plotExcel: Clear Cache** reports
and frees the whole of it. The cache is capped at 1 GB, pruned oldest-first, and
plotExcel offers to clear it as it fills.

**plotExcel: Clean Up the Project Folder…** empties it again. Use it rather than
Explorer: Excel keeps an exclusive lock on a workbook for as long as it is open,
and Windows reports a locked file inside a folder as *"you'll need to provide
administrator permission to delete this folder"* — which is not a permissions
problem at all. The command deletes what it can and names the workbook that is
still open.

## Settings

`plotexcel.defaultResolution`, `plotexcel.nPagesMax`, `plotexcel.layoutLocation`,
`plotexcel.officeConverter`, `plotexcel.browserPath`, `plotexcel.cacheSizeLimitMB`,
`plotexcel.cacheWarnAtPercent`, `plotexcel.confirmAbovePageCount`,
`plotexcel.openAfterRender`.

## Licence

AGPL-3.0-or-later, following the R package it is a port of.
