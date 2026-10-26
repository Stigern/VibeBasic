//! Explicit, bounded discovery of AI servers on this computer's own private IPv4 networks.
use std::net::Ipv4Addr;
use std::collections::HashSet;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, State};
use tokio::task::JoinSet;
use crate::ai::AiStreams;

#[derive(Clone)]
struct LocalInterface { name: String, address: Ipv4Addr, prefix: u8, up: bool }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanNetwork {
  interface: String, address: String, network: String, prefix: u8, host_count: usize, note: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServer {
  host: String, port: u16, base_url: String, kind: String, models: Vec<String>, latency_ms: u64, requires_key: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanRequest { networks: Vec<String>, ports: Vec<u16>, link_local: bool, #[serde(default)] tailscale: bool, api_key: Option<String> }
#[derive(Clone, Serialize)]
pub struct LanProgress { completed: usize, total: usize, found: usize, server: Option<LanServer> }

const MAX_HOSTS: usize = 1024;
const MAX_BODY: usize = 1_000_000;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const IDENTIFY_TIMEOUT: Duration = Duration::from_secs(2);
const TAILSCALE_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

fn plan_networks(interfaces: Vec<LocalInterface>, link_local: bool) -> Vec<LanNetwork> {
  let mut result = Vec::new();
  let mut seen = HashSet::new();
  let mut hosts = 0;
  for iface in interfaces {
    let ip = iface.address;
    if !iface.up || !(ip.is_private() || (link_local && ip.is_link_local())) || iface.prefix > 32 { continue; }
    let prefix = iface.prefix.max(24);
    let mask = u32::MAX.checked_shl(u32::from(32 - prefix)).unwrap_or(0);
    let network = format!("{}/{prefix}", Ipv4Addr::from(u32::from(ip) & mask));
    if !seen.insert(network.clone()) || hosts >= MAX_HOSTS { continue; }
    let count = if prefix < 31 { (1usize << (32 - prefix)) - 2 } else { 1usize << (32 - prefix) };
    let host_count = count.min(MAX_HOSTS - hosts);
    hosts += host_count;
    let mut notes = Vec::new();
    if prefix != iface.prefix { notes.push(format!("capped from /{}", iface.prefix)); }
    if host_count < count { notes.push(format!("first {host_count} hosts")); }
    result.push(LanNetwork { interface: iface.name, address: ip.to_string(), network, prefix, host_count, note: notes.join(", ") });
  }
  result
}

fn peer_network(peer: crate::tailscale::Peer) -> LanNetwork {
  LanNetwork { interface: format!("Tailscale: {}", peer.name), address: peer.address.to_string(), network: format!("{}/32", peer.address), prefix: 32, host_count: 1, note: "known peer".into() }
}

fn local_networks(link_local: bool) -> Result<Vec<LanNetwork>, String> {
  let interfaces = if_addrs::get_if_addrs().map_err(|_| "Could not read this computer's network interfaces.".to_string())?;
  let interfaces = interfaces.into_iter().filter_map(|iface| {
    let up = iface.is_oper_up();
    match iface.addr {
      if_addrs::IfAddr::V4(v4) => Some(LocalInterface { name: iface.name, address: v4.ip, prefix: v4.prefixlen, up }),
      _ => None,
    }
  }).collect();
  Ok(plan_networks(interfaces, link_local))
}

fn targets(networks: &[LanNetwork], selected: &[String], ports: &[u16]) -> Result<Vec<(Ipv4Addr, u16)>, String> {
  let ports: Vec<_> = ports.iter().copied().collect::<HashSet<_>>().into_iter().collect();
  if ports.is_empty() || ports.len() > 16 || ports.contains(&0) { return Err("Choose 1 to 16 ports, each from 1 to 65535.".into()); }
  if selected.iter().any(|s| !networks.iter().any(|n| &n.network == s)) { return Err("Choose only the currently listed LAN networks or Tailscale devices. Reopen the search to refresh them.".into()); }
  let mut hosts = vec![Ipv4Addr::LOCALHOST];
  let mut seen_hosts = HashSet::from([Ipv4Addr::LOCALHOST]);
  for network in networks.iter().filter(|n| selected.contains(&n.network)) {
    let base: Ipv4Addr = network.network.split('/').next().unwrap_or("").parse().map_err(|_| "Invalid local network.")?;
    let first = u32::from(base) + u32::from(network.prefix < 31);
    hosts.extend((0..network.host_count).map(|i| Ipv4Addr::from(first + i as u32)).filter(|host| seen_hosts.insert(*host)));
    if hosts.len() > MAX_HOSTS + 1 { return Err("Select fewer networks or devices: the search limit is 1,024 hosts plus localhost.".into()); }
  }
  let mut ports = ports; ports.sort_unstable();
  Ok(hosts.into_iter().flat_map(|host| ports.iter().map(move |port| (host, *port))).collect())
}

fn client() -> reqwest::Client {
  client_for(false)
}

fn client_for(tailscale: bool) -> reqwest::Client {
  reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
    .connect_timeout(if tailscale { TAILSCALE_CONNECT_TIMEOUT } else { CONNECT_TIMEOUT })
    .timeout(if tailscale { Duration::from_secs(5) } else { IDENTIFY_TIMEOUT }).build().expect("LAN HTTP client")
}

async fn get_json(client: &reqwest::Client, url: &str, key: Option<&str>) -> Option<(u16, bool, Value)> {
  let mut request = client.get(url);
  if let Some(key) = key.filter(|k| !k.trim().is_empty()) { request = request.bearer_auth(key); }
  let mut response = request.send().await.ok()?;
  let status = response.status().as_u16();
  let bearer = response.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).is_some_and(|s| s.to_lowercase().contains("bearer"));
  if response.content_length().is_some_and(|n| n > MAX_BODY as u64) { return None; }
  let mut body = Vec::new();
  while let Some(chunk) = response.chunk().await.ok()? {
    if body.len() + chunk.len() > MAX_BODY { return None; }
    body.extend_from_slice(&chunk);
  }
  Some((status, bearer, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

async fn identify(client: &reqwest::Client, host: Ipv4Addr, port: u16, key: Option<&str>) -> Option<LanServer> {
  let base_url = format!("http://{host}:{port}/v1");
  let started = Instant::now();
  let (status, bearer, payload) = get_json(client, &format!("{base_url}/models"), key).await?;
  let requires_key = (status == 401 || status == 403) && (bearer || payload.is_object() || payload.is_array());
  let data = payload.get("data").and_then(Value::as_array);
  if !requires_key && (status != 200 || data.is_none()) { return None; }
  let models = data.map(|rows| rows.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default();
  let mut kind = if data.is_some_and(|rows| rows.iter().any(|m| m["owned_by"].as_str() == Some("vllm"))) { "vLLM" } else { "OpenAI-compatible" };
  if !requires_key && kind != "vLLM" {
    let root = format!("http://{host}:{port}");
    for (path, name, field) in [("/api/version", "Ollama", "version"), ("/api/v0/models", "LM Studio", "data"), ("/version", "llama.cpp", "build_number")] {
      if let Some((200, _, value)) = get_json(client, &format!("{root}{path}"), key).await {
        if value.get(field).is_some_and(|v| !v.is_null()) { kind = name; break; }
      }
    }
  }
  Some(LanServer { host: host.to_string(), port, base_url, kind: kind.into(), models, latency_ms: started.elapsed().as_millis() as u64, requires_key })
}

/// A separate semaphore caps HTTP identification at eight while TCP probes remain capped at 64.
/// Dropping/aborting this future drops JoinSet, aborting every outstanding probe and HTTP request.
async fn scan_targets(targets: Vec<(Ipv4Addr, u16)>, key: Option<String>, report: impl Fn(LanProgress) + Send) -> Result<Vec<LanServer>, String> {
  let total = targets.len();
  let mut pending = targets.into_iter();
  let mut tasks = JoinSet::new();
  let client = client();
  let tailscale_client = client_for(true);
  let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
  let mut found = Vec::new();
  let mut completed = 0;
  let mut last_report = Instant::now();
  report(LanProgress { completed, total, found: 0, server: None });
  loop {
    while tasks.len() < 64 {
      let Some((host, port)) = pending.next() else { break; };
      let tailscale = crate::tailscale::is_address(host);
      let client = if tailscale { tailscale_client.clone() } else { client.clone() };
      let key = key.clone(); let permits = permits.clone();
      tasks.spawn(async move {
        match tokio::time::timeout(if tailscale { TAILSCALE_CONNECT_TIMEOUT } else { CONNECT_TIMEOUT }, tokio::net::TcpStream::connect((host, port))).await {
          Ok(Ok(connection)) => { drop(connection); },
          _ => return None,
        }
        let _permit = permits.acquire_owned().await.ok()?;
        identify(&client, host, port, key.as_deref()).await
      });
    }
    let Some(result) = tasks.join_next().await else { break; };
    completed += 1;
    let server = result.map_err(|_| "The LAN search stopped unexpectedly.".to_string())?;
    if let Some(server) = &server { found.push(server.clone()); }
    if server.is_some() || completed == total || last_report.elapsed() >= Duration::from_millis(100) {
      report(LanProgress { completed, total, found: found.len(), server }); last_report = Instant::now();
    }
  }
  found.sort_by_key(|s| (s.host.parse::<Ipv4Addr>().unwrap_or(Ipv4Addr::LOCALHOST), s.port));
  Ok(found)
}

#[tauri::command]
pub async fn ai_lan_networks(link_local: bool, tailscale: Option<bool>) -> Result<Vec<LanNetwork>, String> {
  let mut networks = crate::io_util::off_main(move || local_networks(link_local)).await?;
  if tailscale.unwrap_or(false) {
    networks.extend(crate::tailscale::peers().await?.into_iter().map(peer_network));
  }
  Ok(networks)
}

#[tauri::command]
pub async fn ai_lan_scan(app: tauri::AppHandle, streams: State<'_, AiStreams>, request: LanRequest, stream_id: String) -> Result<Vec<LanServer>, String> {
  let id = stream_id.clone();
  let result = registered_task(|handle| streams.register(&stream_id, handle), async move {
    let available = ai_lan_networks(request.link_local, Some(request.tailscale)).await?;
    let targets = targets(&available, &request.networks, &request.ports)?;
    scan_targets(targets, request.api_key, move |progress| {
      let _ = app.emit_to("main", "ai:lan", json!({"id": id, "progress": progress}));
    }).await
  }).await;
  streams.finish(&stream_id);
  result
}

async fn registered_task(register: impl FnOnce(tokio::task::AbortHandle) -> bool + Send,
  work: impl std::future::Future<Output = Result<Vec<LanServer>, String>> + Send + 'static) -> Result<Vec<LanServer>, String> {
  let (start, ready) = tokio::sync::oneshot::channel::<()>();
  let task = tokio::spawn(async move {
    ready.await.map_err(|_| "cancelled".to_string())?;
    work.await
  });
  if register(task.abort_handle()) { let _ = start.send(()); } else { drop(start); }
  let result = task.await;
  match result {
    Ok(result) => result,
    Err(e) if e.is_cancelled() => Err("cancelled".into()),
    Err(_) => Err("The LAN search stopped unexpectedly.".into()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use httpmock::prelude::*;
  fn iface(address: &str, prefix: u8) -> LocalInterface { LocalInterface { name: "test".into(), address: address.parse().unwrap(), prefix, up: true } }

  #[test]
  fn private_network_plan_is_capped_deduplicated_and_excludes_public_down_and_link_local() {
    let mut down = iface("192.168.2.3", 24); down.up = false;
    let nets = plan_networks(vec![iface("10.20.30.40", 8), iface("10.20.30.41", 24), iface("192.168.1.5", 28),
      iface("8.8.8.8", 24), iface("127.0.0.1", 8), iface("169.254.1.5", 16), down], false);
    assert_eq!(nets.iter().map(|n| n.network.as_str()).collect::<Vec<_>>(), vec!["10.20.30.0/24", "192.168.1.0/28"]);
    assert_eq!(nets.iter().map(|n| n.host_count).collect::<Vec<_>>(), vec![254, 14]);
    assert!(nets[0].note.contains("/8"));
    assert_eq!(plan_networks(vec![iface("169.254.1.5", 16)], true)[0].network, "169.254.1.0/24");
  }

  #[test]
  fn targets_respect_selected_networks_and_reject_foreign_networks_and_invalid_ports() {
    let nets = plan_networks(vec![iface("192.168.1.5", 30), iface("10.1.2.3", 24)], false);
    let all = targets(&nets, &["192.168.1.4/30".into()], &[8000, 8000]).unwrap();
    assert_eq!(all, vec![(Ipv4Addr::LOCALHOST, 8000), ("192.168.1.5".parse().unwrap(), 8000), ("192.168.1.6".parse().unwrap(), 8000)]);
    for (selected, ports) in [(vec!["8.8.8.0/24".into()], vec![8000]), (vec![], vec![]), (vec![], vec![0]), (vec![], (1..=17).collect())] {
      assert!(targets(&nets, &selected, &ports).is_err());
    }
    let interfaces = (0..9).map(|i| iface(&format!("10.0.{i}.1"), 24)).collect();
    assert!(plan_networks(interfaces, false).iter().map(|n| n.host_count).sum::<usize>() <= 1024);
    let overlapping = plan_networks(vec![iface("192.168.1.5", 30), iface("192.168.1.5", 28)], false);
    let addresses = targets(&overlapping, &overlapping.iter().map(|n| n.network.clone()).collect::<Vec<_>>(), &[8000]).unwrap();
    assert_eq!(addresses.len(), 15); // localhost plus the 14 unique hosts in /28
  }

  #[tokio::test]
  async fn identifies_models_and_server_kind_without_sending_a_key_by_default() {
    let server = MockServer::start();
    let models = server.mock(|when, then| { when.path("/v1/models"); then.status(200).json_body(serde_json::json!({"data":[{"id":"qwen","owned_by":"vllm"}]})); });
    let found = identify(&client(), Ipv4Addr::LOCALHOST, server.port(), None).await.unwrap();
    assert_eq!(found.models, vec!["qwen"]);
    assert_eq!(found.kind, "vLLM");
    assert!(!found.requires_key);
    models.assert_hits(1);
  }

  #[tokio::test]
  async fn key_is_opt_in_and_redirects_and_non_ai_servers_are_not_followed() {
    let server = MockServer::start();
    let authorized = server.mock(|when, then| { when.path("/v1/models").header("authorization", "Bearer secret"); then.status(200).json_body(serde_json::json!({"data":[{"id":"private-model"}]})); });
    let found = identify(&client(), Ipv4Addr::LOCALHOST, server.port(), Some("secret")).await.unwrap();
    assert_eq!(found.models, vec!["private-model"]); authorized.assert_hits(1);
    assert!(identify(&client(), Ipv4Addr::LOCALHOST, server.port(), None).await.is_none());
    let server = MockServer::start();
    let redirect = server.mock(|when, then| { when.path("/v1/models"); then.status(302).header("location", "/private"); });
    let destination = server.mock(|when, then| { when.path("/private"); then.status(200).json_body(serde_json::json!({"data":[]})); });
    assert!(identify(&client(), Ipv4Addr::LOCALHOST, server.port(), Some("secret")).await.is_none());
    redirect.assert_hits(1); destination.assert_hits(0);
    let server = MockServer::start();
    server.mock(|when, then| { when.path("/v1/models"); then.status(401).header("www-authenticate", "Bearer").json_body(serde_json::json!({"error":"key required"})); });
    assert!(identify(&client(), Ipv4Addr::LOCALHOST, server.port(), None).await.unwrap().requires_key);
  }

  #[tokio::test]
  async fn scan_reports_progress_and_cancellation_drops_pending_connections() {
    let server = MockServer::start();
    server.mock(|when, then| { when.path("/v1/models"); then.status(200).json_body(serde_json::json!({"data":[{"id":"m","owned_by":"vllm"}]})); });
    let events = std::sync::Mutex::new(Vec::new());
    let result = scan_targets(vec![(Ipv4Addr::LOCALHOST, server.port())], None, |p| events.lock().unwrap().push(p)).await.unwrap();
    assert_eq!(result.len(), 1);
    let events = events.lock().unwrap();
    assert_eq!(events.last().unwrap().completed, 1);
    assert_eq!(events.last().unwrap().found, 1);
    drop(events);
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let request = tokio::spawn(scan_targets(vec![(Ipv4Addr::LOCALHOST, port)], None, |_| {}));
    let (probe, _) = listener.accept().await.unwrap(); drop(probe);
    let (mut socket, _) = listener.accept().await.unwrap();
    use tokio::io::AsyncReadExt;
    let mut received = Vec::new();
    while !received.ends_with(b"\r\n\r\n") {
      let mut byte = [0]; assert_eq!(socket.read(&mut byte).await.unwrap(), 1); received.push(byte[0]);
    }
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    let mut byte = [0];
    assert_eq!(tokio::time::timeout(Duration::from_secs(1), socket.read(&mut byte)).await.unwrap().unwrap(), 0);
  }

  #[tokio::test]
  async fn identification_ignores_oversized_model_lists() {
    let server = MockServer::start();
    server.mock(|when, then| { when.path("/v1/models"); then.status(200).json_body(json!({"data":[{"id":"x".repeat(MAX_BODY)}]})); });
    assert!(identify(&client(), Ipv4Addr::LOCALHOST, server.port(), None).await.is_none());
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn cancelled_before_registration_never_starts_probe_work() {
    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = started.clone();
    let result = registered_task(|handle| {
      // Let another worker poll the spawned task before the cancellation reaches registration.
      std::thread::sleep(Duration::from_millis(20)); handle.abort(); false
    }, async move { observed.store(true, std::sync::atomic::Ordering::SeqCst); Ok(Vec::new()) }).await;
    assert!(!started.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(result.unwrap_err(), "cancelled");
  }

  #[test]
  fn tailscale_lists_only_known_online_ipv4_nodes_without_sweeping_the_address_range() {
    let status = json!({"BackendState":"Running", "Self":{"HostName":"this-pc", "TailscaleIPs":["100.64.1.1"]}, "Peer":{
      "ai":{"DNSName":"ai-box.example.ts.net.","Online":true,"TailscaleIPs":["100.100.2.3","fd7a:115c:a1e0::1"]},
      "offline":{"HostName":"off","Online":false,"TailscaleIPs":["100.70.0.8"]},
      "public":{"HostName":"outside","Online":true,"TailscaleIPs":["8.8.8.8","192.168.1.9"]},
      "duplicate":{"Online":true,"TailscaleIPs":["100.64.1.1"]}
    }});
    let nodes = crate::tailscale::parse_status(&status).unwrap().into_iter().map(peer_network).collect::<Vec<_>>();
    assert_eq!(nodes.len(), 2);
    assert!(nodes.iter().all(|n| n.prefix == 32 && n.host_count == 1));
    assert!(nodes.iter().any(|n| n.network == "100.100.2.3/32" && n.interface.contains("ai-box.example.ts.net")));
    let selected = nodes.iter().map(|n| n.network.clone()).collect::<Vec<_>>();
    let attempts = targets(&nodes, &selected, &[8000]).unwrap();
    assert_eq!(attempts.len(), 3); // localhost, self and one online peer
    assert!(targets(&nodes, &["100.100.2.0/24".into()], &[8000]).is_err());
    assert!(targets(&[], &["100.100.2.3/32".into()], &[8000]).is_err());
    assert!(crate::tailscale::parse_status(&json!({"BackendState":"NeedsLogin"})).is_err());
    assert!(crate::tailscale::parse_status(&json!({"BackendState":"Stopped"})).is_err());
    let mut crowded = plan_networks((0..5).map(|i| LocalInterface { name: format!("lan{i}"), address: Ipv4Addr::new(10, i, 0, 1), prefix: 24, up: true }).collect(), false);
    crowded.extend(nodes);
    assert_eq!(targets(&crowded, &selected, &[8000]).unwrap().len(), 3);
    let all = crowded.iter().map(|n| n.network.clone()).collect::<Vec<_>>();
    assert!(targets(&crowded, &all, &[8000]).unwrap_err().contains("Select fewer"));
  }
}
