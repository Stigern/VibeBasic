// Regression tests for the 0.9 language review (.superpowers/sdd/v09/review/lang.md): each finding's program, with
// VB6's output.

import { expect, test } from 'vitest';
import { Program, type SourceModule } from '../../src/lang/interp/program';
import type { WatchSpec } from '../../src/lang/interp/debugger';
import { TestHost, TEST_OPTIONS } from './testHost';

/** Runs Main of Module1 with more modules; returns the output lines and the program. */
async function run(main: string, more: Record<string, string> = {}, setup?: (h: TestHost) => void) {
  const host = new TestHost();
  host.fs.mkdirs('/app');
  setup?.(host);
  const mods: SourceModule[] = [{ name: 'Module1', kind: 'module', source: main }];
  for (const [name, source] of Object.entries(more)) mods.push({ name, kind: /^Module/.test(name) ? 'module' : 'class', source });
  const prog = new Program(mods, host, { ...TEST_OPTIONS, appPath: '/app' });
  await prog.runEvent('Module1', 'Main');
  await new Promise(r => setTimeout(r, 0));
  return { out: host.lines(), prog };
}

const BULLET = 'Private mBuf(100) As Double\nPrivate Sub Class_Terminate()\n  Module2.Terms = Module2.Terms + 1\nEnd Sub\n';
const TERMS = { Bullet: BULLET, Module2: 'Public Terms As Long\n' };

test('#1 objects in a Collection, an array, a UDT or a Dictionary terminate when removed, overwritten or let go', async () => {
  // (the first test of the file: the Collection is made before the program's first object)
  const { out, prog } = await run(`Type Slot
  B As Bullet
End Type
Private mCol As New Collection
Sub Main()
  Dim c As New Collection, b As Bullet, i As Long, arr(10) As Bullet
  mCol.Add New Bullet: mCol.Remove 1
  Debug.Print Module2.Terms
  For i = 1 To 2000
    Set b = New Bullet: c.Add b: Set b = Nothing: c.Remove 1
  Next
  For i = 1 To 2000: Set arr(i Mod 10) = New Bullet: Next
  Debug.Print c.Count; Module2.Terms
  Erase arr
  Debug.Print Module2.Terms
  Dim s As Slot, d As New Scripting.Dictionary
  Set s.B = New Bullet: Set s.B = New Bullet
  d.Add "a", New Bullet: Set d("a") = New Bullet: d.Add "b", New Bullet
  Debug.Print Module2.Terms
  d.RemoveAll
  Debug.Print Module2.Terms
  Fill
  Debug.Print Module2.Terms
  Dim k As Collection: Set k = Make()
  Debug.Print k.Count; Module2.Terms
  Set k = Nothing
  Debug.Print Module2.Terms
End Sub
Sub Fill()
  Dim c As New Collection, a(2) As Bullet
  c.Add New Bullet: Set a(1) = New Bullet
End Sub
Function Make() As Collection
  Set Make = New Collection
  Make.Add New Bullet
End Function`, TERMS);
  expect(out).toEqual([' 1 ', ' 0  3991 ', ' 4001 ', ' 4003 ', ' 4005 ', ' 4007 ', ' 1  4007 ', ' 4008 ']);
  expect(prog.liveObjects).toBe(0);   // Main's own variables (the record, the Dictionary) let go of the rest
});

test('#3 a class module type takes no host object (13); a host-type variable for a class parameter does not compile', async () => {
  const { out } = await run(`Sub Main()
  Dim a As Thing
  On Error Resume Next
  Set a = New Collection
  Debug.Print Err.Number; TypeName(a)
End Sub`, { Thing: 'Public X As Long\n' });
  expect(out).toEqual([' 13 Nothing']);
  const r = await run(`Sub Use(t As Thing)
End Sub
Sub Main()
  Dim c As New Collection
  Use c
End Sub`, { Thing: 'Public X As Long\n' });
  expect(r.out.join()).toContain('ByRef argument type mismatch');
});

const TERM_THING = 'Public Tag As String\nPrivate Sub Class_Terminate()\n  Debug.Print "term " & Tag\nEnd Sub\n';

