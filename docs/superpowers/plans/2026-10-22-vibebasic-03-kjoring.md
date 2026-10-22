# VibeBasic plan 03: Kjøring (F5, skjemavinduer, break-modus)

> **For agentiske arbeidere:** PÅKREVD UNDER-FERDIGHET: Bruk superpowers:subagent-driven-development (anbefalt) eller superpowers:executing-plans. Stegene bruker avkrysningsbokser (`- [ ]`).

**Mål:** F5 kjører prosjektet. Hvert VB-skjema er et ekte vindu, hendelser kjører BASIC-koden, og MsgBox og InputBox ser ut som i VB6. Kjøretidsfeil gir VB6-dialog med Debug, som går til break-modus med gul linje og Immediate-vindu.

**Arkitektur:**
- `RunSession` eier `Program` fra plan 01 og ett `FormInstance` (et `VBObject`) per lastet skjema.
- Hver kontroll har et speil av egenskapene. Endringer legges i en patch-kø og sendes til skjemavinduet.
- Skjemavinduet er en «dum» renderer bygget på `renderFormSurface` fra plan 02. Den tar imot `ToWindow`-meldinger og sender `FromWindow`-hendelser tilbake.
- `FormHost` har to implementasjoner:
  - `InlineFormHost` tegner i samme dokument. Den brukes i tester og når IDE-en kjører i nettleseren.
  - `TauriFormHost` lager ekte Tauri-vinduer uten systemramme, med Win98-tittellinje.
- Den samme `RunSession` brukes av ferdige apper i plan 04.

**Teknologi:** TypeScript, Vitest med jsdom, Tauri 2 (`WebviewWindow` og events).

**Spec:** [spec](../specs/2026-10-22-vibebasic-design.md), kap. 2.4 (kontrollmatriser), 2.6 (kjøring og break-modus) og 6 (bilder). Felles regler: se [oversikten](2026-10-22-vibebasic-00-oversikt.md).

## Regler for denne planen

- Skjemavinduets størrelse er `Width/15 × Height/15` px, inkludert tittellinje (18 px) og ramme (4 px på hver side for Sizable, 3 px ellers).
  - `ScaleWidth` og `ScaleHeight` (bare i kjøring, kun lesing) er klientområdet i twips.
  - Mus-koordinater (X, Y) i hendelser er i twips, relativt til kontrollen.
- Rekkefølgen når et skjema lastes og vises: `Form_Initialize` → `Form_Load` → (vises) → `Form_Resize` → `Form_Activate`.
- Lukkeknappen gir `Form_QueryUnload(Cancel, UnloadMode = 0)` og så `Form_Unload(Cancel)`. Settes `Cancel ≠ 0` i en av dem, avbrytes lukkingen.
  - `Unload X` fra kode gir `UnloadMode = 1`.
  - Et skjema som er lastet ut, får design-egenskapene tilbake neste gang det brukes.
- Programmet slutter når ingen skjemaer er lastet og ingen kode kjører, eller ved `End` eller End-knappen.
- Kodevindu, designer, Toolbox og Properties er skrivebeskyttet i kjøring og break. Det er Claudes valg: edit-and-continue kommer i fase 6.
- Patcher sendes senest ved hver av disse:
  - slutten av en hendelseshandler
  - `DoEvents`
  - før en dialog vises
  - `onBreak`
  - hvert 16. ms så lenge det er patcher i kø

## Filer

```
src/run/protocol.ts         FormSnapshot, ToWindow, FromWindow
src/run/formHost.ts         FormHost, FormWindow
src/run/objects/controlObject.ts   ControlObject (VBObject) + ControlArrayObject
src/run/objects/formInstance.ts    FormInstance (VBObject), livssyklus
src/run/objects/appObjects.ts      App, Screen, PictureObject
src/run/patchQueue.ts       PatchQueue
src/run/formWindow.ts       renderer i vinduet: ToWindow inn, FromWindow ut (delt av inline og Tauri)
src/run/inlineFormHost.ts
src/run/tauriFormHost.ts
src/run/formWindowMain.ts   oppstart av form.html (Tauri-vindu)
src/run/session.ts          RunSession (Host for Program)
src/run/windowOptions.ts    windowOptionsFor
src/ide/runController.ts    F5/Break/End, tilstandsmaskin, skrivebeskyttelse, tittel
src/ide/immediate.ts        Immediate-vinduet
form.html
src-tauri/capabilities/default.json   (utvides)
tests/run/*, tests/ide/runController.test.ts, tests/ide/immediate.test.ts
tests/run/e2e/*.vbb          eksempelprosjekter for ende-til-ende-tester
```

