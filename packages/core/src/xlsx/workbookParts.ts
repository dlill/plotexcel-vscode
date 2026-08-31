import { STYLES, type CellStyle } from '../styles.ts';
import { CM_PER_INCH, EXCEL_IMAGE_DPI, POINTS_PER_INCH, ROW_HEIGHT_SLACK } from '../units.ts';
import { cellReference, columnName, escapeXml, xmlDocument } from './xml.ts';

/**
 * Build the parts of an .xlsx by hand.
 *
 * An .xlsx is a ZIP of XML parts, and the parts this project needs — one
 * sheet, sized rows and columns, styled text, embedded images, a frozen header
 * and a page setup — are small enough to write directly. Doing so buys the one
 * thing that matters most for a faithful port: images are positioned and sized
 * in EMU, an exact unit of length, instead of being routed through a library's
 * pixel approximation. A picture that is 8.47 cm wide in the source PDF is
 * 8.47 cm wide in the workbook, at any dpi.
 */

/** English Metric Units: 914400 per inch, and so exactly 360000 per centimetre. */
export const EMU_PER_CM = 360000;

/** How a centimetre becomes an Excel column width. */
export type ColumnWidthModel = 'excel' | 'openxlsx';

export interface WorkbookCellInput {
  /** 1-based. */
  readonly row: number;
  /** 1-based. */
  readonly column: number;
  readonly text: string;
  /** A name from {@link STYLES}. Omit for the default look. */
  readonly style?: string | undefined;
}

export interface WorkbookImageInput {
  readonly row: number;
  readonly column: number;
  readonly widthCm: number;
  readonly heightCm: number;
  /** PNG bytes, already rendered and cropped. */
  readonly png: Uint8Array;
  /** Alt text. Shown by screen readers and in Excel's picture properties. */
  readonly description?: string | undefined;
}

export interface WorkbookInput {
  readonly sheetName?: string;
  readonly cells: readonly WorkbookCellInput[];
  readonly images: readonly WorkbookImageInput[];
  /** Column index to width in centimetres. */
  readonly columnWidthsCm: ReadonlyMap<number, number>;
  /** Row index to height in centimetres. */
  readonly rowHeightsCm: ReadonlyMap<number, number>;
  /** Rows and columns to keep on screen while scrolling. */
  readonly freeze?: { readonly rows: number; readonly columns: number } | undefined;
  readonly addBorders?: boolean | undefined;
  /** Scale the sheet onto a single page when printed or exported to PDF. */
  readonly fitToPage?: boolean | undefined;
  readonly widthModel?: ColumnWidthModel | undefined;
  /** Extra row height, as a factor, so an image is never a hair too tall. */
  readonly rowHeightSlack?: number | undefined;
  readonly createdAt?: Date | undefined;
  readonly title?: string | undefined;
}

/**
 * Excel measures column width in characters of the workbook's default font.
 * For Calibri 11 that character is 7 pixels wide.
 */
const MAXIMUM_DIGIT_WIDTH = 7;

/** R's openxlsx-tuned constant, kept so the two can be compared during the port. */
const OPENXLSX_WIDTH_PER_CM = 5.3;

/**
 * Convert a physical width to Excel's column-width unit.
 *
 * A column here has to be as wide as the picture sitting on it, so the width
 * is the image's pixel width at Excel's nominal 96 dpi divided by the width of
 * one character — 5.3994 per centimetre. Excel's own padding is deliberately
 * not subtracted: that allowance is for text inset from the cell edges, and an
 * image ignores it.
 *
 * `openxlsx` reproduces the constant the R package used, 5.3, which makes
 * columns about 2% narrower than their images. Keeping it available means a
 * ported workbook can be compared against its reference like for like.
 */
export function columnWidthFromCm(cm: number, model: ColumnWidthModel = 'excel'): number {
  if (model === 'openxlsx') return cm * OPENXLSX_WIDTH_PER_CM;

  const pixels = (cm / CM_PER_INCH) * EXCEL_IMAGE_DPI;
  return Math.max(0, pixels / MAXIMUM_DIGIT_WIDTH);
}

/** Convert a physical height to points, Excel's row-height unit. */
export function rowHeightFromCm(cm: number, slack = ROW_HEIGHT_SLACK): number {
  return (cm / CM_PER_INCH) * POINTS_PER_INCH * slack;
}

