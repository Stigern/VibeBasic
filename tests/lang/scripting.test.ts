// 0.9 A3: CreateObject and the Scripting runtime (Dictionary, FileSystemObject + TextStream) on the test host's files.
import { expect, test } from 'vitest';
import { Program } from '../../src/lang/interp/program';
import { TestHost } from './testHost';

async function run(body: string) {
  const host = new TestHost();
  host.fs.mkdirs('/app');
  const prog = new Program([{ name: 'Module1', kind: 'module', source: `Sub Main()\n${body}\nEnd Sub\n` }], host, { locale: 'en-US', appPath: '/app' });
  await prog.runEvent('Module1', 'Main');
  await new Promise(r => setTimeout(r, 0));
  return host.lines();
}

test('Dictionary: Add, Item, Exists, Remove, Keys / Items, Count, CompareMode, For Each, errors', async () => {
  expect(await run(`Dim d As Object, k As Variant, s As String
Set d = CreateObject("Scripting.Dictionary")
d.Add "a", 1
d.Add "A", 2
d("b") = 3
d.Item("a") = 10
Debug.Print d.Count; d("a"); d("A"); d.Exists("b"); d.Exists("c")
For Each k In d.Keys: s = s & k & "=" & d(k) & " ": Next
Debug.Print s; UBound(d.Items)
x = d("new"): Debug.Print d.Count; IsEmpty(d("new"))
d.Remove "new": d.Key("b") = "B": Debug.Print Join(d.Keys, ",")
On Error Resume Next
d.Add "a", 0: Debug.Print Err.Number: Err.Clear
d.Remove "zz": Debug.Print Err.Number: Err.Clear
d.CompareMode = vbTextCompare: Debug.Print Err.Number: Err.Clear
d.RemoveAll
Dim t As New Scripting.Dictionary
t.CompareMode = vbTextCompare: t.Add "X", 1: t.Add "x", 2: Debug.Print Err.Number; t.Count; TypeName(t)`)).toEqual([
    ' 3  10  2 TrueFalse', 'a=10 A=2 b=3  2 ', ' 4 True', 'a,A,B', ' 457 ', ' 32811 ', ' 5 ', ' 457  1 Dictionary']);
});

test('FileSystemObject: write and read a text file, File / Folder, paths', async () => {
  expect(await run(`Dim fso As Object, ts As Object, f As Object, s As String
Set fso = CreateObject("Scripting.FileSystemObject")
Set ts = fso.CreateTextFile(fso.BuildPath("/app", "a.txt"), True)
ts.WriteLine "one"
ts.Write "two"
ts.WriteLine
ts.Close
Set ts = fso.OpenTextFile("a.txt", ForAppending)
ts.WriteLine "three": ts.Close
Set ts = fso.OpenTextFile("a.txt")
Do Until ts.AtEndOfStream
  s = s & "[" & ts.ReadLine & "]"
Loop
ts.Close
Debug.Print s; fso.FileExists("a.txt"); fso.FileExists("b.txt"); fso.FolderExists("/app")
Set f = fso.GetFile("a.txt")
Debug.Print f.Name; f.Size; f.Path; fso.GetFolder(".").Files.Count; f.ParentFolder.Path
Debug.Print fso.OpenTextFile("a.txt", 1).ReadAll = "one" & vbCrLf & "two" & vbCrLf & "three" & vbCrLf
fso.CopyFile "a.txt", "c.txt": fso.MoveFile "c.txt", "d.txt": Debug.Print fso.FileExists("c.txt"); fso.FileExists("d.txt")
fso.DeleteFile "d.txt": Debug.Print fso.FileExists("d.txt")
Debug.Print fso.GetParentFolderName("C:\\x\\y.txt"); " "; fso.GetFileName("C:\\x\\y.txt"); " "; fso.GetBaseName("y.tar.gz"); " "; fso.GetExtensionName("y.txt")
On Error Resume Next
Set ts = fso.OpenTextFile("nope.txt"): Debug.Print Err.Number: Err.Clear
Set ts = fso.CreateTextFile("a.txt", False): Debug.Print Err.Number`)).toEqual([
    '[one][two][three]TrueFalseTrue', 'a.txt 17 /app/a.txt 1 /app', 'True', 'FalseTrue', 'False', 'C:\\x y.txt y.tar txt', ' 53 ', ' 58 ']);
});

test('CreateObject of an unknown ProgID is 429; New ADODB.Connection without a database host too', async () => {
  expect(await run(`On Error Resume Next
Dim o As Object
Set o = CreateObject("Excel.Application")
Debug.Print Err.Number; Err.Description
Err.Clear
Set o = New ADODB.Connection
Debug.Print Err.Number`)).toEqual([" 429 ActiveX component can't create object", ' 429 ']);
});
