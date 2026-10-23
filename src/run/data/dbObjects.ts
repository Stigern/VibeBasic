// SQL from code: the DAO Database of a Data control (`Data1.Database.Execute "UPDATE ..."`, `.OpenRecordset("SELECT ...")`)
// and the ADO Connection of an Adodc's recordset (`Adodc1.Recordset.ActiveConnection.Execute sql, n`). VibeBasic has no
// `New`, so these come from the controls. Execute runs the program's own SQL as written; the controls' writes are parameterised.

import type { OutSlot, VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, toNumber, toStr, type VBValue } from '../../lang/values';
import type { DbConnection } from './dbSession';
import { RecordsetObject } from './recordset';

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

export class ConnectionObject implements VBObject {
  readonly vbTypeName = 'Connection';
  private closed = false;
  constructor(private conn: DbConnection, private connectionString: string) {}

  hasMember(name: string): boolean {
    return ['connectionstring', 'state', 'provider', 'version', 'commandtimeout', 'connectiontimeout', 'defaultdatabase', 'mode'].includes(name.toLowerCase());
  }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) return this.callMethod(name, args) as VBValue;
    if (args.length) throw new VBRuntimeError(450);
    switch (l) {
      case 'connectionstring': return this.connectionString;
      case 'state': return this.closed ? 0 : 1;
      case 'provider': return 'SQLite';
      case 'version': return '2.8';
      case 'commandtimeout': return 30;
      case 'connectiontimeout': return 15;
      case 'mode': return 0;
      default: return '';
    }
  }

  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }

  /** Execute's RecordsAffected (the second argument) is written back. */
  byRefArgs(name: string): readonly number[] | undefined { return name.toLowerCase() === 'execute' ? [1] : undefined; }

  callMethod(name: string, args: VBValue[], refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue> {
    const l = name.toLowerCase();
    if (l === 'close') { if (this.closed) throw new VBRuntimeError(3704); this.closed = true; return Empty; }
    if (this.closed) throw new VBRuntimeError(3704);
    switch (l) {
      case 'execute': {
        if (args.length < 1 || args.length > 3) throw new VBRuntimeError(450);
        const sql = toStr(args[0]);
        const opts = { flavor: 'ado' as const, readOnly: true, commandType: 1, connection: () => this };
        if (ROWS_SQL.test(sql)) return RecordsetObject.open(this.conn, sql, opts);
        return this.conn.execute(sql).then(r => {
          if (refs?.[1]) refs[1].value = r.rowsAffected;
          return RecordsetObject.closedOne(this.conn, opts);
        });
      }
      case 'begintrans': return this.conn.execute('BEGIN').then(() => 1);
      case 'committrans': return this.conn.execute('COMMIT').then(() => Empty);
      case 'rollbacktrans': return this.conn.execute('ROLLBACK').then(() => Empty);
      case 'open': return Empty;   // already open: the Adodc's connection
    }
    throw new VBRuntimeError(438);
  }
}
