//! What a running program asks about its own process: Command$ (the arguments, or the files opened with a made app),
//! Environ, App.PrevInstance and App.LogEvent. Main window only (capabilities/default.json).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::make_app::{bundle_from_exe, current_bundle};

/// The files the app was asked to open (Finder: Open With, a double-clicked document of a made app's file types).
#[derive(Default)]
pub struct OpenedFiles(pub Mutex<Vec<String>>);

impl OpenedFiles {
  /// The files of one open request (a launch by a document, or a later Open With) replace those of the one before.
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

#[tauri::command]
pub fn get_command_line(opened: State<'_, OpenedFiles>) -> String {
  let files = opened.0.lock().map(|v| v.clone()).unwrap_or_default();
  command_line(std::env::args(), &files)
}

/// Environ: the process environment as NAME / value pairs, in the process's order (Environ(n) is the n-th).
#[tauri::command]
pub fn get_environment() -> Vec<(String, String)> {
  std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect()
}

fn bundle_id(bundle: &Path) -> Option<String> {
  plist::Value::from_file(bundle.join("Contents/Info.plist"))
    .ok()?
    .into_dictionary()?
    .get("CFBundleIdentifier")?
    .as_string()
    .map(str::to_string)
}

/// True when one of `others` (the executables of the other processes) belongs to a bundle with the identifier `id`.
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

#[cfg(not(target_os = "macos"))]
fn other_executables() -> Vec<PathBuf> {
  vec![]
}

/// App.PrevInstance: another process of the same app (the same bundle identifier) is running. False outside a bundle.
#[tauri::command]
pub fn app_prev_instance() -> bool {
  let Some(id) = current_bundle().ok().and_then(|b| bundle_id(&b)) else { return false };
  other_instance_of(&id, other_executables())
}

/// The log file of App.LogEvent: `<data folder>/<bundle id>/<app name>.log` (~/Library/Application Support/...).
fn log_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  let base = app.path().data_dir().map_err(|e| format!("no data folder: {e}"))?;
  let bundle = current_bundle().ok();
  let id = bundle.as_deref().and_then(bundle_id).unwrap_or_else(|| "no.vibebasic.ide".into());
  let name = bundle.as_deref().map(crate::embedded::bundle_display_name).unwrap_or_else(|| "VibeBasic".into());
  Ok(base.join(id).join(format!("{name}.log")))
}

/// Appends `line` (one log entry, without the line end) to `file`, creating its folder.
pub fn append_line(file: &Path, line: &str) -> Result<(), String> {
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  }
  let mut f = std::fs::OpenOptions::new().create(true).append(true).open(file).map_err(|e| format!("{}: {e}", file.display()))?;
  writeln!(f, "{line}").map_err(|e| format!("{}: {e}", file.display()))
}

#[tauri::command]
pub fn app_log_event<R: Runtime>(app: AppHandle<R>, line: String) -> Result<(), String> {
  append_line(&log_file(&app)?, &line)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn command_line_from_args_or_opened_files() {
    let args = || ["/A.app/Contents/MacOS/A", "-psn_0_123", "x", "y z"].map(String::from);
    assert_eq!(command_line(args(), &[]), "x y z");
    assert_eq!(command_line(["/a"].map(String::from), &[]), "");
    assert_eq!(command_line(args(), &["/Users/me/a.kalk".into()]), "/Users/me/a.kalk");
  }

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
