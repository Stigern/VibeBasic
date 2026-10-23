// SQL from code: the DAO Database of a Data control (`Data1.Database.Execute "UPDATE ..."`, `.OpenRecordset("SELECT ...")`),
// the ADO Connection of an Adodc's recordset (`Adodc1.Recordset.ActiveConnection.Execute sql, n`), and the ADO objects code
// makes (`New ADODB.Connection`, CreateObject("ADODB.Recordset"), ADODB.Command with ? parameters). Execute runs the program's
// own SQL as written; the controls' writes are parameterised.
//
// - The data controls share one SQLite connection per database file (DbSession); each Connection code makes (and each one a
//   Recordset opens for a connection string) has its own, with its own transaction. BeginTrans nests (savepoints) and returns
//   the level; Close rolls back and closes its SQLite connection. SQLite has one writer per file: while one connection's
//   transaction has written, another connection's write waits and then fails with 3260.

import type { OutSlot, VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, EmptyT, Nothing, NothingT, VBArray, isObject, toNumber, toStr, type VBValue } from '../../lang/values';
import type { DbValue } from '../../backend/backend';
import type { DbConnection } from './dbSession';
import { RecordsetObject, adoKind, type RecordsetOptions } from './recordset';
import { toDb } from './dbValues';
import { VBCollection } from '../../lang/builtins/collection';

const given = (v: VBValue | undefined): v is VBValue => v !== undefined && !(v instanceof EmptyT);
const plain = (v: VBValue): VBValue => (isObject(v) && v.defaultMember !== undefined ? v.getMember(v.defaultMember, []) : v);

/** The Data Source of an ADO connection string ("Provider=...;Data Source=file.db"); a string without "=" is the path itself. */
export function dataSourceOf(cs: string): string {
  const t = cs.trim();
  if (!t.includes('=')) return t;
  for (const part of t.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase().replace(/\s+/g, ' ');
    if (['data source', 'datasource', 'dbq', 'database', 'filename', 'file name'].includes(key)) return part.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return '';
}

/** What code-made ADO objects need from the run: the database file at a path the program gave (relative to App.Path). */
export interface AdoHost { connect(path: string): Promise<DbConnection> }

const ROWS_SQL = /^\s*(select|with|values|pragma)\b/i;

export class DatabaseObject implements VBObject {
  readonly vbTypeName = 'Database';
  private affected = 0;
  private closed = false;
  constructor(private conn: DbConnection, private name: string) {}

  hasMember(name: string): boolean { return ['name', 'recordsaffected', 'connect', 'updatable', 'version'].includes(name.toLowerCase()); }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) return this.callMethod(name, args) as VBValue;
    if (args.length) throw new VBRuntimeError(450);
    switch (l) {
      case 'name': return this.name;
      case 'recordsaffected': return this.affected;
      case 'connect': return '';
      case 'updatable': return true;
      default: return 'SQLite';
    }
  }

  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const l = name.toLowerCase();
    if (l !== 'close' && this.closed) throw new VBRuntimeError(3420);
    switch (l) {
      case 'execute': {
        if (args.length < 1 || args.length > 2) throw new VBRuntimeError(450);
        const sql = toStr(args[0]);
        if (ROWS_SQL.test(sql)) throw new VBRuntimeError(3065);
        return this.conn.execute(sql).then(r => { this.affected = r.rowsAffected; return Empty; });
      }
      case 'openrecordset': {
        if (args.length < 1 || args.length > 4) throw new VBRuntimeError(450);
        const type = args[1] !== undefined && args[1] !== Empty ? toNumber(args[1]) : 2;
        return RecordsetObject.open(this.conn, toStr(args[0]), { flavor: 'dao', readOnly: type === 4 || type === 8 });
      }
      case 'close': this.closed = true; return Empty;
    }
    throw new VBRuntimeError(438);
  }
}

/** An ADO Connection: an Adodc's (open from the start) or one code made (`New ADODB.Connection`, then Open). */
export class ConnectionObject implements VBObject {
  readonly vbTypeName = 'Connection';
  /** BeginTrans levels open. */
  private level = 0;
  private props: Record<string, VBValue> = { provider: 'MSDASQL', commandtimeout: 30, connectiontimeout: 15, cursorlocation: 2, mode: 0, defaultdatabase: '' };
  private readonly errors = new VBCollection();
  constructor(private conn: DbConnection | null, private connectionString: string, private host?: AdoHost) {}

  /** The open connection; 3709 when it is closed (a recordset or command that uses it). */
  get db(): DbConnection {
    if (!this.conn) throw new VBRuntimeError(3709);
    return this.conn;
  }

