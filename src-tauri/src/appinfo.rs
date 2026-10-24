//! What a running program asks about its own process: Command$ (the arguments, or the files opened with a made app),
//! Environ, App.PrevInstance and App.LogEvent. Main window only (capabilities/default.json).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

#[cfg(target_os = "macos")]
use crate::make_app::{bundle_from_exe, current_bundle};

/// The files the app was asked to open (Finder: Open With, a double-clicked document of a made app's file types). macOS
/// only: Windows Explorer and Linux file managers pass an opened document on the command line instead.
#[derive(Default)]
pub struct OpenedFiles(pub Mutex<Vec<String>>);

impl OpenedFiles {
  /// The files of one open request (a launch by a document, or a later Open With) replace those of the one before.
  #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
  pub fn set(&self, paths: impl IntoIterator<Item = String>) {
    if let Ok(mut v) = self.0.lock() {
      *v = paths.into_iter().collect();
    }
  }
}

/// Command$: the files opened with the app when there are any, else the process arguments after the executable; joined with
/// spaces. Old macOS passed a `-psn_...` process serial number argument: it is not part of the command line.
pub fn command_line(args: impl IntoIterator<Item = String>, opened: &[String]) -> String {
  if !opened.is_empty() {
    return opened.join(" ");
  }
  args.into_iter().skip(1).filter(|a| !a.starts_with("-psn_")).collect::<Vec<_>>().join(" ")
}

/// The arguments of a Windows command line as it was typed: everything after the program, which is a quoted path or runs
/// to the first blank. VB6's Command$ is this raw text, so a document Explorer passes keeps its quotes ("C:\My Files\a.txt").
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_arguments(raw: &str) -> &str {
  let rest = match raw.strip_prefix('"') {
    Some(q) => q.find('"').map_or("", |i| &q[i + 1..]),
    None => raw.find([' ', '\t']).map_or("", |i| &raw[i..]),
  };
  rest.trim_start_matches([' ', '\t'])
}

#[cfg(windows)]
fn raw_command_line() -> String {
  // SAFETY: GetCommandLineW returns the process's NUL-terminated command line, which lives as long as the process.
  unsafe {
    let p = windows_sys::Win32::System::Environment::GetCommandLineW();
    if p.is_null() {
      return String::new();
    }
    let len = (0..).take_while(|&i| *p.add(i) != 0).count();
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
  }
}

#[tauri::command]
pub fn get_command_line(opened: State<'_, OpenedFiles>) -> String {
  let files = opened.0.lock().map(|v| v.clone()).unwrap_or_default();
  #[cfg(windows)]
  if files.is_empty() {
    return windows_arguments(&raw_command_line()).to_string();
  }
  command_line(std::env::args(), &files)
}

/// Environ: the process environment as NAME / value pairs, in the process's order (Environ(n) is the n-th).
#[tauri::command]
pub fn get_environment() -> Vec<(String, String)> {
  std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect()
}

#[cfg(target_os = "macos")]
fn bundle_id(bundle: &Path) -> Option<String> {
  plist::Value::from_file(bundle.join("Contents/Info.plist"))
    .ok()?
    .into_dictionary()?
    .get("CFBundleIdentifier")?
    .as_string()
    .map(str::to_string)
}

/// True when one of `others` (the executables of the other processes) belongs to a bundle with the identifier `id`.
#[cfg(target_os = "macos")]
pub fn other_instance_of(id: &str, others: impl IntoIterator<Item = PathBuf>) -> bool {
  others.into_iter().filter_map(|exe| bundle_from_exe(&exe).ok()).any(|b| bundle_id(&b).as_deref() == Some(id))
}

/// The executables of every other process this user can see.
#[cfg(target_os = "macos")]
fn other_executables() -> Vec<PathBuf> {
  use std::os::unix::ffi::OsStringExt;
  let me = std::process::id() as libc::c_int;
  let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
  if n <= 0 {
    return vec![];
  }
  let mut pids = vec![0 as libc::c_int; n as usize + 64];
  let bytes = (pids.len() * std::mem::size_of::<libc::c_int>()) as libc::c_int;
  let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
  pids.truncate(got.max(0) as usize);
  let mut out = vec![];
  let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
  for pid in pids.into_iter().filter(|&p| p > 0 && p != me) {
    let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if len > 0 {
      out.push(PathBuf::from(std::ffi::OsString::from_vec(buf[..len as usize].to_vec())));
    }
  }
  out
}

