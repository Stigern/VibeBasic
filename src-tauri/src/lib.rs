mod ai;
mod ai_settings;
mod clipboard;
mod comm;
mod db;
mod embedded;
mod files;
mod fileio;
mod inet;
mod io_util;
mod make_app;
mod media;
mod printing;
mod sysinfo;
mod winsock;
mod app_commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(ai::AiStreams::default())
    .manage(inet::InetTasks::default())
    .manage(winsock::Sockets::default())
    .manage(media::MediaFiles::default())
    .manage(fileio::OpenFiles::default())
    .manage(db::Databases::default())
    .manage(comm::Ports::default())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      ai::ai_list_models,
      ai::ai_chat,
      ai::ai_cancel,
      ai_settings::ai_settings_get,
      ai_settings::ai_settings_set,
      files::read_text_file,
      files::write_text_file,
      files::read_binary_file,
      files::list_volumes,
      files::list_dir,
      fileio::fio_open,
      fileio::fio_read,
      fileio::fio_write,
      fileio::fio_close,
      fileio::fio_reset,
      fileio::fs_kill,
      fileio::fs_rename,
      fileio::fs_mkdir,
      fileio::fs_rmdir,
      fileio::fs_copy,
      fileio::fs_set_attr,
      fileio::fs_stat,
      fileio::setting_get,
      fileio::setting_save,
      fileio::setting_delete,
      fileio::setting_all,
      db::db_open,
      db::db_query,
      db::db_execute,
      db::db_close,
      db::db_reset,
      clipboard::clipboard_get_text,
      clipboard::clipboard_set_text,
      inet::inet_request,
      inet::inet_cancel,
      winsock::sock_connect,
      winsock::sock_listen,
      winsock::sock_accept,
      winsock::sock_bind,
      winsock::sock_send,
      winsock::sock_close,
      winsock::net_reset,
      winsock::net_local_ip,
      comm::comm_list,
      comm::comm_open,
      comm::comm_configure,
      comm::comm_write,
      comm::comm_set_lines,
      comm::comm_close,
      comm::comm_reset,
      sysinfo::sys_info,
      media::media_open,
      media::media_read,
      media::media_close,
      make_app::make_app,
      make_app::can_make_app,
      embedded::get_embedded_project,
      embedded::quit_app,
      embedded::get_app_dir,
      embedded::get_app_name,
      printing::printer_list,
      printing::print_window
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      embedded::setup_runtime(app.handle())?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

#[cfg(test)]
mod acl_tests {
  //! The capability split: the main window gets every app command, the form and dialog windows only media_read.
  use crate::app_commands::{APP_COMMANDS, RUN_WINDOW_COMMANDS};
  use serde_json::Value;
  use std::collections::BTreeSet;

  fn capability(file: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities").join(file);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
  }
  fn strings(v: &Value) -> BTreeSet<String> {
    v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
  }
  /// The app's own permissions (no "plugin:" prefix) a capability grants.
  fn app_permissions(c: &Value) -> BTreeSet<String> {
    strings(&c["permissions"]).into_iter().filter(|p| !p.contains(':')).collect()
  }
  fn allow(cmds: &[&str]) -> BTreeSet<String> {
    cmds.iter().map(|c| format!("allow-{}", c.replace('_', "-"))).collect()
  }

  #[test]
  fn the_manifest_lists_exactly_the_registered_commands() {
    let src = include_str!("lib.rs");
    let list = src.split("generate_handler![").nth(1).unwrap().split(']').next().unwrap();
    let registered: BTreeSet<&str> = list.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| s.rsplit("::").next().unwrap()).collect();
    assert_eq!(registered, APP_COMMANDS.iter().copied().collect::<BTreeSet<_>>());
  }

  #[test]
  fn only_the_main_window_gets_the_app_commands() {
    let main = capability("default.json");
    assert_eq!(strings(&main["windows"]), BTreeSet::from(["main".to_string()]));
    assert_eq!(app_permissions(&main), allow(APP_COMMANDS));

    let run = capability("run-windows.json");
    assert_eq!(strings(&run["windows"]), BTreeSet::from(["vbform-*".to_string(), "vbdialog-*".to_string()]));
    assert_eq!(app_permissions(&run), allow(RUN_WINDOW_COMMANDS));
    for p in strings(&run["permissions"]) {
      assert!(p.starts_with("core:event:") || p.starts_with("core:window:") || allow(RUN_WINDOW_COMMANDS).contains(&p), "form windows must not get {p}");
    }

    // no other capability file grants anything
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let files: BTreeSet<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert_eq!(files, BTreeSet::from(["default.json".to_string(), "run-windows.json".to_string()]));
  }

  /// Review 08 final #6: events with data (AI replies, Winsock and serial data) go to the main window only, never to every
  /// window: run-windows.json grants core:event:default, so a form window could listen to a broadcast. The IDE's main window
  /// and a made app's are both labelled "main" (tauri.conf.json).
  #[test]
  fn events_go_to_the_main_window_only() {
    let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(conf["app"]["windows"][0]["label"], "main");
    let broadcast = concat!(".", "emit(");
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut targeted = 0;
    for e in std::fs::read_dir(dir).unwrap() {
      let path = e.unwrap().path();
      let text = std::fs::read_to_string(&path).unwrap();
      for line in text.lines().filter(|l| l.contains(broadcast)) {
        // the runtime menu's Quit carries no data
        assert!(line.contains("emit(QUIT_EVENT, ())"), "{}: broadcast event: {}", path.display(), line.trim());
      }
      for line in text.lines().filter(|l| l.contains(concat!(".", "emit_to("))) {
        assert!(line.contains(r#"emit_to("main", "#), "{}: {}", path.display(), line.trim());
        targeted += 1;
      }
    }
    assert_eq!(targeted, 4);   // ai:delta, ai:usage, vb:socket, vb:comm
  }
}
