// The run-time side of the Data control (DAO) and the ADO Data Control (Adodc): the database and recordset they open, the arrow
// buttons, the events (Validate / Reposition / Error; WillMove / MoveComplete / Error) and the data binding of the form's
// controls whose DataSource names them (they show the current record; their changes are saved on a move, on Update and when
// the form unloads).
//
// The recordset opens after Form_Load (an error then raises the Error event and shows a message unless the handler says not
// to), or earlier when code uses Recordset / Database, and again on Refresh. DatabaseName, or the Data Source of the
// ConnectionString, is a SQLite file relative to App.Path (VB6's .mdb files are not readable); a missing file is created.

import type { PropValue } from '../../model/types';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, Nothing, VBRef, toBool, toNumber, toStr, type VBValue } from '../../lang/values';
import type { RichControl } from '../objects/richControl';
import { userAction } from '../objects/richControl';
import type { DbConnection, DbSession } from './dbSession';
import { ConnectionObject, DatabaseObject, dataSourceOf } from './dbObjects';

export { dataSourceOf };
import { ACT, RecordsetObject, type Flavor, type RecordsetOwner } from './recordset';

/** A control of the form as the data control sees it (see ControlObject). */
export interface DataConsumer {
  readonly props: Record<string, PropValue>;
  /** Bound to a field (DataSource and DataField set on a control type that binds). */
  isBound(): boolean;
  boundValue(): VBValue;
  /** Shows a field's value; null: there is no current record (blank). DataChanged becomes False. */
  showBound(v: VBValue | null): void;
  /** DataGrid, DataList, DataCombo: the records changed, or another record is current. */
  dataNotify(src: DataControl, kind: 'reposition' | 'rows'): void;
}

export interface DataHost {
  readonly props: Record<string, PropValue>;
  readonly name: string;
  raise(event: string, args: VBRef[]): Promise<void>;
  send(props: Record<string, PropValue>): void;
  /** The run's databases; throws 429 when the host has none. */
  db(): DbSession;
  /** A path of the program as a full path (relative to App.Path, `\` separators ...). */
  resolvePath(path: string): string;
  /** The controls of the form. */
  consumers(): DataConsumer[];
  msgBox(prompt: string, buttons: number, title: string): Promise<number>;
  /** Runs `fn` with the program's locale current: a bound control shows a date as CStr does, also after an await. */
  inScope<T>(fn: () => T): T;
}

/** ADO's EventReasonEnum for a vbDataAction. */
function adReason(action: number): number {
  switch (action) {
    case ACT.moveFirst: return 12;
    case ACT.moveNext: return 13;
    case ACT.movePrevious: return 14;
    case ACT.moveLast: return 15;
    case ACT.addNew: return 1;
    case ACT.delete: return 2;
    case ACT.update: return 3;
    case ACT.close: return 9;
    case ACT.cancel: return 7;
    default: return 10;
  }
}
const MOVES = new Set<number>([ACT.moveFirst, ACT.movePrevious, ACT.moveNext, ACT.moveLast, ACT.find, ACT.bookmark, ACT.addNew, ACT.cancel]);
const strProp = (v: PropValue | undefined): string => (typeof v === 'string' ? v : '');
const same = (a: unknown, b: string): boolean => typeof a === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();

export class DataControl implements RichControl, RecordsetOwner {
  private rs: RecordsetObject | null = null;
  private opening: Promise<RecordsetObject | null> | null = null;
  private conn: { path: string; c: Promise<DbConnection> } | null = null;
  private connection: ConnectionObject | null = null;
  private database: DatabaseObject | null = null;
  /** A Validate / WillMove handler is running: moves it makes raise no second one. */
  private inEvent = false;
  private busy = false;
  private disposed = false;

  constructor(private h: DataHost, readonly flavor: Flavor) {}

  get name(): string { return this.h.name; }
  /** The open recordset (null before it opens, or when there is no source). */
  recordset(): RecordsetObject | null { return this.rs && !this.rs.isClosed ? this.rs : null; }

  // -- opening ------------------------------------------------------------------------------------------------------

  private dbPath(): string {
    return this.flavor === 'dao' ? strProp(this.h.props.DatabaseName) : dataSourceOf(strProp(this.h.props.ConnectionString));
  }

  private connect(): Promise<DbConnection> {
    const raw = this.dbPath();
    if (raw === '') throw new VBRuntimeError(this.flavor === 'dao' ? 3024 : 3709);
    const path = this.h.resolvePath(raw);
    if (this.conn?.path !== path) {
      this.conn = { path, c: this.h.db().connect(path) };
      this.connection = null;
      this.database = null;
    }
    return this.conn.c;
  }

  /** Opens the recordset if it is not open (once at a time); null when DatabaseName / RecordSource are not set. */
  ensureOpen(): Promise<RecordsetObject | null> {
    if (this.recordset()) return Promise.resolve(this.rs);
    return this.opening ??= this.open().finally(() => { this.opening = null; });
  }

