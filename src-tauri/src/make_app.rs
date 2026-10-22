//! Make app: builds a standalone .app by copying VibeBasic.app itself.

#[allow(dead_code)] // used by the Make app dialog (later task)
/// Removes `/` and `:` and trims whitespace. Empty names become `Project1`.
pub fn sanitize_app_file_name(name: &str) -> String {
  let cleaned: String = name.chars().filter(|c| *c != '/' && *c != ':').collect();
  let trimmed = cleaned.trim();
  if trimmed.is_empty() {
    "Project1".to_string()
  } else {
    trimmed.to_string()
  }
}

fn transliterate(c: char) -> &'static str {
  match c {
    'æ' => "ae",
    'ø' => "o",
    'å' | 'à' | 'á' | 'â' | 'ã' | 'ä' => "a",
    'Æ' => "Ae",
    'Ø' => "O",
    'Å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' => "A",
    'è' | 'é' | 'ê' | 'ë' => "e",
    'È' | 'É' | 'Ê' | 'Ë' => "E",
    'ì' | 'í' | 'î' | 'ï' => "i",
    'Ì' | 'Í' | 'Î' | 'Ï' => "I",
    'ò' | 'ó' | 'ô' | 'õ' | 'ö' => "o",
    'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => "O",
    'ù' | 'ú' | 'û' | 'ü' => "u",
    'Ù' | 'Ú' | 'Û' | 'Ü' => "U",
    'ç' => "c",
    'Ç' => "C",
    'ñ' => "n",
    'Ñ' => "N",
    'ý' | 'ÿ' => "y",
    'Ý' => "Y",
    'ß' => "ss",
    _ => "",
  }
}

/// ASCII-only `[A-Za-z0-9]` slug; Norwegian letters transliterated; at least `App`.
pub fn ascii_slug(name: &str) -> String {
  let mut out = String::new();
  for c in name.chars() {
    if c.is_ascii_alphanumeric() {
      out.push(c);
    } else {
      out.push_str(transliterate(c));
    }
  }
  if out.is_empty() { "App".to_string() } else { out }
}

pub fn bundle_id_for(name: &str) -> String {
  format!("no.vibebasic.app.{}", ascii_slug(name).to_lowercase())
}


use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub trait Signer {
  fn sign(&self, bundle: &Path) -> Result<(), String>;
}

pub trait IconConverter {
  fn png_to_icns(&self, png: &[u8], out: &Path) -> Result<(), String>;
}

pub struct BuildSpec {
  pub app_name: String,
  pub project_json: String,
  pub icon_png: Option<Vec<u8>>,
}

#[derive(Debug, PartialEq)]
pub enum MakeError {
  NotBundled,
  Exists,
  Io(String),
  Tool(String),
}

impl MakeError {
  /// Text shown by the frontend.
  pub fn message(&self) -> String {
    match self {
      MakeError::NotBundled => "Make only works when VibeBasic runs as a built app. Build it with: npm run tauri build".to_string(),
      MakeError::Exists => "exists".to_string(),
      MakeError::Io(d) | MakeError::Tool(d) => format!("Could not make the app: {d}"),
    }
  }
}

fn io<E: std::fmt::Display>(e: E) -> MakeError {
  MakeError::Io(e.to_string())
}

const LICENSES_TXT: &str = "Pixel font 'MS Sans Serif' by lou (FontStruct), licensed CC BY-SA 3.0 \u{2014} https://creativecommons.org/licenses/by-sa/3.0/\nMade with VibeBasic\n";

pub struct CodesignSigner;

impl Signer for CodesignSigner {
  fn sign(&self, bundle: &Path) -> Result<(), String> {
    run_tool(Command::new("codesign").args(["--force", "--deep", "--sign", "-"]).arg(bundle))
  }
}

pub struct SipsIconConverter;

