// Clipboard (VB's Clipboard.GetText / SetText / Clear): the macOS pasteboard as plain text through pbpaste / pbcopy.
// The webview's navigator.clipboard needs a user gesture, which code run from a Timer or Form_Load does not have.

use std::io::Write;
use std::process::{Command, Stdio};

/// UTF-8 for the tools (an app started from Finder has no LANG, and they would fall back to Mac Roman).
fn tool(name: &str) -> Command {
  let mut c = Command::new(name);
  c.env("LANG", "en_US.UTF-8").env("LC_ALL", "en_US.UTF-8");
  c
}

#[tauri::command]
pub fn clipboard_get_text() -> Result<String, String> {
  let out = tool("pbpaste").output().map_err(|e| format!("pbpaste: {}", e))?;
  if !out.status.success() {
    return Err(format!("pbpaste: {}", out.status));
  }
  Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn clipboard_set_text(text: String) -> Result<(), String> {
  let mut child = tool("pbcopy").stdin(Stdio::piped()).spawn().map_err(|e| format!("pbcopy: {}", e))?;
  child.stdin.take().ok_or("pbcopy: no stdin")?.write_all(text.as_bytes()).map_err(|e| format!("pbcopy: {}", e))?;
  let status = child.wait().map_err(|e| format!("pbcopy: {}", e))?;
  if status.success() { Ok(()) } else { Err(format!("pbcopy: {}", status)) }
}
