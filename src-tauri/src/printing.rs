//! Printing for a running program (Printer, Printers, PrintForm, CommonDialog.ShowPrinter): the printers CUPS knows (`lpstat`),
//! and the macOS print dialog for a print window. The main window renders the pages into that window (vbdialog-print-<n>) and
//! asks for the dialog here: `window.print()` does nothing in WKWebView, so the webview prints through NSPrintOperation
//! (Tauri's `print`), as a sheet on the print window. The user picks the printer there; "Save as PDF" comes with it.

use serde::Serialize;
use std::process::Command;
use tauri::Manager;

/// The prefix of a print window's label: the only windows `print_window` prints.
const PRINT_WINDOW: &str = "vbdialog-print-";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
  /// The CUPS queue name (Printer.DeviceName).
  pub name: String,
  /// The device URI (Printer.Port).
  pub port: String,
  pub is_default: bool,
}

/// English output whatever the user's language (an app started from Finder has no LANG).
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

/// The installed printers (empty when there are none, or no CUPS).
#[tauri::command]
pub async fn printer_list() -> Result<Vec<PrinterInfo>, String> {
  crate::io_util::off_main(|| Ok(parse_printers(&lpstat("-v"), &lpstat("-d")))).await
}

/// The macOS print dialog for a print window of the running program.
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
}