---

### Oppgave 1: Protokoll, kontrollobjekter og patch-kø

**Filer:** Opprett `src/run/protocol.ts`, `formHost.ts`, `patchQueue.ts`, `objects/controlObject.ts`. Test: `tests/run/controlObject.test.ts`

**Grensesnitt:**
- Konsumerer:
  - Fra plan 01: `VBObject`, `VBValue`, `VBRuntimeError` og `coerce`.
  - Fra plan 02: `ControlDef`, `getPropDef` og `CONTROL_TYPES`.
- Produserer:

```ts
// protocol.ts
export interface FormSnapshot { key: string; form: FormDef; assets: Record<string, string>;      // asset-nøkkel → data-URL
  handled: Record<string, string[]>; mode: 'ide' | 'app' }                                        // kontroll-id/'form' → hendelser som har kode
export type ToWindow =
  | { t: 'patch'; id: string | 'form'; props: Record<string, PropValue> }
  | { t: 'focus'; id: string }
  | { t: 'show' } | { t: 'hide' }
  | { t: 'blocked'; blocked: boolean }                     // modalt skjema eller break: ignorer input
  | { t: 'keyResult'; requestId: number; keyAscii: number };
export type FromWindow =
  | { t: 'ready' }
  | { t: 'event'; id: string | 'form'; event: string; args: (number | string)[]; state?: Record<string, PropValue>; requestId?: number }
  | { t: 'state'; id: string; props: Record<string, PropValue> }   // brukeren endret noe uten handler
  | { t: 'closeRequest' }
  | { t: 'resized'; width: number; height: number };          // twips
// formHost.ts
export interface FormWindow { send(m: ToWindow): void; onMessage(cb: (m: FromWindow) => void): void; close(): Promise<void> }
export interface FormHost {
  openForm(s: FormSnapshot, o: { modal: boolean }): Promise<FormWindow>;
  messageBox(o: { prompt: string; title: string; buttons: number }): Promise<number>;
  inputBox(o: { prompt: string; title: string; defaultText: string }): Promise<string>;
  runtimeErrorBox(o: { number: number; description: string; compile: boolean; mode: 'ide' | 'app'; title: string }): Promise<'end' | 'debug'>;
}
// patchQueue.ts
export class PatchQueue { constructor(send: (formKey: string, m: ToWindow) => void); set(formKey: string, id: string | 'form', props: Record<string, PropValue>): void; flush(): void; readonly pending: boolean }
// controlObject.ts
export class ControlObject implements VBObject {
  constructor(def: ControlDef, formKey: string, queue: PatchQueue, ctx: RunContext);
  readonly props: Record<string, PropValue>;    // speilet
  applyState(props: Record<string, PropValue>): void;   // fra vinduet, sender ikke patch tilbake
}
export class ControlArrayObject implements VBObject { item(i: number): VBObject; /* Count, LBound, UBound, Ubound */ }
export interface RunContext { resolveAsset(ref: PictureRef): string | null; loadPicture(path: string): Promise<VBValue> }
```

- Regler:
  - `getMember` og `setMember` slår opp i `getPropDef`.
    - `runtime: 'none'`: feil 438.
    - `'ro'` ved skriving: feil 383 `Property is read-only`.
  - Verdier konverteres etter `PropDef.kind`: `bool` via `toBool`, `int` via `coerce(…, 'Long')`, `enum` må være en gyldig verdi, ellers 380.
  - `ProgressBar.Value` utenfor `Min..Max` gir 380. `ListIndex` utenfor `-1..ListCount-1` gir 380.
  - ListBox og ComboBox:
    - `AddItem item[, index]` endrer `List` og `NewIndex`. Med `Sorted` settes elementet inn sortert.
    - `RemoveItem i` med ugyldig `i` gir feil 5.
    - `Clear` tømmer listen og setter `ListIndex` til −1.
    - `List(i)` leser og skriver. `ListCount` og `Text` er tilgjengelige.
  - TextBox: `SelStart`, `SelLength` og `SelText`. Skriving sendes som `patch`.
  - `Move l, t, w, h` setter Left, Top, Width og Height. `SetFocus` sender `focus`.
  - Timer: endringer i `Enabled` eller `Interval` meldes til `RunContext`. Utvid med `timerChanged(ctrl: ControlObject): void`.
  - En kontrollmatrise som mangler indeksen `i` gir feil 340, med `'i'` satt inn i teksten.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('set caption queues patch', () => { const q = fakeQueue(); const c = ctl('CommandButton', q); c.setMember('Caption', [], 'OK'); q.flush();
  expect(q.sent).toEqual([['f1', { t: 'patch', id: c1.id, props: { Caption: 'OK' } }]]); });
