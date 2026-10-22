import { BUILTINS, CONSTANTS } from '../../src/lang/builtins';
import { formatValue, generalDateText } from '../../src/lang/builtins/format';
import { Empty, Nothing, Null, VBArray, dateFrom, type VBValue } from '../../src/lang/values';
import { TestHost } from './testHost';

const testCtx = { host: new TestHost(), locale: 'en-US' };
const call = (n: string, ...a: VBValue[]) => BUILTINS.get(n.toLowerCase())!.fn(a, testCtx);

// ---- brief tests (verbatim) ----
test('mid/instr', () => { expect(call('Mid', 'Hallo', 2, 3)).toBe('all'); expect(call('InStr', 'abcabc', 'c')).toBe(3); expect(call('InStr', 3, 'abcabc', 'a')).toBe(4); });
test('str vs cstr', () => { expect(call('Str', 5)).toBe(' 5'); expect(call('CStr', 5)).toBe('5'); expect(call('Str', 0.5)).toBe(' .5'); });
test('val stops at junk', () => { expect(call('Val', '12abc')).toBe(12); expect(call('Val', '3,5')).toBe(3); expect(call('Val', '&HFF')).toBe(255); });
test('windows-1252', () => { expect(call('Chr', 230)).toBe('æ'); expect(call('Asc', 'ø')).toBe(248); expect(call('Chr', 128)).toBe('€'); });
test('cint banker', () => expect(call('CInt', 2.5)).toBe(2));
test('format', () => { expect(formatValue(1234.5, '#,##0.00', 'en-US')).toBe('1,234.50'); expect(formatValue(0.256, '0%', 'en-US')).toBe('26%'); expect(formatValue(5, '000', 'en-US')).toBe('005'); });
test('format date', () => expect(formatValue(dateFrom(2026, 10, 22, 13, 5, 0), 'dd.mm.yyyy hh:nn', 'en-US')).toBe('22.10.2026 13:05'));
test('rgb', () => expect(call('RGB', 255, 0, 0)).toBe(255));
test('wrong arg count', () => expect(() => call('Mid')).toThrow(expect.objectContaining({ number: 450 })));

// ---- helpers ----
const err = (n: number) => expect.objectContaining({ number: n });
const arr = (a: unknown) => (a as VBArray).values();
const D = dateFrom(2026, 10, 22, 13, 5, 9); // Thursday
const fmt = (v: VBValue, f: string) => formatValue(v, f, 'en-US');

// ---- strings ----
test('Left/Right/Mid', () => {
  expect(call('Left', 'Hallo', 2)).toBe('Ha');
  expect(call('Left', 'ab', 5)).toBe('ab');
  expect(call('Left', 'ab', 0)).toBe('');
  expect(() => call('Left', 'ab', -1)).toThrow(err(5));
  expect(call('Right', 'Hallo', 3)).toBe('llo');
  expect(call('Right', 'ab', 9)).toBe('ab');
  expect(call('Right', 'ab', 0)).toBe('');
  expect(call('Mid', 'Hallo', 2)).toBe('allo');
  expect(call('Mid', 'abc', 5)).toBe('');
  expect(call('Mid', 'abc', 2, 100)).toBe('bc');
  expect(() => call('Mid', 'abc', 0)).toThrow(err(5));
  expect(() => call('Mid', 'abc', 2, -1)).toThrow(err(5));
  expect(call('Mid', Null, 1)).toBe(Null);
  expect(call('Len', Null)).toBe(Null);
  expect(call('Len', 12345)).toBe(5);
  expect(call('Len', 'æøå')).toBe(3);
});

test('InStr / InStrRev', () => {
  expect(call('InStr', 'ABC', 'b')).toBe(0);
  expect(call('InStr', 1, 'ABC', 'b', 1)).toBe(2);
  expect(call('InStr', 'ABC', 'b', 1)).toBe(2); // compare as 3rd argument
  expect(call('InStr', 'abc', '')).toBe(1);
  expect(call('InStr', '', 'a')).toBe(0);
  expect(call('InStr', 9, 'abc', 'a')).toBe(0);
  expect(() => call('InStr', 0, 'abc', 'a')).toThrow(err(5));
  expect(call('InStr', Null, 'a')).toBe(Null);
  expect(call('InStrRev', 'abcabc', 'b')).toBe(5);
  expect(call('InStrRev', 'abcabc', 'b', 4)).toBe(2);
  expect(call('InStrRev', 'abc', 'x')).toBe(0);
  expect(call('InStrRev', 'abc', 'abc', 2)).toBe(0); // start before the match could end
  expect(call('InStrRev', 'abc', 'abc', 3)).toBe(1);
  expect(call('InStrRev', 'abcabc', 'bc', 2)).toBe(0);
  expect(call('InStrRev', 'abcabc', 'bc', 3)).toBe(2);
});

