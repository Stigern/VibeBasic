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
  const rs = new FakeObject('Recordset', { defaultMember: 'Fields', props: { Fields: ['', ''] } });
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
