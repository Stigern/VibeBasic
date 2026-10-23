/// <reference types="vite/client" />
import { collectIdentifiers, fileStatementWords, KEYWORD_CASE, prettifyLine } from '../../src/lang/prettify';
import { tokenize } from '../../src/lang/lexer';
import { KEYWORDS } from '../../src/lang/tokens';
import { BUILTINS, CONSTANTS } from '../../src/lang/builtins';

const known = new Map([['teller', 'Teller'], ['text1', 'Text1']]);
const p = (s: string) => prettifyLine(s, known);

// ---- brief tests (verbatim) ----
test('keywords and spacing', () => expect(prettifyLine('dim x as integer', known)).toBe('Dim x As Integer'));
test('operators spaced', () => expect(prettifyLine('teller=teller+1', known)).toBe('Teller = Teller + 1'));
test('strings untouched', () => expect(prettifyLine('msgbox "dim  x=1"', known)).toBe('MsgBox "dim  x=1"'));
test('comments untouched', () => expect(prettifyLine("x=1 'dim  y", known)).toBe("x = 1 'dim  y"));
test('commas', () => expect(prettifyLine('msgbox "a",vbokonly,"t"', known)).toBe('MsgBox "a", vbOKOnly, "t"'));
test('member names keep case of control', () => expect(prettifyLine('text1.text="x"', known)).toBe('Text1.text = "x"'));
test('unary minus not spaced', () => expect(prettifyLine('x=-1', known)).toBe('x = -1'));
test('invalid line returned unchanged', () => expect(prettifyLine('x = "abc', known)).toBe('x = "abc'));