test('Replace', () => {
  expect(call('Replace', 'Hello World', 'o', '0')).toBe('Hell0 W0rld');
  expect(call('Replace', 'aaa', 'a', 'b', 2)).toBe('bb');
  expect(call('Replace', 'aaa', 'a', 'b', 1, 2)).toBe('bba');
  expect(call('Replace', 'Abc', 'a', 'x', 1, -1, 1)).toBe('xbc');
  expect(call('Replace', 'Abc', 'a', 'x')).toBe('Abc');
  expect(call('Replace', 'abc', '', 'x')).toBe('abc');
  expect(call('Replace', 'abab', 'ab', '')).toBe('');
});

test('case, trim, space, string', () => {
  expect(call('UCase', 'æøå')).toBe('ÆØÅ');
  expect(call('LCase', 'ABC')).toBe('abc');
  expect(call('UCase', Null)).toBe(Null);
  expect(call('Trim', '  a b  ')).toBe('a b');
  expect(call('LTrim', '  a  ')).toBe('a  ');
  expect(call('RTrim', '  a  ')).toBe('  a');
  expect(call('Space', 3)).toBe('   ');
  expect(() => call('Space', -1)).toThrow(err(5));
  expect(call('String', 3, 'xy')).toBe('xxx');
  expect(call('String', 2, 65)).toBe('AA');
  expect(() => call('String', 2, '')).toThrow(err(5));
  expect(call('StrReverse', 'abc')).toBe('cba');
});

test('Chr/Asc/ChrW/AscW', () => {
  expect(call('Chr', 65)).toBe('A');
  expect(call('Chr', 13)).toBe('\r');
  expect(call('Chr', 255)).toBe('ÿ');
  expect(call('Chr', 150)).toBe('–');
  expect(() => call('Chr', -1)).toThrow(err(5));
  expect(() => call('Chr', 256)).toThrow(err(5));
  expect(call('Asc', 'A')).toBe(65);
  expect(call('Asc', 'æ')).toBe(230);
  expect(call('Asc', '€')).toBe(128);
  expect(call('Asc', 'Hello')).toBe(72);
  expect(() => call('Asc', '')).toThrow(err(5));
  expect(call('ChrW', 8364)).toBe('€');
  expect(call('AscW', '€')).toBe(8364);
});

test('Split/Join', () => {
  const a = call('Split', 'a,b,c', ',') as VBArray;
  expect(a.bounds).toEqual([[0, 2]]);
  expect(arr(a)).toEqual(['a', 'b', 'c']);
  expect(arr(call('Split', 'a b  c'))).toEqual(['a', 'b', '', 'c']);
  expect(arr(call('Split', 'a,b,c', ',', 2))).toEqual(['a', 'b,c']);
  expect(arr(call('Split', 'aXbxc', 'x', -1, 1))).toEqual(['a', 'b', 'c']);
  expect((call('Split', '') as VBArray).bounds).toEqual([[0, -1]]);
  expect(arr(call('Split', 'abc', ''))).toEqual(['abc']);
  expect(call('Join', a, '-')).toBe('a-b-c');
  expect(call('Join', a)).toBe('a b c');
});

test('StrComp', () => {
  expect(call('StrComp', 'a', 'B')).toBe(1);
  expect(call('StrComp', 'a', 'B', 1)).toBe(-1);
  expect(call('StrComp', 'abc', 'ABC', 1)).toBe(0);
  expect(call('StrComp', 'a', Null)).toBe(Null);
});

// ---- conversion ----
test('Val', () => {
  expect(call('Val', '  &H1F ')).toBe(31);
  expect(call('Val', '&O17')).toBe(15);
  expect(call('Val', '1e3')).toBe(1000);
  expect(call('Val', '.5')).toBe(0.5);
  expect(call('Val', 'abc')).toBe(0);
  expect(call('Val', '')).toBe(0);
  expect(call('Val', '1 2 3')).toBe(123);
  expect(call('Val', '-3.5x')).toBe(-3.5);
  expect(call('Val', '&HFFFF')).toBe(-1);
  expect(call('Val', '&H10000')).toBe(65536);
  expect(call('Val', 42)).toBe(42);
  expect(() => call('Val', Null)).toThrow(err(94));
});

test('Str', () => {
  expect(call('Str', -5)).toBe('-5');
  expect(call('Str', 0)).toBe(' 0');
  expect(call('Str', 1.25)).toBe(' 1.25');
  expect(call('Str', -0.5)).toBe('-.5');
  expect(call('Str', true)).toBe('-1');
});

