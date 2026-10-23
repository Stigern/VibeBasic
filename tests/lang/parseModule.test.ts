import { parseModule, findSyntaxErrors, checkLineSyntax } from '../../src/lang/parser';
import { exprToString, type Stmt, type ProcDecl } from '../../src/lang/ast';
import { VBSyntaxError } from '../../src/lang/errors';

// ---- tests from the task brief (verbatim) ----

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
test('unsupported statement', () => expect(() => parseModule('Sub A()\nDeclare X\nEnd Sub', 'M')).toThrow('Not supported in VibeBasic: Declare'));
test('line check ignores block matching', () => { expect(checkLineSyntax('If x Then')).toBeNull(); expect(checkLineSyntax('End If')).toBeNull(); expect(checkLineSyntax('x = ')?.message).toBe('Expected: expression'); });
test('collects several errors with lines', () => {
  expect(findSyntaxErrors('Sub A()\nx = \ny = 1 2\nEnd Sub', 'M').map(e => e.line)).toEqual([2, 3]);
});

// ---- helpers ----

/** Parses the statements of a body inside `Sub A() ... End Sub`. */
const body = (src: string): Stmt[] => (parseModule(`Sub A()\n${src}\nEnd Sub`, 'M').procedures[0] as ProcDecl).body;
const one = (src: string): Stmt => { const b = body(src); expect(b).toHaveLength(1); return b[0]; };
const err = (src: string): string => { try { parseModule(src, 'M'); } catch (e) { return (e as Error).message; } return 'NO ERROR'; };
const berr = (src: string): string => err(`Sub A()\n${src}\nEnd Sub`);
const ex = exprToString;

// ---- module level ----

