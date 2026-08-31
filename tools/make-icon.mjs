/**
 * Draw the Marketplace icon.
 *
 *     node tools/make-icon.mjs
 *
 * The Marketplace wants a 128x128 PNG and shows it at several sizes, so this
 * draws at 256 and keeps the shapes simple enough to survive being shrunk:
 * a spreadsheet grid with a plot sitting in one cell, which is the whole
 * extension in one picture.
 *
 * Drawn with the project's own PNG encoder rather than an image library,
 * for the same reason as everything else here — there isn't one.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { encodePng } = await import('../packages/core/src/image/png.ts');

const SIZE = 256;
const data = Buffer.alloc(SIZE * SIZE * 4);

const INK = [31, 111, 82];
const PAPER = [246, 247, 244];
const RULE = [205, 214, 207];
const PLOT = [31, 111, 82];
const ACCENT = [200, 122, 46];

function set(x, y, [r, g, b], alpha = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const at = (y * SIZE + x) * 4;
  const a = alpha / 255;

  data[at] = Math.round(data[at] * (1 - a) + r * a);
  data[at + 1] = Math.round(data[at + 1] * (1 - a) + g * a);
  data[at + 2] = Math.round(data[at + 2] * (1 - a) + b * a);
  data[at + 3] = Math.max(data[at + 3], alpha);
}

function fillRect(x0, y0, w, h, colour, alpha = 255) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, colour, alpha);
}

/** A rounded square, anti-aliased by sampling the corner arcs. */
function roundedSquare(inset, radius, colour) {
  const min = inset;
  const max = SIZE - inset - 1;

  for (let y = min; y <= max; y++) {
    for (let x = min; x <= max; x++) {
      const dx = x < min + radius ? min + radius - x : x > max - radius ? x - (max - radius) : 0;
      const dy = y < min + radius ? min + radius - y : y > max - radius ? y - (max - radius) : 0;
      const distance = Math.hypot(dx, dy);

      if (distance <= radius - 1) set(x, y, colour);
      else if (distance < radius) set(x, y, colour, Math.round(255 * (radius - distance)));
    }
  }
}

/** A line with round-ish ends, thick enough to read when shrunk to 32px. */
function line(x0, y0, x1, y1, colour, thickness) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);

  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;

    for (let dy = -thickness; dy <= thickness; dy++) {
      for (let dx = -thickness; dx <= thickness; dx++) {
        const distance = Math.hypot(dx, dy);
        if (distance <= thickness - 0.5) set(Math.round(cx + dx), Math.round(cy + dy), colour);
        else if (distance < thickness + 0.5) {
          set(Math.round(cx + dx), Math.round(cy + dy), colour, Math.round(255 * (thickness + 0.5 - distance)));
        }
      }
    }
  }
}

// The card.
roundedSquare(12, 34, INK);
roundedSquare(24, 24, PAPER);

// The grid: a header band and two rules, so it reads as a sheet.
const left = 24;
const right = SIZE - 25;
const top = 24;
const bottom = SIZE - 25;

// A tinted header band rather than a solid one: at 32px a solid band merges
// with the border above it and the icon reads as a thick green edge.
fillRect(left, top, right - left, 26, INK, 46);
fillRect(left, top + 26, right - left, 3, RULE);
for (const y of [top + 29 + 66]) fillRect(left, y, right - left, 3, RULE);
fillRect(left + 74, top, 3, bottom - top, RULE);

// Two text rows in the description column, suggested rather than written.
for (const y of [top + 8, top + 56, top + 74, top + 122, top + 140]) fillRect(left + 14, y, 44, 7, RULE);

// The plot in the top-right cell: axes and a rising line with one marker.
const px = left + 92;
const py = top + 40;
const pw = right - px - 14;
const ph = 42;

line(px, py + ph, px + pw, py + ph, RULE, 1.5);
line(px, py, px, py + ph, RULE, 1.5);
line(px + 2, py + ph - 6, px + pw * 0.38, py + ph - 24, PLOT, 2.5);
line(px + pw * 0.38, py + ph - 24, px + pw * 0.68, py + ph - 14, PLOT, 2.5);
line(px + pw * 0.68, py + ph - 14, px + pw - 2, py + 2, PLOT, 2.5);

// The second cell: bars, so the two rows are visibly different plots.
const bx = px;
const by = top + 106;
const bh = 42;

line(bx, by + bh, bx + pw, by + bh, RULE, 1.5);
line(bx, by, bx, by + bh, RULE, 1.5);
for (const [index, height] of [14, 26, 20, 34, 30].entries()) {
  fillRect(bx + 8 + index * 20, by + bh - height, 12, height, index === 3 ? ACCENT : PLOT);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../packages/extension/media/icon.png');

await writeFile(out, encodePng({ width: SIZE, height: SIZE, data }, { dpi: 96 }));
console.log(`${path.relative(process.cwd(), out)} — ${SIZE}x${SIZE}`);
