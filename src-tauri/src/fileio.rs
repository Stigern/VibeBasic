//! VB file I/O of a running program: the files of Open/Close (handles kept here, read and written by position), the
//! file-system statements (Kill, Name, MkDir, RmDir, FileCopy, SetAttr, FileLen/FileDateTime/GetAttr) and the
//! SaveSetting/GetSetting store. Only the main window (the run session) calls these. Errors are "number|description"
//! with the VB6 error number (53|File not found, 76|Path not found ...).

use base64::Engine;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// More open files than this is error 67 (Too many files), as VB6's 511 file numbers.
const MAX_OPEN: usize = 511;

fn vb(n: u32) -> String {
  let d = match n {
    5 => "Invalid procedure call or argument",
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
  files: HashMap<u32, File>,
}

#[derive(Default)]
pub struct OpenFiles(Mutex<Inner>);

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Opened {
  pub id: u32,
  pub len: u64,
}

impl OpenFiles {
  /// `mode`: input, output (truncates), append, binary, random. `access` (binary/random): "" (read/write, read-only when that
  /// is refused), read, write, readwrite. Input and Access Read need an existing file; the others create it.
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
    let file = match o.open(p) {
      Ok(f) => f,
      // Binary / Random without Access on a read-only file: VB6 falls back to reading
      Err(e) if e.kind() == ErrorKind::PermissionDenied && (mode == "binary" || mode == "random") && access.is_empty() => {
        OpenOptions::new().read(true).open(p).map_err(|e| io_err(&e, p, 75))?
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
    g.files.insert(id, file);
    Ok(Opened { id, len })
  }

  /// Up to `len` bytes from `pos` (fewer at the end of the file).
  pub fn read(&self, id: u32, pos: u64, len: u32) -> Result<Vec<u8>, String> {
    let mut g = self.0.lock().unwrap();
    let f = g.files.get_mut(&id).ok_or_else(|| vb(52))?;
    f.seek(SeekFrom::Start(pos)).map_err(|_| vb(57))?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len as u64).read_to_end(&mut buf).map_err(|e| if e.kind() == ErrorKind::PermissionDenied { vb(75) } else { vb(57) })?;
    Ok(buf)
  }

  /// Writes `data` at `pos` (past the end, the gap is filled with zeros by the file system).
  pub fn write(&self, id: u32, pos: u64, data: &[u8]) -> Result<(), String> {
    let mut g = self.0.lock().unwrap();
    let f = g.files.get_mut(&id).ok_or_else(|| vb(52))?;
    f.seek(SeekFrom::Start(pos)).map_err(|_| vb(57))?;
    f.write_all(data).map_err(|e| match e.kind() {
      ErrorKind::StorageFull => vb(61),
      ErrorKind::PermissionDenied => vb(75),
      _ => vb(57),
    })
  }

  pub fn close(&self, id: u32) {
    if let Some(f) = self.0.lock().unwrap().files.remove(&id) {
      let _ = f.sync_all();
    }
  }
}

#[tauri::command]
pub fn fio_open(files: State<'_, OpenFiles>, path: String, mode: String, access: String) -> Result<Opened, String> {
  files.open(&path, &mode, &access)
}

/// The bytes as base64.
#[tauri::command]
pub fn fio_read(files: State<'_, OpenFiles>, id: u32, pos: u64, len: u32) -> Result<String, String> {
  files.read(id, pos, len).map(|b| B64.encode(b))
}

/// `data` is base64.
#[tauri::command]
pub fn fio_write(files: State<'_, OpenFiles>, id: u32, pos: u64, data: String) -> Result<(), String> {
  let bytes = B64.decode(data.as_bytes()).map_err(|_| vb(57))?;
  files.write(id, pos, &bytes)
}

#[tauri::command]
pub fn fio_close(files: State<'_, OpenFiles>, id: u32) {
  files.close(id)
}

// ---------------------------------------------------------------------------------------------------------------
// File-system statements

/// Kill: one file (a folder is 53, as in VB6).
#[tauri::command]
pub fn fs_kill(path: String) -> Result<(), String> {
  let p = Path::new(&path);
  if p.is_dir() {
    return Err(vb(53));
  }
  std::fs::remove_file(p).map_err(|e| io_err(&e, p, 75))
}

/// Name old As new: 53 when old is missing, 58 when new exists.
#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
  let (f, t) = (Path::new(&from), Path::new(&to));
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
#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
  let p = Path::new(&path);
  if std::fs::symlink_metadata(p).is_ok() {
    return Err(vb(75));
  }
  if parent_missing(p) {
    return Err(vb(76));
  }
  std::fs::create_dir(p).map_err(|e| io_err(&e, p, 75))
}