/// Off macOS a program is known by its executable's file name (a made app has one of its own); Windows compares it
/// without regard to case and without ".exe". Another copy of the same program in another folder counts, as with the
/// bundle identifier on macOS (and an AppImage runs from a new mount point each time).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn same_program(me: &Path, other: &Path, ignore_case: bool) -> bool {
  let stem = |p: &Path| {
    let full = p.to_string_lossy();
    if !ignore_case {
      return p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    }
    let n = full.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
    n.strip_suffix(".exe").map(str::to_string).unwrap_or(n)
  };
  let m = stem(me);
  !m.is_empty() && m == stem(other)
}

/// The executable names of every other process (Toolhelp32 gives the file name, which is all `same_program` needs).
#[cfg(windows)]
fn other_executables() -> Vec<PathBuf> {
  use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
  use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
  let me = std::process::id();
  let mut out = vec![];
  // SAFETY: the snapshot handle is closed below; each entry is filled by Process32FirstW / Process32NextW.
  unsafe {
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snap == INVALID_HANDLE_VALUE {
      return out;
    }
    let mut e: PROCESSENTRY32W = std::mem::zeroed();
    e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = Process32FirstW(snap, &mut e) != 0;
    while ok {
      if e.th32ProcessID != me {
        let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
        out.push(PathBuf::from(String::from_utf16_lossy(&e.szExeFile[..len])));
      }
      ok = Process32NextW(snap, &mut e) != 0;
    }
    CloseHandle(snap);
  }
  out
}

/// The executables of every other process this user can see (/proc/<pid>/exe; other users' are not readable).
#[cfg(all(unix, not(target_os = "macos")))]
fn other_executables() -> Vec<PathBuf> {
  let me = std::process::id().to_string();
  let Ok(dir) = std::fs::read_dir("/proc") else { return vec![] };
  dir
    .flatten()
    .filter(|e| e.file_name().to_str().is_some_and(|n| n != me && n.bytes().all(|b| b.is_ascii_digit())))
    .filter_map(|e| std::fs::read_link(e.path().join("exe")).ok())
    .collect()
}

/// App.PrevInstance: another process of the same app (the same bundle identifier) is running. False outside a bundle.
/// Off the main thread: it lists every process and reads the Info.plist of each bundle (a slow volume would freeze the UI).
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn app_prev_instance() -> Result<bool, String> {
  crate::io_util::off_main(|| {
    let Some(id) = current_bundle().ok().and_then(|b| bundle_id(&b)) else { return Ok(false) };
    Ok(other_instance_of(&id, other_executables()))
  })
  .await
}

/// App.PrevInstance off macOS: another process runs the executable of the same name.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn app_prev_instance() -> Result<bool, String> {
  crate::io_util::off_main(|| {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(other_executables().iter().any(|o| same_program(&me, o, cfg!(windows))))
  })
  .await
}

/// `<data folder>/<id>/<name>.log`. The data folder is Tauri's: ~/Library/Application Support on macOS, %APPDATA% (Roaming)
/// on Windows, $XDG_DATA_HOME or ~/.local/share on Linux.
pub fn log_path(data_dir: &Path, id: &str, name: &str) -> PathBuf {
  data_dir.join(id).join(format!("{name}.log"))
}

/// The id and name of the app the log belongs to: the bundle's on macOS. Off macOS a made app (an embedded project) is
/// named after its executable and the IDE is "no.vibebasic.ide" / "VibeBasic" as on macOS.
#[cfg(target_os = "macos")]
fn log_owner<R: Runtime>(_app: &AppHandle<R>) -> (String, String) {
  let bundle = current_bundle().ok();
  let id = bundle.as_deref().and_then(bundle_id).unwrap_or_else(|| "no.vibebasic.ide".into());
  let name = bundle.as_deref().map(crate::embedded::bundle_display_name).unwrap_or_else(|| "VibeBasic".into());
  (id, name)
}

#[cfg(not(target_os = "macos"))]
fn log_owner<R: Runtime>(app: &AppHandle<R>) -> (String, String) {
  match crate::embedded::app_name(app) {
    Some(name) => (crate::make_app::bundle_id_for(&name), name),
    None => ("no.vibebasic.ide".into(), "VibeBasic".into()),
  }
}

/// The log file of App.LogEvent.
fn log_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  let base = app.path().data_dir().map_err(|e| format!("no data folder: {e}"))?;
  let (id, name) = log_owner(app);
  Ok(log_path(&base, &id, &name))
}

