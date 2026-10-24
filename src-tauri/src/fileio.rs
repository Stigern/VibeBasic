//! VB file I/O of a running program: the files of Open/Close (handles kept here, read and written by position), the
//! file-system statements (Kill, Name, MkDir, RmDir, FileCopy, SetAttr, FileLen/FileDateTime/GetAttr) and the
//! SaveSetting/GetSetting store. Only the main window (the run session) calls these. Errors are "number|description"
//! with the VB6 error number (53|File not found, 76|Path not found ...).
//!
//! Every command is `async` and does its work on the blocking pool (`off_main`): a slow disk, a big FileCopy or a FIFO
//! must not freeze the main thread. Open refuses anything that is not a regular file (75) rather than block on it.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use tauri::{AppHandle, Manager, State};

use crate::io_util::{off_main, open_regular};

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// More open files than this is error 67 (Too many files), as VB6's 511 file numbers.
const MAX_OPEN: usize = 511;
/// One fio_read returns at most this many bytes (the frontend reads big files in chunks).
pub const MAX_READ: u32 = 64 * 1024 * 1024;

fn vb(n: u32) -> String {
  let d = match n {
    5 => "Invalid procedure call or argument",
    7 => "Out of memory",
    52 => "Bad file name or number",
    53 => "File not found",
    57 => "Device I/O error",
    58 => "File already exists",
    61 => "Disk full",
    67 => "Too many files",
    70 => "Permission denied",
    75 => "Path/File access error",
    76 => "Path not found",
    _ => "Device I/O error",
  };
  format!("{}|{}", n, d)
}

fn parent_missing(path: &Path) -> bool {
  path.parent().is_some_and(|p| !p.as_os_str().is_empty() && !p.is_dir())
}

