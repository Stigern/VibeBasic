// Interpreter behaviour that golden output alone cannot pin down: the driver
// (slicing, awaiting host promises, end), ByRef through runEvent, scopes
// across modules, recursion limit, and assorted statement semantics.

import { Program, type SourceModule } from '../../src/lang/interp/program';
import { VBRef, type VBValue } from '../../src/lang/values';
import type { VBObject } from '../../src/lang/host';
import { VBRuntimeError } from '../../src/lang/errors';
import { TestHost, TEST_OPTIONS } from './testHost';

function program(src: string | SourceModule[], host = new TestHost(), sliceSize?: number) {
  const mods = typeof src === 'string' ? [{ name: 'Module1', kind: 'module' as const, source: src }] : src;
  return { host, prog: new Program(mods, host, { ...TEST_OPTIONS, sliceSize }) };
}

async function run(src: string | SourceModule[], proc = 'Main', host = new TestHost()): Promise<string[]> {
  const { prog } = program(src, host);
  await prog.runEvent('Module1', proc);
  return host.lines();
}

const lines = (...l: string[]) => l.join('\n');

describe('driver', () => {
  test('long loops yield to the event loop every sliceSize statements', async () => {
    const src = lines('Sub Main()', '  Dim i As Long, s As Long', '  For i = 1 To 5000', '    s = s + i', '  Next', '  Debug.Print s', 'End Sub');
    const order: string[] = [];
    const { prog, host } = program(src, new TestHost(), 100);
    setTimeout(() => order.push('timer'), 0);
    await prog.runEvent('Module1', 'Main').then(() => order.push('done'));
    expect(order).toEqual(['timer', 'done']);
    expect(host.lines()).toEqual([' 12502500 ']);
  });

  test('a short handler runs without giving up the thread', async () => {
    const { prog } = program(lines('Sub Main()', '  Dim i As Integer', '  i = 1', 'End Sub'));
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    await prog.runEvent('Module1', 'Main').then(() => order.push('done'));
    expect(order).toEqual(['done']);
  });

  test('promises from host objects are awaited, also in expressions', async () => {
    const log: string[] = [];
    const obj: VBObject = {
      vbTypeName: 'Fake',
      hasMember: () => false,
      getMember: () => 0,
      setMember: () => {},
      callMethod: (name: string, args: VBValue[]) => new Promise<VBValue>(resolve => setTimeout(() => {
        log.push(name);
        resolve(name === 'Twice' ? (args[0] as number) * 2 : 0);
      }, 5)),
    };
    const host = new TestHost();
    host.objects.set('fake', obj);
    const out = await run(lines('Sub Main()', '  Fake.Wait', '  Debug.Print Fake.Twice(21)', 'End Sub'), 'Main', host);
    expect(log).toEqual(['Wait', 'Twice']);
    expect(out).toEqual([' 42 ']);
  });

  test('end() stops an endless loop and calls onEnd once', async () => {
    const { prog, host } = program(lines('Sub Spin()', '  Do', '  Loop', 'End Sub'), new TestHost(), 1000);
    setTimeout(() => prog.end(), 20);
    await prog.runEvent('Module1', 'Spin');
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });

  test('state goes idle → idle after a normal run, ended after an error', async () => {
    const { prog, host } = program(lines('Sub Ok()', 'End Sub', 'Sub Bad()', '  Debug.Print 1 / 0', 'End Sub'));
    expect(prog.state).toBe('idle');
    await prog.runEvent('Module1', 'Ok');
    expect(prog.state).toBe('idle');
    await prog.runEvent('Module1', 'Bad');
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
    expect(host.lines()).toEqual(['[Error 11 at Module1:4] Division by zero']);
    await prog.runEvent('Module1', 'Ok'); // ignored after the end
    expect(host.endCalls).toBe(1);
  });

  test('End statement ends the program', async () => {
    const { prog, host } = program(lines('Sub Main()', '  Debug.Print "a"', '  End', '  Debug.Print "b"', 'End Sub'));
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual(['a']);
    expect(prog.state).toBe('ended');
    expect(host.endCalls).toBe(1);
  });

  test('debug answer to an error is treated as end for now', async () => {
    const host = new TestHost();
    host.errorChoice = 'debug';
    const { prog } = program(lines('Sub Main()', '  Debug.Print 1 / 0', '  Debug.Print "after"', 'End Sub'), host);
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual(['[Error 11 at Module1:2] Division by zero']);
    expect(prog.state).toBe('ended');
  });

  test('requestPause breaks at the next boundary of a running loop', async () => {
    const host = new TestHost();
    host.breakChoice = 'end';
    const { prog } = program(lines('Sub Spin()', '  Do', '  Loop', 'End Sub'), host, 1000);
    setTimeout(() => prog.requestPause(), 20);
    await prog.runEvent('Module1', 'Spin');
    expect(host.breaks).toHaveLength(1);
    expect(host.breaks[0].reason).toBe('pause');
    expect(host.breaks[0].at).toEqual({ moduleName: 'Module1', procName: 'Spin', line: 2 });
    expect(prog.state).toBe('ended');
  });

  test('Stop enters break mode; continue resumes after it', async () => {
    const host = new TestHost();
    host.breakChoice = 'continue';
    const { prog } = program(lines('Sub Main()', '  Debug.Print 1', '  Stop', '  Debug.Print 2', 'End Sub'), host);
    await prog.runEvent('Module1', 'Main');
    expect(host.breaks.map(b => b.at.line)).toEqual([3]);
    expect(host.lines()).toEqual([' 1 ', ' 2 ']);
    expect(prog.state).toBe('idle');
  });

  test('hasProcedure and missing handlers', async () => {
    const { prog, host } = program(lines('Sub Form_Load()', 'End Sub'));
    expect(prog.hasProcedure('module1', 'FORM_LOAD')).toBe(true);
    expect(prog.hasProcedure('Module1', 'Nope')).toBe(false);
    await prog.runEvent('Module1', 'Nope');
    expect(host.lines()).toEqual([]);
  });
});

