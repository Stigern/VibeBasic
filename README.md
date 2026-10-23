# VibeBasic

A Visual Basic 6 clone for macOS, with the authentic Windows 98 look and a built-in AI assistant that runs on your own local model.

![VibeBasic 0.7.0](docs/images/screenshot.png)

## What it does

- **Form designer:** drag controls onto a form, set their properties and double-click to write event code.
- **The VB6 language:** subs, functions, control arrays, `On Error`, `MsgBox`, `InputBox` and the familiar run-time error dialog.
- **Run and debug:** F5 runs the program in real windows. Breakpoints (F9), stepping (F8) and the Immediate window work as in VB6.
- **Make app:** builds a standalone Mac `.app` from your project.
- **Controls:** the classic intrinsic controls, plus ActiveX-style components picked under Project > Components (Ctrl+T):
  - Common Controls: TreeView, ListView, Toolbar, StatusBar, ImageList, DTPicker and others.
  - Media and data: MSFlexGrid, MSChart, RichTextBox, MaskedEdit, MMControl and MediaPlayer.
  - Networking: WebBrowser, Inet and Winsock.
  - Databases: the Data control, the ADO Data Control, DataGrid, DataList and DataCombo, with data binding. They use SQLite files (`.db`) instead of Jet `.mdb` files.
  - Microsoft Agent, with characters of its own.
- **AI assistant:** connects to any OpenAI-compatible server, such as Ollama or vLLM.
  - Ask AI (Ctrl+I) writes code in the code window, or lays out controls in the form designer.
  - **Ask AI** in the error dialog suggests a fix for the line that failed.
  - Every suggestion is shown as a preview. You can refine it with **Change...**, and it is applied as one undo step.

## Build

Requires Node.js, Rust and the Tauri 2 prerequisites.

```bash
npm install
npm run tauri dev      # run the IDE
npm run tauri build    # build VibeBasic.app
npm test               # run the tests
```

Set up the AI under Tools > Options > AI. Enter the server's base URL (for example `http://<host>:11434/v1` for Ollama) and pick a model.

## Status

VibeBasic is a hobby project and a work in progress. See [CHANGELOG.md](CHANGELOG.md) for what is new.

The look is inspired by Visual Basic 6 and Windows 98. The UI uses [98.css](https://github.com/jdan/98.css). All icons and Agent characters are original artwork.
