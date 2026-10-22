# VibeBasic plan 04: Make app

> **For agentiske arbeidere:** PÅKREVD UNDER-FERDIGHET: Bruk superpowers:subagent-driven-development (anbefalt) eller superpowers:executing-plans. Stegene bruker avkrysningsbokser (`- [ ]`).

**Mål:** File → Make \<navn\>.app… lager en selvstendig Mac-app av prosjektet. Appen kan gis til andre, har eget navn og ikon, og ser ut som skjemaene i designeren.

**Arkitektur:**
- Make kopierer **VibeBasic.app selv** til målet med `ditto`. Prosjektet legges inn som `Contents/Resources/vibebasic-project.vbb`.
- Info.plist skrives om: navn, bundle-id, ikon og navnet på den kjørbare filen. Ikonet lages med `sips` og `iconutil`, som følger med macOS.
- Til slutt signeres appen ad-hoc med `codesign --force --deep --sign -`.
- Ved oppstart ser appen etter den innebygde filen. Finnes den, starter appen i runtime-modus: hovedvinduet forblir skjult, `RunSession` kjører med `TauriFormHost` og modus `'app'`, og appen avslutter når programmet slutter.

**Avvik fra spec kap. 5:** spec-en beskriver en egen ferdigbygd runtime-app inni VibeBasic. Planen bruker i stedet VibeBasic.app selv som runtime. Målet i spec-en er det samme: det trengs ingen utviklerverktøy hos brukeren, og appene blir små, omtrent like store som VibeBasic. Det slipper oss å bygge og vedlikeholde to apper. Claudes valg.

**Teknologi:** Rust (`plist`, `tempfile` som dev-avhengighet), macOS-verktøyene `ditto`, `sips`, `iconutil` og `codesign`, og TypeScript.

**Spec:** [spec](../specs/2026-10-22-vibebasic-design.md), kap. 2.7 og 5. Felles regler: se [oversikten](2026-10-22-vibebasic-00-oversikt.md).

## Filer

```
src-tauri/src/make_app.rs     navn og bundle-id, build_app_from, make_app-kommando, Signer, IconConverter
src-tauri/src/embedded.rs     get_embedded_project, quit_app, runtime-meny
src/backend/*                 makeApp, saveAppDialog, getEmbeddedProject, quitApp
src/runtime/runtimeMain.ts    startRuntime(project)
src/main.ts                   velger modus
src/build/makeApp.ts          Make-flyten i IDE-en
src/ide/projectDialogs.ts     ny fane Make (ikon)
tests/build/*.test.ts, tests/runtime/*.test.ts
```

---

### Oppgave 1: Appnavn og bundle-id

**Filer:** Opprett `src-tauri/src/make_app.rs` med navnedelen og tester.

**Grensesnitt:**
- Produserer:
  - `pub fn sanitize_app_file_name(name: &str) -> String` fjerner `/` og `:` og mellomrom i ytterkantene. Tomt navn blir `Project1`.
  - `pub fn ascii_slug(name: &str) -> String` translittererer æ→ae, ø→o, å→a, Æ→Ae, Ø→O, Å→A og fjerner aksenter. Den beholder bare `[A-Za-z0-9]` og gir minst `App`.
  - `pub fn bundle_id_for(name: &str) -> String` gir `no.vibebasic.app.` pluss slug med små bokstaver.

- [ ] **Steg 1: Skriv de feilende testene.** (Review Focus 5)

```rust
#[test] fn file_name_keeps_spaces_and_norwegian() { assert_eq!(sanitize_app_file_name(" Mitt Program/æøå: "), "Mitt Programæøå"); }
#[test] fn empty_name() { assert_eq!(sanitize_app_file_name("  "), "Project1"); }
#[test] fn slug() { assert_eq!(ascii_slug("Kalkulator på Øya!"), "KalkulatorpaOya"); assert_eq!(ascii_slug("!!!"), "App"); }
#[test] fn bundle_id() { assert_eq!(bundle_id_for("Mitt Program"), "no.vibebasic.app.mittprogram"); }
```

