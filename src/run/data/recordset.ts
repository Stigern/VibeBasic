// The Recordset object of the Data control (DAO), the ADO Data Control and Database.OpenRecordset / Connection.Execute: the
// rows of a query held in memory, a current record, and writes through parameterised SQL (by rowid).
//
// - A table name as the source reads `SELECT rowid, * FROM table`; a simple one-table SELECT gets the rowid added. Other
//   queries (joins, GROUP BY, views, tables without a rowid) give a read-only recordset (3027 on AddNew / Edit / Delete).
// - Positions: BOF before the first record, EOF after the last; both are True for an empty recordset.
// - DAO: Field values can be set only after Edit or AddNew (3020); moving without Update drops the changes. ADO: setting a
//   value starts the edit, and moving saves it (Update). After AddNew + Update the new record is current in ADO; DAO goes back
//   to the record that was current before AddNew (LastModified is the new one).
// - An owner (Data control, Adodc) is asked before every change of record (Validate / WillMove, and the saving of the bound
//   controls) and told afterwards (Reposition / MoveComplete, the bound controls show the record).

import type { OutSlot, VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, Nothing, Null, VBArray, coerce, toNumber, toStr, type VBValue } from '../../lang/values';
import type { DbValue } from '../../backend/backend';
import type { DbConnection } from './dbSession';
import { compileCriteria } from './criteria';
import { fieldKind, fieldSize, fieldTypeNumber, sameDb, toDb, toVB, type FieldKind } from './dbValues';

export type Flavor = 'dao' | 'ado';

/** The DAO vbDataAction* numbers: what an owner is told is about to happen. */
export const ACT = { cancel: 0, moveFirst: 1, movePrevious: 2, moveNext: 3, moveLast: 4, addNew: 5, update: 6, delete: 7, find: 8, bookmark: 9, close: 10, unload: 11 } as const;

export interface RecordsetOwner {
  /** Before a change of record (or Update / Delete / Close): false cancels it. The owner may write the bound controls' changes
   *  (`writeValues`, or `setValues` before an Update). */
  before(rs: RecordsetObject, action: number): Promise<boolean>;
  /** After it: `moved` when another record became current (Reposition / MoveComplete); the bound controls show the record. */
  after(rs: RecordsetObject, action: number, moved: boolean): Promise<void>;
  /** Records were added, changed or removed (DataGrid, DataList). */
  rowsChanged(rs: RecordsetObject): void;
}

export interface Column { name: string; decl: string; kind: FieldKind; /** The table column it writes to; null: not updatable. */ target: string | null }
interface Row { rowid: number | null; bm: number; values: DbValue[] }

const ROWID = '__vbrowid';
let bookmarkSeq = 0;

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
/** `[Order Details]`, `"x"` or `` `x` `` without the quotes. */
const unquote = (s: string): string => (/^\[.*\]$|^".*"$|^`.*`$/s.test(s) ? s.slice(1, -1) : s);

const SQL_START = /^\s*(select|with|values|pragma)\b/i;
const IDENT = String.raw`(?:"[^"]+"|\[[^\]]+\]|\x60[^\x60]+\x60|[\p{L}_][\p{L}\p{N}_]*)`;
const SIMPLE_SELECT = new RegExp(
  String.raw`^\s*select\s+(?!distinct\b|all\b)([\s\S]+?)\s+from\s+(${IDENT})(?:\s+(?:as\s+)?(?!(?:where|order|limit|group|join|inner|left|right|cross|natural|union|having)\b)([\p{L}_][\p{L}\p{N}_]*))?\s*((?:where|order\s+by|limit)\b[\s\S]*)?;?\s*$`, 'iu');
