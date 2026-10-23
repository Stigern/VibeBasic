# VibeBasic plan 07: kraftigere AI-verktøy

> **For agentiske arbeidere:** PÅKREVD UNDER-FERDIGHET: superpowers:subagent-driven-development. LEAN MODE: planens tester pluss det helt nødvendige.

**Mål:** AI-assistenten skal bli raskere, gi bedre kode og kunne hjelpe med feilsøking. Det skjer gjennom fire ting:
- en fast prompt som serveren kan gjenbruke,
- smartere kontroll av koden,
- en samtale som kan fortsette etter første forslag,
- en «Ask AI»-knapp i feildialogene.

**Arkitektur:**
- Alt AI-arbeid ligger i `src/ai`: prompt og kontekst (`context.ts`, `prompts.ts`), kontroll (`validate.ts`) og flyten (`askDialog.ts`, `previewDialogs.ts`).
- Brukstallene (`usage`) går gjennom Rust-proxyen (`src-tauri/src/ai.rs`) og backendene som en valgfri callback i `AiChatOptions`.
- Feilsøking kobler feildialogen (`src/run/errorDialog.ts` og FormHost-ene) og break-modus i `RunSession` til en ny AI-flyt.

**Spec:** [docs/superpowers/specs/2026-10-22-vibebasic-ai-power-design.md](../specs/2026-10-22-vibebasic-ai-power-design.md)

## Felles regler

- Gammel oppførsel skal være uendret: innstillinger, tenkenivå, én angring, og ingenting legges inn uten OK.
- Systemprompten skal være lik byte for byte mellom forespørsler. Ingenting fra prosjektet, ingen dato.
- Meldinger som sendes til Qwen skal være på engelsk, korte og konkrete. Teksten i brukergrensesnittet skal være på engelsk og se ut som Win98.
- Ingen nøkler eller IP-adresser i kode eller tester. Repoet er offentlig.
- Hver oppgave avsluttes med `npm test`, `npx tsc --noEmit` og en commit som ender med en tom linje og `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Oppgaver som endrer Rust-kode kjører i tillegg `cargo test` i `src-tauri`.

## Ting anmelderen skal se etter

1. **Falske treff i kontrollen.** Gyldig kode skal aldri bli flagget. Det gjelder blant annet:
   - innebygde funksjoner (Len, Format, Chr, Val og så videre),
   - konstanter (vbRed, tvwChild og lignende),
   - Public-variabler i moduler, `Form2.Command1`, kontrolltabeller (`Text1(0).Text`) og `Me.Caption`.

   Oppgave 2 har en test med et «stort gyldig program» som ikke skal gi noen problemer.
2. **Change... etter en ny runde:** samtalen skal ta med det siste forståtte forslaget, ikke et svar som ikke ble forstått.
3. **Ask AI mens skjemavinduer er åpne:** programmet stoppes ordentlig før koden endres.
4. **En server uten `usage`:** målelinjen viser bare tiden, uten «undefined».
5. **Moduler like over taket:** gjeldende prosedyre er alltid med i sin helhet.

---

### Oppgave 1: Fast prompt, eksempler, store moduler og måling

**Filer:** `src/ai/prompts.ts`, `src/ai/context.ts`, `src/ai/sse.ts`, `src/backend/tauriBackend.ts`, `src/backend/browserBackend.ts`, `src-tauri/src/ai.rs`, `src/ai/askDialog.ts`. Tester: `tests/ai/context.test.ts`, `tests/ai/sse.test.ts` (eller tilsvarende eksisterende filer), og en Rust-test i `ai.rs`.

**Grensesnitt:**
- `AiChatOptions` får `onUsage?: (u: AiUsage) => void`, der `AiUsage = { promptTokens: number; completionTokens: number; cachedTokens?: number }`.
- Forespørselen sender `stream_options: { include_usage: true }` når den strømmer.
- Rust sender et `ai:usage`-event med samme felt. Navnene i Rust er snake_case, og de gjøres om i tauriBackend.
- `cachedTokens` hentes fra `usage.prompt_tokens_details.cached_tokens` når feltet finnes.
- `export function codeForPrompt(code: string, focus: { procName: string | null; mention: string }, maxLines = 400): string`.

Krav:
- Systemprompten er lik mellom to kall med ulike prosjekter. Kodemodus og skjemamodus har hver sin, men hver av dem er konstant.
- Legg til to-tre korte eksempler i VibeBasic-dialekten, til sammen rundt 15 linjer. De skal vise Caption og Text, `Form_Load`, at fil-I/O ikke finnes, og `Option Explicit` med Dim.
- Rekkefølgen i brukermeldingen er: skjemabeskrivelse, kode, (feil/verdier, som kommer i oppgave 4), ønske.
- `codeForPrompt`:
  - Under taket returneres koden uendret.
  - Over taket returneres deklarasjonene og hele den gjeldende prosedyren, pluss hele prosedyrene som kalles fra den eller som nevnes i ønsket (navnet uten hensyn til store og små bokstaver).
  - For resten sendes bare overskriftslinjen, med `' ... (body omitted)` under.