/// Appends `line` (one log entry, without the line end) to `file`, creating its folder.
pub fn append_line(file: &Path, line: &str) -> Result<(), String> {
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  }
  let mut f = std::fs::OpenOptions::new().create(true).append(true).open(file).map_err(|e| format!("{}: {e}", file.display()))?;
  writeln!(f, "{line}").map_err(|e| format!("{}: {e}", file.display()))
}

/// App.LogEvent: file I/O, so off the main thread (files.rs).
#[tauri::command]
pub async fn app_log_event<R: Runtime>(app: AppHandle<R>, line: String) -> Result<(), String> {
  crate::io_util::off_main(move || append_line(&log_file(&app)?, &line)).await
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Review 0.9 #6: the commands that list processes or write files run off the main thread (async + off_main).
  #[test]
  fn blocking_commands_are_async() {
    let src = include_str!("appinfo.rs");
    for name in ["app_prev_instance", "app_log_event"] {
      assert!(src.contains(&format!("pub async fn {name}")), "{name} must be async");
      assert!(!src.contains(&format!("pub fn {name}")), "{name} must not be a sync command");
    }
  }

  #[test]
  fn command_line_from_args_or_opened_files() {
    let args = || ["/A.app/Contents/MacOS/A", "-psn_0_123", "x", "y z"].map(String::from);
    assert_eq!(command_line(args(), &[]), "x y z");
    assert_eq!(command_line(["/a"].map(String::from), &[]), "");
    assert_eq!(command_line(args(), &["/Users/me/a.kalk".into()]), "/Users/me/a.kalk");
  }

  #[test]
  fn windows_command_line_keeps_the_arguments_as_typed() {
    assert_eq!(windows_arguments(r#""C:\Program Files\Kalk\Kalk.exe" "C:\My Files\a.kalk""#), r#""C:\My Files\a.kalk""#);
    assert_eq!(windows_arguments(r#"kalk.exe  /x  y"#), "/x  y");
    assert_eq!(windows_arguments(r#""C:\Kalk.exe""#), "");
    assert_eq!(windows_arguments("kalk.exe"), "");
    assert_eq!(windows_arguments(""), "");
  }

  #[test]
  fn prev_instance_off_macos_compares_the_executable_name() {
    let me = Path::new(r"C:\Apps\Kalk.exe");
    assert!(same_program(me, Path::new("kalk.EXE"), true));
    assert!(same_program(me, Path::new(r"D:\Copy\KALK.exe"), true));
    assert!(!same_program(me, Path::new("notepad.exe"), true));
    let me = Path::new("/tmp/.mount_Kalk1/usr/bin/kalk");
    assert!(same_program(me, Path::new("/tmp/.mount_Kalk2/usr/bin/kalk"), false));
    assert!(!same_program(me, Path::new("/usr/bin/Kalk"), false));
    assert!(!same_program(Path::new(""), Path::new(""), false));
  }

  #[test]
  fn log_path_is_data_folder_id_name() {
    let p = log_path(Path::new("/home/me/.local/share"), "no.vibebasic.app.kalk", "Kalk");
    assert_eq!(p, Path::new("/home/me/.local/share/no.vibebasic.app.kalk/Kalk.log"));
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn prev_instance_matches_the_bundle_id() {
    let tmp = tempfile::tempdir().unwrap();
    let mk = |name: &str, id: &str| {
      let b = tmp.path().join(name);
      std::fs::create_dir_all(b.join("Contents/MacOS")).unwrap();
      let mut d = plist::Dictionary::new();
      d.insert("CFBundleIdentifier".into(), id.into());
      plist::Value::Dictionary(d).to_file_xml(b.join("Contents/Info.plist")).unwrap();
      b.join("Contents/MacOS/X")
    };
    let same = mk("Copy.app", "no.vibebasic.app.kalk");
    let other = mk("Other.app", "no.vibebasic.app.other");
    assert!(other_instance_of("no.vibebasic.app.kalk", [PathBuf::from("/bin/ls"), other.clone(), same]));
    assert!(!other_instance_of("no.vibebasic.app.kalk", [PathBuf::from("/bin/ls"), other]));
  }

  #[test]
  fn log_lines_are_appended() {
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("id/App.log");
    append_line(&f, "a").unwrap();
    append_line(&f, "b").unwrap();
    assert_eq!(std::fs::read_to_string(&f).unwrap(), "a\nb\n");
  }
}
