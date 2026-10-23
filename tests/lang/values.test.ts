import {
  coerce, toNumber, toStr, toBool, vbTypeName, compare, defaultValue, dateFrom, dateParts,
  Empty, Null, Nothing, VBArray, VBRecord, VBRef,
} from '../../src/lang/values';
import type { VBDate } from '../../src/lang/values';
import { VBRuntimeError, vbErrorText } from '../../src/lang/errors';
import type { VBObject } from '../../src/lang/host';

const err = (n: number) => expect.objectContaining({ number: n });

// ---- brief tests (verbatim) ----
test('integer overflow', () => expect(() => coerce(32768, 'Integer')).toThrow(expect.objectContaining({ number: 6 })));
test('string to integer', () => expect(coerce('12', 'Integer')).toBe(12));
test('bad string', () => expect(() => coerce('abc', 'Integer')).toThrow(expect.objectContaining({ number: 13 })));
test('banker rounding', () => { expect(coerce(2.5, 'Integer')).toBe(2); expect(coerce(3.5, 'Integer')).toBe(4); });
test('bool text', () => expect(toStr(true)).toBe('True'));
test('true is -1', () => expect(toNumber(true)).toBe(-1));
test('empty', () => { expect(toStr(Empty)).toBe(''); expect(toNumber(Empty)).toBe(0); });
test('cstr double', () => { expect(toStr(0.5)).toBe('0.5'); expect(toStr(0.1 + 0.2)).toBe('0.3'); expect(toStr(1e16)).toBe('1E+16'); });
test('array bounds', () => { const a = new VBArray('Integer', [[0, 2]]); expect(() => a.get([3])).toThrow(expect.objectContaining({ number: 9 })); });
test('redim preserve', () => { const a = new VBArray('Integer', [[0, 1]]); a.set([1], 7); a.redim([[0, 3]], true); expect(a.get([1])).toBe(7); });
test('error text', () => expect(vbErrorText(13)).toBe('Type mismatch'));

// ---- ranges ----
test('Integer range', () => {
  expect(coerce(-32768, 'Integer')).toBe(-32768);
  expect(coerce(32767, 'Integer')).toBe(32767);
  expect(() => coerce(-32769, 'Integer')).toThrow(err(6));
  expect(coerce(32767.4, 'Integer')).toBe(32767);
  expect(() => coerce(32767.5, 'Integer')).toThrow(err(6));
});
test('Long range', () => {
  expect(coerce(2147483647, 'Long')).toBe(2147483647);
  expect(coerce(-2147483648, 'Long')).toBe(-2147483648);
  expect(() => coerce(2147483648, 'Long')).toThrow(err(6));
  expect(() => coerce(-2147483649, 'Long')).toThrow(err(6));
});
test('Byte range', () => {
  expect(coerce(0, 'Byte')).toBe(0);
  expect(coerce(255, 'Byte')).toBe(255);
  expect(() => coerce(256, 'Byte')).toThrow(err(6));
  expect(() => coerce(-1, 'Byte')).toThrow(err(6));
  expect(coerce(-0.4, 'Byte')).toBe(0);
});
test('Single and Double must be finite', () => {
  expect(coerce(1.5, 'Single')).toBe(1.5);
  expect(() => coerce(1e39, 'Single')).toThrow(err(6));
  expect(() => coerce(Infinity, 'Double')).toThrow(err(6));
  expect(() => coerce(NaN, 'Double')).toThrow(err(6));
  expect(coerce(1e300, 'Double')).toBe(1e300);
  expect(coerce('1e3', 'Double')).toBe(1000);
});
test('Currency rounds to 4 decimals and has a range', () => {
  expect(coerce(1.23456, 'Currency')).toBe(1.2346);
  expect(coerce(0.00005, 'Currency')).toBe(0);
  expect(() => coerce(1e15, 'Currency')).toThrow(err(6));
});
test('negative banker rounding', () => {
  expect(coerce(-2.5, 'Integer')).toBe(-2);
  expect(coerce(-3.5, 'Integer')).toBe(-4);
  expect(coerce(-0.5, 'Long')).toBe(0);
  expect(Object.is(coerce(-0.5, 'Long'), 0)).toBe(true);
  expect(coerce(0.5, 'Long')).toBe(0);
  expect(coerce(1.5, 'Long')).toBe(2);
  expect(coerce(2.6, 'Byte')).toBe(3);
});

