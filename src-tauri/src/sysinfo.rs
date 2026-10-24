//! SysInfo (SYSINFO.OCX): the OS version, the main screen's visible frame (the work area, in points, from Tauri's monitor
//! API) and the power state. Unknown battery values are VB6's: 255 (percent, AC status), -1 (times); a machine without a
//! battery reports BatteryStatus 128 (no system battery) as Windows does.
//!
//! - macOS: SystemVersion.plist and `pmset -g batt`.
//! - Windows: RtlGetVersion and GetSystemPowerStatus (whose values are VB6's own).
//! - Linux: the kernel release (/proc/sys/kernel/osrelease) and /sys/class/power_supply.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Power {
  /// 0 offline (battery), 1 online (AC), 255 unknown.
  pub ac_status: i32,
  /// 0-100, 255 unknown.
  pub battery_life_percent: i32,
  /// Seconds left on battery, -1 unknown (also while on AC).
  pub battery_life_time: i32,
  /// Seconds a full battery lasts, -1 unknown (pmset does not tell).
  pub battery_full_time: i32,
  /// Flags: 1 high, 2 low, 4 critical, 8 charging, 128 no system battery, 255 unknown.
  pub battery_status: i32,
}

impl Power {
  pub fn unknown() -> Self {
    Power { ac_status: 255, battery_life_percent: 255, battery_life_time: -1, battery_full_time: -1, battery_status: 255 }
  }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SysInfo {
  pub os_version: String,
  pub os_build: String,
  /// The main screen's visible frame (without the menu bar and the Dock), in points; 0 x 0 when unknown.
  pub work_left: f64,
  pub work_top: f64,
  pub work_width: f64,
  pub work_height: f64,
  #[serde(flatten)]
  pub power: Power,
}

/// The output of `pmset -g batt`:
/// ```text
/// Now drawing from 'Battery Power'
///  -InternalBattery-0 (id=4653155)<TAB>76%; discharging; 4:12 remaining present: true
/// ```
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_pmset(out: &str) -> Power {
  let mut p = Power::unknown();
  if out.contains("'AC Power'") {
    p.ac_status = 1;
  } else if out.contains("'Battery Power'") {
    p.ac_status = 0;
  }
  let Some(line) = out.lines().find(|l| l.contains("InternalBattery")) else {
    if p.ac_status != 255 {
      p.battery_status = 128;   // a desktop Mac: on AC, no battery
    }
    return p;
  };
  let percent = line.split('%').next().and_then(|s| s.rsplit(|c: char| !c.is_ascii_digit()).next()).and_then(|s| s.parse::<i32>().ok());
  if let Some(pc) = percent {
    p.battery_life_percent = pc.clamp(0, 100);
  }
  let fields: Vec<String> = line.split(';').map(|s| s.trim().to_ascii_lowercase()).collect();
  let state = fields.get(1).cloned().unwrap_or_default();
  let charging = state == "charging" || state == "finishing charge";
  if p.ac_status == 0 {
    // "4:12 remaining" (not "(no estimate)")
    if let Some(t) = fields.get(2).and_then(|f| f.split_whitespace().next()).and_then(|hm| {
      let (h, m) = hm.split_once(':')?;
      Some(h.parse::<i32>().ok()? * 3600 + m.parse::<i32>().ok()? * 60)
    }) {
      p.battery_life_time = t;
    }
  }
  if let Some(pc) = percent {
    let level = if pc < 5 { 2 | 4 } else if pc < 33 { 2 } else if pc > 66 { 1 } else { 0 };
    p.battery_status = level | if charging { 8 } else { 0 };
  }
  p
}

/// GetSystemPowerStatus's SYSTEM_POWER_STATUS: ACLineStatus, BatteryFlag and BatteryLifePercent are VB6's values as they
/// are; the times are seconds, with u32::MAX (-1) for unknown.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn power_from_windows(ac_line: u8, battery_flag: u8, percent: u8, life_secs: u32, full_secs: u32) -> Power {
  let secs = |s: u32| if s == u32::MAX { -1 } else { s.min(i32::MAX as u32) as i32 };
  Power {
    ac_status: ac_line as i32,
    battery_life_percent: percent as i32,
    battery_life_time: secs(life_secs),
    battery_full_time: secs(full_secs),
    battery_status: battery_flag as i32,
  }
}

/// One /sys/class/power_supply/<name> folder: its attribute files ("type", "online", "capacity", "status" ...), trimmed.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub type Supply = std::collections::HashMap<String, String>;

