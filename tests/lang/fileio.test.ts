// File I/O and SaveSetting in VB source, on the test host's in-memory file system. CurDir starts as App.Path (/app).

import { Program } from '../../src/lang/interp/program';
import { TestHost } from './testHost';

async function run(body: string, setup?: (h: TestHost) => void, decls = '') {
  const host = new TestHost();
  host.fs.mkdirs('/app');
  setup?.(host);
  const src = `${decls}\nSub Main()\n${body}\nEnd Sub\n`;
  const prog = new Program([{ name: 'Module1', kind: 'module', source: src }], host, { locale: 'en-US', appPath: '/app' });
  await prog.runEvent('Module1', 'Main');
  await new Promise(r => setTimeout(r, 0));   // End closes the files in the background
  return { out: host.lines(), host };
}

test('Print # and Line Input: write, then read back (CRLF, zones, Spc, Tab)', async () => {
  const { out, host } = await run(`Dim f As Integer, s As String
f = FreeFile
Open ".\\a.txt" For Output As #f
Print #f, "one"; 2
Print #f, "x", "y";
Print #f, "z"
Print #f, Spc(2); "s"; Tab(6); "t"
Print #f,
Close #f
Open "a.txt" For Input As #f
Do While Not EOF(f)
  Line Input #f, s
  Debug.Print "[" & s & "]"
Loop
Close f`);
  expect(host.fs.readFile('/app/a.txt')).toBe('one 2 \r\nx             yz\r\n  s  t\r\n\r\n');
  expect(out).toEqual(['[one 2 ]', '[x             yz]', '[  s  t]', '[]']);
});

test('Write # and Input #: quoted strings, numbers, #TRUE#, dates, Null', async () => {
  const { out, host } = await run(`Dim a As String, n As Integer, b As Boolean, d As Date, v As Variant, z As String
Open "w.txt" For Output As #1
Write #1, "Hi, there", 42, True, #2/3/2001#, Null
Write #1, "007", 1.5
Close #1
Open "w.txt" For Input As #1
Input #1, a, n, b, d, v
Debug.Print a; n; b; Year(d); IsNull(v)
Input #1, z, v
Debug.Print z; v; EOF(1)
Close #1`);
  expect(host.fs.readFile('/app/w.txt')).toBe('"Hi, there",42,#TRUE#,#2001-02-03#,#NULL#\r\n"007",1.5\r\n');
  expect(out).toEqual(['Hi, there 42 True 2001 True', '007 1.5 True']);
});

test('Append adds to the end; LOF', async () => {
  const { out, host } = await run(`Open "log.txt" For Output As #1
Print #1, "a"
Close #1
Open "log.txt" For Append As #1
Print #1, "b"
Close #1
Open "log.txt" For Input As #1
Debug.Print LOF(1)
Close`);
  expect(host.fs.readFile('/app/log.txt')).toBe('a\r\nb\r\n');
  expect(out).toEqual([' 6 ']);
});

test('Binary Get and Put: numbers, strings, a user type, Seek, Loc, EOF', async () => {
  const { out, host } = await run(`Dim i As Integer, l As Long, s As String, r As Rec, r2 As Rec, b As Byte
Open "b.bin" For Binary As #1
i = -2: l = 70000: s = "AB"
Put #1, , i
Put #1, , l
Put #1, , s
r.Name = "Zed": r.Age = 7: r.Code = "XYZQ"
Put #1, 20, r
Debug.Print LOF(1); Seek(1)
Seek #1, 1
i = 0: l = 0
Get #1, , i
Get #1, , l
s = String(2, " ")
Get #1, , s
Debug.Print i; l; s; Loc(1)
Get #1, 20, r2
Debug.Print r2.Name; r2.Age; r2.Code; EOF(1)
Get #1, , b
Debug.Print EOF(1)
Close #1`, undefined, `Type Rec
  Name As String
  Age As Integer
  Code As String * 4
End Type`);
  const bytes = host.fs.readFile('/app/b.bin')!;
  expect([...bytes.slice(0, 8)].map(c => c.charCodeAt(0))).toEqual([0xfe, 0xff, 0x70, 0x11, 0x01, 0x00, 0x41, 0x42]);
  expect(bytes.slice(19)).toBe('\x03\x00Zed\x07\x00XYZQ');
  expect(out).toEqual([' 30  31 ', '-2  70000 AB 8 ', 'Zed 7 XYZQFalse', 'True']);
});

