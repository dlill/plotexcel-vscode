# Decisions this code assumes

The full porting plan — architecture, phases, risks, the UI surface, the file
locations — lives in the Claude project *Plotexcel Als vscode Plugin* as
`claude/porting-plan.md`. This file records what the code in this repository
already commits to, and what it learned along the way.

## Settled

- **No R at runtime.** R is used only to produce test oracles (`tools/*.R`).
- **No dependencies in the engine.** The `.xlsx` writer, PNG codec and ZIP
  reader/writer are written directly on `node:zlib`. This began as a
  constraint — no package registry was reachable — and stayed because it is
  better: exact image geometry, no supply chain, nothing to install.
- **Zero-install by default.** PDF and PNG inputs always work. Word,
  PowerPoint, Excel and HTML inputs are enabled only when a converter is
  detected, and produce a placeholder that names the missing tool otherwise.
- **Windows with Microsoft Office and Edge is the target machine**, so the
  Office COM path and Edge are the primary backends; LibreOffice is the
  fallback everywhere else.
- **Marketplace distribution**, publisher `dlill`.
- **Layout files are tab-separated**, named `*.plotexcel.tsv`, with a
  `#key: value` preamble.
- **`<root>/.plotexcel/` holds everything project-scoped**, self-ignoring via a
  one-line `.gitignore`. Intermediates go to `os.tmpdir()/plotexcel/`.
  Machine-specific state (detected tool paths) goes to extension global
  storage, never into the project.
- **Cells are classified without touching the filesystem** — by extension, not
  by `file.exists()`, so a layout behaves the same on every machine.

## Measured, not guessed

- **Images are sized in EMU, at 360000 per centimetre.** Confirmed against a
  workbook the R package produced: a 12.395 cm image carries `cx="4462272"`.
- **Row heights are `cm / 2.54 * 72 * 1.05`.** The same workbook's 9.982 cm row
  is 297.108 points, which matches to the digit — including R's 5% slack.
- **Column widths are `cm * 5.3994`, not R's `cm * 5.3`.** Excel's unit is
  pixels at 96 dpi over a 7-pixel character. R's constant makes a column about
  2% narrower than the image sitting on it; both are available, and
  `widthModel: 'openxlsx'` reproduces R exactly for comparison.
- **A cell's `::resolution` decides its physical size**, for every input format
  including PNG. Found by looking at a rendered workbook: a PNG carrying 300
  dpi metadata came out at a third of the size of the same figure exported as a
  PDF, in the same column.

## Deliberate differences from the R package

- Decorator keys are matched exactly rather than by regex prefix.
- A text cell keeps its `::` unless the trailing segment really is a style.
- Revisions are slugged for the filesystem, so `feature/x` and `HEAD~1` work as
  cache keys and cannot collide.
- Cache directories fold case on Windows and macOS.
- Page counts say how much they can be trusted, rather than guessing silently.
- Nothing in the pipeline throws for a problem the user can fix: it produces an
  image that explains itself, and the workbook still builds.
- Placeholders are never cached, because the reason is usually a fact about the
  machine and would otherwise outlive the fix.
- Cells render several at a time, and a run can be cancelled.
- Each LibreOffice conversion gets its own user profile, so two can run at once.

## Comparisons

- **`::tolerance` and `::context` on a diff cell.** The threshold existed in
  the code and could not be reached from a layout, which made it useless: two
  renders of the same figure differ by anti-aliasing, and a comparison that
  reports that is a comparison nobody trusts.
- **The settings are part of the cache key.** Otherwise a comparison re-run at
  a different tolerance is answered from the cache filled at the old one — and
  that staleness is the kind nobody suspects, because the image looks
  perfectly plausible.
- **A misspelt option is an error, not a shrug.** `::tolerence 0.2` silently
  ignored is a comparison that looks right and is not.
- **The closing bracket is found by walking the string.** Neither the first
  `)` nor the last is correct once decorators exist: a backticked column name
  may contain one — ``diff(`Run (a)`, `Run (b)`)`` — and so may a decorator.
  Found by a test written for exactly that case.

## Speed