impl IconConverter for SipsIconConverter {
  fn png_to_icns(&self, png: &[u8], out: &Path) -> Result<(), String> {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0);
    let work = std::env::temp_dir().join(format!("vibebasic-icon-{}-{nanos}", std::process::id()));
    let iconset = work.join("icon.iconset");
    let result = (|| -> Result<(), String> {
      fs::create_dir_all(&iconset).map_err(|e| e.to_string())?;
      let src = work.join("source.png");
      fs::write(&src, png).map_err(|e| e.to_string())?;
      let sizes: [(u32, &str); 10] = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
      ];
      for (px, name) in sizes {
        run_tool(
          Command::new("sips")
            .args(["-z", &px.to_string(), &px.to_string()])
            .arg(&src)
            .arg("--out")
            .arg(iconset.join(name)),
        )?;
      }
      run_tool(Command::new("iconutil").args(["-c", "icns"]).arg(&iconset).arg("-o").arg(out))
    })();
    let _ = fs::remove_dir_all(&work);
    result
  }
}

fn run_tool(cmd: &mut Command) -> Result<(), String> {
  let name = cmd.get_program().to_string_lossy().into_owned();
  let output = cmd.output().map_err(|e| format!("{name}: {e}"))?;
  if output.status.success() {
    Ok(())
  } else {
    Err(format!("{name}: {}", String::from_utf8_lossy(&output.stderr).trim()))
  }
}

/// `exe` is `X.app/Contents/MacOS/<binary>`; returns `X.app`.
pub fn bundle_from_exe(exe: &Path) -> Result<PathBuf, MakeError> {
  let bundle = exe
    .parent()
    .and_then(|p| p.parent())
    .and_then(|p| p.parent())
    .ok_or(MakeError::NotBundled)?;
  if bundle.extension().is_some_and(|e| e == "app") {
    Ok(bundle.to_path_buf())
  } else {
    Err(MakeError::NotBundled)
  }
}

pub fn current_bundle() -> Result<PathBuf, MakeError> {
  let exe = std::env::current_exe().map_err(io)?;
  bundle_from_exe(&exe)
}

pub fn build_app_from(
  source_bundle: &Path,
  target: &Path,
  spec: &BuildSpec,
  overwrite: bool,
  signer: &dyn Signer,
  icons: &dyn IconConverter,
) -> Result<(), MakeError> {
  if fs::symlink_metadata(target).is_ok() {
    if !overwrite {
      return Err(MakeError::Exists);
    }
    if target.is_dir() {
      fs::remove_dir_all(target).map_err(io)?;
    } else {
      fs::remove_file(target).map_err(io)?;
    }
  }
  let result = build_inner(source_bundle, target, spec, signer, icons);
  if result.is_err() {
    let _ = fs::remove_dir_all(target);
  }
  result
}

fn build_inner(
  source: &Path,
  target: &Path,
  spec: &BuildSpec,
  signer: &dyn Signer,
  icons: &dyn IconConverter,
) -> Result<(), MakeError> {
  let status = Command::new("ditto").arg(source).arg(target).output().map_err(io)?;
  if !status.status.success() {
    return Err(MakeError::Tool(format!("ditto: {}", String::from_utf8_lossy(&status.stderr).trim())));
  }
  let contents = target.join("Contents");
  let resources = contents.join("Resources");
  fs::create_dir_all(&resources).map_err(io)?;
  fs::write(resources.join("vibebasic-project.vbb"), &spec.project_json).map_err(io)?;
  fs::write(resources.join("LICENSES.txt"), LICENSES_TXT).map_err(io)?;

  let plist_path = contents.join("Info.plist");
  let mut dict = plist::Value::from_file(&plist_path)
    .map_err(io)?
    .into_dictionary()
    .ok_or_else(|| MakeError::Io("Info.plist is not a dictionary".to_string()))?;
  let old_exe = dict
    .get("CFBundleExecutable")
    .and_then(|v| v.as_string())
    .ok_or_else(|| MakeError::Io("Info.plist has no CFBundleExecutable".to_string()))?
    .to_string();
  let slug = ascii_slug(&spec.app_name);
  if old_exe != slug {
    fs::rename(contents.join("MacOS").join(&old_exe), contents.join("MacOS").join(&slug)).map_err(io)?;
  }
  dict.insert("CFBundleExecutable".into(), slug.into());
  dict.insert("CFBundleName".into(), spec.app_name.clone().into());
  dict.insert("CFBundleDisplayName".into(), spec.app_name.clone().into());
  dict.insert("CFBundleIdentifier".into(), bundle_id_for(&spec.app_name).into());
  if let Some(png) = &spec.icon_png {
    icons.png_to_icns(png, &resources.join("icon.icns")).map_err(MakeError::Tool)?;
    dict.insert("CFBundleIconFile".into(), "icon.icns".into());
  }
  plist::Value::Dictionary(dict).to_file_xml(&plist_path).map_err(io)?;
  signer.sign(target).map_err(MakeError::Tool)
}