/** One file inside the workbook package. */
export interface WorkbookPart {
  readonly name: string;
  readonly data: Uint8Array;
  /** True for data that is already compressed and should be stored as-is. */
  readonly store?: boolean;
}

/**
 * Build every part of the workbook, without packaging them.
 *
 * The split matters more than it looks: everything above this line is string
 * and byte arithmetic with no platform behind it, so the same code can build a
 * workbook inside a browser, where the only difference is which ZIP writer
 * puts the parts together.
 */
export function buildWorkbookParts(input: WorkbookInput): WorkbookPart[] {
  const sheetName = safeSheetName(input.sheetName ?? 'Plots');
  const widthModel = input.widthModel ?? 'excel';
  const slack = input.rowHeightSlack ?? ROW_HEIGHT_SLACK;
  const borders = input.addBorders === true;
  const createdAt = input.createdAt ?? new Date();

  const styleTable = buildStyleTable(borders);
  const parts: WorkbookPart[] = [
    { name: '[Content_Types].xml', data: contentTypes(input.images.length) },
    { name: '_rels/.rels', data: rootRelationships() },
    { name: 'docProps/core.xml', data: coreProperties(input.title ?? sheetName, createdAt) },
    { name: 'docProps/app.xml', data: appProperties(sheetName) },
    { name: 'xl/workbook.xml', data: workbookXml(sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelationships() },
    { name: 'xl/styles.xml', data: styleTable.xml },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: sheetXml({ input, styleTable, widthModel, slack, borders }),
    },
  ];

  if (input.images.length > 0) {
    parts.push(
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: sheetRelationships() },
      { name: 'xl/drawings/drawing1.xml', data: drawingXml(input.images) },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', data: drawingRelationships(input.images.length) },
      ...input.images.map((image, index) => ({
        name: `xl/media/image${index + 1}.png`,
        data: image.png,
        // PNG carries its own compression; deflating it again wastes time.
        store: true,
      })),
    );
  }

  return parts;
}

// ------------------------------------------------------------------------- //
// Styles
// ------------------------------------------------------------------------- //

interface StyleTable {
  readonly xml: Uint8Array;
  /** Style name to cellXfs index. */
  readonly index: ReadonlyMap<string, number>;
  /** The index used for a cell with no style of its own. */
  readonly defaultIndex: number;
}

function buildStyleTable(borders: boolean): StyleTable {
  const fonts = [{ size: 11, bold: false }];
  const fontIndex = new Map<string, number>([['11:false', 0]]);
  const index = new Map<string, number>();
  const xfs: string[] = [];

  const borderId = borders ? 1 : 0;
  xfs.push(`<xf numFmtId="0" fontId="0" fillId="0" borderId="${borderId}" xfId="0"${borders ? ' applyBorder="1"' : ''}/>`);

  for (const [name, style] of Object.entries(STYLES)) {
    const size = style.fontSize ?? 11;
    const bold = style.bold === true;
    const key = `${size}:${bold}`;

    if (!fontIndex.has(key)) {
      fontIndex.set(key, fonts.length);
      fonts.push({ size, bold });
    }

    index.set(name, xfs.length);
    xfs.push(cellXf(fontIndex.get(key)!, borderId, style, borders));
  }

  const fontXml = fonts
    .map((font) => `<font><sz val="${font.size}"/>${font.bold ? '<b/>' : ''}<name val="Calibri"/><family val="2"/></font>`)
    .join('');

  const borderXml =
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>' +
    '<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>';

  const xml = xmlDocument(
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<fonts count="${fonts.length}">${fontXml}</fonts>`,
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
    borderXml,
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`,
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>',
  );

  return { xml, index, defaultIndex: 0 };
}

function cellXf(fontId: number, borderId: number, style: CellStyle, borders: boolean): string {
  const alignment: string[] = [];
  if (style.horizontal) alignment.push(`horizontal="${style.horizontal}"`);
  if (style.vertical) alignment.push(`vertical="${style.vertical === 'middle' ? 'center' : style.vertical}"`);
  if (style.wrapText) alignment.push('wrapText="1"');
  if (style.textRotation !== undefined) alignment.push(`textRotation="${excelRotation(style.textRotation)}"`);

  const attributes = [
    'numFmtId="0"',
    `fontId="${fontId}"`,
    'fillId="0"',
    `borderId="${borderId}"`,
    'xfId="0"',
    'applyFont="1"',
    borders ? 'applyBorder="1"' : '',
    alignment.length > 0 ? 'applyAlignment="1"' : '',
  ].filter((attribute) => attribute.length > 0);

  if (alignment.length === 0) return `<xf ${attributes.join(' ')}/>`;
  return `<xf ${attributes.join(' ')}><alignment ${alignment.join(' ')}/></xf>`;
}

