// Run-time error handling: On Error Resume Next / GoTo label / GoTo 0,
// Resume (Next, label), the Err object, Error(), and how errors bubble up
// the call stack to the nearest active handler (VB6 semantics).

import { Program, type ProgramOptions, type SourceModule } from '../../src/lang/interp/program';
import { VBRuntimeError } from '../../src/lang/errors';
import type { VBObject } from '../../src/lang/host';
import { TestHost, TEST_OPTIONS } from './testHost';

const lines = (...l: string[]) => l.join('\n');

function program(src: string | SourceModule[], host = new TestHost(), opts: ProgramOptions = {}) {
  const mods = typeof src === 'string' ? [{ name: 'Module1', kind: 'module' as const, source: src }] : src;
  return { host, prog: new Program(mods, host, { ...TEST_OPTIONS, ...opts }) };
}

async function run(src: string, host = new TestHost(), opts: ProgramOptions = {}): Promise<string[]> {
  const { prog } = program(src, host, opts);
  await prog.runEvent('Module1', 'Main');
  return host.lines();
}

describe('brief', () => {
  test('resume next', async () => {
    const out = await run(lines('Sub Main()', '  On Error Resume Next', '  x = 1 / 0', '  Debug.Print Err.Number', 'End Sub'));
    expect(out).toEqual([' 11 ']);
  });

  test('goto handler bubbles from callee', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error GoTo H', '  Call Bad', '  Exit Sub', 'H:', '  Debug.Print Err.Description', 'End Sub',
      'Sub Bad()', '  x = 1 / 0', 'End Sub',
    ));
    expect(out).toEqual(['Division by zero']);
  });

  test('err.raise custom', async () => {
    const out = await run(lines('Sub Main()', '  On Error Resume Next', '  Err.Raise 1000, , "Egen"', '  Debug.Print Err.Number; Err.Description', 'End Sub'));
    expect(out).toEqual([' 1000 Egen']);
  });
});

describe('bubbling', () => {
  test('an error bubbles through three levels; frames in between stop at once', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error GoTo H', '  A', '  Debug.Print "after A"; Err.Number', '  Exit Sub',
      'H:', '  Debug.Print "H"; Err.Number', '  Resume Next', 'End Sub',
      'Sub A()', '  Debug.Print "A1"', '  B', '  Debug.Print "A2"', 'End Sub',
      'Sub B()', '  Debug.Print "B1"', '  C', '  Debug.Print "B2"', 'End Sub',
      'Sub C()', '  Dim i As Integer', '  For i = 1 To 3', '    If i = 2 Then Err.Raise 77', '    Debug.Print "C"; i', '  Next', 'End Sub',
    ));
    expect(out).toEqual(['A1', 'B1', 'C 1 ', 'H 77 ', 'after A 0 ']);
  });

  test('the nearest handler wins (inner Resume Next shadows an outer GoTo)', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error GoTo H', '  A', '  Debug.Print "main done"', '  Exit Sub', 'H:', '  Debug.Print "outer"', 'End Sub',
      'Sub A()', '  On Error Resume Next', '  B', '  Debug.Print "A"; Err.Number', 'End Sub',
      'Sub B()', '  Debug.Print 1 / 0', '  Debug.Print "B not reached"', 'End Sub',
    ));
    expect(out).toEqual(['A 11 ', 'main done']);
  });

  test('an unhandled error in a callee is reported at the callee line', async () => {
    const out = await run(lines('Sub Main()', '  A', 'End Sub', 'Sub A()', '  Debug.Print 1 / 0', 'End Sub'));
    expect(out).toEqual(['[Error 11 at Module1:5] Division by zero']);
  });

  test('an error inside the handler is not handled by the same handler: it goes to the caller', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error GoTo Outer', '  Inner', '  Exit Sub', 'Outer:', '  Debug.Print "outer"; Err.Number', 'End Sub',
      'Sub Inner()', '  On Error GoTo H', '  Err.Raise 1001', '  Exit Sub', 'H:', '  Debug.Print "inner"; Err.Number', '  Debug.Print 1 / 0', '  Debug.Print "not reached"', 'End Sub',
    ));
    expect(out).toEqual(['inner 1001 ', 'outer 11 ']);
  });

  test('an error inside the handler with no handler above is unhandled, at the handler line', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error GoTo H', '  Err.Raise 5', '  Exit Sub', 'H:', '  Debug.Print "h"', '  Err.Raise 6', 'End Sub',
    ));
    expect(out).toEqual(['h', '[Error 6 at Module1:7] Overflow']);
  });

  test('a handler in a caller that is itself handling an error is skipped', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error GoTo M', '  Mid1', '  Exit Sub', 'M:', '  Debug.Print "main"; Err.Number', 'End Sub',
      'Sub Mid1()', '  On Error GoTo H', '  Err.Raise 1', '  Exit Sub', 'H:', '  Leaf', 'End Sub',
      'Sub Leaf()', '  Err.Raise 2', 'End Sub',
    ));
    expect(out).toEqual(['main 2 ']);
  });

  test('host object errors are caught like any other', async () => {
    const host = new TestHost();
    const bad: VBObject = {
      vbTypeName: 'Bad', hasMember: () => true, setMember: () => {}, callMethod: () => 0,
      getMember: () => { throw new VBRuntimeError(380); },
    };
    host.objects.set('bad', bad);
    const out = await run(lines('Sub Main()', '  On Error Resume Next', '  Debug.Print Bad.Value', '  Debug.Print Err.Number; Err.Description', 'End Sub'), host);
    expect(out).toEqual([' 380 Invalid property value']);
  });
});

