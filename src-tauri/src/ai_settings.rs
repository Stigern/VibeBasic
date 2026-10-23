//! The AI settings (base URL, model, API key ...) of Tools > Options > AI, kept on the Rust side instead of in the webview's
//! localStorage. Every window of the app shares one localStorage (form windows load form.html from the same origin), so a key
//! kept there could be read by any script that got into a form window. Here it is a file only the user can read
//! (`ai-settings.json`, mode 0600, in the app's config folder), and the commands that read and write it are granted to the
//! main window only (capabilities/default.json; the form and dialog windows get media_read and nothing else).
//! The frontend moves settings saved by older versions out of localStorage once (src/backend/aiSettingsStore.ts).

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::io_util::off_main;

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| format!("no config folder: {e}"))?.join("ai-settings.json"))
}

/// None when nothing was saved (or the file is not valid JSON).
pub fn load(file: &Path) -> Result<Option<Value>, String> {
  match std::fs::read_to_string(file) {
    Ok(t) => Ok(serde_json::from_str(&t).ok()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("{}: {}", file.display(), e)),
  }
}

/// Written to a temp file with mode 0600 and renamed into place.
pub fn save(file: &Path, v: &Value) -> Result<(), String> {
  let fail = |e: std::io::Error| format!("{}: {}", file.display(), e);
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(fail)?;
  }
  let tmp = file.with_extension(format!("json.{}.tmp", std::process::id()));
  let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
  let r = std::fs::OpenOptions::new()
    .write(true)
    .create(true)
    .truncate(true)
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
}