/// RmDir: 76 when missing, 75 when not empty or not a folder.
#[tauri::command]
pub fn fs_rmdir(path: String) -> Result<(), String> {
  let p = Path::new(&path);
  if !p.exists() {
    return Err(vb(76));
  }
  if !p.is_dir() {
    return Err(vb(75));
  }
  std::fs::remove_dir(p).map_err(|e| if e.kind() == ErrorKind::NotFound { vb(76) } else { io_err(&e, p, 75) })
}

/// FileCopy: overwrites the target. 53 when the source is missing, 76 when the target's folder is.
#[tauri::command]
pub fn fs_copy(from: String, to: String) -> Result<(), String> {
  let (f, t) = (Path::new(&from), Path::new(&to));
  if !f.is_file() {
    return Err(vb(if parent_missing(f) { 76 } else { 53 }));
  }
  if parent_missing(t) {
    return Err(vb(76));
  }
  if t.is_dir() {
    return Err(vb(75));
  }
  std::fs::copy(f, t).map(|_| ()).map_err(|e| io_err(&e, t, 75))
}

/// SetAttr: vbReadOnly (1) is the file's write permission; the other attributes have no Mac counterpart and are ignored.
#[tauri::command]
pub fn fs_set_attr(path: String, attr: u32) -> Result<(), String> {
  let p = Path::new(&path);
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
#[tauri::command]
pub fn fs_stat(path: String) -> Option<FileStat> {
  let p = PathBuf::from(&path);
  let meta = std::fs::metadata(&p).ok()?;
  let mtime = meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as f64)
    .unwrap_or(0.0);
  let hidden = p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'));
  Some(FileStat { is_dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() }, mtime, read_only: meta.permissions().readonly(), hidden })
}

// ---------------------------------------------------------------------------------------------------------------
// SaveSetting / GetSetting: one JSON file { app: { section: { key: value } } }; names match without regard to case,
// as registry keys do.

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_config_dir().map_err(|_| vb(75))?;
  Ok(dir.join("vb-settings.json"))
}

fn load(file: &Path) -> Map<String, Value> {
  std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn store(file: &Path, m: &Map<String, Value>) -> Result<(), String> {
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|e| io_err(&e, dir, 75))?;
  }
  let tmp = file.with_extension("json.tmp");
  let text = serde_json::to_string_pretty(&Value::Object(m.clone())).map_err(|_| vb(57))?;
  std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, file)).map_err(|e| io_err(&e, file, 75))
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

pub fn setting_get_in(file: &Path, app: &str, sec: &str, key: &str) -> Option<String> {
  let _g = SETTINGS_LOCK.lock().unwrap();
  let m = load(file);
  let s = section(&m, app, sec)?;
  s.get(&key_of(s, key)?)?.as_str().map(|s| s.to_string())
}

pub fn setting_save_in(file: &Path, app: &str, sec: &str, key: &str, value: &str) -> Result<(), String> {
  let _g = SETTINGS_LOCK.lock().unwrap();
  let mut m = load(file);
  let s = child(child(&mut m, app), sec);
  let k = key_of(s, key).unwrap_or_else(|| key.to_string());
  s.insert(k, Value::String(value.to_string()));
  store(file, &m)
}

/// Deletes a key, or the whole section when `key` is None. Error 5 when it does not exist (as VB6).
pub fn setting_delete_in(file: &Path, app: &str, sec: &str, key: Option<&str>) -> Result<(), String> {
  let _g = SETTINGS_LOCK.lock().unwrap();
  let mut m = load(file);
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
}

