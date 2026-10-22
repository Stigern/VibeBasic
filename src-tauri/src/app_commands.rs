// The app's own commands, shared by build.rs (the app manifest: one allow-<command> permission each) and the ACL test in lib.rs.
// Keep in step with `generate_handler!` in lib.rs (the test checks it).

/// Every app command. Only the main window's capability (capabilities/default.json) grants them.
#[allow(dead_code)]
pub const APP_COMMANDS: &[&str] = &[
  "ai_list_models",
  "ai_chat",
  "ai_cancel",
  "read_text_file",
  "write_text_file",
  "read_binary_file",
  "list_volumes",
  "list_dir",
  "inet_request",
  "inet_cancel",
  "sock_connect",
  "sock_listen",
  "sock_accept",
  "sock_bind",
  "sock_send",
  "sock_close",
  "net_reset",
  "net_local_ip",
  "media_open",
  "media_read",
  "media_close",
  "make_app",
  "can_make_app",
  "get_embedded_project",
  "quit_app",
  "get_app_dir",
  "get_app_name",
];

/// The app commands the form and dialog windows of a running program may call (capabilities/run-windows.json): reading a media
/// file the main window opened, by its token. Nothing else: a page that got into a form window (WebBrowser) must not reach files,
/// the network or Make.
#[allow(dead_code)]
pub const RUN_WINDOW_COMMANDS: &[&str] = &["media_read"];
