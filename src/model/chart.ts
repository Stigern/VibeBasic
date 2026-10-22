// MSChart (MSCHRT20.OCX): the data of a chart and the arithmetic of drawing it. Pure TypeScript, no DOM.
//
// A chart is a table of `rows` x `cols` numbers: a column is a series, a row is a data point (a category), as in MSChart's
// default (series in columns). Rows and columns have labels. `values[r][c]` is 0-based here; the VB6 properties (Row, Column,
// PointSelected) count from 1.

import { joinFields, splitFields } from './fieldLines';

// ---------------------------------------------------------------------------------------------------------------
// Chart types (VtChChartType)

export const VT_BAR_3D = 0, VT_BAR_2D = 1, VT_LINE_3D = 2, VT_LINE_2D = 3, VT_AREA_3D = 4, VT_AREA_2D = 5, VT_STEP_3D = 6, VT_STEP_2D = 7;
export const VT_PIE_2D = 14, VT_XY = 16;
/** The chart types the control draws, with their VB6 constant names. */
export const CHART_TYPE_NAMES: [number, string][] = [
  [VT_BAR_3D, 'VtChChartType3dBar'], [VT_BAR_2D, 'VtChChartType2dBar'], [VT_LINE_3D, 'VtChChartType3dLine'], [VT_LINE_2D, 'VtChChartType2dLine'],
  [VT_AREA_3D, 'VtChChartType3dArea'], [VT_AREA_2D, 'VtChChartType2dArea'], [VT_STEP_3D, 'VtChChartType3dStep'], [VT_STEP_2D, 'VtChChartType2dStep'],
  [VT_PIE_2D, 'VtChChartType2dPie'], [VT_XY, 'VtChChartType2dXY'],
];
/** VtChAxisId: the axes of Plot.Axis(id). */
export const AXIS_X = 0, AXIS_Y = 1, AXIS_Y2 = 2, AXIS_Z = 3;

export type ChartKind = 'bar' | 'line' | 'area' | 'step' | 'pie' | 'xy';
/** The kind of drawing for a chart type; the 3-D types are drawn flat with an offset shadow (`threeD`). */
export function chartKind(type: number): { kind: ChartKind; threeD: boolean } {
  switch (type) {
    case VT_BAR_3D: return { kind: 'bar', threeD: true };
    case VT_LINE_3D: return { kind: 'line', threeD: true };
    case VT_LINE_2D: return { kind: 'line', threeD: false };
    case VT_AREA_3D: return { kind: 'area', threeD: true };
    case VT_AREA_2D: return { kind: 'area', threeD: false };
    case VT_STEP_3D: return { kind: 'step', threeD: true };
    case VT_STEP_2D: return { kind: 'step', threeD: false };
    case VT_PIE_2D: return { kind: 'pie', threeD: false };
    case VT_XY: return { kind: 'xy', threeD: false };
    default: return { kind: 'bar', threeD: false };
  }
}

/** The default series colours (dark blue, dark red, yellow, teal, ...), as CSS colours; they repeat after the last. */
export const SERIES_COLORS = ['#000080', '#800000', '#ffff00', '#008080', '#800080', '#808000', '#0000ff', '#ff0000', '#00ff00', '#00ffff', '#ff00ff', '#808080'];
export const seriesColor = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length];

// ---------------------------------------------------------------------------------------------------------------
// The data

export interface ChartModel { rows: number; cols: number; values: number[][]; rowLabels: string[]; colLabels: string[] }

export const MAX_CHART_ROWS = 4096;
export const MAX_CHART_COLS = 256;

/** The values of a new chart at design time (5 rows x 4 columns, repeating when there are more). */
const SAMPLE = [[9, 2, 5, 3], [6, 7, 4, 6], [3, 8, 7, 5], [8, 3, 9, 7], [5, 6, 2, 8]];
const sampleValue = (r: number, c: number): number => SAMPLE[r % 5][c % 4] + Math.floor(r / 5) + Math.floor(c / 4);
export const defaultRowLabel = (r: number): string => `Row ${r + 1}`;
export const defaultColLabel = (c: number): string => `Column ${c + 1}`;

