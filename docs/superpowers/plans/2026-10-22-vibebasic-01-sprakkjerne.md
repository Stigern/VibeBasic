# VibeBasic plan 01: Språkkjerne

> **For agentiske arbeidere:** PÅKREVD UNDER-FERDIGHET: Bruk superpowers:subagent-driven-development (anbefalt) eller superpowers:executing-plans. Stegene bruker avkrysningsbokser (`- [ ]`).

**Mål:** En VB6-lignende BASIC-tolk i ren TypeScript. Den kjører kode fra skjemaer og moduler, kan pause (DoEvents, dialoger og break-modus) og gir VB6-feilnumre og -tekster.

**Arkitektur:** Lexer → parser (AST) → tre-gjennomgående tolk der hver setning kjøres som en generator (`function*`). En driver kjører generatoren. Den venter på promises som yieldes (dialoger, DoEvents, break) og gir fra seg kontrollen til event-loopen hver `sliceSize` setning. Da fryser ikke brukergrensesnittet, og pause/stopp virker selv i evige løkker. Verten (IDE eller runtime) kobles til via `Host` og `VBObject`.

**Teknologi:** TypeScript, Vitest. Ingen DOM-import i `src/lang/`.

**Spec:** [spec](../specs/2026-10-22-vibebasic-design.md), kap. 2.6 og kap. 6. Felles regler: se [oversikten](2026-10-22-vibebasic-00-oversikt.md).

## Regler for denne planen

- Store/små bokstaver betyr ingenting i nøkkelord og navn. Navn sammenlignes med `toLowerCase()`.
- Tall lagres som JS `number`. Typekontroll (overflow 6, type mismatch 13) skjer når en verdi tilordnes en typet variabel, et typet argument eller en returverdi. Mellomregninger sjekkes ikke. Det er Claudes valg: VB6s `200 * 200`-overflow kopieres ikke.
- Tall til tekst: `CStr`/`&` gir opptil 15 signifikante sifre uten innledende mellomrom (`"0.5"`). `Str`/`Print` gir innledende mellomrom for positive tall og ingen null foran desimaltegnet (`" .5"`). Desimaltegn er alltid `.`.
- `True` = -1, `False` = 0.
- `Asc`/`Chr` bruker Windows-1252: `Chr(230) = "æ"`, `Asc("ø") = 248`, `Chr(128) = "€"`.
- Datoer er `VBDate { kind: 'date', serial: number }` (OLE-dato, dager siden 1899-12-30). `CStr(dato)` og navngitte datoformater bruker `Program`-opsjonen `locale`. Standard er `Intl.DateTimeFormat().resolvedOptions().locale`, og tester bruker `'en-US'`.

## Filer

```
src/lang/tokens.ts        TokenKind, Token, KEYWORDS
src/lang/lexer.ts         tokenize
src/lang/ast.ts           AST-typer + exprToString (for tester)
src/lang/parser.ts        parseModule, parseExpression, findSyntaxErrors
src/lang/errors.ts        VBRuntimeError, VBSyntaxError, vbErrorText
src/lang/values.ts        VBValue, Empty/Null/Nothing, VBArray, VBRecord, VBDate, VBRef, konvertering og sammenligning
src/lang/host.ts          Host, VBObject, BreakInfo
src/lang/interp/program.ts    Program (offentlig API)
src/lang/interp/driver.ts     generator-driver, slicing, pause/stopp
src/lang/interp/exec.ts       setninger
src/lang/interp/eval.ts       uttrykk, navneoppslag, medlemskall
src/lang/interp/scope.ts      Frame, modulscope, globalt scope
src/lang/builtins/index.ts    register: navn → implementasjon
src/lang/builtins/strings.ts | convert.ts | math.ts | datetime.ts | format.ts | constants.ts
src/lang/printFormat.ts   Debug.Print-formatering (; , soner)
src/lang/prettify.ts      prettifyLine, knownIdentifiers
tests/lang/*.test.ts
tests/lang/programs/*.bas + *.out   golden-programmer
tests/lang/testHost.ts    TestHost + runGolden
```

---

### Oppgave 1: Lexer

**Filer:** Opprett `src/lang/tokens.ts`, `src/lang/lexer.ts`. Test: `tests/lang/lexer.test.ts`