const AGGREGATE = /\b(count|sum|avg|min|max|total|group_concat)\s*\(|\bgroup\s+by\b|\bunion\b|\bjoin\b/i;

/** How a RecordSource is read: the SQL, and the table that SQL can write to (with the rowid added) when there is one. */
export function plan(source: string, commandType = 8): { sql: string; withRowid: string | null; table: string | null } {
  const s = source.trim().replace(/;\s*$/, '');
  const isTable = commandType === 2 || (commandType !== 1 && !SQL_START.test(s));
  if (isTable) {
    const t = unquote(s);
    return { sql: `SELECT * FROM ${quoteIdent(t)}`, withRowid: `SELECT rowid AS ${ROWID}, * FROM ${quoteIdent(t)}`, table: t };
  }
  const m = SIMPLE_SELECT.exec(s);
  if (!m || AGGREGATE.test(s)) return { sql: s, withRowid: null, table: null };
  const [, , tableTok, alias, rest] = m;
  const fromAt = s.length - (rest?.length ?? 0);
  const head = s.slice(0, fromAt);
  const rewritten = head.replace(/^\s*select\s+/i, `SELECT ${alias ?? tableTok}.rowid AS ${ROWID}, `) + (rest ?? '');
  return { sql: s, withRowid: rewritten, table: unquote(tableTok) };
}

// ---------------------------------------------------------------------------------------------------------------

export class FieldObject implements VBObject {
  readonly vbTypeName = 'Field';
  readonly defaultMember = 'Value';
  constructor(private rs: RecordsetObject, readonly index: number) {}

  private get col(): Column { return this.rs.columns[this.index]; }

  hasMember(name: string): boolean {
    return ['value', 'name', 'type', 'size', 'definedsize', 'actualsize', 'originalvalue', 'underlyingvalue', 'ordinalposition',
      'sourcefield', 'sourcetable', 'dataupdatable'].includes(name.toLowerCase());
  }

  getMember(name: string, args: VBValue[]): VBValue {
    if (args.length) throw new VBRuntimeError(450);
    const c = this.col, ado = this.rs.flavor === 'ado';
    switch (name.toLowerCase()) {
      case 'value': return this.rs.fieldValue(this.index);
      case 'name': return c.name;
      case 'type': return fieldTypeNumber(this.rs.kindOf(this.index), ado);
      case 'size': case 'definedsize': return fieldSize(c.kind, c.decl);
      case 'actualsize': { const v = this.rs.fieldValue(this.index); return v === Null ? 0 : toStr(v).length; }
      case 'originalvalue': case 'underlyingvalue': return this.rs.storedValue(this.index);
      case 'ordinalposition': return this.index;
      case 'sourcefield': return c.target ?? c.name;
      case 'sourcetable': return this.rs.table ?? '';
      case 'dataupdatable': return !this.rs.readOnly && c.target !== null;
    }
    throw new VBRuntimeError(438);
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (name.toLowerCase() !== 'value') throw new VBRuntimeError(this.hasMember(name) ? 383 : 438);
    if (args.length) throw new VBRuntimeError(450);
    this.rs.setField(this.index, value);
  }

  callMethod(name: string): VBValue {
    throw new VBRuntimeError(name.toLowerCase() === 'value' ? 450 : 438);
  }
}

export class FieldsObject implements VBObject {
  readonly vbTypeName = 'Fields';
  readonly defaultMember = 'Item';
  constructor(private rs: RecordsetObject) {}
  hasMember(name: string): boolean { return ['count', 'item'].includes(name.toLowerCase()); }
  getMember(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'count': if (args.length) throw new VBRuntimeError(450); return this.rs.columns.length;
      case 'item': if (args.length !== 1) throw new VBRuntimeError(450); return this.rs.field(args[0]);
    }
    throw new VBRuntimeError(438);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (name.toLowerCase() === 'item' && args.length === 1) { this.rs.setField(this.rs.fieldIndex(args[0]), value); return; }
    throw new VBRuntimeError(this.hasMember(name) ? 383 : 438);
  }
  callMethod(name: string, args: VBValue[]): VBValue {
    if (name.toLowerCase() === 'refresh') return Empty;
    return this.getMember(name, args);
  }
  items(): VBObject[] { return this.rs.columns.map((_, i) => new FieldObject(this.rs, i)); }
}

// ---------------------------------------------------------------------------------------------------------------

const DAO_PROPS = ['bof', 'eof', 'recordcount', 'absoluteposition', 'bookmark', 'lastmodified', 'editmode', 'nomatch', 'fields', 'name',
  'updatable', 'type', 'percentposition'];
const ADO_PROPS = ['bof', 'eof', 'recordcount', 'absoluteposition', 'bookmark', 'editmode', 'fields', 'source', 'state', 'activeconnection',
  'cursortype', 'locktype', 'cursorlocation', 'maxrecords'];
