//! Winsock (MSWINSCK.OCX): TCP clients and servers and UDP sockets with tokio. The frontend (the run session in the main
//! window) picks the socket ids. Data, incoming connections, remote closes and errors go back as "vb:socket" events;
//! the commands answer with the socket's addresses or an error "number|description" (Winsock error numbers: 10061 ...).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::task::AbortHandle;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const CONNECT_TIMEOUT_SECS: u64 = 30;
/// Incoming connections nobody accepted are kept at most this many (the oldest are dropped).
const MAX_PENDING: usize = 64;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SockEvent {
  /// A listening socket got a connection; `request_id` is what Accept takes.
  ConnectionRequest { id: u32, request_id: u32, remote_ip: String, remote_port: u16 },
  /// Bytes arrived (base64). UDP: one datagram, with its sender.
  Data { id: u32, data: String, remote_ip: String, remote_port: u16 },
  /// The other side closed the connection.
  Close { id: u32 },
  Error { id: u32, number: i32, description: String },
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SocketInfo {
  pub local_ip: String,
  pub local_port: u16,
  pub remote_ip: String,
  pub remote_port: u16,
}

pub type Emit = Arc<dyn Fn(SockEvent) + Send + Sync>;

/// The Winsock number and text for an I/O error.
fn code(e: &std::io::Error) -> (i32, String) {
  use std::io::ErrorKind as K;
  let (n, d) = match e.kind() {
    K::ConnectionRefused => (10061, "Connection is forcefully rejected"),
    K::AddrInUse => (10048, "Address in use"),
    K::AddrNotAvailable => (10049, "Address not available from the local machine"),
    K::TimedOut => (10060, "Connection is aborted due to timeout or other failure"),
    K::ConnectionReset => (10054, "The connection is reset by remote side"),
    K::ConnectionAborted | K::BrokenPipe => (10053, "Connection is aborted due to timeout or other failure"),
    K::NotConnected => (10057, "Socket is not connected"),
    K::PermissionDenied => (10013, "Permission denied"),
    K::HostUnreachable => (10065, "No route to host"),
    K::NetworkUnreachable => (10051, "Network is unreachable"),
    _ => return (10050, format!("Network error: {e}")),
  };
  (n, d.to_string())
}

fn io_err(e: std::io::Error) -> String {
  let (n, d) = code(&e);
  format!("{n}|{d}")
}

fn bad_state() -> String {
  "40006|Wrong protocol or connection state for the requested transaction or request".to_string()
}

fn host_not_found() -> String {
  "11001|Authoritative answer: Host not found".to_string()
}

fn bind_ip(ip: &str) -> &str {
  if ip.trim().is_empty() { "0.0.0.0" } else { ip.trim() }
}

async fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
  let host = host.trim();
  if host.is_empty() {
    return Err(host_not_found());
  }
  let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await.map_err(|_| host_not_found())?.collect();
  if addrs.is_empty() { Err(host_not_found()) } else { Ok(addrs) }
}

enum Sock {
  Tcp { writer: Arc<tokio::sync::Mutex<OwnedWriteHalf>>, reader: AbortHandle },
  Listener { task: AbortHandle },
  Udp { sock: Arc<UdpSocket>, reader: AbortHandle },
}

impl Sock {
  fn stop(&self) {
    match self {
      Sock::Tcp { reader, .. } => reader.abort(),
      Sock::Listener { task } => task.abort(),
      Sock::Udp { reader, .. } => reader.abort(),
    }
  }
}

#[derive(Default)]
struct Inner {
  socks: HashMap<u32, Sock>,
  /// Accepted by a listener, waiting for Accept: request id -> stream (oldest first).
  pending: Vec<(u32, TcpStream)>,
  next_request: u32,
}

/// Every open socket of the app (one running program at a time).
#[derive(Default, Clone)]
pub struct Sockets(Arc<Mutex<Inner>>);

impl Sockets {
  fn put(&self, id: u32, s: Sock) {
    if let Some(old) = self.0.lock().unwrap().socks.insert(id, s) {
      old.stop();
    }
  }