/**
 * Excel stores rotation as 0–90 counter-clockwise, then 91–180 for clockwise
 * angles, so -90 degrees is written as 180.
 */
function excelRotation(degrees: number): number {
  return degrees < 0 ? 90 - degrees : degrees;
}

// ------------------------------------------------------------------------- //
// Worksheet
// ------------------------------------------------------------------------- //

interface SheetInput {
  readonly input: WorkbookInput;
  readonly styleTable: StyleTable;
  readonly widthModel: ColumnWidthModel;
  readonly slack: number;
  readonly borders: boolean;
}

function sheetXml({ input, styleTable, widthModel, slack, borders }: SheetInput): Uint8Array {
  const usedColumns = new Set<number>([...input.columnWidthsCm.keys()]);
  const usedRows = new Set<number>([...input.rowHeightsCm.keys()]);
  for (const cell of input.cells) {
    usedColumns.add(cell.column);
    usedRows.add(cell.row);
  }
  for (const image of input.images) {
    usedColumns.add(image.column);
    usedRows.add(image.row);
  }

  const lastColumn = Math.max(1, ...usedColumns);
  const lastRow = Math.max(1, ...usedRows);

  const byRow = new Map<number, WorkbookCellInput[]>();
  for (const cell of input.cells) {
    const row = byRow.get(cell.row) ?? [];
    row.push(cell);
    byRow.set(cell.row, row);
  }

  const cols = [...input.columnWidthsCm.entries()]
    .sort(([a], [b]) => a - b)
    .map(([column, cm]) => {
      const width = columnWidthFromCm(cm, widthModel).toFixed(4);
      return `<col min="${column}" max="${column}" width="${width}" customWidth="1"/>`;
    })
    .join('');

  const rows = [...usedRows]
    .sort((a, b) => a - b)
    .map((row) => {
      const heightCm = input.rowHeightsCm.get(row);
      const height = heightCm === undefined ? '' : ` ht="${rowHeightFromCm(heightCm, slack).toFixed(2)}" customHeight="1"`;
      const cells = byRow.get(row) ?? [];
      const written = new Map(cells.map((cell) => [cell.column, cell]));

      // With borders on, every cell in the used range needs a style, including
      // the ones that only hold an image.
      const columns = borders
        ? Array.from({ length: lastColumn }, (_, index) => index + 1)
        : [...written.keys()].sort((a, b) => a - b);

      const body = columns
        .map((column) => cellXml(row, column, written.get(column), styleTable))
        .join('');

      return `<row r="${row}"${height}>${body}</row>`;
    })
    .join('');

  const freeze = input.freeze;
  const pane =
    freeze && (freeze.rows > 0 || freeze.columns > 0)
      ? `<pane${freeze.columns > 0 ? ` xSplit="${freeze.columns}"` : ''}${freeze.rows > 0 ? ` ySplit="${freeze.rows}"` : ''}` +
        ` topLeftCell="${cellReference(freeze.rows + 1, freeze.columns + 1)}" activePane="bottomRight" state="frozen"/>`
      : '';

  const fitToPage = input.fitToPage !== false;

  return xmlDocument(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    fitToPage ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '',
    `<dimension ref="A1:${columnName(lastColumn)}${lastRow}"/>`,
    `<sheetViews><sheetView tabSelected="1" workbookViewId="0">${pane}</sheetView></sheetViews>`,
    '<sheetFormatPr defaultRowHeight="15"/>',
    cols.length > 0 ? `<cols>${cols}</cols>` : '',
    `<sheetData>${rows}</sheetData>`,
    '<pageMargins left="0.25" right="0.25" top="0.25" bottom="0.25" header="0.3" footer="0.3"/>',
    `<pageSetup paperSize="9" orientation="landscape"${fitToPage ? ' fitToWidth="1" fitToHeight="1"' : ''}/>`,
    input.images.length > 0 ? '<drawing r:id="rId1"/>' : '',
    '</worksheet>',
  );
}

