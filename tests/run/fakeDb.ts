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
const node = (globalThis as unknown as { process: { getBuiltinModule(n: string): unknown } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDb };

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
  /** With `separate`, each dbOpen is a connection of its own (with its own transaction) to a temporary database file. */
  private readonly dir: string | null;

  constructor(opts: { separate?: boolean } = {}) {
    if (!opts.separate) { this.dir = null; return; }
    const fs = node.getBuiltinModule('node:fs') as { mkdtempSync(p: string): string };
    const os = node.getBuiltinModule('node:os') as { tmpdir(): string };
    this.dir = fs.mkdtempSync(`${os.tmpdir()}/fakedb-`);
  }

  private file(path: string): string { return `${this.dir}/${path.replace(/[^\w.]/g, '_')}`; }

  /** The database at `path` (made when missing), for setting up and checking data. */
  db(path: string): SqliteDb {
    let d = this.files.get(path);
    if (!d) this.files.set(path, d = new DatabaseSync(this.dir ? this.file(path) : ':memory:'));
    return d;
  }

  async dbOpen(path: string): Promise<number> {
    this.calls.push(`open ${path}`);
    this.conns.set(++this.next, this.dir ? new DatabaseSync(this.file(path)) : this.db(path));
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

  /** Transaction levels by connection (savepoints inside), as the Rust side keeps them. */
  private depth = new Map<number, number>();
  async dbBeginTrans(id: number): Promise<number> {
    const n = this.depth.get(id) ?? 0;
    this.conns.get(id)!.exec(n ? `SAVEPOINT vb_trans${n}` : 'BEGIN');
    this.depth.set(id, n + 1);
    return n + 1;
  }
  private endTrans(id: number, commit: boolean): number {
    const n = this.depth.get(id) ?? 0;
    if (!n) throw new Error('-2147168242|No transaction is active.');
    const l = n - 1;
    this.conns.get(id)!.exec(l ? (commit ? `RELEASE vb_trans${l}` : `ROLLBACK TO vb_trans${l}; RELEASE vb_trans${l}`) : commit ? 'COMMIT' : 'ROLLBACK');
    this.depth.set(id, l);
    return l;
  }
  async dbCommitTrans(id: number): Promise<number> { return this.endTrans(id, true); }
  async dbRollbackTrans(id: number): Promise<number> { return this.endTrans(id, false); }
}