- **A renderer hands back PNG bytes, not pixels.** The pipeline was decoding
  every rasterised page to RGBA and encoding it straight back — about 200 ms
  for a page-sized image, whose only effect for an uncropped cell was to
  change the resolution recorded in the file. `retagPngDpi` does that in a
  tenth of a millisecond by replacing a nine-byte chunk, and the pixels are
  decoded only when there is a crop to apply.
- **Measured before it was changed.** 24 pages took 5.7 s through the
  pipeline and 1.0 s through one `pdftoppm` call, so the obvious optimisation
  — batching pages into fewer processes — would have bought half a second of
  the four and a half that were missing. The cost was our own PNG codec.
  Afterwards: 0.89 s, and the sample project — which is mostly diffs — went
  from 1.7 s to 0.8 s.
- **The codec's inner loops were written for clarity and cost accordingly.**
  Decoding allocated a samples array and a closure per pixel — half a million
  of each for a page — and comparing two images allocated five arrays per
  pixel. Both now read and write bytes directly, with a fast path for 8-bit
  RGB and RGBA, which is everything a rasteriser produces. decodePng 65 ms to
  17; diffImages 62 ms to 19. The general paths are still there for the
  unusual bit depths, and the fixtures still cover them.
- **Byte-identical, and checked that way.** The optimised diff was compared
  against a straight reimplementation of the original over three cases; the
  images match exactly. Cached diffs from an older version stay valid.
- **The encoder reuses its buffers.** Choosing a row filter allocated five
  candidate buffers and copied the previous row on every pass; it now writes
  into three scratch buffers, walks bytes by index rather than by iterator,
  and abandons a candidate as soon as it is worse. Half the time, byte-for-byte
  the same output.

## The end-to-end test

- **The sample project is the fixture.** What a new user is shown is also what
  the regression test renders, so neither can rot without the other noticing.
- **A stand-in renderer that encodes the page number into the first pixel.**
  Deterministic, instant, and it lets a test assert that page 3 reached the
  cell that asked for page 3 — not merely that *an* image did. It also means
  the test runs on a machine with no Ghostscript, including a CI runner.
- **The workbook is read back with the project's own ZIP reader.** No openpyxl,
  no Python, nothing to install: the assertions are on the OOXML itself —
  which parts exist, the EMU extents of every image, the height of every row.
- The two bugs that ever reached a rendered workbook were a PNG sized by its
  own metadata rather than the cell's resolution, and a row too short for its
  image. Both are now assertions.

## Testing the extension

- **The stub is a checked-in file, not a generated string.** It can be read,
  reviewed and improved like any other source, and it records what it was
  asked to do so a test can then ask what happened.
- **It exports each name explicitly rather than through a Proxy.** The
  extension does `import * as vscode`, and Node builds that namespace by
  statically scanning the CommonJS file for export assignments — a Proxy is
  invisible to that scan and every property comes back `undefined`, which
  looks exactly like the extension being broken. Cost us an hour; written
  down so it costs nobody else one.
- **Anything the stub has not been taught is `undefined`, deliberately.** A
  forgiving proxy would let a test pass by doing nothing, which is worse than
  no test. Instead a test reads the extension sources for `vscode.X` and fails
  naming what is missing.
- **The manifest tests need no stub and no host.** `package.json` is the half
  of an extension a typechecker cannot see: a menu pointing at a deleted
  command, a setting read under a different name, a walkthrough linking to a
  renamed file. None of those fail to build and all of them fail in front of a
  user. Both failures were confirmed by breaking the manifest on purpose and
  watching the tests catch it.

## Teaching it

- **The sample project is generated, not shipped.** Four plots and a layout,
  built by code that lives beside the code it demonstrates, so the two cannot
  drift. Fixtures would need maintaining; this needs nothing.
- **The sample plots are PDFs on purpose.** An image sample would prove
  nothing about the rasteriser, which is the part most likely to be missing on
  a given machine. If the sample renders, that machine can render anything —
  which makes "open the sample" the most useful diagnostic in the extension,
  as well as its first lesson.
- **The PDF is written by hand**, with its own cross-reference table. A test
  checks that every offset in that table lands exactly on its object header,
  because that is the mistake a reader will not forgive and the one that would
  otherwise be found by a user.
