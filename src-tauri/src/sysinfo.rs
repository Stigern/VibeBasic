//! SysInfo (SYSINFO.OCX): the macOS version (SystemVersion.plist), the main screen's visible frame (the work area, in points)
//! and the power state from `pmset -g batt`. Unknown battery values are VB6's: 255 (percent, AC status), -1 (times);
//! a Mac without a battery reports BatteryStatus 128 (no system battery) as Windows does.

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

fn power() -> Power {
  match std::process::Command::new("/usr/bin/pmset").args(["-g", "batt"]).output() {
    Ok(o) if o.status.success() => parse_pmset(&String::from_utf8_lossy(&o.stdout)),
    _ => Power::unknown(),
  }
}

fn os_version() -> (String, String) {
  let v = plist::Value::from_file("/System/Library/CoreServices/SystemVersion.plist").ok();
  let get = |k: &str| v.as_ref().and_then(|v| v.as_dictionary()).and_then(|d| d.get(k)).and_then(|x| x.as_string()).unwrap_or("").to_string();
  (get("ProductVersion"), get("ProductBuildVersion"))
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
}