test('C-conversions', () => {
  expect(call('CInt', '3.7')).toBe(4);
  expect(call('CInt', 3.5)).toBe(4);
  expect(() => call('CInt', 40000)).toThrow(err(6));
  expect(() => call('CInt', 'abc')).toThrow(err(13));
  expect(() => call('CInt', Null)).toThrow(err(94));
  expect(call('CLng', 2147483647)).toBe(2147483647);
  expect(() => call('CLng', 2147483648)).toThrow(err(6));
  expect(call('CDbl', '1.5')).toBe(1.5);
  expect(call('CSng', 1.5)).toBe(1.5);
  expect(call('CByte', 255)).toBe(255);
  expect(() => call('CByte', 256)).toThrow(err(6));
  expect(call('CCur', 1.23456)).toBe(1.2346);
  expect(call('CBool', 0)).toBe(false);
  expect(call('CBool', 'True')).toBe(true);
  expect(call('CBool', -1)).toBe(true);
  expect(call('CStr', true)).toBe('True');
  expect(call('CStr', 1e16)).toBe('1E+16');
  expect(call('CStr', 0.1 + 0.2)).toBe('0.3');
  expect(call('CDate', '2026-10-22')).toEqual(dateFrom(2026, 10, 22));
  expect(call('CVar', 7)).toBe(7);
});

test('type checks', () => {
  expect(call('IsNumeric', '12')).toBe(true);
  expect(call('IsNumeric', '1.5e3')).toBe(true);
  expect(call('IsNumeric', '&HFF')).toBe(true);
  expect(call('IsNumeric', 'abc')).toBe(false);
  expect(call('IsNumeric', '')).toBe(false);
  expect(call('IsNumeric', Null)).toBe(false);
  expect(call('IsNumeric', 5)).toBe(true);
  expect(call('IsNumeric', Empty)).toBe(true);
  expect(call('IsEmpty', Empty)).toBe(true);
  expect(call('IsEmpty', 0)).toBe(false);
  expect(call('IsNull', Null)).toBe(true);
  expect(call('IsNull', '')).toBe(false);
  expect(call('IsDate', '2026-10-22')).toBe(true);
  expect(call('IsDate', D)).toBe(true);
  expect(call('IsDate', 'hello')).toBe(false);
  expect(call('IsDate', 5)).toBe(false);
  expect(call('IsArray', new VBArray('Integer', [[0, 1]]))).toBe(true);
  expect(call('IsArray', 1)).toBe(false);
  expect(call('IsObject', Nothing)).toBe(true);
  expect(call('IsObject', 1)).toBe(false);
});

test('TypeName / VarType', () => {
  expect(call('TypeName', 'a')).toBe('String');
  expect(call('TypeName', 1)).toBe('Integer');
  expect(call('TypeName', 100000)).toBe('Long');
  expect(call('TypeName', 1.5)).toBe('Double');
  expect(call('TypeName', Null)).toBe('Null');
  expect(call('TypeName', Empty)).toBe('Empty');
  expect(call('TypeName', true)).toBe('Boolean');
  expect(call('TypeName', D)).toBe('Date');
  expect(call('VarType', Empty)).toBe(0);
  expect(call('VarType', Null)).toBe(1);
  expect(call('VarType', 1)).toBe(2);
  expect(call('VarType', 100000)).toBe(3);
  expect(call('VarType', 1.5)).toBe(5);
  expect(call('VarType', D)).toBe(7);
  expect(call('VarType', 'a')).toBe(8);
  expect(call('VarType', true)).toBe(11);
  expect(call('VarType', new VBArray('Variant', [[0, 1]]))).toBe(8204);
  expect(call('VarType', new VBArray('String', [[0, 1]]))).toBe(8200);
});

// ---- math ----
test('Int/Fix/Abs/Sgn/Sqr', () => {
  expect(call('Int', -2.5)).toBe(-3);
  expect(call('Int', 2.9)).toBe(2);
  expect(call('Fix', -2.5)).toBe(-2);
  expect(call('Fix', 2.9)).toBe(2);
  expect(call('Int', Null)).toBe(Null);
  expect(call('Int', D)).toEqual(dateFrom(2026, 10, 22));
  expect(call('Abs', -3)).toBe(3);
  expect(call('Abs', '-3.5')).toBe(3.5);
  expect(call('Sgn', -5)).toBe(-1);
  expect(call('Sgn', 0)).toBe(0);
  expect(call('Sgn', 9)).toBe(1);
  expect(call('Sqr', 16)).toBe(4);
  expect(() => call('Sqr', -1)).toThrow(err(5));
});

test('Round is banker rounding', () => {
  expect(call('Round', 2.5)).toBe(2);
  expect(call('Round', 3.5)).toBe(4);
  expect(call('Round', -2.5)).toBe(-2);
  expect(call('Round', 1.2345, 2)).toBe(1.23);
  expect(call('Round', 0.125, 2)).toBe(0.12);
  expect(call('Round', 0.135, 2)).toBe(0.14);
  expect(call('Round', 1234.5678, 1)).toBe(1234.6);
  expect(() => call('Round', 1, -1)).toThrow(err(5));
});