/// An io error as a VB error: a missing file is 53 (76 when its folder is missing), `other` for the rest.
fn io_err(e: &std::io::Error, path: &Path, other: u32) -> String {
  match e.kind() {
    ErrorKind::NotFound => vb(if parent_missing(path) { 76 } else { 53 }),
    ErrorKind::PermissionDenied => vb(70),
    ErrorKind::AlreadyExists => vb(58),
    ErrorKind::StorageFull => vb(61),
    ErrorKind::IsADirectory | ErrorKind::NotADirectory | ErrorKind::DirectoryNotEmpty | ErrorKind::ReadOnlyFilesystem => vb(75),
    _ => vb(other),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Open files

#[derive(Default)]
struct Inner {
  next: u32,
  /// Each file has its own lock, so a slow read of one file does not hold up the others.
  files: HashMap<u32, Arc<Mutex<File>>>,
}

/// Every open file of the app (one running program at a time). `reset` closes them all when a run starts.
#[derive(Default, Clone)]
pub struct OpenFiles(Arc<Mutex<Inner>>);

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Opened {
  pub id: u32,
  pub len: u64,
}

impl OpenFiles {
  fn get(&self, id: u32) -> Result<Arc<Mutex<File>>, String> {
    self.0.lock().unwrap().files.get(&id).cloned().ok_or_else(|| vb(52))
  }

  /// `mode`: input, output (truncates), append, binary, random. `access` (binary/random): "" (read/write, read-only when that
  /// is refused), read, write, readwrite. Input and Access Read need an existing file; the others create it. A FIFO, device or
  /// socket is 75.
  pub fn open(&self, path: &str, mode: &str, access: &str) -> Result<Opened, String> {
    let p = Path::new(path);
    if p.is_dir() {
      return Err(vb(75));
    }
    let mut o = OpenOptions::new();
    match (mode, access) {
      ("input", _) | (_, "read") => o.read(true),
      ("output", _) => o.write(true).create(true).truncate(true),
      ("append", _) => o.read(true).write(true).create(true),
      (_, "write") => o.write(true).create(true),
      _ => o.read(true).write(true).create(true),
    };
    let file = match open_regular(p, &o) {
      Ok(f) => f,
      // Binary / Random without Access on a read-only file: VB6 falls back to reading
      Err(e) if e.kind() == ErrorKind::PermissionDenied && (mode == "binary" || mode == "random") && access.is_empty() => {
        let mut r = OpenOptions::new();
        r.read(true);
        open_regular(p, &r).map_err(|e| io_err(&e, p, 75))?
      }
      Err(e) => return Err(io_err(&e, p, 75)),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut g = self.0.lock().unwrap();
    if g.files.len() >= MAX_OPEN {
      return Err(vb(67));
    }
    g.next += 1;
    let id = g.next;
    g.files.insert(id, Arc::new(Mutex::new(file)));
    Ok(Opened { id, len })
  }

  /// Up to `len` bytes from `pos` (fewer at the end of the file, and never more than MAX_READ).
  pub fn read(&self, id: u32, pos: u64, len: u32) -> Result<Vec<u8>, String> {
    let f = self.get(id)?;
    let mut f = f.lock().unwrap();
    f.seek(SeekFrom::Start(pos)).map_err(|_| vb(57))?;
    let len = len.min(MAX_READ);
    let mut buf = Vec::new();
    buf.try_reserve(len as usize).map_err(|_| vb(7))?;
    (&mut *f).take(len as u64).read_to_end(&mut buf).map_err(|e| if e.kind() == ErrorKind::PermissionDenied { vb(75) } else { vb(57) })?;
    Ok(buf)
  }

  /// Writes `data` at `pos` (past the end, the gap is filled with zeros by the file system).
  pub fn write(&self, id: u32, pos: u64, data: &[u8]) -> Result<(), String> {
    let f = self.get(id)?;
    let mut f = f.lock().unwrap();
    f.seek(SeekFrom::Start(pos)).map_err(|_| vb(57))?;
    f.write_all(data).map_err(|e| match e.kind() {
      ErrorKind::StorageFull => vb(61),
      ErrorKind::PermissionDenied => vb(75),
      _ => vb(57),
    })
  }

  pub fn close(&self, id: u32) {
    let f = self.0.lock().unwrap().files.remove(&id);
    if let Some(f) = f {
      let _ = f.lock().unwrap().sync_all();
    }
  }

  /// A run starts (or the page was reloaded): files left open by an earlier run are written out and closed.
  pub fn reset(&self) {
    let all: Vec<_> = self.0.lock().unwrap().files.drain().map(|(_, f)| f).collect();
    for f in all {
      let _ = f.lock().unwrap().sync_all();
    }
  }

  #[cfg(test)]
  fn count(&self) -> usize {
    self.0.lock().unwrap().files.len()
  }
}

#[tauri::command]
pub async fn fio_open(files: State<'_, OpenFiles>, path: String, mode: String, access: String) -> Result<Opened, String> {
  let files = files.inner().clone();
  off_main(move || files.open(&path, &mode, &access)).await
}

/// The bytes as a raw IPC response (an ArrayBuffer in the window: no JSON or base64), at most MAX_READ of them.
#[tauri::command]
pub async fn fio_read(files: State<'_, OpenFiles>, id: u32, pos: u64, len: u32) -> Result<tauri::ipc::Response, String> {
  let files = files.inner().clone();
  off_main(move || files.read(id, pos, len)).await.map(tauri::ipc::Response::new)
}

/// `data` is base64.
#[tauri::command]
pub async fn fio_write(files: State<'_, OpenFiles>, id: u32, pos: u64, data: String) -> Result<(), String> {
  let files = files.inner().clone();
  off_main(move || {
    let bytes = B64.decode(data.as_bytes()).map_err(|_| vb(57))?;
    files.write(id, pos, &bytes)
  })
  .await
}

#[tauri::command]
pub async fn fio_close(files: State<'_, OpenFiles>, id: u32) -> Result<(), String> {
  let files = files.inner().clone();
  off_main(move || {
    files.close(id);
    Ok(())
  })
  .await
}

/// The start of a run: every file an earlier run left open is closed.
#[tauri::command]
pub async fn fio_reset(files: State<'_, OpenFiles>) -> Result<(), String> {
  let files = files.inner().clone();
  off_main(move || {
    files.reset();
    Ok(())
  })
  .await
}

// ---------------------------------------------------------------------------------------------------------------
// File-system statements

/// Kill: one file (a folder is 53, as in VB6).
pub fn kill(path: &str) -> Result<(), String> {
  let p = Path::new(path);
  if p.is_dir() {
    return Err(vb(53));
  }
  std::fs::remove_file(p).map_err(|e| io_err(&e, p, 75))
}

/// Name old As new: 53 when old is missing, 58 when new exists.
pub fn rename(from: &str, to: &str) -> Result<(), String> {
  let (f, t) = (Path::new(from), Path::new(to));
  if std::fs::symlink_metadata(f).is_err() {
    return Err(vb(if parent_missing(f) { 76 } else { 53 }));
  }
  if std::fs::symlink_metadata(t).is_ok() {
    return Err(vb(58));
  }
  if parent_missing(t) {
    return Err(vb(76));
  }
  std::fs::rename(f, t).map_err(|e| io_err(&e, f, 75))
}

/// MkDir: 75 when it exists, 76 when the parent is missing.
pub fn mkdir(path: &str) -> Result<(), String> {
  let p = Path::new(path);
  if std::fs::symlink_metadata(p).is_ok() {
    return Err(vb(75));
  }
  if parent_missing(p) {
    return Err(vb(76));
  }
  std::fs::create_dir(p).map_err(|e| io_err(&e, p, 75))
}

/// RmDir: 76 when missing, 75 when not empty or not a folder.
pub fn rmdir(path: &str) -> Result<(), String> {
  let p = Path::new(path);
  if !p.exists() {
    return Err(vb(76));
  }
  if !p.is_dir() {
    return Err(vb(75));
  }
  std::fs::remove_dir(p).map_err(|e| if e.kind() == ErrorKind::NotFound { vb(76) } else { io_err(&e, p, 75) })
}

/// FileCopy: overwrites the target. 53 when the source is missing, 76 when the target's folder is. A target that is the
/// source itself (another spelling on a case-insensitive disk, a symlink or a hard link to it) is 70, as in VB6: copying a
/// file onto itself would empty it. A target that is not a regular file (a FIFO, a device) is 75.
pub fn copy(from: &str, to: &str) -> Result<(), String> {
  let (f, t) = (Path::new(from), Path::new(to));
  let Ok(src) = std::fs::metadata(f) else { return Err(vb(if parent_missing(f) { 76 } else { 53 })) };
  if !src.is_file() {
    return Err(vb(53));
  }
  if parent_missing(t) {
    return Err(vb(76));
  }
  if let Ok(dst) = std::fs::metadata(t) {
    if dst.is_dir() || !dst.is_file() {
      return Err(vb(75));
    }
    if same_file(f, &src, t, &dst) {
      return Err(vb(70));
    }
  }
  // std::fs::copy clones the file on APFS (fcopyfile), so a big copy on one volume is quick
  std::fs::copy(f, t).map(|_| ()).map_err(|e| io_err(&e, t, 75))
}

/// The same file under two names: the same device and inode on Unix (a hard link too); on Windows the same final path
/// (another spelling or a symlink; a hard link is not caught there).
#[cfg(unix)]
fn same_file(_: &Path, a: &std::fs::Metadata, _: &Path, b: &std::fs::Metadata) -> bool {
  use std::os::unix::fs::MetadataExt;
  (a.dev(), a.ino()) == (b.dev(), b.ino())
}

#[cfg(windows)]
fn same_file(a: &Path, _: &std::fs::Metadata, b: &Path, _: &std::fs::Metadata) -> bool {
  matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// SetAttr on Windows: VB6's attribute values are the file attributes themselves (vbReadOnly 1, vbHidden 2, vbSystem 4,
/// vbArchive 32); vbNormal (0) is FILE_ATTRIBUTE_NORMAL.
#[cfg(windows)]
pub fn set_attr(path: &str, attr: u32) -> Result<(), String> {
  use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, SetFileAttributesW};
  let p = Path::new(path);
  std::fs::metadata(p).map_err(|e| io_err(&e, p, 75))?;
  let a = attr & (1 | 2 | 4 | 32);
  let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
  // SAFETY: a NUL-terminated path.
  if unsafe { SetFileAttributesW(wide.as_ptr(), if a == 0 { FILE_ATTRIBUTE_NORMAL } else { a }) } == 0 {
    return Err(io_err(&std::io::Error::last_os_error(), p, 75));
  }
  Ok(())
}

/// SetAttr: vbReadOnly (1) is the file's write permission; the other attributes have no Mac counterpart and are ignored.
#[cfg(unix)]
pub fn set_attr(path: &str, attr: u32) -> Result<(), String> {
  let p = Path::new(path);
  let meta = std::fs::metadata(p).map_err(|e| io_err(&e, p, 75))?;
  use std::os::unix::fs::PermissionsExt;
  let mode = meta.permissions().mode();
  // read-only: no write bits; writable again: the owner's write bit (not everyone's)
  let mode = if attr & 1 != 0 { mode & !0o222 } else { mode | 0o200 };
  std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).map_err(|e| io_err(&e, p, 75))
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
  pub is_dir: bool,
  pub size: u64,
  /// Modification time, ms since 1970 (UTC).
  pub mtime: f64,
  pub read_only: bool,
  pub hidden: bool,
}

/// None when nothing is there.
pub fn stat(path: &str) -> Option<FileStat> {
  let p = PathBuf::from(path);
  let meta = std::fs::metadata(&p).ok()?;
  let mtime = meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as f64)
    .unwrap_or(0.0);
  let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let hidden = !name.is_empty() && crate::files::is_hidden(&name, crate::files::windows_attributes(&meta));
  Some(FileStat { is_dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() }, mtime, read_only: meta.permissions().readonly(), hidden })
}

