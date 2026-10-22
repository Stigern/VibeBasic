# VibeBasic: designdokument

Dato: 2026-10-22
Status: utkast til godkjenning

## 1. Hva og hvorfor

VibeBasic er en kopi av Visual Basic 6.0 for Mac. Den skal se ut og føles som den gamle VB6 fra 1998: du tegner vinduer med knapper og tekstbokser (WYSIWYG), skriver enkel BASIC-kode bak dem, trykker F5 for å kjøre, og lager til slutt en egen app du kan gi til andre.

Hvorfor: brukeren savner den enkle måten å lage programmer på. Du ser nøyaktig hvordan vinduet blir mens du tegner det, og språket er så enkelt at man ikke må slå opp ting hele tiden. I tillegg skal VibeBasic ha en innebygd AI-assistent som kan skrive kode og sette opp skjemaer. Den kobles til brukerens egen Qwen-modell via Ollama på en annen PC i nettverket.

Brukeren er primært seg selv, og verktøyet lages for å bygge nye, små programmer.

## 2. Mål

1. **IDE med ekte VB6-utseende.** Grått Windows 98-tema, blå tittellinjer med gradient, 3D-kanter (outset/inset), prikkete rutenett på skjemaet og VB6-menylinje (File, Edit, View, Project, Format, Debug, Run, Help). Valgt av brukeren fra skisse A, «Ekte gammel VB6».
2. **Standard VB6-vinduer i IDE-en:**
   - Toolbox (verktøykasse) til venstre.
   - Skjemadesigner i midten (MDI-område).
   - Project Explorer og Properties-vindu til høyre.
   - Kodevindu med objekt- og hendelseslister øverst (de to nedtrekkslistene i VB6).
   - Immediate-vindu for `Debug.Print`.
3. **Skjemadesigner:**
   - Dra kontroller fra verktøykassen inn på skjemaet.
   - Flytt dem og endre størrelse med de åtte håndtakene, med fest til rutenettet.
   - Merk flere, kopier/lim inn og slett.
   - Dobbeltklikk på en kontroll åpner kodevinduet i standardhendelsen (for eksempel `Command1_Click`).
4. **Kontroller i første versjon:** Form, CommandButton, Label, TextBox (en- og flerlinjet), CheckBox, OptionButton, Frame, ListBox, ComboBox, PictureBox/Image, Timer, HScrollBar/VScrollBar og ProgressBar (fra Common Controls). Hver kontroll har de vanligste VB6-egenskapene (Name, Caption/Text, Left, Top, Width, Height, Enabled, Visible, BackColor, ForeColor, Font, TabIndex og så videre) og de vanligste hendelsene (Click, DblClick, Change, GotFocus, LostFocus, KeyPress, KeyDown, MouseDown, MouseMove, MouseUp, Timer, Form_Load, Form_Unload, Form_Resize).
   **Kontrollmatriser** (`Command1(0)`, `Command1(1)` …, med `Index` i hendelsene, for eksempel `Sub Command1_Click(Index As Integer)`) er med i første versjon. Når du kopierer og limer inn en kontroll, spør VibeBasic som VB6: «You already have a control named 'Command1'. Do you want to create a control array?» Claudes valg: dette brukes mye i enkle programmer som kalkulatorer og knappenett, og det er dyrt å legge til senere.
5. **Språk:** et VB6-lignende BASIC (se kap. 6).
6. **Kjøring i IDE-en:** F5/Run starter programmet i egne vinduer. Stop avslutter, og Pause/Break (Ctrl+Break) stopper programmet midlertidig. Kjøretidsfeil vises som VB6-feildialog («Run-time error '13': Type mismatch»), med valgene End og Debug. Debug hopper til linjen i kodevinduet og markerer den gult.

   **Break-modus** (Claudes valg): etter Debug eller Pause står programmet stille, men lever fortsatt. I Immediate-vinduet kan du skrive `? x` eller kjøre setninger mot variablene i prosedyren som står stille, og fortsette med F5. Å endre koden mens programmet står stille og så fortsette (edit-and-continue) kommer senere. Tolken må derfor fra starten kunne pause og fortsette midt i en prosedyre, og la deg se på variablene i den. Dette trengs uansett for `DoEvents`, MsgBox og senere brytpunkter.