  /// Splits a connected stream: the reader task sends Data / Close / Error, the writer half stays here for SendData.
  fn start_tcp(&self, id: u32, stream: TcpStream, emit: Emit) -> SocketInfo {
    let local = stream.local_addr().ok();
    let peer = stream.peer_addr().ok();
    let info = SocketInfo {
      local_ip: local.map(|a| a.ip().to_string()).unwrap_or_default(),
      local_port: local.map(|a| a.port()).unwrap_or(0),
      remote_ip: peer.map(|a| a.ip().to_string()).unwrap_or_default(),
      remote_port: peer.map(|a| a.port()).unwrap_or(0),
    };
    let (rip, rport) = (info.remote_ip.clone(), info.remote_port);
    let (mut rd, wr) = stream.into_split();
    let task = tokio::spawn(async move {
      let mut buf = vec![0u8; 64 * 1024];
      loop {
        match rd.read(&mut buf).await {
          Ok(0) => {
            emit(SockEvent::Close { id });
            break;
          }
          Ok(n) => emit(SockEvent::Data { id, data: B64.encode(&buf[..n]), remote_ip: rip.clone(), remote_port: rport }),
          Err(e) => {
            let (number, description) = code(&e);
            emit(SockEvent::Error { id, number, description });
            break;
          }
        }
      }
    });
    self.put(id, Sock::Tcp { writer: Arc::new(tokio::sync::Mutex::new(wr)), reader: task.abort_handle() });
    info
  }

  pub async fn connect(&self, id: u32, host: &str, port: u16, emit: Emit) -> Result<SocketInfo, String> {
    let addrs = resolve(host, port).await?;
    let stream = tokio::time::timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS), TcpStream::connect(&addrs[..]))
      .await
      .map_err(|_| "10060|Connection is aborted due to timeout or other failure".to_string())?
      .map_err(io_err)?;
    let _ = stream.set_nodelay(true);
    Ok(self.start_tcp(id, stream, emit))
  }

  /// Listen: every incoming connection is kept as a request until Accept takes it (ConnectionRequest event).
  pub async fn listen(&self, id: u32, port: u16, ip: &str, emit: Emit) -> Result<SocketInfo, String> {
    let l = TcpListener::bind((bind_ip(ip), port)).await.map_err(io_err)?;
    let local = l.local_addr().map_err(io_err)?;
    let me = self.clone();
    let task = tokio::spawn(async move {
      loop {
        match l.accept().await {
          Ok((s, peer)) => {
            let request_id = {
              let mut g = me.0.lock().unwrap();
              g.next_request = g.next_request.wrapping_add(1).max(1);
              let rid = g.next_request;
              if g.pending.len() >= MAX_PENDING {
                g.pending.remove(0);
              }
              g.pending.push((rid, s));
              rid
            };
            emit(SockEvent::ConnectionRequest { id, request_id, remote_ip: peer.ip().to_string(), remote_port: peer.port() });
          }
          Err(e) => {
            let (number, description) = code(&e);
            emit(SockEvent::Error { id, number, description });
            break;
          }
        }
      }
    });
    self.put(id, Sock::Listener { task: task.abort_handle() });
    Ok(SocketInfo { local_ip: local.ip().to_string(), local_port: local.port(), remote_ip: String::new(), remote_port: 0 })
  }

  /// Accept requestID: the waiting connection becomes socket `id`.
  pub async fn accept(&self, id: u32, request_id: u32, emit: Emit) -> Result<SocketInfo, String> {
    let stream = {
      let mut g = self.0.lock().unwrap();
      let i = g.pending.iter().position(|(r, _)| *r == request_id).ok_or_else(bad_state)?;
      g.pending.remove(i).1
    };
    let _ = stream.set_nodelay(true);
    Ok(self.start_tcp(id, stream, emit))
  }

  /// UDP: binds the local port (0: any free one); each datagram that arrives is a Data event.
  pub async fn bind_udp(&self, id: u32, port: u16, ip: &str, emit: Emit) -> Result<SocketInfo, String> {
    let s = Arc::new(UdpSocket::bind((bind_ip(ip), port)).await.map_err(io_err)?);
    let _ = s.set_broadcast(true);
    let local = s.local_addr().map_err(io_err)?;
    let rs = s.clone();
    let task = tokio::spawn(async move {
      let mut buf = vec![0u8; 65536];
      loop {
        match rs.recv_from(&mut buf).await {
          Ok((n, from)) => emit(SockEvent::Data { id, data: B64.encode(&buf[..n]), remote_ip: from.ip().to_string(), remote_port: from.port() }),
          // e.g. ICMP port unreachable for an earlier datagram: not fatal for UDP
          Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset || e.kind() == std::io::ErrorKind::ConnectionRefused => continue,
          Err(e) => {
            let (number, description) = code(&e);
            emit(SockEvent::Error { id, number, description });
            break;
          }
        }
      }
    });
    self.put(id, Sock::Udp { sock: s, reader: task.abort_handle() });
    Ok(SocketInfo { local_ip: local.ip().to_string(), local_port: local.port(), remote_ip: String::new(), remote_port: 0 })
  }

  /// SendData: the whole buffer on a TCP connection, or one datagram to host:port on a UDP socket.
  pub async fn send(&self, id: u32, data: &[u8], host: &str, port: u16) -> Result<(), String> {
    enum Target {
      Tcp(Arc<tokio::sync::Mutex<OwnedWriteHalf>>),
      Udp(Arc<UdpSocket>),
    }
    let t = match self.0.lock().unwrap().socks.get(&id) {
      Some(Sock::Tcp { writer, .. }) => Target::Tcp(writer.clone()),
      Some(Sock::Udp { sock, .. }) => Target::Udp(sock.clone()),
      _ => return Err(bad_state()),
    };
    match t {
      Target::Tcp(w) => w.lock().await.write_all(data).await.map_err(io_err),
      Target::Udp(s) => {
        let addrs = resolve(host, port).await?;
        let addr = addrs.iter().find(|a| a.is_ipv4()).unwrap_or(&addrs[0]);
        s.send_to(data, addr).await.map(|_| ()).map_err(io_err)
      }
    }
  }

  pub fn close(&self, id: u32) {
    if let Some(s) = self.0.lock().unwrap().socks.remove(&id) {
      s.stop();
    }
  }

  /// The end of the program: every socket and waiting connection is closed.
  pub fn close_all(&self) {
    let mut g = self.0.lock().unwrap();
    for (_, s) in g.socks.drain() {
      s.stop();
    }
    g.pending.clear();
  }
}