const DAO_METHODS = ['movefirst', 'movelast', 'movenext', 'moveprevious', 'move', 'addnew', 'edit', 'update', 'cancelupdate', 'delete',
  'requery', 'close', 'findfirst', 'findlast', 'findnext', 'findprevious', 'getrows'];
const ADO_METHODS = ['movefirst', 'movelast', 'movenext', 'moveprevious', 'move', 'addnew', 'update', 'cancelupdate', 'delete',
  'requery', 'close', 'find', 'getrows'];
const WRITABLE = new Set(['absoluteposition', 'bookmark']);

export interface RecordsetOptions {
  flavor: Flavor;
  /** Data control ReadOnly / a snapshot: no writes. */
  readOnly?: boolean;
  /** ADO CommandType: adCmdText 1, adCmdTable 2, adCmdUnknown 8. */
  commandType?: number;
  owner?: RecordsetOwner;
  /** ADO: the Connection object Recordset.ActiveConnection returns. */
  connection?: () => VBObject;
}

export class RecordsetObject implements VBObject {
  readonly vbTypeName = 'Recordset';
  readonly defaultMember = 'Fields';
  readonly flavor: Flavor;
  columns: Column[] = [];
  private rows: Row[] = [];
  /** -1 BOF, rows.length EOF. After Delete it is where the deleted record was (`deleted`). */
  private pos = -1;
  private deleted = false;
  /** 0 none, 1 Edit, 2 AddNew. */
  private editMode = 0;
  private buffer = new Map<number, DbValue>();
  private noMatch = false;
  private lastModified: number | null = null;
  private closed = false;
  table: string | null = null;
  readOnly: boolean;
  private sql = '';
  private readonly fields = new FieldsObject(this);
  owner: RecordsetOwner | undefined;

  private constructor(readonly conn: DbConnection, readonly source: string, private readonly opts: RecordsetOptions) {
    this.flavor = opts.flavor;
    this.readOnly = opts.readOnly === true;
    this.owner = opts.owner;
  }

  /** Runs the query of `source` (a table name or SQL). Errors are the database's (3078 table not found ...). */
  static async open(conn: DbConnection, source: string, opts: RecordsetOptions): Promise<RecordsetObject> {
    const rs = new RecordsetObject(conn, source, opts);
    await rs.load();
    return rs;
  }

  /** A closed recordset (Connection.Execute of a statement that returns no rows). */
  static closedOne(conn: DbConnection, opts: RecordsetOptions): RecordsetObject {
    const rs = new RecordsetObject(conn, '', opts);
    rs.closed = true;
    return rs;
  }

  private async load(): Promise<void> {
    const p = plan(this.source, this.opts.commandType);
    let res = null;
    if (p.withRowid) {
      try { res = await this.conn.query(p.withRowid); } catch { res = null; }
    }
    let writable = res !== null;
    if (!res) res = await this.conn.query(p.sql);
    this.sql = writable ? p.withRowid! : p.sql;
    this.table = writable ? p.table : null;
    if (!writable) this.readOnly = true;
    let targets = new Map<string, string>();
    if (writable && this.table) {
      try {
        const info = await this.conn.query(`PRAGMA table_info(${quoteIdent(this.table)})`);
        const ni = info.columns.indexOf('name');
        targets = new Map(info.rows.map(r => [String(r[ni]).toLowerCase(), String(r[ni])]));
      } catch { writable = false; this.readOnly = true; }
    }
    const skip = res.columns[0] === ROWID ? 1 : 0;
    this.columns = res.columns.slice(skip).map((name, i) => {
      const decl = res!.types[i + skip] ?? '';
      return { name, decl, kind: fieldKind(decl), target: targets.get(name.toLowerCase()) ?? null };
    });
    this.rows = res.rows.map(r => ({ rowid: skip ? Number(r[0]) : null, bm: ++bookmarkSeq, values: r.slice(skip) }));
    this.pos = this.rows.length ? 0 : -1;
    this.deleted = false;
    this.editMode = 0;
    this.buffer.clear();
  }

  // -- state --------------------------------------------------------------------------------------------------------

  get isClosed(): boolean { return this.closed; }
  get recordCount(): number { return this.rows.length; }
  get position(): number { return this.pos; }
  get mode(): number { return this.editMode; }
  get bof(): boolean { return this.rows.length === 0 || this.pos < 0; }
  get eof(): boolean { return this.rows.length === 0 || this.pos >= this.rows.length; }
  /** A record is current (not BOF / EOF, not deleted). */
  get hasCurrent(): boolean { return !this.deleted && this.pos >= 0 && this.pos < this.rows.length; }

