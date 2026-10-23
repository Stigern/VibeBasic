// MSChart at run time: the objects behind `MSChart1.Plot.Axis(id).AxisTitle.Text` and the conversion between a chart's table
// (model/chart.ts) and a VB 2-D Variant array (ChartData).

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { EmptyT, NullT, VBArray, coerce, isDate, toStr, type VBValue } from '../../lang/values';
import { chartFromMatrix, chartToMatrix, MAX_CHART_COLS, MAX_CHART_ROWS, type ChartModel } from '../../model/chart';

/** `Plot.Axis(id [, index])`: `id` is VtChAxisIdX 0, VtChAxisIdY 1, VtChAxisIdY2 2 or VtChAxisIdZ 3 (380 for any other). */
export interface AxisTitles { get(id: number): string; set(id: number, text: string): void }

export class ChartPlot implements VBObject {
  readonly vbTypeName = 'Plot';
  constructor(private titles: AxisTitles) {}
  hasMember(name: string): boolean { return name.toLowerCase() === 'axis'; }
  getMember(name: string, args: VBValue[]): VBValue {
    if (name.toLowerCase() !== 'axis') throw new VBRuntimeError(438);
    if (args.length < 1 || args.length > 2) throw new VBRuntimeError(450);
    const id = coerce(args[0], 'Long') as number;
    if (id < 0 || id > 3) throw new VBRuntimeError(380);
    return new ChartAxis(id, this.titles);
  }
  setMember(): void { throw new VBRuntimeError(383); }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

class ChartAxis implements VBObject {
  readonly vbTypeName = 'Axis';
  constructor(private id: number, private titles: AxisTitles) {}
  hasMember(name: string): boolean { return name.toLowerCase() === 'axistitle'; }
  getMember(name: string): VBValue {
    if (name.toLowerCase() !== 'axistitle') throw new VBRuntimeError(438);
    return new ChartAxisTitle(this.id, this.titles);
  }
  setMember(): void { throw new VBRuntimeError(383); }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

class ChartAxisTitle implements VBObject {
  readonly vbTypeName = 'AxisTitle';
  readonly defaultMember = 'Text';
  constructor(private id: number, private titles: AxisTitles) {}
  hasMember(name: string): boolean { return name.toLowerCase() === 'text'; }
  getMember(name: string): VBValue {
    if (name.toLowerCase() !== 'text') throw new VBRuntimeError(438);
    return this.titles.get(this.id);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (name.toLowerCase() !== 'text') throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    this.titles.set(this.id, toStr(value));
  }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

// ---------------------------------------------------------------------------------------------------------------
// ChartData

/** A cell of ChartData: a string stays text (a label, or a number written as text), the rest is a number. */
function cellOf(v: VBValue): number | string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? -1 : 0;
  if (v instanceof EmptyT || v instanceof NullT) return 0;
  if (isDate(v)) return v.serial;
  throw new VBRuntimeError(13);   // an object, a record or an array
}

/**
 * ChartData = array. A 2-D array is rows x columns (any lower bounds); strings in its first row and first column are the labels.
 * A 1-D array is one series. Error 13 for anything else, 380 for an array that is empty or too large.
 */
export function chartFromArray(a: VBValue): ChartModel {
  if (!(a instanceof VBArray)) throw new VBRuntimeError(13);
  if (!a.allocated || a.size === 0) throw new VBRuntimeError(380);
  const b = a.bounds;
  let cells: (number | string)[][];
  if (b.length === 1) {
    cells = [];
    for (let i = b[0][0]; i <= b[0][1]; i++) { const v = cellOf(a.get([i])); cells.push([typeof v === 'string' ? Number(v) || 0 : v]); }
  } else if (b.length === 2) {
    cells = [];
    for (let i = b[0][0]; i <= b[0][1]; i++) {
      const row: (number | string)[] = [];
      for (let j = b[1][0]; j <= b[1][1]; j++) row.push(cellOf(a.get([i, j])));
      cells.push(row);
    }
  } else throw new VBRuntimeError(13);
  const m = chartFromMatrix(cells);
  if (m.rows < 1 || m.cols < 1 || m.rows > MAX_CHART_ROWS || m.cols > MAX_CHART_COLS) throw new VBRuntimeError(380);
  return m;
}

/** Reading ChartData: a 2-D Variant array (from 1) with the labels in the first row and column. */
export function chartToArray(m: ChartModel): VBArray {
  const cells = chartToMatrix(m);
  const a = new VBArray('Variant', [[1, cells.length], [1, cells[0].length]]);
  cells.forEach((row, i) => row.forEach((v, j) => a.set([i + 1, j + 1], v)));
  return a;
}
