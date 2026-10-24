//! Helpers for the commands that touch the file system, SQLite or other processes.
//!
//! - `off_main`: a plain `#[tauri::command]` runs on the macOS main thread, so a slow disk, a big copy or a FIFO would freeze
//!   every window. The commands are `async` and run their blocking body on the blocking thread pool through this.
//! - `open_regular`: opens a file without blocking on a FIFO or a device (O_NONBLOCK on Unix) and refuses anything that is
//!   not a regular file, so `Open "/tmp/fifo" For Input` is an error instead of a hang. Windows has no FIFOs in the file
//!   system (a named pipe that is busy fails to open rather than wait), so there it only checks the kind of file.

use std::fs::{File, OpenOptions};
use std::io::{Error, ErrorKind};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Runs blocking work on the blocking thread pool. A panic in it is "51|Internal error".
pub async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("51|Internal error: {e}"))?
}

/// The error `open_regular` gives for a FIFO, a socket or a device.
pub fn not_regular() -> Error {
  Error::new(ErrorKind::InvalidInput, "not a regular file")
}

/// Opens `path` with `opts` (plus O_NONBLOCK, which a regular file ignores) and checks that it is a regular file.
/// A FIFO opened for reading without a writer would otherwise block in open(2), and one opened for writing without a
/// reader fails here (ENXIO) instead.
pub fn open_regular(path: &Path, opts: &OpenOptions) -> std::io::Result<File> {
  #[allow(unused_mut)]
  let mut o = opts.clone();
  #[cfg(unix)]
  o.custom_flags(libc::O_NONBLOCK);
  let f = o.open(path)?;
  if !f.metadata()?.is_file() {
    return Err(not_regular());
  }
  Ok(f)
}

/// Opens a regular file for reading.
pub fn open_read(path: &Path) -> std::io::Result<File> {
  let mut o = OpenOptions::new();
  o.read(true);
  open_regular(path, &o)
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
  use super::*;

  /// A FIFO at `path` (mkfifo).
  pub fn mkfifo(path: &Path) {
    let st = std::process::Command::new("mkfifo").arg(path).status().unwrap();
    assert!(st.success());
  }

  #[test]
  fn a_fifo_is_refused_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("pipe");
    mkfifo(&p);
    let (tx, rx) = std::sync::mpsc::channel();
    let q = p.clone();
    std::thread::spawn(move || {
      let _ = tx.send(open_read(&q).map(|_| ()).map_err(|e| e.kind()));
    });
    let r = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("opening a FIFO blocked");
    assert_eq!(r, Err(ErrorKind::InvalidInput));
    let mut w = OpenOptions::new();
    w.write(true);
    assert!(open_regular(&p, &w).is_err());
    std::fs::write(dir.path().join("f"), "x").unwrap();
    assert!(open_read(&dir.path().join("f")).is_ok());
  }
}