test('progress value out of range is 380', () => expect(() => pb.setMember('Value', [], 101)).toThrow(expect.objectContaining({ number: 380 })));
test('bool coercion', () => { chk.setMember('Enabled', [], 0); expect(chk.props.Enabled).toBe(false); });
test('read-only ListCount', () => expect(() => lst.setMember('ListCount', [], 3)).toThrow(expect.objectContaining({ number: 383 })));
test('additem/removeitem/listindex', () => { lst.callMethod('AddItem', ['a']); lst.callMethod('AddItem', ['b']); lst.setMember('ListIndex', [], 1);
  expect(lst.getMember('Text', [])).toBe('b'); lst.callMethod('RemoveItem', [0]); expect(lst.getMember('ListCount', [])).toBe(1); });
test('sorted additem', () => { /* Sorted=True, AddItem 'b','a' → List ['a','b'], NewIndex 0 */ });
test('control array missing index is 340', () => expect(() => arr.item(5)).toThrow(expect.objectContaining({ number: 340 })));
test('applyState does not echo', () => { txt.applyState({ Text: 'hei' }); q.flush(); expect(q.sent).toEqual([]); expect(txt.getMember('Text', [])).toBe('hei'); });
test('patches coalesce per control', () => { c.setMember('Caption', [], 'a'); c.setMember('Caption', [], 'b'); q.flush(); expect(q.sent.length).toBe(1); });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(run): control objects, protocol, patch queue`.

### Oppgave 2: Skjemavindu-renderer

**Filer:** Opprett `src/run/formWindow.ts`. Test: `tests/run/formWindow.test.ts`

**Grensesnitt:**
- Konsumerer: `renderFormSurface(form, 'run', …)` fra plan 02, og protokollen.
- Produserer: `mountFormWindow(root: HTMLElement, s: FormSnapshot, send: (m: FromWindow) => void): { receive(m: ToWindow): void; dispose(): void }`

- DOM-hendelser blir til `FromWindow`. `event` sendes bare for hendelser i `s.handled`. Endret tilstand sendes alltid, med `state` på `event`-meldingen eller som `state` når det ikke finnes handler.

| Kontroll | DOM | Melding |
|---|---|---|
| CommandButton | click | `Click` |
| Form med Default- eller Cancel-knapp | Enter / Escape | `Click` på knappen |
| TextBox | input | `Change` med `state.Text` |
| TextBox | keydown | `KeyDown` |
| TextBox | keydown | `KeyPress` (se under) |
| TextBox | keyup | `KeyUp` |
| CheckBox | click | Value byttes mellom 0 og 1, så `Click` med `state.Value` |
| OptionButton | click | `Value = True`, andre OptionButton i samme container får `False` (sendes som `state`), så `Click` |
| ListBox | valg | `state.ListIndex`, så `Click` |
| ListBox | dblclick | `DblClick` |
| ComboBox | valg | `ListIndex` og `Text`, så `Click` |
| ComboBox | skriving (Style 0/1) | `Change` |
| HScrollBar/VScrollBar | dra | `Scroll` mens du drar |
| HScrollBar/VScrollBar | ny verdi | `Change` med `state.Value` |
| Alle | mousedown/up/move | `MouseDown`/`MouseUp`/`MouseMove`. Button er 1 venstre, 2 høyre, 4 midten. Shift er 1 Shift, 2 Ctrl, 4 Alt. X/Y i twips |
| Alle | dblclick | `DblClick` |
| Alle | focus/blur | `GotFocus`/`LostFocus` |
| Label, Image, PictureBox, Frame, Form | click | `Click` |
| Form | lukkeknapp | `closeRequest` |
| Form | endret størrelse | `resized` |

  `KeyPress` sendes for tegn som kan skrives, Enter og Backspace, og bare når den har handler. Med `KeyPreview = True` går tastehendelser først til skjemaet.

- **KeyPress tur–retur:** når det finnes handler, blokkeres standardhandlingen (`preventDefault`) og hendelsen sendes med `requestId`. Svaret `keyResult` med `keyAscii ≠ 0` setter inn `String.fromCharCode(keyAscii)` ved markøren, og så sendes `Change`.
- `blocked: true` legger et gjennomsiktig lag over skjemaet som stopper all input.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('button click sends Click', () => { click(btn); expect(sent).toContainEqual({ t: 'event', id: btnId, event: 'Click', args: [] }); });
test('no handler → no event, but state', () => { /* handled uten Text1 → skriv i Text1 → { t: 'state', id, props: { Text: 'a' } } */ });
test('checkbox toggles and reports state', () => { click(chk); expect(sent.at(-1)).toMatchObject({ event: 'Click', state: { Value: 1 } }); });
test('option buttons exclusive per container', () => { /* to i Frame1, én på skjemaet; klikk på første i Frame1 → andre i Frame1 False, den på skjemaet urørt */ });
test('keypress roundtrip cancel', () => { type(txt, 'x'); const req = sent.at(-1); win.receive({ t: 'keyResult', requestId: req.requestId, keyAscii: 0 }); expect(txtEl.value).toBe(''); });
test('keypress roundtrip uppercase', () => { /* svar keyAscii 88 → verdi 'X' + Change sendt */ });
test('enter clicks default button', () => { /* Command1.Default=True; Enter i Text1 → Click på Command1 */ });
test('mouse coords in twips', () => { /* mousedown ved (10,20) px i kontrollen → args [1, 0, 150, 300] */ });
test('patch updates DOM', () => { win.receive({ t: 'patch', id: lblId, props: { Caption: 'Hei' } }); expect(lblEl.textContent).toBe('Hei'); });
test('blocked overlay swallows clicks', () => { win.receive({ t: 'blocked', blocked: true }); click(btn); expect(sent).toEqual([]); });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(run): form window renderer and DOM event mapping`.

