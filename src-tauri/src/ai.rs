//! OpenAI-compatible AI proxy. Calls go through Rust (reqwest) to avoid CORS and mixed-content
//! limits in the webview. Works with Ollama (`http://<ip>:11434/v1`) and similar servers.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, State};
use tokio::task::AbortHandle;

const CHAT_TIMEOUT_SECS: u64 = 600;
/// Streaming: fail only when the server goes silent this long (reasoning models can think for minutes, but they stream).
const STREAM_IDLE_SECS: u64 = 90;
/// Streaming: safety cap for one whole answer.
const STREAM_TOTAL_SECS: u64 = 20 * 60;
const LIST_TIMEOUT_SECS: u64 = 15;
const CONNECT_TIMEOUT_SECS: u64 = 10;

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
  pub role: String,
  pub content: String,
}

/// "http://h:11434/v1/" + "chat/completions" -> "http://h:11434/v1/chat/completions"
pub fn endpoint(base_url: &str, path: &str) -> String {
  format!("{}/{}", base_url.trim().trim_end_matches('/'), path.trim_start_matches('/'))
}

fn unreadable() -> String {
  "The AI server sent an answer VibeBasic could not read.".to_string()
}

/// The innermost cause of a request error (e.g. "No route to host (os error 65)"), for the error text.
fn root_cause(e: &reqwest::Error) -> String {
  let mut cur: &dyn std::error::Error = e;
  while let Some(next) = cur.source() {
    cur = next;
  }
  cur.to_string()
}

fn map_send_error(e: &reqwest::Error, base_url: &str, timeout_secs: u64) -> String {
  eprintln!("ai request failed: {e:?}");
  if e.is_connect() {
    format!(
      "Could not connect to {base_url}. Check that the AI server is running and can be reached from this Mac. For Ollama on another PC, start Ollama with OLLAMA_HOST=0.0.0.0. (Details: {})",
      root_cause(e)
    )
  } else if e.is_timeout() {
    format!("The AI server did not answer within {timeout_secs} seconds.")
  } else if e.is_builder() {
    format!("The base URL \"{base_url}\" is not valid. It should look like http://192.168.1.10:11434/v1")
  } else if e.is_decode() || e.is_body() {
    unreadable()
  } else {
    format!(
      "Could not connect to {base_url}. Check that the AI server is running and can be reached from this Mac. For Ollama on another PC, start Ollama with OLLAMA_HOST=0.0.0.0. (Details: {})",
      root_cause(e)
    )
  }
}

/// `error.message` (OpenAI / Ollama) or a plain string `error` from a JSON error body.
fn body_message(body: &str) -> Option<String> {
  let v: Value = serde_json::from_str(body).ok()?;
  let e = v.get("error")?;
  let m = e.get("message").and_then(Value::as_str).or_else(|| e.as_str())?.trim();
  (!m.is_empty()).then(|| m.to_string())
}

fn status_error(status: reqwest::StatusCode, url: &str, body: &str) -> String {
  let code = status.as_u16();
  if code == 401 || code == 403 {
    return format!("The AI server refused the request ({code}). Check the API key.");
  }
  if let Some(m) = body_message(body) {
    return format!("The AI server answered {status}: {m}");
  }
  if code == 404 {
    return format!("The AI server answered 404 Not Found for {url}. Check the base URL. For Ollama it usually ends with /v1.");
  }
  let head: String = body.chars().take(200).collect();
  format!("The AI server answered {status}: {head}")
}

/// Sends the request and returns the parsed JSON body, or a readable error text.
async fn send_json(
  req: reqwest::RequestBuilder,
  base_url: &str,
  url: &str,
  api_key: &Option<String>,
  timeout_secs: u64,
) -> Result<Value, String> {
  let req = match api_key.as_deref().map(str::trim) {
    Some(k) if !k.is_empty() => req.bearer_auth(k),
    _ => req,
  };
  let resp = req.send().await.map_err(|e| map_send_error(&e, base_url, timeout_secs))?;
  let status = resp.status();
  let text = resp.text().await.map_err(|e| map_send_error(&e, base_url, timeout_secs))?;
  if !status.is_success() {
    return Err(status_error(status, url, &text));
  }
  serde_json::from_str::<Value>(&text).map_err(|_| unreadable())
}

fn client(timeout_secs: u64) -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
    .timeout(Duration::from_secs(timeout_secs))
    .build()
    .map_err(|e| format!("Could not start the AI request: {e}"))
}