- [ ] **Steg 2: Kjør** `npm run test:rust`. Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(make): app names and bundle ids`.

### Oppgave 2: Bygg appen

**Filer:** Endre `src-tauri/src/make_app.rs` og `src-tauri/src/lib.rs`. Endre `src-tauri/Cargo.toml` (`plist`, dev: `tempfile`).

**Grensesnitt:**
- Produserer:

```rust
pub trait Signer { fn sign(&self, bundle: &Path) -> Result<(), String>; }            // CodesignSigner: codesign --force --deep --sign - <bundle>
pub trait IconConverter { fn png_to_icns(&self, png: &[u8], out: &Path) -> Result<(), String>; } // SipsIconConverter: .iconset med 16…1024 (inkl. @2x) via sips, så iconutil -c icns
pub struct BuildSpec { pub app_name: String, pub project_json: String, pub icon_png: Option<Vec<u8>> }
#[derive(Debug, PartialEq)] pub enum MakeError { NotBundled, Exists, Io(String), Tool(String) }
pub fn build_app_from(source_bundle: &Path, target: &Path, spec: &BuildSpec, overwrite: bool, signer: &dyn Signer, icons: &dyn IconConverter) -> Result<(), MakeError>;
pub fn current_bundle() -> Result<PathBuf, MakeError>;   // current_exe()/../.. må slutte på ".app", ellers NotBundled
#[tauri::command] pub fn make_app(target_path: String, app_name: String, project_json: String, icon_png_base64: Option<String>, overwrite: bool) -> Result<(), String>;
```

- Feiltekster til frontend:

| Feil | Tekst |
|---|---|
| `NotBundled` | `Make only works when VibeBasic runs as a built app. Build it with: npm run tauri build` |
| `Exists` | `exists` (frontend tolker koden) |
| Andre | `Could not make the app: <detalj>` |

- `build_app_from` gjør dette i rekkefølge:
  1. Er målet der og `overwrite` er false, gis `Exists`. Med `overwrite` slettes målmappen helt.
  2. `ditto <kilde> <mål>`.
  3. Prosjektet skrives til `Contents/Resources/vibebasic-project.vbb`.
  4. `Contents/MacOS/<gammel kjørbar fil>` får navnet `ascii_slug(app_name)`.
  5. Info.plist får `CFBundleExecutable` = slug, `CFBundleName` og `CFBundleDisplayName` = `app_name`, og `CFBundleIdentifier` = `bundle_id_for(app_name)`.
  6. Med ikon skrives `Contents/Resources/icon.icns` og `CFBundleIconFile` = `icon.icns`.
  7. `signer.sign(mål)`.

- [ ] **Steg 1: Skriv de feilende testene** med en falsk kildebundle i `tempfile::tempdir()` (`Contents/MacOS/VibeBasic`, `Contents/Info.plist` og `Contents/Resources/x`) og falske Signer og IconConverter som logger.

```rust
#[test] fn builds_bundle() { /* sjekk at vibebasic-project.vbb finnes, at MacOS/MittProgram finnes og MacOS/VibeBasic ikke,
   plist-nøkler som over, og at signer ble kalt én gang med mål-stien */ }
#[test] fn refuses_existing_without_overwrite() { /* mål finnes → Err(MakeError::Exists), innhold urørt */ }
#[test] fn overwrite_replaces_completely() { /* gammel ekstra fil i mål forsvinner */ }   // Review Focus 5
#[test] fn icon_sets_plist() { /* icon_png Some → CFBundleIconFile = "icon.icns" og converter kalt */ }
#[test] fn not_bundled_when_exe_not_in_app() { /* current_bundle med en sti uten .app → NotBundled (test via en hjelpefunksjon bundle_from_exe(path)) */ }
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer og registrer `make_app` i `lib.rs`.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(make): build app bundle from self`.

### Oppgave 3: Runtime-modus

**Filer:** Opprett `src-tauri/src/embedded.rs` og `src/runtime/runtimeMain.ts`. Endre `src/main.ts` og `src/backend/*`. Test: `tests/runtime/boot.test.ts`

**Grensesnitt:**
- Konsumerer: `RunSession` og `TauriFormHost` (plan 03), og `parseProject` (plan 02).
- Produserer:
  - Rust-kommandoen `get_embedded_project() -> Option<String>`, som leser `resource_dir()/vibebasic-project.vbb`.
  - Rust-kommandoen `quit_app()`.
  - Rust-funksjonen `fn runtime_menu(app_name)`: én appmeny med `About <navn>` og `Quit <navn>` (Cmd+Q). Den settes i `setup` når den innebygde filen finnes, og ellers settes den vanlige IDE-menyen.
  - Backend: `getEmbeddedProject(): Promise<string | null>` og `quitApp(): Promise<void>`. `BrowserBackend` gir `null` og gjør ingenting.
  - `boot(backend: Backend, deps: { startIde: (b: Backend) => void; startRuntime: (p: Project, b: Backend) => Promise<void> }): Promise<void>` i `src/main.ts`. Den velger modus.
  - `startRuntime(project, backend)`:
    - `RunSession(project, new TauriFormHost(), { debugPrint: () => {}, onBreak: async () => 'end', onEnded: () => backend.quitApp(), readFile: backend.readBinaryFile, appPath: <mappen som inneholder .app> }, 'app')` og `start()`.
    - Hovedvinduet vises aldri.
    - Cmd+Q gir `session.end()` og så `quitApp`.
  - `App.Path` = mappen som inneholder .app-en. `App.EXEName` = appnavnet. `App.Title` = `project.title || project.name`.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('no embedded project starts IDE', async () => { /* fake backend gir null → startIde kalt */ });
