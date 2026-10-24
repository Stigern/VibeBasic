//! MSComm (MSCOMM32.OCX): serial ports with the serialport crate. The frontend (the run session in the main window) picks
//! the port ids. A reader thread per open port sends what arrives, and changes of the CTS / DSR / CD / RI lines, as
//! "vb:comm" events to the main window. The commands answer with an error "number|description" (MSComm error numbers:
//! 8002 Invalid port number, 8005 Port already open, 8018 Operation valid only when the port is open ...).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use tauri::{Emitter, State};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
/// How long one read waits; the thread checks the stop flag and the modem lines in between.
const READ_TIMEOUT: Duration = Duration::from_millis(20);
const LINES_EVERY: Duration = Duration::from_millis(100);

/// The modem status lines (CTSHolding, DSRHolding, CDHolding; RI raises comEvRing).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Lines {
  pub cts: bool,
  pub dsr: bool,
  pub cd: bool,
  pub ring: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CommEvent {
  /// Bytes arrived (base64).
  Data { id: u32, data: String },
  /// A modem line changed.
  Lines { id: u32, cts: bool, dsr: bool, cd: bool, ring: bool },
  /// Reading failed (the device was unplugged): the port is closed.
  Error { id: u32, number: i32, description: String },
}

pub type Emit = Arc<dyn Fn(CommEvent) + Send + Sync>;

/// MSComm Settings: "baud,parity,data,stop", e.g. "9600,n,8,1".
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Settings {
  pub baud: u32,
  pub parity: Parity,
  pub data_bits: DataBits,
  pub stop_bits: StopBits,
}

fn invalid_value() -> String {
  "380|Invalid property value".to_string()
}

/// Parses a Settings string as VB6 does: four comma-separated parts, parity n / e / o (m and s, mark and space, are not
/// supported by macOS serial drivers: 8009), data bits 5-8 (4: 8008), stop bits 1, 1.5 or 2 (1.5 is sent as 2).
pub fn parse_settings(s: &str) -> Result<Settings, String> {
  let parts: Vec<&str> = s.split(',').map(|p| p.trim()).collect();
  if parts.len() != 4 {
    return Err(invalid_value());
  }
  let baud: u32 = parts[0].parse().map_err(|_| invalid_value())?;
  if baud == 0 {
    return Err(invalid_value());
  }
  let parity = match parts[1].to_ascii_lowercase().as_str() {
    "n" => Parity::None,
    "e" => Parity::Even,
    "o" => Parity::Odd,
    "m" | "s" => return Err("8009|The default parameters are in error".to_string()),
    _ => return Err(invalid_value()),
  };
  let data_bits = match parts[2] {
    "5" => DataBits::Five,
    "6" => DataBits::Six,
    "7" => DataBits::Seven,
    "8" => DataBits::Eight,
    "4" => return Err("8008|The specified byte size is invalid".to_string()),
    _ => return Err(invalid_value()),
  };
  let stop_bits = match parts[3] {
    "1" => StopBits::One,
    "1.5" | "2" => StopBits::Two,
    _ => return Err(invalid_value()),
  };
  Ok(Settings { baud, parity, data_bits, stop_bits })
}

/// Handshaking: comNone 0, comXOnXoff 1, comRTS 2, comRTSXOnXOff 3 (one flow control at a time on macOS: RTS/CTS).
fn flow(handshaking: u8) -> FlowControl {
  match handshaking {
    1 => FlowControl::Software,
    2 | 3 => FlowControl::Hardware,
    _ => FlowControl::None,
  }
}

fn port_err(e: serialport::Error) -> String {
  use serialport::ErrorKind as K;
  match e.kind() {
    K::NoDevice => "8005|Port already open".to_string(),
    K::Io(std::io::ErrorKind::NotFound) => "8002|Invalid port number".to_string(),
    K::Io(std::io::ErrorKind::PermissionDenied) => "8010|The hardware is not available (locked by another device)".to_string(),
    K::InvalidInput => "8007|The device's baud rate is unsupported".to_string(),
    _ => format!("8015|Could not set comm state: {e}"),
  }
}