- Ventedialogen viser én målelinje når den er ferdig, og den samme linjen står over forhåndsvisningen: `3,210 prompt tokens (2,900 cached) · 41 s`. Uten tall fra serveren vises bare `41 s`.

Tester:
- Systemprompten er lik for to ulike prosjekter.
- `codeForPrompt` lar korte moduler være uendret.
- En modul på 500 linjer gir hele den gjeldende prosedyren og prosedyren den kaller, mens de andre kortes ned til overskriften.
- SSE-strømmen med en usage-chunk kaller `onUsage` med `cachedTokens`.
- Rust: en usage-chunk blir tolket.

### Oppgave 2: Smartere kontroll av koden

**Filer:** `src/ai/validate.ts` (og eventuelt den nye filen `src/ai/knownNames.ts`), `src/ai/askDialog.ts` (ny runde for JSON i skjemamodus). Test: `tests/ai/validate.test.ts`.

**Grensesnitt:**
- `ValidateContext` får `project?: Project`. Uten prosjekt gjøres bare sjekkene som ikke trenger det.
- `validateCode` returnerer fortsatt `string[]`.

Nye regler (alle beskrevet i specen):
1. **`Kontroll.Medlem` eller `Me.Kontroll.Medlem`** der medlemmet verken er en egenskap eller en metode i registeret for den typen:
   - Melding: `A Label has no Text property. Did you mean Caption?`
   - Forslag hentes først fra en liten tabell over vanlige forvekslinger (Label.Text→Caption, TextBox.Caption→Text, Form.Text→Caption, ListBox.Items→List/AddItem, CheckBox.Checked→Value), og deretter fra navnet i registeret som ligner mest.
   - Kontrolltabeller (`Text1(0).Text`) skal også sjekkes.
2. **Ukjent navn foran et punktum.** Navnet er ikke noe av dette:
   - en kontroll, et skjema eller en modul i prosjektet,
   - en variabel, konstant eller parameter (fra koden),
   - et innebygd objekt (App, Screen, Err, Debug, Clipboard, Forms, Me),
   - noe språket allerede kjenner.

   Melding: `X is not a control, form, module or variable.`
3. **`Option Explicit` i modulen:** identifikatorer som er brukt, men ikke deklarert, gir `Variable not defined: x`. Bruk det språket selv vet om hvilke navn som finnes, slik at regelen stemmer med F5. Det gjelder innebygde funksjoner, konstanter, Public-navn i prosjektet og kontroller.
4. **Ikke støttet:** SaveSetting, GetSetting, DeleteSetting, Open, Close #, Print #, Input #, Line Input, Declare, CreateObject og GetObject.
   - Melding: `X is not supported in VibeBasic.`
   - Der det finnes et alternativ, legges det til, for eksempel «use a module-level variable instead».
- **Skjemamodus:** hvis `parseFormOps` feiler, blir det én ny runde med `Your answer was not valid JSON (<grunn>). Answer again with ONLY the JSON object.` Det skal fortsatt bare bli én ny runde totalt per spørsmål.
- Alle reglene gir bare melding. Ingen av dem endrer koden.

Tester:
- Label1.Text gir et forslag om Caption.
- `Text1(0).Text` på en TextBox-tabell gir ingen melding.
- Et ukjent `Foo.Bar` blir meldt.
- `Option Explicit` + `x = 1` gir `Variable not defined: x`, mens `Dim x` + `x = 1` ikke gir noe.
- `SaveSetting` blir meldt.
- Et stort gyldig program gir ingen problemer. Det bruker:
  - innebygde funksjoner,
  - vb- og tvw-konstanter,
  - en Public-variabel i en modul,
  - `Form2.Command1.Caption`,
  - `Me.Caption`,
  - For Each over `Controls`,
  - `With`-blokker.
- Ugyldig JSON i skjemamodus gir én ny runde, og det andre svaret blir brukt (med en falsk backend).

### Oppgave 3: Fortsett samtalen (Change...)

**Filer:** `src/ai/previewDialogs.ts`, `src/ai/askDialog.ts`. Test: `tests/ai/askDialog.test.ts` (den eksisterende filen).

**Grensesnitt:**
- `showCodePreview` og `showFormPreview` returnerer `'ok' | 'cancel' | { change: string }` i stedet for boolean. Oppdater alle som kaller dem.
- Knappen `Change...` åpner en liten Win98-dialog med en tekstboks, «What should be changed?», og knappene OK og Cancel. Cancel går tilbake til den samme forhåndsvisningen.