test('#4 an object lives until its own method (and a RaiseEvent in it) returns', async () => {
  const { out } = await run(`Public gObj As Thing
Sub Main()
  Set gObj = New Thing: gObj.Tag = "g": gObj.Suicide: Debug.Print "end"
  Dim h As New Handler
  h.Start
  Debug.Print "after"
End Sub`, {
    Thing: TERM_THING + 'Public Sub Suicide()\n  Set Module1.gObj = Nothing\n  Debug.Print "still here " & Tag\nEnd Sub\n',
    Source: 'Public Event Fire()\nPrivate Sub Class_Terminate()\n  Debug.Print "src term"\nEnd Sub\nPublic Sub Go()\n  RaiseEvent Fire\n  Debug.Print "src after raise"\nEnd Sub\n',
    Handler: 'Private WithEvents s As Source\nPublic Sub Start()\n  Set s = New Source\n  s.Go\nEnd Sub\nPrivate Sub s_Fire()\n  Set s = Nothing\n  Debug.Print "handler set nothing"\nEnd Sub\n',
  });
  expect(out).toEqual(['still here g', 'term g', 'end', 'handler set nothing', 'src after raise', 'src term', 'after']);
});

test('#5 Set dict(key) = obj stores the object; an object key compares by identity', async () => {
  const { out } = await run(`Sub Main()
  Dim d As New Scripting.Dictionary, o As Object, c As New Collection
  Set d("x") = New Collection
  Set o = CreateObject("Scripting.Dictionary")
  Set o("y") = c
  d("x").Add 5
  Debug.Print d("x").Count; o("y") Is c; d.Exists(c)
  d.Add c, 1
  Debug.Print d.Exists(c); d(c)
End Sub`);
  expect(out).toEqual([' 1 TrueFalse', 'True 1 ']);
});

test('#6 named arguments to Collection and Dictionary methods', async () => {
  const { out } = await run(`Sub Main()
  Dim col As New Collection, d As Object
  col.Add "v", Key:="k"
  col.Add "w", Before:=1
  col.Add Item:="z", Key:="kz", After:="k"
  Debug.Print col(1); col("k"); col(3); col.Item(Index:="kz")
  col.Remove Index:=1
  Set d = CreateObject("Scripting.Dictionary")
  d.Add Key:="a", Item:=1
  Debug.Print col.Count; d("a"); d.Exists(Key:="a")
  On Error Resume Next
  col.Add "q", Nope:=1
  Debug.Print Err.Number
End Sub`);
  expect(out).toEqual(['wvzz', ' 2  1 True', ' 448 ']);
});

const VALUE_CLASS = `Private mV As String
Public Property Get Value() As String
Attribute Value.VB_UserMemId = 0
  Value = mV
End Property
Public Property Let Value(ByVal s As String)
  mV = s
End Property
`;

const COLL_CLASS = `Private mC As New Collection
Public Sub Add(v)
  mC.Add v
End Sub
Public Property Get Item(ByVal i As Variant) As Variant
Attribute Item.VB_UserMemId = 0
  Item = mC(i)
End Property
Public Property Get NewEnum() As IUnknown
Attribute NewEnum.VB_UserMemId = -4
Attribute NewEnum.VB_MemberFlags = "40"
  Set NewEnum = mC.[_NewEnum]
End Property
`;

test('#7 a class default member (VB_UserMemId = 0) and NewEnum (-4) for For Each', async () => {
  const { out } = await run(`Sub Main()
  Dim t As New Thing, s As String, c As New Things, x As Variant
  t.Value = "hi"
  Debug.Print t
  t = "x"
  s = t & "!"
  Debug.Print s; Len(t)
  c.Add "a": c.Add "b": c.Add "c"
  Debug.Print c(2)
  For Each x In c: s = s & x: Next
  Debug.Print s
End Sub`, { Thing: VALUE_CLASS, Things: COLL_CLASS });
  expect(out).toEqual(['hi', 'x! 1 ', 'b', 'x!abc']);
});

test('#9 a Break When Value Changes watch does not fire when its expression goes out of context and back', async () => {
  const src = ['Option Explicit', 'Sub Main()', '  Dim i As Integer', '  For i = 1 To 2: Other: Next', '  Debug.Print i', 'End Sub',
    'Sub Other()', '  Dim j As Integer', '  j = 1', 'End Sub'].join('\n');
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: src }], host, TEST_OPTIONS);
  const stops: string[] = [];
  host.breakHook = async info => { stops.push(`${info.at.procName}:${info.at.line}`); return 'continue'; };
  const w: WatchSpec = { expression: 'i', module: 'Module1', procedure: null, kind: 'breakChange' };
  await prog.debug.setWatches([w]);
  await prog.runEvent('Module1', 'Main');
  expect(stops).toEqual(['Main:4', 'Main:4', 'Main:5']);
});

