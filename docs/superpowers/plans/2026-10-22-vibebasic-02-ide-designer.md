# VibeBasic plan 02: IDE og skjemadesigner

> **For agentiske arbeidere:** PÅKREVD UNDER-FERDIGHET: Bruk superpowers:subagent-driven-development (anbefalt) eller superpowers:executing-plans. Stegene bruker avkrysningsbokser (`- [ ]`).

**Mål:** En VB6-IDE med ekte Windows 98-utseende der du kan tegne skjemaer, endre egenskaper, skrive kode, og lagre og åpne prosjekter. Kjøring kommer i plan 03.

**Arkitektur:**
- Prosjektmodellen er ren data. Endringer i designeren går gjennom en `CommandStack` med angre og gjør om.
- UI-et er vanlig DOM og TypeScript uten rammeverk, i Win98-tema basert på 98.css.
- Kontroller tegnes av én felles `renderControl`, som kjøringen i plan 03 også bruker.
- Kodevinduet er CodeMirror 6 med VB6-farger.
- IDE-en kjører både i Tauri og i en vanlig nettleser (`npm run dev`) gjennom `Backend`.

**Teknologi:** TypeScript, 98.css, CodeMirror 6 (`@codemirror/state`, `view`, `language`, `commands`, `search`, `autocomplete`), Vitest med jsdom, Tauri 2 (`tauri-plugin-dialog`).

**Spec:** [spec](../specs/2026-10-22-vibebasic-design.md), kap. 2.1–2.4, 2.8, 5 og 8. Felles regler: se [oversikten](2026-10-22-vibebasic-00-oversikt.md).

## Regler for denne planen

- Snarveier: Ctrl og Cmd virker likt for alle Ctrl-snarveier. Ctrl+Break kan også trykkes som Cmd+. eller Ctrl+Pause (plan 03).
- Rutenett: standard 120 × 120 twips. «Show Grid» og «Align Controls to Grid» er på som standard.
- UI-tekster er eksakte VB6-tekster der de finnes, med «Microsoft Visual Basic» byttet ut med «VibeBasic».
- jsdom-tester tester logikk og DOM-struktur. Utseendet sjekkes manuelt i nettleserpanelet med `npm run dev` mot skissen fra brainstormingen («A. Ekte gammel VB6»).

## Filer

```
src/model/types.ts       Project, FormDef, ControlDef, ModuleDef, PropValue, FontValue, PictureRef, Asset
src/model/controls.ts    CONTROL_TYPES-registeret, getPropDef, newControl, nextDefaultName, validateName, newProject
src/model/colors.ts      vbColorToCss, SYSTEM_COLORS, PALETTE_48
src/model/twips.ts       twipsToPx, pxToTwips
src/model/serialize.ts   serializeProject, parseProject, ProjectFormatError
src/model/commands.ts    Command, CommandStack, kommandofabrikker
src/model/procedures.ts  listProcedures, findProcedureRange, buildEventStub
src/backend/*            utvides med fil- og dialog-API
src/ui98/theme.css, dom.ts, mdiWindow.ts, menubar.ts, toolbar.ts, dialogs.ts, combo.ts, tabs.ts
src/controls/render.ts, controls.css
src/ide/main.ts, ideState.ts, layout.ts, menus.ts, toolbox.ts, designer.ts, designerLogic.ts,
        properties.ts, propertyEditors.ts, projectExplorer.ts, projectDialogs.ts, optionsDialog.ts,
        codeWindow.ts, vbLanguage.ts, completions.ts, fileController.ts, clipboard.ts
src/ide/icons/           toolbox- og IDE-ikoner (SVG/PNG, VB6-lignende)
dev/gallery.html + src/dev/gallery.ts
src-tauri/src/files.rs   read_text_file, write_text_file, read_binary_file
tests/model/*, tests/ide/*, tests/controls/*
```

---

### Oppgave 1: Modell, kontrollregister, navn og farger

**Filer:** Opprett `src/model/types.ts`, `controls.ts`, `colors.ts` og `twips.ts`. Test: `tests/model/controls.test.ts`, `tests/model/colors.test.ts`

**Grensesnitt:**
- Produserer `types.ts`:

```ts
export type ControlType = 'Form' | 'CommandButton' | 'Label' | 'TextBox' | 'CheckBox' | 'OptionButton' | 'Frame'
  | 'ListBox' | 'ComboBox' | 'PictureBox' | 'Image' | 'Timer' | 'HScrollBar' | 'VScrollBar' | 'ProgressBar';
export interface FontValue { name: string; size: number; bold: boolean; italic: boolean; underline: boolean }
export interface PictureRef { asset: string }                 // nøkkel i Project.assets
export type PropValue = string | number | boolean | string[] | FontValue | PictureRef | null;
export interface ControlDef { id: string; type: Exclude<ControlType, 'Form'>; name: string; index: number | null;
  parentId: string | null; props: Record<string, PropValue> }  // Left/Top relativt til forelder, i twips
export interface FormDef { id: string; name: string; props: Record<string, PropValue>; controls: ControlDef[]; code: string }
export interface ModuleDef { id: string; name: string; code: string }
export interface Asset { mime: string; dataBase64: string }
export interface Project { name: string; title: string; startupForm: string; forms: FormDef[]; modules: ModuleDef[];
  assets: Record<string, Asset>; iconAsset: string | null }
```

  `FormDef.controls` er ordnet etter z-rekkefølge (bakerst først). `props` har aldri `Name` eller `Index`, fordi de ligger i egne felt.

- Produserer `controls.ts`:

```ts
export type PropKind = 'string' | 'text' | 'int' | 'bool' | 'color' | 'enum' | 'font' | 'picture' | 'list';
export interface PropDef { name: string; kind: PropKind; default: PropValue; enumValues?: { value: number; label: string }[];
  designTime: boolean; runtime: 'rw' | 'ro' | 'none'; min?: number; max?: number }
export interface EventDef { name: string; params: string }          // f.eks. { name: 'KeyPress', params: 'KeyAscii As Integer' }
export interface MethodDef { name: string; params: string }
export interface ControlTypeDef { type: ControlType; namePrefix: string; defaultWidth: number; defaultHeight: number;
  props: PropDef[]; events: EventDef[]; methods: MethodDef[]; defaultEvent: string; defaultMember: string | null;
  isContainer: boolean; invisibleAtRuntime: boolean; toolboxTooltip: string }
export const CONTROL_TYPES: Record<ControlType, ControlTypeDef>;
export const TOOLBOX_ORDER: (ControlType | 'Pointer')[];
export function getPropDef(type: ControlType, name: string): PropDef | undefined;   // uavhengig av store/små bokstaver
export function nextDefaultName(form: FormDef, type: ControlType): string;          // "Command1", "Command2" …
export function newControl(form: FormDef, type: Exclude<ControlType, 'Form'>, rect: { left: number; top: number; width?: number; height?: number }, parentId: string | null): ControlDef;
export function validateName(name: string): boolean;     // /^[A-Za-z][A-Za-z0-9_]{0,39}$/ og ikke et nøkkelord (KEYWORDS fra plan 01)
export function newProject(): Project;                     // "Project1" med Form1 (4800×3600) som oppstartsskjema
export function newId(): string;                           // crypto.randomUUID()
```

  `TOOLBOX_ORDER` følger VB6: Pointer, PictureBox, Label, TextBox, Frame, CommandButton, CheckBox, OptionButton, ComboBox, ListBox, HScrollBar, VScrollBar, Timer, Image, ProgressBar.

