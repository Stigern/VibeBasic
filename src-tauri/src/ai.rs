//! OpenAI-compatible AI proxy. Calls go through Rust (reqwest) to avoid CORS and mixed-content
//! limits in the webview. Works with Ollama (`http://<ip>:11434/v1`) and similar servers.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CHAT_TIMEOUT_SECS: u64 = 180;
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

#[tauri::command]
pub async fn ai_chat(
  base_url: String,
  api_key: Option<String>,
  model: String,
  messages: Vec<ChatMessage>,
  reasoning_effort: Option<String>,
) -> Result<String, String> {
  chat(&base_url, &api_key, &model, &messages, &reasoning_effort).await
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
}
