//! Runtime mode for made apps: the embedded project. On Windows and Linux it is the payload at the end of the made app's
//! executable (payload.rs); on macOS `Contents/Resources/vibebasic-project.vbb` in the bundle.

#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::Emitter;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
use crate::make_app::current_bundle;

#[cfg(target_os = "macos")]
pub const EMBEDDED_FILE: &str = "vibebasic-project.vbb";
/// Event the runtime menu emits to the frontend when the user chooses Quit (Cmd+Q).
#[cfg(target_os = "macos")]
pub const QUIT_EVENT: &str = "vb:quit-requested";

/// The own executable when it carries a project (looked up once: the file doesn't change while it runs).
fn payload_exe() -> Option<&'static PathBuf> {
  static EXE: OnceLock<Option<PathBuf>> = OnceLock::new();
  EXE.get_or_init(|| std::env::current_exe().ok().filter(|p| crate::payload::has_payload(p))).as_ref()
}

enum Embedded {
  /// The payload of this executable.
  Payload(&'static PathBuf),
  /// macOS: the project file in the bundle's Resources.
  #[cfg(target_os = "macos")]
  File(PathBuf),
}

fn locate<R: Runtime>(_app: &AppHandle<R>) -> Option<Embedded> {
  if let Some(exe) = payload_exe() {
    return Some(Embedded::Payload(exe));
  }
  #[cfg(target_os = "macos")]
  {
    let p = _app.path().resource_dir().ok()?.join(EMBEDDED_FILE);
    if p.is_file() {
      return Some(Embedded::File(p));
    }
  }
  None
}

pub fn has_embedded<R: Runtime>(app: &AppHandle<R>) -> bool {
  locate(app).is_some()
}

/// The embedded project's text: None in the plain IDE.
pub fn embedded_project<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
  let (path, bytes) = match locate(app) {
    None => return Ok(None),
    Some(Embedded::Payload(p)) => (p.clone(), crate::payload::read_file(p).map(|b| b.unwrap_or_default())),
    #[cfg(target_os = "macos")]
    Some(Embedded::File(p)) => (p.clone(), std::fs::read(&p)),
  };
  let bytes = bytes.map_err(|e| format!("{}: {}", path.display(), e))?;
  String::from_utf8(bytes).map(Some).map_err(|e| format!("{}: {}", path.display(), e))
}

/// The embedded project's text, or None when this is the plain IDE.
#[tauri::command]
pub fn get_embedded_project<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
  embedded_project(&app)
}

/// Linux: the window icon of a made app, from the project's icon (a PNG). Read before the app is built, since Tauri takes
/// the default window icon from its context. Windows takes it from the exe's icon resource, which Make rewrote.
#[cfg(target_os = "linux")]
pub fn project_window_icon() -> Option<tauri::image::Image<'static>> {
  use base64::Engine;
  let bytes = crate::payload::read_file(payload_exe()?).ok()??;
  let project: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
  let key = project.get("iconAsset")?.as_str()?;
  let b64 = project.get("assets")?.get(key)?.get("dataBase64")?.as_str()?;
  let png = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
  let img = crate::icon::decode_png(&png).ok()?;
  Some(tauri::image::Image::new_owned(img.pixels, img.width, img.height))
}

#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
  app.exit(0);
}

/// Off macOS: the made app's executable (the one carrying the project), None in the IDE.
#[cfg(not(target_os = "macos"))]
fn made_app_exe() -> Option<&'static PathBuf> {
  payload_exe()
}

/// The made app's name: its executable's file name (without `.exe` on Windows). None in the IDE.
#[cfg(not(target_os = "macos"))]
pub fn app_name() -> Option<String> {
  exe_app_name(made_app_exe()?, cfg!(windows))
}

/// `Kalk.exe` -> `Kalk` on Windows (any case); a Linux executable's whole name (`Kalk 2.0`).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn exe_app_name(exe: &std::path::Path, windows: bool) -> Option<String> {
  let name = exe.file_name()?.to_string_lossy().into_owned();
  Some(if windows && name.to_ascii_lowercase().ends_with(".exe") { name[..name.len() - 4].to_string() } else { name })
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
  let dir = {
    let _ = &app;
    made_app_exe()?.parent()?.to_path_buf()
  };
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
  {
    let _ = app;
    app_name()
  }
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn exe_names() {
    assert_eq!(exe_app_name(std::path::Path::new("/a/Kalk.EXE"), true).as_deref(), Some("Kalk"));
    assert_eq!(exe_app_name(std::path::Path::new("/a/Kalk 2.0"), false).as_deref(), Some("Kalk 2.0"));
    assert_eq!(exe_app_name(std::path::Path::new("/a/Kalk.exe"), false).as_deref(), Some("Kalk.exe"));
  }

  #[cfg(target_os = "macos")]
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
