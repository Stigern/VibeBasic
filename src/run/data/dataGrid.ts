// The run-time side of the DataGrid (MSDATGRD.OCX): the records of its DataSource as a grid with column headers and a record
// selector column. The current row is the recordset's current record (a click moves the recordset, the data control's events
// follow); an edited cell is written to its field and the record is saved at once (VB6 saves when the row is left).
// AllowAddNew adds the "*" row, AllowDelete lets the Delete key remove the selected record. Columns(i) is 0-based, as in VB6.
//
// What the window gets: GridCols (one line per column: Caption|Width|Alignment|Locked), GridRows (one line per record, the cell
// texts), GridRow / GridCol (the current cell; -1 none). It reports the user's actions as UserAction (see controls/dataGrid).

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { formatValue } from '../../lang/builtins/format';
import { Empty, Null, NullT, VBArray, VBRef, isObject, toBool, toNumber, toStr, type VBValue } from '../../lang/values';
import { joinFields } from '../../model/fieldLines';
import type { PropValue } from '../../model/types';
import { userAction, type RichControl } from '../objects/richControl';
import type { DataControl } from './dataControl';
import type { RecordsetObject } from './recordset';

export interface GridHost {
  readonly props: Record<string, PropValue>;
  readonly name: string;
  raise(event: string, args: VBRef[]): Promise<void>;
  send(props: Record<string, PropValue>): void;
  /** The data control the DataSource names (null when there is none). */
  source(): DataControl | null;
  msgBox(prompt: string, buttons: number, title: string): Promise<number>;
}

interface Column { caption: string; field: string; width: number; alignment: number; visible: boolean; locked: boolean; numberFormat: string }

const COLUMN_PROPS = ['caption', 'datafield', 'width', 'alignment', 'visible', 'locked', 'numberformat', 'colindex', 'value', 'text'];
const locale = (): string => Intl.DateTimeFormat().resolvedOptions().locale;

/** A cell's text: Null and binary values are blank; NumberFormat applies Format. */
export function cellText(v: VBValue, numberFormat = ''): string {
  if (v instanceof NullT || v instanceof VBArray || isObject(v)) return '';
  return numberFormat ? formatValue(v, numberFormat, locale()) : toStr(v);
}

class ColumnObject implements VBObject {
  readonly vbTypeName = 'Column';
  readonly defaultMember = 'Value';
  constructor(private grid: DataGridControl, readonly index: number) {}
  private get col(): Column { return this.grid.column(this.index); }
  hasMember(name: string): boolean { return COLUMN_PROPS.includes(name.toLowerCase()); }
  getMember(name: string, args: VBValue[]): VBValue {
    if (args.length) throw new VBRuntimeError(450);
    const c = this.col;
    switch (name.toLowerCase()) {
      case 'caption': return c.caption;
      case 'datafield': return c.field;
      case 'width': return c.width;
      case 'alignment': return c.alignment;
      case 'visible': return c.visible;
      case 'locked': return c.locked;
      case 'numberformat': return c.numberFormat;
      case 'colindex': return this.index;
      case 'value': return this.grid.cellValue(this.index);
      case 'text': return cellText(this.grid.cellValue(this.index), c.numberFormat);
    }
    throw new VBRuntimeError(438);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void | Promise<void> {
    if (args.length) throw new VBRuntimeError(450);
    const c = this.col, l = name.toLowerCase();
    switch (l) {
      case 'caption': c.caption = toStr(value); break;
      case 'datafield': c.field = toStr(value); break;
      case 'width': { const n = toNumber(value); if (n < 0) throw new VBRuntimeError(380); c.width = n; break; }
      case 'alignment': { const n = toNumber(value); if (n < 0 || n > 3) throw new VBRuntimeError(380); c.alignment = n; break; }
      case 'visible': c.visible = toBool(value); break;
      case 'locked': c.locked = toBool(value); break;
      case 'numberformat': c.numberFormat = toStr(value); break;
      case 'value': case 'text': return this.grid.editCell(this.index, value);
      default: throw new VBRuntimeError(this.hasMember(l) ? 383 : 438);
    }
    this.grid.sendAll();
  }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

class ColumnsObject implements VBObject {
  readonly vbTypeName = 'Columns';
  readonly defaultMember = 'Item';
  constructor(private grid: DataGridControl) {}
  hasMember(name: string): boolean { return ['count', 'item'].includes(name.toLowerCase()); }
  getMember(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'count': if (args.length) throw new VBRuntimeError(450); return this.grid.columnCount();
      case 'item': {
        if (args.length !== 1) throw new VBRuntimeError(450);
        return this.grid.columnObject(args[0]);
      }
    }
    throw new VBRuntimeError(438);
  }
  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }
  callMethod(name: string, args: VBValue[]): VBValue { return this.getMember(name, args); }
  items(): VBObject[] { return Array.from({ length: this.grid.columnCount() }, (_, i) => this.grid.columnObject(i)); }
}