describe('procedures', () => {
  test('ByRef event argument: the handler changes the caller\'s VBRef', async () => {
    const { prog } = program(lines('Sub Text1_KeyPress(KeyAscii As Integer)', '  KeyAscii = 0', 'End Sub'));
    const k = new VBRef(65);
    await prog.runEvent('Module1', 'Text1_KeyPress', [k]);
    expect(k.value).toBe(0);
  });

  test('ByVal event argument is not written back', async () => {
    const { prog } = program(lines('Sub H(ByVal n As Integer)', '  n = 5', 'End Sub'));
    const k = new VBRef(1);
    await prog.runEvent('Module1', 'H', [k]);
    expect(k.value).toBe(1);
  });

  test('event argument converted to the parameter type', async () => {
    const { prog } = program(lines('Sub H(n As Integer)', '  n = n + 1', 'End Sub'));
    const k = new VBRef('41');
    await prog.runEvent('Module1', 'H', [k]);
    expect(k.value).toBe(42);
  });

  test('wrong number of event arguments is reported', async () => {
    const { prog, host } = program(lines('', 'Sub H(a, b)', 'End Sub'));
    await prog.runEvent('Module1', 'H', [new VBRef(1)]);
    expect(host.lines()).toEqual(['[Error 0 at Module1:2] Compile error: Argument not optional']);
  });

  test('ByRef array elements and record fields', async () => {
    expect(await run(lines(
      'Type P', '  X As Integer', 'End Type',
      'Sub Main()',
      '  Dim a(2) As Integer, p As P',
      '  a(1) = 1: a(2) = 2',
      '  Swap a(1), a(2)',
      '  Inc p.X: Inc p.X',
      '  Debug.Print a(1); a(2); p.X',
      'End Sub',
      'Sub Swap(x As Integer, y As Integer)', '  Dim t As Integer', '  t = x: x = y: y = t', 'End Sub',
      'Sub Inc(n As Integer)', '  n = n + 1', 'End Sub',
    ))).toEqual([' 2  1  2 ']);
  });

  test('an array passed ByRef to a Variant parameter is shared', async () => {
    expect(await run(lines(
      'Sub Main()', '  Dim a(1) As Integer', '  Z a', '  Debug.Print a(0)', 'End Sub',
      'Sub Z(v)', '  v(0) = 9', 'End Sub',
    ))).toEqual([' 9 ']);
  });

  test('expression arguments are passed as copies even ByRef', async () => {
    expect(await run(lines(
      'Sub Main()', '  Dim a As Integer', '  a = 1', '  Bump a + 0', '  Bump (a)', '  Debug.Print a', 'End Sub',
      'Sub Bump(n As Integer)', '  n = 99', 'End Sub',
    ))).toEqual([' 99 ']); // `Bump (a)` passes a ByRef: VB6's "parens force ByVal" is not modelled (Task 2 ruling)
  });

  test('Optional parameters with defaults, Exit Sub/Function, Call', async () => {
    expect(await run(lines(
      'Sub Main()',
      '  Debug.Print Greet("Ann"); Greet("Bo", "Hey")',
      '  Call Shout("x")',
      '  Debug.Print Sign(-3); Sign(0); Sign(8)',
      'End Sub',
      'Function Greet(n As String, Optional g As String = "Hi") As String', '  Greet = g & " " & n & ";"', 'End Function',
      'Sub Shout(s)', '  Debug.Print UCaseLike(s)', '  Exit Sub', '  Debug.Print "never"', 'End Sub',
      'Function UCaseLike(s)', '  UCaseLike = s & "!"', 'End Function',
      'Function Sign(n As Integer) As Integer',
      '  If n < 0 Then Sign = -1: Exit Function',
      '  If n = 0 Then Exit Function',
      '  Sign = 1',
      'End Function',
    ))).toEqual(['Hi Ann;Hey Bo;', 'x!', '-1  0  1 ']);
  });

  test('too many arguments and unknown procedures are compile errors', async () => {
    expect(await run(lines('Sub Main()', '  Foo 1', 'End Sub', 'Sub Foo()', 'End Sub')))
      .toEqual(['[Error 0 at Module1:2] Compile error: Wrong number of arguments or invalid property assignment']);
    expect(await run(lines('Sub Main()', '  Nope 1', 'End Sub')))
      .toEqual(['[Error 0 at Module1:2] Compile error: Sub or Function not defined']);
    expect(await run(lines('Option Explicit', 'Sub Main()', '  Dim x', '  x = Nope(1)', 'End Sub')))
      .toEqual(['[Error 0 at Module1:4] Compile error: Sub or Function not defined']);
  });

  test('errors are reported at the line in the callee', async () => {
    expect(await run(lines('Sub Main()', '  Bad', 'End Sub', 'Sub Bad()', '  Dim b As Byte', '  b = 300', 'End Sub')))
      .toEqual(['[Error 6 at Module1:6] Overflow']);
  });

  test('up to 2000 nested calls (Main included) work, one more is error 28', async () => {
    expect(await run(lines(
      'Sub Main()', '  Debug.Print Depth(1998)', 'End Sub',
      'Function Depth(n As Long) As Long', '  If n = 0 Then Depth = 0 Else Depth = 1 + Depth(n - 1)', 'End Function',
    ))).toEqual([' 1998 ']);
    expect(await run(lines(
      'Sub Main()', '  Debug.Print Depth(1999)', 'End Sub',
      'Function Depth(n As Long) As Long', '  If n = 0 Then Depth = 0 Else Depth = 1 + Depth(n - 1)', 'End Function',
    ))).toEqual(['[Error 28 at Module1:5] Out of stack space']);
    expect(await run(lines('Sub Main()', '  Forever 1', 'End Sub', 'Sub Forever(n As Long)', '  Forever n + 1', 'End Sub')))
      .toEqual(['[Error 28 at Module1:5] Out of stack space']);
  });

  test('a function returns the default value when the name is never assigned', async () => {
    expect(await run(lines('Sub Main()', '  Debug.Print "[" & S() & "]"; N()', 'End Sub',
      'Function S() As String', 'End Function', 'Function N() As Long', 'End Function'))).toEqual(['[] 0 ']);
  });

  test('Static Sub keeps all locals', async () => {
    expect(await run(lines('Sub Main()', '  Tick: Tick', 'End Sub', 'Static Sub Tick()', '  Dim n', '  n = n + 1', '  Debug.Print n', 'End Sub')))
      .toEqual([' 1 ', ' 2 ']);
  });
});

