//! Databases of a running program (Data control, ADO Data Control, Recordset): SQLite files through rusqlite. VB6 programs
//! used Jet (.mdb); here a database is a .db / .sqlite file, opened (and created when missing) by its full path. Only the
//! main window (the run session) calls these. A run keeps its connections by id and closes them at the end (db_reset).
//! Errors are "number|description" with the DAO error number (3078 table not found, 3022 duplicate key ...) and the
//! SQLite message as the description.
//!
//! Every query runs on the blocking pool (`off_main`), with its own connection lock: the map of connections is locked
//! only to look one up, so db_close and db_reset never wait for a query. They interrupt the queries still running
//! (sqlite3_interrupt) and drop the connections. A result bigger than MAX_ROWS rows or about MAX_BYTES of values is
//! "7|Out of memory" instead of eating all the memory there is (a runaway recursive query, a cartesian join).

use base64::Engine;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::State;

use crate::io_util::off_main;

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// A query returns at most this many rows ...
pub const MAX_ROWS: usize = 1_000_000;
/// ... and about this many bytes of values.
pub const MAX_BYTES: usize = 256 * 1024 * 1024;

struct Db {
  conn: Mutex<Connection>,
  /// Stops the statement running on `conn` from any thread (db_close, db_reset).
  interrupt: rusqlite::InterruptHandle,
}

#[derive(Default)]
struct Inner {
  next: u32,
  conns: HashMap<u32, Arc<Db>>,
}

#[derive(Default, Clone)]
pub struct Databases(Arc<Mutex<Inner>>);

/// The rows of a query: column names, their declared types ("" when none, e.g. an expression) and the values
/// (null, a number, a string, or `{"blob": base64}`).
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct QueryResult {
  pub columns: Vec<String>,
  pub types: Vec<String>,
  pub rows: Vec<Vec<Value>>,
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
  pub rows_affected: u64,
  pub last_insert_rowid: i64,
}

fn err(n: u32, msg: &str) -> String {
  format!("{}|{}", n, msg)
}

/// A SQLite error as the DAO error a VB6 program would see.
fn sql_err(e: &rusqlite::Error) -> String {
  let msg = e.to_string();
  let low = msg.to_lowercase();
  if let rusqlite::Error::SqliteFailure(f, _) = e {
    match f.code {
      ErrorCode::ConstraintViolation => {
        let n = if low.contains("unique") || low.contains("primary key") { 3022 } else if low.contains("not null") { 3314 } else { 3317 };
        return err(n, &msg);
      }
      ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => return err(3260, &msg),
      ErrorCode::ReadOnly => return err(3027, &msg),
      ErrorCode::NotADatabase => return err(3343, &msg),
      ErrorCode::CannotOpen => return err(3024, &msg),
      _ => {}
    }
  }
  if low.contains("no such table") {
    err(3078, &msg)
  } else if low.contains("no such column") {
    err(3061, &msg)
  } else if low.contains("syntax error") || low.contains("incomplete input") {
    err(3075, &msg)
  } else if matches!(e, rusqlite::Error::ExecuteReturnedResults) {
    err(3065, "Cannot execute a select query.")
  } else {
    err(3146, &msg)
  }
}

fn to_sql(v: &Value) -> SqlValue {
  match v {
    Value::Null => SqlValue::Null,
    Value::Bool(b) => SqlValue::Integer(*b as i64),
    Value::Number(n) => match n.as_i64() {
      Some(i) => SqlValue::Integer(i),
      None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
    },
    Value::String(s) => SqlValue::Text(s.clone()),
    Value::Object(o) => match o.get("blob").and_then(|b| b.as_str()) {
      Some(b) => SqlValue::Blob(B64.decode(b.as_bytes()).unwrap_or_default()),
      None => SqlValue::Null,
    },
    Value::Array(_) => SqlValue::Null,
  }
}

fn from_sql(v: ValueRef<'_>) -> Value {
  match v {
    ValueRef::Null => Value::Null,
    ValueRef::Integer(i) => Value::from(i),
    ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
    ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
    ValueRef::Blob(b) => {
      let mut m = Map::new();
      m.insert("blob".into(), Value::String(B64.encode(b)));
      Value::Object(m)
    }
  }
}

impl Databases {
  /// Opens (and creates when missing) the database file at `path`; error 3044 when its folder does not exist.
  pub fn open(&self, path: &str) -> Result<u32, String> {
    let p = Path::new(path);
    if p.is_dir() || path.is_empty() {
      return Err(err(3044, &format!("'{}' isn't a valid path.", path)));
    }
    if p.parent().is_some_and(|d| !d.as_os_str().is_empty() && !d.is_dir()) {
      return Err(err(3044, &format!("'{}' isn't a valid path.", path)));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(p, flags).map_err(|e| sql_err(&e))?;
    let _ = conn.busy_timeout(Duration::from_secs(2));
    // a file that is not a database fails here rather than on the first query
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(())).map_err(|e| sql_err(&e))?;
    let interrupt = conn.get_interrupt_handle();
    let mut g = self.0.lock().unwrap();
    g.next += 1;
    let id = g.next;
    g.conns.insert(id, Arc::new(Db { conn: Mutex::new(conn), interrupt }));
    Ok(id)
  }