export function sampleChart(rows = 5, cols = 4): ChartModel {
  const m = emptyChart(rows, cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m.values[r][c] = sampleValue(r, c);
  return m;
}

export function emptyChart(rows: number, cols: number): ChartModel {
  return {
    rows, cols,
    values: Array.from({ length: rows }, () => new Array<number>(cols).fill(0)),
    rowLabels: Array.from({ length: rows }, (_, r) => defaultRowLabel(r)),
    colLabels: Array.from({ length: cols }, (_, c) => defaultColLabel(c)),
  };
}

/** RowCount / ColumnCount were set: the data that still fits stays, new cells are 0 and new labels get the default names. */
export function resizeChart(m: ChartModel, rows: number, cols: number): ChartModel {
  const n = emptyChart(rows, cols);
  for (let r = 0; r < Math.min(rows, m.rows); r++) {
    n.rowLabels[r] = m.rowLabels[r];
    for (let c = 0; c < Math.min(cols, m.cols); c++) n.values[r][c] = m.values[r][c];
  }
  for (let c = 0; c < Math.min(cols, m.cols); c++) n.colLabels[c] = m.colLabels[c];
  return n;
}

/**
 * ChartData = a 2-D array (`cells[row][col]`). As in VB6, strings in the first row are the column labels and strings in the first
 * column are the row labels; with both, the upper left cell is not used. Without labels in the first row (or column) it is data.
 * Cells that are not labels are numbers (the caller converts). A single row or column is never taken for labels.
 */
export function chartFromMatrix(cells: (number | string)[][]): ChartModel {
  const R = cells.length, C = R ? cells[0].length : 0;
  const isStr = (v: number | string | undefined): v is string => typeof v === 'string';
  const colLab = C >= 2 && R >= 2 && cells[0].slice(1).every(isStr);
  const rowLab = R >= 2 && C >= 2 && cells.slice(1).every(row => isStr(row[0]));
  const r0 = colLab ? 1 : 0, c0 = rowLab ? 1 : 0;
  const m = emptyChart(R - r0, C - c0);
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      const v = cells[r + r0][c + c0];
      m.values[r][c] = typeof v === 'number' ? v : Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : 0;   // a number written as text
    }
    if (rowLab) m.rowLabels[r] = String(cells[r + r0][0]);
  }
  if (colLab) for (let c = 0; c < m.cols; c++) m.colLabels[c] = String(cells[0][c + c0]);
  return m;
}

/** What reading ChartData returns: the data with the labels in the first row and column (the upper left cell is empty text). */
export function chartToMatrix(m: ChartModel): (number | string)[][] {
  const out: (number | string)[][] = [['', ...m.colLabels]];
  for (let r = 0; r < m.rows; r++) out.push([m.rowLabels[r], ...m.values[r]]);
  return out;
}

// -- the form the window gets (a list prop): line 0 = '' and the column labels, then one line per row: its label and its values

export function encodeChart(m: ChartModel): string[] {
  return [joinFields(['', ...m.colLabels]), ...m.values.map((row, r) => joinFields([m.rowLabels[r], ...row.map(String)]))];
}

