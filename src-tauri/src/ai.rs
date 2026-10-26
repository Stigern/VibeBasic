//! OpenAI-compatible AI proxy. Calls go through Rust (reqwest) to avoid CORS and mixed-content
//! limits in the webview. Works with Ollama (`http://<ip>:11434/v1`) and similar servers.

use std::collections::{HashMap, HashSet};
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
/// Size caps: a plain (non-streamed) body, one SSE line, and all bytes of one streamed answer.
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_SSE_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
  pub role: String,
  /// A string, or an array of OpenAI-style parts (text and image_url) for a message with a picture.
  pub content: Value,
}

/// "http://h:11434/v1/" + "chat/completions" -> "http://h:11434/v1/chat/completions"
pub fn endpoint(base_url: &str, path: &str) -> String {
  format!("{}/{}", base_url.trim().trim_end_matches('/'), path.trim_start_matches('/'))
}

fn unreadable() -> String {
  "The AI server sent an answer VibeBasic could not read.".to_string()
}

/// The server stopped at max_tokens (finish_reason "length"). Same text as AI_CUT_OFF in src/ai/sse.ts.
fn cut_off() -> String {
  "Output token limit reached (finish_reason = length). The output budget includes reasoning and the final answer; this does not mean the full context window is exhausted. Increase Output budget (tokens), choose a lower Thinking level, or ask for less at a time. VibeBasic will not retry automatically.".to_string()
}

/// Optional request fields the frontend may add: `response_format` (OpenAI structured output), `structured_outputs`
/// (vLLM's own field; the frontend sends one or the other, never both), `max_tokens`, and `presence_penalty` (the retry after
/// an answer that repeated itself).
#[derive(Default, Clone)]
pub struct ChatExtra {
  pub response_format: Option<Value>,
  pub structured_outputs: Option<Value>,
  pub max_tokens: Option<u64>,
  pub presence_penalty: Option<f64>,
  pub tools: Option<Value>,
  pub tool_choice: Option<Value>,
}

/// The chat/completions body. vLLM/Qwen servers honour chat_template_kwargs.reasoning_effort; other servers get nothing extra.
fn chat_body(model: &str, messages: &[ChatMessage], reasoning_effort: &Option<String>, extra: &ChatExtra, stream: bool) -> Value {
  let mut body = json!({ "model": model, "messages": messages, "temperature": 0.2, "stream": stream });
  if stream {
    body["stream_options"] = json!({ "include_usage": true });
  }
  if let Some(e) = reasoning_effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
    body["chat_template_kwargs"] = json!({ "reasoning_effort": e });
  }
  if let Some(n) = extra.max_tokens.filter(|n| *n > 0) {
    body["max_tokens"] = json!(n);
  }
  if let Some(f) = extra.response_format.as_ref().filter(|f| !f.is_null()) {
    body["response_format"] = f.clone();
  }
  if let Some(f) = extra.structured_outputs.as_ref().filter(|f| !f.is_null()) {
    body["structured_outputs"] = f.clone();
  }
  if let Some(v) = extra.presence_penalty {
    body["presence_penalty"] = json!(v);
  }
  if let Some(v) = extra.tools.as_ref().filter(|v| !v.is_null()) {
    body["tools"] = v.clone();
  }
  if let Some(v) = extra.tool_choice.as_ref().filter(|v| !v.is_null()) {
    body["tool_choice"] = v.clone();
  }
  body
}

/// Inspect typed causes rather than parsing platform-specific error text.
fn connection_refused(e: &reqwest::Error) -> bool {
  let mut cause: &(dyn std::error::Error + 'static) = e;
  loop {
    if cause.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::ConnectionRefused) {
      return true;
    }
    match cause.source() {
      Some(next) => cause = next,
      None => return false,
    }
  }
}

/// `url` without userinfo, query and fragment, so a key in the base URL never reaches the log or the UI.
/// An unparsable value is cut at the first `@`, `?` or `#`.
fn redact_url(url: &str) -> String {
  let url = url.trim();
  if let Ok(mut u) = reqwest::Url::parse(url) {
    if u.cannot_be_a_base() {
      return "the base URL".to_string();
    }
    let _ = u.set_username("");
    let _ = u.set_password(None);
    u.set_query(None);
    u.set_fragment(None);
    return u.to_string();
  }
  let end = url.find(['?', '#']).unwrap_or(url.len());
  let head = &url[..end];
  match (head.find("://"), head.rfind('@')) {
    (Some(i), Some(at)) if at > i => format!("{}{}", &head[..i + 3], &head[at + 1..]),
    (None, Some(at)) => head[at + 1..].to_string(),
    _ => head.to_string(),
  }
}

fn too_large() -> String {
  "The AI server sent a much larger answer than expected, so VibeBasic stopped reading it.".to_string()
}

/// Reads a response body in chunks, at most `cap` bytes. The bool is true when the body was longer (then the
/// text is only its start).
async fn read_limited(resp: &mut reqwest::Response, cap: usize, base_url: &str, timeout_secs: u64) -> Result<(String, bool), String> {
  read_limited_with_idle(resp, cap, base_url, timeout_secs, None).await
}

async fn read_limited_with_idle(resp: &mut reqwest::Response, cap: usize, base_url: &str, timeout_secs: u64, idle: Option<Duration>) -> Result<(String, bool), String> {
  if resp.content_length().is_some_and(|n| n > cap as u64) {
    return Ok((String::new(), true));
  }
  let mut buf = Vec::<u8>::new();
  loop {
    let next = match idle {
      Some(limit) => tokio::time::timeout(limit, resp.chunk()).await.map_err(|_| idle_error(limit))?,
      None => resp.chunk().await,
    };
    let Some(chunk) = next.map_err(|e| map_send_error(&e, base_url, timeout_secs))? else { break };
    if buf.len() + chunk.len() > cap {
      buf.extend_from_slice(&chunk[..cap - buf.len()]);
      return Ok((String::from_utf8_lossy(&buf).into_owned(), true));
    }
    buf.extend_from_slice(&chunk);
  }
  Ok((String::from_utf8_lossy(&buf).into_owned(), false))
}

