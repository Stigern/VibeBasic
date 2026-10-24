//! Make app on Windows and Linux: a copy of the running VibeBasic executable with the project appended (payload.rs).
//! Windows: `<name>.exe`, its icon and version resource rewritten. Linux: `<name>`, plus `<name>.desktop` and `<name>.png`
//! next to it. Pure file I/O, so all of it compiles (and is tested) on macOS too, where Make builds a .app instead.
#![cfg_attr(target_os = "macos", allow(dead_code))]

use std::fs;
use std::path::{Path, PathBuf};

use crate::icon;
use crate::make_app::{AppVersion, BuildSpec, MakeError, sanitize_for};
use crate::payload;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExeKind {
  Windows,
  Linux,
}

impl ExeKind {
  pub fn current() -> Self {
    if cfg!(windows) { ExeKind::Windows } else { ExeKind::Linux }
  }
}

fn io<E: std::fmt::Display>(e: E) -> MakeError {
  MakeError::Io(e.to_string())
}

/// The running executable, which Make copies. A development build loads its pages from the dev server, so a copy of it
/// would show nothing: Make needs a built VibeBasic.
pub fn current_exe_source() -> Result<PathBuf, MakeError> {
  if tauri::is_dev() {
    return Err(MakeError::NotBundled);
  }
  std::env::current_exe().map_err(io)
}

/// Absolute path required; the file name is sanitized (Windows rules on Windows) and gets exactly one `.exe` there (any
/// case of an `.exe` typed is replaced); on Linux the executable has no extension.
pub fn normalize_target(raw: &str, kind: ExeKind) -> Result<PathBuf, MakeError> {
  let path: PathBuf = Path::new(raw).components().collect();
  if !path.is_absolute() {
    return Err(MakeError::Io("the target path must be absolute".to_string()));
  }
  let file = path.file_name().ok_or_else(|| MakeError::Io("invalid target path".to_string()))?.to_string_lossy().into_owned();
  let parent = path.parent().ok_or_else(|| MakeError::Io("invalid target path".to_string()))?;
  Ok(match kind {
    ExeKind::Windows => {
      let base = if file.to_ascii_lowercase().ends_with(".exe") { &file[..file.len() - 4] } else { &file[..] };
      parent.join(format!("{}.exe", sanitize_for(base, true)))
    }
    ExeKind::Linux => parent.join(sanitize_for(&file, false)),
  })
}

/// The line that marks a .desktop file as one Make wrote (so a later Make may replace it).
const DESKTOP_MARK: &str = "X-VibeBasic-App=true";

fn made_desktop_file(p: &Path) -> bool {
  fs::read_to_string(p).is_ok_and(|t| t.lines().any(|l| l.trim() == DESKTOP_MARK))
}

/// A desktop entry string value: backslashes doubled (`\s`, `\n`... are escapes there).
fn desktop_value(s: &str) -> String {
  s.replace('\\', "\\\\")
}

/// The Exec value that runs `exe` with an opened file (`%f`): the path quoted as the spec asks, then escaped as a value.
fn desktop_exec(exe: &Path) -> String {
  let mut q = String::from("\"");
  for c in exe.to_string_lossy().chars() {
    match c {
      '"' | '`' | '$' | '\\' => {
        q.push('\\');
        q.push(c);
      }
      '%' => q.push_str("%%"),
      _ => q.push(c),
    }
  }
  q.push('"');
  format!("{} %f", desktop_value(&q))
}

/// The made app's launcher for Linux desktops (copy it to ~/.local/share/applications to list it in the menu).
pub fn desktop_entry(name: &str, exe: &Path, icon: Option<&Path>) -> String {
  let mut s = String::from("[Desktop Entry]\nType=Application\n");
  s += &format!("Name={}\nExec={}\n", desktop_value(name), desktop_exec(exe));
  if let Some(i) = icon {
    s += &format!("Icon={}\n", desktop_value(&i.to_string_lossy()));
  }
  s += "Terminal=false\nCategories=Utility;\n";
  s += DESKTOP_MARK;
  s.push('\n');
  s
}

fn unique_sibling(parent: &Path, name: &str, kind: &str) -> PathBuf {
  use std::sync::atomic::{AtomicU32, Ordering};
  static COUNTER: AtomicU32 = AtomicU32::new(0);
  let n = COUNTER.fetch_add(1, Ordering::Relaxed);
  parent.join(format!(".{name}.{kind}-{}-{n}", std::process::id()))
}

