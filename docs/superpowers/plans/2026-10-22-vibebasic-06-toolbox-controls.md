# VibeBasic plan 06: utvidet verktøykasse

> **For agentiske arbeidere:** PÅKREVD UNDER-FERDIGHET: superpowers:subagent-driven-development. LEAN MODE: planens tester pluss det helt nødvendige.

**Mål:** Verktøykassen skal kunne flyttes og justeres, og det skal komme 14 nye VB6-kontroller.

**Arkitektur:** Hver kontroll følger samme vei som de eksisterende:
1. Registeret i `src/model/controls.ts`, med egenskaper, hendelser, metoder, standardhendelse og standardmedlem.
2. Tegning i `src/controls/render.ts`, både i design og i kjøring.
3. DOM-hendelser blir til VB-hendelser i `src/run/formWindow.ts`.
4. Kjøreobjektet i `src/run/objects/controlObject.ts`.
5. Ikon i verktøykassen.

Samlinger får én felles `CollectionObject`. Filtilgang går via nye Rust-kommandoer. AI-beskrivelsen og IntelliSense leser registeret, så de følger med av seg selv.

**Spec:** [docs/superpowers/specs/2026-10-22-vibebasic-toolbox-controls-design.md](../specs/2026-10-22-vibebasic-toolbox-controls-design.md). Tabellen der gir egenskaper, hendelser og verdier for hver kontroll.

## Felles regler

