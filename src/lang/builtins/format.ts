// Format(), FormatDateTime() and the locale-based date text used by CStr/Print.
//
// Numbers: named formats (General Number, Fixed, Standard, Percent, Currency,
// Scientific, Yes/No, True/False, On/Off) and custom patterns with sections
// `positive;negative;zero`, the placeholders `0 # . , % E+ E-`, quoted text
// "..." and `\x`. Decimal and thousands separators are always `.` and `,`;
// rounding is half away from zero (like VB's Format), on 15 significant digits.
//
// Dates: named formats follow the locale (Intl); custom patterns use
// d dd ddd dddd ddddd m mm mmm mmmm yy yyyy h hh n nn s ss q w ww y ttttt
// AM/PM am/pm A/P a/p. `m` right after `h` or right before `s` means minutes.

import { VBRuntimeError } from '../errors';
import { plain } from '../interp/operators';
import {
  Null, NullT, coerce, dateParts, pivotYear, toBool, toNumber, toStr, validDate, type DateTextParser, type VBDate, type VBValue,
} from '../values';
import { def } from './util';

type Parts = ReturnType<typeof dateParts>;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const clean = (s: string) => s.replace(/[  ]/g, ' ');

function utcDate(p: Parts): Date {
  const d = new Date(0);
  d.setUTCFullYear(p.y, p.m - 1, p.d);
  d.setUTCHours(p.h, p.n, p.s, 0);
  return d;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + '|' + JSON.stringify(opts);
  let f = formatters.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }); }
    catch { f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }); }
    formatters.set(key, f);
  }
  return f;
}

function intl(locale: string, opts: Intl.DateTimeFormatOptions, p: Parts): string {
  return clean(formatter(locale, opts).format(utcDate(p)));
}

/** Locale month name for month 1..12. */
export function monthName(m: number, long: boolean, locale: string): string {
  return intl(locale, { month: long ? 'long' : 'short' }, { y: 2001, m, d: 1, h: 0, n: 0, s: 0 });
}

/** Locale weekday name for dow 0 (Sunday) .. 6. */
export function weekdayNameOf(dow: number, long: boolean, locale: string): string {
  // 2023-01-01 was a Sunday
  return intl(locale, { weekday: long ? 'long' : 'short' }, { y: 2023, m: 1, d: 1 + dow, h: 0, n: 0, s: 0 });
}

const dayOfWeek = (p: Parts): number => utcDate(p).getUTCDay();
function isLeap(y: number): boolean { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

function dayOfYearOf(p: Parts): number {
  const t = Date.UTC(2001, p.m - 1, p.d) - Date.UTC(2001, 0, 1); // 2001: not a leap year
  return Math.round(t / 86400000) + 1 + (isLeap(p.y) && p.m > 2 ? 1 : 0);
}

const SHORT_DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
const LONG_TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
const shortDateText = (p: Parts, loc: string) => intl(loc, SHORT_DATE, p);
const longDateText = (p: Parts, loc: string) => intl(loc, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }, p);
const longTimeText = (p: Parts, loc: string) => intl(loc, LONG_TIME, p);
const shortTimeText = (p: Parts) => `${pad(p.h)}:${pad(p.n)}`;
const h12 = (h: number) => h % 12 || 12;
const mediumTimeText = (p: Parts) => `${pad(h12(p.h))}:${pad(p.n)} ${p.h < 12 ? 'AM' : 'PM'}`;
const mediumDateText = (p: Parts, loc: string) => `${pad(p.d)}-${monthName(p.m, false, loc)}-${pad(p.y % 100)}`;

/** General Date: short date and long time; only the part that is non-zero. */
export function generalDateText(serial: number, locale: string): string {
  const p = dateParts(serial);
  const hasDate = Math.trunc(serial) !== 0;
  const hasTime = p.h !== 0 || p.n !== 0 || p.s !== 0;
  if (hasDate && hasTime) return `${shortDateText(p, locale)} ${longTimeText(p, locale)}`;
  if (hasDate) return shortDateText(p, locale);
  return longTimeText(p, locale);
}

// ---------------------------------------------------------------------------
// Locale date text back to a date (CDate, IsDate)
// ---------------------------------------------------------------------------

type DateField = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'dayPeriod';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A literal of a date pattern: surrounding and inner whitespace is optional (`22.10.2026`, `2026. 10. 22.`). */
const literalRe = (s: string) => s.trim().split(/\s+/).filter(Boolean).map(escapeRe).map(x => `\\s*${x}`).join('') + '\\s*';