/// The power state from the Linux power supplies. AC is a "Mains" supply that is online (or, without one, a battery that is
/// not discharging); the system batteries are the "Battery" supplies whose scope is not "Device" (a mouse, a headset).
/// Times come from energy_now / power_now (µWh, µW) or charge_now / current_now (µAh, µA) while discharging.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn power_from_supplies(supplies: &[Supply]) -> Power {
  let get = |s: &Supply, k: &str| s.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
  let num = |s: &Supply, k: &str| get(s, k).parse::<f64>().ok();
  let mains: Vec<&Supply> = supplies.iter().filter(|s| get(s, "type") == "Mains").collect();
  let batteries: Vec<&Supply> = supplies.iter().filter(|s| get(s, "type") == "Battery" && get(s, "scope") != "Device").collect();
  let mut p = Power::unknown();
  if !mains.is_empty() {
    p.ac_status = if mains.iter().any(|s| get(s, "online") == "1") { 1 } else { 0 };
  }
  let Some(b) = batteries.first() else {
    if p.ac_status == 255 {
      p.ac_status = 1;   // a desktop without power supply entries runs on mains
    }
    p.battery_status = 128;
    return p;
  };
  let status = get(b, "status");
  let discharging = status == "Discharging";
  if p.ac_status == 255 && !status.is_empty() && status != "Unknown" {
    p.ac_status = if discharging { 0 } else { 1 };
  }
  let percent = num(b, "capacity").map(|c| (c.round() as i32).clamp(0, 100)).or_else(|| {
    let (now, full) = (num(b, "energy_now").or(num(b, "charge_now"))?, num(b, "energy_full").or(num(b, "charge_full"))?);
    (full > 0.0).then(|| ((now / full * 100.0).round() as i32).clamp(0, 100))
  });
  if let Some(pc) = percent {
    p.battery_life_percent = pc;
    let level = if pc < 5 { 2 | 4 } else if pc < 33 { 2 } else if pc > 66 { 1 } else { 0 };
    p.battery_status = level | if status == "Charging" { 8 } else { 0 };
  }
  if discharging {
    let (now, full, rate) = match (num(b, "energy_now"), num(b, "power_now")) {
      (Some(e), Some(w)) => (Some(e), num(b, "energy_full"), w),
      _ => (num(b, "charge_now"), num(b, "charge_full"), num(b, "current_now").unwrap_or(0.0)),
    };
    let secs = |amount: Option<f64>| amount.filter(|_| rate > 0.0).map(|a| (a / rate * 3600.0).round() as i32);
    p.battery_life_time = secs(now).unwrap_or(-1);
    p.battery_full_time = secs(full).unwrap_or(-1);
  }
  p
}

/// The kernel release ("6.8.0-45-generic"): OSVersion is its numbers ("6.8.0"), OSBuild the whole release.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_version(release: &str) -> (String, String) {
  let release = release.trim();
  let version: String = release.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
  (version.trim_end_matches('.').to_string(), release.to_string())
}

#[cfg(target_os = "macos")]
fn power() -> Power {
  match std::process::Command::new("/usr/bin/pmset").args(["-g", "batt"]).output() {
    Ok(o) if o.status.success() => parse_pmset(&String::from_utf8_lossy(&o.stdout)),
    _ => Power::unknown(),
  }
}

#[cfg(windows)]
fn power() -> Power {
  use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
  // SAFETY: GetSystemPowerStatus fills the struct it is given.
  let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
  if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
    return Power::unknown();
  }
  power_from_windows(s.ACLineStatus, s.BatteryFlag, s.BatteryLifePercent, s.BatteryLifeTime, s.BatteryFullLifeTime)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn power() -> Power {
  let Ok(dir) = std::fs::read_dir("/sys/class/power_supply") else { return Power::unknown() };
  let mut supplies: Vec<(String, Supply)> = dir
    .flatten()
    .map(|e| {
      let mut s = Supply::new();
      for k in ["type", "scope", "online", "status", "capacity", "energy_now", "energy_full", "power_now", "charge_now", "charge_full", "current_now"] {
        if let Ok(v) = std::fs::read_to_string(e.path().join(k)) {
          s.insert(k.to_string(), v.trim().to_string());
        }
      }
      (e.file_name().to_string_lossy().into_owned(), s)
    })
    .collect();
  supplies.sort_by(|a, b| a.0.cmp(&b.0));   // BAT0 before BAT1
  power_from_supplies(&supplies.into_iter().map(|(_, s)| s).collect::<Vec<_>>())
}

#[cfg(target_os = "macos")]
fn os_version() -> (String, String) {
  let v = plist::Value::from_file("/System/Library/CoreServices/SystemVersion.plist").ok();
  let get = |k: &str| v.as_ref().and_then(|v| v.as_dictionary()).and_then(|d| d.get(k)).and_then(|x| x.as_string()).unwrap_or("").to_string();
  (get("ProductVersion"), get("ProductBuildVersion"))
}

