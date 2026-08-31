## The table is a plain file

Columns are separated by tabs. Rows can be deleted, reordered and rewritten.

| To do this | Write this |
|---|---|
| Take page 2 | `plot.pdf::page 2` |
| Keep the left 85% | `plot.pdf::xmax 85` |
| Render at 300 dpi | `plot.pdf::resolution 300` |
| Use last week's version | `plot.pdf::commit HEAD~1` |
| Caption a row | `Baseline model::vcenter` |
| Compare two columns | `diff(Current, Baseline)` |
| Ignore anti-aliasing | `diff(Current, Baseline)::tolerance 0.3` |

Type `::` in any cell to see the options, and hover a cell to check which file
it points at.