**Grensesnitt:**
- Produserer:
  - `type TokenKind = 'keyword' | 'ident' | 'number' | 'string' | 'date' | 'op' | 'newline' | 'colon' | 'comment' | 'eof'`
  - `interface Token { kind: TokenKind; text: string; value?: number | string; line: number; col: number; suffix?: '%' | '&' | '!' | '#' | '$' }` (linje og kolonne er 1-baserte, `text` er originalteksten)
  - `KEYWORDS: ReadonlySet<string>` (små bokstaver)
  - `tokenize(src: string): Token[]`

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
const kinds = (s: string) => tokenize(s).map(t => t.kind);
test('dim statement', () => expect(kinds('Dim x As Integer')).toEqual(['keyword','ident','keyword','keyword','eof']));
test('hex and octal', () => { expect(tokenize('&HFF')[0].value).toBe(255); expect(tokenize('&O17')[0].value).toBe(15); });
test('doubled quotes', () => expect(tokenize('"He said ""hi"""')[0].value).toBe('He said "hi"'));
test('comment and rem', () => { expect(kinds("x = 1 ' hei")).toEqual(['ident','op','number','comment','eof']); expect(tokenize('Rem hei')[0].kind).toBe('comment'); });
test('line continuation joins lines', () => expect(kinds('x = 1 + _\n  2')).toEqual(['ident','op','number','op','number','eof']));
test('colon separates statements', () => expect(kinds('a = 1: b = 2')).toContain('colon'));
test('type suffix', () => expect(tokenize('name$')[0]).toMatchObject({ kind: 'ident', text: 'name$', suffix: '$' }));
test('date literal', () => expect(tokenize('#1/2/2000#')[0].kind).toBe('date'));
test('two-char ops', () => expect(tokenize('a <> b <= c >= d').filter(t => t.kind === 'op').map(t => t.text)).toEqual(['<>','<=','>=']));
test('line numbers', () => expect(tokenize('a\nb')[2]).toMatchObject({ text: 'b', line: 2, col: 1 }));
test('unterminated string', () => expect(() => tokenize('"abc')).toThrow(VBSyntaxError));
```

- [ ] **Steg 2: Kjør** `npx vitest run tests/lang/lexer.test.ts`. Forventet: FAIL (modulen finnes ikke).
- [ ] **Steg 3: Implementer `tokenize`.**
  - `KEYWORDS` dekker alle nøkkelord fra spec kap. 6. Operator-ord (`And Or Not Xor Eqv Imp Mod Like Is New`) er `keyword`.
  - `Debug`, `MsgBox` og funksjonsnavn er `ident`.
  - `VBSyntaxError` (oppgave 4 definerer den, men lag den her i `errors.ts`): `class VBSyntaxError extends Error { line: number; col: number }`.
- [ ] **Steg 4: Kjør testen.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): lexer`.

### Oppgave 2: Uttrykk-parser

**Filer:** Opprett `src/lang/ast.ts`, `src/lang/parser.ts` (uttrykksdelen). Test: `tests/lang/parseExpr.test.ts`

**Grensesnitt:**
- Konsumerer: `tokenize`.
- Produserer:
  - `type Expr = NumberLit | StringLit | DateLit | BoolLit | NothingLit | NameExpr | MemberExpr | CallOrIndex | UnaryExpr | BinaryExpr | WithMemberExpr | NewExpr`. Hver node har `line: number`.
  - `CallOrIndex { kind: 'call'; target: Expr; args: (Expr | MissingArg)[] }`. Det er tvetydig om `a(1)` er et kall eller en indeks, og det avgjøres i kjøretid.
  - `MemberExpr { kind: 'member'; object: Expr; name: string }`.
  - `WithMemberExpr { kind: 'withMember'; name: string }` for `.Text` i en `With`-blokk.
  - `parseExpression(src: string): Expr`.
  - `exprToString(e: Expr): string` gir et S-uttrykk for tester.

- [ ] **Steg 1: Skriv de feilende testene.** Presedens fra høyest til lavest: `^`, unær `-`, `* /`, `\`, `Mod`, `+ -`, `&`, sammenligning (`= <> < > <= >= Like Is`), `Not`, `And`, `Or`, `Xor`, `Eqv`, `Imp`.

```ts
const p = (s: string) => exprToString(parseExpression(s));
test('precedence', () => expect(p('1 + 2 * 3 ^ 2')).toBe('(+ 1 (* 2 (^ 3 2)))'));
test('unary minus below power', () => expect(p('-2 ^ 2')).toBe('(neg (^ 2 2))'));
test('concat below plus', () => expect(p('a & b + c')).toBe('(& a (+ b c))'));
test('int div below mul', () => expect(p('a * b \\ c')).toBe('(\\ (* a b) c)'));
test('not below compare', () => expect(p('Not a = b')).toBe('(not (= a b))'));
test('member chain and call', () => expect(p('Form1.Command1(2).Caption')).toBe('(. (call (. Form1 Command1) 2) Caption)'));
test('missing args', () => expect(p('MsgBox("x", , "t")')).toBe('(call MsgBox "x" <missing> "t")'));
test('named args rejected', () => expect(() => p('f(x:=1)')).toThrow('Named arguments are not supported'));
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer** en presedensbasert rekursiv parser for uttrykk. Den skal kunne gjenbrukes av setningsparseren i oppgave 3.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): expression parser`.

### Oppgave 3: Setninger, moduler og syntaksfeil

**Filer:** Endre `src/lang/parser.ts` og `src/lang/ast.ts`. Test: `tests/lang/parseModule.test.ts`

**Grensesnitt:**
- Produserer:
  - `parseModule(source: string, moduleName: string): ModuleAst`, som kaster den første `VBSyntaxError`.
  - `ModuleAst { name; optionExplicit: boolean; variables: VarDecl[]; consts: ConstDecl[]; types: TypeDecl[]; enums: EnumDecl[]; procedures: ProcDecl[] }`
  - `ProcDecl { kind: 'sub' | 'function'; name; visibility: 'public' | 'private'; params: Param[]; returnType?: VBTypeName; body: Stmt[]; line; endLine }`
  - `Param { name; byRef: boolean; optional: boolean; defaultValue?: Expr; type?: VBTypeName; isArray: boolean }` (`byRef` er standard)
  - `VBTypeName = 'Integer' | 'Long' | 'Single' | 'Double' | 'Currency' | 'String' | 'Boolean' | 'Variant' | 'Date' | 'Byte' | 'Object' | { userType: string } | { objectType: string }` (for eksempel `As TextBox` eller `As Form`)
  - `findSyntaxErrors(source: string, moduleName: string): VBSyntaxError[]`. Etter en feil hopper den til neste linje og fortsetter, og returnerer alle feilene.
  - `checkLineSyntax(line: string): VBSyntaxError | null` sjekker én logisk linje som setning eller setninger uten å kreve at blokker matcher. `If x Then`, `End If` og `Next` alene er gyldige. Kodevinduet bruker den for VB6s «Auto Syntax Check».
  - Setnings-AST-er for alle setninger i spec kap. 6: `Dim/Private/Public/Static/Const/ReDim [Preserve]/Erase`, `If` (blokk og enlinjet), `Select Case` (`Is`, `To`, lister, `Case Else`), `For…Next [var]`, `For Each…In`, `Do [While|Until]…Loop [While|Until]`, `While…Wend`, `Exit For|Do|Sub|Function`, `With`, `On Error Resume Next | GoTo label | GoTo 0`, `Resume | Resume Next | Resume label`, `GoTo`, etiketter (`Retry:` og linjenumre), `Call`, `Set`, `Let`, tilordning, prosedyrekall uten parenteser, `End`, `Unload x`, `Load x`, `Debug.Print` med `;`/`,`, og `Option Explicit` (bare i modulhodet).
  - Ikke-støttede setninger gir `VBSyntaxError` med meldingen `Not supported in VibeBasic: <Ord>`. Det gjelder `Declare`, `Open`, `Print #`, `Line Input`, `Property`, `Implements`, `Event`, `RaiseEvent`, `Line`, `Circle`, `PSet`, og `Print` uten `Debug.`.