describe('module structure', () => {
  test('Option Explicit and module-level declarations', () => {
    const m = parseModule([
      "' header comment",
      'Option Explicit',
      'Dim a As Integer, b(10) As String, c',
      'Private d As Long',
      'Public e As New Collection',
      'Const K = 5',
      'Public Const L As Long = 7, M$ = "x"',
      'Sub One()',
      'End Sub',
      'Public Function Two(x As Integer) As Double',
      'End Function',
    ].join('\n'), 'M');
    expect(m.name).toBe('M');
    expect(m.optionExplicit).toBe(true);
    expect(m.variables.map(v => [v.name, v.scope])).toEqual([['a', 'dim'], ['b', 'dim'], ['c', 'dim'], ['d', 'private'], ['e', 'public']]);
    expect(m.variables[0].type).toBe('Integer');
    expect(m.variables[1]).toMatchObject({ isArray: true, type: 'String' });
    expect(m.variables[2].type).toBeUndefined();
    expect(m.variables[4]).toMatchObject({ isNew: true, type: { objectType: 'Collection' } });
    expect(m.consts.map(c => [c.name, c.scope, c.type])).toEqual([['K', 'private', undefined], ['L', 'public', 'Long'], ['M', 'public', 'String']]);
    expect(m.procedures.map(p => [p.kind, p.name, p.visibility, p.returnType])).toEqual([['sub', 'One', 'public', undefined], ['function', 'Two', 'public', 'Double']]);
  });
  test('optionExplicit defaults to false', () => expect(parseModule('Sub A()\nEnd Sub', 'M').optionExplicit).toBe(false));
  test('proc lines', () => {
    const p = parseModule('\nSub A()\n x = 1\nEnd Sub', 'M').procedures[0];
    expect(p.line).toBe(2); expect(p.endLine).toBe(4);
  });
  test('Static Sub and function type suffix', () => {
    const m = parseModule('Static Sub A()\nEnd Sub\nFunction F$(n%)\nEnd Function', 'M');
    expect(m.procedures[0]).toMatchObject({ isStatic: true, visibility: 'public' });
    expect(m.procedures[1].returnType).toBe('String');
    expect(m.procedures[1].params[0].type).toBe('Integer');
  });
  test('params: Optional, defaults, arrays, ByRef', () => {
    const p = parseModule('Sub A(Optional ByVal n As Long = 5, ByRef a() As String, s, Optional t)\nEnd Sub', 'M').procedures[0];
    expect(p.params[0]).toMatchObject({ name: 'n', byRef: false, optional: true, type: 'Long' });
    expect(ex(p.params[0].defaultValue!)).toBe('5');
    expect(p.params[1]).toMatchObject({ name: 'a', byRef: true, isArray: true, type: 'String', optional: false });
    expect(p.params[2]).toMatchObject({ name: 's', byRef: true, optional: false, isArray: false });
    expect(p.params[2].type).toBeUndefined();
    expect(p.params[3].optional).toBe(true);
  });
  test('Sub without parentheses', () => expect(parseModule('Sub A\nEnd Sub', 'M').procedures[0].params).toEqual([]));
  test('user type and enum names resolve in As clauses', () => {
    const m = parseModule('Type P\n X As Integer\nEnd Type\nEnum Farge\n Rod\nEnd Enum\nDim a As P, b As Farge, c As TextBox, d As Form, e As Object', 'M');
    expect(m.variables.map(v => v.type)).toEqual([{ userType: 'P' }, 'Long', { objectType: 'TextBox' }, { objectType: 'Form' }, 'Object']);
  });
  test('user type used before its declaration', () => {
    const m = parseModule('Dim a As P\nType P\n X As Integer\nEnd Type', 'M');
    expect(m.variables[0].type).toEqual({ userType: 'P' });
  });
  test('type fields incl arrays and fixed strings', () => {
    const m = parseModule('Public Type P\n Name As String * 20\n V(1 To 3) As Integer\n N As Long\nEnd Type', 'M');
    expect(m.types[0]).toMatchObject({ name: 'P', visibility: 'public' });
    expect(m.types[0].fields.map(f => f.name)).toEqual(['Name', 'V', 'N']);
    expect(m.types[0].fields[0]).toMatchObject({ type: 'String', fixedLength: 20 });
    expect(m.types[0].fields[1]).toMatchObject({ isArray: true, type: 'Integer' });
  });
  test('enum values: explicit, auto-increment, expressions', () => {
    const m = parseModule('Private Enum E\n A\n B = 5\n C\n D = B * 2 + 1\n E = -1\n F\nEnd Enum', 'M');
    expect(m.enums[0].visibility).toBe('private');
    expect(m.enums[0].members.map(x => x.value)).toEqual([0, 5, 6, 11, -1, 0]);
  });
  test('enum non-constant value is an error', () => expect(err('Enum E\n A = x\nEnd Enum')).toBe('Constant expression required'));
  test('executable statement outside procedure', () => expect(err('x = 1')).toBe('Invalid outside procedure'));
  test('Option Explicit inside procedure', () => expect(berr('Option Explicit')).toBe('Invalid inside procedure'));
  test('Option Explicit after a procedure', () => expect(err('Sub A()\nEnd Sub\nOption Explicit')).toBe('Option Explicit must precede any procedure'));
  test('unsupported Option', () => expect(err('Option Strict')).toBe('Not supported in VibeBasic: Option Strict'));
  test('missing End Sub / End Function', () => {
    expect(err('Sub A()\nx = 1')).toBe('Expected: End Sub');
    expect(err('Function F()\nx = 1')).toBe('Expected: End Function');
    expect(err('Sub A()\nEnd Function')).toBe('Expected: End Sub');
  });
  test('missing End Sub before the next procedure', () => {
    expect(err('Sub A()\nx = 1\nSub B()\nEnd Sub')).toBe('Expected: End Sub');
    expect(err('Function F()\nx = 1\nPrivate Sub B()\nEnd Sub')).toBe('Expected: End Function');
    expect(err('Sub A()\nx = 1\nPublic Function B()\nEnd Function')).toBe('Expected: End Sub');
    expect(berr('Type T')).toBe('Invalid inside procedure');
  });
  test('missing identifier / paren', () => {
    expect(err('Sub (x)\nEnd Sub')).toBe('Expected: identifier');
    expect(err('Sub A(x\nEnd Sub')).toBe('Expected: )');
  });
  test('unsupported at module level', () => {
    expect(err('Declare Function F Lib "x" () As Long')).toBe('Not supported in VibeBasic: Declare');
    expect(err('Public Declare Function F Lib "x" () As Long')).toBe('Not supported in VibeBasic: Declare');
  });
  test('class module syntax: Property, Event, Implements, WithEvents, Friend', () => {
    const m = parseModule([
      'Implements IFoo', 'Public Event Changed(ByVal n As Long)', 'Private WithEvents w As Worker',
      'Friend Property Get X(ByVal i As Integer) As Long', '  Exit Property', 'End Property',
      'Public Property Let X(ByVal i As Integer, ByVal v As Long)', '  RaiseEvent Changed(v)', 'End Property',
    ].join('\n'), 'C');
    expect(m.implements).toEqual(['IFoo']);
    expect(m.events!.map(e => [e.name, e.params.length])).toEqual([['Changed', 1]]);
    expect(m.variables[0]).toMatchObject({ name: 'w', withEvents: true });
    expect(m.procedures.map(p => [p.name, p.kind, p.property, p.visibility, p.params.length])).toEqual([
      ['X', 'function', 'get', 'public', 1], ['X', 'sub', 'let', 'public', 2]]);
    expect(m.procedures[1].body[0]).toMatchObject({ kind: 'raiseEvent', name: 'Changed' });
    expect(err('Property Let X()\nEnd Property')).toMatch(/^Definitions of property procedures/);
    expect(err('Property Get X()\nEnd Sub')).toBe('Expected: End Property');
    expect(err('Sub A()\n  Dim WithEvents w As Worker\nEnd Sub')).toBe('Only valid in object module');
  });
  test('Dim with Static/array bounds and As New', () => {
    const d = one('Static a(1 To 5, 3) As Integer, b() As String, c As New Collection') as any;
    expect(d.kind).toBe('dim');
    expect(d.decls.map((x: any) => x.scope)).toEqual(['static', 'static', 'static']);
    expect(d.decls[0].bounds.map((b: any) => [b.lower && ex(b.lower), ex(b.upper)])).toEqual([['1', '5'], [undefined, '3']]);
    expect(d.decls[1]).toMatchObject({ isArray: true, type: 'String' });
    expect(d.decls[1].bounds).toBeUndefined();
    expect(d.decls[2].isNew).toBe(true);
  });
});