  /// Runs `f` on connection `id`; the map lock is held only for the lookup.
  fn with<T>(&self, id: u32, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let db = self.0.lock().unwrap().conns.get(&id).cloned().ok_or_else(|| err(3420, "Object invalid or no longer set."))?;
    let c = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    f(&c)
  }

  pub fn query(&self, id: u32, sql: &str, params: &[Value]) -> Result<QueryResult, String> {
    self.query_limited(id, sql, params, MAX_ROWS, MAX_BYTES)
  }

  fn query_limited(&self, id: u32, sql: &str, params: &[Value], max_rows: usize, max_bytes: usize) -> Result<QueryResult, String> {
    self.with(id, |c| {
      let mut st = c.prepare(sql).map_err(|e| sql_err(&e))?;
      let columns: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
      let types: Vec<String> = st.columns().iter().map(|col| col.decl_type().unwrap_or("").to_string()).collect();
      let n = columns.len();
      let args: Vec<SqlValue> = params.iter().map(to_sql).collect();
      let mut rows = st.query(rusqlite::params_from_iter(args.iter())).map_err(|e| sql_err(&e))?;
      let mut out = Vec::new();
      let mut bytes = 0usize;
      while let Some(r) = rows.next().map_err(|e| sql_err(&e))? {
        if out.len() >= max_rows {
          return Err(err(7, "Out of memory"));
        }
        let mut row = Vec::with_capacity(n);
        for i in 0..n {
          let v = r.get_ref(i).map_err(|e| sql_err(&e))?;
          bytes += 16 + match v {
            ValueRef::Text(t) | ValueRef::Blob(t) => t.len(),
            _ => 8,
          };
          row.push(from_sql(v));
        }
        if bytes > max_bytes {
          return Err(err(7, "Out of memory"));
        }
        out.push(row);
      }
      Ok(QueryResult { columns, types, rows: out })
    })
  }

  /// One statement with `params`; without params the SQL may hold several statements (rowsAffected is the last one's).
  pub fn execute(&self, id: u32, sql: &str, params: &[Value]) -> Result<ExecResult, String> {
    self.with(id, |c| {
      let rows_affected = if params.is_empty() {
        c.execute_batch(sql).map_err(|e| sql_err(&e))?;
        c.changes()
      } else {
        let args: Vec<SqlValue> = params.iter().map(to_sql).collect();
        c.execute(sql, rusqlite::params_from_iter(args.iter())).map_err(|e| sql_err(&e))? as u64
      };
      Ok(ExecResult { rows_affected, last_insert_rowid: c.last_insert_rowid() })
    })
  }

  /// The connection is closed once a query still running on it (interrupted here) has stopped.
  pub fn close(&self, id: u32) {
    let db = self.0.lock().unwrap().conns.remove(&id);
    if let Some(db) = db {
      db.interrupt.interrupt();
    }
  }

  /// Every connection: running queries are interrupted, and nothing waits for them.
  pub fn reset(&self) {
    let all: Vec<Arc<Db>> = self.0.lock().unwrap().conns.drain().map(|(_, d)| d).collect();
    for db in &all {
      db.interrupt.interrupt();
    }
  }
}

#[tauri::command]
pub async fn db_open(dbs: State<'_, Databases>, path: String) -> Result<u32, String> {
  let dbs = dbs.inner().clone();
  off_main(move || dbs.open(&path)).await
}

#[tauri::command]
pub async fn db_query(dbs: State<'_, Databases>, id: u32, sql: String, params: Vec<Value>) -> Result<QueryResult, String> {
  let dbs = dbs.inner().clone();
  off_main(move || dbs.query(id, &sql, &params)).await
}

#[tauri::command]
pub async fn db_execute(dbs: State<'_, Databases>, id: u32, sql: String, params: Vec<Value>) -> Result<ExecResult, String> {
  let dbs = dbs.inner().clone();
  off_main(move || dbs.execute(id, &sql, &params)).await
}

#[tauri::command]
pub async fn db_close(dbs: State<'_, Databases>, id: u32) -> Result<(), String> {
  dbs.close(id);
  Ok(())
}

