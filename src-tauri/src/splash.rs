//! The splash window (splash.html): opened at start while the IDE loads, before the main window's page has run. The main
//! window closes it once the IDE is ready (TauriBackend.showMainWindow). A made app has none: it starts the program.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "splash";

/// Closed at the latest after this long, should the IDE never get to close it.
const SAFETY_CLOSE: std::time::Duration = std::time::Duration::from_secs(20);

pub fn open<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
  WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("splash.html".into()))
    .title("VibeBasic")
    .inner_size(480.0, 360.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .always_on_top(true)
    .center()
    // hidden until its page is drawn: no empty (dark) window first
    .visible(false)
    .background_color(tauri::webview::Color(255, 255, 255, 255))
    .on_page_load(|w, p| {
      if p.event() == tauri::webview::PageLoadEvent::Finished {
        let _ = w.show();
      }
    })
    .build()?;
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(SAFETY_CLOSE);
    if let Some(w) = app.get_webview_window(LABEL) {
      let _ = w.close();
    }
  });
  Ok(())
}
