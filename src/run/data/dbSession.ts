// The databases of one run: SQLite connections of the main window (DatabaseApi), one per database file. The session makes it
// when a Data control, Adodc or Recordset first opens a database; at the end of the program every connection is closed.

import type { DatabaseApi, DbExecResult, DbQueryResult, DbValue } from '../../backend/backend';
import { VBRuntimeError } from '../../lang/errors';

/** "3078|no such table: X" (a rejection of the backend) -> the VB error with that number and text. */
export function dbError(e: unknown, fallback = 3146): VBRuntimeError {
  if (e instanceof VBRuntimeError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^(-?\d+)\|([\s\S]*)$/.exec(msg);
  return m ? new VBRuntimeError(Number(m[1]), m[2]) : new VBRuntimeError(fallback, msg || 'ODBC--call failed.');
}

/** An open database file: queries and statements on it (rejections become VB errors). */
export class DbConnection {
  constructor(private readonly api: DatabaseApi, private readonly id: number, readonly path: string, private readonly session: DbSession) {}

  async query(sql: string, params: DbValue[] = []): Promise<DbQueryResult> {
    this.session.check();
    try { return await this.api.dbQuery(this.id, sql, params); } catch (e) { throw dbError(e); }
  }

  async execute(sql: string, params: DbValue[] = []): Promise<DbExecResult> {
    this.session.check();
    try { return await this.api.dbExecute(this.id, sql, params); } catch (e) { throw dbError(e); }
  }
}

export class DbSession {
  private readonly open = new Map<string, Promise<DbConnection>>();
  private closed = false;
  /** Connections left over from an earlier run are gone before the first open. */
  private readonly ready: Promise<void>;

  constructor(private readonly api: DatabaseApi) {
    this.ready = api.dbReset().catch(() => {});
  }

  check(): void { if (this.closed) throw new VBRuntimeError(3420); }

  /** The connection to the database file at `path` (a full path), opened on first use; the same one for every control. */
  connect(path: string): Promise<DbConnection> {
    this.check();
    let p = this.open.get(path);
    if (!p) {
      p = this.ready.then(() => this.api.dbOpen(path)).then(id => new DbConnection(this.api, id, path, this), e => { throw dbError(e, 3024); });
      p.catch(() => this.open.delete(path));
      this.open.set(path, p);
    }
    return p;
  }

  /** The end of the program: every connection closed. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.open.clear();
    void this.api.dbReset().catch(() => {});
  }
}