### Oppgave 3: InlineFormHost og RunSession

**Filer:** Opprett `src/run/inlineFormHost.ts`, `src/run/session.ts`, `src/run/objects/formInstance.ts`, `src/run/objects/appObjects.ts`, og testprosjektene `tests/run/e2e/hello.vbb`, `calc.vbb` (kontrollmatrise) og `progress.vbb` (løkke med DoEvents). Test: `tests/run/session.test.ts`

**Grensesnitt:**
- Konsumerer:
  - Fra plan 01: `Program`, `Host` og `VBRef`.
  - Fra denne planen: oppgave 1 og 2.
  - Fra plan 02: `messageBox98` og `inputBox98` (brukes inline).
- Produserer:

```ts
export class InlineFormHost implements FormHost { constructor(container: HTMLElement) }   // hvert skjema som et absolutt posisjonert div-«vindu»
export interface SessionCallbacks {
  debugPrint(text: string, newline: boolean): void;
  onBreak(info: BreakInfo): Promise<'continue' | 'end'>;   // IDE: gul linje og venting. App: aldri kalt
  onEnded(): void;
  readFile(path: string): Promise<Uint8Array>;            // LoadPicture
  appPath: string;
}
export class RunSession implements Host {
  constructor(project: Project, formHost: FormHost, cb: SessionCallbacks, mode: 'ide' | 'app');
  start(): Promise<void>;           // laster og viser oppstartsskjemaet
  end(): void;                      // som End-knappen
  pause(): void;                    // Ctrl+Break
  immediate(text: string): Promise<string>;
  readonly program: Program;
  readonly state: 'running' | 'break' | 'ended';
}
export class FormInstance implements VBObject { /* Show [modal], Hide, Load/Unload via callMethod, Caption…, ScaleWidth/Height, kontroller som medlemmer */ }
```

