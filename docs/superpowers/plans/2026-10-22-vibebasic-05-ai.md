# VibeBasic plan 05: AI-assistent

> **For agentiske arbeidere:** PÅKREVD UNDER-FERDIGHET: Bruk superpowers:subagent-driven-development (anbefalt) eller superpowers:executing-plans. Stegene bruker avkrysningsbokser (`- [ ]`).

**Mål:** Tools → Ask AI… (Ctrl+I) lar deg be en OpenAI-kompatibel modell (for eksempel Qwen via Ollama på en annen PC) skrive kode eller sette opp skjemaet. Hva AI-en gjør, kommer an på hvor du står:
- I kodevinduet skriver eller endrer den prosedyrer.
- I designeren legger den til, endrer og sletter kontroller, og kan også skrive hendelseskode.

Du ser forslaget først og trykker OK eller Cancel. Det som er godtatt, angres i ett steg med Ctrl+Z.

**Arkitektur:**
- **Nettverk:** AI-kallene går gjennom Rust (`reqwest`) for å unngå CORS og blandet innhold mot `http://<ip>:11434`.
- **Forespørsel:** frontend bygger meldinger med kontekst, det vil si en beskrivelse av skjemaet og den aktuelle prosedyren.
- **Svar:**
  - Kodemodus forventer én kodeblokk.
  - Skjemamodus forventer et enkelt JSON-format som tolkes tolerant og valideres mot kontrollregisteret.
- **Angring:**
  - Kodemodus: én CodeMirror-transaksjon.
  - Skjemamodus: én `compositeCmd` i `CommandStack`, inkludert en eventuell kodeendring via `setCodeCmd`.

**Teknologi:** Rust (`reqwest` med `json` og `rustls-tls`, `tokio`, dev: `httpmock`), TypeScript og Vitest.

**Spec:** [spec](../specs/2026-10-22-vibebasic-design.md), kap. 7. Felles regler: se [oversikten](2026-10-22-vibebasic-00-oversikt.md).

## Regler for denne planen

- **Forespørsel:** `POST {baseUrl}/chat/completions` med `{ model, messages, temperature: 0.2, stream: false }`. Svaret leses fra `choices[0].message.content`. Tidsavbrudd etter 180 s.
- **Modelliste:** `GET {baseUrl}/models` gir `data[].id`. `baseUrl` kan slutte med eller uten `/`.
- **Tenkeblokker:** alt mellom `<think>` og `</think>` fjernes før tolkning, fordi Qwen-modeller tenker høyt.
- **Hendelseskode i designeren:** AI-endringer fra designeren gjelder skjemaet og eventuelt skjemaets kode.
- **Når Ask AI er deaktivert:** i `run` og `break`.

## Filer

```
src-tauri/src/ai.rs          ai_list_models, ai_chat, endpoint, friendly_error
src/backend/*                aiListModels, aiChat
src/ai/settings.ts           AiSettings, loadAiSettings, saveAiSettings
src/ai/prompts.ts            CODE_SYSTEM_PROMPT, FORM_SYSTEM_PROMPT, describeControlTypes
src/ai/context.ts            describeForm, describeProjectForms, buildCodeRequest, buildFormRequest
src/ai/clean.ts              stripThinking
src/ai/codeMode.ts           extractCode, applyCodeProposal
src/ai/diff.ts               diffLines
src/ai/formMode.ts           parseFormOps, applyFormOpsToClone, formOpsToCommand, describeOps
src/ai/askDialog.ts          Ask AI-dialogen og flyten
src/ai/previewDialogs.ts     forhåndsvisning for kode og skjema
src/ide/optionsDialog.ts     ny fane AI
src/model/commands.ts        + setCodeCmd
tests/ai/*.test.ts
```

---

### Oppgave 1: AI-proxy i Rust

**Filer:** Opprett `src-tauri/src/ai.rs`. Endre `lib.rs` og `Cargo.toml`.

**Grensesnitt:**
- Produserer:

```rust
#[derive(Serialize, Deserialize, Clone)] pub struct ChatMessage { pub role: String, pub content: String }
pub fn endpoint(base_url: &str, path: &str) -> String;     // "http://h:11434/v1/" + "chat/completions" → "http://h:11434/v1/chat/completions"
#[tauri::command] pub async fn ai_list_models(base_url: String, api_key: Option<String>) -> Result<Vec<String>, String>;
#[tauri::command] pub async fn ai_chat(base_url: String, api_key: Option<String>, model: String, messages: Vec<ChatMessage>) -> Result<String, String>;
```

  `Authorization: Bearer <key>` sendes bare når nøkkelen ikke er tom.

- Feiltekster (eksakte, Review Focus 2):

| Situasjon | Tekst |
|---|---|
| Kan ikke koble til | `Could not connect to {base_url}. Check that the AI server is running and can be reached from this Mac. For Ollama on another PC, start Ollama with OLLAMA_HOST=0.0.0.0.` |
| Tidsavbrudd | `The AI server did not answer within 180 seconds.` |
| 404 | `The AI server answered 404 Not Found for {url}. Check the base URL. For Ollama it usually ends with /v1.` |
| 401 eller 403 | `The AI server refused the request ({status}). Check the API key.` |
| Annen status | `The AI server answered {status}: {de første 200 tegnene av svaret}` |
| Svar som ikke kan leses | `The AI server sent an answer VibeBasic could not read.` |

- [ ] **Steg 1: Skriv de feilende testene** med `httpmock`.

```rust
#[test] fn endpoint_joins() { assert_eq!(endpoint("http://h:11434/v1/", "chat/completions"), "http://h:11434/v1/chat/completions"); }
#[tokio::test] async fn chat_returns_content() { /* mock POST /v1/chat/completions → {"choices":[{"message":{"content":"hei"}}]} ; forventer "hei" og at body.model == "qwen" */ }
#[tokio::test] async fn bearer_only_when_key() { /* mock krever header når key Some("k"), ingen header når Some("") */ }
#[tokio::test] async fn models_list() { /* GET /v1/models → {"data":[{"id":"a"},{"id":"b"}]} → ["a","b"] */ }
#[tokio::test] async fn not_found_message() { /* 404 → tekst starter med "The AI server answered 404 Not Found" */ }
#[tokio::test] async fn connection_refused_message() { /* port uten server → starter med "Could not connect to" */ }
#[tokio::test] async fn garbage_body() { /* 200 med "hei" → "The AI server sent an answer VibeBasic could not read." */ }
```

