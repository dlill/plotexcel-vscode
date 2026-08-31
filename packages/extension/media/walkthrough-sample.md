## What the sample contains

A folder called `plotexcel-sample`, four plots, and a layout:

| Row | This run | Previous run | Change |
|---|---|---|---|
| Model fit | page 1 | page 1 | a visual diff |
| Residuals | page 2 | page 2 | a visual diff |
| Convergence, right half | page 3, cropped | page 3, cropped | a visual diff |
| Sensitivity | one page | | |
| Raw scatter | a PNG | | |

Five rows, eleven images, and it renders in about two seconds.

## Why it is worth two minutes

Everything in the layout is something you will want later, sitting there
already working: `::page 2` to take one page out of a document, `::xmin 50`
to keep the right-hand half, `::vcenter` to place a caption, and
``diff(`This run`, `Previous run`)`` to put the difference between two
columns in a third.

Change a number and render again. Only what you changed is redone.

## And it answers the setup question

The sample plots are real PDFs, not images. If the workbook comes out with
pictures in it rather than grey notes, this computer can render anything
plotExcel handles.