test('Hex/Oct', () => {
  expect(call('Hex', 255)).toBe('FF');
  expect(call('Hex', 0)).toBe('0');
  expect(call('Hex', -1)).toBe('FFFF');
  expect(call('Hex', -40000)).toBe('FFFF63C0');
  expect(call('Hex', 65536)).toBe('10000');
  expect(call('Oct', 8)).toBe('10');
  expect(call('Hex', 255.5)).toBe('100'); // rounds like CLng (256)
});

test('Log/Exp/trig', () => {
  expect(call('Log', Math.E)).toBeCloseTo(1, 12);
  expect(() => call('Log', 0)).toThrow(err(5));
  expect(() => call('Log', -1)).toThrow(err(5));
  expect(call('Exp', 1)).toBeCloseTo(Math.E, 12);
  expect(() => call('Exp', 1000)).toThrow(err(6));
  expect(call('Sin', 0)).toBe(0);
  expect(call('Cos', 0)).toBe(1);
  expect(call('Tan', 0)).toBe(0);
  expect(call('Atn', 1)).toBeCloseTo(Math.PI / 4, 12);
});

test('Rnd/Randomize', () => {
  call('Randomize', 5);
  const a = call('Rnd') as number;
  const b = call('Rnd') as number;
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(1);
  expect(b).not.toBe(a);
  expect(call('Rnd', 0)).toBe(b); // repeats the last value
  call('Randomize', 5);
  expect(call('Rnd')).toBe(a); // same seed, same sequence
  expect(call('Rnd', -3)).toBe(call('Rnd', -3)); // negative argument re-seeds
  call('Randomize');
  for (let i = 0; i < 100; i++) {
    const r = call('Rnd') as number;
    expect(r >= 0 && r < 1).toBe(true);
  }
});

// ---- dates ----
test('date parts', () => {
  expect(call('Year', D)).toBe(2026);
  expect(call('Month', D)).toBe(10);
  expect(call('Day', D)).toBe(22);
  expect(call('Hour', D)).toBe(13);
  expect(call('Minute', D)).toBe(5);
  expect(call('Second', D)).toBe(9);
  expect(call('Year', '2020-02-29')).toBe(2020);
  expect(call('Year', Null)).toBe(Null);
  expect(call('Weekday', D)).toBe(5); // Thursday, Sunday = 1
  expect(call('Weekday', D, 2)).toBe(4); // Monday first
  expect(call('Weekday', dateFrom(2026, 10, 25))).toBe(1); // Sunday
  expect(call('Weekday', dateFrom(1899, 12, 30))).toBe(7); // serial 0 is a Saturday
});

test('DateSerial/TimeSerial/DateValue/TimeValue', () => {
  expect(call('DateSerial', 2026, 13, 1)).toEqual(dateFrom(2027, 1, 1));
  expect(call('DateSerial', 2026, 3, 0)).toEqual(dateFrom(2026, 2, 28));
  expect(call('DateSerial', 2026, 1, 32)).toEqual(dateFrom(2026, 2, 1));
  expect(call('DateSerial', 30, 1, 1)).toEqual(dateFrom(1930, 1, 1));
  expect(call('DateSerial', 29, 1, 1)).toEqual(dateFrom(2029, 1, 1));
  expect((call('TimeSerial', 13, 5, 0) as { serial: number }).serial).toBeCloseTo(47100 / 86400, 12);
  expect(call('DateValue', '2026-10-22 13:05')).toEqual(dateFrom(2026, 10, 22));
  expect((call('TimeValue', '2026-10-22 12:00') as { serial: number }).serial).toBeCloseTo(0.5, 12);
});