fn map_send_error(e: &reqwest::Error, base_url: &str, timeout_secs: u64) -> String {
  let base_url = redact_url(base_url);
  let base_url = base_url.as_str();
  if e.is_timeout() {
    format!("The AI server did not answer within {timeout_secs} seconds (timeout).")
  } else if e.is_connect() && connection_refused(e) {
    format!("The AI connection was refused at {base_url}. Check that the server is running and listening on this address and port.")
  } else if e.is_connect() {
    format!("Could not connect to {base_url}. Check the server address and that it can be reached from this computer.")
  } else if e.is_builder() {
    format!("The base URL \"{base_url}\" is not valid. It should look like http://192.168.1.10:11434/v1")
  } else if e.is_decode() || e.is_body() {
    "The AI response was interrupted before it was complete.".to_string()
  } else {
    format!("Could not connect to {base_url}. Check the server address and that it can be reached from this computer.")
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
  let url = redact_url(url);
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
  let mut resp = req.send().await.map_err(|e| map_send_error(&e, base_url, timeout_secs))?;
  let status = resp.status();
  let (text, truncated) = read_limited(&mut resp, MAX_BODY_BYTES, base_url, timeout_secs).await?;
  if !status.is_success() {
    return Err(status_error(status, url, &text));
  }
  if truncated {
    return Err(too_large());
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

/// A model from `GET /models`: its id and, when the server reports it, its context size in tokens
/// (vLLM `max_model_len`, some other servers `context_length`), and `owned_by` ("vllm" on vLLM).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
  pub id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub context_tokens: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub owned_by: Option<String>,
}

pub async fn list_models(base_url: &str, api_key: &Option<String>) -> Result<Vec<ModelInfo>, String> {
  let url = endpoint(base_url, "models");
  let c = client(LIST_TIMEOUT_SECS)?;
  let v = send_json(c.get(&url), base_url, &url, api_key, LIST_TIMEOUT_SECS).await?;
  let data = v.get("data").and_then(Value::as_array).ok_or_else(unreadable)?;
  Ok(data.iter().filter_map(|m| {
    let id = m.get("id").and_then(Value::as_str)?.to_string();
    let context_tokens = ["max_model_len", "context_length"].iter().find_map(|k| m.get(*k).and_then(Value::as_u64)).filter(|n| *n > 0);
    let owned_by = m.get("owned_by").and_then(Value::as_str).map(str::to_string);
    Some(ModelInfo { id, context_tokens, owned_by })
  }).collect())
}

pub async fn chat(
  base_url: &str,
  api_key: &Option<String>,
  model: &str,
  messages: &[ChatMessage],
  reasoning_effort: &Option<String>,
  extra: &ChatExtra,
) -> Result<String, String> {
  let url = endpoint(base_url, "chat/completions");
  let c = client(CHAT_TIMEOUT_SECS)?;
  let body = chat_body(model, messages, reasoning_effort, extra, false);
  let v = send_json(c.post(&url).json(&body), base_url, &url, api_key, CHAT_TIMEOUT_SECS).await?;
  reply_text(&v)
}

/// Incremental server-sent-events reader: feed raw bytes (chunks may split lines or UTF-8 sequences anywhere),
/// get back the `data` payload of every completed event. Comments (`:` lines) and other fields are ignored.
#[derive(Default)]
pub struct SseParser {
  buf: Vec<u8>,
  /// How much of `buf` is already known to hold no newline (so a long line is not rescanned on every chunk).
  scanned: usize,
  /// A line grew past MAX_SSE_LINE_BYTES without a newline.
  overflow: bool,
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
    while let Some(i) = self.buf[self.scanned..].iter().position(|&b| b == b'\n') {
      let raw: Vec<u8> = self.buf.drain(..=self.scanned + i).collect();
      self.scanned = 0;
      self.line(&raw[..raw.len() - 1], &mut out);
    }
    self.scanned = self.buf.len();
    if self.buf.len() > MAX_SSE_LINE_BYTES {
      self.overflow = true;
      self.buf.clear();
      self.scanned = 0;
    }
    out
  }

  /// True once a single line exceeded the cap; the caller should stop reading.
  pub fn overflowed(&self) -> bool {
    self.overflow
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

/// Token counts the server reports in the last streamed chunk (`stream_options.include_usage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Usage {
  pub prompt_tokens: u64,
  pub completion_tokens: u64,
  pub cached_tokens: Option<u64>,
  pub reasoning_tokens: Option<u64>,
}

/// The `usage` object of a chunk, if it has one with a prompt token count.
fn read_usage(v: &Value) -> Option<Usage> {
  let u = v.get("usage").filter(|u| u.is_object())?;
  let n = |p: &str| u.pointer(p).and_then(Value::as_u64);
  Some(Usage {
    prompt_tokens: n("/prompt_tokens")?,
    completion_tokens: n("/completion_tokens").unwrap_or(0),
    cached_tokens: n("/prompt_tokens_details/cached_tokens"),
    reasoning_tokens: n("/completion_tokens_details/reasoning_tokens"),
  })
}

/// Like `chat`, but asks for `"stream": true` and calls `on_delta(kind, text)` ("reasoning" | "content") for every
/// piece as it arrives. Returns the same text as `chat`. A server that answers with plain JSON is read as usual.
#[allow(dead_code)] // Compatibility wrapper for callers without response/tool observers.
pub async fn chat_stream(
  base_url: &str,
  api_key: &Option<String>,
  model: &str,
  messages: &[ChatMessage],
  reasoning_effort: &Option<String>,
  extra: &ChatExtra,
  on_delta: &(dyn Fn(&str, &str) + Send + Sync),
  on_usage: &(dyn Fn(Usage) + Send + Sync),
) -> Result<String, String> {
  let idle = Duration::from_secs(STREAM_IDLE_SECS);
  let total = Duration::from_secs(STREAM_TOTAL_SECS);
  chat_stream_with(base_url, api_key, model, messages, reasoning_effort, extra, on_delta, on_usage, idle, total).await
}

fn idle_error(idle: Duration) -> String {
  format!("The AI server stopped sending for {} seconds.", idle.as_secs())
}

#[allow(dead_code, clippy::too_many_arguments)]
async fn chat_stream_with(
  base_url: &str,
  api_key: &Option<String>,
  model: &str,
  messages: &[ChatMessage],
  reasoning_effort: &Option<String>,
  extra: &ChatExtra,
  on_delta: &(dyn Fn(&str, &str) + Send + Sync),
  on_usage: &(dyn Fn(Usage) + Send + Sync),
  idle: Duration,
  total: Duration,
) -> Result<String, String> {
  chat_stream_observed(base_url, api_key, model, messages, reasoning_effort, extra, on_delta, on_usage,
    None, &|_| {}, &|_| {}, idle, total).await
}

#[allow(clippy::too_many_arguments)]
async fn chat_stream_observed(
  base_url: &str,
  api_key: &Option<String>,
  model: &str,
  messages: &[ChatMessage],
  reasoning_effort: &Option<String>,
  extra: &ChatExtra,
  on_delta: &(dyn Fn(&str, &str) + Send + Sync),
  on_usage: &(dyn Fn(Usage) + Send + Sync),
  client_request_id: Option<&str>,
  on_response: &(dyn Fn(Value) + Send + Sync),
  on_tool_call: &(dyn Fn(Value) + Send + Sync),
  idle: Duration,
  total: Duration,
) -> Result<String, String> {
  let deadline = tokio::time::Instant::now() + total;
  let url = endpoint(base_url, "chat/completions");
  // No client-wide timeout: a long answer may legitimately stream for minutes. Instead: connect timeout, an idle
  // timeout (nothing received for `idle`) on every wait, and a safety cap on the whole answer.
  let c = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not start the AI request: {e}"))?;
  let body = chat_body(model, messages, reasoning_effort, extra, true);
  let mut req = c.post(&url).json(&body);
  if let Some(id) = client_request_id { req = req.header("X-Client-Request-Id", id); }
  if let Some(k) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
    req = req.bearer_auth(k);
  }
  let mut resp = tokio::time::timeout(idle.min(total), req.send())
    .await
    .map_err(|_| idle_error(idle))?
    .map_err(|e| map_send_error(&e, base_url, CHAT_TIMEOUT_SECS))?;
  let status = resp.status();
  let request_id = ["x-request-id", "request-id", "openai-request-id"].iter()
    .find_map(|name| resp.headers().get(*name).and_then(|v| v.to_str().ok())).map(str::to_string);
  on_response(json!({"http_status":status.as_u16(), "request_id":request_id}));
  let observe_metadata = |v: &Value| {
    if let Some(id) = request_id.as_deref().or_else(|| v.get("id").and_then(Value::as_str)) {
      on_response(json!({"request_id":id}));
    }
    if let Some(u) = read_usage(v) { on_usage(u); }
    if let Some(f) = v.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
      on_response(json!({"finish_reason":f}));
    }
  };
  let observe_json = |v: &Value| {
    observe_metadata(v);
    let msg = v.pointer("/choices/0/message");
    let field = |name: &str| msg.and_then(|m| m.get(name)).and_then(Value::as_str).filter(|s| !s.is_empty());
    if let Some(t) = field("reasoning").or_else(|| field("reasoning_content")) {
      on_delta("reasoning", t);
    }
    if let Some(t) = field("content") { on_delta("content", t); }
    if let Some(calls) = v.pointer("/choices/0/message/tool_calls").and_then(Value::as_array) {
      for (index, call) in calls.iter().enumerate() {
        let mut call = call.clone();
        call["index"] = json!(index);
        on_tool_call(call);
      }
    }
  };
  if !status.is_success() {
    let (text, _) = tokio::time::timeout_at(deadline,
      read_limited_with_idle(&mut resp, MAX_BODY_BYTES, base_url, CHAT_TIMEOUT_SECS, Some(idle)))
      .await.map_err(|_| format!("The AI server did not finish within {} minutes (timeout).", total.as_secs() / 60))??;
    return Err(status_error(status, &url, &text));
  }
  let is_json = resp
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .is_some_and(|t| t.to_ascii_lowercase().contains("json"));
  if is_json {
    let (text, truncated) = tokio::time::timeout_at(deadline,
      read_limited_with_idle(&mut resp, MAX_BODY_BYTES, base_url, CHAT_TIMEOUT_SECS, Some(idle)))
      .await.map_err(|_| format!("The AI server did not finish within {} minutes (timeout).", total.as_secs() / 60))??;
    if truncated {
      return Err(too_large());
    }
    let v = serde_json::from_str::<Value>(&text).map_err(|_| unreadable())?;
    observe_json(&v);
    return reply_text(&v);
  }

  let mut parser = SseParser::default();
  let (mut content, mut reasoning) = (String::new(), String::new());
  let mut finish: Option<String> = None;
  let mut done = false;
  let mut tool_calls = Vec::new();
  let mut total_bytes = 0usize;
  // A server that ignores `stream` and answers with plain JSON but no JSON content-type: sniffed below.
  let (mut raw, mut seen_event) = (Vec::<u8>::new(), false);
  let mut handle = |payload: &str| -> Result<bool, String> {
    let payload = payload.trim();
    if payload == "[DONE]" {
      return Ok(true);
    }
    let v = serde_json::from_str::<Value>(payload).map_err(|_| unreadable())?;
    observe_metadata(&v);
    if let Some(f) = v.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
      if finish.as_deref() != Some("length") { finish = Some(f.to_string()); }
    }
    // Provider errors may carry final usage and termination metadata too.
    if v.get("error").is_some_and(|e| !e.is_null()) {
      return Err(body_message(payload).unwrap_or_else(unreadable));
    }
    let delta = v.pointer("/choices/0/delta");
    if let Some(calls) = delta.and_then(|d| d.get("tool_calls")).and_then(Value::as_array) {
      for call in calls {
        tool_calls.push(call.clone());
        on_tool_call(call.clone());
      }
    }
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
      total_bytes += chunk.len();
      let events = parser.push(&chunk);
      if total_bytes > MAX_STREAM_BYTES || parser.overflowed() {
        return Err(too_large());
      }
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
  let read_result = tokio::time::timeout_at(deadline, read)
    .await
    .map_err(|_| format!("The AI server did not finish within {} minutes.", total.as_secs() / 60))
    .and_then(|result| result);
  // Once the server reports the output limit, a later dropped connection cannot make it retryable.
  if finish.as_deref() == Some("length") { return Err(cut_off()); }
  read_result?;
  if !seen_event && content.is_empty() && reasoning.is_empty() {
    if let Ok(v) = serde_json::from_slice::<Value>(&raw) {
      observe_json(&v);
      return reply_text(&v);
    }
  }
  reply_text(&json!({ "choices": [{ "message": { "content": content, "reasoning": reasoning, "tool_calls": tool_calls }, "finish_reason": finish }] }))
}