  private checkOpen(): void {
    if (this.closed) throw new VBRuntimeError(this.flavor === 'ado' ? 3704 : 3420);
  }

  private current(): Row {
    this.checkOpen();
    if (this.deleted) throw new VBRuntimeError(3167);
    if (!this.hasCurrent) throw new VBRuntimeError(3021);
    return this.rows[this.pos];
  }

  /** The values of every record as VB values (DataGrid, DataList), in record order. */
  rowValues(): VBValue[][] {
    return this.rows.map(r => r.values.map((v, i) => toVB(v, this.kindOf(i))));
  }

  /** The kind of a column; an expression column takes it from its first value. */
  kindOf(i: number): FieldKind {
    const c = this.columns[i];
    if (c.kind !== 'variant') return c.kind;
    const v = this.rows.find(r => r.values[i] !== null)?.values[i];
    return typeof v === 'number' ? (Number.isInteger(v) ? 'long' : 'double') : typeof v === 'object' && v !== null ? 'binary' : c.kind;
  }

  // -- fields -------------------------------------------------------------------------------------------------------

  fieldIndex(key: VBValue): number {
    this.checkOpen();
    if (typeof key === 'string') {
      const l = key.toLowerCase();
      const i = this.columns.findIndex(c => c.name.toLowerCase() === l);
      if (i < 0) throw new VBRuntimeError(3265);
      return i;
    }
    const i = toNumber(key);
    if (!Number.isInteger(i) || i < 0 || i >= this.columns.length) throw new VBRuntimeError(3265);
    return i;
  }

  field(key: VBValue): FieldObject { return new FieldObject(this, this.fieldIndex(key)); }

  /** The field's value: the edit buffer during Edit / AddNew, else the current record (3021 when there is none). */
  fieldValue(i: number): VBValue {
    this.checkOpen();
    if (this.editMode === 2) return this.buffer.has(i) ? toVB(this.buffer.get(i)!, this.columns[i].kind) : Null;
    const r = this.current();
    return toVB(this.buffer.has(i) ? this.buffer.get(i)! : r.values[i], this.kindOf(i));
  }

  /** The value as stored (Field.OriginalValue). */
  storedValue(i: number): VBValue {
    if (this.editMode === 2) return Null;
    return toVB(this.current().values[i], this.kindOf(i));
  }

  private checkWritable(i?: number): void {
    this.checkOpen();
    if (this.readOnly || !this.table) throw new VBRuntimeError(3027);
    if (i !== undefined && this.columns[i].target === null) throw new VBRuntimeError(3164);
  }

  /** The fields (by name) can be written: the recordset is updatable and each one is a column of its table. */
  canWrite(names: string[]): boolean {
    if (this.closed || this.readOnly || !this.table) return false;
    return names.every(n => {   // an unknown name is left to setValues (3265)
      const c = this.columns.find(col => col.name.toLowerCase() === n.toLowerCase());
      return c === undefined || c.target !== null;
    });
  }

  /** Field.Value = v. DAO needs Edit / AddNew first (3020); ADO starts the edit. */
  setField(i: number, value: VBValue): void {
    this.checkWritable(i);
    if (this.editMode === 0) {
      if (this.flavor === 'dao') throw new VBRuntimeError(3020);
      this.current();
      this.editMode = 1;
    }
    this.buffer.set(i, toDb(value, this.columns[i].kind));
  }

  /** Values by field name into the edit buffer, starting an Edit when none is in progress (the bound controls' changes). */
  setValues(values: Map<string, VBValue>): void {
    if (!values.size) return;
    this.checkWritable();
    if (this.editMode === 0) { this.current(); this.editMode = 1; }
    for (const [name, v] of values) {
      const i = this.columns.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
      if (i < 0) throw new VBRuntimeError(3265);
      if (this.columns[i].target === null) throw new VBRuntimeError(3164);
      this.buffer.set(i, toDb(v, this.columns[i].kind));
    }
  }