#[tauri::command]
pub async fn fs_kill(path: String) -> Result<(), String> {
  off_main(move || kill(&path)).await
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
  off_main(move || rename(&from, &to)).await
}

#[tauri::command]
pub async fn fs_mkdir(path: String) -> Result<(), String> {
  off_main(move || mkdir(&path)).await
}

#[tauri::command]
pub async fn fs_rmdir(path: String) -> Result<(), String> {
  off_main(move || rmdir(&path)).await
}

#[tauri::command]
pub async fn fs_copy(from: String, to: String) -> Result<(), String> {
  off_main(move || copy(&from, &to)).await
}

#[tauri::command]
pub async fn fs_set_attr(path: String, attr: u32) -> Result<(), String> {
  off_main(move || set_attr(&path, attr)).await
}

#[tauri::command]
pub async fn fs_stat(path: String) -> Result<Option<FileStat>, String> {
  off_main(move || Ok(stat(&path))).await
}

// ---------------------------------------------------------------------------------------------------------------
// SaveSetting / GetSetting: one JSON file { app: { section: { key: value } } }; names match without regard to case,
// as registry keys do.
//
// The file is shared by the IDE and every app made with it (they have the same app identifier, so the same config
// folder), which can run at the same time. Every read-modify-write holds an exclusive flock on "vb-settings.json.lock",
// which also keeps the threads of one process apart (each opens the lock file itself). A new file is written under a
// unique temp name and renamed into place. A file that is not valid JSON is moved aside (".corrupt-<ms>"), never
// overwritten.

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_config_dir().map_err(|_| vb(75))?;
  Ok(dir.join("vb-settings.json"))
}

