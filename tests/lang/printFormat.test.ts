import { PrintLine } from '../../src/lang/printFormat';

// ---- brief tests (verbatim) ----
test('print zones', () => { const l = new PrintLine(); l.addItem('a'); l.addComma(); l.addItem('b'); expect(l.text()).toBe('a' + ' '.repeat(13) + 'b'); });
test('print numbers', () => { const l = new PrintLine(); l.addItem(1); l.addSemicolon(); l.addItem(-2); expect(l.text()).toBe(' 1 -2 '); });

import { generalDateText } from '../../src/lang/builtins/format';
import { Empty, Null, dateFrom, setDateTextFormatter } from '../../src/lang/values';
import { printNumber } from '../../src/lang/printFormat';

// ---- numbers ----
test('number spacing', () => {
  expect(printNumber(5)).toBe(' 5');
  expect(printNumber(0)).toBe(' 0');
  expect(printNumber(-5)).toBe('-5');
  expect(printNumber(0.5)).toBe(' .5');
  expect(printNumber(-0.5)).toBe('-.5');
  expect(printNumber(1.25)).toBe(' 1.25');
  expect(printNumber(1e20)).toBe(' 1E+20');
  expect(printNumber(0.1 + 0.2)).toBe(' .3');
});

test('every number gets a trailing space', () => {
  const l = new PrintLine();
  l.addItem(7);
  expect(l.text()).toBe(' 7 ');
  const m = new PrintLine();
  m.addItem(-0.25);
  expect(m.text()).toBe('-.25 ');
});

test('strings, booleans, Null, Empty', () => {
  const l = new PrintLine();
  l.addItem('x'); l.addSemicolon(); l.addItem(true); l.addSemicolon(); l.addItem(Null); l.addSemicolon(); l.addItem(Empty); l.addSemicolon(); l.addItem(false);
  expect(l.text()).toBe('xTrueNullFalse');
});

test('strings keep no spaces between ; items', () => {
  const l = new PrintLine();
  l.addItem('a'); l.addSemicolon(); l.addItem('b'); l.addSemicolon(); l.addItem(1);
  expect(l.text()).toBe('ab 1 ');
});

// ---- zones ----
test('comma moves to the next 14-column zone', () => {
  const l = new PrintLine();
  l.addItem(1); l.addComma(); l.addItem(2);
  expect(l.text()).toBe(' 1 ' + ' '.repeat(11) + ' 2 ');
});

test('comma at a zone boundary moves a whole zone', () => {
  const l = new PrintLine();
  l.addItem('abcdefghijklmn'); l.addComma(); l.addItem('x');
  expect(l.text()).toBe('abcdefghijklmn' + ' '.repeat(14) + 'x');
});

test('comma after a long item goes to the next zone', () => {
  const l = new PrintLine();
  l.addItem('abcdefghijklmnopq'); l.addComma(); l.addItem('x'); // 17 chars: next zone starts at 28
  expect(l.text()).toBe('abcdefghijklmnopq' + ' '.repeat(11) + 'x');
});

test('several commas', () => {
  const l = new PrintLine();
  l.addItem('a'); l.addComma(); l.addComma(); l.addItem('b');
  expect(l.text()).toBe('a' + ' '.repeat(27) + 'b');
});

test('a leading comma', () => {
  const l = new PrintLine();
  l.addComma(); l.addItem('b');
  expect(l.text()).toBe(' '.repeat(14) + 'b');
});

test('start column continues an unfinished line', () => {
  const l = new PrintLine(10);
  l.addComma(); l.addItem('z');
  expect(l.text()).toBe('    z');
});

// ---- dates ----
test('dates print by locale', () => {
  setDateTextFormatter(v => generalDateText(v.serial, 'en-US'));
  try {
    const l = new PrintLine();
    l.addItem(dateFrom(2026, 10, 22)); l.addSemicolon(); l.addItem(' '); l.addItem(dateFrom(2026, 10, 22, 13, 5, 0));
    expect(l.text()).toBe('10/22/2026 10/22/2026 1:05:00 PM');
    setDateTextFormatter(v => generalDateText(v.serial, 'nb-NO'));
    const m = new PrintLine();
    m.addItem(dateFrom(2026, 10, 22));
    expect(m.text()).toBe('22.10.2026');
  } finally {
    setDateTextFormatter(undefined);
  }
});
