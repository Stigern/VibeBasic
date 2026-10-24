//! Printing for a running program (Printer, Printers, PrintForm, CommonDialog.ShowPrinter): the installed printers (CUPS's
//! `lpstat` on macOS and Linux, EnumPrintersW on Windows), and the system print dialog for a print window. The main window
//! renders the pages into that window (vbdialog-print-<n>) and asks for the dialog here: `window.print()` does nothing in
//! WKWebView, so the webview prints through Tauri's `print` (NSPrintOperation as a sheet on macOS, WebView2's print on
//! Windows, WebKitGTK's print dialog on Linux). The user picks the printer there; "Save as PDF" comes with it on macOS.

use serde::Serialize;
#[cfg(not(windows))]
use std::process::Command;
use tauri::Manager;

/// The prefix of a print window's label: the only windows `print_window` prints.
const PRINT_WINDOW: &str = "vbdialog-print-";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
  /// The CUPS queue name, or the Windows printer name (Printer.DeviceName).
  pub name: String,
  /// The device URI, or the Windows port name such as "USB001" (Printer.Port).
  pub port: String,
  pub is_default: bool,
}

/// English output whatever the user's language (an app started from Finder has no LANG).
#[cfg(not(windows))]
fn lpstat(arg: &str) -> String {
  Command::new("lpstat")
    .arg(arg)
    .env("LANG", "en_US.UTF-8")
    .env("LC_ALL", "en_US.UTF-8")
    .output()
    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    .unwrap_or_default()
}

/// `lpstat -v` ("device for NAME: URI" per printer) and `lpstat -d` ("system default destination: NAME").
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_printers(devices: &str, default: &str) -> Vec<PrinterInfo> {
  let def = default.lines().find_map(|l| l.trim().strip_prefix("system default destination: ")).map(str::trim);
  devices
    .lines()
    .filter_map(|l| {
      let rest = l.trim().strip_prefix("device for ")?;
      let (name, uri) = rest.split_once(':')?;
      let name = name.trim().to_string();
      Some(PrinterInfo { is_default: def == Some(name.as_str()), port: uri.trim().to_string(), name })
    })
    .collect()
}

/// The printers Windows lists, as (name, port), and the default printer's name: PrinterInfo values.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn printers_from(list: Vec<(String, String)>, default: Option<&str>) -> Vec<PrinterInfo> {
  list.into_iter().map(|(name, port)| PrinterInfo { is_default: default.is_some_and(|d| d.eq_ignore_ascii_case(&name)), name, port }).collect()
}

#[cfg(windows)]
fn wide_str(p: *const u16) -> String {
  if p.is_null() {
    return String::new();
  }
  // SAFETY: a NUL-terminated UTF-16 string from the spooler, inside the buffer EnumPrintersW / GetDefaultPrinterW filled.
  unsafe {
    let len = (0..).take_while(|&i| *p.add(i) != 0).count();
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
  }
}

/// The local printers and the connections to shared ones (EnumPrintersW, level 2), and the default (GetDefaultPrinterW).
#[cfg(windows)]
fn windows_printers() -> Vec<PrinterInfo> {
  use windows_sys::Win32::Graphics::Printing::{EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_2W};
  let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
  let (mut needed, mut count) = (0u32, 0u32);
  let mut list = vec![];
  // SAFETY: the first call only asks for the size; the second fills a buffer of that size (u64s keep it aligned for the
  // PRINTER_INFO_2W records at its start, whose strings point into the same buffer).
  unsafe {
    EnumPrintersW(flags, std::ptr::null(), 2, std::ptr::null_mut(), 0, &mut needed, &mut count);
    if needed > 0 {
      let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
      if EnumPrintersW(flags, std::ptr::null(), 2, buf.as_mut_ptr().cast(), needed, &mut needed, &mut count) != 0 {
        let infos = std::slice::from_raw_parts(buf.as_ptr().cast::<PRINTER_INFO_2W>(), count as usize);
        list = infos.iter().map(|i| (wide_str(i.pPrinterName), wide_str(i.pPortName))).collect();
      }
    }
  }
  let mut len = 0u32;
  // SAFETY: as above, size first, then a buffer of that many UTF-16 units.
  let default = unsafe {
    GetDefaultPrinterW(std::ptr::null_mut(), &mut len);
    let mut name = vec![0u16; len as usize + 1];
    (len > 0 && GetDefaultPrinterW(name.as_mut_ptr(), &mut len) != 0).then(|| wide_str(name.as_ptr()))
  };
  printers_from(list, default.as_deref())
}

/// The installed printers (empty when there are none, or no CUPS).
#[tauri::command]
pub async fn printer_list() -> Result<Vec<PrinterInfo>, String> {
  #[cfg(windows)]
  return crate::io_util::off_main(|| Ok(windows_printers())).await;
  #[cfg(not(windows))]
  crate::io_util::off_main(|| Ok(parse_printers(&lpstat("-v"), &lpstat("-d")))).await
}

/// The system print dialog for a print window of the running program.
#[tauri::command]
pub fn print_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
  if !label.starts_with(PRINT_WINDOW) {
    return Err(format!("{label} is not a print window"));
  }
  let w = app.get_webview_window(&label).ok_or_else(|| format!("no window {label}"))?;
  w.print().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lpstat_output_gives_the_printers_and_the_default() {
    let devices = "device for HP_LaserJet: dnssd://HP%20LaserJet._ipp._tcp.local./?uuid=1\ndevice for Office: ipp://10.0.0.5/ipp/print\n";
    let p = parse_printers(devices, "system default destination: Office\n");
    assert_eq!(p.len(), 2);
    assert_eq!(p[0], PrinterInfo { name: "HP_LaserJet".into(), port: "dnssd://HP%20LaserJet._ipp._tcp.local./?uuid=1".into(), is_default: false });
    assert!(p[1].is_default);
    assert!(parse_printers("", "no system default destination\n").is_empty());
  }

  #[test]
  fn windows_printer_list_marks_the_default() {
    let p = printers_from(vec![("Microsoft Print to PDF".into(), "PORTPROMPT:".into()), ("HP LaserJet".into(), "USB001".into())], Some("hp laserjet"));
    assert_eq!(p[0], PrinterInfo { name: "Microsoft Print to PDF".into(), port: "PORTPROMPT:".into(), is_default: false });
    assert!(p[1].is_default);
    assert!(!printers_from(vec![("A".into(), "LPT1:".into())], None)[0].is_default);
  }
}