/// The end of a run (and the start of the next): every connection closed, running queries interrupted.
#[tauri::command]
pub async fn db_reset(dbs: State<'_, Databases>) -> Result<(), String> {
  dbs.reset();
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn create_insert_query_update_delete() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("people.db").to_string_lossy().to_string();
    let dbs = Databases::default();
    let id = dbs.open(&path).unwrap();
    dbs.execute(id, "CREATE TABLE People (ID INTEGER PRIMARY KEY, Name TEXT NOT NULL UNIQUE, Age INTEGER, Born DATE)", &[]).unwrap();
    let r = dbs.execute(id, "INSERT INTO People (Name, Age) VALUES (?, ?)", &[json!("Ann"), json!(31)]).unwrap();
    assert_eq!(r, ExecResult { rows_affected: 1, last_insert_rowid: 1 });
    dbs.execute(id, "INSERT INTO People (Name, Age, Born) VALUES (?, ?, ?)", &[json!("Bob"), json!(2.5), json!("2000-01-02")]).unwrap();

    let q = dbs.query(id, "SELECT rowid AS r, * FROM People ORDER BY ID", &[]).unwrap();
    // rowid is the INTEGER PRIMARY KEY here, so it has its declared type
    assert_eq!(q.columns, vec!["r", "ID", "Name", "Age", "Born"]);
    assert_eq!(q.types, vec!["INTEGER", "INTEGER", "TEXT", "INTEGER", "DATE"]);
    assert_eq!(q.rows, vec![
      vec![json!(1), json!(1), json!("Ann"), json!(31), Value::Null],
      vec![json!(2), json!(2), json!("Bob"), json!(2.5), json!("2000-01-02")],
    ]);

    let u = dbs.execute(id, "UPDATE People SET Age = ? WHERE rowid = ?", &[json!(32), json!(1)]).unwrap();
    assert_eq!(u.rows_affected, 1);
    let d = dbs.execute(id, "DELETE FROM People WHERE Name = ?", &[json!("Bob")]).unwrap();
    assert_eq!(d.rows_affected, 1);
    let q = dbs.query(id, "SELECT Name, Age FROM People", &[]).unwrap();
    assert_eq!(q.rows, vec![vec![json!("Ann"), json!(32)]]);

    // DAO error numbers
    assert!(dbs.query(id, "SELECT * FROM Nope", &[]).unwrap_err().starts_with("3078|"));
    assert!(dbs.execute(id, "INSERT INTO People (Name) VALUES (?)", &[json!("Ann")]).unwrap_err().starts_with("3022|"));
    assert!(dbs.execute(id, "INSERT INTO People (Age) VALUES (?)", &[json!(1)]).unwrap_err().starts_with("3314|"));
    assert!(dbs.query(id, "SELEKT", &[]).unwrap_err().starts_with("3075|"));

    // the data is in the file
    dbs.reset();
    assert!(dbs.query(id, "SELECT 1", &[]).unwrap_err().starts_with("3420|"));
    let id2 = dbs.open(&path).unwrap();
    assert_eq!(dbs.query(id2, "SELECT count(*) FROM People", &[]).unwrap().rows, vec![vec![json!(1)]]);
    dbs.close(id2);
    assert!(dbs.open(&dir.path().join("no/such/x.db").to_string_lossy()).unwrap_err().starts_with("3044|"));
  }

  const RUNAWAY: &str = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n";

  /// H2: a runaway query is stopped by the row cap with "7|" instead of using all the memory.
  #[test]
  fn a_runaway_result_is_out_of_memory() {
    let dir = tempfile::tempdir().unwrap();
    let dbs = Databases::default();
    let id = dbs.open(&dir.path().join("a.db").to_string_lossy()).unwrap();
    assert!(dbs.query_limited(id, RUNAWAY, &[], 1000, MAX_BYTES).unwrap_err().starts_with("7|"));
    let blob = "SELECT zeroblob(1000) FROM (WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 100) SELECT x FROM n)";
    assert!(dbs.query_limited(id, blob, &[], MAX_ROWS, 50_000).unwrap_err().starts_with("7|"));
    assert_eq!(dbs.query_limited(id, blob, &[], MAX_ROWS, 200_000).unwrap().rows.len(), 100);
  }

  /// H2: reset does not wait for a query that never ends; it interrupts it, and the next run can open databases at once.
  #[test]
  fn reset_interrupts_a_query_that_never_ends() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.db").to_string_lossy().to_string();
    let dbs = Databases::default();
    let id = dbs.open(&path).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let d = dbs.clone();
    // no row ever comes out of this, so the row cap does not stop it
    std::thread::spawn(move || {
      let _ = tx.send(d.query(id, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n", &[]));
    });
    std::thread::sleep(Duration::from_millis(200));
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let d = dbs.clone();
    std::thread::spawn(move || {
      d.reset();
      let id2 = d.open(&path);
      let _ = done_tx.send(id2.is_ok());
    });
    assert!(done_rx.recv_timeout(Duration::from_secs(5)).expect("reset waited for the query"));
    let r = rx.recv_timeout(Duration::from_secs(5)).expect("the query was not interrupted");
    assert!(r.is_err());
  }
}