- [ ] **Steg 2: Kjør** `npm run test:rust`. Forventet: FAIL.
- [ ] **Steg 3: Implementer og registrer kommandoene.** `BrowserBackend` gjør det samme med `fetch`, som krever `OLLAMA_ORIGINS=*` og bare er for utvikling, og bruker de samme feiltekstene.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ai): OpenAI-compatible proxy in Rust`.

### Oppgave 2: Innstillinger og AI-fanen i Options

**Filer:** Opprett `src/ai/settings.ts`. Endre `src/ide/optionsDialog.ts` og `src/backend/*`. Test: `tests/ai/settings.test.ts`

**Grensesnitt:**
- Produserer:
  - `interface AiSettings { baseUrl: string; model: string; apiKey: string }`, med standard `{ baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '' }`.
  - `loadAiSettings(b: Backend): Promise<AiSettings>`
  - `saveAiSettings(b: Backend, s: AiSettings): Promise<void>`, med nøkkelen `'ai'` via `loadSettings`/`saveSettings` fra plan 02 oppg. 10.
  - Backend: `aiListModels(s: AiSettings): Promise<string[]>` og `aiChat(s: AiSettings, messages: ChatMessage[]): Promise<string>`.
- AI-fanen har disse feltene:
  - `Base URL:` (tekstfelt)
  - `Model:` (redigerbar ComboBox)
  - `API Key (optional):` (passordfelt)
  - Knappen `Test Connection`. Når den lykkes, fylles modellisten og meldingen `Connected. {n} models found.` vises (vbInformation). Feil vises med teksten fra Rust (vbExclamation).
  - Hjelpetekst under: `For Ollama on another PC use http://<its IP>:11434/v1`.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('defaults', async () => expect(await loadAiSettings(fakeBackend())).toEqual({ baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '' }));
test('roundtrip', async () => { /* save → load gir samme */ });
test('test connection fills models and reports', async () => { /* aiListModels → ['qwen2.5-coder:14b'] → combo har valget, melding 'Connected. 1 models found.' */ });
test('test connection error shown', async () => { /* aiListModels kaster 'Could not connect to …' → messageBox med samme tekst */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ai): settings and Options AI tab`.

### Oppgave 3: Kontekst og prompter

**Filer:** Opprett `src/ai/prompts.ts`, `src/ai/context.ts`, `src/ai/clean.ts`. Test: `tests/ai/context.test.ts`

**Grensesnitt:**
- Produserer:

```ts
export function stripThinking(reply: string): string;
export function describeControlTypes(): string;   // én linje per type: "CommandButton: Caption, Default, Cancel, … | events: Click, …"
export function describeForm(form: FormDef): string;
export function describeProjectForms(p: Project): string;  // "Form1: Command1 (CommandButton), Text1 (TextBox) …" per skjema
export function buildCodeRequest(p: Project, itemId: string, cursorLine: number, userPrompt: string): ChatMessage[];
export function buildFormRequest(p: Project, formId: string, userPrompt: string): ChatMessage[];
export const CODE_SYSTEM_PROMPT: string; export const FORM_SYSTEM_PROMPT: string;
```

- `describeForm` har én linje for skjemaet og én per kontroll, i z-rekkefølge. Bare Left, Top, Width, Height og egenskaper som avviker fra standard tas med. Strenger står i `"…"`. Eksempel:

```
Form Form1 Caption="Login" Width=4800 Height=3600
CommandButton cmdOK Left=1200 Top=2400 Width=1215 Height=495 Caption="OK" Default=True
TextBox Text1 Left=1200 Top=600 Width=2415 Height=315 Text=""
CommandButton Command1(0) Left=120 Top=120 Width=495 Height=495 Caption="1"
Label Label1 in Frame1 Left=120 Top=240 Width=1215 Height=255 Caption="Navn:"
```

- `buildCodeRequest` sender to meldinger:
  - `system`: `CODE_SYSTEM_PROMPT` + `describeControlTypes()`.
  - `user`:
    - For et skjema: `describeForm`. For en modul: `describeProjectForms`.
    - Hele modulkoden.
    - Navnet på prosedyren markøren står i, eller `(none)`.
    - Til slutt brukerens forespørsel.
- `buildFormRequest` sender to meldinger:
  - `system`: `FORM_SYSTEM_PROMPT` + `describeControlTypes()`.
  - `user`: `describeForm`, skjemakoden og forespørselen.
- `CODE_SYSTEM_PROMPT` må si dette:
  1. Det er VB6-dialekten VibeBasic. Disse finnes ikke: klassemoduler, `Declare`, fil-I/O, `Print`/`Line`/`Circle`/`PSet` på skjemaer, navngitte argumenter og ActiveX.
  2. Svar med **nøyaktig én** kodeblokk ```` ```vb ```` som inneholder hele prosedyrer (fra `Private Sub` til `End Sub`), og ingenting annet utenfor blokken enn eventuelt én kort setning.
  3. Bruk bare kontrollnavn som finnes.
  4. Skal noe deklareres på modulnivå, settes det øverst i blokken før prosedyrene.
- `FORM_SYSTEM_PROMPT` må forklare:
  1. Twips: 1 piksel = 15 twips. Standardskjemaet er 4800×3600. Rutenettet er 120. Vanlig knapp er 1215×495, og en enlinjet TextBox er 315 høy.
  2. Svaret skal være **bare** et JSON-objekt i formatet fra oppgave 5, med ett eksempel.
  3. Eksisterende kontroller endres med `set` og ikke med `add`.
  4. Hendelseskode legges i feltet `code` som hele prosedyrer.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('strip thinking', () => expect(stripThinking('<think>hmm\nja</think>\nSvar')).toBe('Svar'));
test('describe form exact', () => expect(describeForm(sampleForm)).toBe(expectedLines));   // sampleForm/expectedLines som eksempelet over
test('code request mentions current procedure', () => expect(buildCodeRequest(p, form1.id, 3, 'tell til 10')[1].content).toContain('Current procedure: Command1_Click'));
test('module request lists forms', () => expect(buildCodeRequest(p, module1.id, 1, 'x')[1].content).toContain('Form1: Command1 (CommandButton)'));
test('system prompts contain format rules', () => { expect(CODE_SYSTEM_PROMPT).toContain('```vb'); expect(FORM_SYSTEM_PROMPT).toContain('"ops"'); });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ai): context and prompts`.

### Oppgave 4: Kodemodus

**Filer:** Opprett `src/ai/codeMode.ts`, `src/ai/diff.ts`, `src/ai/previewDialogs.ts` (kodedelen). Test: `tests/ai/codeMode.test.ts`

**Grensesnitt:**
- Konsumerer: `listProcedures` og `findProcedureRange` (plan 02 oppg. 9), og `CodeWindow.applyChange`.
- Produserer:

```ts
export function extractCode(reply: string): string | null;
export interface CodeApplyResult { source: string; changes: { name: string; kind: 'replaced' | 'added' | 'body' | 'declarations' }[] }
export function applyCodeProposal(source: string, code: string, currentProc: string | null): CodeApplyResult | null;  // null = ingenting å bruke
export function diffLines(a: string[], b: string[]): { kind: 'same' | 'add' | 'del'; text: string }[];
export function showCodePreview(doc: Document, before: string, after: string, changes: CodeApplyResult['changes']): Promise<boolean>;
```

- `extractCode`:
  1. Kjør `stripThinking`.
  2. Bruk den første blokken som er merket ```` ```vb ````, ```` ```vba ````, ```` ```vb6 ````, ```` ```vbnet ```` eller ```` ```basic ````. Ellers den første umerkede ```` ``` ````-blokken.
  3. Uten blokk: bruk hele teksten hvis første linje som ikke er tom starter med `Private`, `Public`, `Sub`, `Function`, `Dim`, `Const` eller `'`.
  4. Ellers: `null`.