/// Final answer only: reasoning and tool calls never become answer text.
fn reply_text(v: &Value) -> Result<String, String> {
  let finish = v.pointer("/choices/0/finish_reason").and_then(Value::as_str);
  if finish == Some("length") {
    return Err(cut_off());
  }
  if v.get("error").is_some_and(|e| !e.is_null()) {
    return Err(body_message(&v.to_string()).unwrap_or_else(unreadable));
  }
  if finish.is_none() {
    return Err("The AI response was incomplete: no finish_reason was received.".to_string());
  }
  let msg = v.pointer("/choices/0/message");
  if matches!(finish, Some("tool_calls" | "function_call")) || msg.and_then(|m| m.get("tool_calls")).and_then(Value::as_array).is_some_and(|v| !v.is_empty()) {
    return Err("The AI server requested tool calls; no final answer was produced.".to_string());
  }
  if finish != Some("stop") {
    return Err(format!("The AI response ended before completion (finish_reason = {}).", finish.unwrap_or("none")));
  }
  let field = |name: &str| {
    msg.and_then(|m| m.get(name)).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
  };
  if let Some(c) = field("content") {
    return Ok(c);
  }
  if field("reasoning").or_else(|| field("reasoning_content")).is_some() {
    return Err("The AI server returned reasoning without a final answer.".to_string());
  }
  let finish = finish.unwrap_or("none");
  Err(format!("{} (Details: the reply had no text; finish_reason = {finish}.)", unreadable()))
}