- [ ] **Steg 1: Skriv de feilende testene.** VB6-tekster for kompileringsfeil skal være eksakte:

```ts
test('sub with params', () => {
  const m = parseModule('Private Sub Command1_Click(Index As Integer, ByVal s As String)\nEnd Sub', 'Form1');
  expect(m.procedures[0]).toMatchObject({ name: 'Command1_Click', visibility: 'private', params: [{ name: 'Index', byRef: true }, { name: 's', byRef: false }] });
});
test('single-line if', () => expect(() => parseModule('Sub A()\nIf x Then y = 1 Else y = 2\nEnd Sub', 'M')).not.toThrow());
test('block if without end if', () => expect(() => parseModule('Sub A()\nIf x Then\nEnd Sub', 'M')).toThrow('Block If without End If'));
test('for without next', () => expect(() => parseModule('Sub A()\nFor i = 1 To 2\nEnd Sub', 'M')).toThrow('For without Next'));
test('next without for', () => expect(() => parseModule('Sub A()\nNext\nEnd Sub', 'M')).toThrow('Next without For'));
test('expected end of statement', () => expect(() => parseModule('Sub A()\nx = 1 2\nEnd Sub', 'M')).toThrow('Expected: end of statement'));
test('expected expression', () => expect(() => parseModule('Sub A()\nx = \nEnd Sub', 'M')).toThrow('Expected: expression'));
test('type and enum', () => {
  const m = parseModule('Type P\n X As Integer\nEnd Type\nEnum Farge\n Rod = 1\n Bla\nEnd Enum', 'M');
  expect(m.types[0].name).toBe('P'); expect(m.enums[0].members).toEqual([{ name: 'Rod', value: 1 }, { name: 'Bla', value: 2 }]);
});
test('unsupported statement', () => expect(() => parseModule('Sub A()\nOpen "f" For Input As #1\nEnd Sub', 'M')).toThrow('Not supported in VibeBasic: Open'));
test('line check ignores block matching', () => { expect(checkLineSyntax('If x Then')).toBeNull(); expect(checkLineSyntax('End If')).toBeNull(); expect(checkLineSyntax('x = ')?.message).toBe('Expected: expression'); });
test('collects several errors with lines', () => {
  expect(findSyntaxErrors('Sub A()\nx = \ny = 1 2\nEnd Sub', 'M').map(e => e.line)).toEqual([2, 3]);
});
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer setningsparseren** med disse meldingene: `Expected: end of statement`, `Expected: expression`, `Expected: identifier`, `Expected: )`, `Block If without End If`, `End If without block If`, `For without Next`, `Next without For`, `Do without Loop`, `Loop without Do`, `Select Case without End Select`, `While without Wend`, `With without End With`, `Expected: End Sub`, `Expected: End Function`, `Invalid outside procedure`.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): statement parser and syntax errors`.

### Oppgave 4: Verdier, konvertering og feil

**Filer:** Opprett `src/lang/values.ts` og endre `src/lang/errors.ts`. Test: `tests/lang/values.test.ts`