- Regler:
  - `resolveName(modul, navn)`:
    - I en skjemamodul løses `Me` og kontrollnavnene i det skjemaet først.
    - Ellers løses skjemanavn (standardinstansen, som lastes automatisk ved første medlemstilgang), `App` (`Title`, `Path`, `EXEName`, `PrevInstance` = False) og `Screen` (`Width`, `Height` i twips, og `MousePointer` som ignoreres).
  - Hendelsesnavn: `<Kontrollnavn>_<Hendelse>`, eller `Form_<Hendelse>` for skjemaet.
    - For kontrollmatriser sendes `Index` først som `VBRef`.
    - ByRef-argumenter (KeyAscii, Cancel) leses tilbake etter handleren.
    - **Er navnet endret siden koden ble skrevet, finnes ingen prosedyre, og ingenting kjøres** (Review Focus 3).
  - `handled` i snapshot regnes ut med `program.hasProcedure`.
  - `Show vbModal` venter til skjemaet skjules eller lastes ut, og blokkerer de andre skjemaene mens det står åpent.
  - Timer: én `setInterval` per aktiv Timer med `Interval > 0`. Hendelser som kommer mens forrige Timer-hendelse fortsatt kjører, droppes.
  - `Program` lages av alle skjemaer (`kind: 'form'`, kilde = `form.code`) og moduler, med `appTitle: project.title || project.name`.
  - `doEvents()`: `queue.flush()`, så venter den på `setTimeout(0)`.
  - `msgBox` og `inputBox`: `flush` først, så `formHost`. Standardtittel er `project.title || project.name`.
  - `loadPicture(path)`:
    - En relativ sti løses fra `appPath`.
    - Resultatet er en `PictureObject` med data-URL. Å sette `Picture` til den gir en patch med URL-en.
    - `LoadPicture("")` gir et tomt bilde.
    - En fil som ikke finnes gir feil 53 `File not found`.

- [ ] **Steg 1: Skriv de feilende testene.** Alle bruker jsdom og `InlineFormHost`.

```ts
test('hello: click sets label', async () => { const s = await startProject('hello.vbb'); click('Command1'); await settle(s); expect(text('Label1')).toBe('Hei, verden!'); });
test('load order', async () => { /* Form_Initialize/Load/Resize/Activate logger via Debug.Print */ expect(out).toEqual(['Initialize', 'Load', 'Resize', 'Activate']); });
test('control array index', async () => { /* calc.vbb: Command1(7) klikk → Text1 = "7" */ });
test('renamed control: old handler not run', async () => { /* kontroll heter cmdOK, kode har Command1_Click som setter Label1 → Label1 uendret */ });
test('query unload cancel keeps form', async () => { /* Form_QueryUnload setter Cancel = 1 → closeRequest → skjema fortsatt åpent */ });
test('unload last form ends session', async () => { /* Unload Me → onEnded kalt */ });
test('form2 auto-loads on member access and modal show waits', async () => { /* Form2.Show vbModal; Debug.Print "etter" skrives først når Form2 lukkes */ });
test('progress loop with DoEvents updates DOM before finishing', async () => { /* progress.vbb: For i = 1 To 100: ProgressBar1.Value = i: DoEvents: Next → under kjøring sees en mellomverdi */ });
test('timer fires', async () => { /* Interval 50, teller i Timer1_Timer; vent 200 ms → minst 2 */ });
test('keypress uppercase via handler', async () => { /* Text1_KeyPress: KeyAscii = Asc(UCase(Chr(KeyAscii))) → skriv 'a' → 'A' */ });
test('loadpicture missing file is 53', async () => { /* … */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(run): run session, form lifecycle, inline host`.

### Oppgave 4: Dialoger i kjøring

**Filer:** Endre `src/run/inlineFormHost.ts`. Opprett `src/run/errorDialog.ts`. Test: `tests/run/dialogs.test.ts`

**Grensesnitt:**
- Produserer `runtimeErrorContent(o): { title: string; text: string; buttons: { label: string; value: 'end' | 'debug'; disabled?: boolean }[] }`. Den er ren, og begge vertene bruker den.

