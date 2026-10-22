//! Runtime mode for made apps: the project embedded in `Contents/Resources/vibebasic-project.vbb`.

use std::path::{Path, PathBuf};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::make_app::current_bundle;

pub const EMBEDDED_FILE: &str = "vibebasic-project.vbb";
/// Event the runtime menu emits to the frontend when the user chooses Quit (Cmd+Q).
pub const QUIT_EVENT: &str = "vb:quit-requested";

fn embedded_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
  let p = app.path().resource_dir().ok()?.join(EMBEDDED_FILE);
  p.is_file().then_some(p)
}

pub fn has_embedded<R: Runtime>(app: &AppHandle<R>) -> bool {
  embedded_path(app).is_some()
}

/// The embedded project's text, or None when this is the plain IDE.
#[tauri::command]
pub fn get_embedded_project<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
  match embedded_path(&app) {
    None => Ok(None),
    Some(p) => std::fs::read_to_string(&p).map(Some).map_err(|e| format!("{}: {}", p.display(), e)),
  }
}

#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
  app.exit(0);
}

/// The folder that contains the .app (App.Path in a made app).
#[tauri::command]
pub fn get_app_dir() -> Option<String> {
  let bundle = current_bundle().ok()?;
  Some(bundle.parent()?.to_string_lossy().to_string())
}

/// CFBundleName of the bundle at `bundle`, else its file name without `.app`.
pub fn bundle_display_name(bundle: &Path) -> String {
  let from_plist = plist::Value::from_file(bundle.join("Contents/Info.plist"))
    .ok()
    .and_then(|v| v.into_dictionary())
    .and_then(|d| d.get("CFBundleName").and_then(|n| n.as_string().map(str::to_string)));
  from_plist.unwrap_or_else(|| {
    bundle.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "VibeBasic".into())
  })
}

/// One app menu: "About <name>" and "Quit <name>" (Cmd+Q, handled by the frontend so the program can end cleanly).
pub fn runtime_menu<R: Runtime>(app: &AppHandle<R>, app_name: &str) -> tauri::Result<Menu<R>> {
  let about = PredefinedMenuItem::about(app, Some(&format!("About {app_name}")), None)?;
  let quit = MenuItem::with_id(app, "vb-quit", format!("Quit {app_name}"), true, Some("CmdOrCtrl+Q"))?;
  let sep = PredefinedMenuItem::separator(app)?;
  let sub = Submenu::with_items(app, app_name, true, &[&about, &sep, &quit])?;
  // Standard Edit menu so Cmd+Z/X/C/V/A work in TextBoxes.
  let edit = Submenu::with_items(
    app,
    "Edit",
    true,
    &[
      &PredefinedMenuItem::undo(app, None)?,
      &PredefinedMenuItem::redo(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::copy(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
    ],
  )?;
  Menu::with_items(app, &[&sub, &edit])
}

/// Installs the runtime menu when the embedded project exists. Returns whether it did.
pub fn setup_runtime<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
  if !has_embedded(app) {
    return Ok(false);
  }
  let name = current_bundle().map(|b| bundle_display_name(&b)).unwrap_or_else(|_| "VibeBasic".into());
  app.set_menu(runtime_menu(app, &name)?)?;
  app.on_menu_event(|app, event| {
    if event.id().as_ref() == "vb-quit" {
      let _ = app.emit(QUIT_EVENT, ());
    }
  });
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn display_name_from_plist_else_folder() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("Mitt Program.app");
    assert_eq!(bundle_display_name(&bundle), "Mitt Program");
    std::fs::create_dir_all(bundle.join("Contents")).unwrap();
    let mut d = plist::Dictionary::new();
    d.insert("CFBundleName".into(), "Kalkulator".into());
    plist::Value::Dictionary(d).to_file_xml(bundle.join("Contents/Info.plist")).unwrap();
    assert_eq!(bundle_display_name(&bundle), "Kalkulator");
  }
}