/// The Mac's address on the network it would use to reach the internet (LocalIP); 127.0.0.1 without a network.
pub fn local_ip() -> String {
  std::net::UdpSocket::bind("0.0.0.0:0")
    .and_then(|s| s.connect("8.8.8.8:80").map(|_| s))
    .and_then(|s| s.local_addr())
    .map(|a| a.ip().to_string())
    .unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn emitter(app: tauri::AppHandle) -> Emit {
  Arc::new(move |e: SockEvent| {
    let _ = app.emit("vb:socket", e);
  })
}

#[tauri::command]
pub async fn sock_connect(app: tauri::AppHandle, socks: State<'_, Sockets>, id: u32, host: String, port: u16) -> Result<SocketInfo, String> {
  socks.inner().clone().connect(id, &host, port, emitter(app)).await
}

#[tauri::command]
pub async fn sock_listen(app: tauri::AppHandle, socks: State<'_, Sockets>, id: u32, port: u16, ip: String) -> Result<SocketInfo, String> {
  socks.inner().clone().listen(id, port, &ip, emitter(app)).await
}

#[tauri::command]
pub async fn sock_accept(app: tauri::AppHandle, socks: State<'_, Sockets>, id: u32, request_id: u32) -> Result<SocketInfo, String> {
  socks.inner().clone().accept(id, request_id, emitter(app)).await
}

#[tauri::command]
pub async fn sock_bind(app: tauri::AppHandle, socks: State<'_, Sockets>, id: u32, port: u16, ip: String) -> Result<SocketInfo, String> {
  socks.inner().clone().bind_udp(id, port, &ip, emitter(app)).await
}

/// `data` is base64.
#[tauri::command]
pub async fn sock_send(socks: State<'_, Sockets>, id: u32, data: String, host: String, port: u16) -> Result<(), String> {
  let bytes = B64.decode(data.as_bytes()).map_err(|_| "13|Type mismatch".to_string())?;
  socks.inner().clone().send(id, &bytes, &host, port).await
}

#[tauri::command]
pub fn sock_close(socks: State<'_, Sockets>, id: u32) {
  socks.close(id);
}

/// End of the program (or a new run): closes every socket and aborts every Inet request.
#[tauri::command]
pub fn net_reset(socks: State<'_, Sockets>, inet: State<'_, crate::inet::InetTasks>) {
  socks.close_all();
  inet.abort_all();
}

#[tauri::command]
pub fn net_local_ip() -> String {
  local_ip()
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::sync::mpsc;

  fn collector() -> (Emit, mpsc::UnboundedReceiver<SockEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(move |e| { let _ = tx.send(e); }), rx)
  }

  async fn next(rx: &mut mpsc::UnboundedReceiver<SockEvent>) -> SockEvent {
    tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("no event").expect("closed")
  }

  fn text(e: &SockEvent) -> (u32, String) {
    match e {
      SockEvent::Data { id, data, .. } => (*id, String::from_utf8(B64.decode(data).unwrap()).unwrap()),
      other => panic!("expected data, got {other:?}"),
    }
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn tcp_echo_on_localhost_listen_connect_send_receive_close() {
    let s = Sockets::default();
    let (emit, mut rx) = collector();
    // server: Winsock1.Listen on a free port
    let info = s.listen(1, 0, "127.0.0.1", emit.clone()).await.unwrap();
    assert!(info.local_port > 0);
    // client: Winsock2.Connect "127.0.0.1", port
    let c = s.connect(2, "127.0.0.1", info.local_port, emit.clone()).await.unwrap();
    assert_eq!(c.remote_port, info.local_port);
    assert_eq!(c.remote_ip, "127.0.0.1");
    let SockEvent::ConnectionRequest { id: 1, request_id, remote_port, .. } = next(&mut rx).await else { panic!("no ConnectionRequest") };
    assert_eq!(remote_port, c.local_port);
    // ConnectionRequest: Winsock1.Close: Winsock1.Accept requestID (here into socket 3; the listener stays open)
    let a = s.accept(3, request_id, emit.clone()).await.unwrap();
    assert_eq!(a.remote_port, c.local_port);
    assert!(s.accept(4, request_id, emit.clone()).await.unwrap_err().starts_with("40006|"));   // taken
    s.send(2, b"hello", "", 0).await.unwrap();
    let (id, got) = text(&next(&mut rx).await);
    assert_eq!((id, got.as_str()), (3, "hello"));
    s.send(3, got.as_bytes(), "", 0).await.unwrap();   // echo
    let (id, back) = text(&next(&mut rx).await);
    assert_eq!((id, back.as_str()), (2, "hello"));
    // the client closes: the server side gets Close
    s.close(2);
    assert_eq!(next(&mut rx).await, SockEvent::Close { id: 3 });
    assert!(s.send(2, b"x", "", 0).await.unwrap_err().starts_with("40006|"));
    s.close_all();
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn errors_have_winsock_numbers() {
    let s = Sockets::default();
    let (emit, _rx) = collector();
    let info = s.listen(1, 0, "127.0.0.1", emit.clone()).await.unwrap();
    // the port is taken
    assert!(s.listen(2, info.local_port, "127.0.0.1", emit.clone()).await.unwrap_err().starts_with("10048|"));
    s.close(1);
    tokio::time::sleep(Duration::from_millis(50)).await;
    // nobody listens any more
    assert!(s.connect(3, "127.0.0.1", info.local_port, emit.clone()).await.unwrap_err().starts_with("10061|"));
    assert!(s.connect(4, "", 80, emit).await.unwrap_err().starts_with("11001|"));
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn udp_datagrams_carry_their_sender() {
    let s = Sockets::default();
    let (emit, mut rx) = collector();
    let a = s.bind_udp(1, 0, "127.0.0.1", emit.clone()).await.unwrap();
    let b = s.bind_udp(2, 0, "127.0.0.1", emit).await.unwrap();
    s.send(2, b"ping", "127.0.0.1", a.local_port).await.unwrap();
    match next(&mut rx).await {
      SockEvent::Data { id: 1, data, remote_port, .. } => {
        assert_eq!(B64.decode(data).unwrap(), b"ping");
        assert_eq!(remote_port, b.local_port);
      }
      other => panic!("{other:?}"),
    }
    s.close_all();
  }
}
