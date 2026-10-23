// The cells of an MSFlexGrid (TextMatrix), kept in the run-time mirror. `cells` is row-major and is what the window
// gets; a change in place keeps the same array (one patch per flush, no copy per write), a resize makes a new one.

export const DEFAULT_COL_WIDTH = 975, DEFAULT_ROW_HEIGHT = 240, DEFAULT_ALIGN = 1;   // flexAlignLeftCenter

export class GridData {
  rows = 0;
  cols = 0;
  cells: string[] = [];
  colWidth: number[] = [];
  rowHeight: number[] = [];
  colAlign: number[] = [];

  constructor(rows: number, cols: number) { this.resize(rows, cols); }

  resize(rows: number, cols: number): void {
    const cells = new Array<string>(rows * cols).fill('');
    for (let r = 0; r < Math.min(rows, this.rows); r++) for (let c = 0; c < Math.min(cols, this.cols); c++) cells[r * cols + c] = this.cells[r * this.cols + c];
    const fit = (a: number[], n: number, d: number): number[] => Array.from({ length: n }, (_, i) => a[i] ?? d);
    this.colWidth = fit(this.colWidth, cols, DEFAULT_COL_WIDTH);
    this.colAlign = fit(this.colAlign, cols, DEFAULT_ALIGN);
    this.rowHeight = fit(this.rowHeight, rows, DEFAULT_ROW_HEIGHT);
    this.rows = rows; this.cols = cols; this.cells = cells;
  }

  has(r: number, c: number): boolean { return r >= 0 && r < this.rows && c >= 0 && c < this.cols; }
  get(r: number, c: number): string { return this.cells[r * this.cols + c]; }
  set(r: number, c: number, v: string): void { this.cells[r * this.cols + c] = v; }
}