**Grensesnitt:**
- Produserer:
  - `type VBValue = number | string | boolean | VBDate | VBArray | VBRecord | VBObject | EmptyT | NullT | NothingT`
  - Singletons `Empty`, `Null`, `Nothing`.
  - `class VBRef { constructor(public value: VBValue) }`, brukt for ByRef og hendelsesargumenter.
  - `class VBArray { elemType: VBTypeName; bounds: [lo: number, hi: number][]; get(idx: number[]): VBValue; set(idx: number[], v: VBValue): void; redim(bounds, preserve: boolean): void }`. Indeks utenfor gir feil 9.
  - `class VBRecord { typeName: string; fields: Map<string, VBValue> }`
  - `coerce(v: VBValue, t: VBTypeName): VBValue`
  - `toNumber(v)`, `toStr(v)`, `toBool(v)`, `vbTypeName(v): string` (som `TypeName()`), `compare(a, b, textMode = false): -1 | 0 | 1`, `defaultValue(t: VBTypeName): VBValue`
  - `class VBRuntimeError extends Error { constructor(public number: number, description?: string) }`, der beskrivelsen hentes fra `vbErrorText(number)` når den mangler.
  - `vbErrorText(n: number): string` dekker minst 3 `Return without GoSub`, 5 `Invalid procedure call or argument`, 6 `Overflow`, 7 `Out of memory`, 9 `Subscript out of range`, 10 `This array is fixed or temporarily locked`, 11 `Division by zero`, 13 `Type mismatch`, 20 `Resume without error`, 28 `Out of stack space`, 35 `Sub or Function not defined`, 53 `File not found`, 91 `Object variable or With block variable not set`, 92 `For loop not initialized`, 94 `Invalid use of Null`, 340 `Control array element 'n' doesn't exist`, 380 `Invalid property value`, 383 `Property is read-only`, 424 `Object required`, 438 `Object doesn't support this property or method`, og 450 `Wrong number of arguments or invalid property assignment`. Ukjent nummer gir `Application-defined or object-defined error`.
  - Kompileringsfeil i kjøretid (`Variable not defined`, `Sub or Function not defined`) er `VBRuntimeError` med `compile = true`. Verten viser dem som «Compile error:».

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('integer overflow', () => expect(() => coerce(32768, 'Integer')).toThrow(expect.objectContaining({ number: 6 })));
test('string to integer', () => expect(coerce('12', 'Integer')).toBe(12));
test('bad string', () => expect(() => coerce('abc', 'Integer')).toThrow(expect.objectContaining({ number: 13 })));
test('banker rounding', () => { expect(coerce(2.5, 'Integer')).toBe(2); expect(coerce(3.5, 'Integer')).toBe(4); });
test('bool text', () => expect(toStr(true)).toBe('True'));
test('true is -1', () => expect(toNumber(true)).toBe(-1));
test('empty', () => { expect(toStr(Empty)).toBe(''); expect(toNumber(Empty)).toBe(0); });
test('cstr double', () => { expect(toStr(0.5)).toBe('0.5'); expect(toStr(0.1 + 0.2)).toBe('0.3'); expect(toStr(1e16)).toBe('1E+16'); });
test('array bounds', () => { const a = new VBArray('Integer', [[0, 2]]); expect(() => a.get([3])).toThrow(expect.objectContaining({ number: 9 })); });
test('redim preserve', () => { const a = new VBArray('Integer', [[0, 1]]); a.set([1], 7); a.redim([[0, 3]], true); expect(a.get([1])).toBe(7); });
test('error text', () => expect(vbErrorText(13)).toBe('Type mismatch'));
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer** etter VB6-reglene:
  - Integer: −32768..32767. Long: −2147483648..2147483647. Byte: 0..255. Single og Double: endelige tall.
  - Heltallstyper rundes med banker's rounding.
  - Tekst til tall godtar `&H`, mellomrom rundt og `.` som desimaltegn.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): values, coercion, error texts`.

### Oppgave 5: Tolk, kjerne og golden-tester

**Filer:**
- Opprett: `src/lang/host.ts`, `src/lang/interp/{program,driver,exec,eval,scope}.ts`, `tests/lang/testHost.ts`, `tests/lang/golden.test.ts`.
- Opprett `tests/lang/programs/`: `01-arith.bas`, `02-strings.bas`, `03-loops.bas`, `04-select.bas`, `05-procs.bas`, `06-arrays.bas`, `07-types-enums-static.bas`, `08-explicit.bas`, hver med en `.out`-fil.

**Grensesnitt:**
- Produserer `src/lang/host.ts`:

```ts
export interface VBObject {
  readonly vbTypeName: string;            // "TextBox", "Form" …
  readonly defaultMember?: string;        // "Text" for TextBox, "Caption" for Label
  hasMember(name: string): boolean;
  getMember(name: string, args: VBValue[]): VBValue;              // også indekserte: List1.List(2)
  setMember(name: string, args: VBValue[], value: VBValue): void;
  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue>;
  item?(index: number): VBObject;         // kontrollmatriser: Command1(2)
}
export interface CodeLocation { moduleName: string; procName: string; line: number }
export interface BreakInfo { reason: 'error' | 'pause'; at: CodeLocation; error?: VBRuntimeError }
export interface Host {
  resolveName(moduleName: string, name: string): VBObject | undefined; // "Me", "Command1" i Form1, "Form2", "App"
  msgBox(prompt: string, buttons: number, title: string): Promise<number>;
  inputBox(prompt: string, title: string, defaultText: string): Promise<string>;
  debugPrint(text: string, newline: boolean): void;
  doEvents(): Promise<void>;
  loadPicture(path: string): Promise<VBValue>;
  onRuntimeError(err: VBRuntimeError, at: CodeLocation): Promise<'end' | 'debug'>;
  onBreak(info: BreakInfo): Promise<'continue' | 'end'>;
  onEnd(): void;
}
```

- Produserer `src/lang/interp/program.ts`:

```ts
export interface SourceModule { name: string; kind: 'form' | 'module'; source: string }
export interface ProgramOptions { sliceSize?: number /* standard 10000 */; locale?: string }
export class Program {
  constructor(modules: SourceModule[], host: Host, opts?: ProgramOptions);
  readonly state: 'idle' | 'running' | 'break' | 'ended';
  hasProcedure(moduleName: string, procName: string): boolean;
  runEvent(moduleName: string, procName: string, args?: VBRef[]): Promise<void>; // løser seg når handleren er ferdig
  immediate(text: string): Promise<string>;   // oppgave 8
  requestPause(): void;                       // oppgave 8
  end(): void;                                // oppgave 8
}
```

- Produserer `tests/lang/testHost.ts`:
  - `class TestHost implements Host` med `output: string[]` (Debug.Print-linjer), `msgBoxAnswers: number[]` og `errorChoice: 'end' | 'debug'`. MsgBox legger til `[MsgBox] <prompt>` i `output`. Ubehandlet feil legger til `[Error <n> at <Modul>:<linje>] <tekst>`.
  - `runGolden(basFile: string): Promise<string>`: lager en modul `Module1` av filen, kjører `Main` og returnerer `output.join('\n')`.

Regler for oppførselen:
- Modulnivå-variabler: `Dim`/`Private` i en modul er synlige i modulen. `Public` i en `kind: 'module'` er global. Skjemamodul-variabler hører til skjemamodulen.
- Navneoppslag i rekkefølge: lokal → modul → globale `Public` → enum-medlemmer og konstanter → innebygde funksjoner (oppgave 6) → `host.resolveName`.
- Med `Option Explicit` gir en ukjent variabel kompileringsfeilen `Variable not defined` (compile) når linjen kjøres. Uten Option Explicit opprettes en lokal Variant.
- Ukjent prosedyre gir `Sub or Function not defined` (compile).
- `Static`-variabler beholder verdien mellom kall. Det gjelder også `Static Sub`.
- Funksjoner returnerer verdien gjennom funksjonsnavnet. Rekursjon er tillatt, og over 2000 nivåer gir feil 28.
- Driveren kjører generatoren og venter på promises som yieldes. Hver `sliceSize` setning venter den på `setTimeout(0)`, og sjekker pause/stopp ved hver setning.

- [ ] **Steg 1: Skriv golden-programmene og `golden.test.ts`.**
  `golden.test.ts` kjører hver `.bas` og sammenligner med `.out`. Eksempel, `05-procs.bas`:

```vb
Sub Main()
    Dim a As Integer, b As Integer
    a = 1: b = 2
    Swap a, b
    Debug.Print a; b
    Debug.Print Fact(5)
    Debug.Print Twice(3)