pub async fn list_models(base_url: &str, api_key: &Option<String>) -> Result<Vec<String>, String> {
  let url = endpoint(base_url, "models");
  let c = client(LIST_TIMEOUT_SECS)?;
  let v = send_json(c.get(&url), base_url, &url, api_key, LIST_TIMEOUT_SECS).await?;
  let data = v.get("data").and_then(Value::as_array).ok_or_else(unreadable)?;
  Ok(data.iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string)).collect())
}

pub async fn chat(
  base_url: &str,
  api_key: &Option<String>,
  model: &str,
  messages: &[ChatMessage],
  reasoning_effort: &Option<String>,
) -> Result<String, String> {
  let url = endpoint(base_url, "chat/completions");
  let c = client(CHAT_TIMEOUT_SECS)?;
  let mut body = json!({ "model": model, "messages": messages, "temperature": 0.2, "stream": false });
  // vLLM/Qwen servers honour chat_template_kwargs.reasoning_effort; other servers get nothing extra.
  if let Some(e) = reasoning_effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
    body["chat_template_kwargs"] = json!({ "reasoning_effort": e });
  }
  let v = send_json(c.post(&url).json(&body), base_url, &url, api_key, CHAT_TIMEOUT_SECS).await?;
  reply_text(&v)
}

/// Incremental server-sent-events reader: feed raw bytes (chunks may split lines or UTF-8 sequences anywhere),
/// get back the `data` payload of every completed event. Comments (`:` lines) and other fields are ignored.
#[derive(Default)]
pub struct SseParser {
  buf: Vec<u8>,
  data: Vec<String>,
}

impl SseParser {
  fn line(&mut self, raw: &[u8], out: &mut Vec<String>) {
    let line = String::from_utf8_lossy(raw);
    let line = line.trim_end_matches('\r');
    if line.is_empty() {
      if !self.data.is_empty() {
        out.push(self.data.join("\n"));
        self.data.clear();
      }
    } else if let Some(rest) = line.strip_prefix("data:") {
      self.data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
    }
  }

  pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
    self.buf.extend_from_slice(bytes);
    let mut out = Vec::new();
    while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
      let raw: Vec<u8> = self.buf.drain(..=i).collect();
      self.line(&raw[..raw.len() - 1], &mut out);
    }
    out
  }

  /// The stream ended: a last event without its closing blank line still counts.
  pub fn finish(&mut self) -> Vec<String> {
    let mut out = Vec::new();
    if !self.buf.is_empty() {
      let raw = std::mem::take(&mut self.buf);
      self.line(&raw, &mut out);
    }
    self.line(b"", &mut out);
    out
  }
}

/// Like `chat`, but asks for `"stream": true` and calls `on_delta(kind, text)` ("reasoning" | "content") for every
/// piece as it arrives. Returns the same text as `chat`. A server that answers with plain JSON is read as usual.
pub async fn chat_stream(
  base_url: &str,
  api_key: &Option<String>,
  model: &str,
  messages: &[ChatMessage],
  reasoning_effort: &Option<String>,
  on_delta: &(dyn Fn(&str, &str) + Send + Sync),
) -> Result<String, String> {
  let idle = Duration::from_secs(STREAM_IDLE_SECS);
  let total = Duration::from_secs(STREAM_TOTAL_SECS);
  chat_stream_with(base_url, api_key, model, messages, reasoning_effort, on_delta, idle, total).await
}

fn idle_error(idle: Duration) -> String {
  format!("The AI server stopped sending for {} seconds.", idle.as_secs())
}

