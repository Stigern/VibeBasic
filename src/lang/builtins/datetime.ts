// Date and time built-ins: Now Date Time Timer, Year Month Day Hour Minute
// Second Weekday, DateSerial TimeSerial DateValue TimeValue, DateAdd DateDiff
// DatePart, MonthName WeekdayName. (CDate and IsDate are in convert.ts,
// Format and FormatDateTime in format.ts.)

import { VBRuntimeError } from '../errors';
import { plain } from '../interp/operators';
import { Null, coerce, dateFrom, dateParts, toSingle, toStr, type VBDate, type VBValue } from '../values';
import { monthName, weekdayNameOf } from './format';
import { def, intArg, isNullV, optInt } from './util';

const date = (serial: number): VBDate => ({ kind: 'date', serial });
const serialOf = (v: VBValue): number => (coerce(plain(v), 'Date') as VBDate).serial;

def('Now', 0, 0, () => {
  const d = new Date();
  return dateFrom(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
});
def('Date', 0, 0, () => {
  const d = new Date();
  return dateFrom(d.getFullYear(), d.getMonth() + 1, d.getDate());
});
def('Time', 0, 0, () => {
  const d = new Date();
  return date((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400);
});
/** Seconds since midnight as a Single (VB6: shown with 7 digits, e.g. 30896.12). */
def('Timer', 0, 0, () => {
  const d = new Date();
  return toSingle(d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000);
});

// ---- parts ----

function part(name: string, pick: (p: ReturnType<typeof dateParts>) => number): void {
  def(name, 1, 1, a => (isNullV(plain(a[0])) ? Null : pick(dateParts(serialOf(a[0])))));
}
part('Year', p => p.y);
part('Month', p => p.m);
part('Day', p => p.d);
part('Hour', p => p.h);
part('Minute', p => p.n);
part('Second', p => p.s);

/** Weekday of a serial, 1 = Sunday (1899-12-30 was a Saturday). */
const weekdayOf = (serial: number): number => ((((Math.floor(serial) + 6) % 7) + 7) % 7) + 1;

const firstDay = (v: VBValue | undefined): number => {
  const f = optInt(v, 1);
  if (f < 0 || f > 7) throw new VBRuntimeError(5);
  return f === 0 ? 1 : f;
};

def('Weekday', 1, 2, a => {
  if (isNullV(plain(a[0]))) return Null;
  return ((weekdayOf(serialOf(a[0])) - firstDay(a[1]) + 7) % 7) + 1;
});

// ---- construction ----

function fullYear(y: number): number {
  if (y < 0 || y > 9999) throw new VBRuntimeError(5);
  if (y <= 29) return 2000 + y;
  if (y <= 99) return 1900 + y;
  return y;
}

def('DateSerial', 3, 3, a => dateFrom(fullYear(intArg(a[0])), intArg(a[1]), intArg(a[2])));
def('TimeSerial', 3, 3, a => date(dateFrom(1899, 12, 30, intArg(a[0]), intArg(a[1]), intArg(a[2])).serial));
def('DateValue', 1, 1, a => date(Math.floor(serialOf(a[0]))));
def('TimeValue', 1, 1, a => {
  const s = serialOf(a[0]);
  return date(s - Math.floor(s));
});

// ---- DateAdd / DateDiff / DatePart ----

type Interval = 'yyyy' | 'q' | 'm' | 'y' | 'd' | 'w' | 'ww' | 'h' | 'n' | 's';
const INTERVALS = new Set(['yyyy', 'q', 'm', 'y', 'd', 'w', 'ww', 'h', 'n', 's']);

function interval(v: VBValue): Interval {
  const s = toStr(v).toLowerCase();
  if (!INTERVALS.has(s)) throw new VBRuntimeError(5);
  return s as Interval;
}

function daysInMonth(y: number, m: number): number {
  return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function addMonths(serial: number, months: number): VBDate {
  const p = dateParts(serial);
  const idx = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  if (y < 100 || y > 9999) throw new VBRuntimeError(5);
  return dateFrom(y, m, Math.min(p.d, daysInMonth(y, m)), p.h, p.n, p.s);
}

def('DateAdd', 3, 3, a => {
  const iv = interval(a[0]);
  if (isNullV(plain(a[2]))) return Null;
  const n = intArg(plain(a[1])); // VB rounds the number argument
  const s = serialOf(a[2]);
  switch (iv) {
    case 'yyyy': return addMonths(s, n * 12);
    case 'q': return addMonths(s, n * 3);
    case 'm': return addMonths(s, n);
    case 'y': case 'd': case 'w': return date(s + n);
    case 'ww': return date(s + n * 7);
    case 'h': return date(s + n / 24);
    case 'n': return date(s + n / 1440);
    case 's': return date(s + n / 86400);
  }
});

/** Whole seconds since the epoch day, so boundary counts are exact. */
const secondsOf = (serial: number): number => Math.round(serial * 86400);

def('DateDiff', 3, 5, a => {
  const iv = interval(a[0]);
  if (isNullV(plain(a[1])) || isNullV(plain(a[2]))) return Null;
  const s1 = serialOf(a[1]);
  const s2 = serialOf(a[2]);
  const p1 = dateParts(s1);
  const p2 = dateParts(s2);
  const first = firstDay(a[3]);
  switch (iv) {
    case 'yyyy': return p2.y - p1.y;
    case 'q': return (p2.y * 4 + Math.floor((p2.m - 1) / 3)) - (p1.y * 4 + Math.floor((p1.m - 1) / 3));
    case 'm': return (p2.y - p1.y) * 12 + (p2.m - p1.m);
    case 'y': case 'd': return Math.floor(s2) - Math.floor(s1);
    case 'w': return Math.trunc((Math.floor(s2) - Math.floor(s1)) / 7);
    case 'ww': return Math.floor((Math.floor(s2) - first) / 7) - Math.floor((Math.floor(s1) - first) / 7);
    case 'h': return Math.floor(secondsOf(s2) / 3600) - Math.floor(secondsOf(s1) / 3600);
    case 'n': return Math.floor(secondsOf(s2) / 60) - Math.floor(secondsOf(s1) / 60);
    case 's': return secondsOf(s2) - secondsOf(s1);
  }
});

def('DatePart', 2, 4, a => {
  const iv = interval(a[0]);
  if (isNullV(plain(a[1]))) return Null;
  const s = serialOf(a[1]);
  const p = dateParts(s);
  const first = firstDay(a[2]);
  const jan1 = Math.floor(dateFrom(p.y, 1, 1).serial);
  const doy = Math.floor(s) - jan1 + 1;
  switch (iv) {
    case 'yyyy': return p.y;
    case 'q': return Math.ceil(p.m / 3);
    case 'm': return p.m;
    case 'y': return doy;
    case 'd': return p.d;
    case 'w': return ((weekdayOf(s) - first + 7) % 7) + 1;
    case 'ww': return Math.floor((doy - 1 + ((weekdayOf(jan1) - first + 7) % 7)) / 7) + 1;
    case 'h': return p.h;
    case 'n': return p.n;
    case 's': return p.s;
  }
});

// ---- names ----

def('MonthName', 1, 2, (a, ctx) => {
  const m = intArg(a[0]);
  if (m < 1 || m > 12) throw new VBRuntimeError(5);
  return monthName(m, !(a[1] !== undefined && coerce(a[1], 'Boolean')), ctx.locale);
});

def('WeekdayName', 1, 3, (a, ctx) => {
  const w = intArg(a[0]);
  if (w < 1 || w > 7) throw new VBRuntimeError(5);
  const dow = (w - 1 + firstDay(a[2]) - 1) % 7; // 0 = Sunday
  return weekdayNameOf(dow, !(a[1] !== undefined && coerce(a[1], 'Boolean')), ctx.locale);
});