7. **Make app:** File → Make Project1.app… lager en selvstendig Mac-app (.app) som kan gis til andre, med eget navn og ikon (valgfritt). Appen ser ut som skjemaene i designeren, altså i VB6-stil.
8. **Lagre/åpne prosjekter** i VibeBasics eget format, med flere skjemaer per prosjekt og et oppstartsskjema.
9. **AI-assistent** (se kap. 7).

## 3. Ikke-mål

- Åpne, importere eller kjøre gamle VB6-prosjekter (.vbp/.frm/.bas). Brukeren skal bare lage nye ting.
- Windows eller Linux. Både IDE-en og appene du lager trenger bare å kjøre på Mac.
- Full VB6-språkkompatibilitet. COM, ActiveX/OCX, `Declare` (DLL-kall), DAO/ADO, DDE, OLE og andre Windows-spesifikke ting er utelatt.
- C# som språk i første versjon. Brukeren nevnte C# som et akseptabelt alternativ, men BASIC er valgt. Det kan vurderes senere.
- Kompilering til maskinkode. Appene kan kjøre koden via en innebygd tolk.

## 4. Anti-mål (ting som gjør det mislykket selv om det teknisk virker)

- At det ser moderne ut, eller «Mac-aktig». Brukeren valgte bevisst det ekte Windows 98-utseendet framfor Mac-varianten.
- At arbeidsflyten avviker fra VB6: tegne, dobbeltklikke, skrive kode, F5. En VB6-bruker skal kjenne seg igjen uten forklaring.
- At AI-en krever skytjeneste eller API-nøkkel. Den skal fungere mot en lokal Ollama i nettverket.
- At AI-en endrer prosjektet uten at brukeren ser hva som skjer.

## 5. Teknisk retning

**Dette er Claudes valg. Brukeren overlot valget og sa «greit».**

- **Plattform:** Tauri 2 (Rust-skall og systemets WKWebView) med TypeScript-frontend. Begrunnelse:
  - Windows 98-utseendet er enkelt og nøyaktig i HTML/CSS. Biblioteket 98.css (MIT) kan brukes som utgangspunkt.
  - Tolken skrives i samme språk som resten.
  - Ferdige apper blir små, noen få MB.
- **IDE og runtime deler kode.** Den samme kontroll-renderingen og den samme tolken brukes både når du trykker F5 og i ferdige apper, så programmet oppfører seg likt begge steder.
- **Make app** skal ikke kreve Rust, Xcode eller andre utviklerverktøy på brukerens maskin. Anbefalt løsning:
  - VibeBasic har med seg en ferdigbygd «runtime-app» (Tauri) inni seg.
  - Make kopierer den, legger prosjektet inn i appens Resources og setter navn, bundle-id og ikon i Info.plist.
  - Til slutt kjøres en ad-hoc kodesignering (`codesign -s -`).
  - Mottakere må høyreklikke → Åpne første gang (Gatekeeper). Det er akseptabelt.
- **AI-trafikken går via Rust-siden** (Tauri-kommando eller HTTP-plugin), ikke via `fetch` i webview. Ollama på en annen PC nås over vanlig `http://<ip>:11434`, og det ville ellers stoppet på CORS og blandet innhold.
- **Font:** MS Sans Serif finnes ikke på Mac. Bruk en fritt lisensiert pikselfont som ligner, eller den som følger med 98.css. Byggeren velger, men lisensen må tillate at fonten følger med appene.
- **Enheter:** egenskapene Left/Top/Width/Height vises i twips som i VB6 (1 piksel = 15 twips). Det gir autentisk følelse, og AI-modeller som kan VB6 vil bruke twips. Claudes valg.

## 6. Språket (VibeBasic BASIC)

Målet er at typisk kode for enkle skjemaprogrammer, av den typen man finner i nybegynnerbøker om VB6, skal kjøre uendret. Omfanget er listen under. Det som ikke står her, er ikke med i første versjon (Claudes valg; brukeren ønsket «noe helt simpelt»). Første versjon skal ha:

- **Deklarasjoner:**
  - `Dim`, `Private`, `Public`, `Const`, `Option Explicit`.
  - Typer: Integer, Long, Single, Double, String, Boolean, Variant, Date.
  - Faste og dynamiske arrays, med `ReDim [Preserve]`, `LBound` og `UBound`.
  - `Static`-variabler, `Enum` og brukerdefinerte typer (`Type…End Type`).
  - Standardegenskaper: `Text1 = "x"` betyr `Text1.Text`, og `Label1 = "x"` betyr `Label1.Caption`.
  - Klassemoduler (.cls), `New`, `Set` på egne objekter og navngitte argumenter (`x:=1`) er ikke med i første versjon. De legges i fase 6.
- **Kontrollflyt:**
  - `If…Then…ElseIf…Else…End If`, inkludert enlinjet If.
  - `Select Case` med `Is`, `To` og lister.
  - `For…Next` med `Step` og `For Each`.
  - `Do…Loop` (`While`/`Until`, før og etter), `While…Wend`.
  - `Exit For/Do/Sub/Function`.
- **Prosedyrer:**
  - `Sub` og `Function` med `ByVal`/`ByRef`, `Optional`, retur via funksjonsnavnet og `Call`.
  - Moduler (.bas-lignende) med felles kode.
- **Operatorer:** `+ - * / \ Mod ^ &`, sammenligninger, `And Or Not Xor`, `Like` (enkelt).
- **Innebygde funksjoner:**
  - Tekst: Len, Left, Right, Mid, InStr, Replace, UCase, LCase, Trim/LTrim/RTrim, Space, String, Chr, Asc, Split, Join.
  - Konvertering: Str, Val, CStr, CInt, CLng, CDbl, CBool, Format (vanlige mønstre).
  - Tall og tid: Int, Fix, Abs, Rnd, Randomize, Round, Sqr, Now, Date, Time, Timer.
  - Typesjekk: IsNumeric, IsEmpty.
- **Dialoger:** `MsgBox` med knapper, ikon og returverdi (vbYes og så videre) og `InputBox`, i VB6-stil.
- **Skjema og objekter:**
  - `Me`, `Form2.Show`, `.Hide`, `Unload Me`, `End`.
  - Tilgang til kontroller via `Text1.Text`, `ProgressBar1.Value` og så videre, og `With…End With`.
- **Feilhåndtering:** `On Error Resume Next`, `On Error GoTo label`, `Err.Number` og `Err.Description`, `Resume`.
- **`DoEvents`:** en løkke som oppdaterer en ProgressBar skal vise fremgangen, som i VB6.
- **Feilmeldinger:** VB6-feilnummer og VB6-tekster for vanlige feil, som 6 Overflow, 9 Subscript out of range, 11 Division by zero, 13 Type mismatch og 91 Object variable not set.
- **Kodevinduet:**
  - Syntaksfarger som i VB6: blå nøkkelord, grønne kommentarer.
  - Automatisk store forbokstaver i nøkkelord (`dim` → `Dim`).
  - Syntakssjekk når du forlater linjen, med rød linje og meldingsboks.
  - Enkel autofullføring av kontrollnavn og egenskaper etter punktum (IntelliSense-liste) er ønskelig.

Fil-I/O (`Open … For Input/Output`, `Print #`, `Line Input #`) og en meny-editor (Ctrl+E) er ønskelig. De kan komme i en senere fase, se kap. 9.

**Bilder og grafikk** (Claudes valg):
- Første versjon: PictureBox og Image kan vise bilder. Egenskapen Picture velges i Properties og lagres inne i prosjektet, og `LoadPicture("fil")` virker i kjøretid. Make app tar med bildene. Prosjektformatet må derfor kunne ha med binærfiler (bilder og ikon).
- Fase 6: tegnemetoder på Form og PictureBox (`Line`, `Circle`, `PSet`, `Cls`, `Print`, `AutoRedraw`). Form og PictureBox bør likevel bygges slik at et tegnelag (canvas) kan legges til uten omskriving.

## 7. AI-assistenten

