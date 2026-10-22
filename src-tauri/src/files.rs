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
}