| Situasjon | Tittel | Tekst | Knapper |
|---|---|---|---|
| IDE, kjøretidsfeil | `VibeBasic` | `Run-time error '13':` + blank linje + `Type mismatch` | `Continue` (deaktivert), `End`, `Debug` (standard), `Help` (deaktivert) |
| IDE, kompileringsfeil | `VibeBasic` | `Compile error:` + blank linje + melding | `OK` gir `debug`: break på linjen, som VB6 |
| App, kjøretidsfeil | `project.title` | `Run-time error '13':` + blank linje + `Type mismatch` | `OK` gir `end` |

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('ide runtime error content', () => expect(runtimeErrorContent({ number: 13, description: 'Type mismatch', compile: false, mode: 'ide', title: 'P' }))
  .toEqual({ title: 'VibeBasic', text: "Run-time error '13':\n\nType mismatch", buttons: [
    { label: 'Continue', value: 'end', disabled: true }, { label: 'End', value: 'end' }, { label: 'Debug', value: 'debug' }, { label: 'Help', value: 'end', disabled: true }] }));
test('app runtime error ends', () => expect(runtimeErrorContent({ number: 11, description: 'Division by zero', compile: false, mode: 'app', title: 'Kalk' }).buttons).toEqual([{ label: 'OK', value: 'end' }]));
test('msgbox blocks forms while open', async () => { /* mens MsgBox er åpen, ignoreres klikk på Command1 */ });
test('inputbox returns typed text', async () => { /* … */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(run): runtime dialogs`.

### Oppgave 5: TauriFormHost (ekte vinduer)

**Filer:** Opprett `src/run/tauriFormHost.ts`, `src/run/formWindowMain.ts`, `src/run/windowOptions.ts`. Endre `form.html` og `src-tauri/capabilities/default.json`. Test: `tests/run/windowOptions.test.ts`

**Grensesnitt:**
- Produserer:
  - `windowOptionsFor(form: FormDef, cascadeIndex: number): { width: number; height: number; resizable: boolean; center: boolean; x?: number; y?: number; minimizable: boolean; maximizable: boolean }` (px)
  - `class TauriFormHost implements FormHost`

- Regler:
  - **Vinduet:** hvert skjema blir en `WebviewWindow` med label `vbform-<key>`, URL `form.html#<key>`, `decorations: false`, `visible: false`, og `alwaysOnTop: true` når det er modalt.
  - **Meldinger:**
    - Vinduet sender `ready`, og hovedvinduet svarer med snapshotet. Vinduet ber om det med `emit('vb:hello', key)`, og hovedvinduet svarer med `emitTo(label, 'vb:snapshot', s)`.
    - Deretter går meldingene som `emitTo(label, 'vb:to', m)` og `emit('vb:from', { key, m })`.
    - Vinduet vises først etter at første patch er tegnet.
  - **Tittellinjen** har `data-tauri-drag-region`. Knappene for minimer og maksimer bruker `getCurrentWindow().minimize()` / `toggleMaximize()`. Lukk sender `closeRequest`.
  - **Plassering etter `StartUpPosition`:**
    - 0 Manual: `Left`/`Top` fra skjemaet.
    - 1 og 2: midtstilt.
    - 3 Windows Default: x = y = 60 + 30·`cascadeIndex`.
  - **`BorderStyle`:**
    - 2 og 5: kan endre størrelse.
    - 0: ingen tittellinje.
    - 3 og 4: ingen minimer- eller maksimerknapp.
  - **MsgBox, InputBox og feildialog** åpnes i et eget vindu `form.html#dialog-<n>`, som rendrer `showDialog98`. Vinduet måler innholdet, endrer størrelse, midtstilles, er `alwaysOnTop` og sender resultatet tilbake.
  - **Rettigheter** i `capabilities/default.json`:
    - `core:window:allow-create`, `core:webview:allow-create-webview-window`
    - `core:window:allow-start-dragging`, `core:window:allow-close`, `core:window:allow-minimize`, `core:window:allow-toggle-maximize`
    - `core:window:allow-set-size`, `core:window:allow-center`, `core:window:allow-show`, `core:window:allow-hide`
    - `core:event:default`
    - Vinduer som matcher `vbform-*` og `vbdialog-*`.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('size from twips', () => expect(windowOptionsFor(form({ Width: 4800, Height: 3600 }), 0)).toMatchObject({ width: 320, height: 240 }));
test('fixed dialog', () => expect(windowOptionsFor(form({ BorderStyle: 3 }), 0)).toMatchObject({ resizable: false, minimizable: false, maximizable: false }));
test('windows default cascades', () => expect(windowOptionsFor(form({ StartUpPosition: 3 }), 2)).toMatchObject({ center: false, x: 120, y: 120 }));
test('center screen', () => expect(windowOptionsFor(form({ StartUpPosition: 2 }), 0).center).toBe(true));
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør tester.** Forventet: PASS.
- [ ] **Steg 5: Sjekk manuelt** i `npm run tauri dev` (IDE-koblingen kommer i oppgave 6, så bruk en midlertidig utviklerknapp eller test etter oppgave 6). Sjekk at:
  - `hello.vbb` åpner et eget Win98-vindu som kan dras
  - klikk på knappen oppdaterer etiketten
  - MsgBox kommer i et eget vindu midt på skjermen
- [ ] **Steg 6: Commit** med meldingen `feat(run): real form windows via Tauri`.

### Oppgave 6: IDE-integrasjon: Run-menyen, break-modus og Immediate-vinduet

**Filer:** Opprett `src/ide/runController.ts`, `src/ide/immediate.ts`. Endre `src/ide/menus.ts`, `codeWindow.ts`, `designer.ts`, `properties.ts` og `toolbox.ts`. Test: `tests/ide/runController.test.ts`, `tests/ide/immediate.test.ts`

**Grensesnitt:**
- Konsumerer: `RunSession`, `IdeState.mode`, `CodeWindow.setBreakLine` og `markErrorLines`, `findSyntaxErrors`, `compileErrorBox`.
- Produserer:

```ts
export class RunController {
  constructor(ide: IdeState, hostFactory: () => FormHost, openCode: (itemId: string) => CodeWindow);
  start(fullCompile: boolean): Promise<void>;   // F5 / Ctrl+F5. I break-modus fortsetter F5 i stedet
  breakNow(): void;                             // Ctrl+Break, Cmd+., Ctrl+Pause
  end(): void;
  restart(): Promise<void>;                     // Shift+F5
}
export function createImmediateWindow(host: HTMLElement, run: () => RunSession | null, project: () => Project): { print(text: string, newline: boolean): void; show(): void; focus(): void };
```

- Regler:
  - **Tilstander:** `design → run` (start), `run → break` (feil med Debug, kompileringsfeil eller Ctrl+Break), `break → run` (F5) og `run/break → design` (End eller at programmet slutter).
  - **Tittel:** `[design]`, `[run]` eller `[break]`.
  - **Verktøylinjen:** Start, Break og End er aktive etter tilstanden.
  - **Ctrl+F5:** kjører `findSyntaxErrors` på alle moduler før start. Ved den første feilen vises `compileErrorBox`, kodevinduet åpnes på linjen, linjen markeres rød, og programmet starter ikke.
  - **Break:**
    - Kodevinduet for modulen åpnes, linjen markeres gul med en pil i margen, og Immediate-vinduet vises.
    - Skjemavinduene får `blocked: true`.
    - F5 gir `'continue'`, og End gir `'end'`.
  - **Immediate-vinduet:**
    - Enter på en linje kjører `session.immediate(linje)`, eller en midlertidig `Program` av prosjektets moduler i design-modus.
    - Resultatet settes inn på linjen under, som i VB6.
    - `Debug.Print` skrives hit.
    - Ctrl+G åpner vinduet.
  - **Skrivebeskyttelse:** designer, Properties, Toolbox og kodevinduer er skrivebeskyttet i `run` og `break`.
  - **Feil i oppstart:** kaster `start` før første skjema vises (for eksempel en feil i Form_Load), går IDE-en til break som vanlig.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('state machine', async () => { /* start → 'run'; breakNow → 'break'; start → 'run'; end → 'design' */ });
test('runtime error debug opens code at line in yellow', async () => { /* Command1_Click: x = 1 / 0 → Debug → setBreakLine(2) på Form1-koden */ });
test('continue after fixing via immediate', async () => { /* Dim d: Debug.Print 10 / d → break; immediate 'd = 2'; F5 → Immediate viser ' 5 ' */ });
test('ctrl+f5 stops on syntax error', async () => { /* Module1 har 'x = ' → compileErrorBox + markErrorLines([n]) + mode 'design' */ });
test('immediate in design mode evaluates', async () => expect(await immediateEval('? 1 + 2')).toBe(' 3 '));
test('read-only during run', async () => { /* properties-input disabled og codeWindow readOnly i 'run' */ });
test('title follows mode', async () => { /* 'Project1 - VibeBasic [run]' */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
  - `hostFactory` gir `TauriFormHost` når `backend.kind === 'tauri'`.
  - Ellers gir den `InlineFormHost` i et flytende lag over MDI-området.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ide): run/break/end, break highlighting, immediate window`.

### Oppgave 7: Ende-til-ende og Review Focus 1

**Filer:** Test: `tests/run/e2e.test.ts`

- [ ] **Steg 1: Skriv testene.**

```ts
test('infinite loop can be stopped quickly and IDE stays responsive', async () => {   // Review Focus 1
  /* Command1_Click: Do: Loop. Klikk, vent 100 ms, sjekk at en setTimeout(0)-callback i testen fortsatt kjører (UI svarer),
     run.end(); forventer mode 'design' innen 500 ms og at skjemavinduet er lukket */
}, 2000);
test('break during infinite loop shows loop line', async () => { /* breakNow → setBreakLine på 'Loop'- eller 'Do'-linjen */ });
test('calc.vbb full scenario', async () => { /* klikk 1, +, 2, = → Text1 = "3" */ });
```

- [ ] **Steg 2: Kjør.** Forventet: PASS hvis oppgave 1–6 er riktige. Hvis ikke: rett feilen i oppgaven som eier koden.
- [ ] **Steg 3: Sjekk manuelt** i `npm run tauri dev`:
  1. Lag et nytt prosjekt med Command1, Label1 og ProgressBar1.
  2. Skriv en løkke med `DoEvents`, og trykk F5. ProgressBar skal fylles gradvis.
  3. Skriv `x = 1 / 0` og velg Debug. Du skal få gul linje, og `? x` i Immediate-vinduet skal virke.
  4. Trykk End. Alle skjemavinduer skal lukkes.
- [ ] **Steg 4: Commit** med meldingen `test(run): end-to-end scenarios`.

---

## Arvet fra plan 01 (gjennomgang, 2026-10-22)

Kontrakten for `Host` og `VBObject` er dokumentert i `src/lang/host.ts`. Det viktigste:

- **Krav til `getMember`, `hasMember` og `resolveName`:** de må være billige og uten bivirkninger, fordi en Let til `obj.navn` leser `getMember` først. `setMember` kalles bare når `hasMember` er sann. `callMethod` kaster 438 for ukjente metoder.
- **Navneoppslag i skjemakode:** navn som `resolveName` returnerer, kommer før globale Public-variabler, og egenskaper på `Me` kan brukes uten `Me.`. Det gjelder også vertsglobaler som App og Screen. Vurder å la `resolveName` bare gi skjemalokale navn der.
- **Standardmedlemmer:**
  - Objektargumenter til `callMethod` løses til standardmedlemmet når objektet har et. `List1.AddItem Text1` legger altså til teksten. Metoder som trenger selve objektet, for eksempel PaintPicture, trenger et unntak.
  - `Form1.Text1 = Text2` gir `setMember(navn, args, objekt)`. Kontrollobjektet må selv løse dette til standardmedlemmet.
- **Feilobjekter:** verten må kaste en ny `VBRuntimeError` hver gang, fordi forplantningsmerket hører til hver forekomst. Vanlige JS-feil blir feil 51 «Internal error».
- **Kontrollmatriser:** `items?()` på `VBObject` brukes av `For Each`. `ControlArrayObject` må implementere den.
- **Break mens verten venter:** `requestPause` kan ikke avbryte en handler som venter på verten, for eksempel `Form2.Show vbModal`. Break-knappen virker først når det modale skjemaet lukkes. Dokumenter dette i runController, eller løs det der.
- **Mål ytelsen i oppgave 7:** `setTimeout(0)` i driveren og i `doEvents` kan bli strupet til 4 ms i WKWebView. Mål `For i = 1 To 100000 … DoEvents` i ekte Tauri. Er det tregt, bytt til `MessageChannel` og tidsbasert slicing.
- **Avvik å nevne i brukerdokumentasjon:** `Resume Next` etter en feil i hodet på en For-, Select- eller With-setning hopper over hele setningen.
