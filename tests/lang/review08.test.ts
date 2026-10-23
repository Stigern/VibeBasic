// Regression tests for the VB6 differences found in review 08 (.superpowers/sdd/review08/lang.md): each finding's
// program, with VB6's output.

import { Program } from '../../src/lang/interp/program';
import { TestHost } from './testHost';
import { FakeObject } from './fakeObject';

/** Runs `Main` of a one-module program (en-US, App.Path /app); returns the output lines. */
async function run(src: string, setup?: (h: TestHost) => void): Promise<string[]> {
  const host = new TestHost();
  host.fs.mkdirs('/app');
  setup?.(host);
  const prog = new Program([{ name: 'Module1', kind: 'module', source: src }], host, { locale: 'en-US', appPath: '/app' });
  await prog.runEvent('Module1', 'Main');
  await new Promise(r => setTimeout(r, 0));
  return host.lines();
}

const main = (body: string, decls = '') => `${decls}\nSub Main()\n${body}\nEnd Sub\n`;

test('#1 an argument in its own parentheses is a copy', async () => {
  expect(await run(`Sub Inc(x As Integer)
  x = x + 1
End Sub
Function Dbl(x As Integer) As Integer
  x = x * 2: Dbl = x
End Function
Sub Swap(a, b)
  Dim t: t = a: a = b: b = t
End Sub
Sub Main()
  Dim v As Integer, r As Integer, p, q
  v = 1
  Inc (v):        Debug.Print v
  Call Inc((v)):  Debug.Print v
  r = Dbl((v)):   Debug.Print v
  p = 1: q = 2
  Swap (p), q:    Debug.Print p; q
  Inc v:          Debug.Print v
  Call Inc(v):    Debug.Print v
End Sub`)).toEqual([' 1 ', ' 1 ', ' 1 ', ' 1  1 ', ' 2 ', ' 3 ']);
});

test('#3 !Field inside With is the With object\'s field', async () => {
  const rs = new FakeObject('Recordset', { defaultMember: 'Fields', props: { Fields: ['', ''] as unknown as string } });
  // the fake's default member takes the field name as an index: map names to slots
  const fields = new Map<string, number>([['name', 0], ['first name', 1]]);
  rs.getMember = (name, args) => (args.length ? (rs.props.Fields as unknown as string[])[fields.get(String(args[0]).toLowerCase())!] : rs.props[name]);
  rs.setMember = (_name, args, value) => { (rs.props.Fields as unknown as unknown[])[fields.get(String(args[0]).toLowerCase())!] = value; };
  expect(await run(main(`With rs
  !Name = "Cy"
  ![First Name] = "Ann"
  Debug.Print !Name; " "; ![First Name]
End With`), h => h.objects.set('rs', rs))).toEqual(['Cy Ann']);
});

test('#7 Dim As New and Set = New make a Collection', async () => {
  expect(await run(main(`Dim c As New Collection
c.Add "a"
c.Add "b", "kb"
c.Add "z", , 1
Debug.Print c.Count; c(1); c("KB"); c!kb; c.Item(3)
Dim x, s
For Each x In c: s = s & x: Next
Debug.Print s
c.Remove "kb"
Debug.Print c.Count
Set c = Nothing
Debug.Print c Is Nothing; c.Count
Dim d As Collection
Set d = New Collection
d.Add 5
Debug.Print TypeName(d); d(1)
On Error Resume Next
d.Add 6, "k": d.Add 7, "K": Debug.Print Err.Number
Err.Clear: x = d(9): Debug.Print Err.Number
Err.Clear: x = d("nope"): Debug.Print Err.Number`))).toEqual([' 3 zbbb', 'zab', ' 2 ', 'False 0 ', 'Collection 5 ', ' 457 ', ' 9 ', ' 5 ']);
});