End Sub
Sub Swap(x As Integer, y As Integer)
    Dim t As Integer
    t = x: x = y: y = t
End Sub
Function Fact(n As Integer) As Long
    If n <= 1 Then Fact = 1 Else Fact = n * Fact(n - 1)
End Function
Function Twice(ByVal n As Integer) As Integer
    n = n * 2
    Twice = n
End Function
```

  `05-procs.out`:

```
 2  1 
 120 
 6 
```

  Hvert av de andre programmene dekker sin del av spec kap. 6:
  - `01-arith`: `^`, `\`, `Mod`, `/`, at `"10" + 5 = 15`, at `"10" & 5 = "105"`, og at `Dim i As Integer: i = 32767: i = i + 1` gir `[Error 6 at Module1:<linje>] Overflow`.
  - `03-loops`: `For` med `Step -1`, `Do Until`, `Do…Loop While`, `While…Wend`, `Exit For`, `For Each` over en array.
  - `06-arrays`: `ReDim Preserve`, `LBound`/`UBound`, todimensjonal array, og `[Error 9 …]`.
  - `07`: `Type`, `Enum` og en `Static`-teller kalt tre ganger (1, 2, 3).
  - `08-explicit`: ukjent variabel gir `[Error 0 at Module1:3] Compile error: Variable not defined`. TestHost skriver `0` og `Compile error:` for compile-feil.
- [ ] **Steg 2: Kjør** `npx vitest run tests/lang/golden.test.ts`. Forventet: FAIL.
- [ ] **Steg 3: Implementer `Program`, scope, `exec` og `eval` for alt over.** Debug.Print-formateringen her er bare det golden-testene trenger. Den fullføres i oppgave 6.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): interpreter core with golden tests`.

### Oppgave 6: Innebygde funksjoner, konstanter, Format og Print-formatering

**Filer:** Opprett `src/lang/builtins/*.ts` og `src/lang/printFormat.ts`. Test: `tests/lang/builtins.test.ts`, `tests/lang/printFormat.test.ts`, og golden `09-builtins.bas`/`.out`.

**Grensesnitt:**
- Produserer:
  - `BUILTINS: Map<string, Builtin>` med `type Builtin = { minArgs: number; maxArgs: number; fn: (args: VBValue[], ctx: BuiltinCtx) => VBValue | Promise<VBValue> }`. `BuiltinCtx` gir tilgang til `host`, `locale` og `Err`.
  - `CONSTANTS: Map<string, VBValue>`.
  - `formatValue(v: VBValue, fmt: string, locale: string): string`.
  - `class PrintLine { addItem(v: VBValue): void; addSemicolon(): void; addComma(): void; text(): string }`.