- **The walkthrough steps tick themselves off.** Each carries a
  `completionEvent` naming the command it describes, so doing the thing marks
  the step — rather than the list sitting there unchanged while someone works
  through it.

## Releasing

- **The `.vsix` on GitHub Releases is a first-class route, not a stopgap.** It
  needs no Marketplace account, works offline, and is how the extension can be
  handed to one colleague. What it does not do is update itself, which is the
  honest trade and is said plainly in the README.
- **The tag starts the build; the manifest owns the version.** A tag that
  disagrees with `packages/extension/package.json` fails the workflow before
  anything is built, because the alternative is a file whose name contradicts
  the release it hangs under.
- **The release notes are the changelog section.** One place a change gets
  written down. A version with no section fails the release rather than
  publishing a file with no explanation.
- **Two copies of the same file are attached**: `plotexcel-0.1.0.vsix` and
  `plotexcel.vsix`. The second gives
  `releases/latest/download/plotexcel.vsix` — an install command that can go
  in the README and never goes stale.
- **Nothing builds on a commit.** Tests run on a pull request, on a version
  tag, or on demand; the package is built on a tag and nothing else. A solo
  project where every commit to `main` triggers a five-minute matrix build
  teaches its author to ignore the badge, which is worse than not having one.
  The safety net is that the release workflow runs the suite before it
  packages: a tag with failing tests produces no `.vsix`.
- **`gh` rather than a third-party action.** It is already on the runner, and
  a release workflow is not the place to take a supply-chain dependency.

## The cache

- **1 GB, pruned oldest-first after every render.** The cache lives where
  nothing reliably cleans it, so the extension has to: Windows does not empty
  `%TEMP%` on reboot, and closing the editor does nothing at all.
- **It says when it is filling up.** At 80% of the limit, once per window,
  with `Clear Cache` in the notification — because a cache that quietly holds
  a gigabyte of someone's disk should be their decision, and the command is
  no use if it has to be found first. Once per window rather than once per
  render: a size-capped cache sits near its limit at steady state, so the
  obvious wiring would fire the notice every single time.
- **Dismissing it is a setting, not a memory.** `cacheWarnAtPercent: 0` turns
  it off for good, which is honest about what "don't tell me again" means.

## The browser build

- **The page is a way in, not a second implementation.** It shares the layout
  format, the styles, the geometry and the OOXML writer with the extension.
  Only the platform seam differs, and it is small enough to name: a ZIP writer
  that stores instead of deflating, and canvas placeholders where the extension
  would call a PDF renderer.
- **The seam was made by splitting `writeWorkbook.ts`.** Everything that
  decides what a workbook contains moved to `workbookParts.ts`, which imports
  nothing but arithmetic; `writeWorkbook.ts` is now the four lines that call
  `node:zlib`. A browser importing the first gets no Node builtins at all — a
  property worth a test, since a single stray import breaks the page and
  nothing else.
- **Verified from `file://`.** The bundled file was opened from disk in
  Chromium with no server running, given a folder, and its workbook read back
  by openpyxl: a 600x400 PNG at 150 dpi came out 10.16 x 6.77 cm, which is
  exactly right.
- **No bundler.** `tools/bundle-browser.mjs` inlines the module graph by
  ordering it and giving each module its own scope. The graph is acyclic and
  uses only named imports and exports, which is what makes 90 lines enough.
- **Firefox and Safari get a notice, not a fallback.** Without the File System
  Access API the workbook could only arrive in Downloads, which is the one
  thing the page exists to avoid.

## Comparing against a revision

- **Right-click reaches it directly.** The command already preferred a passed
  URI over the stored selection, so only the menu's `when` stood in the way: it
  demanded a selection *and* `selectionInRepository`, which meant the two-step
  select-then-compare dance for something that needs one resource. It is now
  offered on any plot or folder, and says so itself when there is no history.
- **That made `selectionInRepository` dead, and it took a subprocess with it.**
  Nothing consumed the key any more, and the only thing that set it was a
  `git ls-files` on every single selection — a process started to decide
  whether to grey out a menu entry that now handles the answer itself.