// ---- string -> number ----
test('string to number parsing', () => {
  expect(toNumber(' 12 ')).toBe(12);
  expect(toNumber('&HFF')).toBe(255);
  expect(toNumber('  &H10  ')).toBe(16);
  expect(toNumber('&hff')).toBe(255);
  expect(toNumber('&O17')).toBe(15);
  expect(toNumber('&HFFFF')).toBe(-1);
  expect(toNumber('&HFFFF&')).toBe(65535);
  expect(toNumber('&HFFFFFFFF')).toBe(-1);
  expect(toNumber('&H7FFFFFFF')).toBe(2147483647);
  expect(toNumber('3.25')).toBe(3.25);
  expect(toNumber('.5')).toBe(0.5);
  expect(toNumber('-2.')).toBe(-2);
  expect(toNumber('+7')).toBe(7);
  expect(toNumber('1.5E2')).toBe(150);
});
test('bad strings are type mismatch', () => {
  for (const s of ['', ' ', 'abc', '12abc', '&H', '&HZZ', '1.2.3', '--1', '&H123456789', ',5', '5,', '$', '$1$', '(-1)', '-1-'])
    expect(() => toNumber(s)).toThrow(err(13));
  // VB6 skips thousands separators between digits (en-US): "1,5" is 15
  expect(toNumber('1,5')).toBe(15);
});
test('coerce string to typed numbers', () => {
  expect(coerce(' &H10 ', 'Integer')).toBe(16);
  expect(coerce('2.5', 'Integer')).toBe(2);
  expect(() => coerce('40000', 'Integer')).toThrow(err(6));
  expect(coerce('1.5', 'Double')).toBe(1.5);
});

// ---- toStr ----
test('toStr numbers', () => {
  expect(toStr(0)).toBe('0');
  expect(toStr(-0)).toBe('0');
  expect(toStr(5)).toBe('5');
  expect(toStr(-1.5)).toBe('-1.5');
  expect(toStr(100)).toBe('100');
  expect(toStr(123456789012345)).toBe('123456789012345');
  expect(toStr(1e14)).toBe('100000000000000');
  expect(toStr(1e15)).toBe('1E+15');
  expect(toStr(123456789012345678)).toBe('1.23456789012346E+17');
  expect(toStr(0.0001)).toBe('0.0001');
  expect(toStr(0.00012345)).toBe('0.00012345');
  expect(toStr(0.00001)).toBe('1E-05');
  expect(toStr(1.5e-10)).toBe('1.5E-10');
  expect(toStr(1e100)).toBe('1E+100');
  expect(toStr(-1e16)).toBe('-1E+16');
  expect(toStr(1 / 3)).toBe('0.333333333333333');
  expect(toStr(2147483647)).toBe('2147483647');
});
test('toStr other values', () => {
  expect(toStr(false)).toBe('False');
  expect(toStr('hi')).toBe('hi');
  expect(() => toStr(Null)).toThrow(err(94));
  expect(() => toStr(Nothing)).toThrow(err(91));
  expect(toStr(dateFrom(2024, 3, 5))).toMatch(/\S/);
  expect(() => toStr(new VBArray('Integer', [[0, 1]]))).toThrow(err(13));
});

