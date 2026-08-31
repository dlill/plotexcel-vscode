# The map

Five packages. The dependency arrows all point one way:

```
extension ─┐
cli       ─┼─→ tools ─→ core
browser   ─┘            ↑
   └────────────────────┘   (browser reaches core directly, never tools)
```

`core` depends on nothing. It does not import `vscode`, does not spawn
processes, and — in the modules the browser build reaches — does not import a
`node:` builtin either. Everything that touches the outside world arrives
through `pipeline/ports.ts` as an object of functions.

That single seam is why the pipeline can be tested without Ghostscript
installed, and why a browser page can build a real workbook.

---

## packages/core — 4,900 lines, 11 test files

The whole of what plotExcel *is*, with nothing platform-specific in it.

### Reading the layout

| File | Does |
|---|---|
| `layout/layoutFile.ts` | `parseLayout` / `formatLayout`. The `.plotexcel.tsv` format, the `#key: value` preamble, and the diagnostics a bad line produces. |
| `layout/editCell.ts` | String surgery on one cell — set a crop, change a page, renumber a caption — leaving the rest of the line untouched. Used by every editor command that rewrites a layout. |
| `spec/classify.ts` | Is this cell a plot, a caption, a diff, or empty? Decided by extension alone, **never** by touching the filesystem. |
| `spec/plotSpec.ts` | `path::page 2::xmin 10` into a `PlotSpec`. Keys match exactly. |
| `spec/textSpec.ts` | A caption and its style. The style is taken from the last `::` only when that segment is a real style name. |
| `spec/diffSpec.ts` | ``diff(`A`, `B`)``, with backtick-aware comma splitting. |
| `styles.ts` | The ten styles, transcribed from the R package. |
| `types.ts` | `PlotSpec`, `Cell`, `SpecError`. Written without parameter properties — Node's type stripping cannot emit them. |

### Making the pictures

| File | Does |
|---|---|
| `pipeline/ports.ts` | **The seam.** `PdfRenderer`, `DocumentConverter`, `RevisionReader`, `Tools`. Everything outside arrives here. |
| `pipeline/renderPlot.ts` | Six stages: locate → checkout at a revision → convert to PDF → rasterise a page → crop → cache. Never throws; a failure becomes a placeholder image that says what is wrong. |
| `pipeline/renderDiff.ts` | Two rendered pages into a difference image. |
| `pipeline/cache.ts` | `cacheStats`, `clearCache`, `pruneCache`. Size-capped, oldest-first. |
| `pipeline/files.ts` | Atomic writes, freshness by mtime. |
| `pipeline/limit.ts` | `mapWithLimit` — bounded concurrency with cancellation. |
| `cache/keys.ts` | Every intermediate path, derived from the inputs. Change the page, the dpi or the crop and you get a different path; that is what makes the pipeline idempotent. Case-folded on Windows and macOS. |
| `image/png.ts` | A complete PNG codec. Decodes every non-interlaced form (1/2/4/8/16-bit, all five filters, `pHYs`); encodes with adaptive filtering. |
| `image/ops.ts` | Crop, difference (YIQ, pixelmatch-style threshold), placeholder images. |
| `image/font.ts` | A 5x7 bitmap font, upper and lower case. The placeholders have to say something and there is no font library. |

### Writing the workbook

| File | Does |
|---|---|
| `xlsx/workbookParts.ts` | Every OOXML part, as bytes. **Imports nothing but arithmetic**, which is what lets the browser use it. |
| `xlsx/writeWorkbook.ts` | Four lines: hand those parts to the Node ZIP writer. The only part that touches a platform. |
| `xlsx/xml.ts` | Escaping, cell references, column names. |
| `zip/zip.ts` | Deterministic ZIP on `node:zlib`. Also reads, for the Office converters. |
| `units.ts` | Centimetres to column widths and row heights. `COLUMN_WIDTH_PER_CM = 5.3` and the rest were measured from the R package's own output, not derived. |
| `build/renderLayout.ts` | Layout in, workbook out. Orchestrates the pipeline, collects issues, reports progress. |
| `build/generateLayout.ts` | A folder (or two, for a comparison) into a layout. |
| `build/exportPdf.ts` | The workbook to PDF, when a converter exists. |
| `samples/samplePdf.ts` | A real PDF, written by hand, cross-reference table and all. |
| `samples/sampleProject.ts` | Four plots and a layout, generated so they cannot drift from the code. |
| `documents/pdfPages.ts` | Page counts from a PDF's own structure. Platform-free, so the browser can use it. |
| `documents/pageCount.ts` | The same, plus the paths that need `node:fs` — pptx slides, docx `<Pages>`. |

