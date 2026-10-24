include!("src/app_commands.rs");

fn main() {
  // An app manifest: every app command needs a permission (allow-<command>), so a window gets only what its capability grants.
  // Without it Tauri lets every window call every app command.
  println!("cargo:rerun-if-changed=src/app_commands.rs");
  let mut attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));

  // Windows (MSVC): the dialog plugin links TaskDialogIndirect from Common Controls v6, which only a program whose Windows
  // manifest asks for v6 can load. Tauri puts that manifest in the resource file, and the resource file goes into the bins
  // only, so `cargo test` binaries fail to start (STATUS_ENTRYPOINT_NOT_FOUND). The same manifest goes in through the linker
  // here, for every target. The app's manifest is unchanged; macOS and Linux are not touched.
  let target = |k: &str| std::env::var(k).unwrap_or_default();
  if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
    attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    let manifest = std::path::Path::new(&target("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
  }

  tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