test('DateAdd', () => {
  expect(call('DateAdd', 'm', 1, dateFrom(2026, 1, 31))).toEqual(dateFrom(2026, 2, 28));
  expect(call('DateAdd', 'm', -1, dateFrom(2026, 3, 31))).toEqual(dateFrom(2026, 2, 28));
  expect(call('DateAdd', 'yyyy', 1, dateFrom(2024, 2, 29))).toEqual(dateFrom(2025, 2, 28));
  expect(call('DateAdd', 'q', 1, dateFrom(2026, 11, 30))).toEqual(dateFrom(2027, 2, 28));
  expect(call('DateAdd', 'd', 10, dateFrom(2026, 10, 22))).toEqual(dateFrom(2026, 11, 1));
  expect(call('DateAdd', 'ww', 1, dateFrom(2026, 10, 22))).toEqual(dateFrom(2026, 10, 29));
  expect(call('DateAdd', 'h', 5, dateFrom(2026, 10, 22, 22, 0, 0))).toEqual(dateFrom(2026, 10, 23, 3, 0, 0));
  expect(call('DateAdd', 'n', 90, dateFrom(2026, 10, 22, 0, 0, 0))).toEqual(dateFrom(2026, 10, 22, 1, 30, 0));
  expect(call('DateAdd', 'm', 1, dateFrom(2026, 1, 15, 8, 30, 0))).toEqual(dateFrom(2026, 2, 15, 8, 30, 0));
  expect(() => call('DateAdd', 'x', 1, D)).toThrow(err(5));
  // the number argument is rounded (banker's), not truncated
  expect(call('DateAdd', 'd', 1.6, dateFrom(2026, 10, 22))).toEqual(dateFrom(2026, 10, 24));
  expect(call('DateAdd', 'd', 1.5, dateFrom(2026, 10, 22))).toEqual(dateFrom(2026, 10, 24));
  expect(call('DateAdd', 'd', 2.5, dateFrom(2026, 10, 22))).toEqual(dateFrom(2026, 10, 24));
  expect(call('DateAdd', 'm', -1.6, dateFrom(2026, 3, 15))).toEqual(dateFrom(2026, 1, 15));
});

test('DateDiff / DatePart', () => {
  expect(call('DateDiff', 'd', dateFrom(2026, 1, 1), dateFrom(2026, 12, 31))).toBe(364);
  expect(call('DateDiff', 'd', dateFrom(2026, 12, 31), dateFrom(2026, 1, 1))).toBe(-364);
  expect(call('DateDiff', 'm', dateFrom(2026, 1, 31), dateFrom(2026, 3, 1))).toBe(2);
  expect(call('DateDiff', 'yyyy', dateFrom(2025, 12, 31), dateFrom(2026, 1, 1))).toBe(1);
  expect(call('DateDiff', 'q', dateFrom(2026, 3, 31), dateFrom(2026, 4, 1))).toBe(1);
  expect(call('DateDiff', 'ww', dateFrom(2026, 10, 24), dateFrom(2026, 10, 25))).toBe(1); // crosses a Sunday
  expect(call('DateDiff', 'ww', dateFrom(2026, 10, 25), dateFrom(2026, 10, 31))).toBe(0);
  expect(call('DateDiff', 'h', dateFrom(2026, 1, 1, 10, 30, 0), dateFrom(2026, 1, 1, 12, 15, 0))).toBe(2);
  expect(call('DateDiff', 'n', dateFrom(2026, 1, 1, 10, 30, 0), dateFrom(2026, 1, 1, 12, 15, 0))).toBe(105);
  expect(call('DateDiff', 's', dateFrom(2026, 1, 1, 0, 0, 0), dateFrom(2026, 1, 1, 0, 1, 30))).toBe(90);
  expect(call('DatePart', 'yyyy', D)).toBe(2026);
  expect(call('DatePart', 'q', D)).toBe(4);
  expect(call('DatePart', 'm', D)).toBe(10);
  expect(call('DatePart', 'y', D)).toBe(295);
  expect(call('DatePart', 'w', D)).toBe(5);
  expect(call('DatePart', 'ww', D)).toBe(43);
  expect(call('DatePart', 'h', D)).toBe(13);
});

test('names and clocks', () => {
  expect(call('MonthName', 10)).toBe('October');
  expect(call('MonthName', 10, true)).toBe('Oct');
  expect(call('WeekdayName', 1)).toBe('Sunday');
  expect(call('WeekdayName', 2, true)).toBe('Mon');
  expect(call('WeekdayName', 1, false, 2)).toBe('Monday');
  expect(() => call('MonthName', 13)).toThrow(err(5));
  const now = call('Now') as { kind: string; serial: number };
  expect(now.kind).toBe('date');
  expect(now.serial).toBeGreaterThan(46000); // after 2025
  expect((call('Date') as { serial: number }).serial % 1).toBe(0);
  expect((call('Time') as { serial: number }).serial).toBeLessThan(1);
  const t = call('Timer') as number;
  expect(t).toBeGreaterThanOrEqual(0);
  expect(t).toBeLessThan(86400);
});