- Produserer `colors.ts`: `vbColorToCss(n: number): string`, `SYSTEM_COLORS`, `PALETTE_48`.
- Produserer `twips.ts`: `twipsToPx(t: number): number` (`Math.round(t / 15)`) og `pxToTwips(px: number): number` (`px * 15`).

**Fellesegenskaper** for alle kontroller unntatt Timer: `Left Top Width Height Visible Enabled TabIndex TabStop Tag ToolTipText`. Timer har bare `Left Top Enabled Interval Tag`.

**Kontrolltabell** (`prefiks`, standardstørrelse i twips, så egenskaper med standardverdi):

| Type | Prefiks / størrelse | Egne egenskaper (standard) | Standardhendelse / -medlem |
|---|---|---|---|
| Form | Form, 4800×3600 | Caption=navn, BackColor &H8000000F, ForeColor &H80000012, BorderStyle 2 (0 None, 1 Fixed Single, 2 Sizable, 3 Fixed Dialog, 4 Fixed ToolWindow, 5 Sizable ToolWindow), StartUpPosition 3 (0 Manual, 1 CenterOwner, 2 CenterScreen, 3 Windows Default), ControlBox True, MaxButton True, MinButton True, WindowState 0 (0 Normal, 1 Minimized, 2 Maximized), KeyPreview False, Font MS Sans Serif 8, Picture null, Icon null | Load / – |
| CommandButton | Command, 1215×495 | Caption=navn, BackColor &H8000000F, Default False, Cancel False, Style 0 (0 Standard, 1 Graphical), Picture null, Font | Click / Value |
| Label | Label, 1215×255 | Caption=navn, Alignment 0 (0 Left Justify, 1 Right Justify, 2 Center), AutoSize False, BackStyle 1 (0 Transparent, 1 Opaque), BackColor &H8000000F, ForeColor &H80000012, BorderStyle 0 (0 None, 1 Fixed Single), WordWrap False, Font | Click / Caption |
| TextBox | Text, 1215×495 | Text=navn, MultiLine False, ScrollBars 0 (0 None, 1 Horizontal, 2 Vertical, 3 Both), PasswordChar "", MaxLength 0, Locked False, Alignment 0, BackColor &H80000005, ForeColor &H80000008, BorderStyle 1, Font; bare i kjøring: SelStart, SelLength, SelText | Change / Text |
| CheckBox | Check, 1215×495 | Caption=navn, Value 0 (0 Unchecked, 1 Checked, 2 Grayed), Alignment 0, BackColor, ForeColor, Font | Click / Value |
| OptionButton | Option, 1215×495 | Caption=navn, Value False, Alignment 0, BackColor, ForeColor, Font | Click / Value |
| Frame | Frame, 1815×1335 | Caption=navn, BackColor, ForeColor, BorderStyle 1, Font. Kan inneholde andre kontroller | Click / Caption |
| ListBox | List, 1215×1035 | List [] (liste), Sorted False, MultiSelect 0 (0 None, 1 Simple, 2 Extended), BackColor &H80000005, ForeColor &H80000008, Font; bare i kjøring: ListIndex, ListCount, Text, Selected(i), NewIndex | Click / Text |
| ComboBox | Combo, 1215×315 | Text=navn, Style 0 (0 Dropdown Combo, 1 Simple Combo, 2 Dropdown List), List [], Sorted False, BackColor &H80000005, ForeColor &H80000008, Font; bare i kjøring: ListIndex, ListCount, NewIndex | Change / Text |
| PictureBox | Picture, 1215×1215 | Picture null, AutoSize False, BorderStyle 1, BackColor &H8000000F. Kan inneholde andre kontroller | Click / Picture |
| Image | Image, 1215×1215 | Picture null, Stretch False, BorderStyle 0 | Click / Picture |
| Timer | Timer, 420×420 (fast) | Interval 0, Enabled True. Usynlig i kjøring | Timer / Enabled |
| HScrollBar | HScroll, 1215×255 | Min 0, Max 32767, Value 0, SmallChange 1, LargeChange 1 | Change / Value |
| VScrollBar | VScroll, 255×1215 | som HScrollBar | Change / Value |
| ProgressBar | ProgressBar, 1935×255 | Min 0, Max 100, Value 0, Scrolling 0 (0 ccScrollingStandard, 1 ccScrollingSmooth), Orientation 0 (0 ccOrientationHorizontal, 1 ccOrientationVertical), Appearance 1, BorderStyle 0 | Click / Value |

**Hendelser** (`params` eksakt):
- Click og DblClick (`""`).
- `Change`.
- GotFocus og LostFocus.
- `KeyPress` (`KeyAscii As Integer`).
- KeyDown og KeyUp (`KeyCode As Integer, Shift As Integer`).
- MouseDown, MouseMove og MouseUp (`Button As Integer, Shift As Integer, X As Single, Y As Single`).
- `Scroll` for rullefelt.
- `DropDown` for ComboBox.
- `Timer`.

Form har i tillegg `Load`, `Unload` (`Cancel As Integer`), `QueryUnload` (`Cancel As Integer, UnloadMode As Integer`), `Activate`, `Deactivate`, `Resize` og `Initialize`. Hver kontroll får de hendelsene VB6 har for typen.

**Metoder:**
- Alle kontroller: `Move` (`Left As Single, [Top], [Width], [Height]`), `SetFocus`, `Refresh` og `ZOrder` (`[Position]`).
- ListBox og ComboBox: `AddItem` (`Item As String, [Index]`), `RemoveItem` (`Index As Integer`) og `Clear`.
- Form: `Show` (`[Modal], [OwnerForm]`), `Hide`, `Refresh` og `Move`.

**Systemfarger** (`SYSTEM_COLORS`, hex):

| Kode | Farge | Kode | Farge |
|---|---|---|---|
| `&H80000000` | `#c0c0c0` | `&H8000000E` | `#ffffff` |
| `&H80000001` | `#008080` | `&H8000000F` | `#c0c0c0` |
| `&H80000002` | `#000080` | `&H80000010` | `#808080` |
| `&H80000003` | `#808080` | `&H80000011` | `#808080` |
| `&H80000005` | `#ffffff` | `&H80000012` | `#000000` |
| `&H80000006` | `#000000` | `&H80000014` | `#ffffff` |
| `&H80000008` | `#000000` | `&H80000015` | `#000000` |
| `&H80000009` | `#ffffff` | `&H80000016` | `#dfdfdf` |
| `&H8000000D` | `#000080` | `&H80000017` | `#000000` |
|  |  | `&H80000018` | `#ffffe1` |