describe('variables and scope', () => {
  test('implicit variables without Option Explicit', async () => {
    expect(await run(lines('Sub Main()', '  x = 5', '  y$ = x', '  Debug.Print x; y$; z', 'End Sub'))).toEqual([' 5 5']);
  });

  test('Dim inside a loop does not reset the variable', async () => {
    expect(await run(lines('Sub Main()', '  Dim i As Integer', '  For i = 1 To 3', '    Dim n As Integer', '    n = n + 1', '  Next', '  Debug.Print n', 'End Sub')))
      .toEqual([' 3 ']);
  });

  test('constants cannot be assigned', async () => {
    expect(await run(lines('Const K = 1', 'Sub Main()', '  K = 2', 'End Sub')))
      .toEqual(['[Error 0 at Module1:3] Compile error: Assignment to constant not permitted']);
  });

  test('module variables, Public globals and qualified names across modules', async () => {
    const mods: SourceModule[] = [
      { name: 'Module1', kind: 'module', source: lines(
        'Option Explicit',
        'Private count As Integer',
        'Sub Main()',
        '  count = 2',
        '  Total = 10',
        '  AddTo 5',
        '  Debug.Print count; Total; Module2.Total; Twice(4); Module2.Twice(5); Limit',
        'End Sub',
      ) },
      { name: 'Module2', kind: 'module', source: lines(
        'Public Total As Long',
        'Private secret As Integer',
        'Public Const Limit = 99',
        'Sub AddTo(n As Long)', '  Total = Total + n', 'End Sub',
        'Function Twice(n)', '  Twice = n * 2', 'End Function',
        'Private Sub Hidden()', 'End Sub',
      ) },
    ];
    expect(await run(mods)).toEqual([' 2  15  15  8  10  99 ']);
    const hidden = structuredClone(mods);
    hidden[0].source = lines('Option Explicit', 'Sub Main()', '  secret = 1', 'End Sub');
    expect(await run(hidden)).toEqual(['[Error 0 at Module1:3] Compile error: Variable not defined']);
    hidden[0].source = lines('Sub Main()', '  Hidden', 'End Sub');
    expect(await run(hidden)).toEqual(['[Error 0 at Module1:2] Compile error: Sub or Function not defined']);
  });

  test('form module variables are not global', async () => {
    const mods: SourceModule[] = [
      { name: 'Module1', kind: 'module', source: lines('Option Explicit', 'Sub Main()', '  Debug.Print formVar', 'End Sub') },
      { name: 'Form1', kind: 'form', source: lines('Public formVar As Integer', 'Sub Form_Load()', '  formVar = 3', '  Debug.Print formVar', 'End Sub') },
    ];
    const host = new TestHost();
    const prog = new Program(mods, host, TEST_OPTIONS);
    await prog.runEvent('Form1', 'Form_Load');
    await prog.runEvent('Module1', 'Main');
    expect(host.lines()).toEqual([' 3 ', '[Error 0 at Module1:3] Compile error: Variable not defined']);
  });

  test('Public Type and Enum from another module', async () => {
    const mods: SourceModule[] = [
      { name: 'Module1', kind: 'module', source: lines(
        'Sub Main()',
        '  Dim p As Pt, pts(1 To 2) As Pt, s As Shade',
        '  p.X = 4',
        '  pts(1) = p',
        '  pts(1).X = 5',
        '  s = Dark',
        '  Debug.Print p.X; pts(1).X; pts(2).X; s; Shade.Dark',
        'End Sub',
      ) },
      { name: 'Module2', kind: 'module', source: lines('Public Type Pt', '  X As Integer', '  Tags(1 To 3) As String', 'End Type', 'Public Enum Shade', '  Light', '  Dark', 'End Enum') },
    ];
    expect(await run(mods)).toEqual([' 4  5  0  1  1 ']);
  });
});