Faste verdier:
- **Funksjoner:** alle i spec kap. 6, og i tillegg `Year Month Day Hour Minute Second Weekday DateSerial TimeSerial DateAdd DateDiff` (intervaller `yyyy q m d ww h n s`), `Hex Oct Sgn Log Exp Sin Cos Tan Atn`, `IsDate IsArray IsObject IsNull TypeName VarType`, `StrComp`, `InStrRev`, `StrReverse`, `LoadPicture` (sendes til `host.loadPicture`), `RGB(r,g,b) = r + g*256 + b*65536`, `QBColor(n)` (VB6-tabell), `Environ` (gir `""`), og `Command` (gir `""`).
- **Konstanter:**

| Gruppe | Verdier |
|---|---|
| MsgBox-knapper | `vbOKOnly 0`, `vbOKCancel 1`, `vbAbortRetryIgnore 2`, `vbYesNoCancel 3`, `vbYesNo 4`, `vbRetryCancel 5` |
| MsgBox-ikoner | `vbCritical 16`, `vbQuestion 32`, `vbExclamation 48`, `vbInformation 64` |
| Standardknapp | `vbDefaultButton1 0`, `vbDefaultButton2 256`, `vbDefaultButton3 512` |
| MsgBox-svar | `vbOK 1`, `vbCancel 2`, `vbAbort 3`, `vbRetry 4`, `vbIgnore 5`, `vbYes 6`, `vbNo 7` |
| Tekst | `vbCrLf`, `vbCr`, `vbLf`, `vbNewLine` (= vbCrLf), `vbTab`, `vbNullString` (`""`) |
| Farger | `vbBlack 0`, `vbRed &HFF`, `vbGreen &HFF00`, `vbYellow &HFFFF`, `vbBlue &HFF0000`, `vbMagenta &HFF00FF`, `vbCyan &HFFFF00`, `vbWhite &HFFFFFF` |
| Taster | `vbKeyReturn 13`, `vbKeyEscape 27`, `vbKeySpace 32`, `vbKeyBack 8`, `vbKeyTab 9`, `vbKeyLeft 37`, `vbKeyUp 38`, `vbKeyRight 39`, `vbKeyDown 40`, `vbKeyA`–`vbKeyZ` 65–90, `vbKey0`–`vbKey9` 48–57 |
| Avkrysning | `vbUnchecked 0`, `vbChecked 1`, `vbGrayed 2` |
| Annet | `vbModal 1`, `vbModeless 0`, `vbTextCompare 1`, `vbBinaryCompare 0` |

- **Format:**
  - Navngitte formater: `General Number`, `Fixed`, `Standard`, `Percent`, `Currency` (`$`-tegn, Claudes valg), `Yes/No`, `True/False`, `On/Off`, og datoformatene `General Date`, `Short Date`, `Long Date`, `Short Time`, `Long Time` (etter locale).
  - Mønstre: `0`, `#`, `.`, `,` (tusenskille), `%`, `E+`, bokstavelig tekst i `""` eller `\`, og datomønstre `d dd ddd dddd m mm mmm mmmm yy yyyy h hh n nn s ss AM/PM`.
- **Print-formatering:**
  - Tall: positive tall og null får et mellomrom foran, og alle tall får et mellomrom etter.
  - `;` setter ingen skilletegn. `,` hopper til neste sone på 14 tegn.
  - `;` eller `,` til slutt gir ingen linjeskift (`newline = false` til verten).

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
const call = (n: string, ...a: VBValue[]) => BUILTINS.get(n.toLowerCase())!.fn(a, testCtx);
test('mid/instr', () => { expect(call('Mid', 'Hallo', 2, 3)).toBe('all'); expect(call('InStr', 'abcabc', 'c')).toBe(3); expect(call('InStr', 3, 'abcabc', 'a')).toBe(4); });
test('str vs cstr', () => { expect(call('Str', 5)).toBe(' 5'); expect(call('CStr', 5)).toBe('5'); expect(call('Str', 0.5)).toBe(' .5'); });
test('val stops at junk', () => { expect(call('Val', '12abc')).toBe(12); expect(call('Val', '3,5')).toBe(3); expect(call('Val', '&HFF')).toBe(255); });
test('windows-1252', () => { expect(call('Chr', 230)).toBe('æ'); expect(call('Asc', 'ø')).toBe(248); expect(call('Chr', 128)).toBe('€'); });
test('cint banker', () => expect(call('CInt', 2.5)).toBe(2));
test('format', () => { expect(formatValue(1234.5, '#,##0.00', 'en-US')).toBe('1,234.50'); expect(formatValue(0.256, '0%', 'en-US')).toBe('26%'); expect(formatValue(5, '000', 'en-US')).toBe('005'); });
test('format date', () => expect(formatValue(dateFrom(2026, 10, 22, 13, 5, 0), 'dd.mm.yyyy hh:nn', 'en-US')).toBe('22.10.2026 13:05'));
test('rgb', () => expect(call('RGB', 255, 0, 0)).toBe(255));
test('print zones', () => { const l = new PrintLine(); l.addItem('a'); l.addComma(); l.addItem('b'); expect(l.text()).toBe('a' + ' '.repeat(13) + 'b'); });
test('print numbers', () => { const l = new PrintLine(); l.addItem(1); l.addSemicolon(); l.addItem(-2); expect(l.text()).toBe(' 1 -2 '); });
test('wrong arg count', () => expect(() => call('Mid')).toThrow(expect.objectContaining({ number: 450 })));
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer, og koble `BUILTINS`/`CONSTANTS` inn i navneoppslaget.** `MsgBox(prompt, [buttons], [title])` går til `host.msgBox`. Standardtittel er prosjektnavnet, som gis via `ProgramOptions.appTitle` med standardverdi `'Project1'`. Legg den til i `ProgramOptions`. `InputBox` går til `host.inputBox`, og `DoEvents` går til `host.doEvents`, som returnerer 0.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): builtins, constants, Format, Print formatting`.