describe('Resume', () => {
  test('Resume runs the failing statement again', async () => {
    const out = await run(lines(
      'Sub Main()', '  Dim d As Integer, n As Integer', '  On Error GoTo Fix', '  Debug.Print 10 / d', '  Debug.Print "n"; n', '  Exit Sub',
      'Fix:', '  n = n + 1', '  d = 5', '  Resume', 'End Sub',
    ));
    expect(out).toEqual([' 2 ', 'n 1 ']);
  });

  test('Resume re-calls a procedure that failed (the statement in the handler frame)', async () => {
    const out = await run(lines(
      'Dim calls As Integer',
      'Sub Main()', '  On Error GoTo Fix', '  Work', '  Debug.Print "done"; calls', '  Exit Sub', 'Fix:', '  Resume', 'End Sub',
      'Sub Work()', '  calls = calls + 1', '  If calls < 3 Then Err.Raise 9', 'End Sub',
    ));
    expect(out).toEqual(['done 3 ']);
  });

  test('Resume Next continues after the failing statement, inside a loop', async () => {
    const out = await run(lines(
      'Sub Main()', '  Dim i As Integer', '  On Error GoTo H', '  For i = 1 To 4', '    If i Mod 2 = 0 Then Err.Raise 1000 + i',
      '    Debug.Print "i"; i', '  Next', '  Debug.Print "end"', '  Exit Sub', 'H:', '  Debug.Print "err"; Err.Number', '  Resume Next', 'End Sub',
    ));
    expect(out).toEqual(['i 1 ', 'err 1002 ', 'i 2 ', 'i 3 ', 'err 1004 ', 'i 4 ', 'end']);
  });

  test('Resume label jumps to the label', async () => {
    const out = await run(lines(
      'Sub Main()', '  Dim n As Integer', '  On Error GoTo H', 'Again:', '  n = n + 1', '  If n < 3 Then Err.Raise 5', '  Debug.Print "n"; n', '  Exit Sub',
      'H:', '  Resume Again', 'End Sub',
    ));
    expect(out).toEqual(['n 3 ']);
  });

  test('Resume Next inside nested loops and Do loops (On Error Resume Next)', async () => {
    const out = await run(lines(
      'Sub Main()', '  Dim i As Integer, j As Integer, s As String', '  On Error Resume Next',
      '  For i = 1 To 2', '    j = 0', '    Do While j < 3', '      j = j + 1', '      s = s & (6 \\ (j - 2)) & ","', '    Loop', '  Next',
      '  Debug.Print s', 'End Sub',
    ));
    expect(out).toEqual(['-6,6,-6,6,']);
  });

  test('a handler that falls off End Sub leaves the procedure', async () => {
    const out = await run(lines(
      'Sub Main()', '  A', '  Debug.Print "back"; Err.Number', 'End Sub',
      'Sub A()', '  On Error GoTo H', '  Err.Raise 3', '  Debug.Print "no"', 'H:', '  Debug.Print "h"', 'End Sub',
    ));
    expect(out).toEqual(['h', 'back 0 ']);
  });

  test('Resume without an error is error 20', async () => {
    expect(await run(lines('Sub Main()', '  Resume', 'End Sub'))).toEqual(['[Error 20 at Module1:2] Resume without error']);
    expect(await run(lines('Sub Main()', '  On Error Resume Next', '  Resume Next', '  Debug.Print Err.Number', 'End Sub'))).toEqual([' 20 ']);
  });

  test('Resume to an unknown label and On Error GoTo an unknown label are compile errors', async () => {
    expect(await run(lines('Sub Main()', '  On Error GoTo Nowhere', 'End Sub')))
      .toEqual(['[Error 0 at Module1:2] Compile error: Label not defined']);
  });

  test('error in an If condition with Resume Next runs the Then branch (VB6 quirk)', async () => {
    const out = await run(lines('Sub Main()', '  On Error Resume Next', '  If 1 / 0 > 5 Then Debug.Print "then" Else Debug.Print "else"', '  Debug.Print Err.Number', 'End Sub'));
    expect(out).toEqual(['then', ' 11 ']);
  });

  test('an overflowing For increment with Resume Next leaves the loop', async () => {
    const out = await run(lines(
      'Sub Main()', '  Dim i As Integer', '  On Error Resume Next', '  For i = 32766 To 32767', '    Debug.Print i', '  Next', '  Debug.Print "after"; i; Err.Number', 'End Sub',
    ));
    expect(out).toEqual([' 32766 ', ' 32767 ', 'after 32767  6 ']);
  });

  test('On Error GoTo 0 turns handling off', async () => {
    const out = await run(lines('Sub Main()', '  On Error Resume Next', '  Debug.Print 1 / 0', '  On Error GoTo 0', '  Debug.Print 2 / 0', 'End Sub'));
    expect(out).toEqual(['[Error 11 at Module1:5] Division by zero']);
  });

  test('compile errors are never caught by On Error', async () => {
    const out = await run(lines('Option Explicit', 'Sub Main()', '  On Error Resume Next', '  y = 1', '  Debug.Print "after"', 'End Sub'));
    expect(out).toEqual(['[Error 0 at Module1:4] Compile error: Variable not defined']);
  });

  test('GoTo out of the handler keeps the handler active (a second error goes to the caller)', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error GoTo M', '  A', '  Exit Sub', 'M:', '  Debug.Print "main"; Err.Number', 'End Sub',
      'Sub A()', '  Dim n As Integer', '  On Error GoTo H', 'Top:', '  n = n + 1', '  Err.Raise 100 + n', '  Exit Sub', 'H:', '  GoTo Top', 'End Sub',
    ));
    expect(out).toEqual(['main 102 ']);
  });
});