/// Writes `bytes` to `target` through a sibling temp file, so a failed write leaves the old file whole.
fn write_replacing(target: &Path, bytes: &[u8], executable: bool) -> Result<(), MakeError> {
  let parent = target.parent().ok_or_else(|| MakeError::Io("invalid target path".to_string()))?;
  let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let tmp = unique_sibling(parent, &name, "tmp");
  let result = (|| {
    fs::write(&tmp, bytes).map_err(io)?;
    #[cfg(unix)]
    if executable {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).map_err(io)?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    if target.exists() {
      // Windows can't rename over a file; moving the old one aside also works when it is running.
      let aside = unique_sibling(parent, &name, "old");
      fs::rename(target, &aside).map_err(io)?;
      if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::rename(&aside, target);
        return Err(io(e));
      }
      let _ = fs::remove_file(&aside);
      Ok(())
    } else {
      fs::rename(&tmp, target).map_err(io)
    }
  })();
  if result.is_err() {
    let _ = fs::remove_file(&tmp);
  }
  result
}

/// Builds the made app at `target` (a normalized path) from the executable `source`. Overwrites only a file that already
/// carries a project (a program Make made), never VibeBasic itself.
pub fn build_exe_from(source: &Path, target: &Path, spec: &BuildSpec, overwrite: bool, kind: ExeKind) -> Result<(), MakeError> {
  // Guards first: nothing is touched before these pass.
  let src = fs::canonicalize(source).map_err(io)?;
  let name = target.file_name().ok_or_else(|| MakeError::Io("invalid target path".to_string()))?.to_string_lossy().into_owned();
  let parent_raw = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
  let parent = fs::canonicalize(parent_raw).map_err(io)?;
  let target_real = parent.join(&name);
  if let Ok(meta) = fs::symlink_metadata(&target_real) {
    if fs::canonicalize(&target_real).is_ok_and(|t| t == src) {
      return Err(MakeError::Io("Can't replace VibeBasic itself.".to_string()));
    }
    if !overwrite {
      return Err(MakeError::Exists);
    }
    if !meta.is_file() || !payload::has_payload(&target_real) {
      return Err(MakeError::Io("Can't replace a program that wasn't made with VibeBasic.".to_string()));
    }
  }
  let linux_icon = spec.icon_png.as_deref().filter(|b| icon::is_png(b));
  let (desktop, png) = (parent.join(format!("{name}.desktop")), parent.join(format!("{name}.png")));
  if kind == ExeKind::Linux {
    let ours = made_desktop_file(&desktop);
    if desktop.exists() && !ours {
      return Err(MakeError::Io(format!("Can't replace {name}.desktop: it wasn't made with VibeBasic.")));
    }
    // the icon next to a launcher Make wrote is Make's too
    if linux_icon.is_some() && png.exists() && !(ours && png.is_file()) {
      return Err(MakeError::Io(format!("Can't replace {name}.png: it wasn't made with VibeBasic.")));
    }
  }

  let mut exe = payload::strip(&fs::read(&src).map_err(io)?).to_vec();
  if kind == ExeKind::Windows {
    exe = apply_pe_info(exe, spec, &name)?;
  }
  payload::append(&mut exe, spec.project_json.as_bytes());
  write_replacing(&target_real, &exe, true)?;

  if kind == ExeKind::Linux {
    if let Some(p) = linux_icon {
      write_replacing(&png, p, false)?;
    }
    let entry = desktop_entry(&spec.app_name, &target_real, linux_icon.map(|_| png.as_path()));
    write_replacing(&desktop, entry.as_bytes(), true)?;
  }
  Ok(())
}

/// The resource id of the application icon in a Tauri executable: Explorer shows it and Tauri makes the windows' icon from it.
const APP_ICON_ID: u32 = 32512;

/// The Authenticode signature (certificate table) of a signed VibeBasic.exe is dropped: it would not match the made app.
fn strip_signature(exe: &mut Vec<u8>) {
  let u16_at = |b: &[u8], o: usize| b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]));
  let u32_at = |b: &[u8], o: usize| b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]));
  let Some(pe) = u32_at(exe, 0x3c).map(|v| v as usize) else { return };
  if exe.get(pe..pe + 4) != Some(b"PE\0\0") {
    return;
  }
  let opt = pe + 24;
  let (count_at, dirs_at) = match u16_at(exe, opt) {
    Some(0x20b) => (opt + 108, opt + 112),
    Some(0x10b) => (opt + 92, opt + 96),
    _ => return,
  };
  if u32_at(exe, count_at).is_none_or(|n| n < 5) {
    return;
  }
  let cert = dirs_at + 4 * 8;
  let (Some(off), Some(size)) = (u32_at(exe, cert), u32_at(exe, cert + 4)) else { return };
  if size > 0 && (off as usize) > cert && off as usize + size as usize <= exe.len() {
    exe.truncate(off as usize);
    exe[cert..cert + 8].fill(0);
  }
}

