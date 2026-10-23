// VB6 syntax of 0.9.0 (A2): TypeOf, named arguments, Option Base / Compare, GoSub / Return, On n GoTo, #If,
// financial functions, Debug.Assert.

import { describe, expect, it } from 'vitest';
import { Program, type ProgramOptions, type SourceModule } from '../../src/lang/interp/program';
import { TestHost, TEST_OPTIONS } from './testHost';
import { checkLineSyntax } from '../../src/lang/parser';

const lines = (...l: string[]) => l.join('\n');

/** Runs `Main` of Module1 with the extra modules; returns the host (output lines in `lines()`). */
async function run(main: string, extra: SourceModule[] = [], opts: ProgramOptions = {}): Promise<TestHost> {
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: main }, ...extra], host, { ...TEST_OPTIONS, ...opts });
  await prog.runEvent('Module1', 'Main');
  return host;
}
const out = async (main: string, extra: SourceModule[] = [], opts: ProgramOptions = {}) => (await run(main, extra, opts)).lines();

describe('A2 syntax', () => {
  it('TypeOf for a class, Collection and Nothing, with Not and in expressions', async () => {
    expect(await out(lines(
      'Sub Main()',
      '  Dim a As Object, c As New Collection, n As Object',
      '  Set a = New Dog',
      '  If TypeOf a Is Dog Then Debug.Print "dog"',
      '  If Not TypeOf a Is Collection Then Debug.Print "not coll"',
      '  Debug.Print TypeOf a Is IAnimal; TypeOf a Is Object; TypeOf c Is Collection; TypeOf n Is Dog',
      'End Sub'), [
      { name: 'IAnimal', kind: 'class', source: 'Public Sub Speak()\nEnd Sub' },
      { name: 'Dog', kind: 'class', source: 'Implements IAnimal\nPrivate Sub IAnimal_Speak()\nEnd Sub' },
    ])).toEqual(['dog', 'not coll', 'TrueTrueTrueFalse']);
  });

  it('named arguments: user procedures (skipping an Optional), built-ins, unknown name 448', async () => {
    const h = await run(lines(
      'Sub Show(a As String, Optional b As String = "B", Optional c As String = "C")',
      '  Debug.Print a & b & c',
      'End Sub',
      'Sub Main()',
      '  Show "x", c:="z"',
      '  Show c:="3", a:="1"',
      '  Call Show(a:="p", b:="q")',
      '  Debug.Print Mid(String:="abcdef", Start:=2, Length:=3); InStr(String1:="hello", String2:="l"); Format(Expression:=1.5, Format:="0.00")',
      '  MsgBox Title:="T", Prompt:="hi"',
      '  On Error Resume Next',
      '  Show a:="x", zz:="y"',
      '  Debug.Print Err.Number',
      'End Sub'));
    expect(h.lines()).toEqual(['xBz', '1B3', 'pqC', 'bcd 3 1.50', '[MsgBox] hi', ' 448 ']);
  });

  it('Option Base 1 sets the lower bound of Dim and Array (per module); Option Compare Text compares without case; Global', async () => {
    expect(await out(lines(
      'Option Base 1',
      'Option Compare Text',
      'Sub Main()',
      '  Dim a(3) As Integer, v',
      '  v = Array(10, 20)',
      '  Debug.Print LBound(a); UBound(a); LBound(v); v(1)',
      '  Debug.Print "abc" = "ABC"; "a" < "B"; "HELLO" Like "h*o"; InStr("xAbc", "aB"); StrComp("abc", "ABC"); StrComp("a", "A", vbBinaryCompare)',
      '  Select Case "YES"',
      '    Case "yes": Debug.Print "case"',
      '  End Select',
      '  gName = "x"',
      '  Debug.Print LBound(gArr); gName',
      'End Sub'), [
      { name: 'Module2', kind: 'module', source: 'Option Private Module\nGlobal gName As String, gArr(2) As Integer' },
    ])).toEqual([' 1  3  1  10 ', 'TrueTrueTrue 2  0  1 ', 'case', ' 0 x']);
    // another module without Option Compare Text stays binary
    expect(await out('Sub Main()\nDebug.Print Same(); "a" = "A"\nEnd Sub', [
      { name: 'Module2', kind: 'module', source: 'Option Compare Text\nPublic Function Same() As Boolean\nSame = "a" = "A"\nEnd Function' },
    ])).toEqual(['TrueFalse']);
  });

  it('GoSub / Return, nested, and Return without GoSub (error 3)', async () => {
    expect(await out(lines(
      'Sub Main()',
      '  Dim i As Integer',
      '  For i = 1 To 2',
      '    GoSub Twice',
      '  Next',
      '  On Error Resume Next',
      '  Return',
      '  Debug.Print "err"; Err.Number',
      '  Exit Sub',
      'Twice:',
      '  Debug.Print "twice"; i',
      '  GoSub Inner',
      '  Return',
      'Inner:',
      '  Debug.Print "inner"',
      '  Return',
      'End Sub'))).toEqual(['twice 1 ', 'inner', 'twice 2 ', 'inner', 'err 3 ']);
  });

  it('On n GoTo / GoSub: the n-th label, out of range goes on, negative is error 5', async () => {
    expect(await out(lines(
      'Sub Main()',
      '  Dim n As Integer',
      '  For n = 0 To 3',
      '    On n GoSub One, Two',
      '    Debug.Print "after"; n',
      '  Next',
      '  On 2 GoTo L1, L2',
      'L1: Debug.Print "L1"',
      'L2: Debug.Print "L2"',
      '  On Error Resume Next',
      '  On -1 GoTo L1',
      '  Debug.Print Err.Number',
      '  Exit Sub',
      'One: Debug.Print "one": Return',
      'Two: Debug.Print "two": Return',
      'End Sub'))).toEqual(['after 0 ', 'one', 'after 1 ', 'two', 'after 2 ', 'after 3 ', 'L2', ' 5 ']);
  });

  it('#Const / #If / #ElseIf / #Else with project constants; excluded code is not compiled', async () => {
    const main = lines(
      '#Const LEVEL = 2',
      'Sub Main()',
      '#If LEVEL = 1 Then',
      '  Debug.Print "one"',
      '#ElseIf LEVEL = 2 And DEBUGGING Then',
      '  Debug.Print "two, debugging"',
      '#Else',
      '  Debug.Print "other": this is not VB at all',
      '#End If',
      '#If Win32 Then',
      '  Debug.Print "win32"; Erl',
      '#End If',
      'End Sub');
    expect(await out(main, [], { condComp: 'DEBUGGING = 1' })).toEqual(['two, debugging', 'win32 0 ']);
    await expect(out(main)).rejects.toThrow(/Syntax error|Expected/);
    expect(() => new Program([{ name: 'M', kind: 'module', source: '#If 1 Then\nSub Main()\nEnd Sub' }], new TestHost()))
      .toThrow('#If block not terminated by #End If');
    // the editor's line check takes a directive line on its own
    expect([checkLineSyntax('#Else'), checkLineSyntax('  #End If'), checkLineSyntax('#If X = 1 Then')]).toEqual([null, null, null]);
    expect(checkLineSyntax('#If X')?.message).toBe('Expected: Then');
  });

  it('financial functions give VB6 values', async () => {
    expect(await out(lines(
      'Sub Main()',
      '  Dim v(5) As Double',
      '  v(0) = -70000: v(1) = 12000: v(2) = 15000: v(3) = 18000: v(4) = 21000: v(5) = 26000',
      '  Debug.Print Format(Pmt(0.08 / 12, 48, -10000), "0.000000"); " "; Format(FV(0.06 / 12, 12, -100), "0.000000")',
      '  Debug.Print Format(IRR(v), "0.000000"); " "; Format(NPV(0.1, v), "0.00"); " "; Format(Rate(48, -244.129223, 10000) * 12, "0.000000")',
      '  Debug.Print Format(PV(0.08 / 12, 48, -244.129223), "0.00"); " "; Format(NPer(0.08 / 12, -244.129223, 10000), "0.00")',
      '  Debug.Print Format(IPmt(0.1 / 12, 1, 36, -8000), "0.00"); " "; Format(PPmt(0.1 / 12, 1, 36, -8000), "0.00"); " "; Format(MIRR(v, 0.1, 0.12), "0.0000")',
      '  Debug.Print DDB(2400, 300, 10, 1); Format(DDB(2400, 300, 10, 10), "0.00"); SLN(30000, 7500, 10); SYD(30000, 7500, 10, 1); TypeName(Pmt(0.1, 2, 100))',
      'End Sub'))).toEqual([
      '244.129223 1233.556237',
      '0.086631 -2439.37 0.080000',
      '10000.00 48.00',
      '66.67 191.47 0.0987',
      ' 480 22.12 2250  4090.90909090909 Double',
    ]);
  });

  it('Debug.Assert breaks when False in the IDE and is skipped in a made app; Partition and byte functions', async () => {
    const src = lines(
      'Function Side() As Boolean',
      '  Debug.Print "evaluated"',
      'End Function',
      'Sub Main()',
      '  Debug.Assert 1 = 1',
      '  Debug.Assert Side()',
      '  Debug.Print "after"; Partition(25, 0, 99, 10); "|"; Partition(150, 0, 99, 10); "|"',
      '  Debug.Print LenB("ab"); AscB("A"); MidB("abc", 3, 2); InStrB("abc", "c"); LeftB("abc", 4); RightB("abc", 2)',
      'End Sub');
    const ide = new TestHost();
    ide.breakChoice = 'continue';
    await new Program([{ name: 'Module1', kind: 'module', source: src }], ide, TEST_OPTIONS).runEvent('Module1', 'Main');
    expect(ide.breaks.map(b => `${b.reason}@${b.at.line}`)).toEqual(['pause@6']);
    expect(ide.lines()).toEqual(['evaluated', 'after 20: 29|100:   |', ' 4  65 b 5 abc']);
    expect(await out(src, [], { ignoreAsserts: true })).toEqual(['after 20: 29|100:   |', ' 4  65 b 5 abc']);
  });
});
