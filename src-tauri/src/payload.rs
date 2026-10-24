//! The project a made app carries on Windows and Linux: appended to the executable as `[payload][length][MAGIC]`. PE and
//! ELF loaders ignore data after the image, so the made app is still the same program, it only finds its project here.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// The last 16 bytes of an executable that carries a project.
pub const MAGIC: [u8; 16] = *b"VibeBasicPrj\x00\x00\x00\x01";
/// The payload length (u64, little endian) and the magic.
pub const TRAILER_LEN: u64 = 8 + MAGIC.len() as u64;

/// Where the payload of `f` starts and how long it is, None when `f` has no (valid) trailer.
pub fn find<F: Read + Seek>(f: &mut F) -> io::Result<Option<(u64, u64)>> {
  let size = f.seek(SeekFrom::End(0))?;
  if size < TRAILER_LEN {
    return Ok(None);
  }
  f.seek(SeekFrom::Start(size - TRAILER_LEN))?;
  let mut t = [0u8; TRAILER_LEN as usize];
  f.read_exact(&mut t)?;
  if t[8..] != MAGIC {
    return Ok(None);
  }
  let len = u64::from_le_bytes(t[..8].try_into().expect("8 bytes"));
  Ok((len <= size - TRAILER_LEN).then(|| (size - TRAILER_LEN - len, len)))
}

/// The payload of the file at `path`; None when it has none (a plain executable, or VibeBasic itself).
pub fn read_file(path: &Path) -> io::Result<Option<Vec<u8>>> {
  let mut f = File::open(path)?;
  let Some((start, len)) = find(&mut f)? else { return Ok(None) };
  f.seek(SeekFrom::Start(start))?;
  let mut buf = vec![0u8; usize::try_from(len).map_err(|_| io::Error::other("payload too large"))?];
  f.read_exact(&mut buf)?;
  Ok(Some(buf))
}

/// Whether the file at `path` carries a payload (false when it can't be read).
pub fn has_payload(path: &Path) -> bool {
  File::open(path).and_then(|mut f| find(&mut f)).ok().flatten().is_some()
}

/// `bytes` without a payload and trailer at the end (unchanged when there is none).
pub fn strip(bytes: &[u8]) -> &[u8] {
  match find(&mut io::Cursor::new(bytes)) {
    Ok(Some((start, _))) => &bytes[..start as usize],
    _ => bytes,
  }
}

/// Appends `payload` and its trailer to `exe`.
pub fn append(exe: &mut Vec<u8>, payload: &[u8]) {
  exe.extend_from_slice(payload);
  exe.extend_from_slice(&(payload.len() as u64).to_le_bytes());
  exe.extend_from_slice(&MAGIC);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn append_then_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut exe = b"MZ plain program".to_vec();
    append(&mut exe, "{\"name\":\"Kalk\"} æøå".as_bytes());
    let p = dir.path().join("Kalk.exe");
    std::fs::write(&p, &exe).unwrap();
    assert!(has_payload(&p));
    assert_eq!(read_file(&p).unwrap().unwrap(), "{\"name\":\"Kalk\"} æøå".as_bytes());
    assert_eq!(strip(&exe), b"MZ plain program");
  }

  #[test]
  fn plain_executable_has_none() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("plain.exe");
    std::fs::write(&p, b"MZ\x90\x00 some program bytes that end in no trailer at all").unwrap();
    assert!(!has_payload(&p));
    assert_eq!(read_file(&p).unwrap(), None);
    std::fs::write(&p, b"").unwrap();
    assert!(!has_payload(&p));
    assert!(!has_payload(&dir.path().join("missing")));
    assert_eq!(strip(b"abc"), b"abc");
  }

  #[test]
  fn a_length_beyond_the_file_is_no_payload() {
    let mut exe = b"xx".to_vec();
    exe.extend_from_slice(&1000u64.to_le_bytes());
    exe.extend_from_slice(&MAGIC);
    assert_eq!(find(&mut io::Cursor::new(&exe)).unwrap(), None);
    assert_eq!(strip(&exe), &exe[..]);
  }

  #[test]
  fn appending_again_after_strip_replaces_the_project() {
    let mut exe = b"ELF".to_vec();
    append(&mut exe, b"one");
    let mut again = strip(&exe).to_vec();
    append(&mut again, b"");
    assert_eq!(strip(&again), b"ELF");
    assert_eq!(find(&mut io::Cursor::new(&again)).unwrap(), Some((3, 0)));
  }
}