#[tauri::command]
pub async fn make_app(
  target_path: String,
  app_name: String,
  project_json: String,
  icon_png_base64: Option<String>,
  overwrite: bool,
) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    use base64::Engine;
    let icon_png = match icon_png_base64 {
      Some(b64) => Some(
        base64::engine::general_purpose::STANDARD
          .decode(b64)
          .map_err(|e| MakeError::Io(format!("bad icon data: {e}")))?,
      ),
      None => None,
    };
    let source = current_bundle()?;
    let mut target = PathBuf::from(target_path);
    if target.extension().is_none_or(|e| e != "app") {
      let mut s = target.into_os_string();
      s.push(".app");
      target = PathBuf::from(s);
    }
    let spec = BuildSpec { app_name, project_json, icon_png };
    build_app_from(&source, &target, &spec, overwrite, &CodesignSigner, &SipsIconConverter)
  })
  .await
  .map_err(|e| format!("Could not make the app: {e}"))?
  .map_err(|e| e.message())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;

  #[test]
  fn file_name_keeps_spaces_and_norwegian() {
    assert_eq!(sanitize_app_file_name(" Mitt Program/æøå: "), "Mitt Programæøå");
  }
  #[test]
  fn empty_name() {
    assert_eq!(sanitize_app_file_name("  "), "Project1");
  }
  #[test]
  fn slug() {
    assert_eq!(ascii_slug("Kalkulator på Øya!"), "KalkulatorpaOya");
    assert_eq!(ascii_slug("!!!"), "App");
  }
  #[test]
  fn bundle_id() {
    assert_eq!(bundle_id_for("Mitt Program"), "no.vibebasic.app.mittprogram");
  }

  struct FakeSigner(RefCell<Vec<PathBuf>>);
  impl Signer for FakeSigner {
    fn sign(&self, b: &Path) -> Result<(), String> {
      self.0.borrow_mut().push(b.to_path_buf());
      Ok(())
    }
  }
  struct FakeIcons(RefCell<u32>);
  impl IconConverter for FakeIcons {
    fn png_to_icns(&self, _png: &[u8], out: &Path) -> Result<(), String> {
      *self.0.borrow_mut() += 1;
      fs::write(out, b"icns").map_err(|e| e.to_string())
    }
  }

  fn fake_source(dir: &Path) -> PathBuf {
    let src = dir.join("VibeBasic.app");
    fs::create_dir_all(src.join("Contents/MacOS")).unwrap();
    fs::create_dir_all(src.join("Contents/Resources")).unwrap();
    fs::write(src.join("Contents/MacOS/VibeBasic"), b"bin").unwrap();
    fs::write(src.join("Contents/Resources/x"), b"x").unwrap();
    let mut d = plist::Dictionary::new();
    d.insert("CFBundleExecutable".into(), "VibeBasic".into());
    d.insert("CFBundleIdentifier".into(), "no.vibebasic.ide".into());
    plist::Value::Dictionary(d).to_file_xml(src.join("Contents/Info.plist")).unwrap();
    src
  }

  fn spec(icon: bool) -> BuildSpec {
    BuildSpec {
      app_name: "Mitt Program".into(),
      project_json: "{\"a\":1}".into(),
      icon_png: if icon { Some(vec![1, 2, 3]) } else { None },
    }
  }

  fn plist_of(target: &Path) -> plist::Dictionary {
    plist::Value::from_file(target.join("Contents/Info.plist")).unwrap().into_dictionary().unwrap()
  }

  #[test]
  fn builds_bundle() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let target = tmp.path().join("Mitt Program.app");
    let signer = FakeSigner(RefCell::new(vec![]));
    build_app_from(&src, &target, &spec(false), false, &signer, &FakeIcons(RefCell::new(0))).unwrap();
    assert_eq!(fs::read_to_string(target.join("Contents/Resources/vibebasic-project.vbb")).unwrap(), "{\"a\":1}");
    assert!(target.join("Contents/MacOS/MittProgram").exists());
    assert!(!target.join("Contents/MacOS/VibeBasic").exists());
    assert!(target.join("Contents/Resources/x").exists());
    let p = plist_of(&target);
    assert_eq!(p["CFBundleExecutable"].as_string(), Some("MittProgram"));
    assert_eq!(p["CFBundleName"].as_string(), Some("Mitt Program"));
    assert_eq!(p["CFBundleDisplayName"].as_string(), Some("Mitt Program"));
    assert_eq!(p["CFBundleIdentifier"].as_string(), Some("no.vibebasic.app.mittprogram"));
    assert!(p.get("CFBundleIconFile").is_none());
    assert_eq!(*signer.0.borrow(), vec![target.clone()]);
    let lic = fs::read_to_string(target.join("Contents/Resources/LICENSES.txt")).unwrap();
    assert!(lic.contains("Pixel font 'MS Sans Serif' by lou (FontStruct), licensed CC BY-SA 3.0"));
    assert!(lic.contains("https://creativecommons.org/licenses/by-sa/3.0/"));
    assert!(lic.contains("Made with VibeBasic"));
  }

  #[test]
  fn refuses_existing_without_overwrite() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let target = tmp.path().join("T.app");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("old"), b"old").unwrap();
    let signer = FakeSigner(RefCell::new(vec![]));
    let r = build_app_from(&src, &target, &spec(false), false, &signer, &FakeIcons(RefCell::new(0)));
    assert_eq!(r, Err(MakeError::Exists));
    assert!(target.join("old").exists());
    assert!(signer.0.borrow().is_empty());
  }

  #[test]
  fn overwrite_replaces_completely() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let target = tmp.path().join("T.app");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("old"), b"old").unwrap();
    let signer = FakeSigner(RefCell::new(vec![]));
    build_app_from(&src, &target, &spec(false), true, &signer, &FakeIcons(RefCell::new(0))).unwrap();
    assert!(!target.join("old").exists());
    assert!(target.join("Contents/MacOS/MittProgram").exists());
  }

  #[test]
  fn icon_sets_plist() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let target = tmp.path().join("T.app");
    let icons = FakeIcons(RefCell::new(0));
    build_app_from(&src, &target, &spec(true), false, &FakeSigner(RefCell::new(vec![])), &icons).unwrap();
    assert_eq!(*icons.0.borrow(), 1);
    assert_eq!(plist_of(&target)["CFBundleIconFile"].as_string(), Some("icon.icns"));
    assert!(target.join("Contents/Resources/icon.icns").exists());
  }

  #[test]
  fn not_bundled_when_exe_not_in_app() {
    assert_eq!(bundle_from_exe(Path::new("/x/target/debug/app")), Err(MakeError::NotBundled));
    assert_eq!(bundle_from_exe(Path::new("/Apps/V.app/Contents/MacOS/V")), Ok(PathBuf::from("/Apps/V.app")));
  }
}