// ---- statements ----

describe('statements', () => {
  test('assignment and call distinction', () => {
    const b = body('x = 1\nText1.Text = "a"\na(1) = 2\nLet y = 3\nSet o = Nothing\nSet f = New Form2');
    expect(b.map(s => s.kind)).toEqual(Array(6).fill('assign'));
    expect((b[0] as any).isSet).toBe(false);
    expect(ex((b[1] as any).target)).toBe('(. Text1 Text)');
    expect(ex((b[2] as any).target)).toBe('(call a 1)');
    expect((b[3] as any).isSet).toBe(false);
    expect((b[4] as any).isSet).toBe(true);
    expect(ex((b[5] as any).value)).toBe('(new Form2)');
  });
  test('with member assignment', () => {
    const s = one('With Text1\n.Text = "x"\n.SetFocus\nEnd With') as any;
    expect(s.kind).toBe('with'); expect(ex(s.object)).toBe('Text1');
    expect(s.body.map((x: Stmt) => x.kind)).toEqual(['assign', 'call']);
    expect(ex(s.body[0].target)).toBe('(with. Text)');
  });
  test('call statements', () => {
    const b = body('Foo\nFoo 1, 2\nCall Foo(1)\nCall Bar\nForm2.Show vbModal\nText1.SetFocus\nFoo (x)\nFoo (x), y\nList1.AddItem "x"') as any[];
    expect(b.every(s => s.kind === 'call')).toBe(true);
    expect(b.map(s => [ex(s.target), s.args.map(ex), s.explicitCall])).toEqual([
      ['Foo', [], false],
      ['Foo', ['1', '2'], false],
      ['Foo', ['1'], true],
      ['Bar', [], true],
      ['(. Form2 Show)', ['vbModal'], false],
      ['(. Text1 SetFocus)', [], false],
      ['Foo', ['x'], false],
      ['Foo', ['x', 'y'], false],
      ['(. List1 AddItem)', ['"x"'], false],
    ]);
  });
  test('paren-less call with missing args', () => {
    const s = one('MsgBox "x", , "t"') as any;
    expect(s.args.map(ex)).toEqual(['"x"', '<missing>', '"t"']);
  });
  test('paren-less call with an omitted first argument', () => {
    const s = one('Panels.Add , "k", "t"') as any;
    expect(s.args.map(ex)).toEqual(['<missing>', '"k"', '"t"']);
  });
  test('call stops at colon, comment and Else', () => {
    expect(body('Foo 1: Bar 2').map(s => s.kind)).toEqual(['call', 'call']);
    expect((one("Foo 1 ' note") as any).args).toHaveLength(1);
    const i = one('If a Then Foo 1 Else Bar 2') as any;
    expect(i.branches[0].body[0].args.map(ex)).toEqual(['1']);
    expect(i.elseBody[0].args.map(ex)).toEqual(['2']);
  });
  test('Me members', () => {
    const b = body('Me.Caption = "x"\nMe.Hide') as any[];
    expect([b[0].kind, b[1].kind]).toEqual(['assign', 'call']);
  });
  test('comments, blank lines, colon-separated statements, Rem', () => {
    expect(body("' c\n\nx = 1: y = 2 ' trailing\nRem old\n").map(s => s.kind)).toEqual(['assign', 'assign']);
  });
  test('line continuation', () => {
    const s = one('MsgBox "a", _\n  vbInformation') as any;
    expect(s.args).toHaveLength(2);
  });
  test('Const in procedure', () => {
    const s = one('Const Pi = 3.14, N As Integer = 2') as any;
    expect(s.kind).toBe('const');
    expect(s.decls.map((d: any) => [d.name, d.type, ex(d.value)])).toEqual([['Pi', undefined, '3.14'], ['N', 'Integer', '2']]);
  });
  test('ReDim / Erase', () => {
    const b = body('ReDim a(1 To 5, 3)\nReDim Preserve b(10) As String, c(2)\nErase a, b') as any[];
    expect(b[0]).toMatchObject({ kind: 'redim', preserve: false });
    expect(b[0].decls[0].bounds).toHaveLength(2);
    expect(b[1]).toMatchObject({ kind: 'redim', preserve: true });
    expect(b[1].decls.map((d: any) => d.name)).toEqual(['b', 'c']);
    expect(b[1].decls[0].type).toBe('String');
    expect(b[2].targets.map(ex)).toEqual(['a', 'b']);
  });
  test('block If / ElseIf / Else', () => {
    const s = one('If a Then\nx = 1\nElseIf b Then\nx = 2\nElse\nx = 3\nEnd If') as any;
    expect(s).toMatchObject({ kind: 'if', singleLine: false });
    expect(s.branches.map((b: any) => ex(b.cond))).toEqual(['a', 'b']);
    expect(s.branches.map((b: any) => b.body.length)).toEqual([1, 1]);
    expect(s.elseBody).toHaveLength(1);
  });
  test('single-line If with several statements, Else and GoTo', () => {
    const s = one('If a Then x = 1: y = 2 Else z = 3') as any;
    expect(s.singleLine).toBe(true);
    expect(s.branches[0].body).toHaveLength(2); expect(s.elseBody).toHaveLength(1);
    const g = one('If a Then 100') as any;
    expect(g.branches[0].body[0]).toMatchObject({ kind: 'goto', label: '100' });
    const e = one('If a Then Exit Sub') as any;
    expect(e.branches[0].body[0]).toMatchObject({ kind: 'exit', what: 'sub' });
  });
  test('If with comment after Then is a block If', () => {
    expect((one("If a Then ' c\nx = 1\nEnd If") as any).singleLine).toBe(false);
  });
  test('nested ifs', () => {
    const s = one('If a Then\nIf b Then\nx = 1\nEnd If\nElse\ny = 2\nEnd If') as any;
    expect(s.branches[0].body[0].kind).toBe('if'); expect(s.elseBody).toHaveLength(1);
  });
  test('Select Case', () => {
    const s = one('Select Case n\nCase 1, 2, 5 To 9, Is > 20\nx = 1\nCase "a"\nCase Else\nx = 3\nEnd Select') as any;
    expect(ex(s.subject)).toBe('n');
    expect(s.cases).toHaveLength(2);
    expect(s.cases[0].tests.map((t: any) => t.kind)).toEqual(['value', 'value', 'range', 'is']);
    expect(ex(s.cases[0].tests[2].from)).toBe('5'); expect(ex(s.cases[0].tests[2].to)).toBe('9');
    expect(s.cases[0].tests[3]).toMatchObject({ op: '>' });
    expect(s.cases[0].body).toHaveLength(1); expect(s.cases[1].body).toHaveLength(0);
    expect(s.elseBody).toHaveLength(1);
  });
  test('Select Case with no cases and statement before Case', () => {
    expect((one('Select Case n\nEnd Select') as any).cases).toEqual([]);
    expect(berr('Select Case n\nx = 1\nCase 1\nEnd Select')).toBe('Expected: Case');
  });
  test('For / Step / Next var', () => {
    const s = one('For i = 10 To 1 Step -1\nx = i\nNext i') as any;
    expect(s).toMatchObject({ kind: 'for' }); expect(ex(s.variable)).toBe('i');
    expect([ex(s.from), ex(s.to), ex(s.step)]).toEqual(['10', '1', '(neg 1)']);
    expect(s.body).toHaveLength(1);
  });
  test('Next i, j closes two loops', () => {
    const s = one('For i = 1 To 2\nFor j = 1 To 2\nNext j, i') as any;
    expect(s.body[0].kind).toBe('for');
  });
  test('Next with wrong variable', () => expect(berr('For i = 1 To 2\nNext j')).toBe('Next without For'));
  test('For Each', () => {
    const s = one('For Each c In Me.Controls\nNext c') as any;
    expect(s.kind).toBe('forEach'); expect(ex(s.variable)).toBe('c'); expect(ex(s.collection)).toBe('(. Me Controls)');
  });
  test('Do variants', () => {
    const b = body('Do\nLoop\nDo While a\nLoop\nDo Until a\nLoop\nDo\nLoop While b\nDo\nLoop Until c') as any[];
    expect(b.map(s => s.test && [s.test.mode, ex(s.test.expr), s.test.atEnd])).toEqual([
      undefined, ['while', 'a', false], ['until', 'a', false], ['while', 'b', true], ['until', 'c', true]]);
  });
  test('Do with both pre and post condition', () => expect(berr('Do While a\nLoop While b')).toBe('Syntax error'));
  test('While/Wend', () => {
    const s = one('While a < 3\na = a + 1\nWend') as any;
    expect(s.kind).toBe('while'); expect(s.body).toHaveLength(1);
  });
  test('Exit', () => {
    const b = body('Exit For\nExit Do\nExit Sub\nExit Function') as any[];
    expect(b.map(s => s.what)).toEqual(['for', 'do', 'sub', 'function']);
  });
  test('On Error / Resume / GoTo / labels', () => {
    const b = body('On Error Resume Next\nOn Error GoTo 0\nOn Error GoTo Oops\nResume\nResume Next\nResume Retry\nGoTo Done\nRetry:\n10\nDone:') as any[];
    expect(b.map(s => s.kind)).toEqual(['onError', 'onError', 'onError', 'resume', 'resume', 'resume', 'goto', 'label', 'label', 'label']);
    expect(b[0].mode).toBe('resumeNext'); expect(b[1].mode).toBe('goto0');
    expect(b[2]).toMatchObject({ mode: 'goto', label: 'Oops' });
    expect(b.slice(3, 6).map(s => [s.mode, s.label])).toEqual([['resume', undefined], ['next', undefined], ['label', 'Retry']]);
    expect(b[6].label).toBe('Done');
    expect(b[7].name).toBe('Retry'); expect(b[8].name).toBe('10');
  });
  test('line number label followed by statement; label followed by statement', () => {
    expect(body('10 x = 1\nRetry: y = 2').map(s => s.kind)).toEqual(['label', 'assign', 'label', 'assign']);
  });
  test('call to a Sub named like a label in single-line If is a call', () => {
    expect((one('If a Then Foo: x = 1') as any).branches[0].body.map((s: Stmt) => s.kind)).toEqual(['call', 'assign']);
  });
  test('End, Stop, Unload, Load', () => {
    const b = body('End\nStop\nUnload Me\nLoad Form2') as any[];
    expect(b.map(s => s.kind)).toEqual(['end', 'stop', 'unload', 'load']);
    expect(ex(b[2].target)).toBe('Me'); expect(ex(b[3].target)).toBe('Form2');
  });
  test('Debug.Print', () => {
    const b = body('Debug.Print\nDebug.Print a; b, c;\nDebug.Print "x"\nDebug.Print ,\nDebug.Print a, , b') as any[];
    const sh = (s: any) => s.items.map((i: any) => [i.expr ? ex(i.expr) : null, i.sep ?? null]);
    expect(b.every(s => s.kind === 'debugPrint')).toBe(true);
    expect(b[0].items).toEqual([]);
    expect(sh(b[1])).toEqual([['a', ';'], ['b', ','], ['c', ';']]);
    expect(sh(b[2])).toEqual([['"x"', null]]);
    expect(sh(b[3])).toEqual([[null, ',']]);
    expect(sh(b[4])).toEqual([['a', ','], [null, ','], ['b', null]]);
  });
  test('Debug.Assert is a statement; other Debug members stay calls', () => {
    expect(one('Debug.Assert x').kind).toBe('debugAssert');
    expect(one('Debug.Foo x').kind).toBe('call');
  });
  test('statement keywords are case-insensitive', () => {
    expect(body('IF a THEN\nX = 1\nend if').map(s => s.kind)).toEqual(['if']);
  });
  test('line numbers', () => {
    const b = body('x = 1\nIf a Then\ny = 2\nEnd If') as any[];
    expect(b[0].line).toBe(2); expect(b[1].line).toBe(3); expect(b[1].branches[0].body[0].line).toBe(4);
  });
});