  /** setValues, then the record is saved (a move with changed bound controls, Data1.UpdateRecord). */
  async writeValues(values: Map<string, VBValue>): Promise<void> {
    this.setValues(values);
    if (this.editMode !== 0) await this.commit();
  }

  // -- writing ------------------------------------------------------------------------------------------------------

  /** The record as stored, read again by its rowid, in this recordset's column order. */
  private async refetch(rowid: number, old: DbValue[] | null): Promise<DbValue[]> {
    const res = await this.conn.query(`SELECT * FROM ${quoteIdent(this.table!)} WHERE rowid = ?`, [rowid]);
    const row = res.rows[0];
    if (!row) return old ?? this.columns.map(() => null);
    return this.columns.map((c, i) => {
      if (c.target === null) return old?.[i] ?? null;
      const k = res.columns.findIndex(n => n.toLowerCase() === c.target!.toLowerCase());
      return k >= 0 ? row[k] : old?.[i] ?? null;
    });
  }

  /** Writes the edit buffer: INSERT for AddNew, UPDATE of the changed fields for Edit. The edit stays when it fails. */
  private async commit(): Promise<void> {
    const t = quoteIdent(this.table!);
    const entries = [...this.buffer.entries()];
    if (this.editMode === 2) {
      const sql = entries.length
        ? `INSERT INTO ${t} (${entries.map(([i]) => quoteIdent(this.columns[i].target!)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`
        : `INSERT INTO ${t} DEFAULT VALUES`;
      const r = await this.conn.execute(sql, entries.map(([, v]) => v));
      const row: Row = { rowid: r.lastInsertRowid, bm: ++bookmarkSeq, values: await this.refetch(r.lastInsertRowid, null) };
      this.rows.push(row);
      this.lastModified = row.bm;
      // ADO: the new record is current. DAO: the record current before AddNew stays (from EOF or an empty recordset, the new one)
      if (this.flavor === 'ado' || this.pos < 0 || this.pos === this.rows.length - 1) { this.pos = this.rows.length - 1; this.deleted = false; }
    } else if (this.editMode === 1) {
      const row = this.current();
      const changed = entries.filter(([i, v]) => !sameDb(row.values[i], v));
      if (changed.length) {
        await this.conn.execute(`UPDATE ${t} SET ${changed.map(([i]) => `${quoteIdent(this.columns[i].target!)} = ?`).join(', ')} WHERE rowid = ?`,
          [...changed.map(([, v]) => v), row.rowid]);
        row.values = await this.refetch(row.rowid!, row.values);
      }
      this.lastModified = row.bm;
    }
    this.editMode = 0;
    this.buffer.clear();
    this.owner?.rowsChanged(this);
  }

  /** Before a move: ADO saves an edit in progress, DAO drops it. A new record nothing was put in is dropped (no blank row). */
  private async settle(): Promise<void> {
    if (this.editMode === 0) return;
    if (this.flavor === 'ado' && !this.dropEmptyAdd()) await this.commit();
    else { this.editMode = 0; this.buffer.clear(); }
  }

  /** AddNew without a value set: the new record is dropped (true), as VB6 does on a move or an Unload. */
  dropEmptyAdd(): boolean {
    if (this.editMode !== 2 || this.buffer.size > 0) return false;
    this.editMode = 0;
    return true;
  }

  // -- moving -------------------------------------------------------------------------------------------------------

  /** Moves to the record `target()` gives (it is worked out after the owner's Validate and the saving of an edit). */
  private async moveTo(action: number, target: () => number): Promise<void> {
    this.checkOpen();
    if (this.editMode === 0) target();   // 3021 before any event
    if (this.owner && !(await this.owner.before(this, action))) return;
    await this.settle();
    const p = target();
    this.pos = Math.max(-1, Math.min(this.rows.length, p));
    this.deleted = false;
    await this.owner?.after(this, action, true);
  }

  /** After Delete the next record is the one that took the deleted one's place. */
  private nextPos(): number {
    if (this.deleted) return this.pos;
    if (this.eof) throw new VBRuntimeError(3021);
    return this.pos + 1;
  }
  private prevPos(): number {
    if (!this.deleted && this.bof) throw new VBRuntimeError(3021);
    return this.pos - 1;
  }
  private endPos(last: boolean): number {
    if (this.rows.length === 0) throw new VBRuntimeError(3021);
    return last ? this.rows.length - 1 : 0;
  }