test('Random records: Put by number, Get them back, LOF / Len', async () => {
  const { out } = await run(`Dim r As Rec, k As Integer
Open "r.dat" For Random As #1 Len = Len(r)
For k = 1 To 3
  r.Id = k * 10: r.Tag = "t" & k
  Put #1, k, r
Next
Debug.Print LOF(1) / 8
Get #1, 2, r
Debug.Print r.Id; r.Tag; Loc(1)
Close #1`, undefined, `Type Rec
  Id As Integer
  Tag As String * 6
End Type`);
  expect(out).toEqual([' 3 ', ' 20 t2     2 ']);
});

test('FreeFile, error 53, error 62, bad file number and mode', async () => {
  const { out } = await run(`On Error Resume Next
Debug.Print FreeFile
Open "a" For Output As #1
Debug.Print FreeFile; FreeFile(1)
Open "missing.txt" For Input As #2
Debug.Print Err.Number; Err.Description: Err.Clear
Open "/nodir/x.txt" For Output As #2
Debug.Print Err.Number: Err.Clear
Open "a" For Output As #1
Debug.Print Err.Number: Err.Clear
Line Input #1, s
Debug.Print Err.Number: Err.Clear
Close #1
Open "a" For Input As #1
Line Input #1, s
Debug.Print Err.Number; Err.Description: Err.Clear
Print #7, "x"
Debug.Print Err.Number: Err.Clear`);
  expect(out).toEqual([' 1 ', ' 2  256 ', ' 53 File not found', ' 76 ', ' 55 ', ' 54 ', ' 62 Input past end of file', ' 52 ']);
});

test('Dir iterates with wildcards and vbDirectory; Kill, Name, MkDir, RmDir, FileLen, GetAttr', async () => {
  const { out, host } = await run(`Dim d As String
d = Dir("*.txt")
Do While d <> ""
  Debug.Print d
  d = Dir
Loop
Debug.Print Dir("sub", vbDirectory); "|"; Dir("sub"); "|"; Dir("c.bas")
Debug.Print FileLen("b.txt"); GetAttr("sub") = vbDirectory
Kill "*.txt"
Debug.Print Dir("*.txt") = ""
Name "c.bas" As "sub\\d.bas"
MkDir "new"
RmDir "new"
ChDir "sub"
Debug.Print CurDir; Dir("")`, h => {
    h.fs.writeFile('/app/b.txt', 'abc');
    h.fs.writeFile('/app/A.txt', '');
    h.fs.writeFile('/app/c.bas', '');
    h.fs.writeFile('/app/.hidden.txt', '');
    h.fs.mkdirs('/app/sub');
  });
  expect(out).toEqual(['A.txt', 'b.txt', 'sub||c.bas', ' 3 True', 'True', '/app/subd.bas']);
  expect(host.fs.readFile('/app/.hidden.txt')).toBe('');
  expect(host.fs.files.has('/app/sub/d.bas')).toBe(true);
});

test('Kill of a read-only file is 75 (VB6); FSO DeleteFile with Force deletes it', async () => {
  const { out, host } = await run(`On Error Resume Next
SetAttr "r.txt", vbReadOnly
Kill "r.txt"
Debug.Print Err.Number; Dir("r.txt")
Err.Clear
Dim fso As Object
Set fso = CreateObject("Scripting.FileSystemObject")
fso.DeleteFile "r.txt", True
Debug.Print Err.Number; Dir("r.txt") = ""`, h => h.fs.writeFile('/app/r.txt', 'x'));
  expect(out).toEqual([' 75 r.txt', ' 0 True']);
  expect(host.fs.files.has('/app/r.txt')).toBe(false);
});

test('SaveSetting / GetSetting round trip, the default when missing, GetAllSettings, DeleteSetting', async () => {
  const { out } = await run(`SaveSetting "MyApp", "Startup", "Top", 75
SaveSetting "MyApp", "Startup", "Left", "50"
Debug.Print GetSetting("myapp", "startup", "TOP"); "|"; GetSetting("MyApp", "Startup", "Width", "100"); "|"; GetSetting("MyApp", "X", "Y")
Dim a As Variant
a = GetAllSettings("MyApp", "Startup")
Debug.Print UBound(a, 1); a(0, 0); a(0, 1)
DeleteSetting "MyApp", "Startup", "Top"
Debug.Print GetSetting("MyApp", "Startup", "Top", "gone")
On Error Resume Next
DeleteSetting "MyApp", "Nope"
Debug.Print Err.Number
Debug.Print IsEmpty(GetAllSettings("MyApp", "Nope"))`);
  expect(out).toEqual(['75|100|', ' 1 Top75', 'gone', ' 5 ', 'True']);
});

test('End closes the files and writes what was buffered', async () => {
  const { host } = await run(`Open "end.txt" For Output As #1
Open "bin.dat" For Binary As #2
Print #1, "kept"
End`);
  expect(host.fs.readFile('/app/end.txt')).toBe('kept\r\n');
  expect(host.fs.openCount).toBe(0);
});