fn not_open() -> String {
  "8018|Operation valid only when the port is open".to_string()
}

/// Windows: CommPort n is "COMn", exactly as VB6, so the list (the frontend opens its n-th entry) runs from COM1 to the
/// highest port there is. A COMn in between that is not there fails when it is opened (8002).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_comm_list(available: &[String]) -> Vec<String> {
  let max = available
    .iter()
    .filter_map(|p| {
      let p = p.trim_start_matches(r"\\.\");
      p.get(..3).filter(|c| c.eq_ignore_ascii_case("COM"))?;
      p[3..].parse::<u32>().ok()
    })
    .max()
    .unwrap_or(0);
  (1..=max).map(|n| format!("COM{n}")).collect()
}

/// Linux: the USB serial adapters and CDC-ACM devices (/dev/ttyUSB*, /dev/ttyACM*) in name order, numbers by value
/// (ttyUSB2 before ttyUSB10). CommPort n is the n-th of them.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_comm_list(available: impl IntoIterator<Item = String>) -> Vec<String> {
  let mut out: Vec<String> = available.into_iter().filter(|p| p.starts_with("/dev/ttyUSB") || p.starts_with("/dev/ttyACM")).collect();
  let key = |p: &String| {
    let digits = p.len() - p.bytes().rev().take_while(u8::is_ascii_digit).count();
    (p[..digits].to_string(), p[digits..].parse::<u64>().unwrap_or(0))
  };
  out.sort_by_key(key);
  out.dedup();
  out
}

/// The serial ports: /dev/cu.* (the "call-up" devices a program opens), sorted by name. CommPort n is the n-th of them.
#[cfg(target_os = "macos")]
pub fn list_ports() -> Vec<String> {
  let mut out = available_names();
  // ports IOKit does not list (virtual ones): the /dev entries
  if let Ok(dir) = std::fs::read_dir("/dev") {
    for e in dir.flatten() {
      let name = e.file_name().to_string_lossy().to_string();
      if name.starts_with("cu.") {
        out.push(format!("/dev/{name}"));
      }
    }
  }
  out.retain(|p| p.starts_with("/dev/cu."));
  out.sort();
  out.dedup();
  out
}

fn available_names() -> Vec<String> {
  serialport::available_ports().map(|v| v.into_iter().map(|p| p.port_name).collect()).unwrap_or_default()
}

/// COM1 to the highest port Windows has (windows_comm_list).
#[cfg(windows)]
pub fn list_ports() -> Vec<String> {
  windows_comm_list(&available_names())
}

/// The ports the serialport crate finds plus the /dev entries it skips, filtered by linux_comm_list.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn list_ports() -> Vec<String> {
  let mut all = available_names();
  if let Ok(dir) = std::fs::read_dir("/dev") {
    all.extend(dir.flatten().map(|e| format!("/dev/{}", e.file_name().to_string_lossy())));
  }
  linux_comm_list(all)
}

