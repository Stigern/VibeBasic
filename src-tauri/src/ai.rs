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

fn map_send_error(e: &reqwest::Error, base_url: &str, timeout_secs: u64) -> String {
  if e.is_connect() {
    format!(
      "Could not connect to {base_url}. Check that the AI server is running and can be reached from this Mac. For Ollama on another PC, start Ollama with OLLAMA_HOST=0.0.0.0."
    )
  } else if e.is_timeout() {
    format!("The AI server did not answer within {timeout_secs} seconds.")
  } else if e.is_builder() {
    format!("The base URL \"{base_url}\" is not valid. It should look like http://192.168.1.10:11434/v1")
  } else if e.is_decode() || e.is_body() {
    unreadable()
  } else {
    format!("Could not connect to {base_url}. Check that the AI server is running and can be reached from this Mac. For Ollama on another PC, start Ollama with OLLAMA_HOST=0.0.0.0.")
  }
}

fn status_error(status: reqwest::StatusCode, url: &str, body: &str) -> String {
  match status.as_u16() {
    404 => format!("The AI server answered 404 Not Found for {url}. Check the base URL. For Ollama it usually ends with /v1."),
    401 | 403 => format!("The AI server refused the request ({}). Check the API key.", status.as_u16()),
    _ => {
      let head: String = body.chars().take(200).collect();
      format!("The AI server answered {status}: {head}")
    }
  }
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
) -> Result<String, String> {
  let url = endpoint(base_url, "chat/completions");
  let c = client(CHAT_TIMEOUT_SECS)?;
  let body = json!({ "model": model, "messages": messages, "temperature": 0.2, "stream": false });
  let v = send_json(c.post(&url).json(&body), base_url, &url, api_key, CHAT_TIMEOUT_SECS).await?;
  v.pointer("/choices/0/message/content")
    .and_then(Value::as_str)
    .map(str::to_string)
    .ok_or_else(unreadable)
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
) -> Result<String, String> {
  chat(&base_url, &api_key, &model, &messages).await
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
    let r = chat(&server.url("/v1"), &None, "qwen", &msgs()).await;
    assert_eq!(r.unwrap(), "hei");
    m.assert();
  }

  #[tokio::test]
  async fn bearer_only_when_key() {
    let server = MockServer::start();
    let with = server.mock(|when, then| {
      when.method(POST).path("/v1/chat/completions").header("authorization", "Bearer k");
      then.status(200).json_body(json!({"choices":[{"message":{"content":"ok"}}]}));
    });
    assert_eq!(chat(&server.url("/v1"), &Some("k".into()), "m", &msgs()).await.unwrap(), "ok");
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
    assert_eq!(chat(&server2.url("/v1"), &Some(String::new()), "m", &msgs()).await.unwrap(), "ok");
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
    let e = chat(&server.url("/v1"), &None, "m", &msgs()).await.unwrap_err();
    assert!(e.starts_with("The AI server answered 404 Not Found"), "{e}");
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
    let e = chat(&server.url("/v1"), &None, "m", &msgs()).await.unwrap_err();
    assert!(e.starts_with("The AI server answered 500 Internal Server Error: boom"), "{e}");
  }

  #[tokio::test]
  async fn connection_refused_message() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let e = chat(&format!("http://127.0.0.1:{port}/v1"), &None, "m", &msgs()).await.unwrap_err();
    assert!(e.starts_with("Could not connect to"), "{e}");
  }

  #[tokio::test]
  async fn garbage_body() {
    let server = MockServer::start();
    server.mock(|when, then| {
      when.any_request();
      then.status(200).body("hei");
    });
    let e = chat(&server.url("/v1"), &None, "m", &msgs()).await.unwrap_err();
    assert_eq!(e, "The AI server sent an answer VibeBasic could not read.");
    let e = list_models(&server.url("/v1"), &None).await.unwrap_err();
    assert_eq!(e, "The AI server sent an answer VibeBasic could not read.");
  }
}