/// The made app's .ico from the project icon (a PNG, or an .ico as it is); None keeps VibeBasic's icon.
fn windows_icon(icon_bytes: Option<&[u8]>) -> Result<Option<Vec<u8>>, MakeError> {
  match icon_bytes {
    Some(b) if icon::is_ico(b) => Ok(Some(b.to_vec())),
    Some(b) if icon::is_png(b) => icon::ico_from_png(b).map(Some).map_err(MakeError::Tool),
    _ => Ok(None),
  }
}

fn clamp16(n: u32) -> u32 {
  n.min(u16::MAX as u32)
}

/// VB6's version resource: FILEVERSION Major.Minor.0.Revision and the version texts of Project Properties > Make. The
/// description and product name are the app's name when empty (Task Manager shows the description).
pub fn fill_version_info(vi: &mut editpe::VersionInfo, v: &AppVersion, app_name: &str, file_name: &str) {
  let packed = editpe::types::VersionU32 { major: (clamp16(v.major) << 16) | clamp16(v.minor), minor: clamp16(v.revision) };
  vi.info.file_version = packed;
  vi.info.product_version = packed;
  let key = vi.strings.first().map(|t| t.key.clone()).unwrap_or_else(|| "040904B0".to_string());
  let mut table = editpe::VersionStringTable { key, strings: Default::default() };
  let version = format!("{}.{}.{}", v.major, v.minor, v.revision);
  let or_name = |s: &str| if s.trim().is_empty() { app_name.to_string() } else { s.to_string() };
  for (k, val) in [
    ("Comments", v.comments.clone()),
    ("CompanyName", v.company_name.clone()),
    ("FileDescription", or_name(&v.file_description)),
    ("FileVersion", version.clone()),
    ("InternalName", app_name.to_string()),
    ("LegalCopyright", v.copyright.clone()),
    ("LegalTrademarks", v.legal_trademarks.clone()),
    ("OriginalFilename", file_name.to_string()),
    ("ProductName", or_name(&v.product_name)),
    ("ProductVersion", version.clone()),
  ] {
    if !val.trim().is_empty() {
      table.strings.insert(k.to_string(), val);
    }
  }
  vi.strings = vec![table];
  if vi.vars.is_empty() {
    vi.vars = vec![editpe::types::VersionU16 { major: 0x0409, minor: 0x04B0 }];
  }
}

fn pe_err<E: std::fmt::Display>(e: E) -> MakeError {
  MakeError::Tool(format!("the program file: {e}"))
}

/// The made app's icon and version information in the PE resources of `exe` (VibeBasic.exe without a payload).
pub fn apply_pe_info(mut exe: Vec<u8>, spec: &BuildSpec, file_name: &str) -> Result<Vec<u8>, MakeError> {
  use editpe::{ResourceEntryName, constants::RT_GROUP_ICON};
  strip_signature(&mut exe);
  let mut image = editpe::Image::parse(exe).map_err(pe_err)?;
  let mut res = image.resource_directory().cloned().unwrap_or_default();
  if let Some(ico) = windows_icon(spec.icon_png.as_deref())? {
    res.remove_main_icon().map_err(pe_err)?;
    res.set_main_icon(ico).map_err(pe_err)?;
    // set_main_icon names the group MAINICON; Tauri loads the window icon by its id
    if let Some(groups) = res.root_mut().get_mut(ResourceEntryName::ID(RT_GROUP_ICON as u32)).and_then(|e| e.as_table_mut())
      && let Some(main) = groups.remove(ResourceEntryName::from_string("MAINICON"))
    {
      groups.insert(ResourceEntryName::ID(APP_ICON_ID), main);
    }
  }
  let mut vi = res.get_version_info().ok().flatten().unwrap_or_default();
  let v = spec.version.clone().unwrap_or(AppVersion { major: 1, ..Default::default() });
  fill_version_info(&mut vi, &v, &spec.app_name, file_name);
  res.set_version_info(&vi).map_err(pe_err)?;
  image.set_resource_directory(res).map_err(pe_err)?;
  Ok(image.data().to_vec())
}