  private async open(): Promise<RecordsetObject | null> {
    const source = strProp(this.h.props.RecordSource);
    if (this.dbPath() === '' || source.trim() === '') return null;
    const conn = await this.connect();
    const p = this.h.props;
    const readOnly = this.flavor === 'dao' ? p.ReadOnly === true || Number(p.RecordsetType) === 2 : Number(p.LockType) === 1;
    const rs = await RecordsetObject.open(conn, source, {
      flavor: this.flavor, readOnly, owner: this,
      commandType: this.flavor === 'ado' ? Number(p.CommandType ?? 8) : undefined,
      connection: () => this.connectionObject(conn),
    });
    if (this.disposed) return null;
    this.rs = rs;
    this.rowsChanged(rs);
    await this.after(rs, ACT.bookmark, true);
    return rs;
  }

  private connectionObject(conn: DbConnection): ConnectionObject {
    return this.connection ??= new ConnectionObject(conn, strProp(this.h.props.ConnectionString));
  }

  /** Refresh: the database and the recordset are opened again from the current properties. */
  private async refresh(): Promise<void> {
    this.rs = null;
    this.conn = null;
    this.opening = null;
    const rs = await this.ensureOpen();
    if (!rs) {   // nothing to show: the bound controls go blank
      this.fillBound(null);
      this.notify('rows');
    }
  }

  /** An error of an automatic open or of a button: the Error event, then a message unless the handler cleared Response /
   *  set fCancelDisplay. */
  private async reportError(e: unknown): Promise<void> {
    if (!(e instanceof VBRuntimeError) || this.disposed) { if (!(e instanceof VBRuntimeError)) console.error(e); return; }
    let show: boolean;
    if (this.flavor === 'dao') {
      const response = new VBRef(1);
      await this.h.raise('Error', [new VBRef(e.number), response]);
      show = toNumber(response.value) !== 0;
    } else {
      const cancel = new VBRef(false);
      await this.h.raise('Error', [new VBRef(e.number), new VBRef(e.description), new VBRef(0), new VBRef(this.h.name), new VBRef(''), new VBRef(0), cancel]);
      show = !toBool(cancel.value);
    }
    if (show && !this.disposed) await this.h.msgBox(e.description, 48, '');
  }

  // -- binding ------------------------------------------------------------------------------------------------------

  private bound(): DataConsumer[] {
    return this.h.consumers().filter(c => same(c.props.DataSource, this.h.name) && c.isBound());
  }

  /** The changed values of the bound controls, by field name. */
  private dirty(): Map<string, VBValue> {
    const out = new Map<string, VBValue>();
    for (const c of this.bound()) if (c.props.DataChanged === true) out.set(strProp(c.props.DataField), c.boundValue());
    return out;
  }

  /** The bound controls show the current record (or the AddNew buffer); blank without one. */
  private fillBound(rs: RecordsetObject | null): void {
    this.h.inScope(() => {
      for (const c of this.bound()) {
        let v: VBValue | null = null;
        if (rs && !rs.isClosed && (rs.hasCurrent || rs.mode === 2)) {
          try { v = rs.fieldValue(rs.fieldIndex(strProp(c.props.DataField))); } catch { v = null; }
        }
        c.showBound(v);
      }
    });
  }

  private notify(kind: 'reposition' | 'rows'): void {
    this.h.inScope(() => {
      for (const c of this.h.consumers()) {
        if (same(c.props.DataSource, this.h.name) || same(c.props.RowSource, this.h.name)) c.dataNotify(this, kind);
      }
    });
  }

  // -- RecordsetOwner -----------------------------------------------------------------------------------------------

  async before(rs: RecordsetObject, action: number): Promise<boolean> {
    if (this.inEvent || rs !== this.rs) return true;
    let save = true;
    this.inEvent = true;
    try {
      if (this.flavor === 'dao') {
        const a = new VBRef(action), s = new VBRef(this.dirty().size > 0);
        await this.h.raise('Validate', [a, s]);
        if (toNumber(a.value) === ACT.cancel) return false;
        save = toBool(s.value);
      } else if (MOVES.has(action) || action === ACT.close) {
        const status = new VBRef(1);
        await this.h.raise('WillMove', [new VBRef(adReason(action)), status, new VBRef(rs)]);
        if (toNumber(status.value) === 4) return false;   // adStatusCancel
      }
    } finally {
      this.inEvent = false;
    }
    const values = this.dirty();
    if (!save || values.size === 0 || action === ACT.delete) return true;
    if (!rs.hasCurrent && rs.mode === 0) return true;
    if (action !== ACT.update && !rs.canWrite([...values.keys()])) {
      // a read-only source (a join, ReadOnly ...): the error once, the bound controls show the record again, and the move goes on
      this.fillBound(rs);
      await this.reportError(new VBRuntimeError(3027));
      return true;
    }
    if (action === ACT.update) rs.setValues(values);
    else await rs.writeValues(values);
    return true;
  }

