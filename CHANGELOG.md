# Changelog

All notable changes to VibeBasic. Format follows Keep a Changelog.

## [0.7.5] - 2026-10-23

### Changed
- The AI knows the language: a compact reference card, generated from VibeBasic's own built-in functions, statements and constants, is part of the fixed system prompt.
- The AI knows the project: public procedures, variables and other forms' controls are sent with each request, so it can call your own code.
- The size limit for code sent to the AI follows the server's real context (read from the model list on Test Connection); servers that do not report it keep the 400-line rule.
- With code selected in the code window, Ask AI works on the selection, and a body-only answer replaces just the selection.

## [0.7.0] - 2026-10-23

### Added
- Project > Components (Ctrl+T): pick ActiveX components like in VB6; new projects show only the intrinsic controls.
- New components: SSTab, ImageList, Toolbar, DTPicker, MonthView, MaskedEdit, WebBrowser, Inet, Winsock (TCP/UDP), MSChart, MMControl, MediaPlayer and Agent (original Robby and Wizard characters). TreeView, ListView and TabStrip show ImageList pictures.
- Debug menu: breakpoints (F9), Step Into (F8), Step Over, Step Out, Run To Cursor and Clear All Breakpoints.
- Properties window: working dropdowns everywhere, VB6 colour Palette/System picker, multi-line list editor, double-click cycles values, object box, Categorized tab, description pane and keyboard navigation.
- Toolbar: Add Form, Add Module, Find and Immediate buttons, and VB6 position/size readouts.
- Language: Controls, Forms, Clipboard, Screen.ActiveForm/ActiveControl, and Load/Unload of control array elements.
- Ask AI on errors: the run-time and compile error dialogs have an Ask AI button (also Tools > Ask AI about this error in break mode). The AI gets the error, the line, the code and the variable values, and proposes a fix in the preview; OK ends the program and applies the fix as one undo step. Made apps never show the button.
- Change... in the AI previews continues the conversation with a new wish; nothing is applied before OK.
- A 1998-style animation in the AI waiting dialog (thinking and writing).
- The AI waiting dialog and preview show prompt tokens (cached) and the time taken.

### Changed
- A fixed AI system prompt with short VB6 examples, so the server can reuse its prefix cache; large modules send only the relevant procedures in full.
- Cut, Copy, Paste, Delete and Select All work in the code window from the menu and the toolbar; buttons are only enabled when they can act.
- A break moves the focus to the code window; stepping through For loops stops on Next as in VB6.
- Large controls placed by a Toolbox double-click shrink to fit the form.
- Smarter AI code check: unknown properties and methods (with a suggestion), unknown names, undeclared variables under Option Explicit and statements VibeBasic does not support; form mode retries once on invalid JSON.

### Fixed
- Properties dropdown lists were clipped and invisible.
- A typed but uncommitted Properties value is kept on Run and Save.
- DirListBox lists symlinked folders and gives error 76 for a missing folder; CommonDialog keeps "All files".

### Security
- Form windows can no longer call the app's commands, and a Content Security Policy keeps WebBrowser pages away from the app.

## [0.6.0] - 2026-10-23 (released together with 0.7.0)

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
