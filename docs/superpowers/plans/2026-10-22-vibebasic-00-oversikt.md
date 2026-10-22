# VibeBasic: byggeplan, oversikt

> **For agentiske arbeidere:** PÅKREVD UNDER-FERDIGHET: Bruk superpowers:subagent-driven-development (anbefalt) eller superpowers:executing-plans for å gjennomføre planene oppgave for oppgave. Stegene bruker avkrysningsbokser (`- [ ]`).

**Mål:** En kopi av Visual Basic 6.0 for Mac med ekte Windows 98-utseende. Du tegner skjemaer, skriver BASIC og kjører med F5. Du kan lage selvstendige Mac-apper, og du kan få AI-hjelp via et OpenAI-kompatibelt API (Ollama/Qwen).

**Arkitektur:** Det er én Tauri 2-app med TypeScript-frontend. Språkkjernen er ren TypeScript uten DOM. Den er en tolk som bruker generatorer, slik at den kan pause for DoEvents, dialoger og break-modus. Kontroll-rendering og tolk deles mellom IDE (F5) og ferdige apper. Ferdige apper er en kopi av VibeBasic.app selv med prosjektet lagt inn i Resources. Ved oppstart ser appen et innebygd prosjekt og går da i runtime-modus. Hvert VB-skjema er et ekte Mac-vindu som tegnes ut fra en snapshot og patcher fra tolken i hovedvinduet (fjern-rendering).

**Teknologi:** Tauri 2, Rust (stabil), Node 22, TypeScript (strict), Vite (flersidig), Vitest (+ jsdom), CodeMirror 6, 98.css (MIT) som utgangspunkt for temaet, reqwest (Rust, AI-kall) og plist (Rust).

**Spec:** [docs/superpowers/specs/2026-10-22-vibebasic-design.md](../specs/2026-10-22-vibebasic-design.md). Les den før du starter på en plan.

## Planene og rekkefølgen