// ---- spacing rules ----
test('all binary operators', () => {
  expect(p('x=a+b-c*d/e\\f^g &h')).toBe('x = a + b - c * d / e \\ f ^ g & h');
  expect(p('If a<b And a>c Or a<=b Or a>=c Or a<>b Then')).toBe('If a < b And a > c Or a <= b Or a >= c Or a <> b Then');
});
test('extra spaces collapse', () => expect(p('x   =   a  +   b')).toBe('x = a + b'));
test('drawing statements are written as VB6 does', () => {
  expect(p('line (0,0)-step(10,10),vbred,bf')).toBe('Line (0, 0)-Step(10, 10), vbRed, bf');
  expect(p('text1.Line -(5, 5): pset step(1,2): scale (0,9)-(9,0)')).toBe('Text1.Line -(5, 5): PSet Step(1, 2): Scale (0, 9)-(9, 0)');
});
test('unary minus in various places', () => {
  expect(p('Foo(-1)')).toBe('Foo(-1)');
  expect(p('x=a*-b')).toBe('x = a * -b');
  expect(p('x = 3 - -b')).toBe('x = 3 - -b');
  expect(p('x=-(a+1)')).toBe('x = -(a + 1)');
  expect(p('Case -1, -2')).toBe('Case -1, -2');
  expect(p('For i = 10 To 1 Step -1')).toBe('For i = 10 To 1 Step -1');
  expect(p('x = a-1')).toBe('x = a - 1');
  expect(p('x = f(1)-1')).toBe('x = f(1) - 1');
  expect(p('x = +1')).toBe('x = +1');
});
test('call statement with negative argument stays unary', () => {
  expect(p('Foo -1')).toBe('Foo -1');
  expect(p('Debug.Print -1')).toBe('Debug.Print -1');
});
test('Not has spaces around, no extra space after unary minus', () => {
  expect(p('x=not a')).toBe('x = Not a');
  expect(p('If not(a) Then')).toBe('If Not (a) Then');
});
test('commas: none before, one after', () => {
  expect(p('Foo(1 ,2,   3)')).toBe('Foo(1, 2, 3)');
  expect(p('MsgBox "x", , "t"')).toBe('MsgBox "x", , "t"');
  expect(p('MsgBox "x",,"t"')).toBe('MsgBox "x", , "t"');
});
test('no space inside parentheses or before ( in calls and indexes', () => {
  expect(p('x = Foo( 1, 2 )')).toBe('x = Foo(1, 2)');
  expect(p('a (1) = 2')).toBe('a(1) = 2');
  expect(p('x = a (1) + b (2)')).toBe('x = a(1) + b(2)');
  expect(p('Dim a (1 To 3) As Integer')).toBe('Dim a(1 To 3) As Integer');
  expect(p('x=((a+b)*c)')).toBe('x = ((a + b) * c)');
});
test('space kept before ( of a call statement (Foo (1), 2 differs from Foo(1), 2)', () => {
  expect(p('Foo (1), 2')).toBe('Foo (1), 2');
  expect(p('Foo(1)')).toBe('Foo(1)');
  expect(p('Debug.Print (1), 2')).toBe('Debug.Print (1), 2');
  expect(p('MsgBox ("hi")')).toBe('MsgBox ("hi")');
  expect(p('If (a) Then')).toBe('If (a) Then');
  expect(p('x = a And (b)')).toBe('x = a And (b)');
});
test('keyword-named functions keep ( attached', () => {
  expect(p('x = string(5,"a")')).toBe('x = String(5, "a")');
  expect(p('x = mid$(s,2)')).toBe('x = Mid$(s, 2)');
});
test('no spaces around member access', () => {
  expect(p('Form1.Text1.Text = "a"')).toBe('Form1.Text1.Text = "a"');
  expect(p('x = Me.Width')).toBe('x = Me.Width');
  expect(p('x = Foo(1).Bar')).toBe('x = Foo(1).Bar');
  expect(p('x = a.b .c')).toBe('x = a.b .c'); // a space before . is kept: `MsgBox .Text`
  expect(p('x = a. b')).toBe('x = a.b');
});
test('With-block member access', () => {
  expect(p('.Text="a"')).toBe('.Text = "a"');
  expect(p('x = .Width')).toBe('x = .Width');
  expect(p('Foo(.Width)')).toBe('Foo(.Width)');
  expect(p('MsgBox .Text')).toBe('MsgBox .Text');
});
test('colon statement separator', () => {
  expect(p('a=1:b=2')).toBe('a = 1: b = 2');
  expect(p('a = 1 : b = 2')).toBe('a = 1: b = 2');
  expect(p('a = 1:')).toBe('a = 1:');
});
test('labels kept', () => {
  expect(p('Done:')).toBe('Done:');
  expect(p('Done:  x=1')).toBe('Done: x = 1');
});
test('semicolon in Debug.Print', () => {
  expect(p('Debug.Print a;b ;c')).toBe('Debug.Print a; b; c');
  expect(p('debug.print a;')).toBe('Debug.Print a;');
});
test('named arguments :=', () => expect(p('Foo a := 1, b:=2')).toBe('Foo a:=1, b:=2'));
test('# file numbers', () => expect(p('Print #1,x')).toBe('Print #1, x'));
test('type-suffixed identifiers keep their suffix', () => {
  expect(p('name$ = left$(name$,2)')).toBe('name$ = Left$(name$, 2)');
  expect(p('x% = y&+1')).toBe('x% = y& + 1');
  expect(p('x# = 1.5#')).toBe('x# = 1.5#');
});
test('known identifier with suffix', () => {
  expect(prettifyLine('name$="x"', new Map([['name', 'Name']]))).toBe('Name$ = "x"');
});

// ---- case ----
test('builtin and constant casing', () => {
  expect(p('x = instr(1, a, b) + ubound(arr) + lbound(arr)')).toBe('x = InStr(1, a, b) + UBound(arr) + LBound(arr)');
  expect(p('doevents')).toBe('DoEvents');
  expect(p('If isnumeric(s) Then')).toBe('If IsNumeric(s) Then');
  expect(p('s = "a" & vbcrlf')).toBe('s = "a" & vbCrLf');
  expect(p('debug.print err.number')).toBe('Debug.Print Err.number');
});
test('keywords are cased wherever they appear', () => {
  expect(p('on error goto 0')).toBe('On Error GoTo 0');
  expect(p('elseif a then')).toBe('ElseIf a Then');
  expect(p('redim preserve a(5)')).toBe('ReDim Preserve a(5)');
  expect(p('private declare function foo lib "x" (byval a as long) as long'))
    .toBe('Private Declare Function foo Lib "x" (ByVal a As Long) As Long');
  expect(p('x = typeof a is nothing')).toBe('x = TypeOf a Is Nothing');
});
test('member names after . are untouched, even keywords and builtins', () => {
  expect(p('x.close')).toBe('x.close');
  expect(p('x = a.len')).toBe('x = a.len');
  expect(p('Err.Raise 5')).toBe('Err.Raise 5');
});
test('known identifiers fix case; unknown identifiers untouched', () => {
  expect(p('TELLER = foo')).toBe('Teller = foo');
});
test('known identifiers win over built-in names', () => {
  expect(prettifyLine('x = left + 1', new Map([['left', 'left']]))).toBe('x = left + 1');
});