/** The model of encoded lines; null when there is no data (the caller then shows the sample). */
export function decodeChart(lines: readonly string[]): ChartModel | null {
  if (lines.length < 2) return null;
  const rowsF = lines.slice(1).map(splitFields);
  const cols = Math.max(...rowsF.map(f => f.length - 1), splitFields(lines[0]).length - 1);
  if (cols < 1) return null;
  const m = emptyChart(rowsF.length, cols);
  const head = splitFields(lines[0]);
  for (let c = 0; c < cols; c++) m.colLabels[c] = head[c + 1] ?? defaultColLabel(c);
  rowsF.forEach((f, r) => {
    m.rowLabels[r] = f[0] ?? defaultRowLabel(r);
    for (let c = 0; c < cols; c++) { const n = Number(f[c + 1]); m.values[r][c] = Number.isFinite(n) ? n : 0; }
  });
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing arithmetic

export interface Scale { min: number; max: number; step: number; ticks: number[] }

/** A value axis that includes `lo` .. `hi` with round tick values (about `target` of them). Always spans a positive range. */
export function niceScale(lo: number, hi: number, target = 5): Scale {
  if (!(hi > lo)) { if (lo === 0) hi = 1; else if (lo > 0) { hi = lo; lo = 0; } else { hi = 0; } }
  if (!(hi > lo)) { lo = 0; hi = 1; }
  const raw = (hi - lo) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  const min = Math.floor(lo / step + 1e-9) * step, max = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0, v = min; v <= max + step * 1e-6 && i < 1000; i++, v = min + i * step) ticks.push(Math.round(v / step) * step);
  return { min, max: ticks[ticks.length - 1], step, ticks };
}

/** The slices of a pie (negative values count as 0) in degrees; they add up to 360 (all 0 when every value is 0). */
export function pieSweeps(values: readonly number[]): number[] {
  const v = values.map(x => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = v.reduce((a, b) => a + b, 0);
  if (total <= 0) return v.map(() => 0);
  const out = v.map(x => (x / total) * 360);
  // exact sum: the last slice takes the rest
  let last = -1;
  out.forEach((x, i) => { if (x > 0) last = i; });
  out[last] = 360 - out.reduce((a, b, i) => (i === last ? a : a + b), 0);
  return out;
}

/** One bar segment: `series` / `point` are 0-based; `y0` .. `y1` are the values it spans (y0 <= y1). */
export interface BarSeg { series: number; point: number; slot: number; slots: number; y0: number; y1: number }

/**
 * The bars of a bar chart. Next to each other (`slot` = the series, `slots` = the number of series), or stacked (`slot` 0 of 1:
 * positive values pile up from 0 upwards, negative ones downwards).
 */
export function barSegments(m: ChartModel, stacking: boolean): BarSeg[] {
  const out: BarSeg[] = [];
  for (let r = 0; r < m.rows; r++) {
    let pos = 0, neg = 0;
    for (let c = 0; c < m.cols; c++) {
      const v = m.values[r][c];
      if (!stacking) out.push({ series: c, point: r, slot: c, slots: m.cols, y0: Math.min(0, v), y1: Math.max(0, v) });
      else if (v >= 0) { out.push({ series: c, point: r, slot: 0, slots: 1, y0: pos, y1: pos + v }); pos += v; }
      else { out.push({ series: c, point: r, slot: 0, slots: 1, y0: neg + v, y1: neg }); neg += v; }
    }
  }
  return out;
}

/** The y value of every point of a line / area / step chart: `[series][point]`; stacked ones are running totals. */
export function lineValues(m: ChartModel, stacking: boolean): number[][] {
  return Array.from({ length: m.cols }, (_, c) => m.values.map((row, r) => (stacking ? row.slice(0, c + 1).reduce((a, b) => a + b, 0) : row[c] ?? 0)));
}

/** The value range a chart of this kind needs (it includes 0 for bars and areas). */
export function valueRange(m: ChartModel, kind: ChartKind, stacking: boolean): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  const take = (v: number): void => { if (v < lo) lo = v; if (v > hi) hi = v; };
  if (kind === 'bar') for (const s of barSegments(m, stacking)) { take(s.y0); take(s.y1); }
  else if (kind === 'xy') { for (let r = 0; r < m.rows; r++) for (let c = 1; c < m.cols; c++) take(m.values[r][c]); }
  else for (const s of lineValues(m, stacking)) for (const v of s) take(v);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (kind === 'bar' || kind === 'area') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  return { lo, hi };
}

/** Axis label text of a tick value. */
export function tickText(v: number): string {
  return String(Math.round(v * 1e6) / 1e6);
}