export class DataGridControl implements RichControl {
  private cols: Column[] = [];
  /** The fields the columns were made for (a new set of fields makes new columns). */
  private fieldsKey = '';
  private src: DataControl | null = null;
  private col = 0;
  private readonly columns = new ColumnsObject(this);
  private busy = false;

  constructor(private h: GridHost) {}

  private rs(): RecordsetObject | null { return (this.src ?? this.h.source())?.recordset() ?? null; }

  column(i: number): Column { return this.cols[i]; }
  columnCount(): number { return this.cols.length; }
  columnObject(key: VBValue): ColumnObject {
    let i: number;
    if (typeof key === 'string') i = this.cols.findIndex(c => c.field.toLowerCase() === key.toLowerCase() || c.caption.toLowerCase() === key.toLowerCase());
    else i = toNumber(key);
    if (!Number.isInteger(i) || i < 0 || i >= this.cols.length) throw new VBRuntimeError(6148, 'Invalid column index');
    return new ColumnObject(this, i);
  }

  /** The value of column i in the current record (Null when there is none). */
  cellValue(i: number): VBValue {
    const rs = this.rs(), c = this.cols[i];
    if (!rs || !c || !(rs.hasCurrent || rs.mode === 2)) return Null;
    try { return rs.fieldValue(rs.fieldIndex(c.field)); } catch { return Null; }
  }

  // -- what the window shows ------------------------------------------------------------------------------------------

  /** Columns for the recordset's fields (kept when the fields are the same, so captions and widths set by code stay). */
  private syncColumns(rs: RecordsetObject | null): void {
    const fields = rs?.columns.map(c => c.name) ?? [];
    const key = fields.join('\u0000');
    if (key === this.fieldsKey) return;
    this.fieldsKey = key;
    const w = Number(this.h.props.DefColWidth) || 1215;
    this.cols = fields.map(f => ({ caption: f, field: f, width: w, alignment: 3, visible: true, locked: false, numberFormat: '' }));
    this.col = Math.min(this.col, Math.max(0, this.cols.length - 1));
  }

  sendAll(): void {
    const rs = this.rs();
    const rows: string[] = [];
    if (rs) {
      const values = rs.rowValues();
      const idx = this.cols.map(c => rs.columns.findIndex(k => k.name.toLowerCase() === c.field.toLowerCase()));
      for (const r of values) rows.push(joinFields(this.cols.map((c, i) => (idx[i] < 0 ? '' : cellText(r[idx[i]], c.numberFormat)))));
    }
    const cols = this.cols.map(c => joinFields([c.caption, c.visible ? c.width : 0, c.alignment, c.locked ? 1 : 0]));
    Object.assign(this.h.props, { GridCols: cols, GridRows: rows });
    this.h.send({ GridCols: cols, GridRows: rows, ...this.cursor() });
  }

  /** GridRow / GridCol / GridEdit and the Row / Col properties from the recordset. */
  private cursor(): Record<string, PropValue> {
    const rs = this.rs();
    const row = rs && rs.mode === 2 ? rs.recordCount : rs?.hasCurrent ? rs.position : -1;
    const p = { GridRow: row, GridCol: this.col, GridEdit: rs?.mode === 2 ? 'add' : rs?.mode === 1 ? 'edit' : '' };
    Object.assign(this.h.props, p, { Row: Math.max(0, row), Col: this.col });
    return p;
  }

  dataNotify(src: DataControl, kind: 'reposition' | 'rows'): void {
    if (src.name.toLowerCase() !== String(this.h.props.DataSource ?? '').toLowerCase()) return;
    this.src = src;
    if (kind === 'rows') {
      this.syncColumns(src.recordset());
      this.sendAll();
    } else {
      const p = this.cursor();
      this.h.send(p);
    }
  }

  // -- user and code actions ------------------------------------------------------------------------------------------

  private async report(e: unknown): Promise<void> {
    if (!(e instanceof VBRuntimeError)) { console.error(e); return; }
    const response = new VBRef(1);
    await this.h.raise('Error', [new VBRef(e.number), response]);
    if (toNumber(response.value) !== 0) await this.h.msgBox(e.description, 48, '');
  }

  /** Makes record `row` (and column `col`) current; RowColChange when either changed. */
  private async goTo(row: number, col: number): Promise<void> {
    const rs = this.rs();
    if (!rs) return;
    const lastRow: VBValue = rs.hasCurrent ? rs.bookmarkAt(rs.position) : Null, lastCol = this.col;
    const newCol = Math.max(0, Math.min(col, this.cols.length - 1));
    let moved = false;
    if (row >= 0 && row < rs.recordCount && (row !== rs.position || rs.mode === 2)) { await rs.move('to', row); moved = rs.position === row; }
    this.col = newCol;
    this.h.send(this.cursor());
    if (moved || newCol !== lastCol) await this.h.raise('RowColChange', [new VBRef(lastRow), new VBRef(lastCol)]);
  }

