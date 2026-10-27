//! Fil-kommandoer for prosjektfiler. Feil returneres som tekst til frontend.
//!
//! The commands are `async` and do their work on the blocking pool (`off_main`), so a slow disk, a FIFO or a network
//! volume does not freeze the main thread. Only regular files are read, at most MAX_FILE_BYTES of them.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::io_util::{off_main, open_read};

/// Bigger files are refused ("7|...", Out of memory): a project, a picture or a media file is far smaller.
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

fn err(path: &str, e: std::io::Error) -> String {
  format!("{}: {}", path, e)
}

/// The whole of a regular file, at most MAX_FILE_BYTES.
pub fn read_file(path: &str) -> Result<Vec<u8>, String> {
  let f = open_read(Path::new(path)).map_err(|e| err(path, e))?;
  let len = f.metadata().map(|m| m.len()).unwrap_or(0);
  if len > MAX_FILE_BYTES {
    return Err(format!("7|{}: the file is too big (more than {} MB)", path, MAX_FILE_BYTES / (1024 * 1024)));
  }
  let mut buf = Vec::with_capacity(len as usize);
  f.take(MAX_FILE_BYTES + 1).read_to_end(&mut buf).map_err(|e| err(path, e))?;
  if buf.len() as u64 > MAX_FILE_BYTES {
    return Err(format!("7|{}: the file is too big (more than {} MB)", path, MAX_FILE_BYTES / (1024 * 1024)));
  }
  Ok(buf)
}

pub fn read_text(path: &str) -> Result<String, String> {
  String::from_utf8(read_file(path)?).map_err(|_| format!("{}: stream did not contain valid UTF-8", path))
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
  off_main(move || read_text(&path)).await
}

/// The bytes as a raw IPC response (an ArrayBuffer in the window), not a JSON array of numbers.
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
  off_main(move || read_file(&path)).await.map(tauri::ipc::Response::new)
}

/// Skriver via en midlertidig fil i samme mappe og `rename`, så en krasj ikke ødelegger filen.
pub fn write_text(path: &str, text: &str) -> Result<(), String> {
  let target = Path::new(path);
  let file_name = target
    .file_name()
    .ok_or_else(|| format!("{}: not a file path", path))?
    .to_string_lossy()
    .to_string();
  // a temp file of its own for each write: two saves of one file at once must not share one
  static SEQ: AtomicU64 = AtomicU64::new(0);
  let seq = SEQ.fetch_add(1, Ordering::Relaxed);
  let tmp: PathBuf = target.with_file_name(format!(".{}.{}.{}.tmp", file_name, std::process::id(), seq));
  let result = std::fs::File::create(&tmp)
    .and_then(|mut f| f.write_all(text.as_bytes()).and_then(|_| f.sync_all()))   // on disk before it replaces the file
    .and_then(|_| std::fs::rename(&tmp, target));
  if let Err(e) = result {
    let _ = std::fs::remove_file(&tmp);
    return Err(err(path, e));
  }
  Ok(())
}

#[tauri::command]
pub async fn write_text_file(path: String, text: String) -> Result<(), String> {
  off_main(move || write_text(&path, &text)).await
}

/// A volume for DriveListBox: `path` is what `Drive1.Drive` returns.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Volume {
  pub name: String,
  pub path: String,
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct FileEntry {
  pub name: String,
  pub hidden: bool,
}

/// The contents of one folder: sub-folder names and files, each sorted without regard to case.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
  pub dirs: Vec<String>,
  pub files: Vec<FileEntry>,
  /// The hidden ones of `dirs` (Dir leaves them out without vbHidden): `$Recycle.Bin`, `System Volume Information`... on
  /// Windows, a name that starts with "." elsewhere.
  pub hidden_dirs: Vec<String>,
}

fn sort_names(v: &mut [String]) {
  v.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
}