/// Windows reports a missing port and a port in use alike (serialport's NoDevice): a port Windows does not list is 8002.
#[cfg(windows)]
fn open_err(path: &str, e: serialport::Error) -> String {
  let name = path.trim_start_matches(r"\\.\");
  if matches!(e.kind(), serialport::ErrorKind::NoDevice) && !available_names().iter().any(|p| p.trim_start_matches(r"\\.\").eq_ignore_ascii_case(name)) {
    return "8002|Invalid port number".to_string();
  }
  port_err(e)
}

#[cfg(not(windows))]
fn open_err(_path: &str, e: serialport::Error) -> String {
  port_err(e)
}

fn read_lines(p: &mut dyn SerialPort) -> Lines {
  Lines {
    cts: p.read_clear_to_send().unwrap_or(false),
    dsr: p.read_data_set_ready().unwrap_or(false),
    cd: p.read_carrier_detect().unwrap_or(false),
    ring: p.read_ring_indicator().unwrap_or(false),
  }
}

struct Port {
  /// Writes, line changes and settings go through this handle; the reader thread has its own clone.
  port: Mutex<Box<dyn SerialPort>>,
  stop: Arc<AtomicBool>,
  /// The reader thread: close waits for it, because its clone shares the port's exclusive lock (an open of the same device
  /// right after a close would fail with 8005 until the clone is gone).
  reader: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Port {
  /// Stops the reader thread and waits for it (at most one read timeout).
  fn stop_and_join(&self) {
    self.stop.store(true, Ordering::Relaxed);
    let h = self.reader.lock().unwrap().take();
    if let Some(h) = h.filter(|h| h.thread().id() != std::thread::current().id()) {
      let _ = h.join();
    }
  }
}

/// Every open port of the app (one running program at a time).
#[derive(Default, Clone)]
pub struct Ports(Arc<Mutex<HashMap<u32, Arc<Port>>>>);

impl Ports {
  fn get(&self, id: u32) -> Result<Arc<Port>, String> {
    self.0.lock().unwrap().get(&id).cloned().ok_or_else(not_open)
  }

  /// PortOpen = True: opens `path`, sets DTR and RTS, and starts the reader thread. Returns the modem lines.
  #[allow(clippy::too_many_arguments)]
  pub fn open(&self, id: u32, path: &str, settings: &str, handshaking: u8, dtr: bool, rts: bool, emit: Emit) -> Result<Lines, String> {
    if self.0.lock().unwrap().contains_key(&id) {
      return Err("8005|Port already open".to_string());
    }
    let s = parse_settings(settings)?;
    let mut port = serialport::new(path, s.baud)
      .parity(s.parity)
      .data_bits(s.data_bits)
      .stop_bits(s.stop_bits)
      .flow_control(flow(handshaking))
      .timeout(READ_TIMEOUT)
      .dtr_on_open(dtr)
      .open()
      .map_err(|e| open_err(path, e))?;
    let _ = port.write_data_terminal_ready(dtr);
    if flow(handshaking) != FlowControl::Hardware {
      let _ = port.write_request_to_send(rts);
    }
    let lines = read_lines(port.as_mut());
    let mut reader = port.try_clone().map_err(port_err)?;
    let stop = Arc::new(AtomicBool::new(false));
    let entry = Arc::new(Port { port: Mutex::new(port), stop: stop.clone(), reader: Mutex::new(None) });
    self.0.lock().unwrap().insert(id, entry.clone());
    let me = self.clone();
    let reader_thread = std::thread::spawn(move || {
      let mut buf = vec![0u8; 4096];
      let mut last = lines;
      let mut checked = Instant::now();
      while !stop.load(Ordering::Relaxed) {
        match reader.read(&mut buf) {
          Ok(0) => {}
          Ok(n) => emit(CommEvent::Data { id, data: B64.encode(&buf[..n]) }),
          Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted => {}
          Err(e) => {
            if !stop.load(Ordering::Relaxed) {
              me.0.lock().unwrap().remove(&id);
              emit(CommEvent::Error { id, number: 8020, description: format!("Error reading comm device: {e}") });
            }
            break;
          }
        }
        if checked.elapsed() >= LINES_EVERY {
          checked = Instant::now();
          let now = read_lines(reader.as_mut());
          if now != last {
            last = now;
            emit(CommEvent::Lines { id, cts: now.cts, dsr: now.dsr, cd: now.cd, ring: now.ring });
          }
        }
      }
    });
    *entry.reader.lock().unwrap() = Some(reader_thread);
    Ok(lines)
  }

  /// Settings or Handshaking changed while the port is open.
  pub fn configure(&self, id: u32, settings: &str, handshaking: u8) -> Result<(), String> {
    let s = parse_settings(settings)?;
    let p = self.get(id)?;
    let mut port = p.port.lock().unwrap();
    port.set_baud_rate(s.baud).map_err(port_err)?;
    port.set_parity(s.parity).map_err(port_err)?;
    port.set_data_bits(s.data_bits).map_err(port_err)?;
    port.set_stop_bits(s.stop_bits).map_err(port_err)?;
    port.set_flow_control(flow(handshaking)).map_err(port_err)?;
    Ok(())
  }

  /// Output: the whole buffer, written and flushed.
  pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
    let p = self.get(id)?;
    let mut port = p.port.lock().unwrap();
    // a write may time out part-way (the device is not reading): keep going while it makes progress
    let mut rest = data;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !rest.is_empty() {
      match port.write(rest) {
        Ok(0) => return Err("8015|Could not write to the comm device".to_string()),
        Ok(n) => rest = &rest[n..],
        Err(e) if (e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted) && Instant::now() < deadline => {}
        Err(e) => return Err(format!("8015|Could not write to the comm device: {e}")),
      }
    }
    let _ = port.flush();
    Ok(())
  }

  /// DTREnable, RTSEnable, Break (None: unchanged).
  pub fn set_lines(&self, id: u32, dtr: Option<bool>, rts: Option<bool>, brk: Option<bool>) -> Result<(), String> {
    let p = self.get(id)?;
    let mut port = p.port.lock().unwrap();
    if let Some(v) = dtr {
      port.write_data_terminal_ready(v).map_err(port_err)?;
    }
    if let Some(v) = rts {
      port.write_request_to_send(v).map_err(port_err)?;
    }
    match brk {
      Some(true) => port.set_break().map_err(port_err)?,
      Some(false) => port.clear_break().map_err(port_err)?,
      None => {}
    }
    Ok(())
  }

  /// PortOpen = False: the reader thread stops (within one read timeout) and the port closes; it can be opened again at once.
  pub fn close(&self, id: u32) {
    let p = self.0.lock().unwrap().remove(&id);   // not locked while waiting: the reader takes the lock when the device fails
    if let Some(p) = p {
      p.stop_and_join();
    }
  }

  /// The end of the program: every port closed.
  pub fn close_all(&self) {
    let all: Vec<Arc<Port>> = self.0.lock().unwrap().drain().map(|(_, p)| p).collect();
    for p in all {
      p.stop_and_join();
    }
  }
}

fn emitter(app: tauri::AppHandle) -> Emit {
  Arc::new(move |e: CommEvent| {
    let _ = app.emit_to("main", "vb:comm", e);
  })
}

/// Blocking serial work off the async runtime's threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("8015|{e}"))?
}

#[tauri::command]
pub async fn comm_list() -> Result<Vec<String>, String> {
  blocking(|| Ok(list_ports())).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn comm_open(app: tauri::AppHandle, ports: State<'_, Ports>, id: u32, path: String, settings: String, handshaking: u8, dtr: bool, rts: bool) -> Result<Lines, String> {
  let ports = ports.inner().clone();
  blocking(move || ports.open(id, &path, &settings, handshaking, dtr, rts, emitter(app))).await
}

#[tauri::command]
pub async fn comm_configure(ports: State<'_, Ports>, id: u32, settings: String, handshaking: u8) -> Result<(), String> {
  let ports = ports.inner().clone();
  blocking(move || ports.configure(id, &settings, handshaking)).await
}

/// `data` is base64.
#[tauri::command]
pub async fn comm_write(ports: State<'_, Ports>, id: u32, data: String) -> Result<(), String> {
  let bytes = B64.decode(data.as_bytes()).map_err(|_| "13|Type mismatch".to_string())?;
  let ports = ports.inner().clone();
  blocking(move || ports.write(id, &bytes)).await
}

#[tauri::command]
pub async fn comm_set_lines(ports: State<'_, Ports>, id: u32, dtr: Option<bool>, rts: Option<bool>, brk: Option<bool>) -> Result<(), String> {
  let ports = ports.inner().clone();
  blocking(move || ports.set_lines(id, dtr, rts, brk)).await
}

/// Waits (off the async runtime's threads) until the port is closed.
#[tauri::command]
pub async fn comm_close(ports: State<'_, Ports>, id: u32) -> Result<(), String> {
  let ports = ports.inner().clone();
  blocking(move || {
    ports.close(id);
    Ok(())
  })
  .await
}

/// End of the program (or a new run): closes every port.
#[tauri::command]
pub async fn comm_reset(ports: State<'_, Ports>) -> Result<(), String> {
  let ports = ports.inner().clone();
  blocking(move || {
    ports.close_all();
    Ok(())
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn settings_strings_parse_as_in_vb6() {
    assert_eq!(
      parse_settings("9600,n,8,1").unwrap(),
      Settings { baud: 9600, parity: Parity::None, data_bits: DataBits::Eight, stop_bits: StopBits::One }
    );
    assert_eq!(
      parse_settings(" 115200 , E , 7 , 2 ").unwrap(),
      Settings { baud: 115200, parity: Parity::Even, data_bits: DataBits::Seven, stop_bits: StopBits::Two }
    );
    assert_eq!(parse_settings("300,o,5,1.5").unwrap().stop_bits, StopBits::Two);
    assert_eq!(parse_settings("300,o,5,1.5").unwrap().parity, Parity::Odd);
    for bad in ["", "9600", "9600,n,8", "9600,n,8,1,1", "fast,n,8,1", "0,n,8,1", "9600,x,8,1", "9600,n,9,1", "9600,n,8,3"] {
      assert!(parse_settings(bad).unwrap_err().starts_with("380|"), "{bad}");
    }
    assert!(parse_settings("9600,m,8,1").unwrap_err().starts_with("8009|"));
    assert!(parse_settings("9600,n,4,1").unwrap_err().starts_with("8008|"));
  }

  #[test]
  fn comm_port_n_per_platform() {
    let win = windows_comm_list(&["COM3".into(), r"\\.\COM10".into(), "com1".into(), "LPT1".into()]);
    assert_eq!(win.len(), 10);
    assert_eq!((win[0].as_str(), win[2].as_str(), win[9].as_str()), ("COM1", "COM3", "COM10"));
    assert!(windows_comm_list(&[]).is_empty());
    let linux = linux_comm_list(["/dev/ttyUSB10", "/dev/ttyS0", "/dev/ttyUSB2", "/dev/ttyACM0", "/dev/ttyUSB2", "/dev/tty"].map(String::from));
    assert_eq!(linux, ["/dev/ttyACM0", "/dev/ttyUSB2", "/dev/ttyUSB10"]);
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn port_listing_is_a_sorted_list_of_call_up_devices() {
    let ports = list_ports();
    assert!(ports.iter().all(|p| p.starts_with("/dev/cu.")));
    let mut sorted = ports.clone();
    sorted.sort();
    assert_eq!(ports, sorted);
  }

  #[test]
  fn a_missing_port_is_8002_and_a_closed_one_8018() {
    let p = Ports::default();
    let emit: Emit = Arc::new(|_| {});
    let missing = if cfg!(windows) { "COM250" } else { "/dev/cu.no-such-port-vibebasic" };
    assert!(p.open(1, missing, "9600,n,8,1", 0, true, false, emit).unwrap_err().starts_with("8002|"));
    assert!(p.write(1, b"x").unwrap_err().starts_with("8018|"));
    assert!(p.set_lines(1, Some(true), None, None).unwrap_err().starts_with("8018|"));
    p.close(1);
    p.close_all();
  }

  /// MSComm1.PortOpen = False: MSComm1.PortOpen = True at once (reconnect code): the reader thread's clone of the port holds
  /// the exclusive lock until it has stopped, so close (and close_all) return only once the thread has ended.
  #[cfg(unix)]
  #[test]
  fn close_waits_for_the_reader_thread() {
    for all in [false, true] {
      let (master, _slave) = serialport::TTYPort::pair().expect("pty");
      let stop = Arc::new(AtomicBool::new(false));
      let done = Arc::new(AtomicBool::new(false));
      let (s2, d2) = (stop.clone(), done.clone());
      let reader = std::thread::spawn(move || {
        while !s2.load(Ordering::Relaxed) {
          std::thread::sleep(READ_TIMEOUT);
        }
        std::thread::sleep(Duration::from_millis(10));   // the clone is dropped as the thread ends
        d2.store(true, Ordering::Relaxed);
      });
      let p = Ports::default();
      p.0.lock().unwrap().insert(1, Arc::new(Port { port: Mutex::new(Box::new(master)), stop, reader: Mutex::new(Some(reader)) }));
      if all { p.close_all() } else { p.close(1) }
      assert!(done.load(Ordering::Relaxed), "close_all {all}");
      assert!(p.get(1).is_err());
    }
  }
}