// ---- Format ----
test('Format numbers', () => {
  expect(fmt(0.5, '0.00')).toBe('0.50');
  expect(fmt(1234567.891, '#,##0.00')).toBe('1,234,567.89');
  expect(fmt(-5, '0.00')).toBe('-5.00');
  expect(fmt(5, '0.00;(0.00)')).toBe('5.00');
  expect(fmt(-5, '0.00;(0.00)')).toBe('(5.00)');
  expect(fmt(0, '0.00;;Zero')).toBe('Zero');
  expect(fmt(0, '0.00')).toBe('0.00');
  expect(fmt(0.5, '#.##')).toBe('.5');
  expect(fmt(5, '#.##')).toBe('5.');
  expect(fmt(3.14159, '0.###')).toBe('3.142');
  expect(fmt(1234567, '#,##0')).toBe('1,234,567');
  expect(fmt(999, '#,##0')).toBe('999');
  expect(fmt(0, '#,##0')).toBe('0');
  expect(fmt(0, '#')).toBe('');
  expect(fmt(5, '00.0')).toBe('05.0');
  expect(fmt(123456, '0')).toBe('123456');
  expect(fmt(12.5, '$0.00')).toBe('$12.50');
  expect(fmt(-12.5, '$0.00')).toBe('-$12.50');
  expect(fmt(5, '"Total: "0.00')).toBe('Total: 5.00');
  expect(fmt(5, '\\#0')).toBe('#5');
  expect(fmt(5, '0 "kr"')).toBe('5 kr');
  expect(fmt(1500, '0.0,')).toBe('1.5');
  expect(fmt(1500000, '0.0,,')).toBe('1.5');
  expect(fmt(0.5, '0')).toBe('1');
  expect(fmt(1.5, '0')).toBe('2');
  expect(fmt(2.5, '0')).toBe('3');
  expect(fmt(1.005, '0.00')).toBe('1.01');
  expect(fmt(0.999, '0.00')).toBe('1.00');
  expect(fmt(99.5, '0')).toBe('100');
  expect(fmt(-0.001, '0.00')).toBe('0.00');
  expect(fmt(0.256, '0.0%')).toBe('25.6%');
  expect(fmt('5', '0.00')).toBe('5.00');
  expect(fmt('abc', '0.00')).toBe('abc');
  expect(fmt(true, '0')).toBe('-1');
  expect(fmt(12345.678, '0.00E+00')).toBe('1.23E+04');
  expect(fmt(0.000123, '0.00E+00')).toBe('1.23E-04');
  expect(fmt(12345.678, '0.00E-00')).toBe('1.23E04');
  expect(fmt(0, '0.0E+0')).toBe('0.0E+0');
  expect(fmt(5, '')).toBe('5');
  expect(fmt(5, 'abc')).toBe('abc');
  expect(fmt(1234.5, '0,000.00')).toBe('1,234.50');
  expect(fmt(-1234.567, '#,##0.00')).toBe('-1,234.57');
  expect(fmt(7, '.00')).toBe('7.00');
});

test('Format named numeric formats', () => {
  expect(fmt(1234.5, 'General Number')).toBe('1234.5');
  expect(fmt(1234.5, 'Fixed')).toBe('1234.50');
  expect(fmt(1234.5, 'Standard')).toBe('1,234.50');
  expect(fmt(0.256, 'Percent')).toBe('25.60%');
  expect(fmt(1234.5, 'Currency')).toBe('$1,234.50');
  expect(fmt(-1234.5, 'Currency')).toBe('($1,234.50)');
  expect(fmt(12345.678, 'Scientific')).toBe('1.23E+04');
  expect(fmt(7, 'FIXED')).toBe('7.00');
  expect(fmt(true, 'Yes/No')).toBe('Yes');
  expect(fmt(0, 'Yes/No')).toBe('No');
  expect(fmt(5, 'True/False')).toBe('True');
  expect(fmt(0, 'On/Off')).toBe('Off');
  expect(fmt(true, 'On/Off')).toBe('On');
});

test('Format text', () => {
  expect(fmt('abc', '>')).toBe('ABC');
  expect(fmt('ABC', '<')).toBe('abc');
  expect(fmt('Hello', '@@@@@@@')).toBe('  Hello');
  expect(fmt('ab', '&&&')).toBe('ab');
});

test('Format dates', () => {
  expect(fmt(D, 'dddd, mmmm d, yyyy')).toBe('Thursday, October 22, 2026');
  expect(fmt(D, 'ddd mmm dd yy')).toBe('Thu Oct 22 26');
  expect(fmt(D, 'h:nn:ss AM/PM')).toBe('1:05:09 PM');
  expect(fmt(D, 'hh:mm')).toBe('13:05');
  expect(fmt(D, 'hh:mm:ss')).toBe('13:05:09');
  expect(fmt(D, 'm/d/yyyy')).toBe('10/22/2026');
  expect(fmt(D, 'yyyy-mm-dd')).toBe('2026-10-22');
  expect(fmt(D, 'hh:mm am/pm')).toBe('01:05 pm');
  expect(fmt(D, 'h A/P')).toBe('1 P');
  expect(fmt(dateFrom(2026, 1, 5, 0, 7, 0), 'h:mm AM/PM')).toBe('12:07 AM');
  expect(fmt(dateFrom(2026, 1, 5, 12, 7, 0), 'h:mm AM/PM')).toBe('12:07 PM');
  expect(fmt(D, 'q')).toBe('4');
  expect(fmt(D, 'y')).toBe('295');
  expect(fmt(D, 'w')).toBe('5');
  expect(fmt(D, 'ww')).toBe('43');
  expect(fmt(D, 'dd "of" mmmm')).toBe('22 of October');
  expect(fmt(D, 'd\\t\\h')).toBe('22th');
  expect(fmt('2026-10-22', 'dd.mm.yyyy')).toBe('22.10.2026');
  expect(fmt(D, 'mm')).toBe('10');
});

