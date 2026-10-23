// Review 08 final #4: the compile errors lang-08 raises when a call runs are found before the program starts, as in VB6.
import { expect, test } from 'vitest';
import { Program } from '../../src/lang/interp/program';
import { VBSyntaxError } from '../../src/lang/errors';
import { TestHost } from './testHost';

/** The compile error `new Program` throws ("Module1:3 ByRef argument type mismatch"), or null when it starts. */
function compile(main: string, other = ''): string | null {
  const mods = [{ name: 'Module1', kind: 'module' as const, source: main }];
  if (other) mods.push({ name: 'Module2', kind: 'module' as const, source: other });
  try {
    new Program(mods, new TestHost(), { locale: 'en-US' });
    return null;
  } catch (e) {
    if (e instanceof VBSyntaxError) return `${e.moduleName}:${e.line} ${e.message}`;
    throw e;
  }
}

const INC = 'Private Sub Inc(n As Integer)\n  n = n + 1\nEnd Sub\nPrivate Sub IncL(n As Long)\nEnd Sub\nPrivate Sub Fill(a() As Long)\nEnd Sub\n';
const sub = (body: string, decls = '') => `${decls}\n${INC}Sub Main()\n${body}\nEnd Sub\n`;

test('a variable of another type for a typed ByRef parameter does not compile, even when never called', () => {
  expect(compile(sub('  Dim total As Long\n  If False Then Inc total'))).toBe('Module1:11 ByRef argument type mismatch')   // line 1 is empty, 2-8 INC, 9 Sub Main;
  expect(compile(sub('  Dim total\n  IncL total'))).toMatch(/ByRef argument type mismatch/);
  expect(compile(sub('  Dim v(3)\n  Inc v(1)'))).toMatch(/ByRef argument type mismatch/);
  expect(compile(sub('  Dim x As Integer\n  y = Twice(x)'), 'Public Function Twice(n As Long) As Long\nEnd Function')).toMatch(/Module1:\d+ ByRef argument type mismatch/);
  expect(compile(sub('  IncL m'), 'Public m As Integer')).toMatch(/ByRef argument type mismatch/);
});

test('what VB6 compiles is not reported', () => {
  for (const body of [
    '  Dim i As Integer, l As Long\n  Inc i: Inc (l): Inc l + 0: Call Inc((l)): IncL l',
    '  Dim a(2) As Long, c As Long\n  Fill a: IncL a(0): Inc 5: Inc c * 1',
    '  Inc undeclared',               // left to the run (it may be an implicit Variant or something else)
    '  Const K = 3\n  Inc K',
    '  Dim e As Colour\n  IncL e',    // an Enum is a Long
  ]) expect(compile(sub(body, 'Enum Colour\n  Red\nEnd Enum'))).toBeNull();
  // a ByVal or Variant parameter takes anything
  expect(compile('Sub A(ByVal n As Integer)\nEnd Sub\nSub B(v)\nEnd Sub\nSub Main()\n  Dim l As Long\n  A l: B l\nEnd Sub')).toBeNull();
  // a local of the same name hides the procedure
  expect(compile(sub('  Dim Inc(2) As Integer, l As Long\n  Inc(0) = l'))).toBeNull();
});

test('a parenthesised array or record, New of a record or a class, LSet of a record', () => {
  expect(compile(sub('  Dim a(2) As Long\n  Fill (a)'))).toMatch(/Type mismatch: array or user-defined type expected/);
  const rec = 'Type P\n  X As Integer\nEnd Type';
  expect(compile(sub('  Dim q As New P', rec))).toMatch(/Invalid use of New keyword/);
  expect(compile(sub('  Dim d As Object\n  Set d = New Gadget'))).toMatch(/User-defined type not defined/);
  expect(compile(sub('  Dim a As P, b As P\n  LSet a = b', rec))).toMatch(/Not supported in VibeBasic: LSet of a user-defined type/);
  expect(compile(sub('', 'Private c As New Thing'))).toMatch(/Module1:1 User-defined type not defined/);
  expect(compile(sub('  Dim c As New Collection, s As String * 4\n  Set c = New Collection\n  LSet s = "ab"'))).toBeNull();
});