/**
 * Regex source and field order of a locale pattern from `formatToParts`.
 * Seconds (with the literal before them) and the day period are optional; a
 * trailing literal is optional too.
 */
function patternOf(parts: Intl.DateTimeFormatPart[], fieldRe: Partial<Record<DateField, string>>): { src: string; fields: DateField[] } {
  const segs: string[] = [];
  const fields: DateField[] = [];
  let lastWasLiteral = false;
  parts.forEach((part, i) => {
    if (part.type === 'literal') {
      const re = literalRe(part.value);
      segs.push(i === parts.length - 1 ? `(?:${re})?` : re);
      lastWasLiteral = true;
      return;
    }
    const type = part.type as DateField;
    const re = fieldRe[type];
    if (re === undefined) return; // e.g. an era: not part of the text we accept
    fields.push(type);
    if (type === 'second') segs.push(`(?:${lastWasLiteral ? segs.pop() : ''}${re})?`);
    else if (type === 'dayPeriod') segs.push(`(?:${re})?`);
    else segs.push(re);
    lastWasLiteral = false;
  });
  return { src: segs.join(''), fields };
}

const dateParsers = new Map<string, DateTextParser>();

/**
 * Parses the text `generalDateText` gives in `locale` back into a date: the
 * short date (field order and separators from Intl), optionally followed by
 * the long time, or the long time alone (seconds and AM/PM optional; a
 * 24-hour time is accepted too). Two-digit years use VB's window (`pivotYear`).
 */
export function localeDateParser(locale: string): DateTextParser {
  let parser = dateParsers.get(locale);
  if (parser) return parser;
  const sample = utcDate({ y: 2026, m: 10, d: 22, h: 14, n: 5, s: 9 });
  const tf = formatter(locale, LONG_TIME);
  const periodOf = (h: number) => tf.formatToParts(utcDate({ y: 2026, m: 10, d: 22, h, n: 0, s: 0 })).find(p => p.type === 'dayPeriod')?.value;
  const am = [periodOf(1), 'AM', 'A'].filter((x): x is string => !!x);
  const pm = [periodOf(13), 'PM', 'P'].filter((x): x is string => !!x);
  const periodRe = [...am, ...pm].map(x => clean(x).trim().split(/\s+/).map(escapeRe).join('\\s*')).join('|');
  const date = patternOf(formatter(locale, SHORT_DATE).formatToParts(sample), { year: '(\\d{1,4})', month: '(\\d{1,2})', day: '(\\d{1,2})' });
  const time = patternOf(tf.formatToParts(sample), { hour: '(\\d{1,2})', minute: '(\\d{1,2})', second: '(\\d{1,2})', dayPeriod: `(${periodRe})` });
  const dateTime = new RegExp(`^${date.src}(?:\\s+${time.src})?$`, 'i');
  const timeOnly = new RegExp(`^${time.src}$`, 'i');
  const lower = (x: string) => clean(x).replace(/\s+/g, '').toLowerCase();
  const pmKeys = new Set(pm.map(lower));
  parser = (text: string) => {
    const s = clean(text).trim();
    const got: Partial<Record<DateField, string>> = {};
    let m = dateTime.exec(s);
    if (m) [...date.fields, ...time.fields].forEach((f, i) => { got[f] = m![i + 1]; });
    else {
      m = timeOnly.exec(s);
      if (!m) return undefined;
      time.fields.forEach((f, i) => { got[f] = m![i + 1]; });
    }
    const num = (f: DateField, dflt: number) => (got[f] === undefined ? dflt : Number(got[f]));
    let y = num('year', 1899);
    if (got.year !== undefined && got.year.length <= 2) y = pivotYear(y);
    let h = num('hour', 0);
    if (got.dayPeriod !== undefined) {
      if (h < 1 || h > 12) return undefined;
      h = (h % 12) + (pmKeys.has(lower(got.dayPeriod)) ? 12 : 0);
    }
    return validDate(y, num('month', 12), num('day', 30), h, num('minute', 0), num('second', 0));
  };
  dateParsers.set(locale, parser);
  return parser;
}

type DateKind = 'general' | 'short date' | 'long date' | 'medium date' | 'short time' | 'long time' | 'medium time';

function namedDate(kind: DateKind, v: VBValue, locale: string): string {
  const serial = (coerce(v, 'Date') as VBDate).serial;
  const p = dateParts(serial);
  switch (kind) {
    case 'general': return generalDateText(serial, locale);
    case 'short date': return shortDateText(p, locale);
    case 'long date': return longDateText(p, locale);
    case 'medium date': return mediumDateText(p, locale);
    case 'short time': return shortTimeText(p);
    case 'long time': return longTimeText(p, locale);
    case 'medium time': return mediumTimeText(p);
  }
}