#[tauri::command]
pub async fn ai_list_models(base_url: String, api_key: Option<String>) -> Result<Vec<ModelInfo>, String> {
  list_models(&base_url, &api_key).await
}

/// In-flight streaming requests by the id the frontend chose, so `ai_cancel` can abort them.
#[derive(Default)]
pub struct AiStreams(Mutex<StreamTable>);

#[derive(Default)]
struct StreamTable {
  handles: HashMap<String, AbortHandle>,
  /// Ids whose cancel arrived before their request was registered.
  cancelled: HashSet<String>,
}

/// Bounds the cancelled-before-start set (a cancel for a finished request is never consumed).
const MAX_PENDING_CANCELS: usize = 256;

impl AiStreams {
  /// Registers a running request. Returns false (and aborts it) when a cancel for `id` already arrived.
  pub(crate) fn register(&self, id: &str, handle: AbortHandle) -> bool {
    let mut t = self.0.lock().unwrap();
    if t.cancelled.remove(id) {
      handle.abort();
      return false;
    }
    t.handles.insert(id.to_string(), handle);
    true
  }

  pub(crate) fn finish(&self, id: &str) {
    let mut t = self.0.lock().unwrap();
    t.handles.remove(id);
    t.cancelled.remove(id);
  }

  /// Aborts a running request, or remembers the id so a request that registers later is aborted at once.
  fn cancel(&self, id: &str) {
    let mut t = self.0.lock().unwrap();
    if let Some(h) = t.handles.remove(id) {
      h.abort();
    } else {
      if t.cancelled.len() >= MAX_PENDING_CANCELS {
        t.cancelled.clear();
      }
      t.cancelled.insert(id.to_string());
    }
  }
}

#[tauri::command]
pub async fn ai_chat(
  app: tauri::AppHandle,
  streams: State<'_, AiStreams>,
  base_url: String,
  api_key: Option<String>,
  model: String,
  messages: Vec<ChatMessage>,
  reasoning_effort: Option<String>,
  response_format: Option<Value>,
  structured_outputs: Option<Value>,
  max_tokens: Option<u64>,
  presence_penalty: Option<f64>,
  tools: Option<Value>,
  tool_choice: Option<Value>,
  stream_id: Option<String>,
) -> Result<String, String> {
  let extra = ChatExtra { response_format, structured_outputs, max_tokens, presence_penalty, tools, tool_choice };
  let Some(id) = stream_id else {
    return chat(&base_url, &api_key, &model, &messages, &reasoning_effort, &extra).await;
  };
  let emit_id = id.clone();
  let id_for_usage = id.clone();
  let app2 = app.clone();
  let app_response = app.clone();
  let app_tools = app.clone();
  let response_id = id.clone();
  let tool_id = id.clone();
  let client_id = id.clone();
  let task = tokio::spawn(async move {
    let on_delta = move |kind: &str, text: &str| {
      let _ = app.emit_to("main", "ai:delta", json!({ "id": emit_id, "kind": kind, "text": text }));
    };
    let emit_id = id_for_usage;
    let on_usage = move |u: Usage| {
      let _ = app2.emit_to("main", "ai:usage", json!({ "id": emit_id, "prompt_tokens": u.prompt_tokens, "completion_tokens": u.completion_tokens, "cached_tokens": u.cached_tokens, "reasoning_tokens":u.reasoning_tokens }));
    };
    let on_response = move |mut v: Value| {
      v["id"] = json!(response_id);
      let _ = app_response.emit_to("main", "ai:response", v);
    };
    let on_tool_call = move |v: Value| {
      let _ = app_tools.emit_to("main", "ai:tool_call", json!({"id":tool_id,"tool_call":v}));
    };
    chat_stream_observed(&base_url, &api_key, &model, &messages, &reasoning_effort, &extra, &on_delta, &on_usage,
      Some(&client_id), &on_response, &on_tool_call, Duration::from_secs(STREAM_IDLE_SECS), Duration::from_secs(STREAM_TOTAL_SECS)).await
  });
  streams.register(&id, task.abort_handle());
  let res = task.await;
  streams.finish(&id);
  match res {
    Ok(r) => r,
    Err(e) if e.is_cancelled() => Err("cancelled".to_string()),
    Err(_) => Err("The AI request stopped unexpectedly.".to_string()),
  }
}

/// Aborts the in-flight `ai_chat` with this stream id (its invoke then rejects with "cancelled").
#[tauri::command]
pub fn ai_cancel(streams: State<'_, AiStreams>, stream_id: String) {
  streams.cancel(&stream_id);
}

#[cfg(test)]
mod tests {
  use super::*;
  use httpmock::prelude::*;