Krav:
- Samtalen vokser bare bakover: `[system, user, assistant(siste forståtte svar), user(endringsønske), …]`. Det som allerede er sendt, skrives aldri om.
- Endringsønsket inneholder ønsket og ingen ny kopi av koden. Modellen har forslaget sitt i samtalen.
- Hvert nytt svar går gjennom den samme analysen og den ene nye runden for kontroll som det første svaret.
- Blir det nye svaret ikke forstått, vises «not understood» med Details. Etterpå kommer du tilbake til det forrige forslaget.
- Når samtalen er over cirka 24 000 tegn, fjernes de eldste parene av assistentsvar og endringsønske. Systemmeldingen, det første spørsmålet og det siste svaret beholdes.
- OK legger inn det siste forslaget som ett angre-steg, som før.

Tester:
- Change... sender en samtale der de første meldingene er identiske med første forespørsel, og som slutter med endringsønsket. OK legger da inn det andre forslaget.
- Et nytt svar som ikke blir forstått, går tilbake til det første forslaget.
- Cancel i Change-dialogen går tilbake til forhåndsvisningen.

### Oppgave 4: Feilsøking med AI (Ask AI i feildialogene) og 0.7.0

**Før du starter:** kontrolleren merger `feat/toolbox-controls` (plan 06 oppgave 5 og 6) inn i denne grenen.

**Filer:**
- `src/run/errorDialog.ts`, `src/run/formHost.ts`, `src/run/tauriFormHost.ts`, `src/run/inlineFormHost.ts`, `src/run/dialogSpec.ts`, `src/run/session.ts`
- `src/lang/interp/*` (bare for å lese variabelverdier i break-modus, hvis det ikke allerede finnes)
- `src/ide/menus.ts`, `src/ide/main.ts`
- `src/ai/context.ts`, `src/ai/askDialog.ts`
- `package.json` med `npm version` (0.7.0), `CHANGELOG.md`
- Tester: `tests/run/errorDialog.test.ts`, `tests/ai/fixWithAi.test.ts`

**Grensesnitt:**
- `runtimeErrorContent` får knappen `Ask AI` med verdien `'ai'`. Den kommer i IDE-modus mellom Debug og Help, og etter OK i kompileringsfeil. Den finnes aldri i app-modus.
- `runtimeErrorBox` returnerer `'end' | 'debug' | 'ai'`.
- `RunSession` bruker `'ai'` som `'debug'`. Programmet går altså i break-modus på feillinjen, og IDE-en starter AI-flyten.
- `export function snapshotVariables(...)`: lokale variabler og modulvariabler i rammen som er stoppet, som `{ name: string; value: string }[]`.
  - Strenger kortes ned til 80 tegn.
  - Tabeller og objekter vises som typen, med de første tre verdiene.
  - Høyst 40 variabler.
- `export function buildFixRequest(p: Project, itemId: string, err: { number: number; description: string; compile: boolean; line: number; procName: string | null }, vars: { name: string; value: string }[]): ChatMessage[]`
  - Den bruker samme systemprompt som kodemodus.
  - I brukermeldingen kommer først skjemabeskrivelsen, så koden (`codeForPrompt`, med fokus på prosedyren med feilen og de som kaller den), så feilen, linjen og verdiene. Til slutt står den faste teksten `Fix the error.`
- Menyen Tools har `Ask AI about this error` (handlingen `askAiAboutError`). Den er bare aktiv i break-modus etter en feil.

Krav:
- Flyten bruker kodemodusens analyse, forhåndsvisning, Change... og den ene nye runden for kontroll.
- **OK:**
  1. Stopp programmet (End) og vent til det har stoppet.
  2. Legg rettingen inn i den riktige modulen eller det riktige skjemaet som ett angre-steg.
  3. Åpne kodevinduet på den linjen.
- **Cancel:** programmet blir stående i break-modus.
- Kompileringsfeil sender ingen variabler.
- Versjonen blir 0.7.0, og CHANGELOG.md får 0.7.0-delen med de fire forbedringene. Du kan også ta med 0.6.0-kontrollene hvis de mangler der.

Tester:
- Feildialogen har Ask AI i IDE-modus, men ikke i app-modus.
- `snapshotVariables` gir avkortede strenger, og ikke mer enn 40 variabler.
- `buildFixRequest` inneholder feilnummeret, linjen og variablene i riktig rekkefølge. Systemprompten er den samme som i kodemodus.
- En kjøring med en falsk backend: `x = 1 / 0` → Ask AI → forslaget → OK. Programmet er stoppet, koden er endret, og ett Ctrl+Z tar alt tilbake.