describe('realistic programs', () => {
  test('typical form code parses', () => {
    const src = [
      'Option Explicit',
      'Private Const MAXN = 10',
      'Dim total As Long',
      'Dim names(1 To MAXN) As String',
      '',
      'Private Sub Form_Load()',
      '    Dim i As Integer',
      '    On Error GoTo Oops',
      '    For i = 1 To MAXN',
      '        names(i) = "N" & i',
      '        If i Mod 2 = 0 Then total = total + i Else total = total - 1',
      '    Next i',
      '    Select Case total',
      '        Case 1: Label1.Caption = "one"',
      '        Case Is > 5, 2 To 3',
      '            Label1.Caption = "many"',
      '        Case Else: Label1 = "?"',
      '    End Select',
      '    Do While total > 0: total = total - 1: Loop',
      '    MsgBox "Total: " & total, vbInformation, "Result"',
      '    Text1.Text = Text1.Text & Chr(13) & Chr(10)',
      '    Debug.Print "t="; total, Len(names(1))',
      '    Exit Sub',
      'Oops:',
      '    MsgBox Err.Description',
      '    Resume Next',
      'End Sub',
      '',
      'Function Add(a As Integer, Optional b As Integer = 1) As Integer',
      '    Add = a + b',
      'End Function',
      '',
      "Private Sub Command1_Click() ' handler",
      '    Form2.Show vbModal',
      '    Unload Me',
      'End Sub',
    ].join('\n');
    expect(findSyntaxErrors(src, 'Form1')).toEqual([]);
    const m = parseModule(src, 'Form1');
    expect(m.procedures.map(p => p.name)).toEqual(['Form_Load', 'Add', 'Command1_Click']);
    const sel = m.procedures[0].body.find(s => s.kind === 'select') as any;
    expect(sel.cases.map((c: any) => c.body.length)).toEqual([1, 1]);
    expect(sel.elseBody).toHaveLength(1);
    expect(m.procedures[0].body.find(s => s.kind === 'do')).toMatchObject({ test: { mode: 'while' } });
  });
  test('Else on its own line with colon statement', () => {
    const s = one('If a Then\nx = 1\nElse: x = 2\nEnd If') as any;
    expect(s.elseBody).toHaveLength(1);
  });
});