/// Runs `f` while holding the store's file lock.
fn locked<T>(file: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|e| io_err(&e, dir, 75))?;
  }
  let lock_path = file.with_extension("json.lock");
  let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path).map_err(|e| io_err(&e, &lock_path, 75))?;
  lock.lock().map_err(|e| io_err(&e, &lock_path, 75))?;
  let r = f();
  let _ = lock.unlock();
  r
}

fn load(file: &Path) -> Result<Map<String, Value>, String> {
  let text = match std::fs::read_to_string(file) {
    Ok(t) => t,
    Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Map::new()),
    Err(e) => return Err(io_err(&e, file, 75)),
  };
  if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&text) {
    return Ok(m);
  }
  let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  let aside = file.with_extension(format!("json.corrupt-{ms}"));
  std::fs::rename(file, &aside).map_err(|e| io_err(&e, file, 75))?;
  eprintln!("VibeBasic: {} was not valid JSON; moved to {}", file.display(), aside.display());
  Ok(Map::new())
}

fn store(file: &Path, m: &Map<String, Value>) -> Result<(), String> {
  let tmp = file.with_extension(format!("json.{}.{}.tmp", std::process::id(), TMP_SEQ.fetch_add(1, Ordering::Relaxed)));
  let text = serde_json::to_string_pretty(&Value::Object(m.clone())).map_err(|_| vb(57))?;
  let r = std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, file));
  if r.is_err() {
    let _ = std::fs::remove_file(&tmp);
  }
  r.map_err(|e| io_err(&e, file, 75))
}