test('#7 New of a type that cannot be made is a compile error', async () => {
  expect((await run(main('Dim x As New Class1\nx.Foo')))[0]).toMatch(/Compile error: Not supported in VibeBasic: New Class1/);
  expect((await run(main('Dim x As Object\nSet x = New Class1')))[0]).toMatch(/Compile error: Not supported in VibeBasic: New Class1/);
  expect((await run(main('Dim p As New Pt', 'Type Pt\n  X As Integer\nEnd Type')))[0]).toMatch(/Compile error: Invalid use of New keyword/);
  expect((await run(main('Dim i As New Integer')))[0]).toMatch(/Compile error: Invalid use of New keyword/);
});

test('#9 Mid, LSet and RSet statements', async () => {
  expect(await run(main(`Dim s As String: s = "Hello World"
Mid(s, 1, 3) = "XYZ": Debug.Print s
Mid$(s, 7) = "abcdefghij": Debug.Print s
Mid(s, 2, 1) = "--": Debug.Print s
Dim f As String * 5
LSet f = "ab": Debug.Print "[" & f & "]"
RSet f = "ab": Debug.Print "[" & f & "]"
RSet f = "abcdefg": Debug.Print "[" & f & "]"
Dim v: v = "1234"
LSet v = "x": Debug.Print "[" & v & "]"
On Error Resume Next
Mid(s, 20) = "q": Debug.Print Err.Number`))).toEqual(['XYZlo World', 'XYZlo abcde', 'X-Zlo abcde', '[ab   ]', '[   ab]', '[abcde]', '[x   ]', ' 5 ']);
});

test('#11 a Function can return a typed array', async () => {
  expect(await run(`Function Nums() As Integer()
  Dim a(2) As Integer
  a(1) = 8: Nums = a
End Function
Sub Main()
  Dim x() As Integer
  x = Nums()
  Debug.Print x(1); UBound(x); TypeName(Nums())
End Sub`)).toEqual([' 8  2 Integer()']);
});

test('#15 the Error statement raises the error; Erl gives the line number', async () => {
  expect(await run(main(`On Error Resume Next
Error 7
Debug.Print Err.Number; Err.Description`))).toEqual([' 7 Out of memory']);
  expect(await run(`Sub Main()
10  On Error GoTo 100
20  Dim x: x = 1 / 0
30  Exit Sub
100 Debug.Print "line"; Erl
110 Resume Next
End Sub`)).toEqual(['line 20 ']);
  expect(await run(main(`On Error Resume Next
Dim x: x = 1 / 0
Debug.Print Erl`))).toEqual([' 0 ']);
});

test('#17 Write # keeps empty items', async () => {
  const out = await run(main(`Open "w.txt" For Output As #1
Write #1, True, Null, , "x"
Close #1
Dim a, b, c, d
Open "w.txt" For Input As #1
Input #1, a, b, c, d
Close #1
Debug.Print a; IsNull(b); IsEmpty(c); d`), h => { h.fs.mkdirs('/app'); });
  expect(out).toEqual(['TrueTrueTruex']);
});

test('#17 Write # file text', async () => {
  const host = new TestHost();
  host.fs.mkdirs('/app');
  const prog = new Program([{ name: 'Module1', kind: 'module', source: main('Open "w.txt" For Output As #1\nWrite #1, True, Null, , "x"\nClose #1') }], host, { locale: 'en-US', appPath: '/app' });
  await prog.runEvent('Module1', 'Main');
  await new Promise(r => setTimeout(r, 0));
  expect(host.fs.readFile('/app/w.txt')).toBe('#TRUE#,#NULL#,,"x"\r\n');
});