test('embedded project starts runtime', async () => { /* gir serializeProject(p) → startRuntime kalt med p */ });
test('corrupt embedded project shows error and quits', async () => { /* 'hei' → messageBox med 'This is not a VibeBasic project file.' og så quitApp */ });
test('session end quits app', async () => { /* onEnded → quitApp kalt */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør `npm test` og `npm run test:rust`.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(make): runtime mode for made apps`.

### Oppgave 4: Make-flyten i IDE-en

**Filer:** Opprett `src/build/makeApp.ts`. Endre `src/ide/menus.ts`, `src/ide/projectDialogs.ts` og `src/backend/*`. Test: `tests/build/makeApp.test.ts`

**Grensesnitt:**
- Produserer:
  - Backend: `saveAppDialog(defaultName: string): Promise<string | null>` (filter `.app`, macOS spør selv om erstatning) og `makeApp(o: { targetPath: string; appName: string; projectJson: string; iconPngBase64: string | null; overwrite: boolean }): Promise<void>`. `BrowserBackend.makeApp` kaster `Make requires the desktop version of VibeBasic.`
  - `makeAppFlow(ide: IdeState, backend: Backend): Promise<void>`
  - Fanen Make i Project Properties har Icon, med knappen `Browse...` for PNG, forhåndsvisning 32×32 og `Clear`. Ikonet lagres i `project.assets` og `project.iconAsset`.

- `makeAppFlow`:
  1. Er IDE-en i `run` eller `break`, vises `messageBox98` med `Can't make the app while the program is running.`.
  2. `saveAppDialog(sanitize(project.title || project.name) + '.app')`. `null` avbryter.
  3. Appnavnet er filnavnet uten `.app`.
  4. `makeApp({ …, overwrite: true })` (lagre-panelet har allerede bekreftet erstatning).
  5. Feil vises i `messageBox98` med vbCritical og teksten fra Rust.
  6. Når det lykkes, vises ingen dialog (VB6-oppførsel). Statuslinjen eller tittelen viser ikke noe nytt.

  `Make Project1.app...` i File-menyen bruker `project.name`, se plan 02 oppg. 6.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('default file name from title', async () => { /* title 'Min Kalk' → saveAppDialog('Min Kalk.app') */ });
test('cancel does nothing', async () => { /* null → makeApp ikke kalt */ });
test('passes project json and icon', async () => { /* iconAsset satt → iconPngBase64 = asset.dataBase64 */ });
test('error shown', async () => { /* makeApp kaster 'Could not make the app: x' → messageBox med samme tekst */ });
test('blocked while running', async () => { /* mode 'run' → melding, ingen dialog */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(make): Make dialog and project icon`.

### Oppgave 5: Ende-til-ende-sjekk (manuell)

- [ ] **Steg 1: Bygg VibeBasic** med `npm run tauri build`. Forventet: `src-tauri/target/release/bundle/macos/VibeBasic.app`.
- [ ] **Steg 2: Lag en app.** Start den bygde VibeBasic.app og åpn `tests/run/e2e/calc.vbb`. Sett et ikon i Project Properties → Make, og velg File → Make Kalk.app… med skrivebordet som mål.
- [ ] **Steg 3: Prøv appen.**
  1. Åpne `Kalk.app` fra Finder.
  2. Kalkulatoren skal åpne i Win98-stil med riktig navn i menylinjen og Dock, og uten IDE-vindu.
  3. Regn ut 1 + 2.
  4. Lukk vinduet. Appen skal avslutte.
- [ ] **Steg 4: Prøv feil og erstatning.**
  1. Lag `Kalk.app` en gang til. macOS spør om erstatning. Svar Ja, og den nye appen skal virke.
  2. Lag en kjøretidsfeil i koden, lag appen på nytt og utløs feilen. Dialogen `Run-time error '11':` med bare OK skal vises, og appen avslutter.
- [ ] **Steg 5: Noter resultatet** i `docs/superpowers/plans/2026-10-22-vibebasic-04-make-app.md` under en ny overskrift «Verifisert», med dato og hva som ble sjekket. Commit med meldingen `docs(make): verified end-to-end`.

Merk: mottakere av appen må høyreklikke → Åpne første gang (Gatekeeper), fordi appen bare er ad-hoc-signert. Det godtar spec-en.

---

## Arvet fra grunnmuren (gjennomgang, 2026-10-22)

- Cargo-pakken heter fortsatt `app`/`app_lib`, med maler for beskrivelse og forfatter.
- `tauri.conf.json` har Android-rester og `bundle.targets: "all"`.
- Den kjørbare filen heter derfor `app`, og oppgave 2 gir den nytt navn.
- Rydd i dette i oppgave 1 eller 2.