// ---- strings, comments, literals ----
test('string contents and escaped quotes preserved', () => {
  expect(p('x="a  ""b""  c"')).toBe('x = "a  ""b""  c"');
});
test('comment: original whitespace before it is kept, at least one space', () => {
  expect(p("x = 1    'c  d")).toBe("x = 1    'c  d");
  expect(p("x = 1\t'c")).toBe("x = 1\t'c");
  expect(p("x=1'c")).toBe("x = 1 'c");
  expect(p("a=1:'c")).toBe("a = 1: 'c");
});
test('comment-only line and indentation', () => {
  expect(p("    ' hello  there")).toBe("    ' hello  there");
  expect(p("  'x   ")).toBe("  'x");
});
test('Rem comments', () => {
  expect(p('rem  hello   world')).toBe('Rem  hello   world');
  expect(p('x=1: rem hi')).toBe('x = 1: Rem hi');
  expect(p('REM')).toBe('Rem');
});
test('date literals untouched', () => {
  expect(p('d=#1/2/2000#+1')).toBe('d = #1/2/2000# + 1');
  expect(p('d = #12/31/1999 10:30:00 PM#')).toBe('d = #12/31/1999 10:30:00 PM#');
});
test('hex and octal literals with suffixes untouched', () => {
  expect(p('x=&hFF+&H7FFF&')).toBe('x = &hFF + &H7FFF&');
  expect(p('x=&o17')).toBe('x = &o17');
  expect(p('x = 1.5e+10 + 3E-2')).toBe('x = 1.5e+10 + 3E-2');
});
test('indentation preserved exactly, trailing whitespace removed', () => {
  expect(p('\t\tx=1   ')).toBe('\t\tx = 1');
  expect(p('    if a then')).toBe('    If a Then');
  expect(p('  \t x=1')).toBe('  \t x = 1');
});
test('blank and whitespace-only lines', () => {
  expect(p('')).toBe('');
  expect(p('   ')).toBe('');
});
test('line continuation: each physical line alone, trailing _ kept', () => {
  expect(p('x=a+ _')).toBe('x = a + _');
  expect(p('x=a+_')).toBe('x = a + _');
  expect(p('    foo(a,b) _')).toBe('    foo(a, b) _');
  expect(p('    & "x"')).toBe('    & "x"');
  expect(p('    -b+c')).toBe('    -b + c');
  expect(p('    - b')).toBe('    - b');
  expect(p("x = 1 ' comment _")).toBe("x = 1 ' comment _");
  expect(p('_')).toBe('_');
});
test('lines that do not tokenize are returned unchanged', () => {
  expect(p('x = "abc')).toBe('x = "abc');
  expect(p('x =   $')).toBe('x =   $');
  expect(p('  x ?= 1  ')).toBe('  x ?= 1  ');
  expect(p('a _ b')).toBe('a _ b');
});
test('multi-line input is prettified line by line', () => {
  expect(p('x=1\r\ny=2\nz=3')).toBe('x = 1\r\ny = 2\nz = 3');
});

// ---- KEYWORD_CASE ----
test('KEYWORD_CASE has every keyword, built-in and constant, correctly cased', () => {
  for (const k of KEYWORDS) {
    const c = KEYWORD_CASE.get(k);
    expect(c, k).toBeDefined();
    expect(c!.toLowerCase()).toBe(k);
  }
  for (const k of [...BUILTINS.keys(), ...CONSTANTS.keys()]) {
    const c = KEYWORD_CASE.get(k);
    expect(c, k).toBeDefined();
    expect(c!.toLowerCase()).toBe(k);
  }
  const expected: Record<string, string> = {
    dim: 'Dim', msgbox: 'MsgBox', vbcrlf: 'vbCrLf', vbokonly: 'vbOKOnly', instr: 'InStr', ubound: 'UBound',
    doevents: 'DoEvents', lbound: 'LBound', isnumeric: 'IsNumeric', debug: 'Debug', print: 'Print', err: 'Err',
    byval: 'ByVal', elseif: 'ElseIf', goto: 'GoTo', redim: 'ReDim', typeof: 'TypeOf', true: 'True', nothing: 'Nothing',
    'left$': 'Left$', 'mid$': 'Mid$', vbkeya: 'vbKeyA', vbkeyf5: 'vbKeyF5', rgb: 'RGB', iif: 'IIf', ucase: 'UCase',
  };
  for (const [k, v] of Object.entries(expected)) expect(KEYWORD_CASE.get(k), k).toBe(v);
});