pub fn setting_all_in(file: &Path, app: &str, sec: &str) -> Vec<(String, String)> {
  let _g = SETTINGS_LOCK.lock().unwrap();
  let m = load(file);
  section(&m, app, sec)
    .map(|s| s.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
    .unwrap_or_default()
}

#[tauri::command]
pub fn setting_get(app: AppHandle, app_name: String, section: String, key: String) -> Result<Option<String>, String> {
  Ok(setting_get_in(&settings_file(&app)?, &app_name, &section, &key))
}

#[tauri::command]
pub fn setting_save(app: AppHandle, app_name: String, section: String, key: String, value: String) -> Result<(), String> {
  setting_save_in(&settings_file(&app)?, &app_name, &section, &key, &value)
}

#[tauri::command]
pub fn setting_delete(app: AppHandle, app_name: String, section: String, key: Option<String>) -> Result<(), String> {
  setting_delete_in(&settings_file(&app)?, &app_name, &section, key.as_deref())
}

#[tauri::command]
pub fn setting_all(app: AppHandle, app_name: String, section: String) -> Result<Vec<(String, String)>, String> {
  Ok(setting_all_in(&settings_file(&app)?, &app_name, &section))
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
    let st = fs_stat(s(&a)).unwrap();
    assert!(!st.is_dir && st.size == 3 && !st.read_only && st.mtime > 0.0);
    assert!(fs_stat(s(&dir.path().join("x"))).is_none());

    let b = dir.path().join("b.txt");
    fs_rename(s(&a), s(&b)).unwrap();
    assert_eq!(fs_rename(s(&a), s(&b)).unwrap_err(), "53|File not found");
    std::fs::write(&a, "x").unwrap();
    assert_eq!(fs_rename(s(&a), s(&b)).unwrap_err(), "58|File already exists");

    fs_copy(s(&b), s(&dir.path().join("c.txt"))).unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join("c.txt")).unwrap(), "abc");
    assert_eq!(fs_copy(s(&dir.path().join("zz")), s(&a)).unwrap_err(), "53|File not found");

    let sub = dir.path().join("sub");
    fs_mkdir(s(&sub)).unwrap();
    assert_eq!(fs_mkdir(s(&sub)).unwrap_err(), "75|Path/File access error");
    assert_eq!(fs_mkdir(s(&dir.path().join("q/r"))).unwrap_err(), "76|Path not found");
    std::fs::write(sub.join("f"), "x").unwrap();
    assert_eq!(fs_rmdir(s(&sub)).unwrap_err(), "75|Path/File access error");
    fs_kill(s(&sub.join("f"))).unwrap();
    assert_eq!(fs_kill(s(&sub.join("f"))).unwrap_err(), "53|File not found");
    fs_rmdir(s(&sub)).unwrap();
    assert_eq!(fs_rmdir(s(&sub)).unwrap_err(), "76|Path not found");

    fs_set_attr(s(&b), 1).unwrap();
    assert!(fs_stat(s(&b)).unwrap().read_only);
    fs_set_attr(s(&b), 0).unwrap();
    assert!(!fs_stat(s(&b)).unwrap().read_only);
  }

  #[test]
  fn settings_roundtrip_without_regard_to_case() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("cfg").join("vb-settings.json");
    assert_eq!(setting_get_in(&file, "App", "S", "K"), None);
    setting_save_in(&file, "MyApp", "Startup", "Top", "75").unwrap();
    setting_save_in(&file, "myapp", "startup", "Left", "50").unwrap();
    assert_eq!(setting_get_in(&file, "MYAPP", "STARTUP", "top").as_deref(), Some("75"));
    setting_save_in(&file, "MyApp", "Startup", "TOP", "80").unwrap();
    assert_eq!(setting_get_in(&file, "MyApp", "Startup", "Top").as_deref(), Some("80"));
    let mut all = setting_all_in(&file, "MyApp", "Startup");
    all.sort();
    assert_eq!(all, vec![("Left".to_string(), "50".to_string()), ("Top".to_string(), "80".to_string())]);
    setting_delete_in(&file, "MyApp", "Startup", Some("Left")).unwrap();
    assert_eq!(setting_delete_in(&file, "MyApp", "Startup", Some("Left")).unwrap_err(), "5|Invalid procedure call or argument");
    setting_delete_in(&file, "MyApp", "Startup", None).unwrap();
    assert!(setting_all_in(&file, "MyApp", "Startup").is_empty());
    assert_eq!(setting_delete_in(&file, "MyApp", "Startup", None).unwrap_err(), "5|Invalid procedure call or argument");
  }
}