/// "10.0" and the build number ("22631"): RtlGetVersion, which (unlike GetVersionEx) tells the truth without a manifest.
#[cfg(windows)]
fn os_version() -> (String, String) {
  use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
  use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
  // SAFETY: RtlGetVersion fills the struct whose size it is given.
  let mut v: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
  v.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
  if unsafe { RtlGetVersion(&mut v) } != 0 {
    return (String::new(), String::new());
  }
  (format!("{}.{}", v.dwMajorVersion, v.dwMinorVersion), v.dwBuildNumber.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_version() -> (String, String) {
  linux_version(&std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default())
}

#[tauri::command]
pub async fn sys_info(app: tauri::AppHandle) -> Result<SysInfo, String> {
  let (mut l, mut t, mut w, mut h) = (0.0, 0.0, 0.0, 0.0);
  if let Ok(Some(m)) = app.primary_monitor() {
    let scale = m.scale_factor().max(1.0);
    let a = m.work_area();
    (l, t, w, h) = (a.position.x as f64 / scale, a.position.y as f64 / scale, a.size.width as f64 / scale, a.size.height as f64 / scale);
  }
  let (os_version, os_build) = os_version();
  let power = tauri::async_runtime::spawn_blocking(power).await.unwrap_or_else(|_| Power::unknown());
  Ok(SysInfo { os_version, os_build, work_left: l, work_top: t, work_width: w, work_height: h, power })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn pmset_output_gives_the_vb6_power_values() {
    let on_battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t76%; discharging; 4:12 remaining present: true\n";
    assert_eq!(parse_pmset(on_battery), Power { ac_status: 0, battery_life_percent: 76, battery_life_time: 4 * 3600 + 12 * 60, battery_full_time: -1, battery_status: 1 });
    let charging = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t20%; charging; 1:30 remaining present: true\n";
    assert_eq!(parse_pmset(charging), Power { ac_status: 1, battery_life_percent: 20, battery_life_time: -1, battery_full_time: -1, battery_status: 2 | 8 });
    let desktop = "Now drawing from 'AC Power'\n";
    assert_eq!(parse_pmset(desktop).battery_status, 128);
    assert_eq!(parse_pmset(desktop).battery_life_percent, 255);
    assert_eq!(parse_pmset(""), Power::unknown());
  }

  #[test]
  fn windows_power_status_is_vb6s_own() {
    assert_eq!(power_from_windows(0, 1, 80, 7200, u32::MAX), Power { ac_status: 0, battery_life_percent: 80, battery_life_time: 7200, battery_full_time: -1, battery_status: 1 });
    assert_eq!(power_from_windows(1, 128, 255, u32::MAX, u32::MAX), Power { ac_status: 1, battery_life_percent: 255, battery_life_time: -1, battery_full_time: -1, battery_status: 128 });
    assert_eq!(power_from_windows(255, 255, 255, u32::MAX, u32::MAX), Power::unknown());
  }

  fn supply(kv: &[(&str, &str)]) -> Supply {
    kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
  }

  #[test]
  fn linux_power_supplies_give_the_vb6_power_values() {
    let ac_off = supply(&[("type", "Mains"), ("online", "0")]);
    let bat = supply(&[("type", "Battery"), ("status", "Discharging"), ("capacity", "76"), ("energy_now", "38000000"), ("energy_full", "50000000"), ("power_now", "10000000")]);
    let mouse = supply(&[("type", "Battery"), ("scope", "Device"), ("capacity", "5"), ("status", "Discharging")]);
    let p = power_from_supplies(&[mouse.clone(), ac_off, bat]);
    assert_eq!(p, Power { ac_status: 0, battery_life_percent: 76, battery_life_time: 13680, battery_full_time: 18000, battery_status: 1 });

    let ac_on = supply(&[("type", "Mains"), ("online", "1")]);
    let charging = supply(&[("type", "Battery"), ("status", "Charging"), ("charge_now", "1000"), ("charge_full", "5000")]);
    assert_eq!(power_from_supplies(&[ac_on, charging]), Power { ac_status: 1, battery_life_percent: 20, battery_life_time: -1, battery_full_time: -1, battery_status: 2 | 8 });

    // a desktop: no supplies, or only a peripheral's battery
    let desktop = Power { ac_status: 1, battery_status: 128, ..Power::unknown() };
    assert_eq!(power_from_supplies(&[]), desktop);
    assert_eq!(power_from_supplies(&[mouse]), desktop);
  }

  #[test]
  fn linux_version_is_the_kernel_release() {
    assert_eq!(linux_version("6.8.0-45-generic\n"), ("6.8.0".to_string(), "6.8.0-45-generic".to_string()));
    assert_eq!(linux_version("6.10.arch1-1"), ("6.10".to_string(), "6.10.arch1-1".to_string()));
    assert_eq!(linux_version(""), (String::new(), String::new()));
  }
}