describe('syntax errors', () => {
  test('stray closers', () => {
    expect(berr('End If')).toBe('End If without block If');
    expect(berr('Loop')).toBe('Loop without Do');
    expect(berr('Wend')).toBe('Wend without While');
    expect(berr('Else')).toBe('Else without If');
    expect(berr('Case 1')).toBe('Case without Select Case');
    expect(berr('End Select')).toBe('End Select without Select Case');
    expect(berr('End With')).toBe('End With without With');
  });
  test('unclosed blocks', () => {
    expect(berr('Do')).toBe('Do without Loop');
    expect(berr('While x')).toBe('While without Wend');
    expect(berr('Select Case x')).toBe('Select Case without End Select');
    expect(berr('With x')).toBe('With without End With');
    expect(err('Sub A()\nIf x Then\nx = 1')).toBe('Block If without End If');
  });
  test('wrong closer nesting reports the opener', () => {
    expect(berr('For i = 1 To 2\nIf x Then\nNext i\nEnd If')).toBe('Block If without End If');
  });
  test('error positions', () => {
    const at = (src: string) => {
      try { parseModule(src, 'M'); } catch (e) { return [(e as VBSyntaxError).line, (e as VBSyntaxError).col]; }
      throw new Error('expected a syntax error');
    };
    expect(at('Sub A()\nx = 1 2\nEnd Sub')).toEqual([2, 7]);
    expect(at('Sub A()\nIf x Then\nEnd Sub')[0]).toBe(2);
    expect(at('Sub A()\nx = 1\nSub B()\nEnd Sub')[0]).toBe(3);
  });
  test('Next with more names than open loops', () => {
    expect(berr('For j = 1 To 2\nNext j, i')).toBe('Next without For');
    expect(berr('Next j, i')).toBe('Next without For');
    expect(berr('For i = 1 To 2\nFor j = 1 To 2\nNext j, i, k')).toBe('Next without For');
  });
  test('missing Then', () => expect(berr('If x\nEnd If')).toBe('Expected: Then'));
  test('missing To', () => expect(berr('For i = 1\nNext')).toBe('Expected: To'));
  test('junk after block header', () => expect(berr('For i = 1 To 2 x\nNext')).toBe('Expected: end of statement'));
  test('junk after End If', () => expect(berr('If a Then\nEnd If x')).toBe('Expected: end of statement'));
  test('expected identifier', () => {
    expect(berr('For = 1 To 2\nNext')).toBe('Expected: identifier');
    expect(berr('Dim 5')).toBe('Expected: identifier');
  });
  test('expected )', () => expect(berr('x = f(1')).toBe('Expected: )'));
  test('lexer errors surface', () => expect(berr('x = "abc')).toBe('Unterminated string'));
  test('Not supported statements', () => {
    expect(berr('Print "hi"')).toBe('Not supported in VibeBasic: Print');
    expect(berr('Line (0, 0)-(10, 10)')).toBe('Not supported in VibeBasic: Line');
    expect(berr('Circle (5, 5), 3')).toBe('Not supported in VibeBasic: Circle');
    expect(berr('PSet (5, 5)')).toBe('Not supported in VibeBasic: PSet');
    expect(berr('Declare Foo')).toBe('Not supported in VibeBasic: Declare');
  });
  test('file I/O statements', () => {
    const b = body('Open App.Path & "\\x.dat" For Random Access Read Write Lock Write As #f Len = 20\nClose\nClose #1, 2\n'
      + 'Print #1, a; Spc(2); Tab(5); b, Tab\nWrite #1, a, b;\nInput #1, a, b(1)\nLine Input #1, s\nGet #1, , r\nPut 1, 3, r\n'
      + 'Seek #1, 10\nSeek 1, 10\nName "a" As "b"\nName = 5');
    expect(b.map(s => s.kind)).toEqual(['open', 'close', 'close', 'printFile', 'writeFile', 'inputFile', 'lineInput', 'getFile', 'putFile',
      'seekFile', 'seekFile', 'name', 'assign']);
    expect(b[0]).toMatchObject({ mode: 'random', access: 'readwrite', recLen: { kind: 'number', value: 20 } });
    expect((b[3] as { items: unknown[] }).items).toHaveLength(5);
    expect(berr('Open "f" For Reading As #1')).toBe('Expected: Input, Output, Append, Binary or Random');
  });
  test('variables named Line/Print are still assignable', () => {
    expect(body('Line = 5\nPrint.x = 1').map(s => s.kind)).toEqual(['assign', 'assign']);
  });
  test('first error is thrown, not later ones', () => expect(berr('x = \ny = 1 2')).toBe('Expected: expression'));
});