Vanlige farger konverteres som `&H00BBGGRR` → `#rrggbb`.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('default names increment', () => { const p = newProject(); const f = p.forms[0];
  f.controls.push(newControl(f, 'CommandButton', { left: 0, top: 0 }, null));
  expect(nextDefaultName(f, 'CommandButton')).toBe('Command2'); });
test('new control defaults', () => { const f = newProject().forms[0]; const c = newControl(f, 'TextBox', { left: 120, top: 240 }, null);
  expect(c).toMatchObject({ name: 'Text1', index: null, props: { Text: 'Text1', Width: 1215, Height: 495, Left: 120, Top: 240 } }); });
test('new project', () => expect(newProject()).toMatchObject({ name: 'Project1', startupForm: 'Form1', forms: [{ name: 'Form1', props: { Caption: 'Form1', Width: 4800, Height: 3600 } }] }));
test('name validation', () => { expect(validateName('cmdOK')).toBe(true); expect(validateName('1abc')).toBe(false); expect(validateName('Dim')).toBe(false); expect(validateName('a'.repeat(41))).toBe(false); });
test('prop lookup case-insensitive', () => expect(getPropDef('TextBox', 'text')?.name).toBe('Text'));
test('every type has its default event', () => { for (const t of Object.values(CONTROL_TYPES)) expect(t.events.map(e => e.name)).toContain(t.defaultEvent); });
test('colors', () => { expect(vbColorToCss(0x8000000f)).toBe('#c0c0c0'); expect(vbColorToCss(0x0000ff)).toBe('#ff0000'); expect(vbColorToCss(0xff0000)).toBe('#0000ff'); });
```

- [ ] **Steg 2: Kjør** `npx vitest run tests/model`. Forventet: FAIL.
- [ ] **Steg 3: Implementer** etter tabellene over.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(model): project model and control registry`.

### Oppgave 2: Prosjektfil og fil-API i Backend

**Filer:**
- Opprett: `src/model/serialize.ts`, `src-tauri/src/files.rs`.
- Endre: `src/backend/*.ts`, `src-tauri/src/lib.rs`.
- Test: `tests/model/serialize.test.ts`, og Rust-tester i `files.rs`.

**Grensesnitt:**
- Produserer:
  - `serializeProject(p: Project): string`. Lager JSON med to mellomroms innrykk, med `format` og `version` først.
  - `parseProject(text: string): Project`. Kaster `ProjectFormatError` med meldingen `This is not a VibeBasic project file.` eller `This project was made with a newer version of VibeBasic.`
  - Backend-utvidelse:

```ts
openProjectDialog(): Promise<string | null>;                // filter *.vbb
saveProjectDialog(defaultFileName: string): Promise<string | null>;
openFileDialog(filters: { name: string; extensions: string[] }[]): Promise<string | null>;
readTextFile(path: string): Promise<string>;
writeTextFile(path: string, text: string): Promise<void>;
readBinaryFile(path: string): Promise<Uint8Array>;
setWindowTitle(title: string): Promise<void>;
onCloseRequested(handler: () => Promise<boolean>): void;   // false = avbryt lukking
```

  - Tauri-kommandoene `read_text_file`, `write_text_file` og `read_binary_file`. Skriving går via en midlertidig fil og `rename`, så en krasj ikke ødelegger prosjektet.
  - `BrowserBackend` lagrer filer i `localStorage` under `vibebasic.fs:<sti>`. Dialogene bruker `window.prompt` med filnavn. Den er bare til utvikling.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('roundtrip', () => { const p = newProject(); expect(parseProject(serializeProject(p))).toEqual(p); });
test('header first', () => expect(serializeProject(newProject()).startsWith('{\n  "format": "vibebasic-project",\n  "version": 1')).toBe(true));
test('not a project', () => expect(() => parseProject('{"a":1}')).toThrow('This is not a VibeBasic project file.'));
test('newer version', () => expect(() => parseProject('{"format":"vibebasic-project","version":2}')).toThrow('This project was made with a newer version of VibeBasic.'));
test('garbage', () => expect(() => parseProject('hei')).toThrow('This is not a VibeBasic project file.'));
```

  Rust-test `write_then_read_roundtrip` skriver og leser `"æøå"` i en midlertidig mappe.
- [ ] **Steg 2: Kjør** `npm test` og `npm run test:rust`. Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør begge.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(model): project file format and file backend`.

### Oppgave 3: Kommandostabel og designerkommandoer

**Filer:** Opprett `src/model/commands.ts`. Test: `tests/model/commands.test.ts`

**Grensesnitt:**
- Produserer:

```ts
export interface Command { label: string; do(p: Project): void; undo(p: Project): void }
export class CommandStack {
  constructor(getProject: () => Project, onChange: () => void);
  execute(c: Command): void; undo(): boolean; redo(): boolean;
  readonly canUndo: boolean; readonly canRedo: boolean; readonly undoLabel: string | null;
  markSaved(): void; readonly isDirty: boolean;
  markDirtyExternal(): void;          // for kodeendringer, som har egen angring i CodeMirror
}
export function addControlsCmd(formId: string, defs: ControlDef[]): Command;
export function deleteControlsCmd(formId: string, ids: string[]): Command;      // sletter også barn i Frame/PictureBox
export function moveResizeCmd(formId: string, changes: { id: string; left: number; top: number; width: number; height: number }[]): Command;
export function setPropertyCmd(formId: string, targetId: string | 'form', name: string, value: PropValue): Command;
export function renameCmd(formId: string, targetId: string | 'form', newName: string, newIndex: number | null): Command;
export function zOrderCmd(formId: string, ids: string[], where: 'front' | 'back'): Command;
export function compositeCmd(label: string, cmds: Command[]): Command;           // brukes av AI i plan 05
export function addFormCmd(form: FormDef): Command; export function addModuleCmd(m: ModuleDef): Command;
export function removeItemCmd(id: string): Command;
```

  `renameCmd` endrer **ikke** koden. Hendelsesprosedyrer med det gamle navnet blir stående (VB6-oppførsel, Review Focus 3). Å endre navn på et skjema oppdaterer `project.startupForm` hvis det var oppstartsskjemaet.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('add then undo then redo', () => { /* execute(addControlsCmd) → 1 kontroll; undo → 0; redo → 1 */ });
test('dirty tracking', () => { /* execute → isDirty; markSaved → !isDirty; undo → isDirty */ });
test('delete frame deletes children and undo restores order', () => { /* Frame med Command1 inni, slett Frame, undo gir samme rekkefølge og parentId */ });
test('rename leaves code untouched', () => { const code = 'Private Sub Command1_Click()\nEnd Sub';
  /* form.code = code; renameCmd(.., 'cmdOK') */ expect(form.code).toBe(code); expect(form.controls[0].name).toBe('cmdOK'); });
