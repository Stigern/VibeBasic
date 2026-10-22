// Built-ins called from VB source: name lookup, statement calls, $ variants, host dialogs, dates by locale.

import { Program } from '../../src/lang/interp/program';
import { TestHost } from './testHost';

async function run(body: string, opts: { locale?: string; appTitle?: string; setup?: (h: TestHost) => void } = {}) {
  const host = new TestHost();
  opts.setup?.(host);
  const src = `Sub Main()\n${body}\nEnd Sub\n`;
  const prog = new Program([{ name: 'Module1', kind: 'module', source: src }], host, { locale: opts.locale ?? 'en-US', appTitle: opts.appTitle });
  await prog.runEvent('Module1', 'Main');
  return host.lines();
}

test('$ variants and bare names', async () => {
  expect(await run(`Debug.Print Left$("abc", 2); Mid$("abcdef", 2, 3); UCase$("x"); Chr$(65); Trim$("  y "); Str$(5)
Debug.Print Format$(5, "00")
Debug.Print Len(Date) > 0
Debug.Print Timer >= 0
Debug.Print Rnd < 1
Debug.Print Year(Now) > 2020`)).toEqual(['abbcdXAy 5', '05', 'True', 'True', 'True', 'True']);
});

test('built-in statements: Randomize, DoEvents, MsgBox', async () => {
  const out = await run(`Randomize 3
Randomize
DoEvents
MsgBox "plain"
MsgBox "with title", vbInformation, "Hello"
Dim r As Integer
r = MsgBox("Really?", vbYesNo + vbQuestion)
Debug.Print r`, { setup: h => { h.msgBoxAnswers = [1, 1, 7]; } });
  expect(out).toEqual(['[MsgBox] plain', '[MsgBox] with title', '[MsgBox] Really?', ' 7 ']);
});

test('MsgBox default title and buttons reach the host', async () => {
  const host = new TestHost();
  const seen: [string, number, string][] = [];
  host.msgBox = async (p, b, t) => { seen.push([p, b, t]); return 6; };
  const src = `Sub Main()
MsgBox "a"
MsgBox "b", vbYesNo + vbQuestion + vbDefaultButton2
MsgBox "c", , "Mine"
End Sub
`;
  await new Program([{ name: 'Module1', kind: 'module', source: src }], host, { appTitle: 'Calc' }).runEvent('Module1', 'Main');
  expect(seen).toEqual([['a', 0, 'Calc'], ['b', 292, 'Calc'], ['c', 0, 'Mine']]);
  const host2 = new TestHost();
  host2.msgBox = async (_p, _b, t) => { seen.push(['', 0, t]); return 1; };
  await new Program([{ name: 'Module1', kind: 'module', source: src }], host2).runEvent('Module1', 'Main');
  expect(seen[3][2]).toBe('Project1');
});

test('InputBox', async () => {
  expect(await run(`Dim s As String
s = InputBox("Name?", "T", "Bob")
Debug.Print s
s = InputBox("Name?")
Debug.Print "[" & s & "]"`, { setup: h => { h.inputBoxAnswers = ['Ann']; } })).toEqual(['Ann', '[]']);
});

test('wrong argument count is error 450', async () => {
  const out = await run(`Debug.Print Left("a")`);
  expect(out).toEqual(['[Error 450 at Module1:2] Wrong number of arguments or invalid property assignment']);
});

test('invalid argument is error 5', async () => {
  expect(await run(`Debug.Print Mid("abc", 0)`)).toEqual(['[Error 5 at Module1:2] Invalid procedure call or argument']);
});

test('dates print and convert by locale', async () => {
  const body = `Dim d As Date
d = DateSerial(2026, 10, 22) + TimeSerial(13, 5, 0)
Debug.Print d
Debug.Print CStr(d)
Debug.Print "at " & d
Debug.Print DateSerial(2026, 10, 22)
Debug.Print TimeSerial(13, 5, 9)`;
  expect(await run(body, { locale: 'en-US' })).toEqual([
    '10/22/2026 1:05:00 PM', '10/22/2026 1:05:00 PM', 'at 10/22/2026 1:05:00 PM', '10/22/2026', '1:05:09 PM',
  ]);
  expect(await run(body, { locale: 'nb-NO' })).toEqual([
    '22.10.2026 13:05:00', '22.10.2026 13:05:00', 'at 22.10.2026 13:05:00', '22.10.2026', '13:05:09',
  ]);
});

test('constants resolve in code, user names win', async () => {
  expect(await run(`Debug.Print vbYes; vbCrLf = Chr(13) & Chr(10); vbRed`)).toEqual([' 6 True 255 ']);
  expect(await run(`Dim vbYes As Integer
vbYes = 99
Debug.Print vbYes`)).toEqual([' 99 ']);
});

