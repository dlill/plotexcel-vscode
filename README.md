# plotexcel-vscode

Arrange PDF and image plots into an Excel workbook, from VS Code — the
[plotExcel](https://github.com/dlill/plotExcel) R package, ported so that no R
installation is needed.

**Status.** The engine is complete and tested: layouts, the render pipeline,
image handling, the workbook writer, the adapters for external tools, and a
command line that drives all of it. The VS Code layer builds, packages to a
`.vsix` and has been run in an extension host; it is tested against a stub of
the VS Code API and checked against its own manifest, so a command that would
fail when pressed fails a test first.

```
npm test                                                                     # 283 tests, no VS Code, no build step
node packages/cli/src/main.ts check                                          # what this machine can do
node packages/cli/src/main.ts generate ./figs --render                       # folder -> layout -> workbook
```

Node 22.6 or newer runs the TypeScript directly, so none of that needs a build
step or a single installed package.

## What is here

| Path | What it is |
|---|---|
| `packages/core` | Layouts, specs, cache keys, PNG codec, ZIP, the .xlsx writer, the pipeline. No dependencies, no `vscode`. |
| `packages/tools` | Adapters: PDF renderers, Office and HTML converters, git. Each optional, each detected. |
| `packages/cli` | `plotexcel render | generate | compare | compare-folders | check | cache` |
| `packages/extension` | Commands, menus, settings, walkthrough, and the editor features for layout files. |
| `packages/browser` | The same core in one HTML file: drop a folder, get a workbook. No install, no server. |
| `tools/` | Scripts: the R oracles, PNG fixtures, a workbook sample, an openpyxl check. |
| `docs/decisions.md` | What is settled, what differs from the R package, what is still open. |
| `docs/architecture.md` | The module map: what each file does and which way the arrows point. |
| `CLAUDE.md` | The rules — no dependencies, no parameter properties, where things go. |

## No dependencies

Three things this port does not depend on, and why:

**No spreadsheet library.** An `.xlsx` is a ZIP of XML, and `node:zlib` reaches
both. Writing the parts directly is what makes image geometry exact: pictures
are positioned in EMU — 360000 per centimetre — which is precisely what
openxlsx does, so a plot that is 12.395 cm wide in R is 12.395 cm wide here.

**No image library.** PNG is chunks around a zlib stream, so decoding, cropping,
diffing and encoding are all reachable from the standard library. The decoder
handles every non-interlaced PNG; the fixtures it is tested against were
written by a Python encoder, so it is proved against files this repository did
not produce.

**No bundled converters.** Rendering PDF pages, converting Office documents and
reading git are three interfaces. Whatever the machine has fills them in:
MuPDF if the optional package is installed, else Ghostscript or poppler;
Microsoft Office on Windows, else LibreOffice; Edge or Chrome for HTML. What is
missing is reported rather than fatal — those cells get an image that names the
tool to install, and the rest of the workbook renders.

## Installing it

Releases are `.vsix` files on the
[releases page](https://github.com/dlill/plotexcel-vscode/releases). The latest
one always lives at the same URL, so this command does not go stale:

```
curl -LO https://github.com/dlill/plotexcel-vscode/releases/latest/download/plotexcel.vsix
code --install-extension plotexcel.vsix
```

Or in VS Code: **Extensions** → the **…** menu → **Install from VSIX…**

Updates are not automatic on this route — run the two lines again. Cutting a
release is `npm run release minor`, which bumps the version, dates the
changelog, commits and tags; pushing the tag builds the `.vsix` and publishes
it with the changelog section as its notes.

## Working on it

```
npm install        # devtools only; the code itself needs nothing
npm run verify     # tests, extension manifest, browser bundle, typecheck
```

There is no build step for development: Node 22.18+ strips TypeScript types
itself, so the tests and the CLI run the sources directly. esbuild is used
once, at packaging time.


Nothing is built automatically. A commit — even straight onto `main` — runs
nothing at all, so day-to-day work costs no waiting and produces no red
badges. Two things do run:

| What | When |
|---|---|
| Tests, on Linux and Windows | a pull request, a version tag, or the Run workflow button |
| Build and publish the `.vsix` | a `v*` tag, and nothing else |

The release workflow runs the tests itself before it packages anything, so a
tag with a failing suite produces no release rather than a broken one. The
cost of this arrangement is that a mistake committed directly to `main` sits
there until the next pull request or tag; running `npm test` locally before
pushing is the habit that closes that gap. To go back to testing every commit
on `main`, uncomment the four lines at the top of
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Without installing anything

`npm run browser:bundle` writes `dist/plotexcel.html` — one file, 65 KB, no
network requests. Double-click it, drop a folder of plots on it, and the
workbook is written back into that folder. It runs from `file://`, so it
travels by email or USB stick and needs no VS Code, no Node and no admin
rights; Chrome and Edge have the folder API it needs, Firefox and Safari do
not.

A browser has no PDF renderer, so PDF pages arrive as labelled placeholders —
but the page also writes the `.plotexcel.tsv` layout, and rendering that with
the extension or the CLI produces the full workbook. See
[`packages/browser/README.md`](packages/browser/README.md).

## Layout files

A layout is a tab-separated file named `<something>.plotexcel.tsv`:

```
# generated from figs/, then edited
#output: reports/plots.xlsx
#resolution: 150
Description             Current                 Baseline                            Diff
Iris, page 1::vcenter   figs/01.pdf::page 1     figs/01.pdf::page 1::commit HEAD~1   diff(Current, Baseline)
```

Tabs rather than commas, because generated description cells contain commas and
CSV would need them quoted. Options live in a `#key: value` preamble above the
header row.

| In a cell | Means |
|---|---|
| `plot.pdf::page 2` | the second page or slide |
| `plot.pdf::xmax 85` | crop to the left 85% |
| `plot.pdf::resolution 300` | render at 300 dpi — which also sets its size in the workbook |
| `plot.pdf::commit HEAD~1` | the version committed before the last one |
| `Some caption::vcenter` | text, in one of ten named styles |
| `diff(Current, Baseline)` | the visual difference between two columns of this row |

## Where things are written

`<workspace>/.plotexcel/` holds layouts, workbooks and logs, and carries a
one-line `.gitignore` containing `*` so it ignores itself — the extension never
edits a file you own. Pipeline intermediates go to the system temp folder
instead, keyed on their inputs, so a re-render after one edit costs almost
nothing. Detected tool paths are per-machine and stay out of the project.

Nothing empties the system temp folder reliably — Windows does not clear
`%TEMP%` on reboot, and closing the editor does nothing — so plotExcel manages
that cache itself. After every render it drops the oldest entries to stay under
`plotexcel.cacheSizeLimitMB` (1 GB by default), and once the cache passes 80% of
that it says so, with `Clear Cache` one click away in the notification and in
the plotExcel panel. Clearing costs nothing but the next render's speed.

## Finishing it

1. `npm install` (or pnpm), then `npm run build -w plotexcel`.
2. Open the repository in VS Code and press F5 to launch an extension host.
3. Run the two R scripts once, on a machine with plotExcel installed, to get
   the oracles: `tools/dump-r-vectors.R` and `tools/make-reference-workbook.R`.
   Add your own real spec strings to the first before running it.
4. Compare `reference.xlsx` against a render of `reference.plotexcel.tsv`. The
   constants to adjust, if any are needed, are in `packages/core/src/units.ts`
   and `packages/core/src/xlsx/writeWorkbook.ts`.

`node tools/load-extension-sources.mjs` loads every extension source against a
stub of the VS Code API — a smoke alarm for syntax and import mistakes while
the package cannot be compiled.

## Licence

AGPL-3.0-or-later, following the R package. Only the optional MuPDF renderer
requires it; a PDFium-based renderer would leave the choice open.
