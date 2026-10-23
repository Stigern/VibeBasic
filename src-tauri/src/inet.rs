//! Inet (MSINET.OCX): the HTTP(S) requests of OpenURL and Execute, made with reqwest so the webview's CORS rules
//! do not apply. Errors are "number|description" with the Inet error numbers (35752 URL is malformed, 35761 Request timed out ...).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::State;
use tokio::task::AbortHandle;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InetResponse {
  /// 200, 404 ...
  pub status: u16,
  /// "OK", "Not Found" ...
  pub status_text: String,
  /// "HTTP/1.1"
  pub version: String,
  pub headers: Vec<(String, String)>,
  /// The body, base64.
  pub body: String,
}

pub struct InetRequest {
  pub url: String,
  pub method: String,
  /// "Name: value" lines (CR LF or LF), as the fourth argument of Execute.
  pub headers: String,
  pub body: Vec<u8>,
  /// RequestTimeout in seconds; 0 = no timeout.
  pub timeout_secs: u64,
  pub user_name: String,
  pub password: String,
}

fn fail(number: u32, description: &str) -> String {
  format!("{number}|{description}")
}

/// Sends one request and reads the whole answer. Any HTTP status is a success (OpenURL returns the error page too).
pub async fn request(r: &InetRequest) -> Result<InetResponse, String> {
  let url = reqwest::Url::parse(r.url.trim()).map_err(|_| fail(35752, "URL is malformed"))?;
  if url.scheme() != "http" && url.scheme() != "https" {
    return Err(fail(35753, "Protocol not supported for this method"));
  }
  let method = reqwest::Method::from_bytes(r.method.trim().to_uppercase().as_bytes()).map_err(|_| fail(35763, "Invalid operation"))?;
  let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(30));
  if r.timeout_secs > 0 {
    b = b.timeout(Duration::from_secs(r.timeout_secs));
  }
  let client = b.build().map_err(|e| fail(35750, &e.to_string()))?;
  let mut req = client.request(method, url);
  for line in r.headers.lines() {
    if let Some((k, v)) = line.split_once(':') {
      if !k.trim().is_empty() {
        req = req.header(k.trim(), v.trim());
      }
    }
  }
  if !r.user_name.is_empty() {
    req = req.basic_auth(&r.user_name, Some(&r.password));
  }
  if !r.body.is_empty() {
    req = req.body(r.body.clone());
  }
  let map = |e: reqwest::Error| -> String {
    if e.is_timeout() {
      fail(35761, "Request timed out")
    } else if e.is_connect() {
      fail(35754, "Unable to connect to remote host")
    } else {
      fail(35756, "Request to remote computer failed")
    }
  };
  let resp = req.send().await.map_err(map)?;
  let status = resp.status();
  let version = format!("{:?}", resp.version());
  let headers = resp
    .headers()
    .iter()
    .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
    .collect();
  let body = resp.bytes().await.map_err(map)?;
  Ok(InetResponse {
    status: status.as_u16(),
    status_text: status.canonical_reason().unwrap_or("").to_string(),
    version,
    headers,
    body: B64.encode(&body),
  })
}

/// Requests in flight by the id the frontend chose, so Cancel and the end of the program can abort them.
#[derive(Default)]
pub struct InetTasks(Mutex<HashMap<String, AbortHandle>>);

impl InetTasks {
  pub fn abort_all(&self) {
    for (_, h) in self.0.lock().unwrap().drain() {
      h.abort();
    }
  }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn inet_request(
  tasks: State<'_, InetTasks>,
  id: String,
  url: String,
  method: String,
  headers: String,
  body: String,
  timeout_secs: u64,
  user_name: String,
  password: String,
) -> Result<InetResponse, String> {
  let body = B64.decode(body.as_bytes()).map_err(|_| fail(13, "Type mismatch"))?;
  let r = InetRequest { url, method, headers, body, timeout_secs, user_name, password };
  let task = tokio::spawn(async move { request(&r).await });
  tasks.0.lock().unwrap().insert(id.clone(), task.abort_handle());
  let res = task.await;
  tasks.0.lock().unwrap().remove(&id);
  match res {
    Ok(r) => r,
    Err(e) if e.is_cancelled() => Err(fail(35764, "Operation cancelled")),
    Err(_) => Err(fail(35756, "Request to remote computer failed")),
  }
}

/// Inet.Cancel: aborts the request with this id (its invoke rejects).
#[tauri::command]
pub fn inet_cancel(tasks: State<'_, InetTasks>, id: String) {
  if let Some(h) = tasks.0.lock().unwrap().remove(&id) {
    h.abort();
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use httpmock::prelude::*;

  fn req(url: String, method: &str) -> InetRequest {
    InetRequest { url, method: method.into(), headers: String::new(), body: vec![], timeout_secs: 60, user_name: String::new(), password: String::new() }
  }

  #[tokio::test]
  async fn get_returns_status_headers_and_body() {
    let server = MockServer::start();
    let m = server.mock(|when, then| {
      when.method(GET).path("/page").header("x-ask", "1");
      then.status(200).header("X-Test", "yes").body("hei på deg");
    });
    let mut r = req(server.url("/page"), "get");
    r.headers = "X-Ask: 1\r\n".into();
    let resp = request(&r).await.unwrap();
    m.assert();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.status_text, "OK");
    assert!(resp.headers.iter().any(|(k, v)| k == "x-test" && v == "yes"));
    assert_eq!(B64.decode(resp.body).unwrap(), "hei på deg".as_bytes());
  }

  #[tokio::test]
  async fn post_sends_the_body_and_an_error_status_is_still_an_answer() {
    let server = MockServer::start();
    let m = server.mock(|when, then| {
      when.method(POST).path("/form").body("a=1");
      then.status(404).body("nope");
    });
    let mut r = req(server.url("/form"), "POST");
    r.body = b"a=1".to_vec();
    let resp = request(&r).await.unwrap();
    m.assert();
    assert_eq!(resp.status, 404);
    assert_eq!(B64.decode(resp.body).unwrap(), b"nope");
  }

  #[tokio::test]
  async fn bad_urls_and_schemes_are_inet_errors() {
    assert!(request(&req("not a url".into(), "GET")).await.unwrap_err().starts_with("35752|"));
    assert!(request(&req("ftp://example.com/x".into(), "GET")).await.unwrap_err().starts_with("35753|"));
  }
}
