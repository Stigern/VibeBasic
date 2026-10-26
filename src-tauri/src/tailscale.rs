//! Read-only access to the local Tailscale client's known peers. Never enumerate the 100.64/10 range.
use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use serde_json::Value;
use tokio::io::AsyncReadExt;

const MAX_STATUS: usize = 4 * 1024 * 1024;
const STATUS_TIMEOUT: Duration = Duration::from_secs(3);
const CONNECT_MESSAGE: &str = "Could not read Tailscale status. Open Tailscale and connect, then try again.";

pub struct Peer { pub name: String, pub address: Ipv4Addr }

pub fn is_address(ip: Ipv4Addr) -> bool { ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]) }

pub fn parse_status(status: &Value) -> Result<Vec<Peer>, String> {
  if status["BackendState"].as_str() != Some("Running") {
    return Err("Tailscale is not connected. Open Tailscale and connect, then try again.".into());
  }
  let mut nodes = Vec::new();
  if status["Self"].is_object() { nodes.push((&status["Self"], true)); }
  if let Some(peers) = status["Peer"].as_object() {
    nodes.extend(peers.values().filter(|peer| peer["Online"].as_bool() == Some(true)).map(|peer| (peer, false)));
  }
  let mut seen = HashSet::new();
  let mut peers = Vec::new();
  for (node, own) in nodes {
    let Some(addresses) = node["TailscaleIPs"].as_array() else { continue; };
    for value in addresses {
      let Some(ip) = value.as_str().and_then(|s| s.parse::<Ipv4Addr>().ok()).filter(|ip| is_address(*ip)) else { continue; };
      if !seen.insert(ip) || peers.len() >= 1024 { continue; }
      let name = if own { "this computer" } else {
        node["DNSName"].as_str().filter(|s| !s.is_empty()).or_else(|| node["HostName"].as_str()).unwrap_or("peer")
      };
      peers.push(Peer { name: name.trim_end_matches('.').to_string(), address: ip });
    }
  }
  peers.sort_by_key(|p| p.address);
  Ok(peers)
}

fn executable() -> Option<PathBuf> {
  let mut paths = Vec::<PathBuf>::new();
  #[cfg(target_os = "macos")]
  paths.extend(["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].map(PathBuf::from));
  #[cfg(target_os = "linux")]
  paths.extend(["/usr/bin/tailscale", "/usr/local/bin/tailscale"].map(PathBuf::from));
  #[cfg(windows)]
  if let Some(root) = std::env::var_os("ProgramFiles") { paths.push(PathBuf::from(root).join("Tailscale").join("tailscale.exe")); }
  if let Some(path) = std::env::var_os("PATH") {
    paths.extend(std::env::split_paths(&path).filter(|p| p.is_absolute()).map(|p| p.join(if cfg!(windows) { "tailscale.exe" } else { "tailscale" })));
  }
  paths.into_iter().find(|p| p.is_file())
}

async fn read_status(program: &Path, limit: usize, timeout: Duration) -> Result<Value, String> {
  let mut command = tokio::process::Command::new(program);
  command.args(["status", "--json"]).env("TAILSCALE_BE_CLI", "1")
    .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
  #[cfg(windows)]
  command.creation_flags(0x08000000); // CREATE_NO_WINDOW
  let mut child = command.spawn().map_err(|_| CONNECT_MESSAGE.to_string())?;
  let stdout = child.stdout.take().ok_or_else(|| CONNECT_MESSAGE.to_string())?;
  let work = async {
    let mut bytes = Vec::new();
    stdout.take(limit as u64 + 1).read_to_end(&mut bytes).await.map_err(|_| CONNECT_MESSAGE.to_string())?;
    if bytes.len() > limit { return Err("Tailscale status exceeded the size limit.".into()); }
    let exit = child.wait().await.map_err(|_| CONNECT_MESSAGE.to_string())?;
    if !exit.success() { return Err(CONNECT_MESSAGE.to_string()); }
    serde_json::from_slice(&bytes).map_err(|_| "Tailscale returned an unreadable status.".to_string())
  };
  tokio::time::timeout(timeout, work).await.map_err(|_| "Tailscale did not respond in time. Open Tailscale and try again.".to_string())?
}

pub async fn peers() -> Result<Vec<Peer>, String> {
  let program = executable().ok_or_else(|| "Tailscale was not found. Install its desktop client or CLI, connect, and try again.".to_string())?;
  parse_status(&read_status(&program, MAX_STATUS, STATUS_TIMEOUT).await?)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[cfg(unix)]
  use std::os::unix::fs::PermissionsExt;
  #[cfg(unix)]
  fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name); std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap(); path
  }
  #[cfg(unix)]
  #[tokio::test]
  async fn cli_is_read_only_bounded_and_forced_into_cli_mode() {
    let dir = tempfile::tempdir().unwrap();
    let good = script(dir.path(), "good", "[ \"$1\" = status ] && [ \"$2\" = --json ] && [ \"$TAILSCALE_BE_CLI\" = 1 ] || exit 1\nprintf '%s' '{\"BackendState\":\"Running\"}'");
    assert_eq!(read_status(&good, 1024, Duration::from_secs(1)).await.unwrap()["BackendState"], "Running");
    let large = script(dir.path(), "large", "printf '123456789'");
    assert!(read_status(&large, 4, Duration::from_secs(1)).await.unwrap_err().contains("size limit"));
    let slow = script(dir.path(), "slow", "exec sleep 5");
    assert!(read_status(&slow, 1024, Duration::from_millis(50)).await.unwrap_err().contains("in time"));
    let bad = script(dir.path(), "bad", "printf 'not json'");
    assert!(read_status(&bad, 1024, Duration::from_secs(1)).await.unwrap_err().contains("unreadable"));
  }

  #[test]
  fn address_bounds_exclude_other_cgnat_and_public_hosts() {
    for (address, expected) in [("100.63.255.255", false), ("100.64.0.0", true), ("100.127.255.255", true), ("100.128.0.0", false), ("192.168.1.1", false)] {
      assert_eq!(is_address(address.parse().unwrap()), expected, "{address}");
    }
  }
}