/// "/" (the startup disk, named after the entry that points back to it when there is one) and every other folder in
/// `volume_dirs` (/Volumes on macOS; /media/$USER, /run/media/$USER and /mnt on Linux), sorted by name.
#[cfg_attr(windows, allow(dead_code))]
fn volumes_in(volume_dirs: &[PathBuf]) -> Vec<Volume> {
  let mut root_name = "/".to_string();
  let mut others: Vec<Volume> = Vec::new();
  for rd in volume_dirs.iter().filter_map(|d| std::fs::read_dir(d).ok()) {
    for e in rd.flatten() {
      let name = e.file_name().to_string_lossy().to_string();
      let path = e.path();
      if std::fs::canonicalize(&path).is_ok_and(|p| p == Path::new("/")) {
        root_name = name;
        continue;
      }
      if path.is_dir() {
        others.push(Volume { name, path: path.to_string_lossy().to_string() });
      }
    }
  }
  others.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
  let mut out = vec![Volume { name: root_name, path: "/".to_string() }];
  out.extend(others);
  out
}

/// A Windows drive as VB6's DriveListBox shows it: "c: [label]" (just "a:" without a label); `path` is its root (C:\).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn drive_volume(letter: char, label: &str) -> Volume {
  let l = letter.to_ascii_lowercase();
  let name = if label.is_empty() { format!("{l}:") } else { format!("{l}: [{label}]") };
  Volume { name, path: format!("{}:\\", letter.to_ascii_uppercase()) }
}

/// The drives there are (GetLogicalDrives), A: to Z:. The label is read for fixed, network and RAM drives only: an empty
/// floppy or card reader is not touched (it could be slow or ask for a disk).
#[cfg(windows)]
fn windows_volumes() -> Vec<Volume> {
  use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
  const DRIVE_FIXED: u32 = 3;
  const DRIVE_REMOTE: u32 = 4;
  const DRIVE_RAMDISK: u32 = 6;
  // SAFETY: no arguments.
  let mask = unsafe { GetLogicalDrives() };
  (0..26u8)
    .filter(|i| mask & (1 << i) != 0)
    .map(|i| {
      let letter = (b'A' + i) as char;
      let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain([0]).collect();
      // SAFETY: `root` is NUL-terminated; the label buffer's size is passed.
      let label = unsafe {
        let kind = GetDriveTypeW(root.as_ptr());
        let mut buf = [0u16; 261];
        let ok = matches!(kind, DRIVE_FIXED | DRIVE_REMOTE | DRIVE_RAMDISK)
          && GetVolumeInformationW(root.as_ptr(), buf.as_mut_ptr(), buf.len() as u32, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), 0) != 0;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
        if ok { String::from_utf16_lossy(&buf[..len]) } else { String::new() }
      };
      drive_volume(letter, &label)
    })
    .collect()
}

/// Where Linux mounts other disks: udisks2 under /media/$USER (Debian, Ubuntu) or /run/media/$USER (Fedora, Arch), and /mnt.
#[cfg(all(unix, not(target_os = "macos")))]
fn linux_volume_dirs() -> Vec<PathBuf> {
  let mut dirs = vec![];
  if let Some(user) = std::env::var_os("USER").filter(|u| !u.is_empty()) {
    dirs.push(Path::new("/media").join(&user));
    dirs.push(Path::new("/run/media").join(&user));
  }
  dirs.push(PathBuf::from("/mnt"));
  dirs
}

#[tauri::command]
pub async fn list_volumes() -> Result<Vec<Volume>, String> {
  #[cfg(target_os = "macos")]
  return off_main(|| Ok(volumes_in(&[PathBuf::from("/Volumes")]))).await;
  #[cfg(windows)]
  return off_main(|| Ok(windows_volumes())).await;
  #[cfg(all(unix, not(target_os = "macos")))]
  off_main(|| Ok(volumes_in(&linux_volume_dirs()))).await
}

/// A hidden file: the hidden attribute on Windows (`windows_attributes`), a name that starts with "." elsewhere.
pub fn is_hidden(name: &str, windows_attributes: Option<u32>) -> bool {
  const FILE_ATTRIBUTE_HIDDEN: u32 = 2;
  match windows_attributes {
    Some(a) => a & FILE_ATTRIBUTE_HIDDEN != 0,
    None => name.starts_with('.'),
  }
}

/// The Windows file attributes of `meta` (None elsewhere).
pub fn windows_attributes(meta: &std::fs::Metadata) -> Option<u32> {
  #[cfg(windows)]
  return Some(std::os::windows::fs::MetadataExt::file_attributes(meta));
  #[cfg(not(windows))]
  {
    let _ = meta;
    None
  }
}

