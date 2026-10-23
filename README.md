<img src="docs/images/icon.png" width="128" align="right" alt="VibeBasic icon">

# VibeBasic

A Visual Basic 6 clone for macOS, with the authentic Windows 98 look and a built-in AI assistant that runs on your own local model.

![VibeBasic 0.7.0](docs/images/screenshot.png)

## What it does

- **Form designer:** drag controls onto a form, set their properties and double-click to write event code.
- **Menus:** Tools > Menu Editor (Ctrl+E) builds a form's menus as in VB6: `&` access keys, separators, submenus, Checked, Enabled and Visible, Shortcut keys, menu control arrays (`Load mnuMRU(i)` for a recent-files list) and `PopupMenu` for context menus. Each form window draws its own Win98 menu bar under its title bar; a program's menus never go into the Mac's menu bar at the top of the screen. A Ctrl shortcut also answers to Cmd, except Cmd+C, X, V, A, Z, W and Q, which stay with the Mac.
- **MDI:** Project > Add MDI Form makes the project's MDI form (the AppWorkspace grey; it holds aligned controls such as a Toolbar, a StatusBar or a PictureBox with Align, and invisible ones). Forms with `MDIChild = True` open inside it as Win98 child windows that move, resize, minimize and maximize within it ("MDIForm1 - [Form2]"); `Arrange`, `ActiveForm`, the Window list menu and merged child menus work as in VB6, and `Dim f As New Form2: f.Show` opens another instance of a form.
- **The VB6 language:** subs, functions, control arrays, `On Error`, `MsgBox`, `InputBox` and the familiar run-time error dialog. It also covers class modules (`Property Get/Let/Set`, `Event`/`RaiseEvent`/`WithEvents`, `Implements`), file I/O (`Open`, `Print #`, `Line Input`, `Get`/`Put`, `Dir`…), `SaveSetting`/`GetSetting`, `TypeOf`, named arguments, `Option Base`/`Compare`, `GoSub`, `#If`, the financial functions, `CreateObject` with ADO, `Scripting.Dictionary` and `FileSystemObject`, and VB6's own number and date rules.
- **Graphics and printing:** `Print`, `Line`, `Circle`, `PSet`, `PaintPicture`, `ScaleMode`, `AutoRedraw` and the `Paint` event on forms and PictureBoxes; the `Printer` object prints through the macOS print dialog (or Save as PDF).
- **Code window:** Visual Studio-style colours (or classic VB6), folding of procedures and blocks (Edit > Outlining, Ctrl+M), indentation guides, procedure separators, matching `If`/`End If` highlighting, and automatic `End` lines.
- **Run and debug:** F5 runs the program in real windows. Breakpoints (F9), stepping (F8), the Immediate, Locals, Watch and Call Stack windows, data tips and Set Next Statement work as in VB6. Programs can start in `Sub Main` and read `Command$`.
- **Open VB6 projects:** File > Open Project reads `.vbp` projects with their `.frm`, `.frx`, `.bas` and `.cls` files, and shows a report of anything VibeBasic cannot use.
- **Make app:** builds a standalone Mac `.app` from your project, with version information and the file types it opens.
- **Controls:** the classic intrinsic controls, plus ActiveX-style components picked under Project > Components (Ctrl+T):
  - Common Controls: TreeView, ListView, Toolbar, StatusBar, ImageList, ImageCombo, CoolBar (bands host other controls), DTPicker, FlatScrollBar, Animation (GIF, APNG, WebP and MP4 instead of AVI) and others, plus the Access-style Calendar (MSCAL).
  - Media and data: MSFlexGrid, MSChart, RichTextBox, MaskedEdit, MMControl and MediaPlayer.
  - Networking: WebBrowser, Inet and Winsock.
  - Serial ports and system information: MSComm (for an Arduino or a 3D printer over USB) and SysInfo. `CommPort` n opens the n-th `/dev/cu.*` device in name order; the extra property `PortName` takes the device path itself, e.g. `MSComm1.PortName = "/dev/cu.usbmodem1101"`.
  - Databases: the Data control, the ADO Data Control, DataGrid, DataList and DataCombo, with data binding. They use SQLite files (`.db`) instead of Jet `.mdb` files.
  - Sheridan 3D controls: SSPanel (with the flood bar), SSFrame, SSCommand, SSCheck, SSOption and SSRibbon.
  - Microsoft Agent, with characters of its own.
- **AI assistant:** connects to any OpenAI-compatible server, such as Ollama or vLLM.
  - Ask AI (Ctrl+I) writes code in the code window, or lays out controls in the form designer.
  - **Ask AI** in the error dialog suggests a fix for the line that failed.
  - Every suggestion is shown as a preview. You can refine it with **Change...**, and it is applied as one undo step.
  - With a vision model, the AI sees a picture of your form. A layout check catches overlapping controls and cut-off captions, and the AI places controls relative to each other ("below Text1", "arrange as a row").
  - Generated code is checked before you see it: syntax, event signatures, missing procedures and wrong properties. Problems go back to the model once.
  - Questions get plain answers. Tools > AI Log shows every request, answer, token count and timing.

## Build

Requires Node.js, Rust and the Tauri 2 prerequisites.

```bash
npm install
npm run tauri dev      # run the IDE
npm run build:app      # build VibeBasic.app (scripts/build-app.sh runs tauri build)
npm test               # run the tests
```

### Code signing

The signing identity is not in the repository. To sign your builds, create a file `.env.local` next to `package.json` (it is git-ignored) with your own identity:

```bash
APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)"
```

`security find-identity -v -p codesigning` lists the identities on your Mac. `npm run build:app` loads `.env.local`, and the Tauri bundler reads `APPLE_SIGNING_IDENTITY` from the environment. Sign every build with the same identity, or macOS asks again for permissions such as Local Network access (Winsock). Without an identity the app is built unsigned.

Set up the AI under Tools > Options > AI. Enter the server's base URL (for example `http://<host>:11434/v1` for Ollama) and pick a model.

## Status

VibeBasic is a hobby project and a work in progress. See [CHANGELOG.md](CHANGELOG.md) for what is new.

The look is inspired by Visual Basic 6 and Windows 98. The UI uses [98.css](https://github.com/jdan/98.css). All icons and Agent characters are original artwork.