#[allow(clippy::too_many_arguments)]
async fn chat_stream_with(
  base_url: &str,
  api_key: &Option<String>,
  model: &str,
  messages: &[ChatMessage],
  reasoning_effort: &Option<String>,
  on_delta: &(dyn Fn(&str, &str) + Send + Sync),
  idle: Duration,
  total: Duration,
) -> Result<String, String> {
  let url = endpoint(base_url, "chat/completions");
  // No client-wide timeout: a long answer may legitimately stream for minutes. Instead: connect timeout, an idle
  // timeout (nothing received for `idle`) on every wait, and a safety cap on the whole answer.
  let c = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not start the AI request: {e}"))?;
  let mut body = json!({ "model": model, "messages": messages, "temperature": 0.2, "stream": true });
  if let Some(e) = reasoning_effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
    body["chat_template_kwargs"] = json!({ "reasoning_effort": e });
  }
  let mut req = c.post(&url).json(&body);
  if let Some(k) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
    req = req.bearer_auth(k);
  }
  let mut resp = tokio::time::timeout(idle, req.send())
    .await
    .map_err(|_| idle_error(idle))?
    .map_err(|e| map_send_error(&e, base_url, CHAT_TIMEOUT_SECS))?;
  let status = resp.status();
  if !status.is_success() {
    let text = resp.text().await.map_err(|e| map_send_error(&e, base_url, CHAT_TIMEOUT_SECS))?;
    return Err(status_error(status, &url, &text));
  }
  let is_json = resp
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .is_some_and(|t| t.to_ascii_lowercase().contains("json"));
  if is_json {
    let text = resp.text().await.map_err(|e| map_send_error(&e, base_url, CHAT_TIMEOUT_SECS))?;
    let v = serde_json::from_str::<Value>(&text).map_err(|_| unreadable())?;
    return reply_text(&v);
  }

  let mut parser = SseParser::default();
  let (mut content, mut reasoning) = (String::new(), String::new());
  let mut finish: Option<String> = None;
  let mut done = false;
  // A server that ignores `stream` and answers with plain JSON but no JSON content-type: sniffed below.
  let (mut raw, mut seen_event) = (Vec::<u8>::new(), false);
  let mut handle = |payload: &str| -> Result<bool, String> {
    let payload = payload.trim();
    if payload == "[DONE]" {
      return Ok(true);
    }
    let Ok(v) = serde_json::from_str::<Value>(payload) else { return Ok(false) };
    if v.get("error").is_some() {
      return Err(body_message(payload).unwrap_or_else(unreadable));
    }
    if let Some(f) = v.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
      finish = Some(f.to_string());
    }
    let delta = v.pointer("/choices/0/delta");
    let get = |name: &str| delta.and_then(|d| d.get(name)).and_then(Value::as_str).filter(|s| !s.is_empty());
    if let Some(t) = get("reasoning").or_else(|| get("reasoning_content")) {
      reasoning.push_str(t);
      on_delta("reasoning", t);
    }
    if let Some(t) = get("content") {
      content.push_str(t);
      on_delta("content", t);
    }
    Ok(false)
  };
  let read = async {
    'read: while let Some(chunk) = tokio::time::timeout(idle, resp.chunk())
      .await
      .map_err(|_| idle_error(idle))?
      .map_err(|e| map_send_error(&e, base_url, CHAT_TIMEOUT_SECS))?
    {
      let events = parser.push(&chunk);
      if !seen_event {
        if events.is_empty() && raw.len() < 4_000_000 {
          raw.extend_from_slice(&chunk);
        } else {
          seen_event = true;
          raw = Vec::new();
        }
      }
      for p in events {
        if handle(&p)? {
          done = true;
          break 'read;
        }
      }
    }
    if !done {
      for p in parser.finish() {
        if handle(&p)? {
          break;
        }
      }
    }
    Ok::<(), String>(())
  };
  tokio::time::timeout(total, read)
    .await
    .map_err(|_| format!("The AI server did not finish within {} minutes.", total.as_secs() / 60))??;
  if !seen_event && content.is_empty() && reasoning.is_empty() {
    if let Ok(v) = serde_json::from_slice::<Value>(&raw) {
      return reply_text(&v);
    }
  }
  reply_text(&json!({ "choices": [{ "message": { "content": content, "reasoning": reasoning }, "finish_reason": finish }] }))
}

/// The answer text of a chat reply. Reasoning models served with a reasoning parser (vLLM `--reasoning-parser`)
/// sometimes put the whole answer in `reasoning`/`reasoning_content` and leave `content` null; then that text is
/// used, since the code/JSON extractors find the answer inside it.
fn reply_text(v: &Value) -> Result<String, String> {
  let msg = v.pointer("/choices/0/message");
  let field = |name: &str| {
    msg.and_then(|m| m.get(name)).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
  };
  if let Some(c) = field("content") {
    return Ok(c);
  }
  if let Some(r) = field("reasoning").or_else(|| field("reasoning_content")) {
    return Ok(r);
  }
  let finish = v.pointer("/choices/0/finish_reason").and_then(Value::as_str).unwrap_or("none");
  Err(format!("{} (Details: the reply had no text; finish_reason = {finish}.)", unreadable()))
}

#[tauri::command]
pub async fn ai_list_models(base_url: String, api_key: Option<String>) -> Result<Vec<String>, String> {
  list_models(&base_url, &api_key).await
}

/// In-flight streaming requests by the id the frontend chose, so `ai_cancel` can abort them.
#[derive(Default)]
pub struct AiStreams(Mutex<HashMap<String, AbortHandle>>);

