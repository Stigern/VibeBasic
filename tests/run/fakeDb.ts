// A DatabaseApi for tests: SQLite in memory through node:sqlite (one database per path), with the Rust side's error numbers.
import type { DatabaseApi, DbExecResult, DbQueryResult, DbValue } from '../../src/backend/backend';

// node:sqlite through getBuiltinModule: vite cannot bundle it for the jsdom environment
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    setReturnArrays(on: boolean): void; columns(): { name: string; type: string | null }[];
    all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
}
const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(n: string): { DatabaseSync: new (p: string) => SqliteDb } } })
  .process.getBuiltinModule('node:sqlite');

function vbErr(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e);
  const l = m.toLowerCase();
  const n = l.includes('unique') ? 3022 : l.includes('not null') ? 3314 : l.includes('no such table') ? 3078
    : l.includes('no such column') ? 3061 : l.includes('syntax') ? 3075 : 3146;
  return new Error(`${n}|${m}`);
}

const arg = (v: DbValue): unknown => (v !== null && typeof v === 'object' ? Uint8Array.from(atob(v.blob), ch => ch.charCodeAt(0)) : v);

export class FakeDb implements DatabaseApi {
  readonly files = new Map<string, SqliteDb>();
  private conns = new Map<number, SqliteDb>();
  private next = 0;
  calls: string[] = [];

  /** The database at `path` (made when missing), for setting up and checking data. */
  db(path: string): SqliteDb {
    let d = this.files.get(path);
    if (!d) this.files.set(path, d = new DatabaseSync(':memory:'));
    return d;
  }

  async dbOpen(path: string): Promise<number> {
    this.calls.push(`open ${path}`);
    this.conns.set(++this.next, this.db(path));
    return this.next;
  }

  async dbQuery(id: number, sql: string, params: DbValue[]): Promise<DbQueryResult> {
    const d = this.conns.get(id);
    if (!d) throw new Error('3420|Object invalid or no longer set.');
    try {
      const st = d.prepare(sql);
      st.setReturnArrays(true);
      const cols = st.columns();
      const rows = st.all(...params.map(arg)) as unknown[][];
      return { columns: cols.map(c => c.name), types: cols.map(c => c.type ?? ''), rows: rows.map(r => r.map(v => (typeof v === 'bigint' ? Number(v) : v)) as DbValue[]) };
    } catch (e) { throw vbErr(e); }
  }

  async dbExecute(id: number, sql: string, params: DbValue[]): Promise<DbExecResult> {
    const d = this.conns.get(id);
    if (!d) throw new Error('3420|Object invalid or no longer set.');
    this.calls.push(`exec ${sql} ${JSON.stringify(params)}`);
    try {
      if (!params.length) {
        d.exec(sql);
        const c = d.prepare('SELECT changes() AS n, last_insert_rowid() AS r').get() as { n: number; r: number };
        return { rowsAffected: Number(c.n), lastInsertRowid: Number(c.r) };
      }
      const r = d.prepare(sql).run(...params.map(arg));
      return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    } catch (e) { throw vbErr(e); }
  }

  async dbClose(id: number): Promise<void> { this.conns.delete(id); }
  async dbReset(): Promise<void> { this.calls.push('reset'); this.conns.clear(); }
}
