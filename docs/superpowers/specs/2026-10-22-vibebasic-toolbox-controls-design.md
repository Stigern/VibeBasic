# VibeBasic: utvidet verktøykasse, design

Dato: 2026-10-22. Bygger på hoveddesignet i [2026-10-22-vibebasic-design.md](2026-10-22-vibebasic-design.md).

## Hvorfor

Brukeren vil lage mer avanserte programmer enn de 15 kontrollene tillater, og vil ha den kjente VB6-opplevelsen der verktøykassen kan flyttes og gjøres bredere.

## Mål

1. **Verktøykassen kan flyttes og justeres.**
   - Den er dokket til venstre som standard.
   - Drar du tittellinjen, blir den et flytende Win98-vindu som kan ligge hvor som helst i IDE-vinduet.
   - Dobbeltklikk på tittellinjen dokker den til venstre igjen.
   - Bredden justeres ved å dra i høyre kant (eller i kanten på det flytende vinduet). Ikonene fyller så mange kolonner som får plass, minst 2.
   - Posisjon, dokk-tilstand og bredde huskes mellom hver gang VibeBasic startes, via `saveSettings('toolbox', …)`.
2. **14 nye kontroller** med VB6-navn på egenskaper, metoder, hendelser og konstanter, i designer, Properties, kjøring, IntelliSense og AI-beskrivelse. Det siste kommer automatisk fra registeret.

| Gruppe | Kontroll | Det viktigste (VB6) |
|---|---|---|
| VB6-standard | Shape | Shape (0 Rectangle, 1 Square, 2 Oval, 3 Circle, 4 Rounded Rectangle, 5 Rounded Square), FillStyle, FillColor, BackStyle, BackColor, BorderColor, BorderWidth, BorderStyle. Ingen hendelser. |
| | Line | X1, Y1, X2, Y2, BorderColor, BorderWidth, BorderStyle. Ingen Left, Top, Width eller Height. I designeren dras den i endepunktene. Ingen hendelser. |
| | DriveListBox | Drive. Change. Viser Macens volumer: «/» som oppstartsdisken, og /Volumes/*. |
| | DirListBox | Path, ListCount, List(i), ListIndex. Change og Click. Viser mappetreet som VB6 (stien med åpnede mapper over undermappene). |
| | FileListBox | Path, Pattern («*.*», «*.txt;*.bas»), FileName, ListCount, List(i), ListIndex, Archive, Hidden, Normal. Click, DblClick og PathChange. |
| Common Controls | Slider | Min, Max, Value, SmallChange, LargeChange, TickFrequency, TickStyle, Orientation. Change og Scroll. |
| | UpDown | Min, Max, Value, Increment, Wrap, Orientation. Change, UpClick og DownClick. |
| | StatusBar | Style (sbrNormal, sbrSimple), SimpleText, Panels-samling (Add, Remove, Clear, Item; Panel.Text, Width, Alignment, Key). Legger seg nederst på skjemaet. Click og PanelClick(Panel). |
| | TabStrip | Tabs-samling (Add, Remove, Clear, Item; Tab.Caption, Key, Index), SelectedItem. Click. Ikke en container, som i VB6. Programmet viser og skjuler selv Frames når fanen byttes. |
| Lister og trær | TreeView | Nodes-samling: Add(Relative, Relationship, Key, Text) med tvwChild, tvwFirst, tvwLast, tvwNext og tvwPrevious. Node har Text, Key, Expanded, Parent, Child, Children, Next, Index, Selected og Tag. SelectedItem, LineStyle, Indentation. NodeClick(Node), Expand(Node) og Collapse(Node). |
| | ListView | View (lvwIcon, lvwSmallIcon, lvwList, lvwReport), ColumnHeaders-samling (Add(, Key, Text, Width)), ListItems-samling (Add(, Key, Text); ListItem har Text, Key, SubItems(i), Selected og Tag), SelectedItem, FullRowSelect, GridLines, Sorted, SortKey og SortOrder. ItemClick(Item), ColumnClick(ColumnHeader) og DblClick. |
| | MSFlexGrid | Rows, Cols, FixedRows, FixedCols, Row, Col, Text, TextMatrix(r, c), ColWidth(c), RowHeight(r), ColAlignment(c), GridLines og SelectionMode. Click, DblClick, RowColChange og SelChange. Kan ikke redigeres direkte, som i VB6. |
| Dialoger og tekst | CommonDialog | Usynlig i kjøring. Metodene ShowOpen og ShowSave bruker Macens egne fildialoger, og ShowColor og ShowFont bruker VibeBasics Win98-dialoger. Egenskaper: FileName, FileTitle, Filter («Tekst (*.txt)\|*.txt»), FilterIndex, DialogTitle, InitDir, Color, FontName, FontSize, FontBold, FontItalic og CancelError (gir feil 32755 «Cancel was selected» ved Avbryt). |
| | RichTextBox | Text, SelStart, SelLength, SelText, SelBold, SelItalic, SelUnderline, SelColor, SelFontName, SelFontSize, Locked, MultiLine (alltid sann) og ScrollBars. Change og SelChange. Bygget på et redigerbart felt. TextRTF, LoadFile og SaveFile er ikke med. |

- **Samlinger** (Nodes, ListItems, ColumnHeaders, Tabs, Panels) får én felles samlingsklasse i kjøringen. Den har Add, Remove(indeks eller nøkkel), Clear, Count og Item(indeks eller nøkkel), og virker med For Each. Indeksene starter på 1, som i VB6.
- **Konstantene** legges til i språkkjernen: tvw*, lvw*, sbr*, cdl* (cdlOFNFileMustExist og så videre der det gir mening) og vbShape*-verdiene som tall.
- **Verktøykasse-ikonene** er egne SVG-er i VB6-stil.

## Ikke-mål

- Fil-I/O i språket (`Open`, `Print #`). Filkontrollene og CommonDialog gir filnavn, men lesing og skriving av filer kommer senere.
- Bilder i TreeView og ListView (ImageList), RTF-format, utskrift (ShowPrinter) og hjelp (ShowHelp, som gir feil 438).
- Andre kontroller enn de 14 over.

## Begrensninger

- **Filtilgang:** VibeBasic må få to nye Rust-kommandoer, `list_volumes` og `list_dir(path)`. Den siste gir mapper og filer, med skjulte filer markert. Ingen andre filoperasjoner er tillatt.
- **Ferdige apper** (Make app) må også kunne bruke filkontrollene og CommonDialog. Rettighetene for skjemavinduene utvides tilsvarende.
- **Gammel kode:** alt som virker i dag, skal virke uendret, inkludert gamle prosjektfiler uten de nye kontrollene.

## Overlatt til byggeren

- Detaljer i tegning og CSS, så lenge det ser ut som VB6 under Windows 98.
- Oppdelingen i filer, med samme mønster som de eksisterende kontrollene.
- Hvor mye av hver kontroll som testes. Brukeren vil holde tokenbruken nede.