// ---------------------------------------------------------------------------
// Custom date patterns
// ---------------------------------------------------------------------------

type DTok =
  | { t: 'lit'; s: string }
  | { t: 'd' | 'm' | 'y' | 'h' | 'n' | 's' | 'w'; n: number }
  | { t: 'q' }
  | { t: 'ampm'; style: 'AM/PM' | 'am/pm' | 'A/P' | 'a/p' }
  | { t: 'time5' };

function dateTokens(fmt: string): DTok[] {
  const out: DTok[] = [];
  const lit = (s: string) => {
    const last = out[out.length - 1];
    if (last && last.t === 'lit') last.s += s; else out.push({ t: 'lit', s });
  };
  for (let i = 0; i < fmt.length;) {
    const c = fmt[i];
    const lower = c.toLowerCase();
    const rest = fmt.slice(i).toLowerCase();
    if (c === '"') {
      const end = fmt.indexOf('"', i + 1);
      lit(fmt.slice(i + 1, end < 0 ? fmt.length : end));
      i = end < 0 ? fmt.length : end + 1;
    } else if (c === '\\') {
      lit(fmt[i + 1] ?? '');
      i += 2;
    } else if (rest.startsWith('am/pm')) {
      const text = fmt.slice(i, i + 5);
      out.push({ t: 'ampm', style: text === text.toLowerCase() ? 'am/pm' : 'AM/PM' });
      i += 5;
    } else if (rest.startsWith('a/p')) {
      const text = fmt.slice(i, i + 3);
      out.push({ t: 'ampm', style: text === text.toLowerCase() ? 'a/p' : 'A/P' });
      i += 3;
    } else if (rest.startsWith('ttttt')) {
      out.push({ t: 'time5' });
      i += 5;
    } else if ('dmyhnsw'.includes(lower)) {
      let j = i;
      while (j < fmt.length && fmt[j].toLowerCase() === lower) j++;
      out.push({ t: lower as 'd', n: j - i });
      i = j;
    } else if (lower === 'q') {
      out.push({ t: 'q' });
      i++;
    } else {
      lit(c);
      i++;
    }
  }
  return out;
}

