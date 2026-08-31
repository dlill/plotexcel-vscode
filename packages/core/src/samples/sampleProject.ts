import { encodePng } from '../image/png.ts';
import { drawText, measureText } from '../image/font.ts';
import { formatLayout, type LayoutFile } from '../layout/layoutFile.ts';
import { samplePdf } from './samplePdf.ts';

/**
 * A folder of plots and a layout to go with them, made on the spot.
 *
 * Someone who has just installed the extension has no plots to hand, and
 * "find a folder of PDFs" is a bad first instruction. This makes one: three
 * documents, seven pages between them, and a layout that already uses the
 * features worth knowing about — a caption style, a page number, a crop, and
 * a comparison column.
 *
 * Generated rather than shipped as fixtures, so it cannot drift from what the
 * code currently does. And made of PDFs rather than images on purpose: opening
 * the sample is then a real test of the rasteriser, which is the part most
 * likely to be missing on a given machine.
 */

export interface SampleFile {
  /** Path relative to the sample folder, with forward slashes. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface SampleProject {
  readonly files: readonly SampleFile[];
  readonly layoutName: string;
  readonly layoutText: string;
}

export const SAMPLE_FOLDER = 'plotexcel-sample';

export function sampleProject(): SampleProject {
  const files: SampleFile[] = [
    {
      path: 'figures/model-fit.pdf',
      bytes: samplePdf({
        pages: [
          {
            title: 'Model fit',
            subtitle: 'observed against predicted, run 4',
            series: [0.08, 0.32, 0.26, 0.58, 0.51, 0.79, 0.94],
            kind: 'line',
          },
          {
            title: 'Residuals',
            subtitle: 'by group',
            series: [0.38, 0.72, 0.51, 0.88, 0.6],
            kind: 'bars',
          },
          {
            title: 'Convergence',
            subtitle: 'objective over iterations',
            series: [0.96, 0.61, 0.43, 0.31, 0.25, 0.22, 0.21],
            kind: 'line',
          },
        ],
      }),
    },
    {
      path: 'figures/model-fit-previous.pdf',
      bytes: samplePdf({
        pages: [
          {
            title: 'Model fit',
            subtitle: 'observed against predicted, run 3',
            series: [0.08, 0.3, 0.27, 0.44, 0.5, 0.62, 0.71],
            kind: 'line',
          },
          {
            title: 'Residuals',
            subtitle: 'by group',
            series: [0.4, 0.69, 0.55, 0.62, 0.58],
            kind: 'bars',
          },
          {
            title: 'Convergence',
            subtitle: 'objective over iterations',
            series: [0.96, 0.68, 0.55, 0.47, 0.43, 0.41, 0.4],
            kind: 'line',
          },
        ],
      }),
    },
    {
      path: 'figures/sensitivity.pdf',
      bytes: samplePdf({
        pages: [
          {
            title: 'Sensitivity',
            subtitle: 'each parameter, held at its bounds',
            series: [0.22, 0.9, 0.35, 0.61, 0.15, 0.48],
            kind: 'bars',
          },
        ],
      }),
    },
    { path: 'figures/scatter.png', bytes: scatterPng() },
  ];

  const layout: LayoutFile = {
    options: { resolution: 150, textColWidth: 7, addBorders: false },
    comments: [
      '# A sample, made by plotExcel: Open a Sample Project.',
      '# Edit anything here and render again — everything unchanged is reused.',
    ],
    columns: ['Figure', 'This run', 'Previous run', 'Change'],
    rows: [
      [
        'Model fit::vcenter',
        'figures/model-fit.pdf::page 1',
        'figures/model-fit-previous.pdf::page 1',
        'diff(`This run`, `Previous run`)',
      ],
      [
        'Residuals::vcenter',
        'figures/model-fit.pdf::page 2',
        'figures/model-fit-previous.pdf::page 2',
        'diff(`This run`, `Previous run`)',
      ],
      [
        'Convergence, right half::vcenter',
        'figures/model-fit.pdf::page 3::xmin 50',
        'figures/model-fit-previous.pdf::page 3::xmin 50',
        'diff(`This run`, `Previous run`)',
      ],
      ['Sensitivity::vcenter', 'figures/sensitivity.pdf', '', ''],
      ['Raw scatter::vcenter', 'figures/scatter.png', '', ''],
    ],
  };

  return {
    files,
    layoutName: 'sample.plotexcel.tsv',
    layoutText: formatLayout(layout),
  };
}

// ------------------------------------------------------------------------- //
// The one image plot
// ------------------------------------------------------------------------- //

/**
 * A scatter plot as a PNG, so the sample has one cell that needs no renderer
 * at all — it will look right even on a machine with nothing installed.
 */
function scatterPng(): Uint8Array {
  const width = 620;
  const height = 440;
  const data = Buffer.alloc(width * height * 4, 0);

  const paper = [255, 255, 255];
  const rule = [214, 220, 213];
  const ink = [26, 30, 26];
  const green = [31, 111, 82];
  const amber = [199, 122, 46];

  // Rounded here rather than at every call site: a fractional index into a
  // Buffer sets a property instead of a byte, and the pixel silently vanishes.
  const put = (fx: number, fy: number, colour: readonly number[]) => {
    const x = Math.round(fx);
    const y = Math.round(fy);
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    const at = (y * width + x) * 4;
    data[at] = colour[0]!;
    data[at + 1] = colour[1]!;
    data[at + 2] = colour[2]!;
    data[at + 3] = 255;
  };

  const rect = (x0: number, y0: number, w: number, h: number, colour: readonly number[]) => {
    const left0 = Math.round(x0);
    const top0 = Math.round(y0);
    for (let y = top0; y < top0 + Math.round(h); y++) {
      for (let x = left0; x < left0 + Math.round(w); x++) put(x, y, colour);
    }
  };

  const disc = (cx: number, cy: number, radius: number, colour: readonly number[]) => {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (x * x + y * y <= radius * radius) put(cx + x, cy + y, colour);
      }
    }
  };

  rect(0, 0, width, height, paper);

  const left = 70;
  const right = width - 40;
  const top = 70;
  const bottom = height - 60;

  // Axes and gridlines.
  rect(left, top, 2, bottom - top, rule);
  rect(left, bottom, right - left, 2, rule);
  for (let step = 1; step <= 3; step++) rect(left, top + ((bottom - top) * step) / 4, right - left, 1, [235, 239, 234]);

  // Two clusters, from a fixed sequence so the picture never changes.
  let seed = 20260830;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let index = 0; index < 90; index++) {
    const high = index % 3 === 0;
    const x = left + 20 + random() * (right - left - 40);
    const drift = (x - left) / (right - left);
    const y = bottom - 30 - (drift * 0.55 + random() * 0.35 + (high ? 0.1 : 0)) * (bottom - top - 60);

    disc(x, y, 4, high ? amber : green);
  }

  // Title, in the 5x7 font the placeholders use.
  const scale = 4;
  drawText('SCATTER', scale, (x, y) => put(left + x, 26 + y, ink));
  drawText('measured against fitted', 2, (x, y) => put(left + x, 26 + scale * 7 + 10 + y, [110, 118, 110]));

  // A short scale bar, so a crop is visibly a crop.
  const barWidth = measureText('n = 90', 2);
  drawText('n = 90', 2, (x, y) => put(right - barWidth + x, top - 22 + y, [110, 118, 110]));

  return encodePng({ width, height, data }, { dpi: 150 });
}