/// The key of `m` equal to `name` without regard to case.
fn key_of(m: &Map<String, Value>, name: &str) -> Option<String> {
  let l = name.to_lowercase();
  m.keys().find(|k| k.to_lowercase() == l).cloned()
}

fn child<'a>(m: &'a mut Map<String, Value>, name: &str) -> &'a mut Map<String, Value> {
  let k = key_of(m, name).unwrap_or_else(|| name.to_string());
  let v = m.entry(k).or_insert_with(|| Value::Object(Map::new()));
  if !v.is_object() {
    *v = Value::Object(Map::new());
  }
  v.as_object_mut().unwrap()
}

fn section<'a>(m: &'a Map<String, Value>, app: &str, sec: &str) -> Option<&'a Map<String, Value>> {
  let a = m.get(&key_of(m, app)?)?.as_object()?;
  a.get(&key_of(a, sec)?)?.as_object()
}

pub fn setting_get_in(file: &Path, app: &str, sec: &str, key: &str) -> Result<Option<String>, String> {
  let m = locked(file, || load(file))?;
  let Some(s) = section(&m, app, sec) else { return Ok(None) };
  Ok(key_of(s, key).and_then(|k| s.get(&k)).and_then(|v| v.as_str()).map(|s| s.to_string()))
}

pub fn setting_save_in(file: &Path, app: &str, sec: &str, key: &str, value: &str) -> Result<(), String> {
  locked(file, || {
    let mut m = load(file)?;
    let s = child(child(&mut m, app), sec);
    let k = key_of(s, key).unwrap_or_else(|| key.to_string());
    s.insert(k, Value::String(value.to_string()));
    store(file, &m)
  })
}

/// Deletes a key, or the whole section when `key` is None. Error 5 when it does not exist (as VB6).
pub fn setting_delete_in(file: &Path, app: &str, sec: &str, key: Option<&str>) -> Result<(), String> {
  locked(file, || {
    let mut m = load(file)?;
    let ak = key_of(&m, app).ok_or_else(|| vb(5))?;
    let a = m.get_mut(&ak).and_then(|v| v.as_object_mut()).ok_or_else(|| vb(5))?;
    let sk = key_of(a, sec).ok_or_else(|| vb(5))?;
    match key {
      None => {
        a.remove(&sk);
      }
      Some(key) => {
        let s = a.get_mut(&sk).and_then(|v| v.as_object_mut()).ok_or_else(|| vb(5))?;
        let kk = key_of(s, key).ok_or_else(|| vb(5))?;
        s.remove(&kk);
      }
    }
    if a.is_empty() {
      m.remove(&ak);
    }
    store(file, &m)
  })
}