test('Format and Array from code', async () => {
  expect(await run(`Dim a As Variant
a = Array(10, 20, 30)
Debug.Print UBound(a); a(1)
Debug.Print Format(1234.5, "#,##0.00"); "|"; Format(0.256, "0%")
Debug.Print Join(Split("a-b-c", "-"), "+")
Debug.Print IIf(1 > 2, "yes", "no")
Debug.Print TypeName(Null); TypeName(3.5); VarType("x")`)).toEqual([' 2  20 ', '1,234.50|26%', 'a+b+c', 'no', 'NullDouble 8 ']);
});

test('LoadPicture goes to the host', async () => {
  const host = new TestHost();
  const paths: string[] = [];
  host.loadPicture = async p => { paths.push(p); return 'handle' as never; };
  const src = `Sub Main()\nDim p As Variant\np = LoadPicture("a.bmp")\nDebug.Print p\nEnd Sub\n`;
  await new Program([{ name: 'Module1', kind: 'module', source: src }], host).runEvent('Module1', 'Main');
  expect(paths).toEqual(['a.bmp']);
  expect(host.lines()).toEqual(['handle']);
});

// ---- review fixes: no process-global state between Programs ----
import { dateFrom, toStr } from '../../src/lang/values';

const DATE_SRC = `Sub Main()
Debug.Print DateSerial(2026, 10, 22) + TimeSerial(13, 5, 0)
DoEvents
Debug.Print CStr(DateSerial(2026, 10, 22)) & "|" & DateSerial(2026, 10, 22)
End Sub
`;
const newProg = (src: string, host: TestHost, locale?: string) =>
  new Program([{ name: 'Module1', kind: 'module', source: src }], host, locale ? { locale } : {});

test('date locale belongs to its Program, not to the last one constructed', async () => {
  const h1 = new TestHost();
  const h2 = new TestHost();
  const p1 = newProg(DATE_SRC, h1, 'en-US');
  newProg(DATE_SRC, h2, 'nb-NO'); // constructed later, never run
  await p1.runEvent('Module1', 'Main');
  expect(h1.lines()).toEqual(['10/22/2026 1:05:00 PM', '10/22/2026|10/22/2026']);
});

test('interleaved runs of two Programs keep their own locale', async () => {
  const h1 = new TestHost();
  const h2 = new TestHost();
  const p1 = newProg(DATE_SRC, h1, 'en-US');
  const p2 = newProg(DATE_SRC, h2, 'nb-NO');
  // DoEvents is awaited, so the two runs interleave
  await Promise.all([p1.runEvent('Module1', 'Main'), p2.runEvent('Module1', 'Main')]);
  expect(h1.lines()).toEqual(['10/22/2026 1:05:00 PM', '10/22/2026|10/22/2026']);
  expect(h2.lines()).toEqual(['22.10.2026 13:05:00', '22.10.2026|22.10.2026']);
});

test('the date formatter is restored after a run (outside code uses the default)', async () => {
  const h = new TestHost();
  await newProg(DATE_SRC, h, 'nb-NO').runEvent('Module1', 'Main');
  expect(toStr(dateFrom(2026, 10, 22))).toBe('2026-10-22');
});

test('Rnd sequence is per Program: fresh Programs repeat VB\'s fixed sequence', async () => {
  const src = `Sub Main()\nDebug.Print Rnd; Rnd; Rnd\nEnd Sub\n`;
  const outs: string[][] = [];
  for (let i = 0; i < 2; i++) {
    const h = new TestHost();
    await newProg(src, h, 'en-US').runEvent('Module1', 'Main');
    outs.push(h.lines());
  }
  expect(outs[0]).toEqual(outs[1]);
  expect(outs[0][0].startsWith(' .705547')).toBe(true); // VB's first value 0.7055475
  // a second run in the same Program continues the sequence
  const h = new TestHost();
  const p = newProg(src, h, 'en-US');
  await p.runEvent('Module1', 'Main');
  await p.runEvent('Module1', 'Main');
  expect(h.lines()[1]).not.toBe(h.lines()[0]);
});

test('Randomize in one Program does not disturb another', async () => {
  const src = `Sub Main()\nDebug.Print Rnd\nEnd Sub\n`;
  const rand = `Sub Main()\nRandomize 42\nDebug.Print Rnd\nEnd Sub\n`;
  const a = new TestHost();
  const pa = newProg(src, a);
  await newProg(rand, new TestHost()).runEvent('Module1', 'Main');
  await pa.runEvent('Module1', 'Main');
  const b = new TestHost();
  await newProg(src, b).runEvent('Module1', 'Main');
  expect(a.lines()).toEqual(b.lines());
});