describe('arrays', () => {
  test('size guard, negative size and rounding of bounds', async () => {
    expect(await run(lines('Sub Main()', '  Dim a() As Byte', '  ReDim a(100000000)', 'End Sub')))
      .toEqual(['[Error 7 at Module1:3] Out of memory']);
    expect(await run(lines('Sub Main()', '  Dim a() As Byte', '  ReDim a(-5)', 'End Sub')))
      .toEqual(['[Error 9 at Module1:3] Subscript out of range']);
    expect(await run(lines('Sub Main()', '  Dim a(2.5), b(3.5)', '  Debug.Print UBound(a); UBound(b)', 'End Sub')))
      .toEqual([' 2  4 ']);
  });

  test('dynamic array before ReDim, fixed array ReDim, Erase', async () => {
    expect(await run(lines('Sub Main()', '  Dim a() As Integer', '  Debug.Print UBound(a)', 'End Sub')))
      .toEqual(['[Error 9 at Module1:3] Subscript out of range']);
    expect(await run(lines('Sub Main()', '  Dim a(3) As Integer', '  ReDim a(5)', 'End Sub')))
      .toEqual(['[Error 10 at Module1:3] This array is fixed or temporarily locked']);
    expect(await run(lines(
      'Sub Main()', '  Dim f(2) As Integer, d() As Integer', '  f(1) = 7: ReDim d(3): d(1) = 7',
      '  Erase f, d', '  Debug.Print f(1); UBound(f)', '  Debug.Print UBound(d)', 'End Sub',
    ))).toEqual([' 0  2 ', '[Error 9 at Module1:6] Subscript out of range']);
  });

  test('ReDim Preserve keeps records, arrays of records do not share', async () => {
    expect(await run(lines(
      'Type T', '  V As Integer', 'End Type',
      'Sub Main()', '  Dim a() As T', '  ReDim a(1)', '  a(0).V = 3', '  ReDim Preserve a(2)', '  a(2).V = 9',
      '  Debug.Print a(0).V; a(1).V; a(2).V', 'End Sub',
    ))).toEqual([' 3  0  9 ']);
  });

  test('For Each over a 2-D array goes first index fastest', async () => {
    expect(await run(lines(
      'Sub Main()', '  Dim g(1, 1) As Integer, v', '  g(0, 0) = 1: g(1, 0) = 2: g(0, 1) = 3: g(1, 1) = 4',
      '  For Each v In g', '    Debug.Print v;', '  Next', '  Debug.Print', 'End Sub',
    ))).toEqual([' 1  2  3  4 ']);
  });
});