/// Lists one folder (one level: nothing is followed further). A symlink to a folder is a folder, a symlink to a file a file.
/// An entry that can't be read is skipped; a folder that can't be opened is an error.
#[tauri::command]
pub async fn list_dir(path: String) -> Result<DirListing, String> {
  off_main(move || list(&path)).await
}

pub fn list(path: &str) -> Result<DirListing, String> {
  let rd = std::fs::read_dir(path).map_err(|e| err(path, e))?;
  let mut dirs: Vec<String> = Vec::new();
  let mut hidden_dirs: Vec<String> = Vec::new();
  let mut files: Vec<FileEntry> = Vec::new();
  for e in rd.flatten() {
    let name = e.file_name().to_string_lossy().to_string();
    let Ok(ft) = e.file_type() else { continue };
    // Windows: the entry's own attributes (a link's, not its target's), as Explorer shows them
    let attrs = || if cfg!(windows) { e.metadata().ok().and_then(|m| windows_attributes(&m)) } else { None };
    // a symlinked folder (/tmp, /var and /etc at "/") is listed like any other; DirListBox only goes one level down
    if ft.is_dir() || (ft.is_symlink() && std::fs::metadata(e.path()).is_ok_and(|m| m.is_dir())) {
      if is_hidden(&name, attrs()) {
        hidden_dirs.push(name.clone());
      }
      dirs.push(name);
    } else if ft.is_file() || (ft.is_symlink() && std::fs::metadata(e.path()).is_ok_and(|m| m.is_file())) {
      files.push(FileEntry { hidden: is_hidden(&name, attrs()), name });
    }
  }
  sort_names(&mut dirs);
  sort_names(&mut hidden_dirs);
  files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
  Ok(DirListing { dirs, files, hidden_dirs })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn unique_dir(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("vibebasic-test-{}-{}-{}", tag, std::process::id(), nanos));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn overlapping_saves_of_one_file_each_write_whole() {
    let dir = unique_dir("race");
    let path = dir.join("p.vbb").to_string_lossy().to_string();
    let texts: Vec<String> = (0..8).map(|i| i.to_string().repeat(200_000)).collect();
    let handles: Vec<_> = texts
      .iter()
      .cloned()
      .map(|t| {
        let path = path.clone();
        std::thread::spawn(move || (0..20).map(|_| write_text(&path, &t)).collect::<Result<Vec<_>, _>>())
      })
      .collect();
    for h in handles {
      h.join().unwrap().unwrap();
    }
    assert!(texts.contains(&read_text(&path).unwrap()));
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);   // no temp file left behind
  }

  #[test]
  fn write_then_read_roundtrip() {
    let dir = unique_dir("rt");
    let path = dir.join("a.vbb").to_string_lossy().to_string();
    write_text(&path, "æøå").unwrap();
    assert_eq!(read_text(&path).unwrap(), "æøå");
    assert_eq!(read_file(&path).unwrap(), "æøå".as_bytes());
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn overwrite_leaves_no_temp_file() {
    let dir = unique_dir("ow");
    let path = dir.join("b.vbb").to_string_lossy().to_string();
    write_text(&path, "one").unwrap();
    write_text(&path, "two").unwrap();
    assert_eq!(read_text(&path).unwrap(), "two");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn missing_file_gives_error_string() {
    let dir = unique_dir("miss");
    let err = read_text(&dir.join("nope.vbb").to_string_lossy()).unwrap_err();
    assert!(!err.is_empty());
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn list_dir_finds_folders_files_and_hidden_files_sorted() {
    let dir = unique_dir("ls");
    std::fs::create_dir(dir.join("beta")).unwrap();
    std::fs::create_dir(dir.join("Alpha")).unwrap();
    std::fs::write(dir.join("b.txt"), "x").unwrap();
    std::fs::write(dir.join("A.bas"), "x").unwrap();
    std::fs::write(dir.join(".secret"), "x").unwrap();
    let l = list(&dir.to_string_lossy()).unwrap();
    assert_eq!(l.dirs, vec!["Alpha", "beta"]);
    let files: Vec<(&str, bool)> = l.files.iter().map(|f| (f.name.as_str(), f.hidden)).collect();
    // a dot file is hidden on macOS and Linux; on Windows only the Hidden attribute counts
    assert_eq!(files, vec![(".secret", !cfg!(windows)), ("A.bas", false), ("b.txt", false)]);
    std::fs::remove_dir_all(dir).ok();
  }

  #[cfg(unix)]
  #[test]
  fn list_dir_lists_symlinked_folders_and_files() {
    let dir = unique_dir("sym");
    std::fs::create_dir(dir.join("real")).unwrap();
    std::fs::write(dir.join("f.txt"), "x").unwrap();
    std::os::unix::fs::symlink(&dir, dir.join("loop")).unwrap();
    std::os::unix::fs::symlink(dir.join("f.txt"), dir.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(dir.join("gone"), dir.join("broken")).unwrap();
    let l = list(&dir.to_string_lossy()).unwrap();
    assert_eq!(l.dirs, vec!["loop", "real"]);
    let names: Vec<&str> = l.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, vec!["f.txt", "link.txt"]);
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn list_dir_of_a_missing_folder_is_an_error_text() {
    let dir = unique_dir("nodir");
    assert!(!list(&dir.join("nope").to_string_lossy()).unwrap_err().is_empty());
    std::fs::remove_dir_all(dir).ok();
  }

  #[cfg(unix)]
  #[test]
  fn volumes_start_with_the_startup_disk_and_skip_the_entry_that_points_back() {
    let dir = unique_dir("vol");
    std::fs::create_dir(dir.join("Zeta")).unwrap();
    std::fs::create_dir(dir.join("alpha")).unwrap();
    std::os::unix::fs::symlink("/", dir.join("Macintosh HD")).unwrap();
    let v = volumes_in(&[dir.clone(), dir.join("missing")]);
    let got: Vec<(String, String)> = v.into_iter().map(|v| (v.name, v.path)).collect();
    assert_eq!(got[0], ("Macintosh HD".to_string(), "/".to_string()));
    assert_eq!(got.len(), 3);
    assert_eq!(got[1].0, "alpha");
    assert_eq!(got[2].0, "Zeta");
    assert!(!got.iter().skip(1).any(|(_, p)| p == "/"));
    std::fs::remove_dir_all(dir).ok();
  }

  #[cfg(unix)]
  #[test]
  fn linux_volumes_come_from_several_folders() {
    let (media, mnt) = (unique_dir("media"), unique_dir("mnt"));
    std::fs::create_dir(media.join("USB STICK")).unwrap();
    std::fs::create_dir(mnt.join("backup")).unwrap();
    let names: Vec<String> = volumes_in(&[media.clone(), mnt.clone()]).into_iter().map(|v| v.name).collect();
    assert_eq!(names, ["/", "backup", "USB STICK"]);
    std::fs::remove_dir_all(media).ok();
    std::fs::remove_dir_all(mnt).ok();
  }

  #[test]
  fn windows_drives_show_as_in_vb6() {
    assert_eq!(drive_volume('C', "Windows"), Volume { name: "c: [Windows]".into(), path: "C:\\".into() });
    assert_eq!(drive_volume('a', ""), Volume { name: "a:".into(), path: "A:\\".into() });
  }

  #[test]
  fn hidden_is_the_attribute_on_windows_and_a_dot_elsewhere() {
    assert!(is_hidden(".profile", None));
    assert!(!is_hidden("a.txt", None));
    assert!(is_hidden("desktop.ini", Some(2 | 4)));
    assert!(!is_hidden(".gitignore", Some(32)));
  }

  /// M1/M2: a FIFO is refused at once (not read forever), and a file over the cap is "7|".
  #[cfg(unix)]
  #[test]
  fn fifos_are_refused_and_big_files_capped() {
    let dir = unique_dir("fifo");
    let fifo = dir.join("pipe");
    crate::io_util::tests::mkfifo(&fifo);
    let p = fifo.to_string_lossy().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
      let _ = tx.send((read_text(&p).is_err(), read_file(&p).is_err()));
    });
    assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)).expect("reading a FIFO blocked"), (true, true));
    let big = dir.join("big.bin");
    std::fs::File::create(&big).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
    assert!(read_file(&big.to_string_lossy()).unwrap_err().starts_with("7|"));
    std::fs::remove_dir_all(dir).ok();
  }
}