  hasMember(name: string): boolean {
    return ['connectionstring', 'state', 'version', 'errors', ...Object.keys(this.props)].includes(name.toLowerCase());
  }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) return this.callMethod(name, args) as VBValue;
    if (args.length) throw new VBRuntimeError(450);
    switch (l) {
      case 'connectionstring': return this.connectionString;
      case 'state': return this.conn ? 1 : 0;
      case 'version': return '2.8';
      case 'errors': return this.errors;   // provider errors become VB run-time errors: always empty
    }
    return this.props[l];
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    if (l === 'state' || l === 'version' || l === 'errors') throw new VBRuntimeError(383);
    if ((l === 'connectionstring' || l === 'provider') && this.conn) throw new VBRuntimeError(3705);
    if (l === 'connectionstring') this.connectionString = toStr(value);
    else this.props[l] = typeof this.props[l] === 'number' ? toNumber(value) : toStr(value);
  }

  /** Execute's RecordsAffected (the second argument) is written back. */
  byRefArgs(name: string): readonly number[] | undefined { return name.toLowerCase() === 'execute' ? [1] : undefined; }

  /** Open [ConnectionString], [UserID], [Password], [Options]: the Data Source (or the string itself) is the database file. */
  private async open(args: VBValue[]): Promise<VBValue> {
    if (args.length > 4) throw new VBRuntimeError(450);
    if (this.conn) throw new VBRuntimeError(3705);
    if (given(args[0])) this.connectionString = toStr(args[0]);
    const path = dataSourceOf(this.connectionString);
    if (path === '' || !this.host) throw new VBRuntimeError(-2147467259, '[Microsoft][ODBC Driver Manager] Data source name not found and no default driver specified');
    this.conn = await this.host.connect(path);
    return Empty;
  }

  private async transaction(op: 'begin' | 'commit' | 'rollback'): Promise<VBValue> {
    this.level = await this.db.transaction(op);
    return op === 'begin' ? this.level : Empty;
  }

  callMethod(name: string, args: VBValue[], refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue> {
    const l = name.toLowerCase();
    if (l === 'open') return this.open(args);
    if (l === 'close') {
      if (!this.conn) throw new VBRuntimeError(3704);
      const c = this.conn, n = this.level;
      this.conn = null;
      this.level = 0;
      // an open transaction is rolled back
      return (async () => {
        for (let i = 0; i < n; i++) await c.transaction('rollback').catch(() => 0);
        await c.close();
        return Empty;
      })();
    }
    if (!this.conn) throw new VBRuntimeError(3704);
    switch (l) {
      case 'execute': {
        if (args.length < 1 || args.length > 3) throw new VBRuntimeError(450);
        const opt = given(args[2]) ? toNumber(args[2]) : -1;
        return runCommand(this.conn, toStr(args[0]), (opt & 0xff) === 2 ? 2 : 1, [], refs?.[1], () => this);
      }
      case 'begintrans': return this.transaction('begin');
      case 'committrans': return this.transaction('commit');
      case 'rollbacktrans': return this.transaction('rollback');
    }
    if (this.hasMember(l)) return this.getMember(name, args);
    throw new VBRuntimeError(438);
  }
}

/** Runs a command's SQL: a Recordset for a query (read-only, as ADO's Execute gives), else a closed one and RecordsAffected. */
function runCommand(conn: DbConnection, sql: string, commandType: number, params: DbValue[], affected: OutSlot | undefined,
  connection: () => VBObject): Promise<VBValue> {
  const opts: RecordsetOptions = { flavor: 'ado', readOnly: true, commandType, connection, params };
  if (commandType === 2 || ROWS_SQL.test(sql)) return RecordsetObject.open(conn, sql, opts);
  return conn.execute(sql, params).then(r => {
    if (affected) affected.value = r.rowsAffected;
    return RecordsetObject.closedOne(conn, opts);
  });
}

/** The connection a Recordset or Command uses: a Connection object (open), or a connection string (a new Connection is opened). */
async function connectionFor(v: VBValue, host: AdoHost): Promise<{ conn: DbConnection; obj: VBObject }> {
  if (v instanceof ConnectionObject) return { conn: v.db, obj: v };
  if (isObject(v) || v instanceof NothingT) throw new VBRuntimeError(3001, 'Arguments are of the wrong type, are out of acceptable range, or are in conflict with one another.');
  const c = new ConnectionObject(null, '', host);
  await c.callMethod('open', [toStr(v)]);
  return { conn: c.db, obj: c };
}

// ---------------------------------------------------------------------------------------------------------------
// Command and Parameters

class ParameterObject implements VBObject {
  readonly vbTypeName = 'Parameter';
  readonly defaultMember = 'Value';
  props: Record<string, VBValue> = { name: '', type: 0, direction: 1, size: 0, value: Empty, precision: 0, numericscale: 0, attributes: 0 };
  hasMember(name: string): boolean { return name.toLowerCase() in this.props; }
  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    return this.props[l];
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    this.props[l] = l === 'value' ? plain(value) : l === 'name' ? toStr(value) : toNumber(value);
  }
  callMethod(name: string, args: VBValue[]): VBValue { return this.getMember(name, args); }
  /** The value bound for its `?`. */
  dbValue(): DbValue { return toDb(this.props.value, adoKind(toNumber(this.props.type))); }
}

