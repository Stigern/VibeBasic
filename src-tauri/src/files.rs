//! Fil-kommandoer for prosjektfiler. Feil returneres som tekst til frontend.

use std::path::{Path, PathBuf};

fn err(path: &str, e: std::io::Error) -> String {
  format!("{}: {}", path, e)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
  std::fs::read_to_string(&path).map_err(|e| err(&path, e))
}

#[tauri::command]
pub fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
  std::fs::read(&path).map_err(|e| err(&path, e))
}

/// Skriver via en midlertidig fil i samme mappe og `rename`, så en krasj ikke ødelegger filen.
#[tauri::command]
pub fn write_text_file(path: String, text: String) -> Result<(), String> {
  let target = Path::new(&path);
  let file_name = target
    .file_name()
    .ok_or_else(|| format!("{}: not a file path", path))?
    .to_string_lossy()
    .to_string();
  let tmp: PathBuf = target.with_file_name(format!(".{}.{}.tmp", file_name, std::process::id()));
  let result = std::fs::write(&tmp, text.as_bytes()).and_then(|_| std::fs::rename(&tmp, target));
  if let Err(e) = result {
    let _ = std::fs::remove_file(&tmp);
    return Err(err(&path, e));
  }
  Ok(())
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
pub struct DirListing {
  pub dirs: Vec<String>,
  pub files: Vec<FileEntry>,
}

fn sort_names(v: &mut [String]) {
  v.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
}

/// "/" (the startup disk, named after the /Volumes entry that points back to it when there is one) and every other /Volumes/* entry.
fn volumes_in(volumes_dir: &Path) -> Vec<Volume> {
  let mut root_name = "/".to_string();
  let mut others: Vec<Volume> = Vec::new();
  if let Ok(rd) = std::fs::read_dir(volumes_dir) {
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

#[tauri::command]
pub fn list_volumes() -> Vec<Volume> {
  volumes_in(Path::new("/Volumes"))
}

/// Lists one folder (one level: nothing is followed further). A symlink to a folder is a folder, a symlink to a file a file.
/// An entry that can't be read is skipped; a folder that can't be opened is an error.
#[tauri::command]
pub fn list_dir(path: String) -> Result<DirListing, String> {
  let rd = std::fs::read_dir(&path).map_err(|e| err(&path, e))?;
  let mut dirs: Vec<String> = Vec::new();
  let mut files: Vec<FileEntry> = Vec::new();
  for e in rd.flatten() {
    let name = e.file_name().to_string_lossy().to_string();
    let Ok(ft) = e.file_type() else { continue };
    // a symlinked folder (/tmp, /var and /etc at "/") is listed like any other; DirListBox only goes one level down
    if ft.is_dir() || (ft.is_symlink() && std::fs::metadata(e.path()).is_ok_and(|m| m.is_dir())) {
      dirs.push(name);
    } else if ft.is_file() || (ft.is_symlink() && std::fs::metadata(e.path()).is_ok_and(|m| m.is_file())) {
      files.push(FileEntry { hidden: name.starts_with('.'), name });
    }
  }
  sort_names(&mut dirs);
  files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
  Ok(DirListing { dirs, files })
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
  fn write_then_read_roundtrip() {
    let dir = unique_dir("rt");
    let path = dir.join("a.vbb").to_string_lossy().to_string();
    write_text_file(path.clone(), "æøå".to_string()).unwrap();
    assert_eq!(read_text_file(path.clone()).unwrap(), "æøå");
    assert_eq!(read_binary_file(path).unwrap(), "æøå".as_bytes());
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn overwrite_leaves_no_temp_file() {
    let dir = unique_dir("ow");
    let path = dir.join("b.vbb").to_string_lossy().to_string();
    write_text_file(path.clone(), "one".to_string()).unwrap();
    write_text_file(path.clone(), "two".to_string()).unwrap();
    assert_eq!(read_text_file(path).unwrap(), "two");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn missing_file_gives_error_string() {
    let dir = unique_dir("miss");
    let err = read_text_file(dir.join("nope.vbb").to_string_lossy().to_string()).unwrap_err();
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
    let l = list_dir(dir.to_string_lossy().to_string()).unwrap();
    assert_eq!(l.dirs, vec!["Alpha", "beta"]);
    let files: Vec<(&str, bool)> = l.files.iter().map(|f| (f.name.as_str(), f.hidden)).collect();
    assert_eq!(files, vec![(".secret", true), ("A.bas", false), ("b.txt", false)]);
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn list_dir_lists_symlinked_folders_and_files() {
    let dir = unique_dir("sym");
    std::fs::create_dir(dir.join("real")).unwrap();
    std::fs::write(dir.join("f.txt"), "x").unwrap();
    std::os::unix::fs::symlink(&dir, dir.join("loop")).unwrap();
    std::os::unix::fs::symlink(dir.join("f.txt"), dir.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(dir.join("gone"), dir.join("broken")).unwrap();
    let l = list_dir(dir.to_string_lossy().to_string()).unwrap();
    assert_eq!(l.dirs, vec!["loop", "real"]);
    let names: Vec<&str> = l.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, vec!["f.txt", "link.txt"]);
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn list_dir_of_a_missing_folder_is_an_error_text() {
    let dir = unique_dir("nodir");
    assert!(!list_dir(dir.join("nope").to_string_lossy().to_string()).unwrap_err().is_empty());
    std::fs::remove_dir_all(dir).ok();
  }

  #[test]
  fn volumes_start_with_the_startup_disk_and_skip_the_entry_that_points_back() {
    let dir = unique_dir("vol");
    std::fs::create_dir(dir.join("Zeta")).unwrap();
    std::fs::create_dir(dir.join("alpha")).unwrap();
    std::os::unix::fs::symlink("/", dir.join("Macintosh HD")).unwrap();
    let v = volumes_in(&dir);
    let got: Vec<(String, String)> = v.into_iter().map(|v| (v.name, v.path)).collect();
    assert_eq!(got[0], ("Macintosh HD".to_string(), "/".to_string()));
    assert_eq!(got.len(), 3);
    assert_eq!(got[1].0, "alpha");
    assert_eq!(got[2].0, "Zeta");
    assert!(!got.iter().skip(1).any(|(_, p)| p == "/"));
    std::fs::remove_dir_all(dir).ok();
  }
}