function cellXml(row: number, column: number, cell: WorkbookCellInput | undefined, styles: StyleTable): string {
  const reference = cellReference(row, column);
  const styleIndex = cell?.style === undefined ? styles.defaultIndex : styles.index.get(cell.style) ?? styles.defaultIndex;
  const attributes = `r="${reference}" s="${styleIndex}"`;

  if (cell === undefined || cell.text.length === 0) return `<c ${attributes}/>`;

  if (isPlainNumber(cell.text)) {
    return `<c ${attributes}><v>${cell.text.trim()}</v></c>`;
  }

  return `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.text)}</t></is></c>`;
}

/**
 * True for text Excel should hold as a number.
 *
 * Deliberately narrow: "5" is a number, but "007" and "1e5" stay text, because
 * a label that loses its leading zeros in a report is a bug the reader notices
 * long after the fact.
 */
function isPlainNumber(text: string): boolean {
  const trimmed = text.trim();
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) return false;
  return Number.isFinite(Number(trimmed));
}

// ------------------------------------------------------------------------- //
// Drawing
// ------------------------------------------------------------------------- //

function drawingXml(images: readonly WorkbookImageInput[]): Uint8Array {
  const anchors = images
    .map((image, index) => {
      const id = index + 2;
      const width = Math.round(image.widthCm * EMU_PER_CM);
      const height = Math.round(image.heightCm * EMU_PER_CM);
      const description = escapeXml(image.description ?? `Plot ${index + 1}`);

      return (
        '<xdr:oneCellAnchor>' +
        `<xdr:from><xdr:col>${image.column - 1}</xdr:col><xdr:colOff>0</xdr:colOff>` +
        `<xdr:row>${image.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${width}" cy="${height}"/>` +
        '<xdr:pic>' +
        `<xdr:nvPicPr><xdr:cNvPr id="${id}" name="Picture ${index + 1}" descr="${description}"/>` +
        '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
        `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${index + 1}"/>` +
        '<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
        '<xdr:spPr><a:xfrm><a:off x="0" y="0"/>' +
        `<a:ext cx="${width}" cy="${height}"/></a:xfrm>` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
        '</xdr:pic>' +
        '<xdr:clientData/>' +
        '</xdr:oneCellAnchor>'
      );
    })
    .join('');

  return xmlDocument(
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"',
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    anchors,
    '</xdr:wsDr>',
  );
}

// ------------------------------------------------------------------------- //
// Package parts
// ------------------------------------------------------------------------- //

function contentTypes(imageCount: number): Uint8Array {
  return xmlDocument(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    imageCount > 0 ? '<Default Extension="png" ContentType="image/png"/>' : '',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    imageCount > 0
      ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
      : '',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    '</Types>',
  );
}

function rootRelationships(): Uint8Array {
  return xmlDocument(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    '</Relationships>',
  );
}

function workbookRelationships(): Uint8Array {
  return xmlDocument(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '</Relationships>',
  );
}

function sheetRelationships(): Uint8Array {
  return xmlDocument(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>',
    '</Relationships>',
  );
}

function drawingRelationships(imageCount: number): Uint8Array {
  const relationships = Array.from({ length: imageCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index + 1}.png"/>`,
  ).join('');

  return xmlDocument(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    relationships,
    '</Relationships>',
  );
}

function workbookXml(sheetName: string): Uint8Array {
  return xmlDocument(
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`,
    '</workbook>',
  );
}

function coreProperties(title: string, createdAt: Date): Uint8Array {
  const stamp = createdAt.toISOString().replace(/\.\d+Z$/, 'Z');
  return xmlDocument(
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"',
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapeXml(title)}</dc:title>`,
    '<dc:creator>plotExcel</dc:creator>',
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>`,
    '</cp:coreProperties>',
  );
}

function appProperties(sheetName: string): Uint8Array {
  return xmlDocument(
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"',
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<Application>plotExcel for VS Code</Application>',
    '<TitlesOfParts><vt:vector size="1" baseType="lpstr">',
    `<vt:lpstr>${escapeXml(sheetName)}</vt:lpstr>`,
    '</vt:vector></TitlesOfParts>',
    '</Properties>',
  );
}

/** Excel rejects some characters in sheet names, and anything past 31 characters. */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned.length === 0 ? 'Plots' : cleaned).slice(0, 31);
}