test('composite undoes as one step', () => { /* compositeCmd med add + setProperty; ett undo fjerner begge */ });
test('execute clears redo', () => { /* execute, undo, execute ny → canRedo false */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.** Kommandoene lagrer det de trenger for angring (gammel verdi, indeks i listen).
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(model): undoable designer commands`.

### Oppgave 4: Win98-tema, widgets og dialoger

**Filer:** Opprett `src/ui98/theme.css`, `dom.ts`, `mdiWindow.ts`, `menubar.ts`, `toolbar.ts`, `dialogs.ts`, `combo.ts`, `tabs.ts`, og `src/ui98/icons/` (msgbox-ikoner: critical, question, exclamation, information). Test: `tests/ui98/dialogs.test.ts`, `tests/ui98/menubar.test.ts`

**Grensesnitt:**
- Produserer:

```ts
// dom.ts
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, unknown>, ...children: (Node | string)[]): HTMLElementTagNameMap[K];
// mdiWindow.ts
export interface MdiWindow { el: HTMLElement; body: HTMLElement; setTitle(t: string): void; activate(): void; close(): void; onClose?: () => boolean }
export function createMdiWindow(host: HTMLElement, o: { title: string; icon?: string; x: number; y: number; width: number; height: number; resizable?: boolean }): MdiWindow;
// menubar.ts
export interface MenuItem { label: string; shortcut?: string; action?: () => void; enabled?: () => boolean; checked?: () => boolean; submenu?: MenuItem[]; separator?: boolean }
export function createMenubar(root: HTMLElement, menus: { label: string; items: MenuItem[] }[]): { refresh(): void };
export function bindShortcuts(menus: { label: string; items: MenuItem[] }[], target: Window): void; // "Ctrl+S" matcher også Cmd+S
// dialogs.ts: modale dialoger i gjeldende dokument (gjenbrukes i skjemavinduer i plan 03)
export function messageBox98(doc: Document, o: { prompt: string; title: string; buttons: number }): Promise<number>; // VB-konstanter inn/ut
export function inputBox98(doc: Document, o: { prompt: string; title: string; defaultText: string }): Promise<string>; // Cancel gir ""
export function compileErrorBox(doc: Document, message: string): Promise<void>;
export function showDialog98(doc: Document, o: { title: string; content: HTMLElement; buttons: { label: string; value: string; default?: boolean; cancel?: boolean; disabled?: boolean }[] }): Promise<string>;
```

- MsgBox-utseende:
  - Ikon til venstre etter `buttons & 0x70`. Knappetekstene er `OK`, `Cancel`, `Abort`, `Retry`, `Ignore`, `Yes` og `No`, i VB6-rekkefølge.
  - Standardknappen bestemmes av `buttons & 0x300`. Enter trykker den, og Escape trykker Cancel/No der det finnes.
  - Teksten brytes ved `vbCrLf`.
- Kompileringsfeil vises med tittel `VibeBasic`, teksten `Compile error:` og en blank linje, så meldingen. Knappene er `OK` og `Help` (deaktivert).

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('yes/no question returns vbNo', async () => { const p = messageBox98(document, { prompt: 'Lagre?', title: 'T', buttons: 4 + 32 });
  expect([...document.querySelectorAll('.dlg98 button')].map(b => b.textContent)).toEqual(['Yes', 'No']);
  (document.querySelectorAll('.dlg98 button')[1] as HTMLButtonElement).click(); expect(await p).toBe(7); });
test('enter presses default button 2', async () => { const p = messageBox98(document, { prompt: 'x', title: 'T', buttons: 1 + 256 });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); expect(await p).toBe(2); });
test('escape cancels inputbox to empty string', async () => { const p = inputBox98(document, { prompt: 'Navn', title: 'T', defaultText: 'Ola' });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(await p).toBe(''); });
test('ctrl shortcut also matches cmd', () => { /* bindShortcuts med Ctrl+S; dispatch metaKey+s → action kalt */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
  - Temaet bygger på 98.css: kopier eller importer CSS-en og fonten med lisensfil i `src/ui98/vendor/`.
  - MDI-vinduer kan dras etter tittellinjen innenfor `host`. Aktivt vindu har blå gradient og inaktive grå.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ui98): win98 theme, menus, mdi windows, dialogs`.

### Oppgave 5: Kontroll-rendering og galleri

**Filer:** Opprett `src/controls/render.ts`, `src/controls/controls.css`, `dev/gallery.html`, `src/dev/gallery.ts`. Test: `tests/controls/render.test.ts`

**Grensesnitt:**
- Konsumerer: `types.ts`, `CONTROL_TYPES`, `vbColorToCss`, `twipsToPx`.
- Produserer:

```ts
export type AssetResolver = (ref: PictureRef) => string | null;   // data-URL
export interface ControlView {
  el: HTMLElement;                         // posisjonert absolutt i forelderen
  inputEl?: HTMLElement;                   // fokuserbart indre element (input, textarea, select, button)
  childHost?: HTMLElement;                 // for Frame/PictureBox
  update(changed: Record<string, PropValue>): void;
}
export interface FormSurface { el: HTMLElement; clientEl: HTMLElement; views: Map<string, ControlView>; update(id: string | 'form', changed: Record<string, PropValue>): void;
  addControl(def: ControlDef): void; removeControl(id: string): void }
export function renderControl(def: ControlDef, mode: 'design' | 'run', assets: AssetResolver): ControlView;
export function renderFormSurface(form: FormDef, mode: 'design' | 'run', assets: AssetResolver, opts?: { showGrid?: boolean; gridX?: number; gridY?: number }): FormSurface;
```

- Regler:
  - `el.dataset.controlId = def.id`.
  - I designmodus er indre elementer ikke interaktive (`pointer-events: none` og `tabindex=-1`), og Timer vises som et 28×28 px ikon.
  - I kjøremodus er Timer skjult.
  - `FormSurface.el` er hele vinduet: tittellinje med Caption, ikon og kontrollknapper etter ControlBox, MinButton og MaxButton. `clientEl` er klientområdet med prikkete rutenett i designmodus når `showGrid` er på.
  - ProgressBar: Standard tegnes som navy blokker (`#000080`, 8 px brede med 2 px mellomrom). Smooth tegnes som en sammenhengende stolpe. Bredden er `(Value − Min) / (Max − Min)`.
  - CommandButton med `Default=True` får tykk svart kant.
  - Form og PictureBox får et tomt `<div class="draw-layer">` under kontrollene. Det er satt av til tegnemetodene i fase 6, så de kan legges til uten omskriving (spec kap. 6).

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('position in px', () => { const v = renderControl(cmd({ Left: 150, Top: 300, Width: 1215, Height: 495 }), 'run', none);
  expect(v.el.style.left).toBe('10px'); expect(v.el.style.top).toBe('20px'); expect(v.el.style.width).toBe('81px'); expect(v.el.style.height).toBe('33px'); });
test('progressbar fill', () => { const v = renderControl(pb({ Min: 0, Max: 200, Value: 50 }), 'run', none);
  expect((v.el.querySelector('.pb-fill') as HTMLElement).style.width).toBe('25%'); });
test('update caption', () => { const v = renderControl(cmd({ Caption: 'A' }), 'run', none); v.update({ Caption: 'B' }); expect(v.el.textContent).toBe('B'); });
test('design mode textbox not focusable', () => { const v = renderControl(txt({}), 'design', none); expect(v.inputEl!.tabIndex).toBe(-1); });
test('timer hidden at runtime', () => expect(renderControl(tmr({}), 'run', none).el.style.display).toBe('none'));
test('frame hosts children', () => { /* renderFormSurface med Frame1 og Command1 (parentId=Frame1) → Command1.el.parentElement === frameView.childHost */ });
test('backcolor', () => expect(renderControl(lbl({ BackColor: 0xff }), 'run', none).el.style.backgroundColor).toBe('rgb(255, 0, 0)'));
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer alle 15 typene.** `dev/gallery.html` viser alle kontrollene i begge moduser på et Form, med noen ulike egenskaper.
- [ ] **Steg 4: Kjør tester.** Forventet: PASS.
  Sjekk deretter visuelt: `npm run dev`, åpne `http://localhost:1420/dev/gallery.html` i nettleserpanelet og ta skjermbilde. Kontrollene skal ligne VB6 under Windows 98.
- [ ] **Steg 5: Commit** med meldingen `feat(controls): shared control rendering + gallery`.

### Oppgave 6: IDE-skall: hovedvindu, menyer, verktøylinje og Toolbox

**Filer:** Opprett `src/ide/main.ts`, `ideState.ts`, `layout.ts`, `menus.ts`, `toolbox.ts`, `src/ide/icons/*`. Endre `src/main.ts`. Test: `tests/ide/menus.test.ts`, `tests/ide/ideState.test.ts`

**Grensesnitt:**
- Produserer:

```ts
// ideState.ts
export type ActiveView = { kind: 'designer'; formId: string } | { kind: 'code'; itemId: string } | { kind: 'none' };
export class IdeState {
  project: Project; filePath: string | null; stack: CommandStack;
  selection: { formId: string; ids: string[] } | null;   // tom ids = skjemaet selv
  activeView: ActiveView; currentTool: ControlType | 'Pointer';
  mode: 'design' | 'run' | 'break';                        // plan 03 setter run/break
  options: IdeOptions;                                     // Auto Syntax Check, Require Variable Declaration, grid
  on(event: 'project' | 'selection' | 'activeView' | 'mode' | 'options', cb: () => void): void;
  emit(event: …): void;
}
export interface IdeOptions { autoSyntaxCheck: boolean; requireVariableDeclaration: boolean; showGrid: boolean; gridWidth: number; gridHeight: number; alignToGrid: boolean }
// menus.ts
export function buildMenus(ide: IdeActions): { label: string; items: MenuItem[] }[];
export interface IdeActions { [name: string]: () => void }   // navngitte handlinger; ukjente gir deaktiverte menypunkter
```

- Menyer (etiketter og snarveier er eksakte, og punkter uten handling ennå er deaktivert):
  - **File:** New Project Ctrl+N, Open Project... Ctrl+O, Save Project Ctrl+S, Save Project As..., Make Project1.app... (plan 04), Exit.
  - **Edit:** Undo Ctrl+Z, Redo Ctrl+Y, Cut Ctrl+X, Copy Ctrl+C, Paste Ctrl+V, Delete Del, Select All Ctrl+A, Find... Ctrl+F.
  - **View:** Code F7, Object Shift+F7, Immediate Window Ctrl+G, Project Explorer Ctrl+R, Properties Window F4, Toolbox.
  - **Project:** Add Form, Add Module, Remove \<navn\>, Project1 Properties...
  - **Format:** Align ▸ (Lefts, Centers, Rights, Tops, Middles, Bottoms), Make Same Size ▸ (Width, Height, Both), Order ▸ (Bring to Front Ctrl+J, Send to Back Ctrl+K), Lock Controls.
  - **Debug:** Step Into F8, Toggle Breakpoint F9. Begge er deaktivert til fase 6.
  - **Run:** Start F5, Start With Full Compile Ctrl+F5, Break Ctrl+Break, End, Restart Shift+F5 (plan 03).
  - **Tools:** Ask AI... Ctrl+I (plan 05), Options...
  - **Help:** About VibeBasic...
- `Project1` i menyteksten byttes med `project.name`.
- Oppsett:
  - Menylinje og verktøylinje øverst. Verktøylinjen har ikoner for New, Open, Save, Cut, Copy, Paste, Undo, Redo, Start, Break, End, Project Explorer, Properties og Toolbox.
  - Toolbox er dokket til venstre: to kolonner med 24×24-knapper og tooltips.
  - MDI-området i midten har bakgrunn `#808080`.
  - Til høyre er en kolonne med Project Explorer øverst og Properties under, og en flyttbar skillelinje mellom dem.
  - Immediate-vinduet er dokket nederst og skjult til det åpnes med View eller Ctrl+G.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('menu labels', () => expect(buildMenus({}).map(m => m.label)).toEqual(['File', 'Edit', 'View', 'Project', 'Format', 'Debug', 'Run', 'Tools', 'Help']));
test('missing actions disabled', () => { const run = buildMenus({}).find(m => m.label === 'Run')!; expect(run.items[0].enabled!()).toBe(false); });
test('make item uses project name', () => { /* med project.name 'Kalk' → 'Make Kalk.app...' */ });
test('ide state emits selection', () => { /* on('selection') kalles ved setSelection */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.** `src/main.ts` starter IDE-en (`startIde(backend)`) med `newProject()`. Form1 åpnes i et designervindu, foreløpig bare `renderFormSurface` i designmodus.
- [ ] **Steg 4: Kjør tester.** Forventet: PASS.
  Sjekk deretter visuelt med `npm run dev` i nettleserpanelet. Skjermbildet skal ligne skisse A: menyer, verktøylinje, Toolbox, Form1 med rutenett, Project Explorer og Properties.
- [ ] **Steg 5: Commit** med meldingen `feat(ide): main window shell, menus, toolbox`.

### Oppgave 7: Skjemadesigner

**Filer:** Opprett `src/ide/designer.ts`, `designerLogic.ts`, `clipboard.ts`. Test: `tests/ide/designerLogic.test.ts`, `tests/ide/designer.test.ts`

**Grensesnitt:**
- Konsumerer: `IdeState`, `CommandStack` og kommandoene, `renderFormSurface`, `newControl`, `messageBox98`.
- Produserer:

```ts
// designerLogic.ts (rene funksjoner, alt i twips)
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export interface Rect { left: number; top: number; width: number; height: number }
export function snap(v: number, grid: number, enabled: boolean): number;
export function computeResize(r: Rect, h: Handle, dx: number, dy: number, o: { grid: number; snap: boolean }): Rect;  // minste størrelse 1 rute
export function computeMove(rects: Rect[], dx: number, dy: number, o: { grid: number; snap: boolean }): Rect[];      // fester første rect, flytter resten likt
export function hitTest(form: FormDef, x: number, y: number): string | null;     // øverste kontroll, går inn i containere
export function controlsInRect(form: FormDef, r: Rect, parentId: string | null): string[];
export function absoluteRect(form: FormDef, id: string): Rect;
export function containerAt(form: FormDef, x: number, y: number, exclude: string[]): string | null;
export function alignRects(rects: Rect[], how: 'lefts' | 'centers' | 'rights' | 'tops' | 'middles' | 'bottoms'): Rect[]; // etter siste valgte (primær), som i VB6
// designer.ts
export function openDesigner(ide: IdeState, formId: string): MdiWindow;
export function pasteControls(ide: IdeState, formId: string, defs: ControlDef[]): Promise<void>;  // spørsmål om kontrollmatrise
```

- Oppførsel som i VB6:
  - **Plassere kontroller:**
    - Velg et verktøy i Toolbox og dra et rektangel på skjemaet. Da lages kontrollen med den størrelsen.
    - Et klikk uten å dra gir standardstørrelse.
    - Dobbeltklikk på verktøyet legger kontrollen midt på skjemaet.
    - Etterpå går verktøyet tilbake til Pointer.
  - **Velge:**
    - Klikk velger én kontroll, og Ctrl- eller Shift-klikk legger til eller fjerner.
    - Et gummibånd fra tomt område velger alle kontroller som berøres.
    - Klikk på tomt område velger skjemaet.
    - Én valgt kontroll har 8 fylte håndtak. Ved flere valgte er håndtakene hule, og den primære har fylte.
  - **Flytte og endre størrelse:**
    - Dra flytter. Håndtakene endrer størrelse, også på skjemaet selv (høyre, nedre og hjørnet).
    - Ctrl+piltast flytter en rute, og Shift+piltast endrer størrelsen med en rute.
  - **Containere:** slippes en kontroll i en Frame eller PictureBox, blir den et barn med relative koordinater. Flytter du containeren, følger barna med.
  - **Slette og kopiere:** Delete sletter. Ctrl+C, Ctrl+X og Ctrl+V bruker et internt utklippsbord, og innlimte kontroller havner øverst til venstre (0,0) i skjemaet.
  - **Innliming med navn som finnes fra før:** dialogen `You already have a control named 'Command1'. Do you want to create a control array?` (vbYesNo + vbQuestion).
    - Yes: den eksisterende får `index 0` og den nye `index 1`, eller neste ledige.
    - No: den nye får neste standardnavn.
  - **Dobbeltklikk** på en kontroll eller på skjemaet åpner kodevinduet på standardhendelsen (oppgave 9).
  - Alle endringer går gjennom `CommandStack`, og en hel draing er ett angresteg.
  - **Format-menyen:** Align, Make Same Size og Order virker på valget.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('snap', () => { expect(snap(130, 120, true)).toBe(120); expect(snap(190, 120, true)).toBe(240); expect(snap(130, 120, false)).toBe(130); });
test('resize se', () => expect(computeResize({ left: 0, top: 0, width: 1200, height: 480 }, 'se', 130, 10, { grid: 120, snap: true })).toEqual({ left: 0, top: 0, width: 1320, height: 480 }));
test('resize nw keeps opposite corner', () => expect(computeResize({ left: 240, top: 240, width: 1200, height: 480 }, 'nw', -120, -120, { grid: 120, snap: true })).toEqual({ left: 120, top: 120, width: 1320, height: 600 }));
test('min size one grid cell', () => expect(computeResize({ left: 0, top: 0, width: 240, height: 240 }, 'e', -1000, 0, { grid: 120, snap: true }).width).toBe(120));
test('hit test topmost and inside frame', () => { /* Frame med Command inni: punkt inni Command → Command-id */ });
test('align lefts to primary', () => expect(alignRects([{ left: 100, top: 0, width: 10, height: 10 }, { left: 300, top: 50, width: 10, height: 10 }], 'lefts').map(r => r.left)).toEqual([300, 300]));
test('paste duplicate asks for control array; yes makes indices 0 and 1', async () => { /* messageBox98 besvares med vbYes */ expect(names).toEqual([['Command1', 0], ['Command1', 1]]); });
test('paste duplicate; no gives Command2', async () => { /* besvares vbNo */ });
test('drawing a control with tool creates it and resets tool', () => { /* pointerdown/move/up i jsdom på clientEl */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør tester.** Forventet: PASS. Prøv deretter manuelt i nettleserpanelet: tegn, flytt, endre størrelse, kopier og lim inn.
- [ ] **Steg 5: Commit** med meldingen `feat(ide): form designer`.

### Oppgave 8: Properties-vinduet

**Filer:** Opprett `src/ide/properties.ts`, `src/ide/propertyEditors.ts`. Test: `tests/ide/properties.test.ts`

**Grensesnitt:**
- Konsumerer: `IdeState.selection`, `getPropDef`, `setPropertyCmd`, `renameCmd`, `messageBox98`, `backend.openFileDialog` og `readBinaryFile`.
- Produserer:
  - `createPropertiesWindow(host: HTMLElement, ide: IdeState): { refresh(): void }`
  - `parsePropertyInput(def: PropDef, text: string): { ok: true; value: PropValue } | { ok: false }` (ren funksjon)

- Oppførsel:
  - **Toppen:** en nedtrekksliste med alle objektene på skjemaet, vist som `Command1 CommandButton` (VB6-format, kontrollmatriser som `Command1(0) CommandButton`). Under den er en Alphabetic-fane. Claudes valg: Categorized og beskrivelsesfeltet er ikke med.
  - **Listen:** `(Name)` står først, deretter alfabetisk. Bare egenskaper med `designTime: true` vises. Indeksen vises som `Index` når kontrollen er i en matrise.
  - **Redigering:**

| Type | Redigering |
|---|---|
| Tekst | Tekstfelt, lagres med Enter eller ved å gå ut av feltet |
| `text` og `list` | Nedtrekksfelt med flerlinjet redigering, der Ctrl+Enter gir ny linje |
| `bool` | Nedtrekksliste med True og False |
| `enum` | Nedtrekksliste med verdier som `2 - Sizable` |
| `color` | Nedtrekksliste med fanene Palette (`PALETTE_48`) og System (navngitte systemfarger). Verdien vises som `&H8000000F&` |
| `font` | `...`-knapp som åpner en fontdialog med fontliste, størrelse og fet, kursiv og understreket |
| `picture` | `...` åpner en fildialog for png, jpg, gif og bmp, og bildet legges i `project.assets` som base64. Verdien vises som `(Bitmap)` eller `(None)`, og Delete fjerner bildet |
| Tall | Heltall i twips |

  - **Feil:**
    - Ugyldig verdi gir `messageBox98` med `Invalid property value` (vbExclamation), og den gamle verdien settes tilbake.
    - Ugyldig navn gir `Invalid property value`.
    - Navn som finnes fra før gir spørsmål om kontrollmatrise (samme tekst som i oppgave 7). Svarer du No, settes navnet tilbake (Review Focus 3).
  - **Flervalg:** bare felles egenskaper vises, og en endring gjelder alle (`compositeCmd`).
  - F4 fokuserer vinduet.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('int parse', () => { expect(parsePropertyInput(def('Left', 'int'), '120')).toEqual({ ok: true, value: 120 }); expect(parsePropertyInput(def('Left', 'int'), 'abc')).toEqual({ ok: false }); });
test('enum parse accepts "2 - Sizable" and "2"', () => { /* begge gir 2 */ });
test('color parse', () => expect(parsePropertyInput(def('BackColor', 'color'), '&H000000FF&')).toEqual({ ok: true, value: 255 }));
test('invalid name shows message and reverts', async () => { /* skriv '1abc' i (Name) → dialog 'Invalid property value', navn uendret */ });
test('duplicate name asks for control array', async () => { /* Command2 → 'Command1', svar No → navn forblir Command2 */ });
test('list order: (Name) first then alphabetical', () => { /* radene for CommandButton */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør tester.** Forventet: PASS. Prøv deretter manuelt: endre Caption og se at designeren oppdateres med en gang.
- [ ] **Steg 5: Commit** med meldingen `feat(ide): properties window`.

### Oppgave 9: Kodevinduet

**Filer:** Opprett `src/model/procedures.ts`, `src/ide/codeWindow.ts`, `src/ide/vbLanguage.ts`. Test: `tests/model/procedures.test.ts`, `tests/ide/codeWindow.test.ts`

**Grensesnitt:**
- Konsumerer:
  - Fra plan 01: `tokenize`, `KEYWORD_CASE`, `prettifyLine`, `collectIdentifiers`, `findSyntaxErrors` og `checkLineSyntax`.
  - Fra denne planen: `CONTROL_TYPES` og `compileErrorBox`.
- Produserer:

```ts
// procedures.ts (linjebasert, tåler syntaksfeil)
export interface ProcInfo { name: string; kind: 'sub' | 'function'; line: number; endLine: number }   // 1-baserte linjer
export function listProcedures(source: string): ProcInfo[];
export function findProcedureRange(source: string, name: string): ProcInfo | null;   // uavhengig av store/små bokstaver
export function buildEventStub(objectName: string, isArray: boolean, ev: EventDef): string;
export function insertProcedure(source: string, stub: string): { source: string; cursorLine: number };  // legges til slutt, med en tom linje imellom
// codeWindow.ts
export interface CodeWindow { win: MdiWindow; gotoProcedure(objectName: string, eventName: string): void; gotoLine(line: number): void;
  setBreakLine(line: number | null): void; markErrorLines(lines: number[]): void;
  applyChange(from: number, to: number, text: string): void;    // én angretransaksjon (plan 05)
  getCursorLine(): number; getSource(): string }
export function openCodeWindow(ide: IdeState, itemId: string): CodeWindow;   // gjenbruker et åpent vindu
```

- Oppførsel:
  - **Vindu:** tittelen er `Project1 - Form1 (Code)`. Øverst er to nedtrekkslister.
    - Objekt: `(General)`, `Form` og så kontrollene alfabetisk. En kontrollmatrise vises én gang.
    - Prosedyre: med `(General)` er det `(Declarations)` og de generelle prosedyrene. Med et objekt er det hendelsene for typen, og de som har kode står i fet skrift.
    - Velger du en hendelse som ikke finnes, settes `buildEventStub` inn og markøren plasseres på den tomme linjen.
  - **Visning:** bare Full Module View, med en tynn grå strek mellom prosedyrene. Claudes valg.
  - **Syntaksfarger:** fra `tokenize`, med fargene i Felles regler.
  - **Når markøren forlater en linje:**
    1. Linjen kjøres gjennom `prettifyLine`. Den bruker `collectIdentifiers(source)`, kontrollnavnene og «Form»/«Me». Egenskapsnavn etter et kjent kontrollnavn + `.` får riktig stavemåte fra registeret, så `Text1.text` blir `Text1.Text`.
    2. Er `autoSyntaxCheck` på og `checkLineSyntax(linje)` gir feil, blir linjen rød og `compileErrorBox(melding)` vises.
    3. Den røde markeringen fjernes når linjen blir gyldig.
  - **Require Variable Declaration** (i Options): er den på, får nye moduler og skjemaer `Option Explicit` øverst.
  - **Endringer:** kodeendringer oppdaterer `form.code` eller `module.code` og kaller `stack.markDirtyExternal()`. Ctrl+Z og Ctrl+Y i kodevinduet bruker CodeMirrors egen angring.
  - Dobbeltklikk i designeren (oppgave 7) kaller `gotoProcedure(navn, defaultEvent)`.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('event stub', () => expect(buildEventStub('Command1', false, { name: 'Click', params: '' })).toBe('Private Sub Command1_Click()\n\nEnd Sub'));
test('array stub', () => expect(buildEventStub('Text1', true, { name: 'KeyPress', params: 'KeyAscii As Integer' })).toBe('Private Sub Text1_KeyPress(Index As Integer, KeyAscii As Integer)\n\nEnd Sub'));
test('form stub', () => expect(buildEventStub('Form', false, { name: 'Load', params: '' })).toBe('Private Sub Form_Load()\n\nEnd Sub'));
test('list procedures tolerant', () => expect(listProcedures('Option Explicit\nPrivate Sub A()\nx = \nEnd Sub\nFunction B() As Integer\nEnd Function').map(p => [p.name, p.line, p.endLine])).toEqual([['A', 2, 4], ['B', 5, 6]]));
test('insert procedure', () => expect(insertProcedure('Option Explicit', 'Private Sub A()\n\nEnd Sub')).toEqual({ source: 'Option Explicit\n\nPrivate Sub A()\n\nEnd Sub', cursorLine: 4 }));
test('leaving a line prettifies and capitalizes control property', () => { /* skriv 'text1.text="x"' i Command1_Click, flytt markøren ned → 'Text1.Text = "x"' */ });
test('leaving a bad line marks red and shows compile error', async () => { /* 'x = ' → linjen har klassen cm-vb-error, og dialogtekst inneholder 'Expected: expression' */ });
test('procedure dropdown bolds implemented events', () => { /* Command1_Click finnes → Click er fet */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør tester.** Forventet: PASS. Prøv deretter manuelt: dobbeltklikk Command1, skriv kode og bytt hendelse i listen.
- [ ] **Steg 5: Commit** med meldingen `feat(ide): code window`.

### Oppgave 10: Project Explorer, flere skjemaer og moduler, dialoger

**Filer:** Opprett `src/ide/projectExplorer.ts`, `projectDialogs.ts`, `optionsDialog.ts`. Test: `tests/ide/projectExplorer.test.ts`

**Grensesnitt:**
- Produserer:
  - `createProjectExplorer(host, ide)`
  - `showProjectProperties(ide): Promise<void>` med fanen General: Project Name, Startup Object (nedtrekk med skjemaer) og Application Title (= `project.title`). Plan 04 legger til fanen Make.
  - `showOptions(ide): Promise<void>` med fanene Editor (Auto Syntax Check, Require Variable Declaration) og General (Show Grid, Grid Width og Height i twips, Align Controls to Grid). Plan 05 legger til fanen AI. Valgene lagres via `backend.saveSettings('ide', …)` / `loadSettings`. Legg disse til i Backend: `loadSettings<T>(key: string): Promise<T | null>`, `saveSettings(key: string, v: unknown): Promise<void>`. `BrowserBackend` og `TauriBackend` bruker `localStorage` under `vibebasic.settings:<key>`.
  - `addForm(ide)` og `addModule(ide)` (navnene `Form2` og `Module1` og så videre), og `removeItem(ide, id)`. Fjerning av oppstartsskjemaet setter et annet skjema som oppstart. Det siste skjemaet kan ikke fjernes.

- Oppførsel:
  - Treet: `Project1 (Project1.vbb)`, `Forms` → `Form1 (Form1)`, og `Modules` → `Module1 (Module1)`.
  - Knappene View Code, View Object og Toggle Folders.
  - Dobbeltklikk på et skjema åpner designeren, og på en modul åpner kodevinduet.
  - Høyreklikk gir View Code, View Object og Remove \<navn\>.
  - Skjemanavn endres i Properties når skjemaet er valgt.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('add form names Form2', () => { /* addForm → project.forms[1].name === 'Form2' */ });
test('cannot remove last form', () => { /* removeItem på eneste skjema → uendret + messageBox */ });
test('removing startup form moves startup', () => { /* to skjemaer, fjern Form1 → startupForm 'Form2' */ });
test('require variable declaration adds Option Explicit to new module', () => { /* options.requireVariableDeclaration = true → module.code starter med 'Option Explicit' */ });
test('tree labels', () => { /* tekster som over */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ide): project explorer, project properties, options`.

### Oppgave 11: Filoperasjoner og ulagrede endringer

**Filer:** Opprett `src/ide/fileController.ts`. Test: `tests/ide/fileController.test.ts` (med en falsk Backend)

**Grensesnitt:**
- Produserer:

```ts
export class FileController {
  constructor(ide: IdeState, backend: Backend);
  newProject(): Promise<void>; open(): Promise<void>; save(): Promise<boolean>; saveAs(): Promise<boolean>;
  confirmDiscard(): Promise<boolean>;   // true = fortsett
  updateTitle(): void;                   // "<navn> - VibeBasic [design|run|break]"
}
```

- Oppførsel:
  - **Spørsmål om lagring:** `confirmDiscard` viser dialogen `Save changes to the following files?` med en liste over prosjektfilnavnet (`Project1.vbb`) og knappene `Yes`, `No` og `Cancel`.
    - Yes lagrer. Avbryter du lagre-dialogen, er resultatet false.
    - No fortsetter uten å lagre.
    - Cancel gir false.
    - Dialogen vises bare når `stack.isDirty`.
  - **Når det spørres:** New, Open, Exit og lukking av vinduet (`backend.onCloseRequested`) går alle gjennom `confirmDiscard`.
  - **Lagring:**
    - `save` uten `filePath` går til `saveAs`, med `<project.name>.vbb` som standard filnavn.
    - Etter lagring kalles `stack.markSaved()` og tittelen oppdateres.
  - **Åpning:** feil fra `parseProject` vises i `messageBox98` med vbCritical, og prosjektet som er åpent blir stående.

- [ ] **Steg 1: Skriv de feilende testene.** (Review Focus 4)

```ts
test('clean project opens without asking', async () => { /* ingen dialog */ });
test('dirty + cancel aborts new', async () => { /* svar Cancel → prosjekt uendret */ });
test('dirty + no discards', async () => { /* svar No → nytt Project1 */ });
test('dirty + yes saves then continues', async () => { /* svar Yes → writeTextFile kalt, så nytt prosjekt */ });
test('yes but save dialog cancelled aborts', async () => { /* saveProjectDialog → null → false */ });
test('close window asks', async () => { /* onCloseRequested-handler gir false ved Cancel */ });
test('bad file shows error and keeps project', async () => { /* readTextFile gir 'hei' → dialog 'This is not a VibeBasic project file.' */ });
test('title', () => { /* 'Project1 - VibeBasic [design]' */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer, og koble til menyene File og Exit.**
- [ ] **Steg 4: Kjør tester.** Forventet: PASS. Prøv deretter manuelt i `npm run tauri dev`: lagre, lukk og åpne prosjektet igjen.
- [ ] **Steg 5: Commit** med meldingen `feat(ide): file operations and unsaved-changes prompt`.

### Oppgave 12: IntelliSense-liste

**Filer:** Opprett `src/ide/completions.ts`. Endre `src/ide/codeWindow.ts`. Test: `tests/ide/completions.test.ts`

**Grensesnitt:**
- Produserer `completionsFor(lineBeforeCursor: string, form: FormDef | null): { from: number; options: string[] } | null`. `from` er kolonnen der ordet som fullføres starter.
- Oppførsel:
  - Etter `Kontrollnavn.`, `Kontrollnavn(n).` eller `Me.Kontroll.` vises egenskaper med `runtime !== 'none'` og metoder for typen.
  - Etter `Me.` vises skjemaets egenskaper og metoder pluss alle kontrollnavnene.
  - Listen filtreres på prefikset som er skrevet, er alfabetisk, og Tab eller Enter setter inn.
  - Den vises bare i kode som ikke står i en streng eller kommentar.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('textbox members', () => expect(completionsFor('  Text1.', form)!.options).toEqual(expect.arrayContaining(['Text', 'SelStart', 'SetFocus'])));
test('prefix filter', () => expect(completionsFor('Text1.Se', form)!.options).toEqual(['SelLength', 'SelStart', 'SelText', 'SetFocus']));
test('me lists controls', () => expect(completionsFor('Me.', form)!.options).toEqual(expect.arrayContaining(['Text1', 'Caption', 'Show'])));
test('not in strings', () => expect(completionsFor('x = "Text1.', form)).toBeNull());
test('unknown object', () => expect(completionsFor('Foo.', form)).toBeNull());
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer** som en kilde for `@codemirror/autocomplete`.
- [ ] **Steg 4: Kjør tester.** Forventet: PASS. Kjør også hele `npm test`.
- [ ] **Steg 5: Commit** med meldingen `feat(ide): member completion list`.