- `applyCodeProposal`:
  1. Hver prosedyre i forslaget erstatter prosedyren med samme navn (store eller små bokstaver spiller ingen rolle), eller legges til på slutten med en tom linje imellom.
  2. Linjer før den første prosedyren i forslaget (deklarasjoner) settes inn etter den siste deklarasjonen øverst i modulen, eller etter `Option Explicit`. Linjer som allerede finnes, dobles ikke.
  3. Har forslaget ingen prosedyrer og `currentProc` er satt, erstatter teksten innholdet i `currentProc` (linjene mellom `Sub` og `End Sub`).
  4. Ingenting brukbart: `null`.
- Forhåndsvisningen er en Win98-dialog `AI Suggestion` med to kolonner, `Before` og `After`, med Courier-font. Nye linjer har grønn bakgrunn og slettede rød. Under er en liste over endringene og knappene `OK` og `Cancel`.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('extract fenced vb', () => expect(extractCode('Her:\n```vb\nPrivate Sub A()\nEnd Sub\n```\nFerdig')).toBe('Private Sub A()\nEnd Sub'));
test('extract unfenced code', () => expect(extractCode('Private Sub A()\nEnd Sub')).toBe('Private Sub A()\nEnd Sub'));
test('prose only is null', () => expect(extractCode('Beklager, jeg forstår ikke.')).toBeNull());       // Review Focus 2
test('replace by name case-insensitive', () => { const r = applyCodeProposal('Private Sub command1_click()\nx = 1\nEnd Sub', 'Private Sub Command1_Click()\nx = 2\nEnd Sub', null)!;
  expect(r.source).toBe('Private Sub Command1_Click()\nx = 2\nEnd Sub'); expect(r.changes).toEqual([{ name: 'Command1_Click', kind: 'replaced' }]); });