describe('Err object', () => {
  test('Err is cleared by On Error, by a procedure with a handler returning, not by a handler-less Exit Sub', async () => {
    const out = await run(lines(
      'Sub Main()',
      '  On Error Resume Next',
      '  Err.Raise 5', '  ExitEarly', '  Debug.Print "exit sub"; Err.Number',
      '  Err.Raise 5', '  On Error Resume Next', '  Debug.Print "on error"; Err.Number',
      '  Err.Raise 5', '  WithHandler', '  Debug.Print "handler proc"; Err.Number',
      '  Err.Raise 5', '  NoHandler', '  Debug.Print "plain proc"; Err.Number',
      'End Sub',
      'Sub ExitEarly()', '  Exit Sub', 'End Sub',
      'Sub WithHandler()', '  On Error Resume Next', '  Err.Raise 7', 'End Sub',
      'Sub NoHandler()', '  Dim z', 'End Sub',
    ));
    expect(out).toEqual(['exit sub 5 ', 'on error 0 ', 'handler proc 0 ', 'plain proc 5 ']);
  });

  test('Exit Sub/Function in a procedure with a handler clears Err; without one it does not', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error Resume Next',
      '  Debug.Print 1 / 0', '  Call Helper', '  If Err.Number <> 0 Then Debug.Print "still"; Err.Number',
      '  Err.Raise 5', '  Handled', '  Debug.Print "handled"; Err.Number',
      '  Err.Raise 5', '  Debug.Print "fn"; F(); Err.Number',
      'End Sub',
      'Sub Helper()', '  If True Then Exit Sub', '  Debug.Print "no"', 'End Sub',
      'Sub Handled()', '  On Error Resume Next', '  Err.Raise 7', '  Exit Sub', 'End Sub',
      'Function F()', '  On Error GoTo H', '  Err.Raise 9', '  Exit Function', 'H:', '  F = "f"', '  Exit Function', 'End Function',
    ));
    expect(out).toEqual(['still 11 ', 'handled 0 ', 'fnf 0 ']);
  });

  test('Err stays set after Resume Next until cleared; Err.Clear clears', async () => {
    const out = await run(lines(
      'Sub Main()', '  On Error Resume Next', '  Err.Raise 13', '  Debug.Print Err.Number', '  Debug.Print Err.Number', '  Err.Clear', '  Debug.Print Err.Number; "["; Err.Description; "]"', 'End Sub',
    ));
    expect(out).toEqual([' 13 ', ' 13 ', ' 0 []']);
  });

  test('Number is the default member; properties are writable', async () => {
    const out = await run(lines(
      'Sub Main()', '  Err.Number = 42', '  Err.Description = "mine"', '  Err.Source = "src"',
      '  Debug.Print Err; Err.Description; " "; Err.Source', '  If Err Then Debug.Print "set"', '  Debug.Print TypeName(Err)', 'End Sub',
    ));
    expect(out).toEqual([' 42 mine src', 'set', 'ErrObject']);
  });

  test('Source defaults to the app title; Raise takes source and description', async () => {
    const src = lines(
      'Sub Main()', '  On Error Resume Next', '  Debug.Print 1 / 0', '  Debug.Print Err.Source',
      '  Err.Raise 600, "Lib", "Bad thing"', '  Debug.Print Err.Number; Err.Source; " "; Err.Description',
      '  Err.Raise 9', '  Debug.Print Err.Description', 'End Sub',
    );
    expect(await run(src, new TestHost(), { appTitle: 'MyApp' }))
      .toEqual(['MyApp', ' 600 Lib Bad thing', 'Subscript out of range']);
  });

  test('an unhandled Err.Raise is reported with its number and description', async () => {
    expect(await run(lines('Sub Main()', '  Err.Raise 1234, , "Custom failure"', 'End Sub')))
      .toEqual(['[Error 1234 at Module1:2] Custom failure']);
    expect(await run(lines('Sub Main()', '  Err.Raise 2000', 'End Sub')))
      .toEqual(['[Error 2000 at Module1:2] Application-defined or object-defined error']);
  });

  test('Error(n) gives the error text; Error alone the current description', async () => {
    const out = await run(lines('Sub Main()', '  Debug.Print Error(11)', '  Debug.Print Error$(13)', '  On Error Resume Next', '  Err.Raise 6', '  Debug.Print Error', 'End Sub'));
    expect(out).toEqual(['Division by zero', 'Type mismatch', 'Overflow']);
  });

  test('a Function handler sets the result and Exit Function keeps it', async () => {
    const out = await run(lines(
      'Sub Main()', '  Debug.Print SafeDiv(1, 0); SafeDiv(6, 3)', 'End Sub',
      'Function SafeDiv(a, b) As Double', '  On Error GoTo H', '  SafeDiv = a / b', '  Exit Function', 'H:', '  SafeDiv = -1', 'End Function',
    ));
    expect(out).toEqual(['-1  2 ']);
  });

  test('handlers in separate event runs do not catch each other\'s errors', async () => {
    const host = new TestHost();
    const { prog } = program([{
      name: 'Form1', kind: 'form', source: lines(
        'Sub A_Click()', '  On Error GoTo H', '  DoEvents', '  Debug.Print "a done"', '  Exit Sub', 'H:', '  Debug.Print "A caught"', 'End Sub',
        'Sub B_Click()', '  Debug.Print 1 / 0', 'End Sub',
      ),
    }], host);
    let inner: Promise<void> | undefined;
    host.doEvents = () => { inner = prog.runEvent('Form1', 'B_Click'); return Promise.resolve(); };
    await prog.runEvent('Form1', 'A_Click');
    await inner;
    expect(host.lines()).toEqual(['[Error 11 at Form1:10] Division by zero']);
    expect(prog.state).toBe('ended');
  });
});