// ---- toNumber / toBool ----
test('toNumber other values', () => {
  expect(toNumber(false)).toBe(0);
  expect(toNumber(dateFrom(1899, 12, 31))).toBe(1);
  expect(() => toNumber(Null)).toThrow(err(94));
  expect(() => toNumber(Nothing)).toThrow(err(91));
  expect(() => toNumber(new VBRecord('P', new Map()))).toThrow(err(13));
});
test('toBool', () => {
  expect(toBool(0)).toBe(false);
  expect(toBool(-1)).toBe(true);
  expect(toBool(0.5)).toBe(true);
  expect(toBool('True')).toBe(true);
  expect(toBool('false')).toBe(false);
  expect(toBool('0')).toBe(false);
  expect(toBool('5')).toBe(true);
  expect(toBool(Empty)).toBe(false);
  expect(() => toBool('abc')).toThrow(err(13));
  expect(() => toBool(Null)).toThrow(err(94));
});
test('coerce to Boolean and String', () => {
  expect(coerce(5, 'Boolean')).toBe(true);
  expect(coerce(0, 'Boolean')).toBe(false);
  expect(coerce(5, 'String')).toBe('5');
  expect(coerce(true, 'String')).toBe('True');
  expect(coerce(Empty, 'String')).toBe('');
  expect(coerce(Empty, 'Integer')).toBe(0);
  expect(coerce(true, 'Integer')).toBe(-1);
});
test('coerce Variant keeps value', () => {
  expect(coerce('x', 'Variant')).toBe('x');
  expect(coerce(Null, 'Variant')).toBe(Null);
  expect(coerce(Empty, 'Variant')).toBe(Empty);
});
test('coerce Null to typed is error 94', () => {
  expect(() => coerce(Null, 'Integer')).toThrow(err(94));
  expect(() => coerce(Null, 'String')).toThrow(err(94));
});
test('coerce Date', () => {
  const d = coerce(43831.5, 'Date') as VBDate;
  expect(d).toEqual({ kind: 'date', serial: 43831.5 });
  expect(coerce(d, 'Date')).toBe(d);
  expect(coerce(d, 'Double')).toBe(43831.5);
  expect(coerce('2020-01-01', 'Date')).toEqual({ kind: 'date', serial: 43831 });
  expect(() => coerce('nonsense', 'Date')).toThrow(err(13));
});
test('coerce object and user types', () => {
  const o: VBObject = {
    vbTypeName: 'Form', hasMember: () => false, getMember: () => 0, setMember: () => {}, callMethod: () => 0,
  };
  expect(coerce(o, 'Object')).toBe(o);
  expect(coerce(Nothing, { objectType: 'Form' })).toBe(Nothing);
  expect(() => coerce(5, 'Object')).toThrow(err(13));
  const r = new VBRecord('Point', new Map());
  expect(coerce(r, { userType: 'point' })).toBe(r);
  expect(() => coerce(r, { userType: 'Other' })).toThrow(err(13));
  expect(() => coerce(5, { userType: 'Point' })).toThrow(err(13));
});
test('object default member is used for conversion', () => {
  const o: VBObject = {
    vbTypeName: 'TextBox', defaultMember: 'Text', hasMember: () => true,
    getMember: (n) => (n === 'Text' ? '42' : Empty), setMember: () => {}, callMethod: () => 0,
  };
  expect(toNumber(o)).toBe(42);
  expect(toStr(o)).toBe('42');
});

// ---- typeName / defaults ----
test('vbTypeName', () => {
  expect(vbTypeName(Empty)).toBe('Empty');
  expect(vbTypeName(Null)).toBe('Null');
  expect(vbTypeName(Nothing)).toBe('Nothing');
  expect(vbTypeName('a')).toBe('String');
  expect(vbTypeName(true)).toBe('Boolean');
  expect(vbTypeName(5)).toBe('Integer');
  expect(vbTypeName(70000)).toBe('Long');
  expect(vbTypeName(1.5)).toBe('Double');
  expect(vbTypeName(1e10)).toBe('Double');
  expect(vbTypeName(dateFrom(2020, 1, 1))).toBe('Date');
  expect(vbTypeName(new VBArray('Integer', [[0, 1]]))).toBe('Integer()');
  expect(vbTypeName(new VBRecord('Point', new Map()))).toBe('Point');
});
test('defaultValue', () => {
  expect(defaultValue('Integer')).toBe(0);
  expect(defaultValue('Double')).toBe(0);
  expect(defaultValue('Byte')).toBe(0);
  expect(defaultValue('Currency')).toBe(0);
  expect(defaultValue('String')).toBe('');
  expect(defaultValue('Boolean')).toBe(false);
  expect(defaultValue('Variant')).toBe(Empty);
  expect(defaultValue('Object')).toBe(Nothing);
  expect(defaultValue({ objectType: 'Form' })).toBe(Nothing);
  expect(defaultValue('Date')).toEqual({ kind: 'date', serial: 0 });
  const r = defaultValue({ userType: 'Point' }) as VBRecord;
  expect(r).toBeInstanceOf(VBRecord);
  expect(r.typeName).toBe('Point');
});