  async after(rs: RecordsetObject, action: number, moved: boolean): Promise<void> {
    if (rs !== this.rs || this.disposed) return;
    this.fillBound(rs);
    this.notify('reposition');
    if (!moved) return;
    if (this.flavor === 'dao') await this.h.raise('Reposition', []);
    else await this.h.raise('MoveComplete', [new VBRef(adReason(action)), new VBRef(Nothing), new VBRef(1), new VBRef(rs)]);
  }

  rowsChanged(rs: RecordsetObject): void {
    if (rs === this.rs) this.notify('rows');
  }

  // -- RichControl --------------------------------------------------------------------------------------------------

  /** `Set Data1.Recordset = rs`: the control and its bound controls show `rs` (made in code) from its current record. */
  set(name: string, value: VBValue): boolean | Promise<void> {
    if (name !== 'Recordset') return false;
    if (!(value instanceof RecordsetObject)) throw new VBRuntimeError(value === Nothing ? 91 : 13);
    if (value.flavor !== this.flavor || value.isClosed) throw new VBRuntimeError(value.isClosed ? 3704 : 13);
    this.rs = value;
    this.opening = null;
    value.owner = this;
    this.rowsChanged(value);
    return this.after(value, ACT.bookmark, true);
  }

  get(name: string, args: VBValue[]): VBValue | undefined {
    switch (name) {
      case 'Recordset': {
        // `Data1.Recordset("Name")` / `Data1.Recordset!Name`: the field of the recordset
        const pick = (rs: RecordsetObject | null): VBValue => (!rs ? Nothing : args.length ? rs.getMember('Fields', args) : rs);
        if (this.recordset()) return pick(this.rs);
        return this.ensureOpen().then(pick) as unknown as VBValue;   // the interpreter waits for it
      }
      case 'Database': {
        if (args.length) throw new VBRuntimeError(450);
        const path = this.dbPath();
        if (path === '') return Nothing;
        return this.connect().then(c => (this.database ??= new DatabaseObject(c, this.h.resolvePath(path)))) as unknown as VBValue;
      }
      case 'EditMode': return this.rs?.mode ?? 0;
    }
    return undefined;
  }

  call(name: string): VBValue | Promise<VBValue> | undefined {
    switch (name) {
      case 'refresh': return this.refresh().then(() => Empty);
      case 'updatecontrols': this.fillBound(this.recordset()); return Empty;
      case 'updaterecord': {
        const rs = this.recordset();
        const values = this.dirty();
        if (!rs || values.size === 0) return Empty;
        return rs.writeValues(values).then(() => { this.fillBound(rs); return Empty; });
      }
    }
    return undefined;
  }

  /** The arrow buttons: |< < > >| (BOFAction / EOFAction at the ends). */
  applyState(props: Record<string, PropValue>): void {
    const a = userAction(props);
    if (!a || typeof a.nav !== 'string' || this.busy) return;
    this.busy = true;
    void this.navigate(String(a.nav)).catch(e => this.reportError(e)).finally(() => { this.busy = false; });
  }

  private async navigate(nav: string): Promise<void> {
    const rs = await this.ensureOpen();
    if (!rs) return;
    const n = rs.recordCount, pos = rs.position, adding = rs.mode === 2;
    switch (nav) {
      case 'first': if (n) await rs.move('first'); break;
      case 'last': if (n) await rs.move('last'); break;
      case 'previous':
        if (adding) { await rs.move('to', Math.max(0, Math.min(pos, n - 1))); break; }
        if (pos <= 0) { if (Number(this.h.props.BOFAction) === 1 && pos === 0) await rs.move('previous'); }
        else await rs.move('previous');
        break;
      case 'next': {
        const atLast = adding || pos >= n - 1;
        if (!atLast) { await rs.move('next'); break; }
        const action = Number(this.h.props.EOFAction);
        if (action === 2) await rs.startAddNew();
        else if (action === 1 && !adding && n > 0 && pos === n - 1) await rs.move('next');
        else if (adding) await rs.move('last');
        break;
      }
    }
  }

  /** After Form_Load: the recordset opens (an error goes to the Error event). */
  async formLoaded(): Promise<void> {
    if (this.recordset() || this.opening) return;
    try { await this.ensureOpen(); } catch (e) { await this.reportError(e); }
  }

  /** The form unloads: changed bound controls are saved (Validate with vbDataActionUnload). */
  async formUnloading(): Promise<void> {
    const rs = this.recordset();
    if (!rs || (this.dirty().size === 0 && rs.mode === 0)) return;
    try {
      if (await this.before(rs, ACT.unload) && rs.mode !== 0 && this.flavor === 'ado' && !rs.dropEmptyAdd()) await rs.saveEdit();
    } catch (e) { await this.reportError(e); }
  }

  dispose(): void { this.disposed = true; }
}
