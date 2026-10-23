//! The AI settings (base URL, model, API key ...) of Tools > Options > AI, kept on the Rust side instead of in the webview's
//! localStorage. Every window of the app shares one localStorage (form windows load form.html from the same origin), so a key
//! kept there could be read by any script that got into a form window. Here it is a file only the user can read
//! (`ai-settings.json`, mode 0600, in the app's config folder), and the commands that read and write it are granted to the
//! main window only (capabilities/default.json; the form and dialog windows get media_read and nothing else).
//! The frontend moves settings saved by older versions out of localStorage once (src/backend/aiSettingsStore.ts).

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::io_util::off_main;

/// Loads and saves run one at a time: `ai_settings_set` runs on the blocking pool, and the server detection saves in the
/// background while Tools > Options may save too.
static STORE: Mutex<()> = Mutex::new(());
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| format!("no config folder: {e}"))?.join("ai-settings.json"))
}

/// None when nothing was saved. A file that is not valid JSON is moved aside (".corrupt-<ms>"), so the settings it held can
/// still be recovered by hand, and reads as None.
pub fn load(file: &Path) -> Result<Option<Value>, String> {
  let _g = STORE.lock().unwrap_or_else(|e| e.into_inner());
  let text = match std::fs::read_to_string(file) {
    Ok(t) => t,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("{}: {}", file.display(), e)),
  };
  if let Ok(v) = serde_json::from_str(&text) {
    return Ok(Some(v));
  }
  let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  let aside = file.with_extension(format!("json.corrupt-{ms}"));
  std::fs::rename(file, &aside).map_err(|e| format!("{}: {}", file.display(), e))?;
  eprintln!("VibeBasic: {} was not valid JSON; moved to {}", file.display(), aside.display());
  Ok(None)
}

/// Written to a temp file of its own (pid and a counter) with mode 0600 and renamed into place: a reader sees the old file
/// or the new one, never a mix.
pub fn save(file: &Path, v: &Value) -> Result<(), String> {
  let _g = STORE.lock().unwrap_or_else(|e| e.into_inner());
  let fail = |e: std::io::Error| format!("{}: {}", file.display(), e);
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(fail)?;
  }
  let tmp = file.with_extension(format!("json.{}.{}.tmp", std::process::id(), TMP_SEQ.fetch_add(1, Ordering::Relaxed)));
  let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
  let r = std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(0o600)
    .open(&tmp)
    .and_then(|mut f| f.write_all(text.as_bytes()).and_then(|_| f.sync_all()))
    .and_then(|_| std::fs::rename(&tmp, file));
  if r.is_err() {
    let _ = std::fs::remove_file(&tmp);
  }
  r.map_err(fail)
}

#[tauri::command]
pub async fn ai_settings_get(app: AppHandle) -> Result<Option<Value>, String> {
  let file = settings_file(&app)?;
  off_main(move || load(&file)).await
}

#[tauri::command]
pub async fn ai_settings_set(app: AppHandle, settings: Value) -> Result<(), String> {
  let file = settings_file(&app)?;
  off_main(move || save(&file, &settings)).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use std::os::unix::fs::PermissionsExt;

  #[test]
  fn saved_settings_come_back_and_only_the_user_can_read_them() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("cfg").join("ai-settings.json");
    assert_eq!(load(&file).unwrap(), None);
    let v = json!({ "baseUrl": "http://localhost:11434/v1", "model": "m", "apiKey": "secret", "thinking": "low" });
    save(&file, &v).unwrap();
    assert_eq!(load(&file).unwrap(), Some(v));
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    save(&file, &json!({ "apiKey": "" })).unwrap();
    assert_eq!(load(&file).unwrap(), Some(json!({ "apiKey": "" })));
    assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
  }

  /// Review 08 final #3: saves at the same time never fail and never leave a mix of two files.
  #[test]
  fn saves_at_the_same_time_leave_one_whole_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("ai-settings.json");
    let long = json!({ "baseUrl": "http://localhost:11434/v1", "model": "a-long-model-name".repeat(20), "apiKey": "secret" });
    let short = json!({ "apiKey": "k" });
    for _ in 0..50 {
      let ts: Vec<_> = [long.clone(), short.clone()]
        .into_iter()
        .map(|v| {
          let f = file.clone();
          std::thread::spawn(move || (0..4).map(|_| save(&f, &v)).collect::<Result<Vec<_>, _>>())
        })
        .collect();
      for t in ts {
        t.join().unwrap().unwrap();
      }
      let got = load(&file).unwrap().unwrap();
      assert!(got == long || got == short, "{got}");
      assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
  }

  #[test]
  fn a_corrupt_settings_file_is_moved_aside() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("ai-settings.json");
    std::fs::write(&file, "{\"apiKey\": \"sec").unwrap();
    assert_eq!(load(&file).unwrap(), None);
    assert!(!file.exists());
    let aside: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".corrupt-")).collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), "{\"apiKey\": \"sec");
  }
}
