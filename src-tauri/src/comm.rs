//! MSComm (MSCOMM32.OCX): serial ports with the serialport crate. The frontend (the run session in the main window) picks
//! the port ids. A reader thread per open port sends what arrives, and changes of the CTS / DSR / CD / RI lines, as
//! "vb:comm" events to the main window. The commands answer with an error "number|description" (MSComm error numbers:
//! 8002 Invalid port number, 8005 Port already open, 8018 Operation valid only when the port is open ...).

use std::collections::HashMap;
use std::io::Read;
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
/// At most this many Data events of one port are on their way to the window, not yet acknowledged (comm_ack); the reader
/// stops reading until an ack comes, so a fast device cannot flood the webview.
const DATA_WINDOW: usize = 8;
/// Output fails (8015) when the device has taken no byte for this long.
const WRITE_STALL: Duration = if cfg!(test) { Duration::from_millis(300) } else { Duration::from_secs(10) };
/// Output goes to the device in pieces of at most this many bytes (see Ports::write).
const WRITE_PIECE: usize = 256;

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
  /// Writes, line changes and settings go through this handle; the reader thread has its own clone. Close takes it out
  /// (the device closes then, not whenever the last command using the port lets go of it).
  port: Mutex<Option<Box<dyn SerialPort>>>,
  stop: Arc<AtomicBool>,
  /// The reader thread: close waits for it, because its clone shares the port's exclusive lock (an open of the same device
  /// right after a close would fail with 8005 until the clone is gone).
  reader: Mutex<Option<std::thread::JoinHandle<()>>>,
  window: Arc<Window>,
}

/// The Data events of a port sent to the window and not yet acknowledged (comm_ack).
#[derive(Default)]
struct Window {
  sent: Mutex<usize>,
  acked: std::sync::Condvar,
}

impl Window {
  /// Waits at most `t` for room for one more Data event.
  fn room(&self, t: Duration) -> bool {
    let g = self.sent.lock().unwrap();
    let (g, _) = self.acked.wait_timeout_while(g, t, |n| *n >= DATA_WINDOW).unwrap();
    *g < DATA_WINDOW
  }

  fn sent(&self) {
    *self.sent.lock().unwrap() += 1;
  }

  fn ack(&self) {
    let mut g = self.sent.lock().unwrap();
    *g = g.saturating_sub(1);
    self.acked.notify_one();
  }
}

impl Port {
  /// Stops the reader thread and a write under way, waits for both (about one read timeout), and closes the port.
  fn stop_and_join(&self) {
    self.stop.store(true, Ordering::Relaxed);
    // a write sees the stop flag after its current piece; one stuck in the final flush (a device holding CTS low) closes
    // the port itself when it returns (with_port)
    let until = Instant::now() + Duration::from_secs(1);
    let mut port = loop {
      if let Ok(g) = self.port.try_lock() {
        break Some(g);
      }
      if Instant::now() >= until {
        break None;
      }
      std::thread::sleep(Duration::from_millis(5));
    };
    if let Some(g) = port.as_mut() {
      discard(g);
    }
    drop(port);
    let h = self.reader.lock().unwrap().take();
    if let Some(h) = h.filter(|h| h.thread().id() != std::thread::current().id()) {
      let _ = h.join();
    }
  }
}

