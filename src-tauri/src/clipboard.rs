// Clipboard (VB's Clipboard.GetText / SetText / Clear) as plain text: on macOS the pasteboard through pbpaste / pbcopy,
// on Windows and Linux the arboard crate (the Win32 clipboard; X11, which Wayland desktops bridge through XWayland).
// The webview's navigator.clipboard needs a user gesture, which code run from a Timer or Form_Load does not have.

#[cfg(target_os = "macos")]
use std::io::Write;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

#[cfg(target_os = "macos")]
/// UTF-8 for the tools (an app started from Finder has no LANG, and they would fall back to Mac Roman).
fn tool(name: &str) -> Command {
  let mut c = Command::new(name);
  c.env("LANG", "en_US.UTF-8").env("LC_ALL", "en_US.UTF-8");
  c
}

/// The clipboard is read and written on the blocking pool, not on the main thread.
#[tauri::command]
pub async fn clipboard_get_text() -> Result<String, String> {
  crate::io_util::off_main(get_text).await
}

#[tauri::command]
pub async fn clipboard_set_text(text: String) -> Result<(), String> {
  crate::io_util::off_main(move || set_text(&text)).await
}

#[cfg(target_os = "macos")]
fn get_text() -> Result<String, String> {
  let out = tool("pbpaste").output().map_err(|e| format!("pbpaste: {}", e))?;
  if !out.status.success() {
    return Err(format!("pbpaste: {}", out.status));
  }
  Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn set_text(text: &str) -> Result<(), String> {
  let mut child = tool("pbcopy").stdin(Stdio::piped()).spawn().map_err(|e| format!("pbcopy: {}", e))?;
  child.stdin.take().ok_or("pbcopy: no stdin")?.write_all(text.as_bytes()).map_err(|e| format!("pbcopy: {}", e))?;
  let status = child.wait().map_err(|e| format!("pbcopy: {}", e))?;
  if status.success() { Ok(()) } else { Err(format!("pbcopy: {}", status)) }
}

/// One clipboard for the life of the app: on X11 the text set here is served by arboard's thread only while a Clipboard
/// object lives (dropping the last one hands it to a clipboard manager, when there is one).
#[cfg(not(target_os = "macos"))]
fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>) -> Result<T, String> {
  static CLIP: std::sync::Mutex<Option<arboard::Clipboard>> = std::sync::Mutex::new(None);
  let mut g = CLIP.lock().unwrap_or_else(|e| e.into_inner());
  if g.is_none() {
    *g = Some(arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?);
  }
  f(g.as_mut().expect("set above")).map_err(|e| format!("clipboard: {e}"))
}

/// An empty clipboard, or one that holds no text, reads as "" (as VB6's GetText).
#[cfg(not(target_os = "macos"))]
fn get_text() -> Result<String, String> {
  with_clipboard(|c| match c.get_text() {
    Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
    r => r,
  })
}

#[cfg(not(target_os = "macos"))]
fn set_text(text: &str) -> Result<(), String> {
  with_clipboard(|c| if text.is_empty() { c.clear() } else { c.set_text(text) })
}