  /** Move n [, start]: from the current record (ADO Start: adBookmarkFirst 1, adBookmarkLast 2, or a bookmark). */
  private movePos(n: number, start: VBValue | undefined): number {
    let from = this.pos;
    if (start !== undefined && start !== Empty) {
      const s = toNumber(start);
      if (this.flavor === 'ado' && s === 1) from = 0;
      else if (this.flavor === 'ado' && s === 2) from = this.rows.length - 1;
      else if (!(this.flavor === 'ado' && s === 0)) from = this.indexOfBookmark(start);
    } else {
      if (n > 0 && this.eof) throw new VBRuntimeError(3021);
      if (n < 0 && this.bof) throw new VBRuntimeError(3021);
      if (n === 0) this.current();
    }
    return from + n;
  }

  private indexOfBookmark(bm: VBValue): number {
    const n = toNumber(bm);
    const i = this.rows.findIndex(r => r.bm === n);
    if (i < 0) throw new VBRuntimeError(3159);
    return i;
  }

  // -- finding ------------------------------------------------------------------------------------------------------

  /** The first record from `from` in `step` direction that matches; -1 when none does. */
  private search(criteria: string, from: number, step: 1 | -1): number {
    const test = compileCriteria(criteria);
    for (let i = from; i >= 0 && i < this.rows.length; i += step) {
      const row = this.rows[i];
      const field = (name: string): VBValue => {
        const k = this.columns.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
        if (k < 0) throw new VBRuntimeError(3070, `The database engine does not recognize '${name}' as a valid field name or expression.`);
        return toVB(row.values[k], this.kindOf(k));
      };
      if (test(field)) return i;
    }
    return -1;
  }

  /** DAO FindFirst / FindLast / FindNext / FindPrevious: NoMatch, and the current record stays when nothing matches. */
  private async daoFind(kind: string, criteria: string): Promise<void> {
    this.checkOpen();
    if (this.rows.length === 0) { this.noMatch = true; return; }
    const cur = this.pos;
    const [from, step]: [number, 1 | -1] = kind === 'findfirst' ? [0, 1] : kind === 'findlast' ? [this.rows.length - 1, -1]
      : kind === 'findnext' ? [this.deleted ? cur : cur + 1, 1] : [cur - 1, -1];
    const i = this.search(criteria, Math.max(0, Math.min(from, this.rows.length)), step);
    this.noMatch = i < 0;
    if (i >= 0) await this.moveTo(ACT.find, () => i);
  }

  /** ADO Find criteria, [SkipRows], [SearchDirection], [Start]: from the current record; EOF (or BOF backwards) when nothing matches. */
  private async adoFind(args: VBValue[]): Promise<void> {
    this.checkOpen();
    const criteria = toStr(args[0]);
    const skip = args[1] !== undefined && args[1] !== Empty ? toNumber(args[1]) : 0;
    const dir: 1 | -1 = args[2] !== undefined && args[2] !== Empty && toNumber(args[2]) === -1 ? -1 : 1;
    let from = this.pos;
    if (args[3] !== undefined && args[3] !== Empty) {
      const s = toNumber(args[3]);
      from = s === 1 ? 0 : s === 2 ? this.rows.length - 1 : s === 0 ? this.pos : this.indexOfBookmark(args[3]);
    } else {
      if (dir === 1 ? this.eof && !this.deleted : this.bof) throw new VBRuntimeError(3021);
      if (dir === 1 && from < 0) from = 0;
    }
    from += skip * dir;
    const i = this.search(criteria, from, dir);
    await this.moveTo(ACT.find, () => (i >= 0 ? i : dir === 1 ? this.rows.length : -1));
  }

  // -- VBObject -----------------------------------------------------------------------------------------------------

  hasMember(name: string): boolean {
    return (this.flavor === 'ado' ? ADO_PROPS : DAO_PROPS).includes(name.toLowerCase());
  }