class ParametersObject implements VBObject {
  readonly vbTypeName = 'Parameters';
  readonly defaultMember = 'Item';
  readonly rawArgs = true;
  list: ParameterObject[] = [];
  items(): VBObject[] { return this.list; }
  private find(k: VBValue): number {
    k = plain(k);
    const i = typeof k === 'string' ? this.list.findIndex(p => toStr(p.props.name).toLowerCase() === k.toLowerCase()) : toNumber(k);
    if (!(Number.isInteger(i) && i >= 0 && i < this.list.length)) throw new VBRuntimeError(3265);
    return i;
  }
  hasMember(name: string): boolean { return ['count', 'item'].includes(name.toLowerCase()); }
  getMember(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'count': if (args.length) throw new VBRuntimeError(450); return this.list.length;
      case 'item': if (args.length !== 1) throw new VBRuntimeError(450); return this.list[this.find(args[0])];
    }
    return this.callMethod(name, args);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (name.toLowerCase() === 'item' && args.length === 1) { this.list[this.find(args[0])].setMember('Value', [], value); return; }
    throw new VBRuntimeError(this.hasMember(name) ? 383 : 438);
  }
  callMethod(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'append':
        if (args.length !== 1) throw new VBRuntimeError(450);
        if (!(args[0] instanceof ParameterObject)) throw new VBRuntimeError(3001, 'Arguments are of the wrong type, are out of acceptable range, or are in conflict with one another.');
        this.list.push(args[0]);
        return Empty;
      case 'delete': if (args.length !== 1) throw new VBRuntimeError(450); this.list.splice(this.find(args[0]), 1); return Empty;
      case 'refresh': return Empty;
      case 'count': case 'item': return this.getMember(name, args);
    }
    throw new VBRuntimeError(438);
  }
}

/** ADODB.Command: CommandText with `?` placeholders, bound from Parameters (or Execute's Parameters array) in order. */
class CommandObject implements VBObject {
  readonly vbTypeName = 'Command';
  private active: { conn: DbConnection; obj: VBObject } | null = null;
  private pending: Promise<void> = Promise.resolve();
  private props: Record<string, VBValue> = { commandtext: '', commandtype: 8, commandtimeout: 30, prepared: false, name: '' };
  private readonly params = new ParametersObject();
  constructor(private host: AdoHost) {}

  hasMember(name: string): boolean { return ['activeconnection', 'state', 'parameters', ...Object.keys(this.props)].includes(name.toLowerCase()); }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) return this.callMethod(name, args) as VBValue;
    if (l === 'parameters') return args.length ? this.params.getMember('Item', args) : this.params;
    if (args.length) throw new VBRuntimeError(450);
    if (l === 'activeconnection') return this.active?.obj ?? Nothing;
    if (l === 'state') return 0;
    return this.props[l];
  }

  setMember(name: string, args: VBValue[], value: VBValue): void | Promise<void> {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    if (l === 'state' || l === 'parameters') throw new VBRuntimeError(383);
    if (l === 'activeconnection') {
      if (value instanceof NothingT) { this.active = null; return; }
      return this.pending = connectionFor(value, this.host).then(r => { this.active = r; });
    }
    this.props[l] = l === 'commandtext' || l === 'name' ? toStr(value) : l === 'prepared' ? value === true : toNumber(value);
  }

  byRefArgs(name: string): readonly number[] | undefined { return name.toLowerCase() === 'execute' ? [0] : undefined; }

  callMethod(name: string, args: VBValue[], refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue> {
    switch (name.toLowerCase()) {
      case 'execute': {
        if (args.length > 3) throw new VBRuntimeError(450);
        return this.pending.then(() => {
          if (!this.active) throw new VBRuntimeError(3709);
          const arr = args[1];
          const values = arr instanceof VBArray
            ? Array.from({ length: arr.bounds[0][1] - arr.bounds[0][0] + 1 }, (_, i) => toDb(plain(arr.get([arr.bounds[0][0] + i])), 'variant'))
            : this.params.list.map(p => p.dbValue());
          const opt = given(args[2]) ? toNumber(args[2]) & 0xff : toNumber(this.props.commandtype);
          const obj = this.active.obj;
          return runCommand(this.active.conn, toStr(this.props.commandtext), opt === 2 ? 2 : 1, values, refs?.[0], () => obj);
        });
      }
      case 'createparameter': {
        if (args.length > 5) throw new VBRuntimeError(450);
        const p = new ParameterObject();
        ['Name', 'Type', 'Direction', 'Size', 'Value'].forEach((n, i) => { if (given(args[i])) p.setMember(n, [], args[i]); });
        return p;
      }
      case 'cancel': return Empty;
    }
    if (this.hasMember(name)) return this.getMember(name, args);
    throw new VBRuntimeError(438);
  }
}

/** `New ADODB.Connection` / Recordset / Command, CreateObject of their ProgIDs (Host.createObject). */
export function createAdoObject(progId: string, host: AdoHost): VBObject | undefined {
  switch (progId.toLowerCase()) {
    case 'adodb.connection': return new ConnectionObject(null, '', host);
    case 'adodb.recordset': return RecordsetObject.unopened({ flavor: 'ado', openConnection: v => connectionFor(v, host) });
    case 'adodb.command': return new CommandObject(host);
  }
  return undefined;
}
