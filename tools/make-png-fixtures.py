#!/usr/bin/env python3
"""Generate small PNG fixtures written by a *foreign* encoder.

The point of these files is that nothing in this repository produced them, so
decoding them proves the decoder reads real PNGs rather than only its own
output. Every colour type, bit depth and row filter the decoder claims to
support appears at least once.

    python3 tools/make-png-fixtures.py

Writes into packages/core/test/fixtures/png/ plus an expected.json describing
the pixels each file should decode to.
"""

from __future__ import annotations

import json
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "packages", "core", "test", "fixtures", "png")


def chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def png(width, height, bit_depth, colour_type, raw_rows, extra=b"", filters=None):
    """raw_rows: list of bytes, one unfiltered scanline each."""
    bytes_per_pixel = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour_type] * (2 if bit_depth == 16 else 1)
    filtered = bytearray()
    previous = bytes(len(raw_rows[0]))

    for index, row in enumerate(raw_rows):
        kind = 0 if filters is None else filters[index % len(filters)]
        filtered.append(kind)
        filtered += apply_filter(kind, row, previous, bytes_per_pixel)
        previous = row

    header = struct.pack(">IIBBBBB", width, height, bit_depth, colour_type, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + extra
        + chunk(b"IDAT", zlib.compress(bytes(filtered), 9))
        + chunk(b"IEND", b"")
    )


def apply_filter(kind, row, previous, bpp):
    out = bytearray(len(row))
    for i, value in enumerate(row):
        left = row[i - bpp] if i >= bpp else 0
        up = previous[i]
        upper_left = previous[i - bpp] if i >= bpp else 0
        if kind == 0:
            out[i] = value
        elif kind == 1:
            out[i] = (value - left) & 0xFF
        elif kind == 2:
            out[i] = (value - up) & 0xFF
        elif kind == 3:
            out[i] = (value - ((left + up) >> 1)) & 0xFF
        elif kind == 4:
            out[i] = (value - paeth(left, up, upper_left)) & 0xFF
        else:
            raise ValueError(kind)
    return bytes(out)


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    expected = {}

    # RGB, every filter type in rotation.
    w, h = 12, 10
    rows = [bytes(((x * 7 + y * 3) % 256, (x * 11) % 256, (y * 23) % 256)[c] for x in range(w) for c in range(3))
            for y in range(h)]
    write("rgb-all-filters.png", png(w, h, 8, 2, rows, filters=[0, 1, 2, 3, 4]), expected,
          w, h, [(r[x * 3], r[x * 3 + 1], r[x * 3 + 2], 255) for r in rows for x in range(w)])

    # RGBA with a varying alpha channel.
    w, h = 6, 4
    rows = [bytes(v for x in range(w) for v in (x * 40 % 256, y * 60 % 256, 128, x * 50 % 256)) for y in range(h)]
    write("rgba.png", png(w, h, 8, 6, rows, filters=[0, 4]), expected,
          w, h, [(r[x * 4], r[x * 4 + 1], r[x * 4 + 2], r[x * 4 + 3]) for r in rows for x in range(w)])

    # Greyscale.
    w, h = 5, 3
    rows = [bytes((x * 50 + y * 20) % 256 for x in range(w)) for y in range(h)]
    write("gray.png", png(w, h, 8, 0, rows, filters=[0, 2]), expected,
          w, h, [(v, v, v, 255) for r in rows for v in r])

    # Greyscale with alpha.
    w, h = 4, 3
    rows = [bytes(v for x in range(w) for v in ((x * 60) % 256, (x * 80) % 256)) for y in range(h)]
    write("gray-alpha.png", png(w, h, 8, 4, rows), expected,
          w, h, [(r[x * 2], r[x * 2], r[x * 2], r[x * 2 + 1]) for r in rows for x in range(w)])

    # Palette, with transparency for the first entry.
    palette = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
    w, h = 4, 2
    rows = [bytes((x + y) % 4 for x in range(w)) for y in range(h)]
    extra = chunk(b"PLTE", b"".join(bytes(c) for c in palette)) + chunk(b"tRNS", bytes([0, 255, 255, 255]))
    write("palette.png", png(w, h, 8, 3, rows, extra=extra), expected, w, h,
          [(*palette[i], 0 if i == 0 else 255) for r in rows for i in r])

    # 16-bit RGB: the decoder keeps the high byte.
    w, h = 3, 2
    rows = []
    pixels16 = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            for c in range(3):
                value = ((x * 4000 + y * 9000 + c * 111) % 65536)
                row += struct.pack(">H", value)
                pixels16.append(value >> 8)
        rows.append(bytes(row))
    write("rgb16.png", png(w, h, 16, 2, rows), expected, w, h,
          [(pixels16[i * 3], pixels16[i * 3 + 1], pixels16[i * 3 + 2], 255) for i in range(w * h)])

    # Physical dimensions: 150 dpi is 5906 pixels per metre.
    w, h = 4, 4
    rows = [bytes(v for x in range(w) for v in (10, 20, 30)) for _ in range(h)]
    phys = chunk(b"pHYs", struct.pack(">IIB", 5906, 5906, 1))
    write("phys-150dpi.png", png(w, h, 8, 2, rows, extra=phys), expected, w, h,
          [(10, 20, 30, 255)] * (w * h), dpi=150)

    with open(os.path.join(OUT, "expected.json"), "w") as handle:
        json.dump(expected, handle, indent=2)
    print(f"wrote {len(expected)} fixtures to {os.path.normpath(OUT)}")


def write(name, data, expected, width, height, pixels, dpi=None):
    with open(os.path.join(OUT, name), "wb") as handle:
        handle.write(data)
    entry = {"width": width, "height": height, "pixels": [list(p) for p in pixels]}
    if dpi is not None:
        entry["dpi"] = dpi
    expected[name] = entry


if __name__ == "__main__":
    main()
