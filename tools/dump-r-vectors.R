#!/usr/bin/env Rscript
#
# Dump the R package's parser behaviour as test vectors for the TypeScript port.
#
# Run this once, from anywhere, with plotExcel installed:
#
#     Rscript tools/dump-r-vectors.R
#
# It writes two files next to itself:
#
#   r-vectors.json  parse results for a list of spec strings, plus the file
#                   names epFiles() derives from them
#   r-styles.txt    the printed style definitions, to check against styles.ts
#
# No packages beyond plotExcel are needed; the JSON is written by hand so this
# runs on a machine without jsonlite.

library(plotExcel)

outDir <- tryCatch(dirname(sys.frame(1)$ofile), error = function(e) ".")
if (is.null(outDir) || is.na(outDir)) outDir <- "."

# ------------------------------------------------------------------------- #
# Minimal JSON writer ----
# ------------------------------------------------------------------------- #

jsonEscape <- function(x) {
  x <- gsub("\\\\", "\\\\\\\\", x)
  x <- gsub("\"", "\\\\\"", x)
  x <- gsub("\n", "\\\\n", x)
  x <- gsub("\t", "\\\\t", x)
  x
}

jsonValue <- function(x) {
  if (is.null(x))            return("null")
  if (length(x) != 1)        return(paste0("[", paste(vapply(x, jsonValue, ""), collapse = ", "), "]"))
  if (is.logical(x))         return(if (isTRUE(x)) "true" else "false")
  if (is.numeric(x))         return(format(x, scientific = FALSE, trim = TRUE))
  paste0("\"", jsonEscape(as.character(x)), "\"")
}

jsonObject <- function(l) {
  paste0("{", paste(sprintf("\"%s\": %s", jsonEscape(names(l)), vapply(l, jsonValue, "")), collapse = ", "), "}")
}

# ------------------------------------------------------------------------- #
# The cases ----
# ------------------------------------------------------------------------- #
# Add anything you have ever typed into a real layout table here: the port is
# checked against whatever this file says, so the more real cases the better.

plotCases <- c(
  "figs/01-Iris.pdf",
  "figs/01-Iris.pdf::page 2",
  "figs/01-Iris.pdf::page 2::resolution 150",
  "figs/01-Iris.pdf::xmax 85",
  "figs/01-Iris.pdf::xmin 10::xmax 90::ymin 5::ymax 95",
  "figs/01-Iris.pdf::commit HEAD~1",
  "figs/01-Iris.pdf::commit a1b2c3d::page 3::resolution 300",
  "figs/sub folder/01 Iris.pdf::page 2",
  "C:/Projects/plots/01-Iris.pdf::page 2",
  "figs/slides.pptx::page 4",
  "figs/report.docx",
  "figs/page.html",
  "figs/figure.png"
)

textCases <- c(
  "Iris",
  "Iris::2",
  "Iris::vcenter",
  "Iris::rotateUp",
  "figs / 01-Iris.pdf, page 2::vcenter",
  "Ratio A::B over time",
  "Ratio A::B::center",
  "Iris::99",
  ""
)

# ------------------------------------------------------------------------- #
# Collect ----
# ------------------------------------------------------------------------- #

capture <- function(expr) {
  tryCatch(list(ok = TRUE, value = expr), error = function(e) list(ok = FALSE, value = conditionMessage(e)))
}

plotRecords <- lapply(plotCases, function(case) {
  parsed <- capture(parsePlotSpec(case))
  if (!parsed$ok) {
    return(jsonObject(list(input = case, ok = FALSE, error = parsed$value)))
  }
  spec <- parsed$value
  # epFiles() is internal; it derives the pipeline's intermediate file names.
  files <- capture(do.call(plotExcel:::epFiles, spec))
  fileNames <- if (files$ok) vapply(files$value, basename, "") else c(error = files$value)

  jsonObject(c(
    list(input = case, ok = TRUE),
    spec[c("path", "commit", "page", "xmin", "xmax", "ymin", "ymax", "resolution")],
    list(files = paste(names(fileNames), unname(fileNames), sep = "=", collapse = " | "))
  ))
})

textRecords <- lapply(textCases, function(case) {
  parsed <- capture(parseTextSpec(case))
  if (!parsed$ok) return(jsonObject(list(input = case, ok = FALSE, error = parsed$value)))
  jsonObject(list(input = case, ok = TRUE, text = parsed$value$text, style = parsed$value$style))
})

json <- paste0(
  "{\n  \"generatedBy\": \"tools/dump-r-vectors.R\",\n",
  "  \"packageVersion\": ", jsonValue(as.character(utils::packageVersion("plotExcel"))), ",\n",
  "  \"plotSpecs\": [\n    ", paste(unlist(plotRecords), collapse = ",\n    "), "\n  ],\n",
  "  \"textSpecs\": [\n    ", paste(unlist(textRecords), collapse = ",\n    "), "\n  ]\n}\n"
)

writeLines(json, file.path(outDir, "r-vectors.json"))

styles <- plotExcel:::styleList
styleText <- unlist(lapply(names(styles), function(name) {
  c(paste0("== ", name, " =="), utils::capture.output(print(styles[[name]])), "")
}))
writeLines(styleText, file.path(outDir, "r-styles.txt"))

message("Wrote r-vectors.json and r-styles.txt to ", normalizePath(outDir))