pub fn setting_all_in(file: &Path, app: &str, sec: &str) -> Result<Vec<(String, String)>, String> {
  let m = locked(file, || load(file))?;
  Ok(section(&m, app, sec)
    .map(|s| s.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
    .unwrap_or_default())
}

#[tauri::command]
pub async fn setting_get(app: AppHandle, app_name: String, section: String, key: String) -> Result<Option<String>, String> {
  let file = settings_file(&app)?;
  off_main(move || setting_get_in(&file, &app_name, &section, &key)).await
}

#[tauri::command]
pub async fn setting_save(app: AppHandle, app_name: String, section: String, key: String, value: String) -> Result<(), String> {
  let file = settings_file(&app)?;
  off_main(move || setting_save_in(&file, &app_name, &section, &key, &value)).await
}

#[tauri::command]
pub async fn setting_delete(app: AppHandle, app_name: String, section: String, key: Option<String>) -> Result<(), String> {
  let file = settings_file(&app)?;
  off_main(move || setting_delete_in(&file, &app_name, &section, key.as_deref())).await
}

#[tauri::command]
pub async fn setting_all(app: AppHandle, app_name: String, section: String) -> Result<Vec<(String, String)>, String> {
  let file = settings_file(&app)?;
  off_main(move || setting_all_in(&file, &app_name, &section)).await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
  }

  #[test]
  fn output_then_input_roundtrip_and_append() {
    let dir = tempfile::tempdir().unwrap();
    let path = s(&dir.path().join("a.txt"));
    let files = OpenFiles::default();
    let o = files.open(&path, "output", "").unwrap();
    assert_eq!(o.len, 0);
    files.write(o.id, 0, b"hello\r\n").unwrap();
    files.close(o.id);
    let a = files.open(&path, "append", "").unwrap();
    assert_eq!(a.len, 7);
    files.write(a.id, a.len, b"more\r\n").unwrap();
    files.close(a.id);
    let i = files.open(&path, "input", "").unwrap();
    assert_eq!(files.read(i.id, 0, 100).unwrap(), b"hello\r\nmore\r\n");
    assert_eq!(files.read(i.id, 7, 2).unwrap(), b"mo");
    files.close(i.id);
    // Output truncates
    let o = files.open(&path, "output", "").unwrap();
    files.close(o.id);
    assert_eq!(std::fs::read(&path).unwrap().len(), 0);
  }

  #[test]
  fn binary_writes_and_reads_by_position() {
    let dir = tempfile::tempdir().unwrap();
    let path = s(&dir.path().join("b.bin"));
    let files = OpenFiles::default();
    let b = files.open(&path, "binary", "").unwrap();
    files.write(b.id, 0, &[1, 2, 3, 4]).unwrap();
    files.write(b.id, 2, &[9]).unwrap();
    assert_eq!(files.read(b.id, 0, 10).unwrap(), vec![1, 2, 9, 4]);
    assert_eq!(files.read(b.id, 10, 4).unwrap(), Vec::<u8>::new());
    files.close(b.id);
    assert_eq!(files.read(b.id, 0, 1).unwrap_err(), "52|Bad file name or number");
  }

  #[test]
  fn open_errors_have_vb_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let files = OpenFiles::default();
    assert_eq!(files.open(&s(&dir.path().join("nope.txt")), "input", "").unwrap_err(), "53|File not found");
    assert_eq!(files.open(&s(&dir.path().join("no/x.txt")), "output", "").unwrap_err(), "76|Path not found");
    assert_eq!(files.open(&s(dir.path()), "input", "").unwrap_err(), "75|Path/File access error");
    assert_eq!(files.open(&s(&dir.path().join("nope.bin")), "binary", "read").unwrap_err(), "53|File not found");
  }

  #[test]
  fn kill_name_mkdir_rmdir_copy_and_stat() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.txt");
    std::fs::write(&a, "abc").unwrap();
    let st = stat(&s(&a)).unwrap();
    assert!(!st.is_dir && st.size == 3 && !st.read_only && st.mtime > 0.0);
    assert!(stat(&s(&dir.path().join("x"))).is_none());

    let b = dir.path().join("b.txt");
    rename(&s(&a), &s(&b)).unwrap();
    assert_eq!(rename(&s(&a), &s(&b)).unwrap_err(), "53|File not found");
    std::fs::write(&a, "x").unwrap();
    assert_eq!(rename(&s(&a), &s(&b)).unwrap_err(), "58|File already exists");

    copy(&s(&b), &s(&dir.path().join("c.txt"))).unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join("c.txt")).unwrap(), "abc");
    assert_eq!(copy(&s(&dir.path().join("zz")), &s(&a)).unwrap_err(), "53|File not found");

    let sub = dir.path().join("sub");
    mkdir(&s(&sub)).unwrap();
    assert_eq!(mkdir(&s(&sub)).unwrap_err(), "75|Path/File access error");
    assert_eq!(mkdir(&s(&dir.path().join("q/r"))).unwrap_err(), "76|Path not found");
    std::fs::write(sub.join("f"), "x").unwrap();
    assert_eq!(rmdir(&s(&sub)).unwrap_err(), "75|Path/File access error");
    kill(&s(&sub.join("f"))).unwrap();
    assert_eq!(kill(&s(&sub.join("f"))).unwrap_err(), "53|File not found");
    rmdir(&s(&sub)).unwrap();
    assert_eq!(rmdir(&s(&sub)).unwrap_err(), "76|Path not found");

    set_attr(&s(&b), 1).unwrap();
    assert!(stat(&s(&b)).unwrap().read_only);
    set_attr(&s(&b), 0).unwrap();
    assert!(!stat(&s(&b)).unwrap().read_only);
  }

  #[test]
  fn settings_roundtrip_without_regard_to_case() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("cfg").join("vb-settings.json");
    assert_eq!(setting_get_in(&file, "App", "S", "K").unwrap(), None);
    setting_save_in(&file, "MyApp", "Startup", "Top", "75").unwrap();
    setting_save_in(&file, "myapp", "startup", "Left", "50").unwrap();
    assert_eq!(setting_get_in(&file, "MYAPP", "STARTUP", "top").unwrap().as_deref(), Some("75"));
    setting_save_in(&file, "MyApp", "Startup", "TOP", "80").unwrap();
    assert_eq!(setting_get_in(&file, "MyApp", "Startup", "Top").unwrap().as_deref(), Some("80"));
    let mut all = setting_all_in(&file, "MyApp", "Startup").unwrap();
    all.sort();
    assert_eq!(all, vec![("Left".to_string(), "50".to_string()), ("Top".to_string(), "80".to_string())]);
    setting_delete_in(&file, "MyApp", "Startup", Some("Left")).unwrap();
    assert_eq!(setting_delete_in(&file, "MyApp", "Startup", Some("Left")).unwrap_err(), "5|Invalid procedure call or argument");
    setting_delete_in(&file, "MyApp", "Startup", None).unwrap();
    assert!(setting_all_in(&file, "MyApp", "Startup").unwrap().is_empty());
    assert_eq!(setting_delete_in(&file, "MyApp", "Startup", None).unwrap_err(), "5|Invalid procedure call or argument");
  }

  /// H1: FileCopy onto the source itself (the same path, another spelling, a symlink, a hard link) is 70 and leaves it intact.
  #[cfg(unix)]
  #[test]
  fn filecopy_onto_itself_is_refused_and_keeps_the_file() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("data.txt");
    std::fs::write(&a, "precious").unwrap();
    assert_eq!(copy(&s(&a), &s(&a)).unwrap_err(), "70|Permission denied");
    let link = dir.path().join("link.txt");
    std::os::unix::fs::symlink(&a, &link).unwrap();
    assert_eq!(copy(&s(&a), &s(&link)).unwrap_err(), "70|Permission denied");
    assert_eq!(copy(&s(&link), &s(&a)).unwrap_err(), "70|Permission denied");
    let hard = dir.path().join("hard.txt");
    std::fs::hard_link(&a, &hard).unwrap();
    assert_eq!(copy(&s(&a), &s(&hard)).unwrap_err(), "70|Permission denied");
    let upper = dir.path().join("DATA.TXT");
    let same_file = std::fs::metadata(&upper).is_ok_and(|m| m.ino() == std::fs::metadata(&a).unwrap().ino());
    if same_file {
      // a case-insensitive disk (the APFS default)
      assert_eq!(copy(&s(&a), &s(&upper)).unwrap_err(), "70|Permission denied");
    }
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "precious");
    // a FIFO target is refused instead of blocking
    let fifo = dir.path().join("pipe");
    crate::io_util::tests::mkfifo(&fifo);
    assert_eq!(copy(&s(&a), &s(&fifo)).unwrap_err(), "75|Path/File access error");
  }

  /// M1: Open of a FIFO is 75 at once instead of blocking in open(2).
  #[cfg(unix)]
  #[test]
  fn open_of_a_fifo_is_75_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("pipe");
    crate::io_util::tests::mkfifo(&fifo);
    let (tx, rx) = std::sync::mpsc::channel();
    let path = s(&fifo);
    std::thread::spawn(move || {
      let files = OpenFiles::default();
      let r: Vec<String> = ["input", "output", "append", "binary"].iter().map(|m| files.open(&path, m, "").unwrap_err()).collect();
      let _ = tx.send(r);
    });
    let r = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("Open of a FIFO blocked");
    assert!(r.iter().all(|e| e == "75|Path/File access error"), "{r:?}");
  }

  /// M2: one read returns at most MAX_READ bytes.
  #[test]
  fn a_read_is_clamped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.bin");
    let f = std::fs::File::create(&path).unwrap();
    f.set_len(MAX_READ as u64 + 10).unwrap();
    let files = OpenFiles::default();
    let o = files.open(&s(&path), "binary", "read").unwrap();
    assert_eq!(files.read(o.id, 0, u32::MAX).unwrap().len(), MAX_READ as usize);
    assert_eq!(files.read(o.id, MAX_READ as u64, u32::MAX).unwrap().len(), 10);
  }

  /// M3: reset closes what an earlier run left open (and writes it out).
  #[test]
  fn reset_closes_every_file() {
    let dir = tempfile::tempdir().unwrap();
    let files = OpenFiles::default();
    let a = files.open(&s(&dir.path().join("a.txt")), "output", "").unwrap();
    files.write(a.id, 0, b"kept").unwrap();
    files.open(&s(&dir.path().join("b.txt")), "output", "").unwrap();
    assert_eq!(files.count(), 2);
    files.reset();
    assert_eq!(files.count(), 0);
    assert_eq!(files.read(a.id, 0, 4).unwrap_err(), "52|Bad file name or number");
    assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "kept");
  }

  /// L1: a store that is not valid JSON is moved aside, not overwritten with an empty one.
  #[test]
  fn a_corrupt_settings_file_is_moved_aside() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("vb-settings.json");
    std::fs::write(&file, "{\"half\": ").unwrap();
    setting_save_in(&file, "App", "S", "K", "v").unwrap();
    assert_eq!(setting_get_in(&file, "App", "S", "K").unwrap().as_deref(), Some("v"));
    let aside: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".corrupt-")).collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), "{\"half\": ");
  }

  /// L1: concurrent writers (here threads, each with its own lock-file handle, as separate processes have) lose nothing.
  #[test]
  fn concurrent_saves_keep_every_value() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("vb-settings.json");
    let threads: Vec<_> = (0..8)
      .map(|t| {
        let file = file.clone();
        std::thread::spawn(move || {
          for i in 0..20 {
            setting_save_in(&file, &format!("App{t}"), "S", &format!("K{i}"), &format!("{t}-{i}")).unwrap();
          }
        })
      })
      .collect();
    for t in threads {
      t.join().unwrap();
    }
    for t in 0..8 {
      assert_eq!(setting_all_in(&file, &format!("App{t}"), "S").unwrap().len(), 20);
    }
    let leftovers = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
    assert_eq!(leftovers, 0);
  }
}