### Oppgave 7: Objekter, With, Set, kontrollmatriser og hendelser

**Filer:** Endre `src/lang/interp/eval.ts`, `exec.ts` og `program.ts`. Test: `tests/lang/objects.test.ts` (med `FakeObject` i `tests/lang/fakeObject.ts`).

**Grensesnitt:**
- Konsumerer: `VBObject` og `Host.resolveName` (oppgave 5).
- Produserer disse reglene, som plan 03 er avhengig av:
  - `a.b` kaller `getMember('b', [])`. `a.b(1)` kaller `getMember('b', [1])` hvis `hasMember('b')`, ellers `callMethod('b', [1])`.
  - Står `a.b …` alene som setning, kalles `callMethod('b', args)`.
  - Standardegenskap: en objektverdi brukt der det trengs en enkel verdi blir `getMember(defaultMember)`. `Text1 = "x"` uten `Set` blir `setMember(defaultMember, [], "x")`.
  - `Command1(2)` på et objekt med `item` gir `item(2)`.
  - `Set x = obj` lagrer referansen. `x Is Nothing` og `a Is b` sammenligner identitet.
  - `With obj … .Text = 1 … End With` (nestet).
  - `Unload X` gir `callMethod('Unload', [])` på X. `Load X` gir `callMethod('Load', [])`, og `Unload Me` virker.
  - `Program.runEvent` er re-entrant. Hendelser som startes mens en handler venter i `DoEvents` eller i en ikke-modal dialog, kjører ferdig før den ytre handleren fortsetter.
  - Hendelser som kommer mens programmet er i break-modus, droppes.
  - Feil fra `VBObject` (kastet `VBRuntimeError`) behandles som vanlige kjøretidsfeil. Mangler medlemmet, blir det feil 438.

- [ ] **Steg 1: Skriv de feilende testene.** Bruk en `FakeObject` med egenskapene `Text` og `Caption`, metoden `AddItem` som logger, og `item(i)` som gir underobjekter.

```ts
test('default member get/set', async () => { /* Form1-kode: Text1 = "hei": Debug.Print Text1 */ expect(out).toEqual(['hei']); });
test('control array item', async () => { /* Command1(2).Caption = "x" */ expect(fake.items[2].props.Caption).toBe('x'); });
test('with block', async () => { /* With Text1: .Text = "a": End With */ expect(fake.props.Text).toBe('a'); });
test('method statement without parens', async () => { /* List1.AddItem "x" */ expect(fake.log).toEqual(['AddItem:x']); });
test('missing member is 438', async () => { /* Text1.Foo = 1 */ expect(host.output).toContain('[Error 438 at Form1:2] Object doesn\'t support this property or method'); });
test('is nothing', async () => { /* Dim o As Object: Debug.Print o Is Nothing */ expect(out).toEqual(['True']); });
test('byref event arg', async () => { const k = new VBRef(65); await prog.runEvent('Form1', 'Text1_KeyPress', [k]); expect(k.value).toBe(0); /* handler: KeyAscii = 0 */ });
test('nested events during DoEvents complete first', async () => { /* A_Click: log "a1": DoEvents: log "a2"; B_Click: log "b" — start B fra host.doEvents */ expect(log).toEqual(['a1', 'b', 'a2']); });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer** reglene over.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): objects, With, control arrays, re-entrant events`.

### Oppgave 8: Feilhåndtering, break-modus, Immediate, pause og End

**Filer:** Endre `src/lang/interp/*`. Test: `tests/lang/errors.test.ts`, `tests/lang/breakmode.test.ts`, og golden `10-onerror.bas`/`.out`.

**Grensesnitt:**
- Produserer:
  - `Err`-objektet med `Number`, `Description`, `Source`, `Clear`, og `Raise n[, source, description]`.
  - `On Error Resume Next`, `On Error GoTo label`, `On Error GoTo 0`, `Resume`, `Resume Next`, `Resume label`. Feil bobler opp gjennom kallstakken til nærmeste aktive handler, som i VB6.
  - Ubehandlet feil: `host.onRuntimeError(err, at)`.
    - `'end'`: programmet avsluttes. `state` blir `'ended'`, og `host.onEnd()` kalles.
    - `'debug'`: `state` blir `'break'`, og `host.onBreak({ reason: 'error', at, error })` kalles.
    - `onBreak` gir `'continue'`: **den samme setningen kjøres på nytt**.
    - `onBreak` gir `'end'`: programmet avsluttes.
  - `requestPause()`: ved neste setningsgrense går programmet til `onBreak({ reason: 'pause', at })`. Uten kode som kjører, løses det med en gang, og `at` er tom (`procName: ''`).
  - `immediate(text)`:
    - Starter teksten med `?` eller `Print `, evalueres resten som uttrykk, og resultatet returneres formatert som Debug.Print.
    - Ellers kjøres teksten som én eller flere setninger, og resultatet er `''`.
    - I break-modus ser den lokale variabler i rammen som står stille. Ellers ser den bare globale variabler og moduler.
    - Feil gir teksten `Run-time error '<n>': <tekst>` som resultat, uten break.
  - `end()` og `End`-setningen stopper all kode som kjører og venter (også nestede hendelser og ventende `onBreak`). `state` blir `'ended'`, og `host.onEnd()` kalles én gang.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
