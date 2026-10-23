// Class modules: properties, per-object variables, Class_Initialize / Class_Terminate, events with WithEvents,
// Implements, `Dim As New` and the errors of object variables.

import { describe, expect, it } from 'vitest';
import { Program, type SourceModule } from '../../src/lang/interp/program';
import { TestHost, TEST_OPTIONS } from './testHost';

const lines = (...l: string[]) => l.join('\n');

/** Runs `Main` of Module1 (`main`) with the class modules `classes` (name -> code); returns the output lines. */
async function run(main: string, classes: Record<string, string>, extra: SourceModule[] = []): Promise<string[]> {
  const host = new TestHost();
  const mods: SourceModule[] = [
    { name: 'Module1', kind: 'module', source: main },
    ...Object.entries(classes).map(([name, source]) => ({ name, kind: 'class' as const, source })),
    ...extra,
  ];
  const prog = new Program(mods, host, TEST_OPTIONS);
  await prog.runEvent(extra.length ? extra[0].name : 'Module1', extra.length ? 'Form_Load' : 'Main');
  return host.lines();
}

const COUNTER = lines(
  'Private mCount As Long',
  'Private mName As String',
  'Public Property Get Count() As Long',
  '  Count = mCount',
  'End Property',
  'Public Property Let Name(ByVal s As String)',
  '  mName = s',
  'End Property',
  'Public Property Get Name() As String',
  '  Name = mName',
  'End Property',
  'Public Sub Bump(Optional ByVal n As Long = 1)',
  '  mCount = mCount + n',
  '  If mCount > 5 Then Exit Sub',
  'End Sub',
);

describe('class modules', () => {
  it('has Property Get/Let and its own module-level variables in each object', async () => {
    const out = await run(lines(
      'Sub Main()',
      '  Dim a As Counter, b As Counter',
      '  Set a = New Counter',
      '  Set b = New Counter',
      '  a.Name = "A": b.Name = "B"',
      '  a.Bump: a.Bump 2: b.Bump',
      '  Debug.Print a.Name; a.Count; b.Name; b.Count',
      '  Debug.Print TypeName(a); a Is b; a Is a',
      'End Sub'), { Counter: COUNTER });
    expect(out).toEqual(['A 3 B 1 ', 'CounterFalseTrue']);
  });

  it('runs Class_Initialize at New and Class_Terminate when the last reference goes', async () => {
    const out = await run(lines(
      'Sub Main()',
      '  Dim a As Thing, b As Thing',
      '  Set a = New Thing',
      '  Set b = a',
      '  Set a = Nothing',
      '  Debug.Print "a gone"',
      '  Set b = Nothing',
      '  Debug.Print "b gone"',
      '  Make',
      '  Debug.Print "after Make"',
      'End Sub',
      'Sub Make()',
      '  Dim t As New Thing',
      '  t.Hello',
      'End Sub'), { Thing: lines(
      'Private Sub Class_Initialize()', '  Debug.Print "init"', 'End Sub',
      'Private Sub Class_Terminate()', '  Debug.Print "term"', 'End Sub',
      'Public Sub Hello()', '  Debug.Print "hello"', 'End Sub') });
    expect(out).toEqual(['init', 'a gone', 'term', 'b gone', 'init', 'hello', 'term', 'after Make']);
  });

  it('makes a Dim As New object on first use, and again after Set Nothing', async () => {
    const out = await run(lines(
      'Sub Main()',
      '  Dim t As New Thing',
      '  Debug.Print "declared"',
      '  t.Value = 5',
      '  Debug.Print t.Value',
      '  Set t = Nothing',
      '  Debug.Print t.Value; t Is Nothing',
      'End Sub'), { Thing: lines(
      'Public Value As Integer',
      'Private Sub Class_Initialize()', '  Debug.Print "init"', 'End Sub') });
    expect(out).toEqual(['declared', 'init', ' 5 ', 'init', ' 0 False']);
  });

  it('raises error 91 for an object variable that is not set and 438 for an unknown member', async () => {
    const out = await run(lines(
      'Sub Main()',
      '  Dim t As Thing',
      '  On Error Resume Next',
      '  t.Value = 1',
      '  Debug.Print Err.Number',
      '  Err.Clear',
      '  Set t = New Thing',
      '  t.Nope',
      '  Debug.Print Err.Number',
      'End Sub'), { Thing: 'Public Value As Integer' });
    expect(out).toEqual([' 91 ', ' 438 ']);
  });

  it('calls through an interface variable dispatch to the IFoo_ procedures (Implements)', async () => {
    const out = await run(lines(
      'Sub Main()',
      '  Dim s As IShape, c As Circle',
      '  Set c = New Circle',
      '  Set s = c',
      '  s.Size = 2',
      '  Debug.Print s.Area; s.Describe("r"); c.Own; TypeName(s); s Is c',
      'End Sub'), {
      IShape: lines('Public Size As Double', 'Public Function Area() As Double', 'End Function', 'Public Function Describe(p As String) As String', 'End Function'),
      Circle: lines(
        'Implements IShape',
        'Private r As Double',
        'Private Property Let IShape_Size(ByVal v As Double)', '  r = v', 'End Property',
        'Private Property Get IShape_Size() As Double', '  IShape_Size = r', 'End Property',
        'Private Function IShape_Area() As Double', '  IShape_Area = 3 * r * r', 'End Function',
        'Private Function IShape_Describe(p As String) As String', '  IShape_Describe = p & "=" & r', 'End Function',
        'Public Function Own() As String', '  Own = "circle"', 'End Function'),
    });
    expect(out).toEqual([' 12 r=2circleCircleTrue']);
  });

  it('runs the WithEvents handlers of a form for RaiseEvent, with ByRef arguments', async () => {
    const out = await run('', {
      Worker: lines(
        'Public Event Progress(ByVal pct As Integer, Cancel As Boolean)',
        'Public Sub Go()',
        '  Dim c As Boolean, i As Integer',
        '  For i = 1 To 3',
        '    RaiseEvent Progress(i * 10, c)',
        '    If c Then Debug.Print "cancelled at"; i: Exit Sub',
        '  Next',
        'End Sub'),
    }, [{ name: 'Form1', kind: 'form', source: lines(
      'Private WithEvents w As Worker',
      'Private Sub Form_Load()',
      '  Set w = New Worker',
      '  w.Go',
      'End Sub',
      'Private Sub w_Progress(ByVal pct As Integer, Cancel As Boolean)',
      '  Debug.Print "pct"; pct',
      '  If pct >= 20 Then Cancel = True',
      'End Sub') }]);
    expect(out).toEqual(['pct 10 ', 'pct 20 ', 'cancelled at 2 ']);
  });

  it('has Property procedures in a standard module, with an index parameter and Exit Property', async () => {
    const out = await run(lines(
      'Private items(3) As String',
      'Public Property Get Item(ByVal i As Integer) As String',
      '  If i > 3 Then Item = "?": Exit Property',
      '  Item = items(i)',
      'End Property',
      'Public Property Let Item(ByVal i As Integer, ByVal v As String)',
      '  items(i) = v',
      'End Property',
      'Sub Main()',
      '  Item(1) = "one"',
      '  Module1.Item(2) = "two"',
      '  Debug.Print Item(1); Module1.Item(2); Item(9)',
      'End Sub'), {});
    expect(out).toEqual(['onetwo?']);
  });
});