describe('checkLineSyntax', () => {
  test.each([
    'If x Then', 'If x Then y = 1 Else y = 2', 'ElseIf x Then', 'Else', 'End If',
    'Next', 'Next i', 'Next j, i', 'Loop', 'Loop While x', 'Wend', 'End With', 'End Select', 'End Sub', 'End Function', 'End Type', 'End Enum',
    'For i = 1 To 2', 'For Each c In coll', 'Do', 'Do While x', 'While x', 'With Text1', 'Select Case n', 'Case 1, 2', 'Case Is > 3', 'Case Else',
    'Sub A()', 'Private Sub Command1_Click(Index As Integer)', 'Public Function F(x) As Long', 'Type P', 'Public Enum E',
    'Static Sub A()', 'X As Integer', 'V(1 To 3) As Integer', 'Rod = 1', 'Dim x As Integer', 'Option Explicit', 'Private x As Long', 'Const A = 1',
    'x = 1: y = 2', "' just a comment", '', 'Retry:', 'Debug.Print a; b', 'Foo 1, 2', 'End', 'Exit Sub',
    'Open "f" For Input As #1', 'Close #1, #2', 'Line Input #1, s', 'Get #1, , x',
  ])('valid: %s', line => expect(checkLineSyntax(line)).toBeNull());

  test.each([
    ['x = ', 'Expected: expression'],
    ['x = 1 2', 'Expected: end of statement'],
    ['If x', 'Expected: Then'],
    ['For i = 1', 'Expected: To'],
    ['Print "x"', 'Not supported in VibeBasic: Print'],
    ['Declare Foo', 'Not supported in VibeBasic: Declare'],
    ['x = f(1', 'Expected: )'],
    ['x = "abc', 'Unterminated string'],
    ['End If x', 'Expected: end of statement'],
  ])('invalid: %s', (line, msg) => {
    const e = checkLineSyntax(line);
    expect(e).toBeInstanceOf(VBSyntaxError);
    expect(e!.message).toBe(msg);
  });
  test('error position', () => {
    const e = checkLineSyntax('x = 1 2')!;
    expect([e.line, e.col]).toEqual([1, 7]);
  });
  test('state does not leak between calls', () => {
    expect(checkLineSyntax('Next j, i')).toBeNull();
    expect(checkLineSyntax('x = 1')).toBeNull();
  });
});