test('Format named dates', () => {
  expect(fmt(D, 'Short Date')).toBe('10/22/2026');
  expect(fmt(D, 'Long Date')).toBe('Thursday, October 22, 2026');
  expect(fmt(D, 'Medium Date')).toBe('22-Oct-26');
  expect(fmt(D, 'Short Time')).toBe('13:05');
  expect(fmt(D, 'Long Time')).toBe('1:05:09 PM');
  expect(fmt(D, 'Medium Time')).toBe('01:05 PM');
  expect(fmt(D, 'General Date')).toBe('10/22/2026 1:05:09 PM');
  expect(fmt(dateFrom(2026, 10, 22), 'General Date')).toBe('10/22/2026');
  expect(fmt({ kind: 'date', serial: 0.5 }, 'General Date')).toBe('12:00:00 PM');
  expect(fmt(0.5, 'Short Time')).toBe('12:00');
  expect(formatValue(D, 'Short Date', 'nb-NO')).toBe('22.10.2026');
  expect(formatValue(D, 'dddd d. mmmm yyyy', 'nb-NO')).toBe('torsdag 22. oktober 2026');
  expect(call('FormatDateTime', D, 2)).toBe('10/22/2026');
  expect(call('FormatDateTime', D)).toBe('10/22/2026 1:05:09 PM');
  expect(call('FormatDateTime', D, 4)).toBe('13:05');
});

test('Format built-in', () => {
  expect(call('Format', 5)).toBe('5');
  expect(call('Format', 1234.5, '#,##0.00')).toBe('1,234.50');
  expect(call('Format', Null, '0')).toBe(Null);
  expect(call('Format', 0.5, '0%')).toBe('50%');
  expect(call('Format', D, 'yyyy')).toBe('2026');
});

// ---- misc built-ins ----
test('RGB / QBColor', () => {
  expect(call('RGB', 0, 255, 0)).toBe(65280);
  expect(call('RGB', 0, 0, 255)).toBe(16711680);
  expect(call('RGB', 300, 0, 0)).toBe(255);
  expect(() => call('RGB', -1, 0, 0)).toThrow(err(5));
  expect(call('QBColor', 4)).toBe(128);
  expect(call('QBColor', 15)).toBe(0xffffff);
  expect(call('QBColor', 9)).toBe(0xff0000);
  expect(() => call('QBColor', 16)).toThrow(err(5));
});

test('IIf / Choose / Switch / Array / Environ / Command', () => {
  expect(call('IIf', true, 'a', 'b')).toBe('a');
  expect(call('IIf', 0, 'a', 'b')).toBe('b');
  expect(call('Choose', 2, 'a', 'b', 'c')).toBe('b');
  expect(call('Choose', 5, 'a')).toBe(Null);
  expect(call('Choose', 0, 'a')).toBe(Null);
  expect(call('Switch', false, 1, true, 2)).toBe(2);
  expect(call('Switch', false, 1)).toBe(Null);
  const a = call('Array', 1, 'x', 3) as VBArray;
  expect(a.bounds).toEqual([[0, 2]]);
  expect(arr(a)).toEqual([1, 'x', 3]);
  expect((call('Array') as VBArray).bounds).toEqual([[0, -1]]);
  expect(call('Environ', 'PATH')).toBe('');
  expect(call('Command')).toBe('');
});

