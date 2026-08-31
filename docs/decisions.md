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

## Still open

- **PDF renderer.** MuPDF (AGPL, and so decides this repository's licence) or a
  PDFium binding (permissive, more work). Ghostscript and poppler already work
  as fallbacks, so this is no longer blocking.
- **The diff image.** It fades unchanged content, marks changes red and marks
  area covered by only one side amber. It does not imitate ImageMagick's
  composite, and it has not been reviewed by anyone but its author.
- **Everything in `packages/extension`** — written, loads, never compiled or
  run. It needs `@types/vscode` and an extension host.
- **The browser page has no PDF renderer.** If MuPDF is ever compiled to
  WebAssembly for the extension, the same build would give the page real PDF
  pages and remove its largest caveat.