test('add new procedure', () => { /* ny prosedyre havner sist med tom linje imellom, kind 'added' */ });
test('declarations after option explicit, no dupes', () => { /* 'Dim teller As Integer' settes etter Option Explicit én gang */ });
test('bare statements replace current body', () => { /* currentProc 'Command1_Click', kode 'Label1.Caption = "Hei"' → body byttet, kind 'body' */ });
test('bare statements without current proc is null', () => expect(applyCodeProposal('Option Explicit', 'x = 1', null)).toBeNull());
test('diff', () => expect(diffLines(['a', 'b'], ['a', 'c'])).toEqual([{ kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'c' }]));
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ai): code mode proposals and preview`.

### Oppgave 5: Skjemamodus

**Filer:** Opprett `src/ai/formMode.ts` og skjemadelen av `src/ai/previewDialogs.ts`. Endre `src/model/commands.ts` (`setCodeCmd`) og `src/ide/codeWindow.ts`: et åpent kodevindu lastes på nytt når koden endres utenfra og vinduet ikke har fokus. Test: `tests/ai/formMode.test.ts`

**Grensesnitt:**
- Konsumerer: `getPropDef`, `CONTROL_TYPES`, `newControl`, `nextDefaultName`, `validateName`, `parsePropertyInput` (plan 02 oppg. 8), `compositeCmd`, `addControlsCmd`, `setPropertyCmd`, `deleteControlsCmd` og `renderFormSurface`.
- Produserer:

```ts
export type FormOp =
  | { op: 'add'; type: Exclude<ControlType, 'Form'>; name: string; index: number | null; container: string | null; props: Record<string, PropValue> }
  | { op: 'set'; name: string; index: number | null; props: Record<string, PropValue> }
  | { op: 'delete'; name: string; index: number | null }
  | { op: 'form'; props: Record<string, PropValue> };
export type ParsedFormOps = { ok: true; ops: FormOp[]; code: string | null; warnings: string[] } | { ok: false; error: string; raw: string };
export function parseFormOps(reply: string, form: FormDef): ParsedFormOps;
export function formOpsToCommand(p: Project, formId: string, parsed: Extract<ParsedFormOps, { ok: true }>, label: string): Command;  // én compositeCmd, inkl. setCodeCmd
export function describeOps(parsed: Extract<ParsedFormOps, { ok: true }>): string[];   // "Add CommandButton cmdOK", "Set Text1.Text = \"\"", "Delete Label1", "Set Form.Caption = \"Login\"", "Add code: cmdOK_Click"
export function applyFormOpsToClone(form: FormDef, parsed: Extract<ParsedFormOps, { ok: true }>): FormDef;  // til forhåndsvisning
export function setCodeCmd(itemId: string, newCode: string): Command;    // i src/model/commands.ts
```

- JSON-formatet som modellen skal svare med:

```json
{ "ops": [
  { "op": "add", "type": "CommandButton", "name": "cmdOK", "container": null, "props": { "Caption": "OK", "Left": 1200, "Top": 2400, "Width": 1215, "Height": 495 } },
  { "op": "set", "name": "Text1", "props": { "Text": "" } },
  { "op": "delete", "name": "Label1" },
  { "op": "form", "props": { "Caption": "Login" } } ],
  "code": "Private Sub cmdOK_Click()\n    MsgBox \"Hei \" & Text1.Text\nEnd Sub" }
