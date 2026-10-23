# Changelog

All notable changes to VibeBasic. Format follows Keep a Changelog.

## [0.8.2] - 2026-10-23

### Fixed
- Ask AI answers that repeat themselves forever (seen in form mode with the form picture: the same `{"op":"form",...}` over and over until Cancel or the token cap). The streamed answer and the thinking are watched for one block repeated at the end; such a request is stopped at once, shown as "loop" in the AI Log, and tried once more with a short reminder and mild presence/frequency penalties (0.3, on vLLM and OpenAI-style servers; dropped if the server refuses them). If the retry loops too, "The AI got stuck repeating itself" is shown and nothing is applied.
- Form mode drops exact duplicate ops (the first one counts), and the structured output schema allows at most 300 ops.

## [0.8.1] - 2026-10-23

### Fixed
- Large form requests (a whole program with its code) were cut off at 12,288 tokens and failed with "The AI answer was cut off". The answer room is now 16,384 tokens, or 32,768 when the server reports a large context, plus the thinking room.

## [0.8.0] - 2026-10-23

### Added
- File I/O in the language: Open, Close, Print #, Write #, Input #, Line Input, Get/Put, Seek, EOF, LOF, Loc, FreeFile, Dir, Kill, Name, MkDir, RmDir, ChDir, FileCopy, FileLen, FileDateTime, GetAttr/SetAttr, CurDir, with VB6 error numbers. SaveSetting, GetSetting, DeleteSetting and GetAllSettings.
- Databases on SQLite: the Data control and ADO Data Control, Recordset (navigation, AddNew/Edit/Update/Delete, Find, `rs!Field`), data binding (DataSource/DataField), DataGrid, DataList and DataCombo.
- Sheridan 3D controls: SSPanel (with flood bar), SSCommand, SSCheck, SSOption, SSFrame and SSRibbon.
- MSComm (serial port) and SysInfo.
- Animation, ImageCombo, CoolBar, FlatScrollBar and Calendar (MSCAL).
- Code window: folding with an outlining margin (Edit > Outlining, Ctrl+M chords), a Visual Studio colour palette (or Classic VB6) and font size under Tools > Options > Editor Format, indentation guides, procedure separators, matching block keywords, highlighted identifiers, and automatic End lines on Enter.
- The AI sees the form: a picture of the form for vision models, a layout check (overlaps, out of bounds, cut captions, alignment) and relative placement (below, right of, arrange as row/column/grid, autosize). An ASCII layout map for servers without vision.
- Ask AI answers questions in plain text (Ask more...), Tools > AI Log shows every exchange, and transient network errors are retried once.
- Language: IsMissing, Mid/LSet/RSet statements, FormatNumber/FormatCurrency/FormatPercent, Filter, CDec, IsError, CVErr, the Error statement and Erl, New Collection, typed array returns, ParamArray, Single as its own type, StrConv, Beep.

### Changed
- The AI code check also catches wrong event signatures, calls to missing procedures, wrong argument counts and duplicate procedures.
- Form mode uses structured output (vLLM structured_outputs, else response_format, with automatic fallback); follow-up rounds can use low thinking for speed; answers have a token cap.
- The AI settings and API key live in a private file on the Rust side, out of reach of the program's form windows.
- Builds read the signing identity from a local .env.local (npm run build:app).

### Fixed
- Integer overflow (error 6), parenthesised arguments passed by value, CDate/CDbl/IsNumeric formats, Input #/Write # round trips and other VB6 differences.
- Lost work in the IDE: undo of Add Module/Form, the multi-line Properties editor, values typed before Exit/New/Open. Modules can be renamed; paste into containers; breakpoints follow deleted lines; TabIndex and pictures.
- Run time: programs end when their forms are closed, TextBox selection, ADO blank records, MultiSelect lists, ItemData, CRLF in multi-line text, KeyPress for Escape/Ctrl, Activate/Deactivate, Cmd+Q in made apps.
- Robustness: FileCopy onto itself, runaway queries, blocking file work, size caps, leaked handles, Winsock sends, the settings store.

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