- Navn og tall er eksakt som i VB6: egenskaper, hendelser, enum-verdier og konstanter.
- Gamle prosjekter og alle eksisterende tester skal fortsette å virke.
- Nye `ControlType`-verdier: `Shape`, `Line`, `DriveListBox`, `DirListBox`, `FileListBox`, `Slider`, `UpDown`, `StatusBar`, `TabStrip`, `TreeView`, `ListView`, `MSFlexGrid`, `CommonDialog`, `RichTextBox`.
- Standard navneprefiks som i VB6: Shape, Line, Drive, Dir, File, Slider, UpDown, StatusBar, TabStrip, TreeView, ListView, MSFlexGrid, CommonDialog, RichTextBox.
- `TOOLBOX_ORDER` følger VB6-rekkefølgen for standardkontrollene og legger deretter Common Controls til slutt.
- Kontroller uten Left, Top, Width og Height (Line), og usynlige kontroller (CommonDialog og Timer), må håndteres i designeren og i AI-ens skjemaoperasjoner.
- Samlinger begynner på indeks 1. En ukjent nøkkel eller indeks gir feil 35600 «Index out of bounds». En nøkkel som finnes fra før gir 35602 «Key is not unique in collection».
- Avbryt i CommonDialog med `CancelError = True` gir feil 32755 «Cancel was selected».
- Hver oppgave avsluttes med `npm test`, `npx tsc --noEmit` og en commit som ender med en tom linje og `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Oppgave 6 kjører i tillegg `npm run test:rust` og `cargo check`.

---

### Oppgave 1: Verktøykassen kan flyttes og justeres

**Filer:** `src/ide/toolbox.ts`, `src/ide/layout.ts`, `src/ide/ide.css`, `src/ide/main.ts`. Test: `tests/ide/toolbox.test.ts`

**Grensesnitt:** `ToolboxLayout { docked: boolean; x: number; y: number; width: number }`, lagret med `backend.saveSettings('toolbox', …)` og lest ved oppstart.

- Dra i tittellinjen: verktøykassen løsner og blir et flytende Win98-vindu, avgrenset til IDE-området.
- Dobbeltklikk på tittellinjen: den dokkes til venstre igjen.
- Dra i høyre kant: bredden endres (minst 2 kolonner, maks 6). Ikonene fyller så mange kolonner som får plass.
- Hvis det ikke er plass i høyden, kan listen scrolles.
- Tester:
  - Bredden gir riktig antall kolonner (`columnsFor(width)`).
  - Dobbeltklikk dokker.
  - Oppsettet lagres og leses inn igjen.
  - Den flytende posisjonen holder seg innenfor IDE-området.

### Oppgave 2: Shape, Line, Slider og UpDown

**Filer:** registeret, render, formWindow, controlObject, ikoner og designer/designerLogic (Line). Tester per kontroll i de eksisterende testfilene.

- **Shape:** alle 6 formene og FillStyle, ved hjelp av CSS eller SVG.
- **Line:** tegnes som SVG.
  - I designeren dras den i to endepunkt-håndtak, og flyttes med drag, som setter X1, Y1, X2 og Y2.
  - Properties viser X1, Y1, X2 og Y2.
- **Slider:** Value forblir mellom Min og Max, og Change og Scroll sendes.
- **UpDown:** Increment og Wrap virker, og UpClick, DownClick og Change sendes.
- Tester:
  - Hver ny type har standardhendelsen sin.
  - Line flyttes og endrer størrelse via endepunktene.
  - Slider `Value = 200` når Max er 100 gir feil 380.
  - UpDown med Wrap går rundt.

### Oppgave 3: Samlinger, StatusBar og TabStrip

**Filer:** `src/run/objects/collectionObject.ts` (ny), registeret, render, formWindow, controlObject og konstanter i `src/lang/builtins/constants.ts` (sbr*). Test: `tests/run/collection.test.ts` og kontrolltester.

**Grensesnitt:** `class CollectionObject<T extends VBObject> implements VBObject`, med `Add(...)` (signatur per samling), `Remove(indexOrKey)`, `Clear`, `Count`, `Item(indexOrKey)` (standardmedlem) og `items()` for For Each. Endringer varsler eieren, som sender en patch.

- **StatusBar:**
  - Panels (Text, Width, Alignment, Key) og Style med SimpleText.
  - Den legger seg nederst i skjemaet. Det betyr i praksis Align = bottom: full bredde, og Top settes ut fra skjemaets høyde.
  - PanelClick(Panel) sendes.
  - Panels kan settes opp i design-tid via Properties, for eksempel som en tekstliste med én linje per panel. Det er Claudes valg.
- **TabStrip:**
  - Tabs-samlingen og `SelectedItem`.
  - Klikk på en fane gir Click.
  - Faner kan settes opp i design-tid som en tekstliste i Properties.
- Tester:
  - Add, Item etter indeks og nøkkel, nøkkel som finnes fra før gir 35602, Remove, og For Each.
  - `StatusBar1.Panels(1).Text = "x"` gir en patch.
  - Å klikke den andre fanen setter `SelectedItem.Index` til 2 og gir Click.

### Oppgave 4: TreeView, ListView og MSFlexGrid

**Filer:** registeret, render, formWindow, controlObject med `CollectionObject`, og konstanter (tvw*, lvw*, flex*). Tester per kontroll.

- **TreeView:**
  - `Nodes.Add(Relative, Relationship, Key, Text)` med tvwChild og de andre relasjonene.
  - Node-objekter med navigasjon (Parent, Child, Next og Children).
  - Expand og Collapse ved klikk på +/-.
  - NodeClick(Node) sender et Node-objekt som argument.
- **ListView:**
  - De fire visningene. Report har kolonneoverskrifter.
  - `ListItems.Add(, Key, Text)` og `SubItems(i)`.
  - ItemClick(Item) og ColumnClick(ColumnHeader).
  - Sortering med Sorted, SortKey og SortOrder.
- **MSFlexGrid:**
  - Rutenett der de faste radene og kolonnene er grå.
  - `TextMatrix(r, c)` leser og skriver.
  - Row og Col følger klikk, og RowColChange sendes.
  - ColWidth.
- Tester:
  - Treet bygges med tvwChild og Expand.
  - NodeClick gir riktig Node.Key.
  - ListView Report med SubItems, og ColumnClick.
  - TextMatrix leser og skriver tilbake.
  - Klikk i en celle setter Row og Col og gir RowColChange.

### Oppgave 5: RichTextBox og CommonDialog

**Filer:** registeret, render, formWindow, controlObject og konstanter (cdl*). Backend: `showOpenDialog` og `showSaveDialog` med filter, tittel og startmappe (Tauri-dialogplugin). Gjenbruk farge- og fontdialogene fra Properties (`src/ide/propertyEditors.ts`).

- **RichTextBox:**
  - Bygget på et redigerbart felt.
  - SelBold, SelItalic, SelUnderline, SelColor, SelFontName og SelFontSize leser og skriver formateringen av markeringen.
  - Text er ren tekst.
  - Change og SelChange sendes.
- **CommonDialog:**
  - Usynlig i kjøring, og vises som et ikon i designeren.
  - `ShowOpen` og `ShowSave` gjør VB-filteret («Tekst (*.txt)|*.txt|Alle (*.*)|*.*») om til dialogfiltre og fyller FileName og FileTitle.
  - `ShowColor` og `ShowFont` fyller Color og Font*.
  - Avbryt med CancelError gir 32755.
  - ShowPrinter og ShowHelp gir 438.
  - I kjøremodus går dialogene via FormHost/RunSession, så de virker både i IDE-en og i ferdige apper. Tauri-dialogen åpnes fra hovedvinduet.
- Tester:
  - Filteret oversettes riktig.
  - CancelError gir 32755 med en falsk backend.
  - SelBold endrer markeringen.

### Oppgave 6: DriveListBox, DirListBox og FileListBox (Rust)

**Filer:** `src-tauri/src/files.rs` med `list_volumes() -> Vec<{name, path}>` og `list_dir(path) -> {dirs: Vec<String>, files: Vec<{name, hidden}>}` (sortert, uten symlink-løkker). Backend-metoder, register, render, formWindow og controlObject. Rettigheter: kommandoene er egne app-kommandoer, så de virker i form- og runtime-vinduene via hovedvinduets sesjon. Test: Rust-tester med tempdir, og TS-tester med falsk backend.

- **Drive:**
  - Viser volumene, med «/» som oppstartsdisken.
  - `Drive1.Drive` gir stien.
  - Change sendes.
- **Dir:**
  - `Path` viser stien med de åpnede mappene over, og undermappene under.
  - Dobbeltklikk åpner en mappe.
  - Change sendes.
- **File:**
  - Pattern med flere mønstre adskilt av «;».
  - Hidden, Normal og Archive (Archive er det samme som vanlige filer).
  - FileName og List(i).
  - PathChange og PatternChange sendes.
- Tester:
  - `list_dir` med tempdir finner mapper, filer og skjulte filer.
  - Pattern «*.txt;*.bas» filtrerer riktig.
  - Typisk VB6-kobling: `Drive1_Change → Dir1.Path = Drive1.Drive` og `Dir1_Change → File1.Path = Dir1.Path` virker i en kjøretest.