test('#2 IsMissing: an omitted Optional Variant is Missing', async () => {
  expect(await run(`Sub Opt(Optional b)
  If IsMissing(b) Then Debug.Print "missing" Else Debug.Print "given"
End Sub
Sub Typed(Optional n As Integer, Optional v = 5)
  Debug.Print IsMissing(n); IsMissing(v); n; v
End Sub
Sub Pass(Optional x)
  Opt x
  Debug.Print TypeName(x); VarType(x); IsError(x)
  MsgBox "hi", , x
End Sub
Sub Main()
  Opt
  Opt 1
  Typed
  Pass
End Sub`)).toEqual(['missing', 'given', 'FalseFalse 0  5 ', 'missing', 'Error 10 True', '[MsgBox] hi']);
});

test('#4 Single values show 7 digits', async () => {
  expect(await run(main(`Dim s As Single, t As Single
s = 1 / 3
Debug.Print s
s = 3.14159265358979
Debug.Print s
Debug.Print CSng(2) / 3
t = 30896.1234567: Debug.Print t
Debug.Print "x" & s; CStr(s * 2)
Dim v: v = s: Debug.Print v
s = 0.1: Debug.Print s * 3; s + s; s = 0.1; s = CSng(0.1)
s = 0.3333333: Debug.Print s * 3
Debug.Print Rnd(0) < 1; TypeName(Timer)`))).toEqual([
    ' .3333333 ', ' 3.141593 ', ' .6666667 ', ' 30896.12 ', 'x3.1415936.283185', ' 3.141593 ', ' .3  .2 FalseTrue', ' .9999999 ', 'TrueSingle',
  ]);
});

test('#6 TypeName and VarType know typed variables and typed expressions', async () => {
  expect(await run(main(`Dim d As Double, c As Currency, s As Single, b As Byte, l As Long, v
d = 5: c = 5: s = 2.5: b = 1: l = 1
Debug.Print TypeName(d); VarType(d); TypeName(c); VarType(c); TypeName(s); VarType(s)
Debug.Print TypeName(b); VarType(b); TypeName(l); VarType(l)
v = CDbl(5):  Debug.Print TypeName(v); VarType(v)
v = CCur(2):  Debug.Print TypeName(v)
v = d: Debug.Print TypeName(v)
v = 7: Debug.Print TypeName(v)
Debug.Print TypeName(#1/2/2003# - #1/1/2003#); TypeName(CSng(1)); TypeName(1.5 * 2); TypeName(CDec(1.5)); VarType(CDec(1))
Debug.Print TypeName(CInt(2) * 2); TypeName(2 * 40000); TypeName(5 \\ 2); TypeName(d \\ 2)
Show d
Show 3
End Sub
Sub Show(ByVal x)
  Debug.Print TypeName(x);`))).toEqual([
    'Double 5 Currency 6 Single 4 ', 'Byte 17 Long 3 ', 'Double 5 ', 'Currency', 'Double', 'Integer',
    'DoubleSingleDoubleDecimal 14 ', 'IntegerLongIntegerLong', 'DoubleInteger',
  ]);
});

test('#4 a Single keeps its exact value in numeric code and shows 7 digits elsewhere', async () => {
  const label = new FakeObject('Label', { defaultMember: 'Caption', props: { Caption: '' } });
  expect(await run(main(`Dim s As Single, i As Integer, d As Double, a(2), sa(2) As Single, c As New Collection, x
For i = 1 To 1000: s = s + 0.001: Next
Debug.Print s
s = 1 / 3
d = s: Debug.Print d; CDbl(s)
a(1) = s: sa(1) = s: Debug.Print a(1); sa(1) = s; sa(1)
c.Add s: Debug.Print c(1)
Label1.Caption = s: Debug.Print Label1.Caption
For Each x In sa: Debug.Print x;: Next: Debug.Print
Debug.Print Str(s); Format(s); Left(s, 4)`), h => h.objects.set('label1', label))).toEqual([
    ' .9999907 ', ' .333333343267441  .333333343267441 ', ' .3333333 True .3333333 ', ' .3333333 ', ' .3333333 ',
    ' 0  .3333333  0 ', ' .33333330.33333330.33',
  ]);
});

