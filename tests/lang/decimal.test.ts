// Decimal (CDec): exact to 28 decimals and 29 digits, VB6's widest numeric type.

import { decDiv, decFromNumber, decFromText, decMul, decRound, decText } from '../../src/lang/decimal';
import { Program } from '../../src/lang/interp/program';
import { TestHost } from './testHost';

const d = (s: string) => decFromText(s)!;

async function run(body: string) {
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: `Sub Main()\n${body}\nEnd Sub\n` }], host, { locale: 'en-US' });
  await prog.runEvent('Module1', 'Main');
  return host.lines();
}

test('decimal core: exact text, rounding, limits', () => {
  expect(decText(d('12345678901234567890.25'))).toBe('12345678901234567890.25');
  expect(decText(d('1.50'))).toBe('1.5');
  expect(decText(d('-.5'))).toBe('-0.5');
  expect(decText(d('1E+3'))).toBe('1000');
  expect(decText(decFromNumber(0.1))).toBe('0.1');
  expect(decText(decDiv(d('1'), d('3')))).toBe('0.3333333333333333333333333333');
  expect(decText(decDiv(d('2'), d('3')))).toBe('0.6666666666666666666666666667');
  expect(decText(decMul(d('0.0000000000000001'), d('0.0000000000000001')))).toBe('0');   // 1E-32 rounds away
  expect(decText(decRound(d('2.345'), 2))).toBe('2.34');   // half to even
  expect(decText(decRound(d('2.355'), 2))).toBe('2.36');
  expect(decText(d('79228162514264337593543950335'))).toBe('79228162514264337593543950335');
  expect(() => d('79228162514264337593543950336')).toThrow(expect.objectContaining({ number: 6 }));
  expect(decFromText('abc')).toBeUndefined();
});

test('CDec keeps its digits through arithmetic, printing, Format and files', async () => {
  expect(await run(`Dim v, w
v = CDec("12345678901234567890.25")
Debug.Print v; TypeName(v); VarType(v)
Debug.Print CDec(0.1) + CDec(0.2) = CDec(0.3), TypeName(CDec(1) + 1.5), CDec(1) / 3
Debug.Print Format(v, "#,##0.00"); "|"; FormatNumber(v, 1); "|"; Str(CDec("-0.5")); "|"; CStr(CDec("1.50"))
Debug.Print Int(CDec("-2.5")); Fix(CDec("-2.5")); Abs(CDec("-3.25")); Sgn(CDec(-1)); Round(CDec("2.345"), 2)
Open "b.dat" For Binary As #1: Put #1, , v: Debug.Print LOF(1): Seek 1, 1: Get #1, , w: Close #1
Debug.Print w = v, TypeName(w)
Open "t.txt" For Output As #1: Write #1, CDec("1.5"), CDec(-2): Close #1
Open "t.txt" For Input As #1: Line Input #1, w: Close #1: Debug.Print w
Dim dict: Set dict = CreateObject("Scripting.Dictionary"): dict(CDec(1)) = "a": dict(CDec("1.0")) = "b": Debug.Print dict.Count; dict(CDec(1))
Dim m: m = CDec("79228162514264337593543950335")
m = m + 1`)).toEqual([
    ' 12345678901234567890.25 Decimal 14 ',
    'True          Decimal        .3333333333333333333333333333 ',
    '12,345,678,901,234,567,890.25|12,345,678,901,234,567,890.3|-.5|1.5',
    '-3 -2  3.25 -1  2.34 ',
    ' 16 ',
    'True          Decimal',
    '1.5,-2',
    ' 1 b',
    '[Error 6 at Module1:14] Overflow',
  ]);
});