  private isMethod(l: string): boolean { return (this.flavor === 'ado' ? ADO_METHODS : DAO_METHODS).includes(l); }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (this.isMethod(l)) return this.callMethod(name, args) as VBValue;
    if (!this.hasMember(l)) throw new VBRuntimeError(438);
    if (l === 'fields') {
      this.checkOpen();
      return args.length ? (args.length === 1 ? this.field(args[0]) : (() => { throw new VBRuntimeError(450); })()) : this.fields;
    }
    if (args.length) throw new VBRuntimeError(450);
    if (l === 'state') return this.closed ? 0 : 1;
    if (l === 'activeconnection') return this.opts.connection?.() ?? Nothing;
    if (l === 'source' || l === 'name') return this.source;
    this.checkOpen();
    const ado = this.flavor === 'ado';
    switch (l) {
      case 'bof': return this.bof;
      case 'eof': return this.eof;
      case 'recordcount': return this.rows.length;
      case 'absoluteposition':
        if (ado) return this.rows.length === 0 ? -1 : this.bof ? -2 : this.eof ? -3 : this.pos + 1;
        return this.hasCurrent ? this.pos : -1;
      case 'percentposition': return this.hasCurrent && this.rows.length ? ((this.pos + 1) / this.rows.length) * 100 : 0;
      case 'bookmark': return this.current().bm;
      case 'lastmodified':
        if (this.lastModified === null) throw new VBRuntimeError(3021);
        return this.lastModified;
      case 'editmode': return this.editMode;
      case 'nomatch': return this.noMatch;
      case 'updatable': return !this.readOnly && this.table !== null;
      case 'type': return this.readOnly ? 4 : 2;   // dbOpenSnapshot / dbOpenDynaset
      case 'cursortype': return 3;                 // adOpenStatic
      case 'locktype': return this.readOnly ? 1 : 3;   // adLockReadOnly / adLockOptimistic
      case 'cursorlocation': return 3;             // adUseClient
      case 'maxrecords': return 0;
    }
    throw new VBRuntimeError(438);
  }

  setMember(name: string, args: VBValue[], value: VBValue): void | Promise<void> {
    const l = name.toLowerCase();
    if (l === 'fields' && args.length === 1) { this.setField(this.fieldIndex(args[0]), value); return; }
    if (!this.hasMember(l)) throw new VBRuntimeError(438);
    if (!WRITABLE.has(l)) throw new VBRuntimeError(383);
    if (args.length) throw new VBRuntimeError(450);
    this.checkOpen();
    if (l === 'bookmark') { const i = this.indexOfBookmark(value); return this.moveTo(ACT.bookmark, () => i); }
    const n = toNumber(value) - (this.flavor === 'ado' ? 1 : 0);
    if (!Number.isInteger(n) || n < 0 || n >= this.rows.length) throw new VBRuntimeError(3001, 'Invalid argument.');
    return this.moveTo(ACT.bookmark, () => n);
  }

  callMethod(name: string, args: VBValue[], _refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue> {
    const l = name.toLowerCase();
    if (!this.isMethod(l)) {
      if (this.hasMember(l)) return this.getMember(name, args);
      throw new VBRuntimeError(438);
    }
    const done = (p: Promise<void>): Promise<VBValue> => p.then(() => Empty);
    switch (l) {
      case 'movefirst': return done(this.moveTo(ACT.moveFirst, () => this.endPos(false)));
      case 'movelast': return done(this.moveTo(ACT.moveLast, () => this.endPos(true)));
      case 'movenext': return done(this.moveTo(ACT.moveNext, () => this.nextPos()));
      case 'moveprevious': return done(this.moveTo(ACT.movePrevious, () => this.prevPos()));
      case 'move': {
        if (args.length < 1 || args.length > 2) throw new VBRuntimeError(450);
        const n = toNumber(coerce(args[0], 'Long'));
        return done(this.moveTo(ACT.bookmark, () => this.movePos(n, args[1])));
      }
      case 'addnew': return done(this.addNew());
      case 'edit': {
        this.checkWritable();
        this.current();
        this.editMode = 1;
        this.buffer.clear();
        return Empty;
      }
      case 'update': return done(this.update());
      case 'cancelupdate': return done(this.cancelUpdate());
      case 'delete': return done(this.deleteCurrent());
      case 'requery': return done(this.requery());
      case 'close': return done(this.close());
      case 'findfirst': case 'findlast': case 'findnext': case 'findprevious':
        if (args.length !== 1) throw new VBRuntimeError(450);
        return done(this.daoFind(l, toStr(args[0])));
      case 'find':
        if (args.length < 1 || args.length > 4) throw new VBRuntimeError(450);
        return done(this.adoFind(args));
      case 'getrows': return this.getRows(args);
    }
    throw new VBRuntimeError(438);
  }

  /** GetRows [Rows]: the next Rows records (all that are left) from the current one as a Variant array (field, record); the
   *  record after them becomes current. 3021 at EOF. */
  private async getRows(args: VBValue[]): Promise<VBValue> {
    this.checkOpen();
    if (args.length > 1) throw new VBRuntimeError(450);
    if (!this.hasCurrent) throw new VBRuntimeError(3021);
    const want = args.length && args[0] !== Empty ? toNumber(coerce(args[0], 'Long')) : -1;
    const from = this.pos, n = Math.max(0, Math.min(want < 0 ? Infinity : want, this.rows.length - from));
    if (n === 0) throw new VBRuntimeError(3021);
    const out = new VBArray('Variant', [[0, this.columns.length - 1], [0, n - 1]]);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < this.columns.length; c++) out.set([c, r], toVB(this.rows[from + r].values[c], this.kindOf(c)));
    }
    await this.moveTo(ACT.bookmark, () => from + n);
    return out;
  }

  private async addNew(): Promise<void> {
    this.checkWritable();
    if (this.owner && !(await this.owner.before(this, ACT.addNew))) return;
    await this.settle();
    this.editMode = 2;
    this.buffer.clear();
    await this.owner?.after(this, ACT.addNew, true);
  }

  private async update(): Promise<void> {
    this.checkOpen();
    if (this.owner && !(await this.owner.before(this, ACT.update))) return;
    if (this.editMode === 0) {
      if (this.flavor === 'dao') throw new VBRuntimeError(3020);
      return;
    }
    const added = this.editMode === 2;
    await this.commit();
    await this.owner?.after(this, ACT.update, added);
  }

  private async cancelUpdate(): Promise<void> {
    this.checkOpen();
    if (this.editMode === 0) {
      if (this.flavor === 'dao') throw new VBRuntimeError(3020);
      return;
    }
    const added = this.editMode === 2;
    this.editMode = 0;
    this.buffer.clear();
    await this.owner?.after(this, ACT.cancel, added);
  }

  private async deleteCurrent(): Promise<void> {
    this.checkWritable();
    const row = this.current();
    if (this.owner && !(await this.owner.before(this, ACT.delete))) return;
    this.editMode = 0;
    this.buffer.clear();
    await this.conn.execute(`DELETE FROM ${quoteIdent(this.table!)} WHERE rowid = ?`, [row.rowid]);
    const i = this.rows.indexOf(row);
    if (i >= 0) { this.rows.splice(i, 1); this.pos = i; }
    this.deleted = true;
    this.owner?.rowsChanged(this);
    await this.owner?.after(this, ACT.delete, false);
  }

  /** The query again: the first record is current. */
  async requery(): Promise<void> {
    this.checkOpen();
    await this.load();
    this.owner?.rowsChanged(this);
    await this.owner?.after(this, ACT.cancel, true);
  }

  async close(): Promise<void> {
    if (this.closed) { if (this.flavor === 'ado') throw new VBRuntimeError(3704); return; }
    if (this.owner && !(await this.owner.before(this, ACT.close))) return;
    this.closed = true;
    this.editMode = 0;
    this.buffer.clear();
    this.rows = [];
    this.owner?.rowsChanged(this);
  }

  /** Moves for the owner's own buttons and the DataGrid (the same events as code). */
  move(kind: 'first' | 'previous' | 'next' | 'last' | 'to', at = 0): Promise<void> {
    switch (kind) {
      case 'first': return this.moveTo(ACT.moveFirst, () => this.endPos(false));
      case 'last': return this.moveTo(ACT.moveLast, () => this.endPos(true));
      case 'next': return this.moveTo(ACT.moveNext, () => this.nextPos());
      case 'previous': return this.moveTo(ACT.movePrevious, () => this.prevPos());
      case 'to': return this.moveTo(ACT.bookmark, () => at);
    }
  }
  startAddNew(): Promise<void> { return this.addNew(); }
  saveEdit(): Promise<void> { return this.update(); }
  remove(): Promise<void> { return this.deleteCurrent(); }
  /** Bookmark of record i (0-based). */
  bookmarkAt(i: number): number { return this.rows[i]?.bm ?? 0; }
}
