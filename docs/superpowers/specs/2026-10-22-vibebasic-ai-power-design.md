# VibeBasic: kraftigere AI-verktøy, design

Dato: 2026-10-22. Bygger på AI-delen av [2026-10-22-vibebasic-design.md](2026-10-22-vibebasic-design.md) og på plan 05.

## Hvorfor

Brukeren koder med sin lokale Qwen (vLLM på AIComputer, 192.168.1.184, modellen `qwen38-27b`) og vil at AI-verktøyet skal bli raskere, gi bedre kode og hjelpe med feilsøking: «gjør AI-verktøyet kraftigere». Brukeren valgte alle fire forbedringene under.

Det vi vet om oppsettet:
- Serveren tar to forespørsler samtidig (`--max-num-seqs=2`) og har prefix caching på (`--enable-prefix-caching`). Det betyr at en lik begynnelse på prompten blir gjenbrukt og ikke regnet ut på nytt.
- Med høy tenking tar svarene 45–76 sekunder.
- Qwen skriver som regel gyldig VB, men gjør tre typer feil:
  - Den bruker ting som ikke finnes i VibeBasic.
  - Den bruker feil hendelsesnavn. Dette er allerede rettet.
  - Den bruker egenskaper som ikke finnes, for eksempel `Label1.Text`.

## Mål

### 1. Feilsøking med AI

- **Kjøretidsfeil i IDE-en:** feildialogen får en ekstra knapp, **Ask AI**, mellom Debug og Help. Ellers ser dialogen ut som i VB6.
  1. Knappen går først i break-modus på feillinjen, akkurat som Debug, og starter så AI-flyten.
  2. Qwen får:
     - feilnummer og beskrivelse,
     - linjen og prosedyren der feilen skjedde,
     - verdiene til de lokale variablene og modulvariablene, med korte verdier og lange strenger avkortet,
     - beskrivelsen av skjemaet,
     - koden.
  3. Forslaget vises i den vanlige diff-forhåndsvisningen.
  4. Trykker du OK, stoppes programmet (End) og rettingen legges inn som ett angre-steg. Brukeren trykker selv F5 igjen. Rediger-og-fortsett er ikke med.
- **Kompileringsfeil:** dialogen får også **Ask AI**. Da sendes feilen, linjen og koden, men ingen variabler.
- **I break-modus** etter en feil: «Ask AI about this error» i Tools-menyen gjør det samme som knappen. Den er bare aktiv når programmet står stoppet på en feil.
- **Ferdige apper** (Make app) får aldri AI-knappen.

### 2. Smartere kontroll av koden

Kontroll-og-rett-løkken fra plan 05 utvides. Hver regel finner et konkret problem som sendes tilbake til Qwen i den ene nye runden:

- **Ukjent egenskap eller metode** på en kjent kontroll. Eksempel: «A Label has no Text property. Did you mean Caption?». Forslaget hentes fra en liten tabell over vanlige forvekslinger, eller fra navnet i registeret som ligner mest.
  - Bare `Kontroll.Medlem` og `Me.Kontroll.Medlem` sjekkes, ikke lengre kjeder.
- **Ukjent navn foran et punktum:** ikke en kontroll, et skjema, en modul, en variabel eller et innebygd objekt (App, Screen, Err, Debug, Clipboard, Forms, Me).
- **Udeklarerte variabler** når modulen har `Option Explicit`. Samme regler som når programmet kjøres, så det sjekkeren sier og det F5 sier stemmer overens.
- **Funksjoner og setninger som ikke finnes i VibeBasic** (SaveSetting, GetSetting, Open, Print #, Declare og så videre): «X is not supported in VibeBasic» pluss et forslag til alternativ der det finnes.
- **Skjemamodus:** JSON som ikke kan leses, gir også én ny runde med feilmeldingen, i stedet for å gå rett til «could not be understood».
- Det blir fortsatt bare én ny runde, så ventetiden ikke dobles mer enn én gang.
- Står det fortsatt problemer igjen, vises de over forhåndsvisningen som i dag.

### 3. Fortsett samtalen

- Forhåndsvisningen (både kode og skjema) får knappen **Change...**. Den åpner en liten tekstboks: «What should be changed?»
  - Det nye ønsket sendes med hele samtalen så langt: system, spørsmål, svar og nytt ønske.
  - Det nye forslaget erstatter det gamle i forhåndsvisningen. Ingenting legges inn i prosjektet før OK.
- Samtalen bare vokser bakover. Ingenting skrives om, så serverens prefix caching gjenbruker alt som er sendt før, og runde to blir rask.
- Samtalen lever til OK eller Cancel. Ikke noe chat-vindu og ingen lagret historikk.
- Hvis samtalen nærmer seg et tak (se mål 4), fjernes de eldste mellomrundene. Første spørsmål og siste forslag blir alltid med.

### 4. Raskere og billigere prompt

- **Fast begynnelse:**
  - Systemprompten (regler, kontrolltyper og eksempler) er identisk byte for byte mellom forespørsler. Ingen dato, ingen tilfeldig rekkefølge, ingenting fra prosjektet.
  - I brukermeldingen kommer det som endrer seg sjeldnest først: skjemabeskrivelse, så kode, så feil og verdier, og til slutt ønsket.
- **Korte eksempler:** systemprompten får to-tre korte VB6-eksempler i VibeBasic-dialekten, for eksempel én hendelsesprosedyre og én funksjon. De viser stilen og viser hvordan man unngår de vanligste feilene (Caption og Text, Form_Load, ingen fil-I/O). Hold det til rundt 15 linjer.
- **Store moduler:**
  - Er koden over et tak (forslag: 400 linjer, Claudes valg), sendes bare deklarasjonene, hele den gjeldende prosedyren, hele prosedyrene som den kaller eller som nevnes i ønsket, og bare overskriftene (`Private Sub X(...)`) til resten.
  - Feilsøking sender prosedyren med feilen pluss de som kaller den.
- **Synlig måling:** ventedialogen og forhåndsvisningen viser én kort linje, for eksempel «3 210 prompt tokens (2 900 cached) · 41 s».
  - Tallene kommer fra `usage` i svaret (`stream_options.include_usage`).
  - Sender serveren ikke tallene, vises bare tiden.

## Ikke-mål

- Tool calling og funksjonskall mot serveren. Fri tekst med kontroll virker godt nok.
- Endringer i flere filer eller skjemaer om gangen, eller en AI som går gjennom hele prosjektet.
- Rediger-og-fortsett i break-modus.
- Å legge SaveSetting, GetSetting eller fil-I/O inn i språket. Det kan bli en egen sak senere.
- Et chat-vindu eller lagret samtalehistorikk.

## Begrensninger

- Alt som virker i dag skal virke uendret. Det gjelder også innstillinger og tenkenivå.
- Alt skal fortsatt ha én angring. Ingenting legges inn uten OK i forhåndsvisningen.
- Repoet er offentlig. Ingen nøkler eller IP-adresser legges i kode eller tester.
- Feilsøkingsdelen berører kjørekoden (feildialog, break-modus og verdier av variabler). Den bygges etter plan 06 oppgave 5 for å unngå konflikter. Del 2–4 er bare i `src/ai` og kan gå parallelt.

## Overlatt til byggeren

- Nøyaktige tak (linjer og tegn) og hvordan verdier avkortes.
- Teksten i meldingene til Qwen, så lenge den er kort og konkret.
- Hvordan Change...-boksen og målelinjen ser ut, så lenge de ligner Win98.
- Versjonen blir 0.7.0, med en oppføring i CHANGELOG.md.