function formatDate(v: VBValue, fmt: string, locale: string): string {
  const serial = (coerce(v, 'Date') as VBDate).serial;
  const p = dateParts(serial);
  const toks = dateTokens(fmt);
  const twelve = toks.some(t => t.t === 'ampm');
  const kinds = toks.filter(t => t.t !== 'lit');
  let out = '';
  for (const t of toks) {
    switch (t.t) {
      case 'lit': out += t.s; break;
      case 'd':
        out += t.n === 1 ? p.d : t.n === 2 ? pad(p.d) : t.n === 3 ? weekdayNameOf(dayOfWeek(p), false, locale)
          : t.n === 4 ? weekdayNameOf(dayOfWeek(p), true, locale) : shortDateText(p, locale);
        break;
      case 'm': {
        const at = kinds.indexOf(t);
        const prev = kinds[at - 1];
        const next = kinds[at + 1];
        if (t.n <= 2 && ((prev && prev.t === 'h') || (next && next.t === 's'))) out += t.n === 1 ? p.n : pad(p.n);
        else out += t.n === 1 ? p.m : t.n === 2 ? pad(p.m) : monthName(p.m, t.n >= 4, locale);
        break;
      }
      case 'y': out += t.n === 1 ? dayOfYearOf(p) : t.n === 2 ? pad(p.y % 100) : pad(p.y, 4); break;
      case 'h': { const h = twelve ? h12(p.h) : p.h; out += t.n === 1 ? h : pad(h); break; }
      case 'n': out += t.n === 1 ? p.n : pad(p.n); break;
      case 's': out += t.n === 1 ? p.s : pad(p.s); break;
      case 'q': out += Math.ceil(p.m / 3); break;
      case 'w':
        if (t.n === 1) out += dayOfWeek(p) + 1;
        else out += Math.floor((dayOfYearOf(p) - 1 + dayOfWeek({ ...p, m: 1, d: 1 })) / 7) + 1;
        break;
      case 'ampm': {
        const pm = p.h >= 12;
        out += t.style === 'AM/PM' ? (pm ? 'PM' : 'AM') : t.style === 'am/pm' ? (pm ? 'pm' : 'am')
          : t.style === 'A/P' ? (pm ? 'P' : 'A') : (pm ? 'p' : 'a');
        break;
      }
      case 'time5': out += longTimeText(p, locale); break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

type NItem =
  | { k: 'lit'; s: string }
  | { k: 'd'; c: '0' | '#' }
  | { k: 'pt' }
  | { k: 'cm' }
  | { k: 'pct' }
  | { k: 'exp'; e: string; plus: boolean; digits: number };

/** Splits at unquoted `;`. */
function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '"') {
      const end = fmt.indexOf('"', i + 1);
      const stop = end < 0 ? fmt.length : end + 1;
      cur += fmt.slice(i, stop);
      i = stop - 1;
    } else if (c === '\\') { cur += c + (fmt[i + 1] ?? ''); i++; }
    else if (c === ';') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function numberItems(sec: string): NItem[] {
  const items: NItem[] = [];
  let seenPoint = false;
  const lit = (s: string) => items.push({ k: 'lit', s });
  for (let i = 0; i < sec.length; i++) {
    const c = sec[i];
    if (c === '"') {
      const end = sec.indexOf('"', i + 1);
      lit(sec.slice(i + 1, end < 0 ? sec.length : end));
      i = end < 0 ? sec.length : end;
    } else if (c === '\\') { lit(sec[i + 1] ?? ''); i++; }
    else if (c === '_') { lit(' '); i++; }
    else if (c === '*') i++;
    else if (c === '0' || c === '#') items.push({ k: 'd', c });
    else if (c === '.' && !seenPoint) { seenPoint = true; items.push({ k: 'pt' }); }
    else if (c === ',') items.push({ k: 'cm' });
    else if (c === '%') items.push({ k: 'pct' });
    else if ((c === 'E' || c === 'e') && (sec[i + 1] === '+' || sec[i + 1] === '-') && sec[i + 2] === '0'
      && items.some(x => x.k === 'd')) {
      let j = i + 2;
      while (sec[j] === '0') j++;
      items.push({ k: 'exp', e: c, plus: sec[i + 1] === '+', digits: j - i - 2 });
      i = j - 1;
    } else lit(c);
  }
  return items;
}

function increment(digits: string): string {
  const a = digits.split('');
  let i = a.length - 1;
  while (i >= 0) {
    if (a[i] === '9') { a[i] = '0'; i--; } else { a[i] = String(+a[i] + 1); return a.join(''); }
  }
  return '1' + a.join('');
}

/** `abs` as decimal digits rounded half up at `nFrac` decimals; `int` has no leading zeros. */
function decimalDigits(abs: number, nFrac: number): { int: string; frac: string } {
  if (abs === 0) return { int: '', frac: '0'.repeat(nFrac) };
  const [mant, expStr] = abs.toExponential(14).split('e');
  const digits = mant.replace('.', '');
  const e = Number(expStr);
  let intPart: string;
  let fracPart: string;
  if (e >= 0) {
    intPart = digits.slice(0, e + 1).padEnd(e + 1, '0');
    fracPart = digits.slice(e + 1);
  } else {
    intPart = '';
    fracPart = '0'.repeat(-e - 1) + digits;
  }
  if (fracPart.length > nFrac) {
    const up = fracPart[nFrac] >= '5';
    fracPart = fracPart.slice(0, nFrac);
    if (up) {
      const all = increment((intPart + fracPart) || '0');
      intPart = all.slice(0, all.length - nFrac);
      fracPart = all.slice(all.length - nFrac);
    }
  } else fracPart = fracPart.padEnd(nFrac, '0');
  return { int: intPart.replace(/^0+/, ''), frac: fracPart };
}

/** Renders `abs` with the digit placeholders and literals of `items` (no exponent). */
function renderMain(items: NItem[], abs: number, thousands: boolean): { text: string; nonZero: boolean } {
  const ptIdx = items.findIndex(x => x.k === 'pt');
  const intItems = ptIdx < 0 ? items : items.slice(0, ptIdx);
  const fracItems = ptIdx < 0 ? [] : items.slice(ptIdx + 1);
  const nFrac = fracItems.filter(x => x.k === 'd').length;
  const { int, frac } = decimalDigits(abs, nFrac);

  // integer part, right to left
  const out: string[] = [];
  let rem = int;
  let count = 0;
  const emit = (ch: string) => {
    if (thousands && count > 0 && count % 3 === 0) out.push(',');
    out.push(ch);
    count++;
  };
  const flush = () => { while (rem) { emit(rem[rem.length - 1]); rem = rem.slice(0, -1); } };
  const first = intItems.findIndex(x => x.k === 'd');
  if (first < 0 && items.some(x => x.k === 'd')) flush(); // no placeholders at all: literals only
  for (let i = intItems.length - 1; i >= 0; i--) {
    const it = intItems[i];
    if (it.k === 'lit') out.push(it.s);
    else if (it.k === 'd') {
      if (rem) { emit(rem[rem.length - 1]); rem = rem.slice(0, -1); }
      else if (it.c === '0') emit('0');
      if (i === first) flush();
    }
  }
  let text = out.reverse().join('');

  // fraction, left to right; trailing `#` that would show 0 are dropped
  if (ptIdx >= 0) {
    const placeholders = fracItems.filter((x): x is { k: 'd'; c: '0' | '#' } => x.k === 'd');
    let lastKeep = -1;
    placeholders.forEach((ph, k) => { if (ph.c === '0' || frac[k] !== '0') lastKeep = k; });
    let k = 0;
    text += '.';
    for (const it of fracItems) {
      if (it.k === 'lit') text += it.s;
      else if (it.k === 'd') { if (k <= lastKeep) text += frac[k]; k++; }
    }
  }
  return { text, nonZero: /[1-9]/.test(int + frac) };
}

function formatNumberSection(n: number, sec: string, negateSign: boolean): string {
  const items = numberItems(sec);
  // scaling commas and thousands separators
  let thousands = false;
  let scale = 1;
  const kept: NItem[] = [];
  items.forEach((it, i) => {
    if (it.k !== 'cm') { kept.push(it); return; }
    const before = items.slice(0, i).some(x => x.k === 'd');
    let j = i + 1;
    while (items[j]?.k === 'cm') j++;
    const nextK = items[j]?.k;
    if (before && (nextK === undefined || nextK === 'pt' || nextK === 'exp')) scale *= 1000;
    else if (before && items.slice(j).some(x => x.k === 'd')) thousands = true;
  });
  let value = Math.abs(n);
  for (const it of kept) if (it.k === 'pct') value *= 100;
  value = Number(value.toPrecision(15)) / scale;
  const body = kept.map(it => (it.k === 'pct' ? { k: 'lit', s: '%' } as NItem : it));

  const expIdx = body.findIndex(x => x.k === 'exp');
  let text: string;
  let nonZero: boolean;
  if (expIdx < 0) {
    ({ text, nonZero } = renderMain(body, value, thousands));
  } else {
    const exp = body[expIdx] as Extract<NItem, { k: 'exp' }>;
    const main = body.slice(0, expIdx);
    const tail = body.slice(expIdx + 1).map(x => (x.k === 'lit' ? x.s : '')).join('');
    const ptIdx = main.findIndex(x => x.k === 'pt');
    const nInt = Math.max(1, main.slice(0, ptIdx < 0 ? main.length : ptIdx).filter(x => x.k === 'd').length);
    const nFrac = ptIdx < 0 ? 0 : main.slice(ptIdx).filter(x => x.k === 'd').length;
    let e = value === 0 ? 0 : Number(value.toExponential(14).split('e')[1]) - (nInt - 1);
    let mant = value === 0 ? 0 : Number(`${value.toPrecision(15)}e${-e}`);
    if (decimalDigits(mant, nFrac).int.length > nInt) { e++; mant = Number(`${value.toPrecision(15)}e${-e}`); }
    const r = renderMain(main, mant, false);
    const sign = e < 0 ? '-' : exp.plus ? '+' : '';
    text = `${r.text}${exp.e}${sign}${pad(Math.abs(e), exp.digits)}${tail}`;
    nonZero = r.nonZero;
  }
  return negateSign && nonZero ? '-' + text : text;
}

function formatNumber(n: number, fmt: string): string {
  const sections = splitSections(fmt);
  if (n > 0 || (n === 0 && sections.length < 3)) return formatNumberSection(n, sections[0], false);
  if (n < 0) return sections.length >= 2 ? formatNumberSection(n, sections[1], false) : formatNumberSection(n, sections[0], true);
  return formatNumberSection(0, sections[2], false);
}

// ---------------------------------------------------------------------------
// Text formats (@ & < >)
// ---------------------------------------------------------------------------

function formatText(s: string, fmt: string): string {
  let upper = false;
  let lower = false;
  const slots: ('@' | '&' | string)[] = [];
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '>') upper = true;
    else if (c === '<') lower = true;
    else if (c === '@' || c === '&') slots.push(c);
    else if (c === '"') {
      const end = fmt.indexOf('"', i + 1);
      slots.push(fmt.slice(i + 1, end < 0 ? fmt.length : end));
      i = end < 0 ? fmt.length : end;
    } else if (c === '\\') { slots.push(fmt[i + 1] ?? ''); i++; }
    else slots.push(c);
  }
  if (upper) s = s.toUpperCase(); else if (lower) s = s.toLowerCase();
  const nSlots = slots.filter(x => x === '@' || x === '&').length;
  if (nSlots === 0) return s;
  let rem = s;
  const out: string[] = [];
  const firstSlot = slots.findIndex(x => x === '@' || x === '&');
  for (let i = slots.length - 1; i >= 0; i--) {
    const sl = slots[i];
    if (sl === '@' || sl === '&') {
      if (rem) { out.push(rem[rem.length - 1]); rem = rem.slice(0, -1); } else if (sl === '@') out.push(' ');
      if (i === firstSlot && rem) { out.push(rem.split('').reverse().join('')); rem = ''; }
    } else out.push(sl);
  }
  return out.reverse().join('');
}