- **A folder's second side comes from `git ls-tree`.** Only the working tree is
  on disk, so pairing by path needs the revision's file list from git. Core
  cannot run git, so the caller passes `commitFiles` in, the same seam that
  keeps the pipeline testable without Ghostscript. `listFiles` answers
  undefined rather than `[]` when there is no repository: "empty then" and "no
  history at all" produce very different tables, and conflating them would show
  every plot as newly added.
- **Pages are counted from the working tree.** The revision's copy is not a
  file, so a plot deleted since falls back to one page. It is the one place
  this table guesses, and the row still appears — which is the point.

## The right-click menu

- **One submenu, not nine entries.** The Explorer entries used the Explorer's
  own groups — `2_workspace`, `3_compare`, `6_copypath`, `7_modification` —
  which is idiomatic and was the wrong call: it scattered them among VS Code's
  commands with separators in between, so Select for Visual Diff was nowhere
  near Generate Table Layout and nothing marked either as ours. They are now
  one `plotexcel.explorer` submenu labelled **plotExcel**, and the grouping
  inside it is the order someone works in: look, build a layout, compare,
  render.
- **The child entries dropped `plotexcel.supported`.** The submenu itself
  carries it, and a check repeated on every child is a check that can
  disagree with itself later.

## Where the workbook lands

- **Windows workbooks carry a timestamp.** Excel takes an exclusive lock on an
  open workbook, so a second render fails on the write — at the very end, after
  every page has been rasterised. `figures-20260831-140509.xlsx` costs a
  tidy-up later and saves losing the work now. Nothing locks the file on macOS
  or Linux, so they keep the clean name.
- **Only a name we chose.** `#output:` in the layout, and `--out` on the
  command line, are answers to "call it this" and are left exactly as written
  on every platform.
- **The stamp is not hidden inside `resolveOutputPath`.** That function is also
  how "Open the Workbook" works out where to look, and a name containing the
  current time would never be found twice — it would report "not rendered yet"
  after every successful render. It stays deterministic; the writers apply
  `timestampedWorkbookPath`, and the opener searches with
  `workbookNamePattern` and takes the newest. The stamp sorts as text in time
  order, which is what makes "newest" a string comparison rather than a stat.

## Hostile input

The extension opens whatever a folder contains and runs converters over it, so
these three are about what a repository can make this machine do simply by
being opened.

- **Workspace trust is enforced in `machine()`, not in the commands.** The
  manifest had always claimed rendering stayed disabled until a workspace was
  trusted, but nothing implemented it: `untrustedWorkspaces: limited` activates
  the extension fully and expects it to restrain itself. The gate went into the
  one place tools are assembled rather than into each command, so a command
  added later that forgets to ask still comes away with an empty `Tools`. It
  sits *before* detection, because finding the tools already means walking the
  `PATH` and running `gs --version`.
- **`browserPath` is machine-scoped.** A setting that names a program is a way
  to run that program, and at the default `window` scope any repository could
  ship a `.vscode/settings.json` pointing it at a script in its own tree. It is
  also listed in `restrictedConfigurations`, which is redundant on purpose:
  the scope stops it being set, the restriction stops it being honoured.
  `selectForDiff` was the one path that started git outside `machine()`; it now
  skips the tracked-file check rather than interrupting a selection with a
  prompt.
- **Both inflate calls are bounded.** A PNG's IHDR and a ZIP's central
  directory each describe how large the decompressed data should be, which
  makes the bound exact and free: `maxOutputLength` is set from the file's own
  promise, and a stream that exceeds it is a bomb rather than an image. The
  PNG decoder also caps dimensions at 100 megapixels, because the header is
  eight bytes that can ask for a 64 GB allocation on their own — A3 at 600 dpi
  is about 70, so nothing the pipeline can legitimately produce comes close.

## MuPDF ships with the extension

Settled after a first run on a real Windows machine, where **Check my setup**
reported no PDF renderer at all: no Ghostscript, no poppler, and no way to get
either without a request to a team that manages the machine. Everything else
that machine needed — Office, a Chromium browser, git — was already there. So
the one capability that is the whole point of the extension was the one
capability a locked-down laptop could not have, and telling a colleague to file
a ticket before they can open a sample is not an installation instruction.