// ---- compare ----
test('compare numbers', () => {
  expect(compare(1, 2)).toBe(-1);
  expect(compare(2, 2)).toBe(0);
  expect(compare(3, 2)).toBe(1);
  expect(compare(true, false)).toBe(-1); // -1 < 0
  expect(compare(false, 0)).toBe(0);
});
test('compare strings: binary vs text mode', () => {
  expect(compare('a', 'B')).toBe(1);
  expect(compare('a', 'B', true)).toBe(-1);
  expect(compare('abc', 'ABC')).toBe(1);
  expect(compare('abc', 'ABC', true)).toBe(0);
  expect(compare('', 'a')).toBe(-1);
});
test('compare number vs numeric string is numeric', () => {
  expect(compare(10, '9')).toBe(1);
  expect(compare('10', 9)).toBe(1);
  expect(compare(5, '5')).toBe(0);
  expect(compare(5, ' 5 ')).toBe(0);
});
test('compare number vs non-numeric string: number is less', () => {
  expect(compare(5, 'abc')).toBe(-1);
  expect(compare('abc', 5)).toBe(1);
});
test('compare Empty acts as 0 or ""', () => {
  expect(compare(Empty, 0)).toBe(0);
  expect(compare(Empty, '')).toBe(0);
  expect(compare(Empty, Empty)).toBe(0);
  expect(compare(Empty, 1)).toBe(-1);
  expect(compare(Empty, 'a')).toBe(-1);
  expect(compare('a', Empty)).toBe(1);
  expect(compare(-1, Empty)).toBe(-1);
});
test('compare dates by serial', () => {
  expect(compare(dateFrom(2020, 1, 1), dateFrom(2020, 1, 2))).toBe(-1);
  expect(compare(dateFrom(2020, 1, 1, 12), dateFrom(2020, 1, 1, 12))).toBe(0);
});
test('compare Null is error 94', () => expect(() => compare(Null, 1)).toThrow(err(94)));

// ---- dates ----
test('dateFrom builds OLE serials', () => {
  expect(dateFrom(1899, 12, 30)).toEqual({ kind: 'date', serial: 0 });
  expect(dateFrom(1900, 1, 1).serial).toBe(2);
  expect(dateFrom(2000, 1, 1).serial).toBe(36526);
  expect(dateFrom(2020, 1, 1).serial).toBe(43831);
  expect(dateFrom(2020, 1, 1, 12).serial).toBe(43831.5);
  expect(dateFrom(2020, 1, 1, 6, 30, 0).serial).toBeCloseTo(43831 + 6.5 / 24, 10);
  expect(dateFrom(1899, 12, 29, 6).serial).toBe(-1.25);
  expect(dateFrom(2020, 13, 1)).toEqual(dateFrom(2021, 1, 1)); // month overflow rolls over
  expect(dateFrom(50, 1, 1).serial).toBeLessThan(0); // year 50 is year 50, not 1950
});
test('dateParts inverts dateFrom', () => {
  expect(dateParts(dateFrom(2024, 2, 29, 13, 45, 30).serial)).toEqual({ y: 2024, m: 2, d: 29, h: 13, n: 45, s: 30 });
  expect(dateParts(0)).toEqual({ y: 1899, m: 12, d: 30, h: 0, n: 0, s: 0 });
  expect(dateParts(-1.25)).toEqual({ y: 1899, m: 12, d: 29, h: 6, n: 0, s: 0 });
});