  const NONE: ChatExtra = ChatExtra { response_format: None, structured_outputs: None, max_tokens: None, presence_penalty: None, tools: None, tool_choice: None };

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
      then.status(200).json_body(json!({"choices":[{"message":{"content":"hei"},"finish_reason":"stop"}]}));
    });
    let r = chat(&server.url("/v1"), &None, "qwen", &msgs(), &None, &NONE).await;
    assert_eq!(r.unwrap(), "hei");
    m.assert();
  }

  #[tokio::test]
  async fn reasoning_effort_in_body_only_when_set() {
    let server = MockServer::start();
    let with = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"chat_template_kwargs":{"reasoning_effort":"low"}}"#);
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}));
    });
    assert_eq!(chat(&server.url("/v1"), &None, "m", &msgs(), &Some("low".into()), &NONE).await.unwrap(), "ok");
    with.assert();

    let server2 = MockServer::start();
    let without = server2.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").body_contains("chat_template_kwargs");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"x"},"finish_reason":"stop"}]}));
    });
    let any = server2.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}));
    });
    assert_eq!(chat(&server2.url("/v1"), &None, "m", &msgs(), &None, &NONE).await.unwrap(), "ok");
    assert_eq!(chat(&server2.url("/v1"), &None, "m", &msgs(), &Some("  ".into()), &NONE).await.unwrap(), "ok");
    without.assert_hits(0);
    any.assert_hits(2);
  }

  #[test]
  fn reply_text_rejects_reasoning_only_tools_and_missing_finish() {
    for field in ["reasoning", "reasoning_content"] {
      let v = json!({"choices":[{"message":{"content":null,field:"private thoughts"},"finish_reason":"stop"}]});
      assert_eq!(reply_text(&v).unwrap_err(), "The AI server returned reasoning without a final answer.");
    }
    let v = json!({"choices":[{"message":{"content":null,"tool_calls":[{"id":"call1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]});
    assert_eq!(reply_text(&v).unwrap_err(), "The AI server requested tool calls; no final answer was produced.");
    let v = json!({"choices":[{"message":{"content":"partial"}}]});
    assert!(reply_text(&v).unwrap_err().contains("incomplete"));
  }

  #[test]
  fn reply_text_reports_finish_reason() {
    let v = json!({"choices":[{"message":{"content":null},"finish_reason":"stop"}]});
    let e = reply_text(&v).unwrap_err();
    assert!(e.starts_with("The AI server sent an answer VibeBasic could not read."));
    assert!(e.contains("finish_reason = stop"));
    // cut off at max_tokens, even with some text: the cut-off message
    let v = json!({"choices":[{"message":{"content":"{\"ops\":["},"finish_reason":"length"}]});
    let e = reply_text(&v).unwrap_err();
    assert!(e.starts_with("Output token limit reached") && e.contains("output budget"), "{e}");
  }

  #[tokio::test]
  async fn response_format_and_max_tokens_passed_through() {
    let rf = json!({"type":"json_schema","json_schema":{"name":"form_ops","schema":{"type":"object"}}});
    let extra = ChatExtra { response_format: Some(rf.clone()), max_tokens: Some(8192), ..Default::default() };
    let want = json!({"response_format": rf, "max_tokens": 8192}).to_string();
    let server = MockServer::start();
    let plain = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(want.clone()).json_body_partial(r#"{"stream":false}"#);
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}));
    });
    let streamed = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(want.clone()).json_body_partial(r#"{"stream":true}"#);
      then.status(200).header("content-type", "text/event-stream").body(sse(&[&delta("content", "ok"), &stop(), "data: [DONE]\n\n"]));
    });
    assert_eq!(chat(&server.url("/v1"), &None, "m", &msgs(), &None, &extra).await.unwrap(), "ok");
    let (_, cb) = collect();
    assert_eq!(chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &extra, &cb, &no_usage).await.unwrap(), "ok");
    plain.assert();
    streamed.assert();
    // without them the body has neither field
    let body = chat_body("m", &msgs(), &None, &NONE, false);
    assert!(body.get("response_format").is_none() && body.get("max_tokens").is_none() && body.get("structured_outputs").is_none());
    // vLLM's structured_outputs goes in as given
    let so = json!({"json":{"type":"object"},"disable_any_whitespace":true});
    let body = chat_body("m", &msgs(), &None, &ChatExtra { structured_outputs: Some(so.clone()), ..Default::default() }, true);
    assert_eq!(body["structured_outputs"], so);
    assert!(body.get("response_format").is_none());
    // the penalty only when given
    assert!(body.get("presence_penalty").is_none());
    let body = chat_body("m", &msgs(), &None, &ChatExtra { presence_penalty: Some(0.3), ..Default::default() }, true);
    assert_eq!(body["presence_penalty"].as_f64(), Some(0.3));
    // a message with a picture keeps its parts array
    let parts = json!([{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]);
    let m: ChatMessage = serde_json::from_value(json!({"role":"user","content":parts.clone()})).unwrap();
    assert_eq!(chat_body("m", &[m], &None, &NONE, false)["messages"][0]["content"], parts);
  }

  #[tokio::test]
  async fn bearer_only_when_key() {
    let server = MockServer::start();
    let with = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").header("authorization", "Bearer k");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}));
    });
    assert_eq!(chat(&server.url("/v1"), &Some("k".into()), "m", &msgs(), &None, &NONE).await.unwrap(), "ok");
    with.assert();

    let server2 = MockServer::start();
    let any = server2.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}));
    });
    let auth = server2.mock(|when, then| {
      when.header_exists("authorization");
      then.status(200).body("x");
    });
    assert_eq!(chat(&server2.url("/v1"), &Some(String::new()), "m", &msgs(), &None, &NONE).await.unwrap(), "ok");
    any.assert();
    auth.assert_hits(0);
  }

  #[tokio::test]
  async fn models_list() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(GET).path("/v1/models");
      then.status(200).json_body(json!({"data":[{"id":"a","max_model_len":262144,"owned_by":"vllm"},{"id":"b","context_length":8192},{"id":"c"}]}));
    });
    let info = |id: &str, n: Option<u64>, o: Option<&str>| ModelInfo { id: id.to_string(), context_tokens: n, owned_by: o.map(str::to_string) };
    assert_eq!(list_models(&server.url("/v1/"), &None).await.unwrap(), vec![info("a", Some(262144), Some("vllm")), info("b", Some(8192), None), info("c", None, None)]);
  }

  #[tokio::test]
  async fn not_found_message() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.any_request();
      then.status(404);
    });
    let e = chat(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE).await.unwrap_err();
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
    let e = chat(&server.url("/v1"), &None, "x", &msgs(), &None, &NONE).await.unwrap_err();
    assert_eq!(e, "The AI server answered 404 Not Found: model \"x\" not found, try pulling it first");
    let e = list_models(&server.url("/v1"), &None).await.unwrap_err();
    assert_eq!(e, "The AI server answered 500 Internal Server Error: out of memory");
  }

  /// A reasoning effort the server does not take: the 400's message (with the levels it lists) reaches the frontend whole,
  /// streamed or not, which retries with the nearest level (src/ai/effort.ts).
  #[tokio::test]
  async fn reasoning_effort_400_keeps_the_supported_levels() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"chat_template_kwargs":{"reasoning_effort":"high"}}"#);
      then.status(400).json_body(json!({"error":{"message":"Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.","type":"BadRequestError","code":400}}));
    });
    let want = "The AI server answered 400 Bad Request: Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.";
    let e = chat(&server.url("/v1"), &None, "m", &msgs(), &Some("high".into()), &NONE).await.unwrap_err();
    assert_eq!(e, want);
    let (_, cb) = collect();
    let e = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &Some("high".into()), &NONE, &cb, &no_usage).await.unwrap_err();
    assert_eq!(e, want);
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
    let e = chat(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE).await.unwrap_err();
    assert!(e.starts_with("The AI server answered 500 Internal Server Error: boom"), "{e}");
  }

  #[tokio::test]
  async fn connection_refused_message() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let e = chat(&format!("http://127.0.0.1:{port}/v1"), &None, "m", &msgs(), &None, &NONE).await.unwrap_err();
    assert!(e.starts_with("The AI connection was refused at"), "{e}");
    assert!(e.contains("address and port"), "{e}");
    assert!(!e.contains("Ollama") && !e.contains("context") && !e.contains("Details:"), "{e}");
  }

  #[tokio::test]
  async fn other_connection_failures_do_not_claim_refusal_or_specific_server() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let fixture = tokio::spawn(async move {
      let (socket, _) = listener.accept().await.unwrap();
      drop(socket); // Connection accepted, but TLS negotiation cannot complete.
    });
    let e = chat(&format!("https://{addr}/v1"), &None, "m", &msgs(), &None, &NONE).await.unwrap_err();
    fixture.await.unwrap();
    assert!(e.starts_with("Could not connect to"), "{e}");
    assert!(!e.contains("refused") && !e.contains("Ollama") && !e.contains("context") && !e.contains("Details:"), "{e}");
  }

  #[tokio::test]
  async fn garbage_body() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.any_request();
      then.status(200).body("hei");
    });
    let e = chat(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE).await.unwrap_err();
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

  fn no_usage(_: Usage) {}

  fn stop() -> String { format!("data: {}\n\n", json!({"choices":[{"delta":{},"finish_reason":"stop"}]})) }

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
    let r = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await;
    assert_eq!(r.unwrap(), "Hello");
    m.assert();
    let got = got.lock().unwrap().clone();
    let pairs: Vec<(&str, &str)> = got.iter().map(|(k, t)| (k.as_str(), t.as_str())).collect();
    assert_eq!(pairs, vec![("reasoning", "Think"), ("reasoning", "ing..."), ("content", "Hel"), ("content", "lo")]);
  }

  #[tokio::test]
  async fn stream_requests_and_reads_usage() {
    let usage = json!({"choices":[],"usage":{"prompt_tokens":3210,"completion_tokens":41,"prompt_tokens_details":{"cached_tokens":2900}}});
    let usage2 = json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}});
    assert_eq!(read_usage(&usage), Some(Usage { prompt_tokens: 3210, completion_tokens: 41, cached_tokens: Some(2900), reasoning_tokens: None }));
    assert_eq!(read_usage(&usage2), Some(Usage { prompt_tokens: 5, completion_tokens: 1, cached_tokens: None, reasoning_tokens: None }));
    assert_eq!(read_usage(&json!({"choices":[{"delta":{}}],"usage":null})), None);
    let server = MockServer::start();
    let m = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"stream_options":{"include_usage":true}}"#);
      then.status(200).header("content-type", "text/event-stream")
        .body(sse(&[&delta("content", "ok"), &stop(), &format!("data: {usage}\n\n"), "data: [DONE]\n\n"]));
    });
    let (_, cb) = collect();
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let on_usage = move |u: Usage| s2.lock().unwrap().push(u);
    assert_eq!(chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &on_usage).await.unwrap(), "ok");
    m.assert();
    assert_eq!(seen.lock().unwrap().clone(), vec![Usage { prompt_tokens: 3210, completion_tokens: 41, cached_tokens: Some(2900), reasoning_tokens: None }]);
  }

  #[tokio::test]
  async fn stream_marks_reasoning_only_and_reports_finish_reason() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "text/event-stream").body(sse(&[&delta("reasoning", "only thoughts"), "data: [DONE]\n\n"]));
    });
    let (_, cb) = collect();
    assert!(chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await.unwrap_err().contains("incomplete"));

    let server2 = MockServer::start();
    server2.mock(|when, then| {
      when.any_request();
      then.status(200).header("content-type", "text/event-stream")
        .body(format!("data: {}\n\n", json!({"choices":[{"delta":{},"finish_reason":"length"}]})));
    });
    let e = chat_stream(&server2.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await.unwrap_err();
    assert!(e.starts_with("Output token limit reached"), "{e}");
  }

  #[tokio::test]
  async fn stream_without_done_and_json_fallback() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "text/event-stream").body(delta("content", "abc").trim_end());
    });
    let (got, cb) = collect();
    assert!(chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await.unwrap_err().contains("incomplete"));
    assert_eq!(got.lock().unwrap().len(), 1);

    let server2 = MockServer::start();
    let m = server2.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"stream":true}"#);
      then.status(200).json_body(json!({"choices":[{"message":{"content":"plain"},"finish_reason":"stop"}]}));
    });
    let (got2, cb2) = collect();
    assert_eq!(chat_stream(&server2.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb2, &no_usage).await.unwrap(), "plain");
    m.assert();
    assert_eq!(*got2.lock().unwrap(), vec![("content".into(), "plain".into())]);
  }

  #[tokio::test]
  async fn stream_idle_timeout() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "text/event-stream").delay(Duration::from_millis(1500)).body(sse(&[&delta("content", "late"), &stop()]));
    });
    let (_, cb) = collect();
    let e = chat_stream_with(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage, Duration::from_millis(200), Duration::from_secs(60))
      .await
      .unwrap_err();
    assert!(e.starts_with("The AI server stopped sending for"), "{e}");
    // a patient idle limit gets the answer
    let r = chat_stream_with(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage, Duration::from_secs(10), Duration::from_secs(60)).await;
    assert_eq!(r.unwrap(), "late");
    // the real limits
    assert_eq!(idle_error(Duration::from_secs(STREAM_IDLE_SECS)), "The AI server stopped sending for 90 seconds.");
    assert_eq!(CHAT_TIMEOUT_SECS, 600);
    assert_eq!(STREAM_TOTAL_SECS, 1200);
  }

  #[tokio::test]
  async fn observed_stream_keeps_finish_usage_ids_and_tools_separate() {
    let server = MockServer::start();
    let tool = json!({"index":0,"id":"call1","type":"function","function":{"name":"lookup","arguments":"{}"}});
    let m = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").header("x-client-request-id", "client1")
        .json_body_partial(r#"{"tools":[{"type":"function"}],"tool_choice":"auto"}"#);
      then.status(200).header("content-type", "text/event-stream").header("x-request-id", "server1")
        .body(format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
          json!({"choices":[{"delta":{"tool_calls":[tool]},"finish_reason":"tool_calls"}]}),
          json!({"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":9,"completion_tokens_details":{"reasoning_tokens":7}}})));
    });
    let events = Mutex::new(Vec::new());
    let tools = Mutex::new(Vec::new());
    let usage = Mutex::new(Vec::new());
    let extra = ChatExtra { tools: Some(json!([{"type":"function"}])), tool_choice: Some(json!("auto")), ..Default::default() };
    let e = chat_stream_observed(&server.url("/v1"), &None, "m", &msgs(), &None, &extra,
      &|_, _| {}, &|u| usage.lock().unwrap().push(u), Some("client1"),
      &|v| events.lock().unwrap().push(v), &|v| tools.lock().unwrap().push(v),
      Duration::from_secs(10), Duration::from_secs(60)).await.unwrap_err();
    assert!(e.contains("requested tool calls"));
    m.assert_hits(1);
    let events = events.lock().unwrap();
    assert!(events.iter().any(|v| v["http_status"] == 200 && v["request_id"] == "server1"));
    assert!(events.iter().any(|v| v["finish_reason"] == "tool_calls"));
    assert_eq!(*tools.lock().unwrap(), vec![tool]);
    assert_eq!(usage.lock().unwrap()[0].reasoning_tokens, Some(7));
  }

  #[test]
  fn native_parity_nonstop_finishes_never_return_answer_text() {
    for finish in ["content_filter", "function_call", "unexpected"] {
      let v = json!({"choices":[{"message":{"content":"partial"},"finish_reason":finish}]});
      assert!(reply_text(&v).is_err(), "finish_reason={finish} must fail");
    }
  }

  #[tokio::test]
  async fn native_parity_body_ids_and_json_channels_are_observed() {
    for streaming in [false, true] {
      let server = MockServer::start();
      server.mock(|when, then| {
        when.method(POST).path("/v1/chat/completions");
        if streaming {
          then.status(200).header("content-type", "text/event-stream").body(format!("data: {}\n\ndata: [DONE]\n\n",
            json!({"id":"chatcmpl-vllm","choices":[{"delta":{"reasoning":"thought","content":"answer"},"finish_reason":"stop"}]})));
        } else {
          then.status(200).json_body(json!({"id":"chatcmpl-vllm","choices":[{"message":{"reasoning":"thought","content":"answer"},"finish_reason":"stop"}]}));
        }
      });
      let events = Mutex::new(Vec::new());
      let (deltas, cb) = collect();
      let answer = chat_stream_observed(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE,
        &cb, &no_usage, None, &|v| events.lock().unwrap().push(v), &|_| {},
        Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
      assert_eq!(answer, "answer");
      assert!(events.lock().unwrap().iter().any(|v| v["request_id"] == "chatcmpl-vllm"));
      assert_eq!(*deltas.lock().unwrap(), vec![("reasoning".into(), "thought".into()), ("content".into(), "answer".into())]);
    }
  }

  #[tokio::test]
  async fn native_parity_json_provider_error_keeps_actionable_message() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).json_body(json!({"error":{"message":"Unsupported reasoning effort. Choose medium."}}));
    });
    let result = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &|_, _| {}, &no_usage).await;
    assert_eq!(result.unwrap_err(), "Unsupported reasoning effort. Choose medium.");
  }

  #[tokio::test]
  async fn native_parity_error_chunk_still_reports_usage_finish_and_id() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "text/event-stream").body(format!("data: {}\n\n",
        json!({"id":"failed-vllm","error":{"message":"server stopped"},
          "choices":[{"delta":{},"finish_reason":"content_filter"}],
          "usage":{"prompt_tokens":3,"completion_tokens":2}})));
    });
    let events = Mutex::new(Vec::new());
    let usage = Mutex::new(Vec::new());
    let result = chat_stream_observed(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE,
      &|_, _| {}, &|u| usage.lock().unwrap().push(u), None,
      &|v| events.lock().unwrap().push(v), &|_| {}, Duration::from_secs(10), Duration::from_secs(60)).await;
    assert_eq!(result.unwrap_err(), "server stopped");
    assert!(events.lock().unwrap().iter().any(|v| v["request_id"] == "failed-vllm"));
    assert!(events.lock().unwrap().iter().any(|v| v["finish_reason"] == "content_filter"));
    assert_eq!(usage.lock().unwrap()[0].completion_tokens, 2);
  }

  #[tokio::test]
  async fn native_parity_length_survives_dropped_transport() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let fixture = tokio::spawn(async move {
      let (mut socket, _) = listener.accept().await.unwrap();
      let mut request = [0; 8192];
      let _ = socket.read(&mut request).await;
      socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 10000\r\nConnection: close\r\n\r\n").await.unwrap();
      let body = format!("data: {}\n\n", json!({"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}));
      socket.write_all(body.as_bytes()).await.unwrap();
      tokio::time::sleep(Duration::from_millis(50)).await;
    });
    let result = chat_stream(&format!("http://{addr}/v1"), &None, "m", &msgs(), &None, &NONE, &|_, _| {}, &no_usage).await;
    fixture.await.unwrap();
    assert_eq!(result.unwrap_err(), cut_off());
  }

  #[tokio::test]
  async fn json_fallback_body_obeys_stream_timeout() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let fixture = tokio::spawn(async move {
      let (mut socket, _) = listener.accept().await.unwrap();
      let mut request = [0; 8192];
      let _ = socket.read(&mut request).await;
      let body = r#"{"choices":[{"message":{"content":"late"},"finish_reason":"stop"}]}"#;
      socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
      tokio::time::sleep(Duration::from_millis(300)).await;
      let _ = socket.write_all(body.as_bytes()).await;
    });
    let result = chat_stream_with(&format!("http://{addr}/v1"), &None, "m", &msgs(), &None, &NONE,
      &|_, _| {}, &no_usage, Duration::from_millis(50), Duration::from_secs(1)).await;
    assert!(result.unwrap_err().contains("stopped sending"));
    fixture.abort();
  }

  #[tokio::test]
  async fn length_keeps_usage_and_is_not_retried() {
    let server = MockServer::start();
    let m = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").json_body_partial(r#"{"max_tokens":8}"#);
      then.status(200).header("content-type", "text/event-stream").body(format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"reasoning":"private"},"finish_reason":"length"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":8,"completion_tokens_details":{"reasoning_tokens":8}}})));
    });
    let usage = Mutex::new(Vec::new());
    let extra = ChatExtra { max_tokens: Some(8), ..Default::default() };
    let result = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &extra,
      &|_, _| {}, &|u| usage.lock().unwrap().push(u)).await;
    assert!(result.unwrap_err().contains("output budget"));
    assert_eq!(usage.lock().unwrap()[0].reasoning_tokens, Some(8));
    m.assert_hits(1);
  }

  #[tokio::test]
  async fn observed_json_and_http_error_report_metadata() {
    for status in [200, 503] {
      let server = MockServer::start();
      server.mock(|when, then| {
        when.method(POST).path("/v1/chat/completions");
        then.status(status).header("content-type", "application/json").header("x-request-id", "req-json")
          .json_body(json!({"choices":[{"message":{"content":"answer"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":1,"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":1}}}));
      });
      let events = Mutex::new(Vec::new());
      let usage = Mutex::new(Vec::new());
      let result = chat_stream_observed(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE,
        &|_, _| {}, &|u| usage.lock().unwrap().push(u), None,
        &|v| events.lock().unwrap().push(v), &|_| {}, Duration::from_secs(10), Duration::from_secs(60)).await;
      assert_eq!(result.is_ok(), status == 200);
      assert!(events.lock().unwrap().iter().any(|v| v["http_status"] == status && v["request_id"] == "req-json"));
      if status == 200 {
        assert!(events.lock().unwrap().iter().any(|v| v["finish_reason"] == "stop"));
        assert_eq!(usage.lock().unwrap()[0].reasoning_tokens, Some(1));
      }
    }
  }

  #[tokio::test]
  async fn stream_errors() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(404).json_body(json!({"error":{"message":"no such model"}}));
    });
    let (_, cb) = collect();
    let e = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await.unwrap_err();
    assert_eq!(e, "The AI server answered 404 Not Found: no such model");
    let server2 = MockServer::start();
    server2.mock(|when, then| {
      when.any_request();
      then.status(200).header("content-type", "text/event-stream").body("data: {\"error\":{\"message\":\"boom\"}}\n\n");
    });
    assert_eq!(chat_stream(&server2.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await.unwrap_err(), "boom");
    // "error": null in every chunk is no error
    let server3 = MockServer::start();
    server3.mock(|when, then| {
      when.any_request();
      then.status(200).header("content-type", "text/event-stream")
        .body("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":\"stop\"}],\"error\":null}\n\ndata: [DONE]\n\n");
    });
    assert_eq!(chat_stream(&server3.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await.unwrap(), "Hi");
  }

  #[test]
  fn redact_url_drops_credentials_and_query() {
    assert_eq!(redact_url("https://user:sekret@host:8000/v1?api-key=sekret#x"), "https://host:8000/v1");
    assert_eq!(redact_url("http://h:11434/v1"), "http://h:11434/v1");
    // unparsable input is still cut at userinfo and query
    let r = redact_url("ht tp://user:sekret@host/v1?key=sekret");
    assert!(!r.contains("sekret"), "{r}");
  }

  #[tokio::test]
  async fn errors_never_contain_url_credentials() {
    // connection refused on a port nothing listens on
    let base = "http://user:sekret@127.0.0.1:1/v1?api-key=sekret";
    let e = chat(base, &None, "m", &msgs(), &None, &NONE).await.unwrap_err();
    assert!(!e.contains("sekret"), "{e}");
    assert!(e.contains("127.0.0.1:1"), "{e}");
    assert!(e.contains("server is running and listening"), "{e}");
    // 404 text echoes the url
    let server = MockServer::start();
    server.mock(|when, then| {
      when.any_request();
      then.status(404).body("nope");
    });
    let base = format!("http://user:sekret@{}/v1?key=sekret", server.address());
    let e = chat(&base, &None, "m", &msgs(), &None, &NONE).await.unwrap_err();
    assert!(!e.contains("sekret"), "{e}");
  }

  #[tokio::test]
  async fn oversized_body_is_refused() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "application/json").body("x".repeat(MAX_BODY_BYTES + 1024));
    });
    let e = chat(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE).await.unwrap_err();
    assert_eq!(e, too_large());
    let (_, cb) = collect();
    let e = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await.unwrap_err();
    assert_eq!(e, too_large());
  }

  #[tokio::test]
  async fn stream_line_without_newline_is_capped() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions");
      then.status(200).header("content-type", "text/event-stream").body("data: ".to_string() + &"x".repeat(MAX_SSE_LINE_BYTES + 1024));
    });
    let (_, cb) = collect();
    let e = chat_stream(&server.url("/v1"), &None, "m", &msgs(), &None, &NONE, &cb, &no_usage).await.unwrap_err();
    assert_eq!(e, too_large());
  }

  #[test]
  fn sse_parser_flags_overlong_line() {
    let mut p = SseParser::default();
    p.push(&vec![b'a'; MAX_SSE_LINE_BYTES]);
    assert!(!p.overflowed());
    p.push(b"a");
    assert!(p.overflowed());
  }

  #[tokio::test]
  async fn cancel_before_register_aborts_the_request() {
    let streams = AiStreams::default();
    streams.cancel("s1"); // arrives while ai_chat is still setting up
    let task = tokio::spawn(async { tokio::time::sleep(Duration::from_secs(60)).await });
    assert!(!streams.register("s1", task.abort_handle()));
    assert!(task.await.unwrap_err().is_cancelled());
    streams.finish("s1");
    // a normal run: register first, cancel later
    let task = tokio::spawn(async { tokio::time::sleep(Duration::from_secs(60)).await });
    assert!(streams.register("s2", task.abort_handle()));
    streams.cancel("s2");
    assert!(task.await.unwrap_err().is_cancelled());
    // the cancel did not leave a stale entry behind
    assert!(streams.0.lock().unwrap().cancelled.is_empty());
  }
}
