# Changelog

All notable changes to VibeBasic. Format follows Keep a Changelog.

## [Unreleased]

### Added
- The New Project dialog, as in VB6: when VibeBasic starts it offers New (Standard EXE, MDI Application, Sub Main, Data Project and an AI Wizard that has the AI build the form from your description), Existing (open a .vbb or .vbp) and Recent. File > New Project shows the New tab. "Don't show this dialog in the future" turns it off; Tools > Options > General, Prompt for project at startup, turns it on again.
- The projects you open or save last: the Recent tab, and the last four at the end of the File menu.
- The AI Wizard has its own dialog: describe the program, then tick improvements that each add an instruction to the request (clear control names, access keys with Enter and Esc buttons, tooltips, input checks, a menu bar, a status line, error handling, remembered settings, a resizable layout, asking before closing, comments). The choices are kept for the next time.
- A splash window when VibeBasic starts, in the spirit of the VB6 one: it shows while the IDE loads (about two seconds), then the IDE comes up. The version on it comes from the app. Programs made with Make have none.

## [0.10.1] - 2026-10-24

A bug hunt in the AI assistant, measured against a real local model (Qwen 27B on vLLM). Tasks solved at Thinking Low rose from 82% to 96%: form layouts from 64% to 91%, Ask AI on run-time errors from 80% to 100%.

### Changed
- The Ask AI waiting window can be made bigger with the grip in its lower right corner; the box with the thinking and the answer grows with it. It keeps its place and size for the next request (until VibeBasic is closed).
- Every dialog can be moved by its title bar, as in Windows 98.