/// Closes the port's handle. VB6 clears both buffers on close; output left queued would also make the last close of the
/// device (maybe the reader's clone) wait until the device took it.
fn discard(port: &mut Option<Box<dyn SerialPort>>) {
  if let Some(p) = port.take() {
    let _ = p.clear(serialport::ClearBuffer::All);
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
    self.start(id, port, lines, emit)?;
    Ok(lines)
  }

  /// Keeps the open `port` as `id` and starts its reader thread.
  fn start(&self, id: u32, port: Box<dyn SerialPort>, lines: Lines, emit: Emit) -> Result<(), String> {
    let mut reader = port.try_clone().map_err(port_err)?;
    let stop = Arc::new(AtomicBool::new(false));
    let window = Arc::new(Window::default());
    let entry = Arc::new(Port { port: Mutex::new(Some(port)), stop: stop.clone(), reader: Mutex::new(None), window: window.clone() });
    self.0.lock().unwrap().insert(id, entry.clone());
    let me = self.clone();
    let reader_thread = std::thread::spawn(move || {
      let mut buf = vec![0u8; 4096];
      let mut last = lines;
      let mut checked = Instant::now();
      while !stop.load(Ordering::Relaxed) {
        // a full window: nothing is read (the driver buffers, or flow control holds the device) until the frontend acks
        if window.room(READ_TIMEOUT) {
          match reader.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
              window.sent();
              emit(CommEvent::Data { id, data: B64.encode(&buf[..n]) });
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
              if !stop.load(Ordering::Relaxed) {
                me.0.lock().unwrap().remove(&id);
                emit(CommEvent::Error { id, number: 8020, description: format!("Error reading comm device: {e}") });
              }
              break;
            }
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
    Ok(())
  }

  /// Runs `f` with the open port `id` (8018 when it is not open, or was closed meanwhile).
  fn with_port<T>(&self, id: u32, f: impl FnOnce(&Port, &mut dyn SerialPort) -> Result<T, String>) -> Result<T, String> {
    let p = self.get(id)?;
    let mut g = p.port.lock().unwrap();
    let port = g.as_mut().ok_or_else(not_open)?;
    let r = f(&p, port.as_mut());
    if p.stop.load(Ordering::Relaxed) {
      discard(&mut g);   // closed while `f` ran: the device closes now
    }
    r
  }

  /// Settings or Handshaking changed while the port is open.
  pub fn configure(&self, id: u32, settings: &str, handshaking: u8) -> Result<(), String> {
    let s = parse_settings(settings)?;
    self.with_port(id, |_, port| {
      port.set_baud_rate(s.baud).map_err(port_err)?;
      port.set_parity(s.parity).map_err(port_err)?;
      port.set_data_bits(s.data_bits).map_err(port_err)?;
      port.set_stop_bits(s.stop_bits).map_err(port_err)?;
      port.set_flow_control(flow(handshaking)).map_err(port_err)?;
      Ok(())
    })
  }

  /// Output: the whole buffer, written and flushed. PortOpen = False stops it (VB6 clears the transmit buffer); it fails
  /// with 8015 when the device has taken nothing for WRITE_STALL.
  pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
    self.with_port(id, |p, port| {
      let mut rest = data;
      let mut progress = Instant::now();
      while !rest.is_empty() {
        if p.stop.load(Ordering::Relaxed) {
          return Err("8015|Could not write to the comm device: the port was closed".to_string());
        }
        // small pieces: a tty write blocks until all of it is queued, and the stop flag is only seen in between
        match port.write(&rest[..rest.len().min(WRITE_PIECE)]) {
          Ok(0) => return Err("8015|Could not write to the comm device".to_string()),
          Ok(n) => {
            rest = &rest[n..];
            progress = Instant::now();
          }
          // timed out (the device is not reading): keep going until it has taken nothing for WRITE_STALL
          Err(e) if (e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted) && progress.elapsed() < WRITE_STALL => {}
          Err(e) => return Err(format!("8015|Could not write to the comm device: {e}")),
        }
      }
      let _ = port.flush();
      Ok(())
    })
  }

  /// DTREnable, RTSEnable, Break (None: unchanged).
  pub fn set_lines(&self, id: u32, dtr: Option<bool>, rts: Option<bool>, brk: Option<bool>) -> Result<(), String> {
    self.with_port(id, |_, port| {
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
    })
  }

  /// The frontend has handled one Data event of port `id`.
  pub fn ack(&self, id: u32) {
    if let Ok(p) = self.get(id) {
      p.window.ack();
    }
  }

  /// PortOpen = False: a write under way and the reader thread stop (within about one read timeout) and the port closes;
  /// it can be opened again at once.
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

/// The window has handled a Data event of port `id` (the reader may send one more).
#[tauri::command]
pub fn comm_ack(ports: State<'_, Ports>, id: u32) {
  ports.ack(id);
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
  use std::io::Write;

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
      p.0.lock().unwrap().insert(1, Arc::new(Port { port: Mutex::new(Some(Box::new(master))), stop, reader: Mutex::new(Some(reader)), window: Default::default() }));
      if all { p.close_all() } else { p.close(1) }
      assert!(done.load(Ordering::Relaxed), "close_all {all}");
      assert!(p.get(1).is_err());
    }
  }

  /// A device that sends fast does not flood the window: at most DATA_WINDOW Data events wait for the frontend's ack.
  /// (A pty pair stands in for the device: macOS cannot set a pty's baud rate, so it is started directly, not opened.)
  #[cfg(unix)]
  #[test]
  fn data_events_wait_for_the_frontends_ack() {
    let (mut master, mut slave) = serialport::TTYPort::pair().expect("pty");
    slave.set_timeout(READ_TIMEOUT).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let emit: Emit = Arc::new(move |e| {
      let _ = tx.send(e);
    });
    let p = Ports::default();
    p.start(1, Box::new(slave), Lines::default(), emit).unwrap();
    let total = 256 * 1024;
    let writer = std::thread::spawn(move || {
      let chunk = [5u8; 1024];
      let mut sent = 0;
      while sent < total {
        match master.write(&chunk) {
          Ok(n) => sent += n,
          Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
          Err(_) => break,
        }
      }
      master
    });
    std::thread::sleep(Duration::from_millis(500));
    let (mut got, mut events) = (0usize, 0usize);
    while let Ok(e) = rx.try_recv() {
      if let CommEvent::Data { data, .. } = e {
        got += B64.decode(data).unwrap().len();
        events += 1;
      }
    }
    assert!(events <= DATA_WINDOW, "{events} unacknowledged Data events");
    while got < total {
      p.ack(1);
      if let CommEvent::Data { data, .. } = rx.recv_timeout(Duration::from_secs(5)).expect("no data") {
        got += B64.decode(data).unwrap().len();
      }
    }
    assert_eq!(got, total);
    drop(writer.join().unwrap());
    p.close_all();
  }

  /// Runs `f` on a thread; the receiver gets its result.
  fn spawn<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> std::sync::mpsc::Receiver<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
      let _ = tx.send(f());
    });
    rx
  }

  /// PortOpen = False while an Output waits on a device that does not read: the write ends at once and close returns
  /// only when the port is really closed (so PortOpen = True right after works).
  #[cfg(unix)]
  #[test]
  fn close_interrupts_a_blocked_write() {
    let (_master, mut slave) = serialport::TTYPort::pair().expect("pty");
    slave.set_timeout(READ_TIMEOUT).unwrap();
    let p = Ports::default();
    p.start(1, Box::new(slave), Lines::default(), Arc::new(|_| {})).unwrap();
    let w = p.clone();
    let write = spawn(move || w.write(1, &vec![1u8; 1024 * 1024]));
    std::thread::sleep(Duration::from_millis(100));
    assert!(write.try_recv().is_err(), "the write should wait on the full pty");
    let started = Instant::now();
    p.close(1);
    let r = write.recv_timeout(Duration::from_millis(100)).expect("close did not end the write");
    assert!(r.unwrap_err().starts_with("8015|"));
    assert!(started.elapsed() < WRITE_STALL, "close took {:?}", started.elapsed());
  }

  /// The write timeout is a stall timeout: a slow device that keeps taking bytes gets all of them, however long it takes.
  #[cfg(unix)]
  #[test]
  fn a_slow_write_that_progresses_does_not_time_out() {
    let (mut master, mut slave) = serialport::TTYPort::pair().expect("pty");
    slave.set_timeout(READ_TIMEOUT).unwrap();
    master.set_timeout(READ_TIMEOUT).unwrap();
    let p = Ports::default();
    p.start(1, Box::new(slave), Lines::default(), Arc::new(|_| {})).unwrap();
    let total = 32 * 1024;
    let reader = spawn(move || {
      let mut buf = [0u8; 1024];
      let mut got = 0;
      while got < total {
        if let Ok(n) = master.read(&mut buf) {
          got += n;
        }
        std::thread::sleep(Duration::from_millis(40));
      }
      got
    });
    let started = Instant::now();
    p.write(1, &vec![2u8; total]).unwrap();
    assert!(started.elapsed() > WRITE_STALL, "the write was too fast to test the stall timeout ({:?})", started.elapsed());
    assert_eq!(reader.recv_timeout(Duration::from_secs(10)).unwrap(), total);
    p.close_all();
  }
}
