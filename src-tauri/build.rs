include!("src/app_commands.rs");

fn main() {
  // An app manifest: every app command needs a permission (allow-<command>), so a window gets only what its capability grants.
  // Without it Tauri lets every window call every app command.
  println!("cargo:rerun-if-changed=src/app_commands.rs");
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)))
    .expect("failed to run tauri-build");
}