describe('findSyntaxErrors', () => {
  const lines = (src: string) => findSyntaxErrors(src, 'M').map(e => [e.line, e.message]);
  test('no errors', () => expect(findSyntaxErrors('Sub A()\nx = 1\nEnd Sub', 'M')).toEqual([]));
  test('collects errors across procedures', () => {
    expect(lines('Sub A()\nx = \nEnd Sub\nSub B()\ny = 1 2\nEnd Sub')).toEqual([[2, 'Expected: expression'], [5, 'Expected: end of statement']]);
  });
  test('errors inside blocks do not break structure', () => {
    expect(lines('Sub A()\nIf x Then\ny = \nEnd If\nz = 1 2\nEnd Sub')).toEqual([[3, 'Expected: expression'], [5, 'Expected: end of statement']]);
  });
  test('unclosed block reported at the opener, rest continues', () => {
    expect(lines('Sub A()\nFor i = 1 To 2\nEnd Sub\nSub B()\nx = \nEnd Sub')).toEqual([[2, 'For without Next'], [5, 'Expected: expression']]);
  });
  test('stray Next', () => expect(lines('Sub A()\nNext\nx = 1\nEnd Sub')).toEqual([[2, 'Next without For']]));
  test('lexer error lines are reported together with parse errors', () => {
    expect(lines('Sub A()\nx = "abc\ny = \nEnd Sub')).toEqual([[2, 'Unterminated string'], [3, 'Expected: expression']]);
  });
  test('module-level errors', () => {
    expect(lines('x = 1\nSub A()\nEnd Sub\ny = 2')).toEqual([[1, 'Invalid outside procedure'], [4, 'Invalid outside procedure']]);
  });
  test('bad proc header still parses body', () => {
    expect(lines('Sub (x)\ny = \nEnd Sub')).toEqual([[1, 'Expected: identifier'], [2, 'Expected: expression']]);
  });
  test('errors are VBSyntaxErrors with columns', () => {
    const e = findSyntaxErrors('Sub A()\nx = 1 2\nEnd Sub', 'M')[0];
    expect(e).toBeInstanceOf(VBSyntaxError); expect(e.col).toBe(7);
  });
  test('missing End Sub at eof', () => expect(lines('Sub A()\nx = 1')).toEqual([[2, 'Expected: End Sub']]));
  test('missing End Sub before the next procedure reports once', () => {
    expect(lines('Sub A()\nx = 1\nSub B()\nEnd Sub')).toEqual([[3, 'Expected: End Sub']]);
  });
  test('Next with more names than open loops terminates', () => {
    expect(lines('Sub A()\nFor j=1 To 2\nNext j, i\nEnd Sub')).toEqual([[3, 'Next without For']]);
    expect(lines('Sub A()\nNext j, i\nEnd Sub')).toEqual([[2, 'Next without For']]);
    expect(lines('Sub A()\nFor i = 1 To 2\nFor j = 1 To 2\nNext j, i, k\nEnd Sub')).toEqual([[2, 'For without Next'], [4, 'Next without For']]);
  });
  test.each([
    'Sub A()\nNext i, j, k\nNext',
    'Sub A()\nFor i = 1 To 2\nIf x Then\nNext i, j\nEnd If\nEnd Sub',
    'Sub A()\nDo\nFor i = 1 To 2\nLoop\nNext i, j\nEnd Sub',
    'Sub A()\nWith x\nSelect Case y\nEnd With\nEnd Sub',
    'Sub A()\nIf x Then\nElse\nElse\nEnd If\nEnd Sub',
    'Sub A()\nFor Each a In b\nNext a, b, c\nFor i = 1 To 2: Next i, j\nEnd Sub',
    'Sub A(\nEnd Sub\nSub B()\nSub C()',
    'Type T\nX As\nEnum E\nA = \nEnd Enum',
    'End Sub\nEnd If\nNext\nLoop\nWend',
  ])('terminates on malformed input %#', src => {
    expect(() => findSyntaxErrors(src, 'M')).not.toThrow();
  });
});

