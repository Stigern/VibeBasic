# Changelog

All notable changes to VibeBasic. Format follows Keep a Changelog.

## [0.7.0] - Unreleased

### Added
- Ask AI on errors: the run-time and compile error dialogs have an Ask AI button (also Tools > Ask AI about this error in break mode). The AI gets the error, the line, the code and the variable values, and proposes a fix in the preview; OK ends the program and applies the fix as one undo step. Made apps never show the button.
- Change... in the AI previews continues the conversation with a new wish; nothing is applied before OK.
- A 1998-style animation in the AI waiting dialog (thinking and writing).
- The AI waiting dialog and preview show prompt tokens (cached) and the time taken.

### Changed
- A fixed AI system prompt with short VB6 examples, so the server can reuse its prefix cache; large modules send only the relevant procedures in full.
- Smarter AI code check: unknown properties and methods (with a suggestion), unknown names, undeclared variables under Option Explicit and statements VibeBasic does not support; form mode retries once on invalid JSON.

## [0.6.0] - Unreleased

### Added
- Movable and resizable toolbox.
- New controls: Shape, Line, Slider, UpDown, StatusBar, TabStrip, TreeView, ListView, MSFlexGrid, RichTextBox, CommonDialog, DriveListBox, DirListBox and FileListBox.
- Ask AI streams the model's thinking and answer live; Cancel stops the server.
- AI check-and-fix loop and a Thinking level setting.
- Version number in the window title and an About dialog with this changelog.

### Changed
- AI requests time out after 90 s of silence instead of 180 s in total.
- Signed builds keep the Local Network permission.
- Clearer network errors when the AI server cannot be reached.

### Fixed
- No OS autocapitalisation in text fields.

## [0.5.0]

### Added
- VB6-dialect language core with break mode and the Immediate window.
- Win98-style IDE: form designer, Properties, code window, IntelliSense, Project Explorer and file operations.
- F5 runs the project in real windows with MsgBox, InputBox and a runtime error dialog.
- Make app: build a standalone .app.
- AI assistant (OpenAI-compatible, Ollama/vLLM) with code and form modes, preview and one-step undo.