// ---- arrays ----
test('array defaults and multi-dim', () => {
  const a = new VBArray('Integer', [[1, 2], [0, 1]]);
  expect(a.get([1, 0])).toBe(0);
  a.set([2, 1], 9);
  expect(a.get([2, 1])).toBe(9);
  expect(a.get([1, 1])).toBe(0);
  expect(() => a.get([0, 0])).toThrow(err(9));
  expect(() => a.set([1, 2], 1)).toThrow(err(9));
  expect(() => a.get([1])).toThrow(err(9)); // wrong dimension count
  expect(() => a.get([1, 0, 0])).toThrow(err(9));
});
test('array string and variant defaults', () => {
  expect(new VBArray('String', [[0, 0]]).get([0])).toBe('');
  expect(new VBArray('Variant', [[0, 0]]).get([0])).toBe(Empty);
});
test('array negative lower bound', () => {
  const a = new VBArray('Long', [[-2, 2]]);
  a.set([-2], 5);
  expect(a.get([-2])).toBe(5);
  expect(() => a.get([-3])).toThrow(err(9));
});
test('fixed array cannot be redimmed', () => {
  const a = new VBArray('Integer', [[0, 2]], true);
  expect(a.fixed).toBe(true);
  expect(() => a.redim([[0, 5]], false)).toThrow(err(10));
  expect(new VBArray('Integer', [[0, 2]]).fixed).toBe(false);
});
test('redim without preserve clears; with preserve shrinks', () => {
  const a = new VBArray('Integer', [[0, 2]]);
  a.set([0], 1); a.set([2], 3);
  a.redim([[0, 1]], true);
  expect(a.get([0])).toBe(1);
  expect(() => a.get([2])).toThrow(err(9));
  a.redim([[0, 4]], false);
  expect(a.get([0])).toBe(0);
  expect(a.bounds).toEqual([[0, 4]]);
});
test('redim preserve only last dimension', () => {
  const a = new VBArray('Integer', [[0, 1], [0, 1]]);
  a.set([1, 1], 5); a.set([0, 1], 4);
  a.redim([[0, 1], [0, 3]], true);
  expect(a.get([1, 1])).toBe(5);
  expect(a.get([0, 1])).toBe(4);
  expect(a.get([1, 3])).toBe(0);
  expect(() => a.redim([[0, 2], [0, 3]], true)).toThrow(err(9));
  expect(() => a.redim([[0, 3]], true)).toThrow(err(9));
  a.redim([[0, 2], [0, 2]], false); // without preserve anything goes
  expect(a.get([2, 2])).toBe(0);
});
test('array rejects inverted bounds', () => {
  expect(() => new VBArray('Integer', [[2, 0]])).toThrow(err(9));
  expect(new VBArray('Integer', [[0, -1]]).size).toBe(0); // empty array like Array()
});
test('array element init factory and clone', () => {
  const a = new VBArray({ userType: 'P' }, [[0, 1]], false, () => new VBRecord('P', new Map([['x', 0]])));
  const r0 = a.get([0]) as VBRecord;
  const r1 = a.get([1]) as VBRecord;
  expect(r0).not.toBe(r1);
  const c = a.clone();
  (r0.fields as Map<string, number>).set('x', 5);
  expect((c.get([0]) as VBRecord).fields.get('x')).toBe(0);
});
test('record clone is deep', () => {
  const inner = new VBRecord('In', new Map([['a', 1]]));
  const r = new VBRecord('Out', new Map<string, any>([['i', inner], ['s', 'x']]));
  const c = r.clone();
  inner.fields.set('a', 2);
  expect((c.fields.get('i') as VBRecord).fields.get('a')).toBe(1);
  expect(c.typeName).toBe('Out');
});

// ---- VBRef ----
test('VBRef holds a value', () => { const r = new VBRef(3); r.value = 4; expect(r.value).toBe(4); });

// ---- errors ----
test('error texts', () => {
  const t: Record<number, string> = {
    3: 'Return without GoSub', 5: 'Invalid procedure call or argument', 6: 'Overflow', 7: 'Out of memory',
    9: 'Subscript out of range', 10: 'This array is fixed or temporarily locked', 11: 'Division by zero',
    13: 'Type mismatch', 20: 'Resume without error', 28: 'Out of stack space',
    35: 'Sub or Function not defined', 53: 'File not found', 91: 'Object variable or With block variable not set',
    92: 'For loop not initialized', 94: 'Invalid use of Null', 340: "Control array element 'n' doesn't exist",
    380: 'Invalid property value', 383: 'Property is read-only', 424: 'Object required',
    438: "Object doesn't support this property or method",
    450: 'Wrong number of arguments or invalid property assignment',
  };
  for (const [n, s] of Object.entries(t)) expect(vbErrorText(Number(n))).toBe(s);
  expect(vbErrorText(99999)).toBe('Application-defined or object-defined error');
});
test('VBRuntimeError', () => {
  const e = new VBRuntimeError(11);
  expect(e).toBeInstanceOf(Error);
  expect(e).toBeInstanceOf(VBRuntimeError);
  expect(e.number).toBe(11);
  expect(e.description).toBe('Division by zero');
  expect(e.message).toBe('Division by zero');
  expect(e.compile).toBe(false);
  const e2 = new VBRuntimeError(5, 'custom');
  expect(e2.description).toBe('custom');
  const c = VBRuntimeError.compile('Variable not defined');
  expect(c.compile).toBe(true);
  expect(c.number).toBe(0);
  expect(c.description).toBe('Variable not defined');
  expect(c).toBeInstanceOf(VBRuntimeError);
});