- **MuPDF is a `devDependency`, not a dependency.** Its files are *copied* into
  `dist/mupdf/` at package time by `tools/copy-mupdf.mjs`; nothing
  `require`s the package at run time. So `dependencies` stays empty, `vsce
  package --no-dependencies` stays correct, and the no-runtime-dependencies rule
  survives in the form that matters — the extension is still a bundle plus
  assets, with no `node_modules` in the `.vsix`.
- **It cannot go through esbuild.** The package is ESM-only and its Emscripten
  glue locates `mupdf-wasm.wasm` with `new URL('mupdf-wasm.wasm',
  import.meta.url)`. Flattening that into a CommonJS bundle breaks the module
  format and the asset lookup at once. It travels as files and is loaded by a
  real dynamic `import()` of a `file://` URL.
- **The import goes through `new Function`.** esbuild rewrites any dynamic
  `import()` it can see into a `require()` when the output is CJS, and
  `require()` cannot load ESM that resolves its own assets. `new Function` is
  opaque to the bundler, so a genuine dynamic import reaches Node. This is the
  one place in the repository that hides something from a tool on purpose.
- **Activation passes the path, rather than the renderer finding it.** Only the
  host knows where the extension was installed, and `__dirname` in a bundle
  versus `import.meta.url` in a type-stripped source are different answers to
  the same question. `useBundledMupdf()` is called once in `activate` with
  `context.extensionUri`; the CLI passes nothing and MuPDF resolves from
  `node_modules` if it is installed at all.
- **The wasm is 10 MB, and that is the price.** It compresses to roughly a third
  inside the `.vsix`, which is a zip. The `.br` copies in the package are for a
  web server that can serve pre-compressed responses and are no use here. A
  build with the copy step skipped installs and activates perfectly and then
  renders a placeholder for every PDF, so the packaging workflow fails if the
  wasm is not in the archive.
- **A generated `package.json` sits beside it.** Just `{"type":"module"}`. The
  nearest manifest above `dist/mupdf/` would otherwise be the extension's own,
  which has no `type`, so Node parses `mupdf.js` as CommonJS, fails, warns and
  reparses — putting `MODULE_TYPELESS_PACKAGE_JSON` in the host log every time.
- **MuPDF's licence text ships beside it.** AGPL requires it travel with the
  binary. The project was already AGPL-3.0-or-later, so this decides nothing it
  had not already decided.

## The convert stage got its cache, and HTML got real page counts

Two bugs reported from the first real use, with one cause between them.

- **The Explorer menu needed the extension to be running already.** It and the
  tree view were gated on `plotexcel.supported`, which activation set at the
  *end* of `activate()`. Nothing activates the extension while somebody browses
  the Explorer, so the key did not exist and the menu stayed hidden — until an
  unrelated command woke it up, after which it worked for the rest of the
  session. Reported as "the right-click options only appear once I have run
  Check My Setup". The key only ever meant "a folder is open", which VS Code
  answers itself with `workspaceFolderCount != 0`, so the menus ask VS Code and
  the key is gone. A test asserts the Explorer menu and the views gate on
  nothing a `plotexcel.*` key could provide.
- **HTML plots only ever rendered page 1.** Not a rendering bug: `::page 3` of
  an HTML file always worked. `countPages` reads a file's own structure, and an
  HTML file has no pages until a browser lays it out, so it answered 1 and every
  generated layout asked for one page. Counting for real means converting, which
  is async and needs a browser, and `core` may not reach `tools` — so the
  counter is injected. `PageCounter` is a parameter of all three generate
  functions; `countSourcePages` is the implementation the extension and the CLI
  pass in.
- **`paths.converted` existed for months and was never written.** `renderPlot`
  used only `paths.source` and `paths.cropped`, converting in memory and
  discarding the PDF, so six pages of one HTML plot meant six Chromium launches
  producing six identical PDFs — despite the file's own docstring promising that
  "a stage whose output is already current does nothing". Implementing it is
  what makes counting affordable: `converted` is keyed on the file, its folder
  and its revision and deliberately not on the page or the resolution, so one
  conversion serves every page and every dpi. Counting a folder's HTML files
  while generating a layout leaves the render with nothing to convert —
  measured at six pages in 0.4 s with no browser started, against roughly
  thirty seconds before.