| Plan | Innhold | Avhenger av |
|---|---|---|
| [00 Oppgave 0](#oppgave-0-grunnmur) | Grunnmur: repo, Vite, Tauri, test-oppsett | – |
| [01 Språkkjerne](2026-10-22-vibebasic-01-sprakkjerne.md) | Lexer, parser, verdier, tolk, innebygde funksjoner, break-modus | 00 |
| [02 IDE og designer](2026-10-22-vibebasic-02-ide-designer.md) | Prosjektmodell, Win98-tema, skjemadesigner, Properties, kodevindu, filer | 00 (bruker `prettifyLine`/`findSyntaxErrors` fra 01 i oppg. 9) |
| [03 Kjøring](2026-10-22-vibebasic-03-kjoring.md) | Kontrollobjekter, skjemavinduer, RunSession, dialoger, F5/break/Immediate | 01, 02 |
| [04 Make app](2026-10-22-vibebasic-04-make-app.md) | Pakking til .app, runtime-modus | 03 |
| [05 AI-assistent](2026-10-22-vibebasic-05-ai.md) | Innstillinger, AI-proxy, kodemodus, skjemamodus, forhåndsvisning | 02 (03 for manuell test av generert kode) |

01 og 02 kan gjøres parallelt når oppgave 0 og 01 oppg. 1 er ferdige, fordi `validateName` i 02 oppg. 1 bruker `KEYWORDS`. Oppgave 9 i 02 trenger 01 oppg. 3 og 9.

## Felles regler

Disse gjelder alle oppgaver i alle planene:

- Kun macOS. Minste versjon er `12.0` (Tauri `bundle.macOS.minimumSystemVersion`). Primært arm64.
- Twips: **1 piksel = 15 twips**, overalt. Modellen lagrer twips, og rendering deler på 15.
- Farger lagres som VB6 Long. Vanlige farger er BGR `&H00BBGGRR`. Systemfarger `&H800000xx` mappes til Win98-paletten i `src/model/colors.ts` (tabell i plan 02 oppg. 1).
- IDE-tekster, menyer, feilmeldinger og dialoger er på **engelsk, som i VB6** (for eksempel «Run-time error '13':», «Save changes to the following files?»). Dette er Claudes valg for autentisitet.
- Win98-utseende: grå `#c0c0c0`, aktiv tittellinje-gradient `#000080 → #1084d0`, inaktiv `#808080 → #b5b5b5`, outset/inset-kanter som 98.css. Pikselfonten må ha en lisens som tillater at den følger med (98.css sin «Pixelated MS Sans Serif» eller tilsvarende). Reserve: `Tahoma, Geneva, sans-serif` 11px.
- Kodevindu: `"Courier New", monospace` 13px. Nøkkelord `#000080`, kommentarer `#008000`, syntaksfeil `#FF0000`, aktiv break-linje med bakgrunn `#FFFF00`.
- Nettverk: VibeBasic gjør ingen nettverkskall utenom AI-kall til adressen brukeren har satt opp.
- `src-tauri/Info.plist` skal ha `NSLocalNetworkUsageDescription` = `"VibeBasic connects to your AI server on the local network."`. Uten den blokkerer macOS kall til Ollama på en annen PC.
- Prosjektfil: én JSON-fil med endelsen `.vbb` og `"format": "vibebasic-project", "version": 1` (plan 02 oppg. 2).
- Alle tester kjøres med `npm test` (Vitest) og `npm run test:rust` (`cargo test --manifest-path src-tauri/Cargo.toml`). Begge skal være grønne før hver commit.
- Commit etter hver oppgave, med meldinger på formen `feat(lang): …`, `feat(ide): …`, `fix: …`.

## Review Focus

Dette er feiltilfeller spec-en antyder og som brukere vil treffe. Hver linje har en test i oppgaven som eier koden:

1. **Evig løkke uten DoEvents** (`Do: Loop` i en Click). IDE-en skal fortsatt svare, og Ctrl+Break/End skal stoppe programmet innen 0,5 s. Test: 01 oppg. 8 og 03 oppg. 7.
2. **AI-tjenesten er nede, treg eller svarer med søppel** (vanlig med små lokale modeller). Ingen endring skal brukes, og du skal få en lesbar feilmelding med «Details». Test: 05 oppg. 1, 4, 5 og 7.
3. **Kontroll får nytt navn etter at koden er skrevet** (Command1 → cmdOK). Som i VB6 blir gamle hendelsesprosedyrer liggende uendret under (General), og de kjøres ikke. Ugyldig eller duplisert navn gir VB6-dialog. Test: 02 oppg. 3 og 8, 03 oppg. 3.
4. **Ulagrede endringer** ved New/Open/Quit gir «Save changes to the following files?» med Yes/No/Cancel. Cancel avbryter. Test: 02 oppg. 11.
5. **Make app når målet finnes fra før, eller navnet har mellomrom/æøå.** Du får spørsmål om å erstatte, og bundle-id og filnavn blir gyldige. Test: 04 oppg. 1 og 2.

---

## Mappestruktur (låst her, fylles av planene)

```
VibeBasic/
  index.html               IDE / oppstart (src/main.ts)
  form.html                ett VB-skjemavindu i kjøring (src/run/formWindowMain.ts)
  dev/gallery.html         utviklerside: alle kontroller rendret (plan 02)
  src/
    main.ts                velger IDE- eller runtime-modus
    backend/               Backend-grensesnitt + Tauri- og nettleser-implementasjon
    lang/                  språkkjerne (plan 01), ingen DOM-import tillatt
    model/                 prosjektmodell, kontrollregister, farger, kommandoer (plan 02)
    ui98/                  Win98-tema og generiske widgets/dialoger (plan 02)
    controls/              renderControl, delt av designer og kjøring (plan 02)
    ide/                   IDE-vinduer (plan 02, 03, 05)
    run/                   kjøring (plan 03)
    build/                 Make-dialog (plan 04)
    ai/                    AI-assistent (plan 05)
  src-tauri/               Rust: kommandoer for filer, vinduer, Make app, AI-proxy
  tests/                   speiler src/ (tests/lang, tests/model, …)
```

## Oppgave 0: Grunnmur

**Filer:**
- Opprett: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `form.html`, `src/main.ts`, `src/backend/backend.ts`, `src/backend/browserBackend.ts`, `src/backend/tauriBackend.ts`, `.gitignore`, `src-tauri/` (via `tauri init`), `tests/smoke.test.ts`

**Grensesnitt:**
- Produserer: `interface Backend` i `src/backend/backend.ts`. Senere planer utvider det med egne metoder (02: filer, 03: vinduer, 04: make/embedded, 05: AI og innstillinger). `getBackend(): Backend` velger `TauriBackend` når `window.__TAURI_INTERNALS__` finnes, ellers `BrowserBackend`. Da kan IDE-en kjøres i en vanlig nettleser med `npm run dev` for rask testing og skjermbilder.

- [ ] **Steg 1: Lag repo og `.gitignore`.**
  Kjør `git init`. `.gitignore` skal inneholde `node_modules/`, `dist/`, `src-tauri/target/`, `.superpowers/` og `.DS_Store`.

- [ ] **Steg 2: Sett opp Vite + TypeScript + Vitest.**
  - Dev-avhengigheter: `vite`, `typescript`, `vitest`, `jsdom`, `@tauri-apps/cli`.
  - Avhengighet: `@tauri-apps/api`.
  - `tsconfig`: `strict: true`, `target: ES2022`, `moduleResolution: bundler`.
  - `vite.config.ts`: flersidig med `build.rollupOptions.input = { main: 'index.html', form: 'form.html', gallery: 'dev/gallery.html' }` (lag `dev/gallery.html` tom nå), og `server.port = 1420`, `strictPort: true`.
  - Skript: `"dev": "vite"`, `"build": "tsc --noEmit && vite build"`, `"test": "vitest run"`, `"test:rust": "cargo test --manifest-path src-tauri/Cargo.toml"`, `"tauri": "tauri"`.

- [ ] **Steg 3: Init Tauri 2.**
  - Kjør `npx tauri init` med appnavn `VibeBasic`, vindustittel `Project1 - VibeBasic [design]`, frontend-dist `../dist`, dev-URL `http://localhost:1420`, dev-kommando `npm run dev` og build-kommando `npm run build`.
  - I `tauri.conf.json`:
    - `identifier: "no.vibebasic.ide"`
    - hovedvindu `label: "main"`, `width: 1024`, `height: 768`, `visible: false` (vises av `main.ts`)
    - `bundle.macOS.minimumSystemVersion: "12.0"`
  - Lag `src-tauri/Info.plist` med `NSLocalNetworkUsageDescription` (se Felles regler).
  - Legg til pluginene `tauri-plugin-dialog`, med JS-pakken `@tauri-apps/plugin-dialog`.

- [ ] **Steg 4: Skriv røyktesten `tests/smoke.test.ts`.**

```ts
import { getBackend } from '../src/backend/backend';
test('browser backend is chosen outside Tauri', () => {
  expect(getBackend().kind).toBe('browser');
});
```

- [ ] **Steg 5: Implementer `Backend` med `readonly kind: 'tauri' | 'browser'` og `showMainWindow(): Promise<void>`.**
  `src/main.ts` kaller `getBackend().showMainWindow()` og viser teksten «VibeBasic». `BrowserBackend.showMainWindow` gjør ingenting.

- [ ] **Steg 6: Bekreft.**
  - `npm test`: PASS.
  - `npm run test:rust`: PASS (0 tester).
  - `npm run tauri dev` åpner et vindu med «VibeBasic».

- [ ] **Steg 7: Commit** med meldingen `chore: grunnmur (vite, tauri 2, vitest)`.

## Kjøring av planene

Anbefalt er subagent-drevet kjøring, én plan om gangen i rekkefølgen over. Etter hver plan skal det finnes noe som virker og kan prøves:

| Etter plan | Kan prøves |
|---|---|
| 01 | Golden-tester med BASIC-programmer |
| 02 | IDE-en der du tegner og lagrer |
| 03 | F5 kjører programmet |
| 04 | Make app |
| 05 | AI |