---

## packages/tools — 1,300 lines, 3 test files

Every adapter. Each one optional, each one detected, none required.

| File | Does |
|---|---|
| `exec.ts` | `run` on `spawn`, with a detached process group so a leaked grandchild cannot hang the pipeline, and a 2 s grace after exit. |
| `detect.ts` | **A pure PATH walk.** No process is started to find out whether a tool exists — `soffice --version` launches LibreOffice, which is how detection once became a thirty-second hang. |
| `discover.ts` | `inspectMachine` → a `Tools` object plus a report in words rather than tool names. |
| `renderers/*` | Ghostscript, Poppler, MuPDF. First one found wins. |
| `converters/*` | Microsoft Office, LibreOffice (own profile per conversion, so two can run at once), Chromium for HTML, and a page-setup fixer for `.xlsx` inputs. |
| `git.ts` | Reading a file at a revision. |

---

## packages/extension — 3,000 lines, 26 tests

25 commands, 54 menu entries, 4 keybindings, a tree view, a walkthrough and
seven editor features. **Never run in a real extension host** — but activated
in every test run against `test/vscode.cjs`, a recording stub, and checked
against its own manifest.

| Area | Files |
|---|---|
| Entry | `extension.ts` — registers everything; the list of what exists |
| Commands | `commands/{render,generate,compare,preview,edit,maintenance,sample}.ts` |
| Editor features | `language/{diagnostics,completion,hover,codelens,codeActions,format,drop,cells}.ts` |
| Plumbing | `storage.ts` (the `.plotexcel/` folder), `machine.ts` (settings + detection cache), `layouts.ts`, `selection.ts` (diff selection + status bar), `output.ts`, `watch.ts` |
| View | `views/plotexcelView.ts` |

`storage.ts` is the rule about where things go: everything project-scoped under
`<workspace>/.plotexcel/`, which carries a one-line `*` gitignore so it ignores
itself. Pipeline intermediates go to the system temp folder instead — they are
reproducible and there can be thousands.

---

## packages/cli — 300 lines, 12 tests

`render | generate | compare | compare-folders | check | cache`. The core
without an editor, and the fastest way to exercise a change. Its tests start
real processes and read what they printed, because what they are checking is
the argument parsing, the exit codes and the messages — not the rendering,
which is covered thoroughly elsewhere.

```
npm run demo -- render some.plotexcel.tsv -o out.xlsx
```

## packages/browser — 800 lines, 1 test file

The same core in one HTML file. `tools/bundle-browser.mjs` inlines the module
graph; `packages/browser/README.md` explains the seam. The test walks the
import graph and fails on the first `node:` or package import.

---

## tools/

| Script | For |
|---|---|
| `load-extension-sources.mjs` | Loads all extension sources against a `vscode` stub and checks the manifest against the code |
| `verify.mjs` | Everything, in order. `npm run verify` |
| `release.mjs`, `release-notes.mjs` | Cutting a release |
| `bundle-browser.mjs`, `serve-browser.mjs` | The browser build |
| `make-icon.mjs` | Redraws `media/icon.png` |
| `sample-workbook.ts`, `verify-workbook.py` | A workbook by hand, and an openpyxl check of one |
| `dump-r-vectors.R`, `make-reference-workbook.R` | The oracles. Need R, and are only for checking a port decision against the original |
| `make-png-fixtures.py` | Regenerates the PNG decoder fixtures |
