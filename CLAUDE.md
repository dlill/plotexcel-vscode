# Working on plotexcel-vscode

A VS Code extension that arranges plots — PDF, PNG, Word, PowerPoint, HTML —
into an Excel workbook. A port of the R package
[plotExcel](https://github.com/dlill/plotExcel) that does not require R.

Read `docs/architecture.md` for the module map and `docs/decisions.md` for
what is settled and why. This file is the rules.

## The one rule that shapes everything

**No runtime dependencies. None.** The `.xlsx` writer, the ZIP writer, the PNG
codec, the bitmap font and the PDF page counter are all written here, on top of
`node:zlib` and nothing else. `packages/extension/package.json` has
`devDependencies` only — esbuild, vsce, typescript, types, and MuPDF.

MuPDF is the one thing that came from outside, and it is still a
`devDependency`: `tools/copy-mupdf.mjs` copies its files into `dist/mupdf/` at
package time, so nothing `require`s the package at run time and no
`node_modules` goes into the `.vsix`. Read the MuPDF section of
`docs/decisions.md` before touching any of it — the loading is deliberately
odd, and the reasons are not guessable.

This is not asceticism. It buys exact image geometry in EMU (a library's pixel
rounding was the thing most likely to break fidelity with the R package), an
extension that is one small bundled file, and a core that runs unchanged in a
browser. Before adding a package, assume the answer is no and look for the
fifty lines that would do it.

Devtools are a different matter — a linter or a test helper is fine to propose,
but say so rather than adding it silently.

## Running things

```
npm install            # devtools only; the code itself needs nothing
npm run verify         # everything below, in order — use this before saying done
npm test               # 295 tests, no VS Code, no build step
npm run test:core      # the fast subset, ~3 s
npm run typecheck      # tsc per package; nothing is emitted
npm run check:extension  # the extension package, against a vscode stub
npm run demo -- render <layout>   # the CLI, which is the core without an editor
```

There is **no build step for development**. Node 22.18+ strips TypeScript types
itself, so tests and the CLI run the `.ts` sources directly. esbuild is used
once, at packaging time, to bundle the extension.

## Things that will bite

- **Node's type stripping is not a compiler.** It erases types; it cannot emit
  anything. So: no parameter properties (`constructor(private x: string)`), no
  enums, no namespaces, no decorators. `SpecError` is written the long way for
  exactly this reason.
- **Imports carry the `.ts` extension**, including across packages
  (`../../core/src/units.ts`). That is what makes both Node and esbuild resolve
  them without configuration.
- **`node --test "glob"` needs the quotes.** A bare directory is treated as a
  file and silently runs nothing.
- **Never write a literal control character into a source file.** Use the
  escape (``). Two files were corrupted this way early on.
- **`packages/core` must never import `vscode`**, and must never import a
  `node:` builtin from anything the browser build reaches — a test walks that
  graph and fails on the first one, because in a browser the failure is silent
  and the page just renders empty.
- **`packages/extension` cannot be run in a real host here**, but it *is*
  tested. `packages/extension/test/` activates it against a checked-in stub
  (`test/vscode.cjs`) and compares what it registers with what `package.json`
  declares. If you add a command, a menu, a setting or a walkthrough step, the
  tests will tell you what you forgot. If you use a VS Code API the stub does
  not have, a test fails naming it — add it to the stub, explicitly, because
  the namespace is built by a static scan and a Proxy is invisible to it.

## Where things go

| Adding | Goes in |
|---|---|
| Layout syntax, geometry, OOXML, images, cache keys | `packages/core` |
| Anything that spawns a process or touches an external tool | `packages/tools` |
| A command, menu, setting, or editor feature | `packages/extension` |
| A flag on the command line | `packages/cli` |
| Anything the browser page needs | `packages/browser` |

`core` knows nothing about `tools`; it receives a `Tools` object through
`pipeline/ports.ts`. That seam is what lets the pipeline be tested without
Ghostscript, and what lets the browser build exist at all. Keep it.

## Conventions

- **British spelling in prose**, including comments and messages. `colour` in
  prose, `color` in anything that is an OOXML or CSS name.
- **Comments say why, not what.** A comment that restates the line below it is
  noise; a comment explaining a non-obvious decision, a workaround, or the
  reason a simpler approach fails is worth keeping. The existing code is the
  reference for the register — read a file before adding to it.
- **Errors carry a fix.** `SpecError` takes a `hint`; use it. Nothing in the
  pipeline throws for a problem the user could fix: it produces a placeholder
  image saying what is wrong, and the workbook still builds.
- **Tests name behaviour, not functions.** `'takes the style from the last ::
  only when it is a real style'`, not `'parseTextSpec works'`.
- Two-space indent, single quotes, semicolons, trailing commas. There is no
  formatter configured; match the file you are in.

## The layout format

A `.plotexcel.tsv` is tab-separated. `#key: value` lines at the top are
options; the first non-comment row is column names; the rest are cells.

A cell is a path or caption followed by `::decorator value` pairs:

```
Baseline::vcenter	figs/fit.pdf::page 2::xmin 10::xmax 90	diff(`A`, `B`)
```

Decorators: `page`, `resolution`, `xmin`/`xmax`/`ymin`/`ymax` (percentages),
`commit`, plus the ten style names from the R package. A diff cell takes
`tolerance` and `context` instead. Keys match **exactly** — the R package
matched by regex prefix, and that is a deliberate difference.

## Deliberate differences from the R package

Listed in full at the end of `docs/decisions.md`. The ones that catch people:
decorator keys match exactly; a text cell keeps its `::` unless the trailing
segment really is a style name; a cell's `::resolution` decides physical size
for every format, including PNGs that carry their own dpi metadata.

## State of things

- 295 tests passing across every package, plus six that skip when Ghostscript,
  poppler or LibreOffice is not installed.
- `packages/extension` is activated in the tests against a stub, and checked
  against its own manifest — but **never run in a real extension host.**
- `packages/cli`: tested by running it as a process and reading the output.
- The GitHub workflows have never run.
- MuPDF ships with the extension, so PDF rendering needs nothing installed. It
  is tried first; Ghostscript and Poppler are still detected and still answer
  when it is absent, which is the case for the CLI run from a fresh clone.
- The extension has been installed from a `.vsix` and run in a real host once,
  on Windows. It activated and rendered. That is one machine and one session.

When you finish something, add a line to `docs/decisions.md` if a decision was
made, and to `packages/extension/CHANGELOG.md` if a user would notice.
