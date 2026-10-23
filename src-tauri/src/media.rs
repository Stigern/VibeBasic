//! MMControl and MediaPlayer files. The main window (the run session) opens a file by its path and gets a token; the form window
//! that plays it reads the bytes by that token (`media_read`, raw bytes, no JSON or base64), so the file never travels through an
//! event. `media_read` is the only app command the form windows may call (capabilities/run-windows.json), and it reads only the
//! files the main window opened.

use std::collections::hash_map::RandomState;
use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::State;

use crate::io_util::{off_main, open_read};

/// Bigger media files are refused (error 296 in the run session): the form window holds the whole file as a Blob.
pub const MAX_MEDIA_BYTES: u64 = 512 * 1024 * 1024;
/// Tokens kept at most (the oldest go first); a running program rarely has more than a few files open.
const MAX_OPEN: usize = 64;

#[derive(Default)]
struct Inner {
  files: HashMap<String, PathBuf>,
  order: VecDeque<String>,
}

#[derive(Default, Clone)]
pub struct MediaFiles(Arc<Mutex<Inner>>);

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 128 unguessable bits: RandomState is seeded from the OS's random source, once per process and per instance.
fn token() -> String {
  let n = SEQ.fetch_add(1, Ordering::Relaxed);
  let half = |salt: u64| {
    let mut h = RandomState::new().build_hasher();
    h.write_u64(n);
    h.write_u64(salt);
    h.finish()
  };
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
  format!("{:016x}{:016x}", half(nanos), half(!nanos))
}

impl MediaFiles {
  /// Errors: "53|File not found" (missing, or not a file), "296|..." (too big).
  pub fn open(&self, path: &str) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|_| "53|File not found".to_string())?;
    if !meta.is_file() {
      return Err("53|File not found".to_string());
    }
    if meta.len() > MAX_MEDIA_BYTES {
      return Err(format!("296|The file is too big to play (more than {} MB)", MAX_MEDIA_BYTES / (1024 * 1024)));
    }
    let t = token();
    let mut g = self.0.lock().unwrap();
    while g.order.len() >= MAX_OPEN {
      if let Some(old) = g.order.pop_front() {
        g.files.remove(&old);
      }
    }
    g.files.insert(t.clone(), PathBuf::from(path));
    g.order.push_back(t.clone());
    Ok(t)
  }

  pub fn read(&self, token: &str) -> Result<Vec<u8>, String> {
    let path = self.0.lock().unwrap().files.get(token).cloned().ok_or_else(|| "53|File not found".to_string())?;
    read_capped(&path)
  }

  pub fn close(&self, token: &str) {
    let mut g = self.0.lock().unwrap();
    g.files.remove(token);
    g.order.retain(|t| t != token);
  }
}

/// A regular file (a FIFO put in its place since media_open is refused), at most MAX_MEDIA_BYTES of it.
fn read_capped(path: &Path) -> Result<Vec<u8>, String> {
  let f = open_read(path).map_err(|_| "53|File not found".to_string())?;
  let mut bytes = Vec::new();
  f.take(MAX_MEDIA_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "53|File not found".to_string())?;
  if bytes.len() as u64 > MAX_MEDIA_BYTES {
    return Err("296|The file is too big to play".to_string());
  }
  Ok(bytes)
}

#[tauri::command]
pub async fn media_open(files: State<'_, MediaFiles>, path: String) -> Result<String, String> {
  let files = files.inner().clone();
  off_main(move || files.open(&path)).await
}

/// The bytes as a raw IPC response (an ArrayBuffer in the window). Read on the blocking pool: a big video must not freeze
/// the main thread while it loads.
#[tauri::command]
pub async fn media_read(files: State<'_, MediaFiles>, token: String) -> Result<tauri::ipc::Response, String> {
  let files = files.inner().clone();
  off_main(move || files.read(&token)).await.map(tauri::ipc::Response::new)
}

#[tauri::command]
pub fn media_close(files: State<'_, MediaFiles>, token: String) {
  files.close(&token);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_opened_files_can_be_read_and_closed_tokens_stop_working() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tada.wav");
    std::fs::write(&path, b"RIFF").unwrap();
    let m = MediaFiles::default();
    let t = m.open(path.to_str().unwrap()).unwrap();
    assert_eq!(t.len(), 32);
    assert_ne!(t, m.open(path.to_str().unwrap()).unwrap());
    assert_eq!(m.read(&t).unwrap(), b"RIFF");
    assert!(m.read("not-a-token").unwrap_err().starts_with("53|"));
    m.close(&t);
    assert!(m.read(&t).unwrap_err().starts_with("53|"));
    assert!(m.open(dir.path().join("missing.wav").to_str().unwrap()).unwrap_err().starts_with("53|"));
    assert!(m.open(dir.path().to_str().unwrap()).unwrap_err().starts_with("53|"));
  }

  #[test]
  fn at_most_max_open_tokens_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.mp3");
    std::fs::write(&path, b"x").unwrap();
    let m = MediaFiles::default();
    let first = m.open(path.to_str().unwrap()).unwrap();
    for _ in 0..MAX_OPEN {
      m.open(path.to_str().unwrap()).unwrap();
    }
    assert!(m.read(&first).is_err());
    assert_eq!(m.0.lock().unwrap().files.len(), MAX_OPEN);
  }

  /// M1: a FIFO swapped in for an opened media file is refused, not read forever.
  #[test]
  fn a_fifo_in_place_of_the_file_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("clip.mp4");
    std::fs::write(&path, b"x").unwrap();
    let m = MediaFiles::default();
    let t = m.open(path.to_str().unwrap()).unwrap();
    std::fs::remove_file(&path).unwrap();
    crate::io_util::tests::mkfifo(&path);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
      let _ = tx.send(m.read(&t));
    });
    let r = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("reading a FIFO blocked");
    assert!(r.unwrap_err().starts_with("53|"));
  }
}