### Fixed
- AI code merges never break your code: declarations no longer land inside a Type, Enum or #If block or in the middle of a continued line, multi-line procedure headers and Attribute lines are kept, End Sub is not doubled, a changed Dim replaces the old one, and #If blocks stay whole. A merge that would add syntax errors is refused and explained instead of applied.
- Thinking High failed on servers that only take low, medium and xhigh. A rejected level is now retried with the nearest one the server accepts, and Test Connection shows the levels the server takes (and picks Low for a new setup).
- Form mode no longer drops values silently: a value it cannot use goes back to the model with the valid ones (StartUpPosition, SSTab tabs, Boolean values, form-level changes), and clear intent is accepted as is.
- Syntax complaints quote the statement and show the expected form (Scale, Line, Circle, PSet, ListItems.Add). Code that still has syntax errors after the retry is marked in red and Cancel is the default.
- Ask AI on a run-time error now sees the values on the failing line and is told to handle them, not to hide the error.
- There was a gap of up to 3 seconds between the prompt and the waiting dialog in which you could start the program or a second Ask AI; a "Connecting..." dialog now covers it, and only one AI request runs at a time.
- The code check knows ListItem, ADODB.Recordset and ADODB.Connection members, read-only properties (WindowList, MDIChild) and Implements methods; the MDI event-name fix renames to MDIForm_.
- Placement and the layout check follow docked containers (a docked PictureBox on an MDI form).
- Small overflows (up to 240 twips) grow the form instead of costing another round; truncated answers are rejected.
- The preview diff uses bounded memory on big modules. The AI Log no longer shows a user name and password from the server address. Error texts say "this computer" on Windows and Linux.
- Windows: a running program's form could not be moved by its title bar. Windows resizes a new window to its scaled size, which rebuilt the title bar without its drag mark; the title bar now carries it each time it is built.
- Windows: F5, Ctrl+R and Shift+F5 in a running program reloaded its window, which went blank (WebView2's browser shortcuts). Those keys, and Ctrl+P, Ctrl+F, Ctrl+G, F3, F7 and Alt+Left/Right, no longer reach the browser in any window. The program still gets KeyDown for them, and F5 in the IDE still runs.
- Windows: a double click on a DirListBox folder did nothing, and so did DblClick on a TreeView or ListView. WebView2 fires no dblclick when the first click repainted the list.
- Windows: characters typed with AltGr (Norwegian @ £ $ { [ ] } €) raised no KeyPress, got past a MaskedEdit's mask, and did not start an edit in a DataGrid or the Properties window.
- DriveListBox.Drive read in Form_Load was "/" on Windows; the drives had not come yet. Reads now wait for them. DriveListBox also has List, ListCount and ListIndex, as in VB6.
- Kill of a read-only file deleted it on Windows; it is error 75, as in VB6. FileSystemObject.DeleteFile and File.Delete honour Force.
- `Name "a.txt" As "A.TXT"` (a new case only) was error 58 on Windows and macOS.
- GetAttr on Windows reports vbSystem and vbArchive, so it matches SetAttr. `Dir(..., vbDirectory)` leaves out hidden folders ($Recycle.Bin, System Volume Information) unless vbHidden is given; on Windows a folder named ".git" is not hidden.
- `CurDir("D")` gave the current drive's folder instead of drive D's.
- Make on Windows turns a device name (CON, NUL, COM1...) into "CON_", which Explorer can open and delete.

### Added
- `tests-live/`: a live evaluation of the AI assistant against an OpenAI-compatible server (33 tasks, behaviour checks in the real run time), with a report.

## [0.10.0] - 2026-10-24

### Added
- Windows and Linux support. VibeBasic runs on Windows 10/11 (WebView2) and Linux (WebKitGTK 4.1) as well as macOS.
  - Windows: real drive letters and backslash paths as in VB6, DriveListBox with "c: [label]", ChDrive, COM ports for MSComm (CommPort 3 is COM3), the Windows printer list, power status for SysInfo, and Ctrl as Ctrl.
  - Linux: /dev/ttyUSB* and /dev/ttyACM* serial ports, CUPS printers, battery status from /sys, and mounted drives under /media and /mnt.
- Make app on Windows produces a single <Name>.exe with the project inside, the project icon and the version information (Properties > Details). On Linux it produces an executable plus a .desktop launcher and icon.
- Downloads for every platform are built by GitHub Actions on each release: a Windows installer and portable zip, a Linux .deb and AppImage, and a macOS zip. Every push is tested on macOS, Windows and Linux.

### Changed
- The clipboard uses a cross-platform library off macOS; macOS behaves as before.

## [0.9.0] - 2026-10-24

### Added
- Menus: the Menu Editor (Tools > Menu Editor, Ctrl+E), a Win98 menu bar in every form (designer and run time) with submenus, checkmarks, separators, shortcuts and Alt/F10 keyboard, menu control arrays (Load/Unload), and PopupMenu.
- Graphics on forms and PictureBoxes: Print, Cls, PSet, Line (B/BF, Step), Circle (arcs, pies, ellipses), Point, PaintPicture, TextWidth/TextHeight, CurrentX/Y, DrawWidth/DrawStyle/DrawMode, FillStyle/FillColor, FontTransparent, AutoRedraw with Image, the Paint event, ScaleMode/ScaleLeft/ScaleTop/ScaleWidth/ScaleHeight, Scale, ScaleX/ScaleY and SavePicture.
- Class modules: Property Get/Let/Set, New, Class_Initialize/Terminate, Event/RaiseEvent/WithEvents, Implements, Friend, default members and For Each (NewEnum).
- The Locals, Watch and Call Stack windows, Add/Edit/Quick Watch with break conditions, data tips in break mode, and Set/Show Next Statement.
- The Printer object and Printers collection (NewPage, EndDoc, KillDoc, Orientation, A4/Letter), a print preview with the macOS print dialog, Form.PrintForm and CommonDialog.ShowPrinter.
- Opening VB6 projects (.vbp, .frm, .frx, .bas, .cls) with an import report, and Project > Add File (Ctrl+D).
- Language: TypeOf…Is, named arguments (x:=1), Option Base and Option Compare, GoSub/Return, On…GoTo/GoSub, Global, #If/#Const, the financial functions (Pmt, FV, NPV, IRR, Rate, …), byte functions (LenB, LeftB, …), Partition and Debug.Assert.
- MousePointer and MouseIcon on forms and controls, Screen.MousePointer, the Validate event with CausesValidation, and Alt+letter accelerators.
- Sub Main as startup, Command$ and Environ, version information, file types and command-line arguments in Project Properties; made apps get their version, copyright and file associations; App.PrevInstance and App.LogEvent.
- MDI forms with child windows, Arrange, the WindowList menu, merged menus, and several instances of a form with New.
- Drag and drop: DragMode/DragDrop/DragOver, OLE drag and drop with DataObject, and files dropped from Finder.
- ADO in code (New ADODB.Connection/Recordset/Command, transactions, Filter, Sort), CreateObject, Scripting.Dictionary and Scripting.FileSystemObject.
- RichTextBox TextRTF/SelRTF, LoadFile/SaveFile, Find and paragraph formats; CommonDialog Flags (multiselect, DefaultExt, colour init).

### Fixed
- A thorough review of all of the above fixed 48 more issues, among them: objects in Collections and arrays are released, each ADO Connection has its own transaction, data tips never run code, crafted pictures in .frx files cannot hang an import, controls follow their container's ScaleMode, docked PictureBoxes know their size, Font* properties work everywhere, menu shortcuts follow the typed letter, and New form instances are freed after Unload.

## [0.8.3] - 2026-10-23

### Fixed
- An Ask AI answer that loops could loop again on the retry, in the same place ("The AI got stuck repeating itself" every time). The retry after a loop now goes without the form picture and without the structured output (the JSON grammar); the layout map and the nudge are still sent.
- Dropdown arrows in dialogs (Tools > Options > AI: Model, Thinking, Send form picture) did nothing; only a click on the text opened the list. The row around the box is a label, which passed the arrow's click on to the text box, and that second click closed the list again.

## [0.8.2] - 2026-10-23

### Added
- A new app icon: a classic VB form window on a glossy rounded tile.

### Fixed
- Ask AI answers that repeat themselves forever (seen in form mode with the form picture: the same `{"op":"form",...}` over and over until Cancel or the token cap). The streamed answer and the thinking are watched for one block repeated at the end; such a request is stopped at once, shown as "loop" in the AI Log, and tried once more with a short reminder and a mild presence_penalty (0.3, on vLLM and OpenAI-style servers; dropped if the server refuses it). No frequency_penalty: on a thinking model it turned the retry into word salad. If the retry loops too, "The AI got stuck repeating itself" is shown and nothing is applied.
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