#[cfg(test)]
mod tests {
  use super::*;
  use editpe::{ResourceEntryName, constants::RT_GROUP_ICON};

  /// A minimal PE32+ (x64) program: headers and one .text section, no resources.
  fn minimal_pe() -> Vec<u8> {
    let mut b = vec![0u8; 0x400];
    b[0..2].copy_from_slice(b"MZ");
    b[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
    b[0x40..0x44].copy_from_slice(b"PE\0\0");
    let put16 = |b: &mut Vec<u8>, o: usize, v: u16| b[o..o + 2].copy_from_slice(&v.to_le_bytes());
    let put32 = |b: &mut Vec<u8>, o: usize, v: u32| b[o..o + 4].copy_from_slice(&v.to_le_bytes());
    let put64 = |b: &mut Vec<u8>, o: usize, v: u64| b[o..o + 8].copy_from_slice(&v.to_le_bytes());
    let coff = 0x44;
    put16(&mut b, coff, 0x8664); // machine
    put16(&mut b, coff + 2, 1); // sections
    put16(&mut b, coff + 16, 240); // optional header size
    put16(&mut b, coff + 18, 0x22); // executable, large address aware
    let opt = coff + 20;
    put16(&mut b, opt, 0x20b);
    put32(&mut b, opt + 4, 0x200); // size of code
    put32(&mut b, opt + 16, 0x1000); // entry point
    put32(&mut b, opt + 20, 0x1000); // base of code
    put64(&mut b, opt + 24, 0x1_4000_0000); // image base
    put32(&mut b, opt + 32, 0x1000); // section alignment
    put32(&mut b, opt + 36, 0x200); // file alignment
    put16(&mut b, opt + 40, 6); // OS version
    put16(&mut b, opt + 48, 6); // subsystem version
    put32(&mut b, opt + 56, 0x2000); // size of image
    put32(&mut b, opt + 60, 0x200); // size of headers
    put16(&mut b, opt + 68, 2); // GUI subsystem
    put64(&mut b, opt + 72, 0x100000);
    put64(&mut b, opt + 80, 0x1000);
    put64(&mut b, opt + 88, 0x100000);
    put64(&mut b, opt + 96, 0x1000);
    put32(&mut b, opt + 108, 16); // data directories
    let sec = opt + 240;
    b[sec..sec + 5].copy_from_slice(b".text");
    put32(&mut b, sec + 8, 0x10); // virtual size
    put32(&mut b, sec + 12, 0x1000); // virtual address
    put32(&mut b, sec + 16, 0x200); // raw size
    put32(&mut b, sec + 20, 0x200); // raw pointer
    put32(&mut b, sec + 36, 0x6000_0020);
    b[0x200] = 0xc3; // ret
    b
  }

  fn spec_with(icon: Option<Vec<u8>>) -> BuildSpec {
    BuildSpec {
      app_name: "Kalkulator".into(),
      project_json: "{\"name\":\"Kalk\"}".into(),
      icon_png: icon,
      version: Some(AppVersion {
        major: 2,
        minor: 1,
        revision: 17,
        copyright: "(c) 2026 Stig".into(),
        company_name: "Moen AS".into(),
        ..Default::default()
      }),
      file_types: vec![],
    }
  }

  #[test]
  fn pe_version_and_icon_round_trip() {
    let png = crate::icon::tests::sample_png(64, 64);
    let out = apply_pe_info(minimal_pe(), &spec_with(Some(png)), "Kalkulator.exe").unwrap();
    let image = editpe::Image::parse(out.as_slice()).unwrap();
    let res = image.resource_directory().unwrap();
    let vi = res.get_version_info().unwrap().unwrap();
    assert_eq!({ vi.info.file_version.major }, (2 << 16) | 1);
    assert_eq!({ vi.info.file_version.minor }, 17);
    let s = &vi.strings[0].strings;
    assert_eq!(s["FileVersion"], "2.1.17");
    assert_eq!(s["CompanyName"], "Moen AS");
    assert_eq!(s["LegalCopyright"], "(c) 2026 Stig");
    assert_eq!(s["FileDescription"], "Kalkulator");
    assert_eq!(s["ProductName"], "Kalkulator");
    assert_eq!(s["OriginalFilename"], "Kalkulator.exe");
    assert!(!s.contains_key("Comments"));
    let groups = res.root().get(ResourceEntryName::ID(RT_GROUP_ICON as u32)).unwrap().as_table().unwrap();
    assert_eq!(groups.entries(), vec![&ResourceEntryName::ID(APP_ICON_ID)]);
    assert_eq!(res.get_main_icon().unwrap().map(|i| !i.is_empty()), Some(true));

    // a second Make from the result keeps one icon group and the new texts
    let mut again = spec_with(None);
    again.version.as_mut().unwrap().company_name = String::new();
    let out2 = apply_pe_info(out, &again, "K.exe").unwrap();
    let res2 = editpe::Image::parse(out2.as_slice()).unwrap().resource_directory().cloned().unwrap();
    let s2 = res2.get_version_info().unwrap().unwrap().strings[0].strings.clone();
    assert!(!s2.contains_key("CompanyName"));
    assert_eq!(s2["OriginalFilename"], "K.exe");
  }

  #[test]
  fn signature_is_dropped() {
    let mut pe = minimal_pe();
    let cert_dir = 0x44 + 20 + 112 + 4 * 8;
    let off = pe.len() as u32;
    pe.extend_from_slice(&[7u8; 16]);
    pe[cert_dir..cert_dir + 4].copy_from_slice(&off.to_le_bytes());
    pe[cert_dir + 4..cert_dir + 8].copy_from_slice(&16u32.to_le_bytes());
    strip_signature(&mut pe);
    assert_eq!(pe.len() as u32, off);
    assert_eq!(&pe[cert_dir..cert_dir + 8], &[0; 8]);
    let mut not_pe = b"plain bytes".to_vec();
    strip_signature(&mut not_pe);
    assert_eq!(not_pe, b"plain bytes");
  }

  #[test]
  fn targets_per_platform() {
    // "/Apps" is absolute only off Windows; there an absolute path needs a drive
    let root = if cfg!(windows) { "C:" } else { "" };
    let abs = |s: &str| format!("{root}{s}");
    let w = |s: &str| normalize_target(&abs(s), ExeKind::Windows).unwrap();
    assert_eq!(w("/Apps/Kalk.EXE"), PathBuf::from(abs("/Apps/Kalk.exe")));
    assert_eq!(w("/Apps/My: App?. "), PathBuf::from(abs("/Apps/My App.exe")));
    assert_eq!(w("/Apps/Kalk"), PathBuf::from(abs("/Apps/Kalk.exe")));
    // a device name (CON, NUL, COM1...) would make a file Explorer can't open or delete
    assert_eq!(w("/Apps/nul.exe"), PathBuf::from(abs("/Apps/nul_.exe")));
    assert_eq!(w("/Apps/CON"), PathBuf::from(abs("/Apps/CON_.exe")));
    assert_eq!(w("/Apps/Com3.backup"), PathBuf::from(abs("/Apps/Com3_.backup.exe")));
    assert_eq!(w("/Apps/LPT9 "), PathBuf::from(abs("/Apps/LPT9_.exe")));
    assert_eq!(w("/Apps/Console"), PathBuf::from(abs("/Apps/Console.exe")));
    assert_eq!(w("/Apps/COM0"), PathBuf::from(abs("/Apps/COM0.exe")));
    let l = |s: &str| normalize_target(&abs(s), ExeKind::Linux).unwrap();
    assert_eq!(l("/home/s/CON"), PathBuf::from(abs("/home/s/CON")));
    assert_eq!(l("/home/s/Kalk 2.0"), PathBuf::from(abs("/home/s/Kalk 2.0")));
    assert!(normalize_target(&abs("/home/s/.."), ExeKind::Linux).is_err());
    assert!(normalize_target("rel/x", ExeKind::Linux).is_err());
  }

  #[test]
  fn desktop_entry_quotes_the_path() {
    let e = desktop_entry("Kalk", Path::new("/home/s/My $Apps/100%/Kalk"), Some(Path::new("/home/s/Kalk.png")));
    assert!(e.contains("Exec=\"/home/s/My \\\\$Apps/100%%/Kalk\" %f\n"), "{e}");
    assert!(e.contains("Icon=/home/s/Kalk.png\n"));
    assert!(e.contains("Name=Kalk\n"));
    assert!(e.lines().any(|l| l == DESKTOP_MARK));
    assert!(!desktop_entry("K", Path::new("/k"), None).contains("Icon="));
  }

  fn source(dir: &Path) -> PathBuf {
    let p = dir.join("VibeBasic");
    fs::write(&p, b"\x7fELF the ide").unwrap();
    p
  }

  #[test]
  fn linux_build_then_overwrite() {
    let tmp = tempfile::tempdir().unwrap();
    let src = source(tmp.path());
    let target = tmp.path().join("Kalk");
    let png = crate::icon::tests::sample_png(8, 8);
    build_exe_from(&src, &target, &spec_with(Some(png.clone())), false, ExeKind::Linux).unwrap();
    let made = fs::read(&target).unwrap();
    assert_eq!(payload::strip(&made), b"\x7fELF the ide");
    assert_eq!(payload::read_file(&target).unwrap().unwrap(), b"{\"name\":\"Kalk\"}");
    assert_eq!(fs::read(tmp.path().join("Kalk.png")).unwrap(), png);
    assert!(made_desktop_file(&tmp.path().join("Kalk.desktop")));
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755);
    }
    assert_eq!(build_exe_from(&src, &target, &spec_with(None), false, ExeKind::Linux), Err(MakeError::Exists));
    let mut s = spec_with(Some(png));
    s.project_json = "two".into();
    build_exe_from(&src, &target, &s, true, ExeKind::Linux).unwrap();
    assert_eq!(payload::read_file(&target).unwrap().unwrap(), b"two");
    let names: Vec<_> = fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(names.iter().all(|n| !n.starts_with('.')), "{names:?}");
  }

  #[test]
  fn refuses_to_overwrite_other_files() {
    let tmp = tempfile::tempdir().unwrap();
    let src = source(tmp.path());
    // a plain program (no payload)
    let target = tmp.path().join("notepad.exe");
    fs::write(&target, b"MZ someone else's program").unwrap();
    let r = build_exe_from(&src, &target, &spec_with(None), true, ExeKind::Windows);
    assert!(matches!(r, Err(MakeError::Io(m)) if m.contains("wasn't made with VibeBasic")));
    assert_eq!(fs::read(&target).unwrap(), b"MZ someone else's program");
    // a folder
    let dir = tmp.path().join("Folder");
    fs::create_dir(&dir).unwrap();
    assert!(matches!(build_exe_from(&src, &dir, &spec_with(None), true, ExeKind::Linux), Err(MakeError::Io(_))));
    // VibeBasic itself
    let r = build_exe_from(&src, &src, &spec_with(None), true, ExeKind::Linux);
    assert!(matches!(r, Err(MakeError::Io(m)) if m.contains("VibeBasic itself")));
    assert_eq!(fs::read(&src).unwrap(), b"\x7fELF the ide");
    // a .desktop or .png beside it that Make didn't write
    fs::write(tmp.path().join("Kalk.desktop"), "[Desktop Entry]\nName=Mine\n").unwrap();
    let r = build_exe_from(&src, &tmp.path().join("Kalk"), &spec_with(None), true, ExeKind::Linux);
    assert!(matches!(r, Err(MakeError::Io(m)) if m.contains("Kalk.desktop")));
    assert!(!tmp.path().join("Kalk").exists());
    fs::write(tmp.path().join("Foto.png"), b"holiday").unwrap();
    let png = crate::icon::tests::sample_png(8, 8);
    let r = build_exe_from(&src, &tmp.path().join("Foto"), &spec_with(Some(png)), true, ExeKind::Linux);
    assert!(matches!(r, Err(MakeError::Io(m)) if m.contains("Foto.png")));
    assert_eq!(fs::read(tmp.path().join("Foto.png")).unwrap(), b"holiday");
  }

  #[test]
  fn windows_build_carries_the_payload_after_the_resources() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("VibeBasic.exe");
    fs::write(&src, minimal_pe()).unwrap();
    let target = tmp.path().join("Kalkulator.exe");
    build_exe_from(&src, &target, &spec_with(None), false, ExeKind::Windows).unwrap();
    assert_eq!(payload::read_file(&target).unwrap().unwrap(), b"{\"name\":\"Kalk\"}");
    let made = fs::read(&target).unwrap();
    let image = editpe::Image::parse(payload::strip(&made)).unwrap();
    assert!(image.resource_directory().unwrap().get_version_info().unwrap().is_some());
    // overwriting a made app works
    build_exe_from(&src, &target, &spec_with(None), true, ExeKind::Windows).unwrap();
  }
}
