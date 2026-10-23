//! Make app: builds a standalone .app by copying VibeBasic.app itself.

/// Removes control characters, `/` and `:`, trims whitespace and leading dots.
/// Empty names (and `.`/`..`) become `Project1`.
pub fn sanitize_app_file_name(name: &str) -> String {
  let cleaned: String = name.chars().filter(|c| !c.is_control() && *c != '/' && *c != ':').collect();
  let trimmed = cleaned.trim().trim_start_matches('.').trim();
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
  /// Project Properties > Make: the version number and copyright. None keeps the source bundle's version.
  pub version: Option<AppVersion>,
  /// File extensions the app opens (CFBundleDocumentTypes); the opened file's path is Command$.
  pub file_types: Vec<String>,
}

/// VB6's version number (Major.Minor.Revision) and the Legal Copyright of the version information.
#[derive(serde::Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
  pub major: u32,
  pub minor: u32,
  pub revision: u32,
  #[serde(default)]
  pub copyright: String,
}

/// An extension as a document type lists it: no leading `*.` or `.`, lower case; None when it has other characters than
/// letters, digits, `-` and `_`.
pub fn clean_extension(ext: &str) -> Option<String> {
  let e = ext.trim().trim_start_matches('*').trim_start_matches('.').to_lowercase();
  (!e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then_some(e)
}

/// The made app's version and document types in its Info.plist. The source's own document types (VibeBasic's) never stay.
pub fn apply_app_info(dict: &mut plist::Dictionary, spec: &BuildSpec) {
  if let Some(v) = &spec.version {
    dict.insert("CFBundleShortVersionString".into(), format!("{}.{}.{}", v.major, v.minor, v.revision).into());
    dict.insert("CFBundleVersion".into(), v.revision.to_string().into());
    if v.copyright.trim().is_empty() {
      dict.remove("NSHumanReadableCopyright");
    } else {
      dict.insert("NSHumanReadableCopyright".into(), v.copyright.clone().into());
    }
  }
  dict.remove("CFBundleDocumentTypes");
  let mut exts: Vec<String> = vec![];
  for e in spec.file_types.iter().filter_map(|e| clean_extension(e)) {
    if !exts.contains(&e) {
      exts.push(e);
    }
  }
  if exts.is_empty() {
    return;
  }
  let types: Vec<plist::Value> = exts
    .into_iter()
    .map(|e| {
      let mut d = plist::Dictionary::new();
      d.insert("CFBundleTypeName".into(), format!("{} {} document", spec.app_name, e.to_uppercase()).into());
      d.insert("CFBundleTypeExtensions".into(), plist::Value::Array(vec![e.into()]));
      d.insert("CFBundleTypeRole".into(), "Editor".into());
      plist::Value::Dictionary(d)
    })
    .collect();
  dict.insert("CFBundleDocumentTypes".into(), plist::Value::Array(types));
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
  let macos = exe.parent().ok_or(MakeError::NotBundled)?;
  let contents = macos.parent().ok_or(MakeError::NotBundled)?;
  let bundle = contents.parent().ok_or(MakeError::NotBundled)?;
  if macos.file_name().is_some_and(|n| n == "MacOS")
    && contents.file_name().is_some_and(|n| n == "Contents")
    && bundle.extension().is_some_and(|e| e == "app")
  {
    Ok(bundle.to_path_buf())
  } else {
    Err(MakeError::NotBundled)
  }
}

pub fn current_bundle() -> Result<PathBuf, MakeError> {
  let exe = std::env::current_exe().map_err(io)?;
  bundle_from_exe(&exe)
}

fn unique_sibling(parent: &Path, stem: &str, kind: &str) -> PathBuf {
  use std::sync::atomic::{AtomicU32, Ordering};
  static COUNTER: AtomicU32 = AtomicU32::new(0);
  let n = COUNTER.fetch_add(1, Ordering::Relaxed);
  parent.join(format!(".{stem}.{kind}-{}-{n}.app", std::process::id()))
}

pub fn build_app_from(
  source_bundle: &Path,
  target: &Path,
  spec: &BuildSpec,
  overwrite: bool,
  signer: &dyn Signer,
  icons: &dyn IconConverter,
) -> Result<(), MakeError> {
  // Guards first: nothing is touched before these pass.
  let src = fs::canonicalize(source_bundle).map_err(io)?;
  let name = target
    .file_name()
    .ok_or_else(|| MakeError::Io("invalid target path".to_string()))?
    .to_os_string();
  let parent_raw = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
  let parent = fs::canonicalize(parent_raw).map_err(io)?;
  let target_real = parent.join(&name);
  let exists = fs::symlink_metadata(&target_real).is_ok();
  let target_cmp = if exists { fs::canonicalize(&target_real).map_err(io)? } else { target_real.clone() };
  if target_cmp == src || target_cmp.starts_with(&src) || src.starts_with(&target_cmp) {
    return Err(MakeError::Io("Can't replace VibeBasic itself.".to_string()));
  }
  if exists {
    if !overwrite {
      return Err(MakeError::Exists);
    }
    let plist_path = target_real.join("Contents/Info.plist");
    if !plist_path.is_file() {
      return Err(MakeError::Io("the existing target is not an app bundle".to_string()));
    }
    let made_here = plist::Value::from_file(&plist_path)
      .ok()
      .and_then(|v| v.into_dictionary())
      .and_then(|d| d.get("CFBundleIdentifier").and_then(|i| i.as_string().map(|s| s.starts_with("no.vibebasic.app."))))
      .unwrap_or(false);
    if !made_here {
      return Err(MakeError::Io("Can't replace an app that wasn't made with VibeBasic.".to_string()));
    }
  }

  // Build in a sibling temp bundle, then swap it into place.
  let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
  let tmp = unique_sibling(&parent, &stem, "tmp");
  let _ = fs::remove_dir_all(&tmp);
  if let Err(e) = build_inner(source_bundle, &tmp, spec, signer, icons) {
    let _ = fs::remove_dir_all(&tmp);
    return Err(e);
  }
  if exists {
    let aside = unique_sibling(&parent, &stem, "old");
    if let Err(e) = fs::rename(&target_real, &aside) {
      let _ = fs::remove_dir_all(&tmp);
      return Err(io(e));
    }
    if let Err(e) = fs::rename(&tmp, &target_real) {
      let _ = fs::rename(&aside, &target_real);
      let _ = fs::remove_dir_all(&tmp);
      return Err(io(e));
    }
    let _ = fs::remove_dir_all(&aside);
  } else if let Err(e) = fs::rename(&tmp, &target_real) {
    let _ = fs::remove_dir_all(&tmp);
    return Err(io(e));
  }
  Ok(())
}

fn build_inner(
  source: &Path,
  target: &Path,
  spec: &BuildSpec,
  signer: &dyn Signer,
  icons: &dyn IconConverter,
) -> Result<(), MakeError> {
  // No resource forks, extended attributes or quarantine flag: FinderInfo breaks codesign, quarantine breaks App.Path.
  let status = Command::new("ditto").args(["--norsrc", "--noextattr", "--noqtn"]).arg(source).arg(target).output().map_err(io)?;
  if !status.status.success() {
    return Err(MakeError::Tool(format!("ditto: {}", String::from_utf8_lossy(&status.stderr).trim())));
  }
  let _ = Command::new("xattr").arg("-cr").arg(target).output();
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
  apply_app_info(&mut dict, spec);
  if let Some(png) = &spec.icon_png {
    icons.png_to_icns(png, &resources.join("icon.icns")).map_err(MakeError::Tool)?;
    dict.insert("CFBundleIconFile".into(), "icon.icns".into());
  }
  plist::Value::Dictionary(dict).to_file_xml(&plist_path).map_err(io)?;
  signer.sign(target).map_err(MakeError::Tool)
}

/// Absolute path required; trailing separators dropped; the file name is
/// sanitized and gets exactly one `.app` suffix.
pub fn normalize_target(raw: &str) -> Result<PathBuf, MakeError> {
  let path: PathBuf = Path::new(raw).components().collect();
  if !path.is_absolute() {
    return Err(MakeError::Io("the target path must be absolute".to_string()));
  }
  let file = path
    .file_name()
    .ok_or_else(|| MakeError::Io("invalid target path".to_string()))?
    .to_string_lossy()
    .into_owned();
  let base = file.strip_suffix(".app").unwrap_or(&file);
  let parent = path.parent().ok_or_else(|| MakeError::Io("invalid target path".to_string()))?;
  Ok(parent.join(format!("{}.app", sanitize_app_file_name(base))))
}

/// Ok when VibeBasic runs as a built .app (the only place Make works).
#[tauri::command]
pub fn can_make_app() -> Result<(), String> {
  current_bundle().map(|_| ()).map_err(|e| e.message())
}

#[tauri::command]
pub async fn make_app(
  target_path: String,
  app_name: String,
  project_json: String,
  icon_png_base64: Option<String>,
  overwrite: bool,
  version: Option<AppVersion>,
  file_types: Option<Vec<String>>,
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
    let target = normalize_target(&target_path)?;
    let spec = BuildSpec { app_name, project_json, icon_png, version, file_types: file_types.unwrap_or_default() };
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
      version: None,
      file_types: vec![],
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
    // signed once, as a sibling temp bundle that is then renamed into place
    assert_eq!(signer.0.borrow().len(), 1);
    assert_eq!(signer.0.borrow()[0].parent(), target.canonicalize().unwrap().parent());
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
    make_old_bundle(&target);
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
  fn plist_gets_version_copyright_and_document_types() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    // VibeBasic's own version, copyright and document types must not reach the made app
    let mut d = plist_of(&src);
    d.insert("CFBundleShortVersionString".into(), "0.9.0".into());
    d.insert("NSHumanReadableCopyright".into(), "VibeBasic".into());
    d.insert("CFBundleDocumentTypes".into(), plist::Value::Array(vec![]));
    plist::Value::Dictionary(d).to_file_xml(src.join("Contents/Info.plist")).unwrap();
    let target = tmp.path().join("T.app");
    let mut s = spec(false);
    s.version = Some(AppVersion { major: 2, minor: 1, revision: 17, copyright: "(c) 2026 Stig".into() });
    s.file_types = vec!["*.kalk".into(), ".TXT".into(), "bad/ext".into()];
    build_app_from(&src, &target, &s, false, &FakeSigner(RefCell::new(vec![])), &FakeIcons(RefCell::new(0))).unwrap();
    let p = plist_of(&target);
    assert_eq!(p["CFBundleShortVersionString"].as_string(), Some("2.1.17"));
    assert_eq!(p["CFBundleVersion"].as_string(), Some("17"));
    assert_eq!(p["NSHumanReadableCopyright"].as_string(), Some("(c) 2026 Stig"));
    let types = p["CFBundleDocumentTypes"].as_array().unwrap();
    let exts: Vec<_> = types
      .iter()
      .map(|t| t.as_dictionary().unwrap()["CFBundleTypeExtensions"].as_array().unwrap()[0].as_string().unwrap().to_string())
      .collect();
    assert_eq!(exts, ["kalk", "txt"]);
    assert_eq!(types[0].as_dictionary().unwrap()["CFBundleTypeRole"].as_string(), Some("Editor"));

    // no file types and no copyright: neither key is left
    let target2 = tmp.path().join("U.app");
    let mut s2 = spec(false);
    s2.version = Some(AppVersion { major: 1, minor: 0, revision: 0, copyright: String::new() });
    build_app_from(&src, &target2, &s2, false, &FakeSigner(RefCell::new(vec![])), &FakeIcons(RefCell::new(0))).unwrap();
    let p2 = plist_of(&target2);
    assert!(p2.get("CFBundleDocumentTypes").is_none());
    assert!(p2.get("NSHumanReadableCopyright").is_none());
    assert_eq!(p2["CFBundleShortVersionString"].as_string(), Some("1.0.0"));
  }

  #[test]
  fn not_bundled_when_exe_not_in_app() {
    assert_eq!(bundle_from_exe(Path::new("/x/target/debug/app")), Err(MakeError::NotBundled));
    assert_eq!(bundle_from_exe(Path::new("/Apps/V.app/Contents/MacOS/V")), Ok(PathBuf::from("/Apps/V.app")));
  }

  fn make_old_bundle(target: &Path) {
    fs::create_dir_all(target.join("Contents")).unwrap();
    set_bundle_id(target, "no.vibebasic.app.old");
    fs::write(target.join("old"), b"old").unwrap();
  }

  fn set_bundle_id(target: &Path, id: &str) {
    let mut d = plist::Dictionary::new();
    d.insert("CFBundleIdentifier".into(), id.into());
    plist::Value::Dictionary(d).to_file_xml(target.join("Contents/Info.plist")).unwrap();
  }

  struct FailSigner;
  impl Signer for FailSigner {
    fn sign(&self, _: &Path) -> Result<(), String> {
      Err("boom".into())
    }
  }

  fn no_leftovers(dir: &Path) {
    let names: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(names.iter().all(|n| !n.contains(".tmp-") && !n.contains(".old-")), "{names:?}");
  }

  #[test]
  fn refuses_to_replace_source_itself() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let r = build_app_from(&src, &src, &spec(false), true, &FakeSigner(RefCell::new(vec![])), &FakeIcons(RefCell::new(0)));
    assert!(matches!(r, Err(MakeError::Io(m)) if m.contains("Can't replace VibeBasic itself")));
    assert!(src.join("Contents/MacOS/VibeBasic").exists());
    assert!(src.join("Contents/Resources/x").exists());
  }

  #[test]
  fn refuses_target_inside_or_around_source() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let inside = src.join("Contents/Resources/Inner.app");
    let r = build_app_from(&src, &inside, &spec(false), false, &FakeSigner(RefCell::new(vec![])), &FakeIcons(RefCell::new(0)));
    assert!(matches!(r, Err(MakeError::Io(_))));
    assert!(!inside.exists());
    // source inside target
    let outer = tmp.path().join("Outer.app");
    fs::create_dir_all(&outer).unwrap();
    let src2 = fake_source(&outer);
    let r = build_app_from(&src2, &outer, &spec(false), true, &FakeSigner(RefCell::new(vec![])), &FakeIcons(RefCell::new(0)));
    assert!(matches!(r, Err(MakeError::Io(_))));
    assert!(src2.join("Contents/MacOS/VibeBasic").exists());
  }

  #[test]
  fn failing_signer_leaves_old_target_intact() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let target = tmp.path().join("T.app");
    make_old_bundle(&target);
    let r = build_app_from(&src, &target, &spec(false), true, &FailSigner, &FakeIcons(RefCell::new(0)));
    assert!(matches!(r, Err(MakeError::Tool(_))));
    assert_eq!(fs::read(target.join("old")).unwrap(), b"old");
    assert!(!target.join("Contents/MacOS").exists());
    no_leftovers(tmp.path());
  }

  #[test]
  fn successful_overwrite_leaves_no_temp_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let target = tmp.path().join("T.app");
    make_old_bundle(&target);
    build_app_from(&src, &target, &spec(false), true, &FakeSigner(RefCell::new(vec![])), &FakeIcons(RefCell::new(0))).unwrap();
    no_leftovers(tmp.path());
  }

  #[test]
  fn refuses_to_delete_non_bundle() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let target = tmp.path().join("Docs.app");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("precious"), b"p").unwrap();
    let r = build_app_from(&src, &target, &spec(false), true, &FakeSigner(RefCell::new(vec![])), &FakeIcons(RefCell::new(0)));
    assert!(matches!(r, Err(MakeError::Io(m)) if m.contains("not an app bundle")));
    assert!(target.join("precious").exists());
  }

  #[test]
  fn refuses_to_replace_foreign_app() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let target = tmp.path().join("Safari.app");
    make_old_bundle(&target);
    set_bundle_id(&target, "com.apple.Safari");
    let signer = FakeSigner(RefCell::new(vec![]));
    let r = build_app_from(&src, &target, &spec(false), true, &signer, &FakeIcons(RefCell::new(0)));
    assert!(matches!(r, Err(MakeError::Io(m)) if m.contains("Can't replace an app that wasn't made with VibeBasic.")));
    assert!(target.join("old").exists());
    assert!(signer.0.borrow().is_empty());
    no_leftovers(tmp.path());
  }

  fn xattr_ok(args: &[&str], path: &Path) -> bool {
    Command::new("xattr").args(args).arg(path).output().map(|o| o.status.success()).unwrap_or(false)
  }

  #[test]
  fn built_bundle_drops_quarantine_and_finder_info() {
    let tmp = tempfile::tempdir().unwrap();
    let src = fake_source(tmp.path());
    let probe = src.join("Contents/Resources/x");
    let q = "0081;00000000;Test;";
    if !xattr_ok(&["-w", "com.apple.quarantine", q], &src) || !xattr_ok(&["-w", "com.apple.quarantine", q], &probe) {
      return; // xattr not available here
    }
    let target = tmp.path().join("T.app");
    build_app_from(&src, &target, &spec(false), false, &FakeSigner(RefCell::new(vec![])), &FakeIcons(RefCell::new(0))).unwrap();
    let listing = |p: &Path| {
      let o = Command::new("xattr").arg(p).output().unwrap();
      String::from_utf8_lossy(&o.stdout).into_owned()
    };
    assert!(listing(&src).contains("com.apple.quarantine"), "precondition");
    assert!(!listing(&target).contains("com.apple.quarantine"));
    assert!(!listing(&target.join("Contents/Resources/x")).contains("com.apple.quarantine"));
  }

  #[test]
  fn sanitize_rejects_dots_and_control_chars() {
    assert_eq!(sanitize_app_file_name(".."), "Project1");
    assert_eq!(sanitize_app_file_name("."), "Project1");
    assert_eq!(sanitize_app_file_name(".hidden"), "hidden");
    assert_eq!(sanitize_app_file_name("a\0b\nc"), "abc");
  }

  #[test]
  fn normalize_target_rules() {
    assert_eq!(normalize_target("/Apps/My: App/").unwrap(), PathBuf::from("/Apps/My App.app"));
    assert_eq!(normalize_target("/Apps/X.app").unwrap(), PathBuf::from("/Apps/X.app"));
    assert_eq!(normalize_target("/Apps/..").unwrap_err().message().contains("Could not make the app"), true);
    assert!(normalize_target("rel/X.app").is_err());
    assert!(normalize_target("/").is_err());
  }

  #[test]
  fn bundle_from_exe_requires_contents_macos() {
    assert_eq!(bundle_from_exe(Path::new("/x/Foo.app/Resources/a/bin")), Err(MakeError::NotBundled));
    assert_eq!(bundle_from_exe(Path::new("/x/Foo.app/Contents/Other/bin")), Err(MakeError::NotBundled));
  }
}
