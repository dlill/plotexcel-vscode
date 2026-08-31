## Generate, then edit

Right-click a folder in the Explorer and choose **Generate Table Layout**.

plotExcel walks the folder, works out how many pages each file has, and writes
a table with one row per page:

```
Description                  Plot
figs / 01-Iris.pdf, page 1   figs/01-Iris.pdf::page 1::resolution 150
figs / 01-Iris.pdf, page 2   figs/01-Iris.pdf::page 2::resolution 150
```

Nothing is rendered yet. The table is the thing you edit.