test('dialogs go to the host', async () => {
  const calls: unknown[][] = [];
  const host = new TestHost();
  host.msgBox = async (p, b, t) => { calls.push(['msgBox', p, b, t]); return 6; };
  host.inputBox = async (p, t, d) => { calls.push(['inputBox', p, t, d]); return 'typed'; };
  host.doEvents = async () => { calls.push(['doEvents']); };
  host.loadPicture = async p => { calls.push(['loadPicture', p]); return 'pic'; };
  const ctx = { host, locale: 'en-US', appTitle: 'My App' };
  const run = (n: string, ...a: VBValue[]) => BUILTINS.get(n)!.fn(a, ctx);
  expect(await run('msgbox', 'Hi', 36, 'T')).toBe(6);
  expect(await run('msgbox', 'Hi')).toBe(6);
  expect(await run('msgbox', 'Hi', undefined as unknown as VBValue, 'T2')).toBe(6);
  expect(await run('inputbox', 'Name?')).toBe('typed');
  expect(await run('inputbox', 'Name?', 'T', 'Bob')).toBe('typed');
  expect(await run('doevents')).toBe(0);
  expect(await run('loadpicture', 'a.bmp')).toBe('pic');
  expect(run('loadpicture')).toBe(Nothing);
  expect(calls).toEqual([
    ['msgBox', 'Hi', 36, 'T'], ['msgBox', 'Hi', 0, 'My App'], ['msgBox', 'Hi', 0, 'T2'],
    ['inputBox', 'Name?', 'My App', ''], ['inputBox', 'Name?', 'T', 'Bob'],
    ['doEvents'], ['loadPicture', 'a.bmp'],
  ]);
  // default title without appTitle
  await BUILTINS.get('msgbox')!.fn(['x'], { host, locale: 'en-US' });
  expect(calls[calls.length - 1]).toEqual(['msgBox', 'x', 0, 'Project1']);
});

test('argument counts', () => {
  expect(() => call('Left', 'a')).toThrow(err(450));
  expect(() => call('Left', 'a', 1, 2)).toThrow(err(450));
  expect(() => call('Now', 1)).toThrow(err(450));
  expect(() => call('Format')).toThrow(err(450));
  expect(() => call('LBound')).toThrow(err(450));
  expect(() => call('Mid', 'abc', undefined as unknown as VBValue)).toThrow(err(450)); // omitted required argument
  expect(BUILTINS.get('left')!.minArgs).toBe(2);
});

test('constants', () => {
  const k = (n: string) => CONSTANTS.get(n.toLowerCase());
  expect(k('vbCrLf')).toBe('\r\n');
  expect(k('vbNewLine')).toBe('\r\n');
  expect(k('vbCr')).toBe('\r');
  expect(k('vbLf')).toBe('\n');
  expect(k('vbTab')).toBe('\t');
  expect(k('vbNullString')).toBe('');
  expect(k('vbYesNo')).toBe(4);
  expect(k('vbYesNoCancel')).toBe(3);
  expect((k('vbYesNo') as number) | (k('vbQuestion') as number)).toBe(36);
  expect(k('vbExclamation')).toBe(48);
  expect(k('vbDefaultButton2')).toBe(256);
  expect(k('vbDefaultButton3')).toBe(512);
  expect([k('vbOK'), k('vbCancel'), k('vbAbort'), k('vbRetry'), k('vbIgnore'), k('vbYes'), k('vbNo')]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(k('vbRed')).toBe(255);
  expect(k('vbGreen')).toBe(0xff00);
  expect(k('vbBlue')).toBe(0xff0000);
  expect(k('vbYellow')).toBe(0xffff);
  expect(k('vbMagenta')).toBe(0xff00ff);
  expect(k('vbCyan')).toBe(0xffff00);
  expect(k('vbWhite')).toBe(0xffffff);
  expect(k('vbBlack')).toBe(0);
  expect(k('vbKeyReturn')).toBe(13);
  expect(k('vbKeyA')).toBe(65);
  expect(k('vbKeyZ')).toBe(90);
  expect(k('vbKey0')).toBe(48);
  expect(k('vbKey9')).toBe(57);
  expect([k('vbKeyLeft'), k('vbKeyUp'), k('vbKeyRight'), k('vbKeyDown')]).toEqual([37, 38, 39, 40]);
  expect([k('vbUnchecked'), k('vbChecked'), k('vbGrayed')]).toEqual([0, 1, 2]);
  expect([k('vbModal'), k('vbModeless'), k('vbTextCompare'), k('vbBinaryCompare')]).toEqual([1, 0, 1, 0]);
});

// ---- general ----
test('every built-in tolerates its own arg-count bounds', () => {
  for (const [name, b] of BUILTINS) {
    if (b.minArgs > 0) expect(() => b.fn([], testCtx), name).toThrow(err(450));
  }
});

test('Format repeated with a cached Intl formatter stays correct', () => {
  for (let i = 0; i < 3; i++) {
    expect(formatValue(D, 'Short Date', 'en-US')).toBe('10/22/2026');
    expect(formatValue(D, 'Short Date', 'nb-NO')).toBe('22.10.2026');
    expect(formatValue(D, 'Short Date', 'not a locale!')).toBe('10/22/2026'); // falls back to en-US
  }
});

test('General Date text uses the locale (CStr/Print)', () => {
  expect(generalDateText(D.serial, 'en-US')).toBe('10/22/2026 1:05:09 PM');
  expect(generalDateText(D.serial, 'nb-NO')).toBe('22.10.2026 13:05:09');
});