- **Tilkobling:**
  - Et innstillingsvindu (Tools → Options… → AI) med adresse til et OpenAI-kompatibelt API (for eksempel `http://192.168.1.50:11434/v1` for Ollama), modellnavn (for eksempel `qwen2.5-coder`) og valgfri API-nøkkel.
  - En «Test tilkobling»-knapp.
  - Det skal også virke mot ekte OpenAI og andre kompatible tjenester.
- **Åpnes** fra et «Ask AI»-vindu i samme grå VB6-stil, med menypunkt og hurtigtast.
- **Kontekstavhengig.** Bestemt av brukeren:
  - **I kodevinduet:** AI-en skriver eller endrer koden der markøren står, typisk i prosedyren du er i (for eksempel `Command1_Click`). Den får vite hvilke kontroller og egenskaper som finnes på skjemaet, så den bruker riktige navn.
  - **I skjemavisningen:** AI-en kan legge til, flytte og endre kontroller og sette egenskaper. Eksempel: «lag et innloggingsvindu med navn, passord og OK-knapp». Den kan også lage tilhørende hendelseskode.
- **Bekreftelse:**
  - AI-en viser forslaget først (kodeendring som før/etter, eller skjemaendring som forhåndsvisning eller liste), og brukeren trykker OK eller Avbryt.
  - Det som godtas kan alltid angres med Ctrl+Z, i ett steg.
  - Claudes valg: brukeren svarte «ja det høres lurt ut» på et spørsmål med to alternativer, og det ble tolket som «vis først».
- **Stabilt format.** AI-en må få svar tilbake i et format VibeBasic kan bruke trygt. For skjemaer betyr det en strukturert liste over endringer som valideres mot kjente kontrolltyper og egenskaper, ikke fri tekst. Små lokale modeller (Qwen via Ollama) må fungere, så formatet skal være enkelt og tåle litt slurv.

## 8. Prosjektformat

Claudes valg, detaljene overlates til byggeren:

- Ett prosjekt er en mappe eller fil med lesbar tekst, slik at den kan versjonskontrolleres.
- Prosjektet inneholder skjemadefinisjoner (kontroller og egenskaper), koden for hvert skjema, moduler og prosjektinnstillinger (navn, oppstartsskjema og ikon).
- Filendelse for eksempel `.vbproj`/`.vbb`. Det skal ikke være kompatibelt med VB6-filer.

## 9. Faser (forslag)

1. **Skall og utseende:** Tauri-app, VB6-hovedvindu med menyer, verktøylinje, Toolbox, Project Explorer og Properties (statisk).
2. **Skjemadesigner:** plassere, flytte og endre størrelse på kontroller, Properties-vinduet koblet til, lagre/åpne prosjekt.
3. **Språk og kjøring:** tolk, kodevindu, hendelser, F5, MsgBox/InputBox, kjøretidsfeil med Debug-hopp, Immediate-vindu.
4. **Make app:** runtime-app, pakking og signering.
5. **AI-assistent:** innstillinger, kodemodus, skjemamodus, forhåndsvisning og angre.
6. **Senere:** brytpunkter og trinnvis kjøring (F9/F8), edit-and-continue, meny-editor, fil-I/O, tegnemetoder, klassemoduler, flere kontroller, eventuelt C#.

Byggeren kan endre rekkefølgen. Én ting er Claudes anbefaling: språk og kjøring (fase 3) bør bli solid før AI-delen, fordi AI-en skriver kode som må kjøre.

## 10. Overlatt til byggeren

- Intern arkitektur for tolken: tre-gjennomgang, bytekode eller oversettelse til JS. Den må kunne pause for `DoEvents`, timere og MsgBox uten å fryse brukergrensesnittet.
- Valg av editor-komponent for kodevinduet (for eksempel CodeMirror med VB6-tema) og testrammeverk.
- Nøyaktig liste over egenskaper og hendelser per kontroll, ut over minimum i kap. 2.
- Detaljer i prosjektformatet og i AI-promptene og -svarformatet.
- Hvordan ikoner og grafikk i verktøykassen lages, med krav om at de ligner VB6.