// ---------------------------------------------------------------------------
// formatValue
// ---------------------------------------------------------------------------

function tryNumber(v: VBValue): number | undefined {
  try { return toNumber(v); } catch (e) {
    if (e instanceof VBRuntimeError && e.number === 13) return undefined;
    throw e;
  }
}

const numericNamed = (pattern: string) => (v: VBValue): string => {
  const n = tryNumber(v);
  return n === undefined ? toStr(v) : formatNumber(n, pattern);
};

const twoWay = (yes: string, no: string) => (v: VBValue): string => ((typeof v === 'boolean' ? v : toBool(v)) ? yes : no);

const NAMED: Record<string, (v: VBValue, locale: string) => string> = {
  'general number': v => { const n = tryNumber(v); return n === undefined ? toStr(v) : toStr(n); },
  'fixed': numericNamed('0.00'),
  'standard': numericNamed('#,##0.00'),
  'percent': numericNamed('0.00%'),
  'currency': numericNamed('$#,##0.00;($#,##0.00)'),
  'scientific': numericNamed('0.00E+00'),
  'yes/no': twoWay('Yes', 'No'),
  'true/false': twoWay('True', 'False'),
  'on/off': twoWay('On', 'Off'),
  'general date': (v, l) => namedDate('general', v, l),
  'short date': (v, l) => namedDate('short date', v, l),
  'long date': (v, l) => namedDate('long date', v, l),
  'medium date': (v, l) => namedDate('medium date', v, l),
  'short time': (v, l) => namedDate('short time', v, l),
  'long time': (v, l) => namedDate('long time', v, l),
  'medium time': (v, l) => namedDate('medium time', v, l),
};