test('#18 Integer arithmetic overflows; Variant arithmetic widens', async () => {
  expect(await run(main(`Dim a As Integer, b As Integer, l As Long, v, w, by As Byte
a = 200: b = 200
On Error Resume Next
l = a * b
Debug.Print Err.Number; l
Err.Clear: l = 30000 + 30000
Debug.Print Err.Number; l
Err.Clear: l = CLng(a) * b: Debug.Print Err.Number; l
Err.Clear: l = a * 200&: Debug.Print Err.Number; l
Err.Clear: l = 30000 + 30000.0: Debug.Print Err.Number; l
v = 200: w = 200: Err.Clear: l = v * w: Debug.Print Err.Number; l
Err.Clear: by = 200: l = by + by: Debug.Print Err.Number
Err.Clear: a = -32768: l = -a: Debug.Print Err.Number
Err.Clear: l = 2147483647 + 1&: Debug.Print Err.Number
Const N = 20000
Err.Clear: l = N * 2: Debug.Print Err.Number; l`))).toEqual([' 6  0 ', ' 6  0 ', ' 0  40000 ', ' 0  40000 ', ' 0  60000 ', ' 0  40000 ', ' 6 ', ' 6 ', ' 6 ', ' 6  40000 ']);
});

test('#16 a variable of another type for a typed ByRef parameter is a compile error', async () => {
  const src = (call: string) => `Sub AddOne(n As Integer)
  n = n + 1
End Sub
Sub Main()
${call}
End Sub`;
  expect(await run(src('  x = 1\n  AddOne x\n  Debug.Print x'))).toEqual(['[Error 0 at Module1:6] Compile error: ByRef argument type mismatch']);
  expect((await run(src('  Dim l As Long: l = 1\n  AddOne l')))[0]).toMatch(/ByRef argument type mismatch/);
  // a copy is fine: an expression, a parenthesised variable, ByVal
  expect(await run(src('  Dim l As Long: l = 1\n  AddOne (l): AddOne l + 0\n  Dim i As Integer: AddOne i: Debug.Print l; i'))).toEqual([' 1  1 ']);
});

test('#8 fixed-length strings keep their length in arrays, fields and ByRef parameters', async () => {
  expect(await run(`Type Rec
  Code(1) As String * 3
End Type
Sub SetIt(x As String)
  x = "abcdefg"
End Sub
Sub Main()
  Dim fs As String * 5
  SetIt fs
  Debug.Print "[" & fs & "]"; Len(fs)
  Dim arr(1) As String * 2
  arr(0) = "xyz"
  Debug.Print "[" & arr(0) & "]"; Len(arr(1))
  SetIt arr(1): Debug.Print "[" & arr(1) & "]"
  Dim d() As String * 2
  ReDim d(1): d(1) = "q": Debug.Print "[" & d(1) & "]"; Len(d(0))
  Dim r As Rec
  r.Code(0) = "abcd": Debug.Print "[" & r.Code(0) & "]"; Len(r.Code(1))
  Erase arr: Debug.Print Len(arr(0))
End Sub`)).toEqual(['[abcde] 5 ', '[xy] 2 ', '[ab]', '[q ] 2 ', '[abc] 3 ', ' 2 ']);
});

test('#13 numeric text with thousands separators and currency signs', async () => {
  expect(await run(main(`Debug.Print IsNumeric("1,000"); IsNumeric("$12"); IsNumeric("(5)"); IsNumeric("abc"); IsNumeric("1,,0")
Debug.Print CDbl("1,000"); CDbl(Format(1234.5, "#,##0.00")); CCur("$1,234.50"); CDbl("(5)"); CDbl("5-"); CInt("-$3")
Debug.Print "1,000" = 1000; "1,000" + 1; Val("1,000")`))).toEqual([
    'TrueTrueTrueFalseFalse', ' 1000  1234.5  1234.5 -5 -5 -3 ', 'True 1001  1 ',
  ]);
});
