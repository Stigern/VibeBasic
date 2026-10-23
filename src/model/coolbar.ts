// CoolBar (COMCT332.OCX) bands: one per line 'Caption|Key|Image|NewRow|Style|Child|MinWidth|Width|Visible' (see fieldLines.ts). Child is the name
// of a control of the form, MinWidth and Width are in twips (Width 0 = as wide as the band needs), NewRow / Visible '1' / '0'.
import { joinFields, splitFields } from './fieldLines';

export interface BandData {
  caption: string; key: string; image: string; newRow: boolean; style: number; child: string; minWidth: number; width: number; visible: boolean;
}

export const CBR_DEFAULT = 0, CBR_FIXED_SIZE = 1;

export function parseBand(line: string): BandData {
  const [caption = '', key = '', image = '', newRow = '', style = '', child = '', minWidth = '', width = '', visible = ''] = splitFields(line);
  return {
    caption, key, image, newRow: newRow === '1', style: Number(style) || 0, child, minWidth: Math.max(0, Number(minWidth) || 0),
    width: Math.max(0, Number(width) || 0), visible: visible !== '0',
  };
}

export function bandLine(b: BandData): string {
  return joinFields([b.caption, b.key, b.image, b.newRow ? '1' : '', b.style || '', b.child, b.minWidth || '', b.width || '', b.visible ? '' : '0']);
}

// -- layout (pixels) ------------------------------------------------------------------------------------------

export const BAND_GRIP = 10;       // the gripper
export const BAND_MIN_ROW = 24;    // the height of a row without a taller child
export const BAND_PAD = 4;         // above and below a child
export const BAND_EDGE = 2;        // the CoolBar's own border, top and bottom

/** What the layout needs to know about the band's content. */
export interface BandContent { image: number; caption: number; childWidth: number; childHeight: number }

export interface BandBox { index: number; row: number; left: number; width: number; height: number }

/** The visible bands in rows (a band with NewRow starts a new one) and the rows' heights. */
export function bandRows(bands: readonly BandData[]): number[][] {
  const rows: number[][] = [];
  bands.forEach((b, i) => {
    if (!b.visible) return;
    if (rows.length === 0 || b.newRow) rows.push([]);
    rows[rows.length - 1].push(i);
  });
  return rows;
}

export function rowHeight(content: readonly BandContent[], row: readonly number[]): number {
  return Math.max(BAND_MIN_ROW, ...row.map(i => (content[i]?.childHeight ? content[i].childHeight + BAND_PAD : 0)));
}

/** The height of the whole CoolBar in pixels. */
export function coolbarHeight(bands: readonly BandData[], content: readonly BandContent[]): number {
  const rows = bandRows(bands);
  return rows.reduce((h, r) => h + rowHeight(content, r), 0) + (rows.length ? BAND_EDGE : 0);
}

/** Where each visible band goes in a CoolBar `width` pixels wide: the width of a band is its own (twips / 15) or what its content needs; the last
 *  band of a row takes what is left (and every band keeps its MinWidth). */
export function layoutBands(bands: readonly BandData[], content: readonly BandContent[], width: number): BandBox[] {
  const out: BandBox[] = [];
  bandRows(bands).forEach((row, r) => {
    const height = rowHeight(content, row);
    let left = 0;
    row.forEach((i, k) => {
      const b = bands[i], c = content[i] ?? { image: 0, caption: 0, childWidth: 0, childHeight: 0 };
      const min = Math.round(b.minWidth / 15);
      let w = b.width > 0 ? Math.round(b.width / 15) : BAND_GRIP + c.image + c.caption + c.childWidth + 6;
      w = Math.max(w, min, BAND_GRIP + 4);
      if (k === row.length - 1) w = Math.max(width - left, min, BAND_GRIP + 4);
      out.push({ index: i, row: r, left, width: w, height });
      left += w;
    });
  });
  return out;
}

/** Dragging the gripper of the band at `pos` in its row by `dx` pixels moves the edge between it and the band before it. Returns the two widths
 *  (px) the pair gets, or null for the first band of a row or a fixed-size band. */
export function dragGripper(widthBefore: number, widthThis: number, minBefore: number, minThis: number, dx: number): [number, number] | null {
  const total = widthBefore + widthThis;
  const before = Math.min(total - minThis, Math.max(minBefore, widthBefore + dx));
  return before > total - minThis ? null : [before, total - before];
}
