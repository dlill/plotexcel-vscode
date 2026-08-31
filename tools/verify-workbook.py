#!/usr/bin/env python3
"""Open a workbook with openpyxl and report what an independent reader sees.

    python3 tools/verify-workbook.py [path.xlsx]

The writer in packages/core/src/xlsx is hand-rolled OOXML. This script is the
check that it produces a file something other than itself can read: openpyxl
parses the parts, resolves the styles, and finds the embedded images. It exits
non-zero if anything essential is missing.
"""

from __future__ import annotations

import sys
import zipfile

try:
    import openpyxl
except ImportError:  # pragma: no cover - depends on the machine
    sys.exit("openpyxl is not installed: pip install openpyxl")

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/plotexcel-sample.xlsx"
problems: list[str] = []

with zipfile.ZipFile(path) as archive:
    damaged = archive.testzip()
    if damaged is not None:
        problems.append(f"corrupt archive member: {damaged}")
    print(f"archive: {len(archive.namelist())} parts")
    for name in sorted(archive.namelist()):
        print(f"  {name} ({archive.getinfo(name).file_size} bytes)")

book = openpyxl.load_workbook(path)
sheet = book.active
print(f"\nsheet: {sheet.title!r}  dimensions {sheet.dimensions}")
print(f"freeze panes: {sheet.freeze_panes}")
print(f"fit to page: {sheet.sheet_properties.pageSetUpPr and sheet.sheet_properties.pageSetUpPr.fitToPage}")
print(f"paper size: {sheet.page_setup.paperSize}  orientation: {sheet.page_setup.orientation}")

print("\ncolumn widths:")
for letter, dimension in sorted(sheet.column_dimensions.items()):
    print(f"  {letter}: {dimension.width:.4f} chars  ~ {dimension.width * 7 / 96 * 2.54:.2f} cm")

print("\nrow heights:")
for index, dimension in sorted(sheet.row_dimensions.items()):
    if dimension.height is not None:
        print(f"  {index}: {dimension.height:.2f} pt  ~ {dimension.height / 72 * 2.54:.2f} cm")

print("\ncells:")
for row in sheet.iter_rows():
    for cell in row:
        if cell.value is None:
            continue
        alignment = cell.alignment
        font = cell.font
        print(
            f"  {cell.coordinate}: {cell.value!r} "
            f"[{type(cell.value).__name__}] font={font.size}{'/bold' if font.bold else ''} "
            f"align={alignment.horizontal}/{alignment.vertical} wrap={alignment.wrap_text} "
            f"rotation={alignment.text_rotation} border={'yes' if cell.border.left.style else 'no'}"
        )

images = getattr(sheet, "_images", [])
print(f"\nimages: {len(images)}")
for image in images:
    anchor = image.anchor
    cell = getattr(anchor, "_from", None)
    extent = getattr(anchor, "ext", None)
    where = f"col {cell.col} row {cell.row}" if cell is not None else "unknown anchor"
    if extent is not None:
        print(f"  {where}: {extent.cx / 360000:.2f} x {extent.cy / 360000:.2f} cm")
    else:
        print(f"  {where}: no explicit extent")

if not images:
    problems.append("no images were found by openpyxl")
if sheet.freeze_panes is None:
    problems.append("freeze panes were not applied")

if problems:
    print("\nPROBLEMS:")
    for problem in problems:
        print(f"  - {problem}")
    sys.exit(1)

print("\nopenpyxl read the workbook without complaint.")