describe('statements', () => {
  test('GoTo forward and backward, line-number labels', async () => {
    expect(await run(lines(
      'Sub Main()', '  Dim n As Integer',
      'Again:', '  n = n + 1', '  If n < 3 Then GoTo Again', '  GoTo 100', '  Debug.Print "skipped"',
      '100', '  Debug.Print n', 'End Sub',
    ))).toEqual([' 3 ']);
    expect(await run(lines('Sub Main()', '  GoTo Nowhere', 'End Sub')))
      .toEqual(['[Error 0 at Module1:2] Compile error: Label not defined']);
  });

  test('With on a record, nested', async () => {
    expect(await run(lines(
      'Type Inner', '  A As Integer', 'End Type', 'Type Outer', '  I As Inner', '  S As String', 'End Type',
      'Sub Main()', '  Dim o As Outer',
      '  With o', '    .S = "s"', '    With .I', '      .A = 5', '    End With', '  End With',
      '  Debug.Print o.S; o.I.A', 'End Sub',
    ))).toEqual(['s 5 ']);
  });

  test('Is Nothing, Null propagation, Null conditions', async () => {
    expect(await run(lines(
      'Sub Main()', '  Dim o As Object, v',
      '  Debug.Print o Is Nothing',
      '  v = Null',
      '  Debug.Print v + 1; v & "x"; v = 1',
      '  If v Then Debug.Print "yes" Else Debug.Print "no"',
      'End Sub',
    ))).toEqual(['True', 'NullxNull', 'no']);
  });

  test('integer division and Mod by zero, 0/0 overflow, Like with special characters', async () => {
    expect(await run(lines('Sub Main()', '  Debug.Print 5 \\ 0', 'End Sub'))).toEqual(['[Error 11 at Module1:2] Division by zero']);
    expect(await run(lines('Sub Main()', '  Debug.Print 0 / 0', 'End Sub'))).toEqual(['[Error 6 at Module1:2] Overflow']);
    expect(await run(lines('Sub Main()', '  Debug.Print "a.b" Like "a.b"; "axb" Like "a.b"; "(1)" Like "(#)"', 'End Sub')))
      .toEqual(['TrueFalseTrue']);
  });

  test('Debug.Print comma zones and trailing separators across statements', async () => {
    expect(await run(lines('Sub Main()', '  Debug.Print "a", "b"', '  Debug.Print "x";', '  Debug.Print ,"y"', 'End Sub')))
      .toEqual(['a             b', 'x             y']);
  });

  test('On Error is not available yet (Task 8)', async () => {
    const out = await run(lines('Sub Main()', '  On Error Resume Next', 'End Sub'));
    expect(out[0]).toMatch(/^\[Error 0 at Module1:2\] Compile error: /);
  });
});

test('VBRuntimeError from host objects is a normal run-time error', async () => {
  const host = new TestHost();
  host.objects.set('thing', {
    vbTypeName: 'Thing', hasMember: () => true, setMember: () => {}, callMethod: () => 0,
    getMember: () => { throw new VBRuntimeError(380); },
  });
  expect(await run(lines('Sub Main()', '  Debug.Print Thing.Value', 'End Sub'), 'Main', host))
    .toEqual(['[Error 380 at Module1:2] Invalid property value']);
});