#[tauri::command]
pub async fn ai_chat(
  app: tauri::AppHandle,
  streams: State<'_, AiStreams>,
  base_url: String,
  api_key: Option<String>,
  model: String,
  messages: Vec<ChatMessage>,
  reasoning_effort: Option<String>,
  stream_id: Option<String>,
) -> Result<String, String> {
  let Some(id) = stream_id else {
    return chat(&base_url, &api_key, &model, &messages, &reasoning_effort).await;
  };
  let emit_id = id.clone();
  let task = tokio::spawn(async move {
    let on_delta = move |kind: &str, text: &str| {
      let _ = app.emit("ai:delta", json!({ "id": emit_id, "kind": kind, "text": text }));
    };
    chat_stream(&base_url, &api_key, &model, &messages, &reasoning_effort, &on_delta).await
  });
  streams.0.lock().unwrap().insert(id.clone(), task.abort_handle());
  let res = task.await;
  streams.0.lock().unwrap().remove(&id);
  match res {
    Ok(r) => r,
    Err(e) if e.is_cancelled() => Err("cancelled".to_string()),
    Err(_) => Err("The AI request stopped unexpectedly.".to_string()),
  }
}

/// Aborts the in-flight `ai_chat` with this stream id (its invoke then rejects with "cancelled").
#[tauri::command]
pub fn ai_cancel(streams: State<'_, AiStreams>, stream_id: String) {
  if let Some(h) = streams.0.lock().unwrap().remove(&stream_id) {
    h.abort();
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use httpmock::prelude::*;

  fn msgs() -> Vec<ChatMessage> {
    vec![ChatMessage { role: "user".into(), content: "hi".into() }]
  }

  #[test]
  fn endpoint_joins() {
    assert_eq!(endpoint("http://h:11434/v1/", "chat/completions"), "http://h:11434/v1/chat/completions");
    assert_eq!(endpoint("http://h:11434/v1", "models"), "http://h:11434/v1/models");
  }

  #[tokio::test]
  async fn chat_returns_content() {
    let server = MockServer::start();
    let m = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"model":"qwen","stream":false}"#);
      then.status(200).json_body(json!({"choices":[{"message":{"content":"hei"}}]}));
    });
    let r = chat(&server.url("/v1"), &None, "qwen", &msgs(), &None).await;
    assert_eq!(r.unwrap(), "hei");
    m.assert();
  }

  #[tokio::test]
  async fn reasoning_effort_in_body_only_when_set() {
    let server = MockServer::start();
    let with = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"chat_template_kwargs":{"reasoning_effort":"low"}}"#);
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"}}]}));
    });
    assert_eq!(chat(&server.url("/v1"), &None, "m", &msgs(), &Some("low".into())).await.unwrap(), "ok");
    with.assert();

    let server2 = MockServer::start();
    let without = server2.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").body_contains("chat_template_kwargs");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"x"}}]}));
    });
    let any = server2.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"}}]}));
    });
    assert_eq!(chat(&server2.url("/v1"), &None, "m", &msgs(), &None).await.unwrap(), "ok");
    assert_eq!(chat(&server2.url("/v1"), &None, "m", &msgs(), &Some("  ".into())).await.unwrap(), "ok");
    without.assert_hits(0);
    any.assert_hits(2);
  }

  #[test]
  fn reply_text_falls_back_to_reasoning() {
    let v = json!({"choices":[{"message":{"content":null,"reasoning":"think...\n```vb\nPrivate Sub A()\nEnd Sub\n```"},"finish_reason":"stop"}]});
    assert!(reply_text(&v).unwrap().contains("Private Sub A()"));
    let v = json!({"choices":[{"message":{"content":"","reasoning_content":"r"}}]});
    assert_eq!(reply_text(&v).unwrap(), "r");
    let v = json!({"choices":[{"message":{"content":"  hei "}}]});
    assert_eq!(reply_text(&v).unwrap(), "hei");
  }

  #[test]
  fn reply_text_reports_finish_reason() {
    let v = json!({"choices":[{"message":{"content":null},"finish_reason":"length"}]});
    let e = reply_text(&v).unwrap_err();
    assert!(e.starts_with("The AI server sent an answer VibeBasic could not read."));
    assert!(e.contains("finish_reason = length"));
  }

  #[tokio::test]
  async fn bearer_only_when_key() {
    let server = MockServer::start();
    let with = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").header("authorization", "Bearer k");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"}}]}));
    });
    assert_eq!(chat(&server.url("/v1"), &Some("k".into()), "m", &msgs(), &None).await.unwrap(), "ok");
    with.assert();

    let server2 = MockServer::start();
    let any = server2.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"}}]}));
    });
    let auth = server2.mock(|when, then| {
      when.header_exists("authorization");
      then.status(200).body("x");
    });
    assert_eq!(chat(&server2.url("/v1"), &Some(String::new()), "m", &msgs(), &None).await.unwrap(), "ok");
    any.assert();
    auth.assert_hits(0);
  }

  #[tokio::test]
  async fn models_list() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(GET).path("/v1/models");
      then.status(200).json_body(json!({"data":[{"id":"a"},{"id":"b"}]}));
    });
    assert_eq!(list_models(&server.url("/v1/"), &None).await.unwrap(), vec!["a", "b"]);
  }

  #[tokio::test]
  async fn not_found_message() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.any_request();
      then.status(404);
    });
    let e = chat(&server.url("/v1"), &None, "m", &msgs(), &None).await.unwrap_err();
    assert!(e.starts_with("The AI server answered 404 Not Found"), "{e}");
  }

  #[tokio::test]
  async fn error_message_from_json_body() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(404).json_body(json!({"error":{"message":"model \"x\" not found, try pulling it first"}}));
    });
    server.mock(|when, then| {
      when.method(GET).path("/v1/models");
      then.status(500).json_body(json!({"error":"out of memory"}));
    });
    let e = chat(&server.url("/v1"), &None, "x", &msgs(), &None).await.unwrap_err();
    assert_eq!(e, "The AI server answered 404 Not Found: model \"x\" not found, try pulling it first");
    let e = list_models(&server.url("/v1"), &None).await.unwrap_err();
    assert_eq!(e, "The AI server answered 500 Internal Server Error: out of memory");
  }

  #[tokio::test]
  async fn refused_and_other_status() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(GET).path("/v1/models");
      then.status(401);
    });
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(500).body("boom");
    });
    let e = list_models(&server.url("/v1"), &None).await.unwrap_err();
    assert_eq!(e, "The AI server refused the request (401). Check the API key.");
    let e = chat(&server.url("/v1"), &None, "m", &msgs(), &None).await.unwrap_err();
    assert!(e.starts_with("The AI server answered 500 Internal Server Error: boom"), "{e}");
  }

  #[tokio::test]
  async fn connection_refused_message() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let e = chat(&format!("http://127.0.0.1:{port}/v1"), &None, "m", &msgs(), &None).await.unwrap_err();
    assert!(e.starts_with("Could not connect to"), "{e}");
  }

  #[tokio::test]
  async fn garbage_body() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.any_request();
      then.status(200).body("hei");
    });
    let e = chat(&server.url("/v1"), &None, "m", &msgs(), &None).await.unwrap_err();
    assert_eq!(e, "The AI server sent an answer VibeBasic could not read.");
    let e = list_models(&server.url("/v1"), &None).await.unwrap_err();
    assert_eq!(e, "The AI server sent an answer VibeBasic could not read.");
  }

  fn sse(parts: &[&str]) -> String {
    parts.concat()
  }

  fn collect() -> (std::sync::Arc<Mutex<Vec<(String, String)>>>, impl Fn(&str, &str) + Send + Sync) {
    let got = std::sync::Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    (got, move |k: &str, t: &str| g.lock().unwrap().push((k.to_string(), t.to_string())))
  }

  #[test]
  fn sse_parser_handles_split_lines_and_multiple_events() {
    let mut p = SseParser::default();
    assert!(p.push(b": keep-alive\n\nda").is_empty());
    assert!(p.push(b"ta: {\"a\":1}\r").is_empty());
    assert_eq!(p.push(b"\n\r\ndata: {\"b\":2}\n\ndata: [DO"), vec!["{\"a\":1}", "{\"b\":2}"]);
    assert_eq!(p.push(b"NE]\n\n"), vec!["[DONE]"]);
    // multi-byte character split across chunks, unterminated last event
    let bytes = "data: {\"t\":\"\u{f8}\"}".as_bytes();
    assert!(p.push(&bytes[..13]).is_empty());
    assert!(p.push(&bytes[13..]).is_empty());
    assert_eq!(p.finish(), vec!["{\"t\":\"\u{f8}\"}"]);
  }

  fn delta(field: &str, text: &str) -> String {
    format!("data: {}\n\n", json!({"choices":[{"delta":{ field: text }}]}))
  }

  #[tokio::test]
  async fn stream_accumulates_reasoning_then_content() {
    let body = sse(&[
      ": ping\n\n",
      &delta("reasoning", "Think"),
      &delta("reasoning_content", "ing..."),
      &delta("content", "Hel"),
      &delta("content", "lo"),
      &format!("data: {}\n\n", json!({"choices":[{"delta":{},"finish_reason":"stop"}]})),
      "data: [DONE]\n\n",
      &delta("content", "NEVER"),
    ]);
    let server = MockServer::start();
    let m = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"stream":true}"#);
      then.status(200).header("content-type", "text/event-stream").body(body);
    });
    let (got, cb) = collect();
    let r = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &cb).await;
    assert_eq!(r.unwrap(), "Hello");
    m.assert();
    let got = got.lock().unwrap().clone();
    let pairs: Vec<(&str, &str)> = got.iter().map(|(k, t)| (k.as_str(), t.as_str())).collect();
    assert_eq!(pairs, vec![("reasoning", "Think"), ("reasoning", "ing..."), ("content", "Hel"), ("content", "lo")]);
  }

  #[tokio::test]
  async fn stream_falls_back_to_reasoning_and_reports_finish_reason() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "text/event-stream").body(sse(&[&delta("reasoning", "only thoughts"), "data: [DONE]\n\n"]));
    });
    let (_, cb) = collect();
    assert_eq!(chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &cb).await.unwrap(), "only thoughts");

    let server2 = MockServer::start();
    server2.mock(|when, then| {
      when.any_request();
      then.status(200).header("content-type", "text/event-stream")
        .body(format!("data: {}\n\n", json!({"choices":[{"delta":{},"finish_reason":"length"}]})));
    });
    let e = chat_stream(&server2.url("/v1"), &None, "m", &msgs(), &None, &cb).await.unwrap_err();
    assert!(e.starts_with("The AI server sent an answer VibeBasic could not read."), "{e}");
    assert!(e.contains("finish_reason = length"), "{e}");
  }

  #[tokio::test]
  async fn stream_without_done_and_json_fallback() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "text/event-stream").body(delta("content", "abc").trim_end());
    });
    let (got, cb) = collect();
    assert_eq!(chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &cb).await.unwrap(), "abc");
    assert_eq!(got.lock().unwrap().len(), 1);

    let server2 = MockServer::start();
    let m = server2.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"stream":true}"#);
      then.status(200).json_body(json!({"choices":[{"message":{"content":"plain"}}]}));
    });
    let (got2, cb2) = collect();
    assert_eq!(chat_stream(&server2.url("/v1"), &None, "m", &msgs(), &None, &cb2).await.unwrap(), "plain");
    m.assert();
    assert!(got2.lock().unwrap().is_empty());
  }

  #[tokio::test]
  async fn stream_idle_timeout() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "text/event-stream").delay(Duration::from_millis(1500)).body(delta("content", "late"));
    });
    let (_, cb) = collect();
    let e = chat_stream_with(&server.url("/v1"), &None, "m", &msgs(), &None, &cb, Duration::from_millis(200), Duration::from_secs(60))
      .await
      .unwrap_err();
    assert!(e.starts_with("The AI server stopped sending for"), "{e}");
    // a patient idle limit gets the answer
    let r = chat_stream_with(&server.url("/v1"), &None, "m", &msgs(), &None, &cb, Duration::from_secs(10), Duration::from_secs(60)).await;
    assert_eq!(r.unwrap(), "late");
    // the real limits
    assert_eq!(idle_error(Duration::from_secs(STREAM_IDLE_SECS)), "The AI server stopped sending for 90 seconds.");
    assert_eq!(CHAT_TIMEOUT_SECS, 600);
    assert_eq!(STREAM_TOTAL_SECS, 1200);
  }

  #[tokio::test]
  async fn stream_errors() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(404).json_body(json!({"error":{"message":"no such model"}}));
    });
    let (_, cb) = collect();
    let e = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &cb).await.unwrap_err();
    assert_eq!(e, "The AI server answered 404 Not Found: no such model");
    let server2 = MockServer::start();
    server2.mock(|when, then| {
      when.any_request();
      then.status(200).header("content-type", "text/event-stream").body("data: {\"error\":{\"message\":\"boom\"}}\n\n");
    });
    assert_eq!(chat_stream(&server2.url("/v1"), &None, "m", &msgs(), &None, &cb).await.unwrap_err(), "boom");
  }
}