- **Conversions are deduplicated in flight as well as cached on disk.** The
  pages of one file render concurrently, so without it they all miss the cache
  in the same instant and convert the same document at once. The `get` and `set`
  on the in-flight map are not separated by an `await`, which is what makes them
  atomic. Cold render of three pages went from 5.5 s to 2.3 s, byte-identical
  output.
- **Generating a layout is now cancellable.** It can start a browser per file,
  so it reports which file it is on and can be stopped. Cancelling does not
  abandon the layout: the files not yet counted fall back to what their own
  structure says. A short layout is a nuisance, and an editable one.

## Laying plots out in columns

Every way of building a layout grew it downwards: **Generate Table Layout**
emits one row per page in a single column, **Add to Layout** appends rows. The
only thing producing columns side by side was the compare family, and it takes
exactly two sides and always adds a difference column — the wrong tool for four
folders that are one run each.

- **`generateSideBySide` takes any number of sources and adds no difference
  column.** A difference is defined between a pair, so generalising
  `generateComparison` to *n* sides would have meant deciding which pair the
  diff compares. Comparing two things is what Compare is for; this is for
  reading three or four of them against each other. Anyone who wants a diff on
  top has **Add a Comparison Column**.
- **Files or folders, told rather than discovered.** `core` classifies nothing
  by touching the filesystem — `classify.ts` decides by extension alone — and
  the caller has already stat'ed the selection to know which menu entry
  applied, so `kind` is a parameter. It also removes the case nobody wants: a
  layout of files beside folders.
- **A folder's pages are counted once, from the first folder that has the
  file.** Counting each side puts the same file on rows of different heights
  when two copies disagree, which reads as a rendering fault rather than as a
  difference. The pairing is by the path inside each folder, as
  `generateFolderComparison` already does, and a file only some folders have
  still gets a row: dropping it is how a plot that stopped being produced goes
  unnoticed.
- **`distinctLabels` grows a colliding name leftwards.** Column names have to
  be unique — `parseLayout` reports a repeat as an error, and a diff cell names
  a column — but the name anyone would pick is the basename, and
  `run-1/plots.pdf` and `run-2/plots.pdf` share it. Only the names that collide
  grow, so the table stays readable, and a `(2)` suffix catches what growing
  cannot separate.
- **A new column fills in row order, not by matching page numbers.** Page 1
  goes in the first data row, page 2 in the second; a file longer than the
  table extends it, a shorter one leaves the tail of its column empty. Reading
  the `::page` of each row and matching it would be cleverer and would break
  the first time a row was cropped, renumbered or sorted — which is most of
  what the editing commands are for.
- **Add to Layout as New Column takes files only.** A folder as a column would
  have to pair against the existing rows on their descriptions, which the user
  is free to have rewritten. A folder goes through Lay Out Side by Side, where
  the pairing is on paths that are still paths.
- **Add to Layout became Add to Layout Below.** With a column command beside
  it, "add to layout" no longer says where. The command id stayed
  `plotexcel.addToLayout`: nothing keybinds it, and renaming an id for a title
  change buys nothing.

## What the first real-host session found

Two reports, both of them the extension doing something reasonable in silence.

- **`nPagesMax` was 4, and nothing said so.** A seven-page HTML plot generated
  four rows. The count was right — `countSourcePages` converts and counts the
  real PDF — and the cap did exactly what it was written to do. It was chosen
  when an HTML page count was always a guess of 1, so a low cap cost nothing;
  once the counts became real it silently discarded most of a report. The
  default is 25, and `GeneratedLayout` now carries `truncated` beside
  `uncertain` so that every caller can say "4 of 7". `DiscoveredFile` already
  held both numbers; nobody was reading them.
- **The notice offers to do it again rather than only pointing at a setting.**
  Regenerating with no cap is affordable precisely because of the convert cache:
  it is keyed independently of the page and the resolution, so the second pass
  re-reads the PDF the first pass made instead of starting a browser again. The
  button that opens the setting is there as well, because the same person will
  generate a second layout tomorrow.