```

- `parseFormOps` er tolerant (Review Focus 2):
  - **Rensing:** `stripThinking` og kodegjerder fjernes. Det ytterste `{…}` brukes. Kommaer til slutt i lister og `//`-kommentarer fjernes før `JSON.parse`.
  - **Typenavn:** aliasene `Button`/`cmd` → CommandButton, `Text`/`Edit` → TextBox, `Lbl` → Label, `Checkbox` → CheckBox, `RadioButton`/`Radio`/`Option` → OptionButton, `GroupBox` → Frame, `List` → ListBox, `Combo`/`DropDown` → ComboBox, `Picture` → PictureBox, `Progress` → ProgressBar. Store og små bokstaver spiller ingen rolle.
  - **Navn:**
    - Egenskapsnavn slås opp med `getPropDef`. `Name` i `props` brukes som navn.
    - `Command1(2)` i `name` blir `index` 2.
    - Mangler navnet, brukes `nextDefaultName`.
    - Et navn som finnes fra før ved `add` gir nytt navn og varselet `Renamed cmdOK to cmdOK1 because the name was taken.`.
  - **Varsler og hopp over:**
    - Ukjent egenskap: `Ignored unknown property Foo on CommandButton.`
    - Ugyldig verdi: `Ignored invalid value for Left on cmdOK.`
    - Ukjent type: `Ignored unknown control type Slider.`
    - `set` eller `delete` på en kontroll som ikke finnes: `Ignored change to missing control Label9.`
  - **Piksler:** har en `add` både `Width` og `Height` under 60, ganges all geometri i den med 15, og varselet er `Sizes for cmdOK looked like pixels and were converted to twips.`.
  - **Kode:** `code` bruker `applyCodeProposal` mot skjemakoden.
  - **Ingenting brukbart:** ingen gyldige ops og ingen kode gir `{ ok: false, error: 'The AI answer could not be understood. Try again or rephrase.', raw }`.
- Forhåndsvisningen er dialogen `AI Suggestion` med:
  - til venstre: listen fra `describeOps` og varslene i grått
  - til høyre: en skrivebeskyttet gjengivelse av `applyFormOpsToClone`, skalert til maks 320 px bred
  - knappene `OK` og `Cancel`