/** The format with quoted and backslash-escaped text removed. */
function stripLiterals(fmt: string): string {
  return fmt.replace(/"[^"]*"?|\\./g, '');
}

/** VB `Format(v, fmt)`. `v` must not be Null (the Format built-in handles that). */
export function formatValue(v: VBValue, fmt: string, locale: string): string {
  v = plain(v);
  if (v instanceof NullT) return '';
  if (fmt === '') return toStr(v);
  const named = NAMED[fmt.toLowerCase()];
  if (named) return named(v, locale);
  const bare = stripLiterals(fmt);
  const hasDigits = /[0#]/.test(bare);
  if (!hasDigits && /[@&<>]/.test(bare)) return formatText(toStr(v), fmt);
  if (!hasDigits && /[dmyhnsqw]|a\/p|am\/pm/i.test(bare)) return formatDate(v, fmt, locale);
  const n = tryNumber(v);
  return n === undefined ? toStr(v) : formatNumber(n, fmt);
}

def('Format', 1, 4, (a, ctx) => {
  const v = plain(a[0]);
  if (v instanceof NullT) return Null;
  return a[1] === undefined ? toStr(v) : formatValue(v, toStr(a[1]), ctx.locale);
});

def('FormatDateTime', 1, 2, (a, ctx) => {
  const kinds: DateKind[] = ['general', 'long date', 'short date', 'long time', 'short time'];
  const k = a[1] === undefined ? 0 : toNumber(a[1]);
  if (!Number.isInteger(k) || k < 0 || k > 4) throw new VBRuntimeError(5);
  return namedDate(kinds[k], plain(a[0]), ctx.locale);
});