- **The cap warning fires from the editing commands too, without the re-take
  button.** Add to Layout Below, Add to Layout as New Column, Insert Plot and
  drag-and-drop all cap the same way. There the layout is one being edited by
  hand, so silently rewriting it is not on offer — the message and the setting
  are.
- **`.plotexcel` "needing administrator permission" is a lock, not an ACL.**
  Nothing here sets permissions: everything under the folder is written through
  `vscode.workspace.fs`, every converter profile and scratch directory is under
  `os.tmpdir()`, and no child process is given a `cwd` inside the workspace.
  What holds it is Excel — `openAfterRender` opens the workbook, Excel takes an
  exclusive lock and writes a hidden `~$` file beside it, and Explorer deleting
  a tree with a locked Office file in it reports the wrong reason. The fix is
  therefore not a fix to the writing: it is Clean Up the Project Folder, which
  deletes file by file and names what is stuck.
- **File by file, not one recursive delete.** A recursive delete fails as a
  whole and names nothing, and the name of the file that is stuck is the only
  useful part of the answer. A `~$plots.xlsx` is reported as `plots.xlsx`,
  because nobody recognises the lock file's name.
- **Workbooks and layouts are separate answers.** Workbooks come back from one
  render; a layout under `layouts/` was generated and then edited by hand, so
  deleting it cannot be the default button.
- **`logs/` is gone.** `ensureProjectFolder` created it on every setup and
  nothing ever wrote to it — the log is a `LogOutputChannel`. The README and
  this file both claimed otherwise.
- **One temp folder, `<temp>/plotexcel`, with everything under it.** The cache
  lived there, but every other temporary directory took `os.tmpdir()` straight
  with a `mkdtemp` prefix — `plotexcel-gen-`, `plotexcel-tools-`,
  `plotexcel-vsix-`, one per converter run and one per test. Only the
  converters cleaned up, so a machine that had run the test suite for a week
  held 384 sibling folders that Clear Cache neither counted nor removed,
  because it only ever looked inside the cache. Now: `cache/` for
  intermediates, `scratch/` for working directories, `test/` for fixtures.
- **Measuring and clearing cover the whole root; pruning covers `cache/`
  alone.** The number has to match what someone sees in `%TEMP%`, so
  `cacheStats` walks everything. The automatic size-capped prune runs on its
  own and must not delete a directory a converter is holding open, so it is
  confined to the part that is keyed on its inputs and safe to drop at any
  moment. That is the whole reason the cache moved down a level instead of
  staying at the root.
- **Clearing also sweeps the old `plotexcel-*` siblings**, so a machine that
  ran an earlier version gets tidied once by the button that was already there.
  Only when clearing the real root: given an explicit one — which is what every
  test does — its siblings belong to somebody else. There is a test for that
  distinction, because getting it wrong deletes a caller's data.
- **`PLOTEXCEL_TEMP_ROOT` exists for the test suite.** `cache --clear` is
  tested by running it as a process, and it empties whatever the root resolves
  to. Pointed at the machine's own root it deleted the fixtures of every test
  file running beside it — which is how this was found: two unrelated suites
  failed with ENOENT and "not a git repository". Each test process now gets a
  root of its own, and the CLI subprocess inherits it.

## Still open

- **The diff image.** It fades unchanged content, marks changes red and marks
  area covered by only one side amber. It does not imitate ImageMagick's
  composite, and it has not been reviewed by anyone but its author.
- **`packages/extension` has now been run once**, from a `.vsix` on a Windows
  machine: it activated, registered, wrote a comparison layout and rendered a
  workbook. That is one machine, one session, and no automated coverage — the
  suite still runs it against a stub.
- **The browser page has no PDF renderer.** MuPDF now ships for the extension,
  and the same WebAssembly build would give the page real PDF pages and remove
  its largest caveat. What stops it is that the page loads the core as ES
  modules from source, so the 10 MB wasm would be a fetch rather than a file,
  and `packages/browser` must reach no `node:` builtin.