test('#10 a Break When Value Changes watch on a big array costs little per statement, and still sees element writes', async () => {
  const src = ['Sub Main()', '  Dim a(200000) As Long, i As Long, n As Long', '  For i = 1 To 3000: n = n + 1: Next', '  a(5) = 1',
    '  Debug.Print n', 'End Sub'].join('\n');
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: src }], host, TEST_OPTIONS);
  const stops: number[] = [];
  host.breakHook = async info => { stops.push(info.at.line); return 'continue'; };
  await prog.debug.setWatches([{ expression: 'a', module: 'Module1', procedure: 'Main', kind: 'breakChange' }]);
  const t = performance.now();
  await prog.runEvent('Module1', 'Main');
  expect(performance.now() - t).toBeLessThan(3000);
  expect(stops).toEqual([5]);
});

test('#11 FSO: DeleteFolder deletes a tree, CopyFile / MoveFile take wildcards, Folder.Size', async () => {
  const { out } = await run(`Sub Main()
  Dim fso As New Scripting.FileSystemObject
  fso.CreateFolder "/app/d": fso.CreateFolder "/app/d/sub": fso.CreateTextFile("/app/d/sub/x.txt").Close
  fso.DeleteFolder "/app/d"
  Debug.Print fso.FolderExists("/app/d")
  fso.CreateFolder "/app/w": fso.CreateFolder "/app/w2": fso.CreateFolder "/app/w3"
  With fso.CreateTextFile("/app/w/a.txt"): .Write "12345": .Close: End With
  With fso.CreateTextFile("/app/w/b.txt"): .Write "678": .Close: End With
  fso.CreateTextFile("/app/w/c.dat").Close
  fso.CopyFile "/app/w/*.txt", "/app/w2/"
  Debug.Print fso.FileExists("/app/w2/a.txt"); fso.FileExists("/app/w2/b.txt"); fso.FileExists("/app/w2/c.dat")
  fso.MoveFile "/app/w/*.txt", "/app/w3"
  Debug.Print fso.FileExists("/app/w/a.txt"); fso.FileExists("/app/w3/b.txt"); fso.GetFolder("/app/w3").Size
  On Error Resume Next
  fso.CopyFile "/app/w/*.zip", "/app/w2/"
  Debug.Print Err.Number
End Sub`);
  expect(out).toEqual(['False', 'TrueTrueFalse', 'FalseTrue 8 ', ' 53 ']);
});

test('#12 the locals of a procedure left by an error terminate before the caller\'s handler runs', async () => {
  const { out } = await run(`Sub Inner()
  Dim t As New Thing: t.Tag = "inner": Err.Raise 5
End Sub
Sub Main()
  On Error GoTo H
  Inner
  Exit Sub
H: Debug.Print "handler"
End Sub`, { Thing: TERM_THING });
  expect(out).toEqual(['term inner', 'handler']);
});

test('#13 Len and LenB of a typed variable are its storage size; a Variant or an expression its text', async () => {
  const { out } = await run(`Type P
  Age As Integer
End Type
Sub Main()
  Dim l As Long, i As Integer, d As Double, v As Variant, s As String, b As Boolean, p As P, a(2) As Long
  l = 123456: v = 123456: s = "abc"
  Debug.Print LenB(l); LenB(i); LenB(d); Len(l); Len(b); LenB(p.Age); Len(a(1))
  Debug.Print Len(v); LenB(v); Len(l + 1); Len(s); LenB(s)
End Sub`);
  expect(out).toEqual([' 4  2  8  4  2  2  4 ', ' 6  12  6  3  6 ']);
});

test('numeric text of a very long digit run converts at once (no regex backtracking)', async () => {
  const t = performance.now();
  const { out } = await run(`Sub Main()
  Dim s As String: s = "0." & String(200000, "1") & "x"
  Debug.Print Val(s) > 0.1; IsNumeric(s); IsNumeric(Mid(s, 3))
End Sub`);
  expect(out).toEqual(['TrueFalseFalse']);
  expect(performance.now() - t).toBeLessThan(500);
});