- OK gir `ide.stack.execute(formOpsToCommand(…))`, og Edit → Undo angrer alt i ett steg.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('valid ops parsed', () => { const r = parseFormOps(sampleReply, form); expect(r.ok && r.ops.map(o => o.op)).toEqual(['add', 'set', 'delete', 'form']); });
test('fenced json with trailing comma and thinking', () => expect(parseFormOps('<think>x</think>```json\n{"ops":[{"op":"add","type":"button","props":{"Caption":"OK",}},]}\n```', form).ok).toBe(true));
test('alias and default name', () => { const r = parseFormOps('{"ops":[{"op":"add","type":"RadioButton"}]}', form) as any; expect(r.ops[0]).toMatchObject({ type: 'OptionButton', name: 'Option1' }); });
test('unknown prop warns', () => expect((parseFormOps('{"ops":[{"op":"add","type":"Label","props":{"Foo":1}}]}', form) as any).warnings).toContain('Ignored unknown property Foo on Label.'));
test('pixels converted', () => { /* Width 80, Height 30 → 1200, 450 + varsel */ });
test('garbage is not understood', () => expect(parseFormOps('Jeg kan ikke det.', form)).toEqual({ ok: false, error: 'The AI answer could not be understood. Try again or rephrase.', raw: 'Jeg kan ikke det.' }));
test('one undo step including code', () => { /* execute(formOpsToCommand) → kontroller + kode endret; stack.undo() → begge tilbake */ });
test('control array name parsed', () => { /* name "Command1(2)" → index 2 */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ai): form mode ops, preview, single undo`.

### Oppgave 6: Ask AI-dialogen og flyten

**Filer:** Opprett `src/ai/askDialog.ts`. Endre `src/ide/menus.ts` (Tools → Ask AI... Ctrl+I) og `src/ide/codeWindow.ts`: legg til «Ask AI...» i høyreklikkmenyen. Test: `tests/ai/askFlow.test.ts`

**Grensesnitt:**
- Produserer `askAi(ide: IdeState, backend: Backend, ui: { codeWindowFor(itemId: string): CodeWindow | null }): Promise<void>`.
- Flyten:
  1. **Modus:**
     - `ide.mode` er ikke `design`: ingenting skjer, siden menypunktet er deaktivert.
     - `activeView` er `code`: kodemodus.
     - `activeView` er `designer`: skjemamodus.
     - Ellers vises meldingen `Open a form or a code window first.`.
  2. **Mangler AI-oppsett:** er `settings.model` tom, vises `Set up the AI server first in Tools > Options > AI.` og Options åpnes på AI-fanen.
  3. **Dialogen:** tittelen er `Ask AI - Form1 (Code)` eller `Ask AI - Form1 (Form)`, med et tekstfelt over flere linjer og knappene `OK` (Ctrl+Enter) og `Cancel`.
  4. **Venting:**
     - Dialogen viser `Waiting for {model}...` og en ProgressBar som går fram og tilbake i Win98-stil, med knappen `Cancel`.
     - Cancel lukker dialogen, og svaret som kommer etterpå blir forkastet.
  5. **Feil fra backend:** `messageBox98` med teksten (vbExclamation).
  6. **Kodemodus:**
     - `extractCode` og `applyCodeProposal` brukes med prosedyren der markøren står.
     - Gir de `null`, vises dialogen `The AI answer could not be understood. Try again or rephrase.` med knappene `OK` og `Details...`. Details viser hele svaret i et skrivebeskyttet tekstfelt.
     - Ellers vises forhåndsvisningen. OK gir `codeWindow.applyChange(0, len, nyKilde)` som én transaksjon.
  7. **Skjemamodus:** `parseFormOps`. Ved feil vises samme dialog som over, og ellers forhåndsvisningen. OK kjører kommandoen.

- [ ] **Steg 1: Skriv de feilende testene** med falsk backend og jsdom.

```ts
test('no view → message', async () => { /* activeView none → 'Open a form or a code window first.' */ });
test('missing model → setup message', async () => { /* model '' → melding + options åpnet på AI */ });
test('code mode happy path applies one transaction', async () => { /* aiChat → ```vb …``` ; OK i preview → applyChange kalt én gang */ });
test('cancel while waiting discards reply', async () => { /* aiChat løses etter Cancel → ingen preview, ingen endring */ });
test('backend error shown', async () => { /* aiChat kaster 'The AI server did not answer within 180 seconds.' → messageBox med teksten */ });   // Review Focus 2
test('garbage reply shows details and changes nothing', async () => { /* aiChat → 'Hmm.' → dialog med Details; prosjekt uendret */ });  // Review Focus 2
test('form mode happy path is one undo step', async () => { /* … stack.undo() fjerner alt */ });
test('disabled during run', () => { /* mode 'run' → menypunktet enabled() false */ });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
- [ ] **Steg 4: Kjør `npm test`.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(ai): Ask AI dialog and flow`.

### Oppgave 7: Manuell test mot ekte Ollama/Qwen

- [ ] **Steg 1:** Sett opp Ollama på den andre PC-en med `OLLAMA_HOST=0.0.0.0` og hent en Qwen-kodemodell (for eksempel `qwen2.5-coder`).
- [ ] **Steg 2:** I VibeBasic (`npm run tauri dev` eller den bygde appen): Tools → Options → AI, skriv `http://<IP>:11434/v1` og trykk Test Connection. Modellen skal vises i listen. Velg den.

  macOS spør første gang om tilgang til lokalt nettverk. Svar Tillat.
- [ ] **Steg 3: Skjemamodus.** I designeren for et tomt Form1, skriv: «Lag et innloggingsvindu med navn, passord og en OK-knapp som viser en MsgBox med navnet.» Forhåndsvisningen skal vise kontrollene og koden. Trykk OK og så F5, og sjekk at det virker. Trykk Ctrl+Z, og alt skal forsvinne.
- [ ] **Steg 4: Kodemodus.** Stå i `Command1_Click` og skriv: «Tell fra 1 til 100 og vis det i ProgressBar1, med DoEvents.» Forhåndsvisningen skal vise endringen. Trykk OK og F5.
- [ ] **Steg 5: Feiltilfeller.** Skriv feil IP og sjekk at feilmeldingen er lesbar. Stopp Ollama midt i et svar og sjekk at det gir en feilmelding og ingen endring.
- [ ] **Steg 6: Noter resultatet,** inkludert hvilke modeller som fungerte godt, under «Verifisert» nederst i denne planen. Commit med meldingen `docs(ai): verified against Ollama`.