  /** A new value for column `i` of the current record (an edited cell, Columns(i).Value = x): BeforeColUpdate (Cancel),
   *  AfterColUpdate, BeforeUpdate (Cancel), the record is saved, AfterUpdate. */
  async editCell(i: number, value: VBValue): Promise<void> {
    const rs = this.rs(), c = this.cols[i];
    if (!rs || !c) return;
    if (this.h.props.AllowUpdate === false || c.locked) throw new VBRuntimeError(3027);
    const old = this.cellValue(i);
    const cancel = new VBRef(0);
    await this.h.raise('BeforeColUpdate', [new VBRef(i), new VBRef(old), cancel]);
    if (toBool(cancel.value)) { this.sendAll(); return; }
    rs.setValues(new Map([[c.field, value]]));
    await this.h.raise('AfterColUpdate', [new VBRef(i)]);
    const cancel2 = new VBRef(0);
    await this.h.raise('BeforeUpdate', [cancel2]);
    if (toBool(cancel2.value)) { await rs.callMethod('CancelUpdate', []); this.sendAll(); return; }
    await rs.saveEdit();
    await this.h.raise('AfterUpdate', []);
  }

  /** Typing in the "*" row: a new record with that value. */
  private async addRow(i: number, text: string): Promise<void> {
    const rs = this.rs(), c = this.cols[i];
    if (!rs || !c || this.h.props.AllowAddNew !== true) return;
    await rs.startAddNew();
    if (rs.mode !== 2) return;
    rs.setValues(new Map([[c.field, text]]));
    await this.h.raise('AfterColUpdate', [new VBRef(i)]);
    await rs.saveEdit();
    if (rs.flavor === 'dao') await rs.move('to', rs.recordCount - 1);   // DAO stays on the old record: the grid shows the new one
    this.col = i;
    this.h.send(this.cursor());
    await this.h.raise('AfterInsert', []);
  }

  private async deleteRow(row: number): Promise<void> {
    const rs = this.rs();
    if (!rs || this.h.props.AllowDelete !== true || row < 0 || row >= rs.recordCount) return;
    if (row !== rs.position) await rs.move('to', row);
    const cancel = new VBRef(0);
    await this.h.raise('BeforeDelete', [cancel]);
    if (toBool(cancel.value)) return;
    await rs.remove();
    if (rs.recordCount) await rs.move('to', Math.min(row, rs.recordCount - 1));
    await this.h.raise('AfterDelete', []);
  }

  applyState(props: Record<string, PropValue>): void {
    const a = userAction(props);
    if (!a || this.busy) return;
    this.busy = true;
    const row = Number(a.row), col = Number(a.col);
    let work: Promise<void>;
    switch (a.verb) {
      case 'cell': work = this.goTo(row, col < 0 ? this.col : col); break;
      case 'edit': work = this.goTo(row, col).then(() => this.editCell(col, String(a.text ?? ''))); break;
      case 'add': work = this.addRow(col, String(a.text ?? '')); break;
      case 'delete': work = this.deleteRow(row); break;
      case 'head': work = this.h.raise('HeadClick', [new VBRef(col)]); break;
      default: work = Promise.resolve();
    }
    void work.catch(e => { this.sendAll(); return this.report(e); }).finally(() => { this.busy = false; });
  }

  get(name: string, args: VBValue[]): VBValue | undefined {
    switch (name) {
      case 'Columns': return args.length ? this.columnObject(args[0]) : this.columns;
      case 'Row': { const rs = this.rs(); return rs?.hasCurrent ? rs.position : 0; }
      case 'Col': return this.col;
      case 'Text': return cellText(this.cellValue(this.col), this.cols[this.col]?.numberFormat);
      case 'ApproxCount': case 'VisibleRows': return this.rs()?.recordCount ?? 0;
      case 'VisibleCols': return this.cols.filter(c => c.visible).length;
      case 'Bookmark': { const rs = this.rs(); return rs?.hasCurrent ? rs.bookmarkAt(rs.position) : Null; }
    }
    return undefined;
  }

  set(name: string, value: VBValue): boolean | Promise<void> {
    switch (name) {
      case 'Row': {
        const rs = this.rs(), n = toNumber(value);
        if (!rs || n < 0 || n >= rs.recordCount) throw new VBRuntimeError(6148, 'Invalid row number');
        return this.goTo(n, this.col);
      }
      case 'Col': {
        const n = toNumber(value);
        if (n < 0 || n >= this.cols.length) throw new VBRuntimeError(6148, 'Invalid column index');
        return this.goTo(-1, n);
      }
      case 'Text': return this.editCell(this.col, value);
    }
    return false;
  }

  call(name: string): VBValue | Promise<VBValue> | undefined {
    if (name === 'rebind') {
      this.fieldsKey = '\u0001';
      const src = this.h.source();
      if (src) this.src = src;
      this.syncColumns(this.rs());
      this.sendAll();
      return Empty;
    }
    if (name === 'refresh') { this.sendAll(); return Empty; }
    return undefined;
  }

  dispose(): void { /* nothing held */ }
}
