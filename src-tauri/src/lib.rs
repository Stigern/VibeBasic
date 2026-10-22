mod ai;
mod embedded;
mod files;
mod make_app;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(ai::AiStreams::default())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      ai::ai_list_models,
      ai::ai_chat,
      ai::ai_cancel,
      files::read_text_file,
      files::write_text_file,
      files::read_binary_file,
      make_app::make_app,
      make_app::can_make_app,
      embedded::get_embedded_project,
      embedded::quit_app,
      embedded::get_app_dir,
      embedded::get_app_name
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