// ---- collectIdentifiers ----
test('collectIdentifiers: declarations, parameters, procedures, types, enums, consts', () => {
  const src = [
    'Option Explicit',
    'Private Teller As Long, nAvn$',
    'Public Const MaxN = 10, MinN As Integer = 1',
    'Type Person',
    '    FirstName As String',
    '    age As Integer',
    'End Type',
    'Enum Color',
    '    Red = 1',
    '    Green',
    'End Enum',
    'Sub DoIt(ByVal Alpha As Long, Optional beta, gamma() As String)',
    '    Dim Local1 As New Collection, arr(1 To 3) As Integer',
    '    Static Counter As Long',
    'End Sub',
    'Private Function Calc(x) As Double',
    'End Function',
  ].join('\n');
  const m = collectIdentifiers(src);
  const get = (k: string) => m.get(k);
  expect(get('teller')).toBe('Teller');
  expect(get('navn')).toBe('nAvn');
  expect(get('maxn')).toBe('MaxN');
  expect(get('minn')).toBe('MinN');
  expect(get('person')).toBe('Person');
  expect(get('firstname')).toBe('FirstName');
  expect(get('age')).toBe('age');
  expect(get('color')).toBe('Color');
  expect(get('red')).toBe('Red');
  expect(get('green')).toBe('Green');
  expect(get('doit')).toBe('DoIt');
  expect(get('alpha')).toBe('Alpha');
  expect(get('beta')).toBe('beta');
  expect(get('gamma')).toBe('gamma');
  expect(get('local1')).toBe('Local1');
  expect(get('arr')).toBe('arr');
  expect(get('counter')).toBe('Counter');
  expect(get('calc')).toBe('Calc');
  expect(get('x')).toBe('x');
  expect(get('string')).toBeUndefined();
  expect(get('integer')).toBeUndefined();
  expect(get('collection')).toBeUndefined();
});
test('collectIdentifiers: first spelling wins', () => {
  const m = collectIdentifiers('Dim Foo As Long\nDim foo2 As Long\nSub Main()\n  Dim FOO As Long\nEnd Sub');
  expect(m.get('foo')).toBe('Foo');
});
test('collectIdentifiers: tolerates syntax errors', () => {
  const m = collectIdentifiers('Dim Alpha As Long\nx = "abc\nDim Beta As Long\nIf Then Then\nDim Gamma As\nSub Delta(\n');
  expect(m.get('alpha')).toBe('Alpha');
  expect(m.get('beta')).toBe('Beta');
  expect(m.get('gamma')).toBe('Gamma');
  expect(m.get('delta')).toBe('Delta');
});
test('collectIdentifiers: continuation lines in parameter lists', () => {
  const m = collectIdentifiers('Sub Foo(A As Long, _\n  Bb As Long)\nEnd Sub');
  expect(m.get('a')).toBe('A');
  expect(m.get('bb')).toBe('Bb');
});
test('collectIdentifiers: End Sub / Exit Sub / member access are not declarations', () => {
  const m = collectIdentifiers('Sub Main()\n  Exit Sub\nEnd Sub\nx.Dim = 1\nEnd Function');
  expect([...m.keys()].sort()).toEqual(['main']);
});
test('collectIdentifiers + prettifyLine together', () => {
  const k = collectIdentifiers('Dim MyCounter As Long');
  expect(prettifyLine('mycounter=mycounter+1', k)).toBe('MyCounter = MyCounter + 1');
});