test('resume next', async () => { /* On Error Resume Next: x = 1 / 0: Debug.Print Err.Number */ expect(out).toEqual([' 11 ']); });
test('goto handler bubbles from callee', async () => { /* Main: On Error GoTo H: Call Bad: Exit Sub: H: Debug.Print Err.Description; Bad: x = 1/0 */ expect(out).toEqual(['Division by zero']); });
test('debug then continue re-executes statement', async () => {
  // Main: Dim d As Integer: Debug.Print 10 / d  — onBreak setter d = 2 via immediate("d = 2") og svarer 'continue'
  expect(out).toEqual([' 5 ']);
});
test('immediate sees locals in break frame', async () => { /* i onBreak: */ expect(await prog.immediate('? d * 3')).toBe(' 0 '); });
test('immediate error text', async () => expect(await prog.immediate('? 1/0')).toBe("Run-time error '11': Division by zero"));
test('pause infinite loop within 500 ms', async () => {   // Review Focus 1
  const p = prog.runEvent('Module1', 'Spin');            // Sub Spin(): Do: Loop: End Sub
  setTimeout(() => prog.requestPause(), 50);
  const info = await host.nextBreak();                    // TestHost lagrer onBreak-kall som promise
  expect(info.reason).toBe('pause'); expect(info.at.procName).toBe('Spin');
  prog.end(); await p; expect(prog.state).toBe('ended');
}, 500);
test('end stops nested and pending', async () => { /* End i en handler mens en annen venter i DoEvents */ expect(host.endCalls).toBe(1); });
test('err.raise custom', async () => { /* On Error Resume Next: Err.Raise 1000, , "Egen": Debug.Print Err.Number; Err.Description */ expect(out).toEqual([' 1000 Egen']); });
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer.**
  - Hver setning kjøres i en `try`. En feil ser etter en handler i rammen. Finnes ingen, kastes den videre til kalleren.
  - Rammen som feiler bevares mens `onBreak` venter.
  - Stopp er et internt `EndSignal` som kastes inn i alle aktive generatorer. Det kan ikke fanges av `On Error`.
- [ ] **Steg 4: Kjør.** Forventet: PASS.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): error handling, break mode, immediate, pause/end`.

### Oppgave 9: prettifyLine (store bokstaver og mellomrom som i VB6)

**Filer:** Opprett `src/lang/prettify.ts`. Test: `tests/lang/prettify.test.ts`

**Grensesnitt:**
- Produserer:
  - `prettifyLine(line: string, known: Map<string, string>): string`
  - `collectIdentifiers(source: string): Map<string, string>`, som mapper navn med små bokstaver til slik det er skrevet første gang i en deklarasjon (`Dim`, parameter, `Sub`- eller `Function`-navn, `Const`, `Type`- og `Enum`-medlem).
  - `KEYWORD_CASE: Map<string, string>` (`dim` → `Dim`, `msgbox` → `MsgBox`, `vbcrlf` → `vbCrLf` og så videre, med alle innebygde funksjoner og konstanter fra oppgave 6). Brukes også til syntaksfarger i plan 02.

- [ ] **Steg 1: Skriv de feilende testene.**

```ts
const known = new Map([['teller', 'Teller'], ['text1', 'Text1']]);
test('keywords and spacing', () => expect(prettifyLine('dim x as integer', known)).toBe('Dim x As Integer'));
test('operators spaced', () => expect(prettifyLine('teller=teller+1', known)).toBe('Teller = Teller + 1'));
test('strings untouched', () => expect(prettifyLine('msgbox "dim  x=1"', known)).toBe('MsgBox "dim  x=1"'));
test('comments untouched', () => expect(prettifyLine("x=1 'dim  y", known)).toBe("x = 1 'dim  y"));
test('commas', () => expect(prettifyLine('msgbox "a",vbokonly,"t"', known)).toBe('MsgBox "a", vbOKOnly, "t"'));
test('member names keep case of control', () => expect(prettifyLine('text1.text="x"', known)).toBe('Text1.text = "x"'));
test('unary minus not spaced', () => expect(prettifyLine('x=-1', known)).toBe('x = -1'));
test('invalid line returned unchanged', () => expect(prettifyLine('x = "abc', known)).toBe('x = "abc'));
```

- [ ] **Steg 2: Kjør.** Forventet: FAIL.
- [ ] **Steg 3: Implementer** ved hjelp av lexeren. Teksten bygges på nytt fra tokens. Innrykket i starten av linjen beholdes.
  - Egenskapsnavn etter `.` rettes ikke her. Det gjør plan 02 oppg. 9 med kontrollregisteret.
- [ ] **Steg 4: Kjør.** Forventet: PASS. Kjør også hele `npm test`.
- [ ] **Steg 5: Commit** med meldingen `feat(lang): prettifyLine`.