describe('final review fixes', () => {
  const show = (src: string) => (parseModule(`Sub A()\n${src}\nEnd Sub`, 'M').procedures[0].body as Stmt[]).map(s =>
    s.kind === 'call' ? `call ${exprToString(s.target)}: ${s.args.map(a => (a.kind === 'missing' ? '_' : exprToString(a))).join(' ; ')}`
      : s.kind === 'assign' ? `${exprToString(s.target)} = ${exprToString(s.value)}` : s.kind);

  test('a paren-less call may start with a negative (or signed) argument', () => {
    expect(show('List1.AddItem -5\nPicture1.Move -100, 0\nFoo -1\nFoo +x, 2\nx = y - 1\nx = -1'))
      .toEqual(['call (. List1 AddItem): (neg 5)', 'call (. Picture1 Move): (neg 100) ; 0', 'call Foo: (neg 1)', 'call Foo: x ; 2', 'x = (- y 1)', 'x = (neg 1)']);
    for (const line of ['List1.AddItem -5', 'Picture1.Move -100, 0', 'Foo -1', 'Foo -1, -2']) expect(checkLineSyntax(line)).toBeNull();
    expect(findSyntaxErrors('Sub A()\nList1.AddItem -5\nPicture1.Move -100, 0\nEnd Sub', 'M')).toEqual([]);
  });

  test('syntax errors carry the module name', () => {
    try {
      parseModule('Sub A()\nx = \nEnd Sub', 'Form2');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(VBSyntaxError);
      expect((e as VBSyntaxError).moduleName).toBe('Form2');
      expect((e as VBSyntaxError).line).toBe(2);
    }
    expect(findSyntaxErrors('Sub A()\nx = \nEnd Sub\nx = "', 'Module3').map(e => [e.moduleName, e.line])).toEqual([['Module3', 2], ['Module3', 4]]);
  });
});