// ---- golden program lines: idempotence and token preservation ----
const SOURCES = import.meta.glob('./programs/*.bas', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const sig = (line: string) => tokenize(line).map(t => {
  const base = t.kind === 'string' || t.kind === 'date' || t.kind === 'number' ? t.text
    : t.kind === 'comment' ? t.text.trimEnd().replace(/^rem\b/i, 'Rem') : t.text.toLowerCase();
  return `${t.kind}:${base}:${t.value ?? ''}`.replace(/(comment:.*:)(.*?)\s*$/, '$1$2');
});

describe('golden program lines', () => {
  const entries = Object.entries(SOURCES);
  test('there are golden programs', () => expect(entries.length).toBeGreaterThanOrEqual(8));
  for (const [file, src] of entries) {
    const kn = collectIdentifiers(src);
    const lines = src.split(/\r?\n/);
    test(`${file}: idempotent and token-preserving`, () => {
      let changed = 0;
      for (const line of lines) {
        const once = prettifyLine(line, kn);
        expect(prettifyLine(once, kn), line).toBe(once);
        expect(sig(once), line).toEqual(sig(line));
        if (once !== line) changed++;
      }
      expect(lines.length).toBeGreaterThan(5);
      void changed;
    });
    test(`${file}: already formatted programs are unchanged`, () => {
      // The golden programs are written in VB6 style; prettify must not disturb them.
      for (const line of lines) expect(prettifyLine(line, kn), line).toBe(line.trimEnd());
    });
  }
});

// ---- robustness ----
test('a re-lex that would change tokens leaves the line alone (pseudo date literal)', () => {
  const line = 'Print #1,a,#2';
  const out = p(line);
  expect(sig(out)).toEqual(sig(line));
});

test('random token soup: tokens preserved, idempotent, never throws', () => {
  const frags = ['x', 'Foo', 'text1', '.', '.Text', '(', ')', ',', ';', ':', ':=', '+', '-', '*', '/', '\\', '^', '&', '=', '<', '>', '<>', '<=',
    '>=', '#', '!', '1', '2.5', '&HFF', '"s t"', '#1/2/2000#', 'If', 'Then', 'Else', 'Not', 'And', 'Dim', 'As', 'String', 'Date', 'Me', 'Nothing',
    'name$', "'c", 'Rem x', '_', 'Debug', 'Print', 'msgbox', 'Error', 'End', 'Sub'];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 3000; n++) {
    const len = 1 + Math.floor(rnd() * 8);
    let line = rnd() < 0.3 ? '  ' : '';
    for (let i = 0; i < len; i++) line += frags[Math.floor(rnd() * frags.length)] + (rnd() < 0.5 ? ' ' : rnd() < 0.5 ? '' : '  ');
    let tokens: string[] | null = null;
    try { tokens = sig(line); } catch { /* does not tokenize */ }
    const once = p(line);
    if (tokens === null) { expect(once, line).toBe(line); continue; }
    expect(sig(once), line).toEqual(tokens);
    expect(p(once), line).toBe(once);
  }
});

test('every built-in has a canonical spelling that matches its registry key', () => {
  for (const k of [...BUILTINS.keys(), ...CONSTANTS.keys()]) expect(KEYWORD_CASE.get(k)?.toLowerCase()).toBe(k);
});

test('fast: 20000 lines', () => {
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) p('If teller<10 Then msgbox "a",vbokonly Else x=foo(1,2)+bar(-1)');
  expect(performance.now() - t0).toBeLessThan(3000);
});

test('file statements: VB6 casing, and their words count as keywords for colouring', () => {
  expect(p('open "x" for output access write lock read as #1 len = 5')).toBe('Open "x" For Output Access Write Lock Read As #1 Len = 5');
  expect(p('line input #1, s')).toBe('Line Input #1, s');
  const kw = (line: string) => { const t = tokenize(line); return [...fileStatementWords(t)].map(i => t[i].text); };
  expect(kw('Open output For Binary Access Read As #1 Len = 4')).toEqual(['Binary', 'Access', 'Read', 'Len']);
  expect(kw('Line Input #1, s: Get #1, , x: Name a As b: Print = 1')).toEqual(['Line', 'Input', 'Get', 'Name']);
});

test('LSet / RSet and Collection get the VB6 spelling (review 08 final #11)', () => {
  expect(prettifyLine('dim c as new collection', known)).toBe('Dim c As New Collection');
  expect(prettifyLine('set c = new collection', known)).toBe('Set c = New Collection');
  expect(prettifyLine('lset t = "a": rset t = "b"', known)).toBe('LSet t = "a": RSet t = "b"');
  expect(prettifyLine('print #1, x: line input #1, s', known)).toBe('Print #1, x: Line Input #1, s');
});
