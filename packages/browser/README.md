# plotExcel in a browser

One HTML file. Drop a folder of plots on it, get an Excel workbook back in
that same folder. Nothing is installed, nothing is uploaded, and there is no
server involved — the file works when opened from disk.

```
npm run browser:bundle     # writes dist/plotexcel.html
npm run browser:serve      # http://localhost:8123 for development
```

## What makes it possible

The **File System Access API** (`showDirectoryPicker`, and
`getAsFileSystemHandle` on a dropped item) gives the page a real handle to a
real folder, with read and — once the person grants it — write permission.
That is the whole reason this can be a page rather than an upload form: the
workbook lands next to the plots, where it was expected, instead of in
Downloads.

It works from a `file://` page. Chrome and Edge have it; Firefox and Safari
do not, and the page says so rather than half-working.

## What it shares with the extension

Everything that decides what the workbook looks like:

| | |
|---|---|
| `core/xlsx/workbookParts.ts` | the OOXML parts, image geometry in EMU |
| `core/units.ts` | centimetres to column widths and row heights |
| `core/styles.ts` | the ten styles, straight from the R package |
| `core/layout/layoutFile.ts` | the `.plotexcel.tsv` layout format |
| `core/spec/*` | cell classification and decorator parsing |
| `core/documents/pdfPages.ts` | page counts read from the file's own structure |

Only the platform seam differs. `core/zip/zip.ts` deflates with `node:zlib`;
the browser has `zip.ts` here, which stores instead — a workbook is a few
small XML parts and a pile of already-compressed PNGs, so storing costs
almost nothing. `core/xlsx/writeWorkbook.ts` exists only to call the Node ZIP
writer; both sides call `buildWorkbookParts` for everything above that line.

## What it cannot do

A browser has no Ghostscript, no Poppler, and no way to reach Microsoft
Office, so:

- **PNGs** are placed at full fidelity, sized by their own resolution.
- **PDF pages** become a labelled placeholder.
- **.docx / .pptx / .xlsx** become a placeholder saying which converter is
  needed.

In every one of those cases the page also writes the `.plotexcel.tsv`
layout, and that file is the real thing: render it with the extension or
`plotexcel render` and the same workbook comes back with every page drawn.
The page is a way in, not a second implementation.

## The bundle

`tools/bundle-browser.mjs` inlines the module graph into `index.html`. There
is no bundler and nothing to install: Node strips the types, and each module
becomes an entry in a registry object with its own scope. 17 modules, about
65 KB, zero external requests.
