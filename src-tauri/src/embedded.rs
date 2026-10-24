//! Runtime mode for made apps: the project embedded in the app's resources (`Contents/Resources/vibebasic-project.vbb` on
//! macOS; Tauri's resource folder elsewhere).

#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "macos")]
use crate::make_app::current_bundle;

pub const EMBEDDED_FILE: &str = "vibebasic-project.vbb";
/// Event the runtime menu emits to the frontend when the user chooses Quit (Cmd+Q).
#[cfg(target_os = "macos")]
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

/// Off macOS: the made app's executable (on Linux the AppImage file itself when it runs as one), None in the IDE (no
/// embedded project).
#[cfg(not(target_os = "macos"))]
fn made_app_exe<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
  if !has_embedded(app) {
    return None;
  }
  #[cfg(target_os = "linux")]
  if let Some(p) = std::env::var_os("APPIMAGE").filter(|p| !p.is_empty()) {
    return Some(PathBuf::from(p));
  }
  std::env::current_exe().ok()
}

/// The made app's name: its executable's file name without the extension. None in the IDE.
#[cfg(not(target_os = "macos"))]
pub fn app_name<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
  made_app_exe(app)?.file_stem().map(|s| s.to_string_lossy().into_owned())
}

/// The folder that contains the .app (App.Path in a made app; off macOS the folder of its executable).
#[tauri::command]
pub fn get_app_dir<R: Runtime>(app: AppHandle<R>) -> Option<String> {
  #[cfg(target_os = "macos")]
  let dir = {
    let _ = &app;
    current_bundle().ok()?.parent()?.to_path_buf()
  };
  #[cfg(not(target_os = "macos"))]
  let dir = made_app_exe(&app)?.parent()?.to_path_buf();
  Some(dir.to_string_lossy().to_string())
}

/// The made app's name (CFBundleName; App.EXEName). None outside a bundle (off macOS: in the IDE).
#[tauri::command]
pub fn get_app_name<R: Runtime>(app: AppHandle<R>) -> Option<String> {
  #[cfg(target_os = "macos")]
  return {
    let _ = app;
    current_bundle().ok().map(|b| bundle_display_name(&b))
  };
  #[cfg(not(target_os = "macos"))]
  app_name(&app)
}

/// CFBundleName of the bundle at `bundle`, else its file name without `.app`.
#[cfg(target_os = "macos")]
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
#[cfg(target_os = "macos")]
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

/// Installs the runtime menu when the embedded project exists. Returns whether it did. macOS only: there the menu is the
/// app's menu bar; on Windows and Linux an app menu would be a menu bar in every window, above the program's own menus.
pub fn setup_runtime<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
  if !has_embedded(app) {
    return Ok(false);
  }
  #[cfg(not(target_os = "macos"))]
  return Ok(true);
  #[cfg(target_os = "macos")]
  install_runtime_menu(app)
}

#[cfg(target_os = "macos")]
fn install_runtime_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
  let name = current_bundle().map(|b| bundle_display_name(&b)).unwrap_or_else(|_| "VibeBasic".into());
  app.set_menu(runtime_menu(app, &name)?)?;
  app.on_menu_event(|app, event| {
    if event.id().as_ref() == "vb-quit" {
      let _ = app.emit(QUIT_EVENT, ());
    }
  });
  Ok(true)
}

#[cfg(all(test, target_os = "macos"))]
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
