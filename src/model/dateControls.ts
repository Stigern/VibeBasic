// Date helpers of DTPicker and MonthView (MSCOMCT2.OCX): the language's date serials, its Format names and month / weekday
// names, the DTPicker format fields (VB6 custom format tokens) and the month grid. Pure: no DOM.

import { dateFrom, dateParts } from '../lang/values';
import { monthName, weekdayNameOf } from '../lang/builtins/format';

/** The range of DTPicker and MonthView: 1/1/1601 to 12/31/9999 (as an OLE serial, before 1899 negative). */
export const MIN_DATE = dateFrom(1601, 1, 1).serial;
export const MAX_DATE = dateFrom(9999, 12, 31).serial;

/** Whole days of a serial (the time of day dropped). */
export const dayOf = (serial: number): number => Math.trunc(serial);
/** Weekday of a serial, 1 = Sunday ... 7 = Saturday (the language's Weekday and the mvw constants). */
export const weekdayOf = (serial: number): number => ((((Math.trunc(serial) + 6) % 7) + 7) % 7) + 1;
export const clampDate = (serial: number, min: number, max: number): number => Math.min(max, Math.max(min, serial));
export const daysInMonth = (y: number, m: number): number => dateParts(dateFrom(y, m + 1, 0).serial).d;

/** The current moment as a serial (`whole`: the date only). */
export function nowSerial(whole = false): number {
  const d = new Date();
  const s = dateFrom(d.getFullYear(), d.getMonth() + 1, d.getDate(), whole ? 0 : d.getHours(), whole ? 0 : d.getMinutes(), whole ? 0 : d.getSeconds());
  return s.serial;
}

/** The serial with another date and the same time of day; day or month may overflow (Jan 32 = Feb 1). */
export function withDate(serial: number, y: number, m: number, d: number): number {
  const p = dateParts(serial);
  return dateFrom(y, m, d, p.h, p.n, p.s).serial;
}

/** A serial with one calendar part replaced; false when the part is out of range (error 380 in VB6). */
export function setPart(serial: number, part: 'Day' | 'Month' | 'Year' | 'Hour' | 'Minute' | 'Second', n: number): number | null {
  const p = dateParts(serial);
  switch (part) {
    case 'Year': return n >= 1601 && n <= 9999 ? dateFrom(n, p.m, Math.min(p.d, daysInMonth(n, p.m)), p.h, p.n, p.s).serial : null;
    case 'Month': return n >= 1 && n <= 12 ? dateFrom(p.y, n, Math.min(p.d, daysInMonth(p.y, n)), p.h, p.n, p.s).serial : null;
    case 'Day': return n >= 1 && n <= daysInMonth(p.y, p.m) ? dateFrom(p.y, p.m, n, p.h, p.n, p.s).serial : null;
    case 'Hour': return n >= 0 && n <= 23 ? dateFrom(p.y, p.m, p.d, n, p.n, p.s).serial : null;
    case 'Minute': return n >= 0 && n <= 59 ? dateFrom(p.y, p.m, p.d, p.h, n, p.s).serial : null;
    case 'Second': return n >= 0 && n <= 59 ? dateFrom(p.y, p.m, p.d, p.h, p.n, n).serial : null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// DTPicker format

/** DTPicker.Format. */
export const DTP_LONG_DATE = 0, DTP_SHORT_DATE = 1, DTP_TIME = 2, DTP_CUSTOM = 3;

export type DtSeg = { tok: string } | { lit: string };

/**
 * The fields of a custom format: d dd ddd dddd, M MM MMM MMMM, y yy yyyy, h hh H HH, m mm, s ss, t tt; 'text' in single
 * quotes and every other character are literal.
 */
export function parseCustomFormat(fmt: string): DtSeg[] {
  const out: DtSeg[] = [];
  const lit = (t: string) => { const last = out[out.length - 1]; if (last && 'lit' in last) last.lit += t; else out.push({ lit: t }); };
  const MAX: Record<string, number> = { d: 4, M: 4, y: 4, h: 2, H: 2, m: 2, s: 2, t: 2 };
  for (let i = 0; i < fmt.length;) {
    const ch = fmt[i];
    if (ch === "'") {
      let j = i + 1, text = '';
      while (j < fmt.length && fmt[j] !== "'") text += fmt[j++];
      if (text === '' && fmt[j] === "'") text = "'";   // '' is a quote
      lit(text);
      i = j + 1;
    } else if (MAX[ch]) {
      let n = 1;
      while (fmt[i + n] === ch && n < MAX[ch]) n++;
      if (ch === 'y' && n === 3) n = 2;
      out.push({ tok: ch.repeat(n) });
      i += n;
    } else { lit(ch); i++; }
  }
  return out;
}

const tidy = (s: string): string => s.replace(/[  ]/g, ' ');

/** The system formats as fields: Long Date, Short Date and Time of the locale. */
export function standardFormat(kind: number, locale: string): DtSeg[] {
  const opts: Intl.DateTimeFormatOptions = kind === DTP_LONG_DATE ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
    : kind === DTP_SHORT_DATE ? { year: 'numeric', month: 'numeric', day: 'numeric' }
    : { hour: 'numeric', minute: '2-digit', second: '2-digit' };
  let f: Intl.DateTimeFormat;
  try { f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }); } catch { f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }); }
  const h12 = f.resolvedOptions().hour12 === true;
  const out: DtSeg[] = [];
  const push = (s: DtSeg) => { const last = out[out.length - 1]; if ('lit' in s && last && 'lit' in last) last.lit += s.lit; else out.push(s); };
  for (const p of f.formatToParts(new Date(Date.UTC(2026, 9, 22, 14, 5, 9)))) {
    switch (p.type) {
      case 'weekday': push({ tok: 'dddd' }); break;
      case 'day': push({ tok: 'd' }); break;
      case 'month': push({ tok: kind === DTP_LONG_DATE ? 'MMMM' : 'M' }); break;
      case 'year': push({ tok: 'yyyy' }); break;
      case 'hour': push({ tok: h12 ? 'h' : 'HH' }); break;
      case 'minute': push({ tok: 'mm' }); break;
      case 'second': push({ tok: 'ss' }); break;
      case 'dayPeriod': push({ tok: 'tt' }); break;
      case 'literal': push({ lit: tidy(p.value) }); break;
    }
  }
  return out;
}

export const dtSegments = (format: number, custom: string, locale: string): DtSeg[] =>
  format === DTP_CUSTOM ? parseCustomFormat(custom) : standardFormat(format, locale);

const p2 = (n: number): string => String(n).padStart(2, '0');

/** The text of one field for a date. */
export function fieldText(tok: string, serial: number, locale: string): string {
  const p = dateParts(serial);
  switch (tok) {
    case 'd': return String(p.d);
    case 'dd': return p2(p.d);
    case 'ddd': return weekdayNameOf(weekdayOf(serial) - 1, false, locale);
    case 'dddd': return weekdayNameOf(weekdayOf(serial) - 1, true, locale);
    case 'M': return String(p.m);
    case 'MM': return p2(p.m);
    case 'MMM': return monthName(p.m, false, locale);
    case 'MMMM': return monthName(p.m, true, locale);
    case 'y': return String(p.y % 100);
    case 'yy': return p2(p.y % 100);
    case 'yyyy': return String(p.y).padStart(4, '0');
    case 'h': return String(p.h % 12 || 12);
    case 'hh': return p2(p.h % 12 || 12);
    case 'H': return String(p.h);
    case 'HH': return p2(p.h);
    case 'm': return String(p.n);
    case 'mm': return p2(p.n);
    case 's': return String(p.s);
    case 'ss': return p2(p.s);
    case 't': return p.h < 12 ? 'A' : 'P';
    case 'tt': return p.h < 12 ? 'AM' : 'PM';
  }
  return '';
}

/** The text of a date in a format (what the DTPicker shows). */
export function formatDtp(serial: number, format: number, custom: string, locale: string): string {
  return dtSegments(format, custom, locale).map(s => ('lit' in s ? s.lit : fieldText(s.tok, serial, locale))).join('');
}

/** Moves the field `tok` by `delta` (the Up and Down keys); the other fields keep their value except where the month is shorter. */
export function adjustField(serial: number, tok: string, delta: number): number {
  const p = dateParts(serial);
  const wrap = (v: number, lo: number, hi: number) => ((v - lo) % (hi - lo + 1) + (hi - lo + 1)) % (hi - lo + 1) + lo;
  switch (tok[0]) {
    case 'd':
      if (tok.length >= 3) return withDate(serial, p.y, p.m, p.d + delta);
      return withDate(serial, p.y, p.m, wrap(p.d + delta, 1, daysInMonth(p.y, p.m)));
    case 'M': { const m = wrap(p.m + delta, 1, 12); return withDate(serial, p.y, m, Math.min(p.d, daysInMonth(p.y, m))); }
    case 'y': { const y = Math.min(9999, Math.max(1601, p.y + delta)); return withDate(serial, y, p.m, Math.min(p.d, daysInMonth(y, p.m))); }
    case 'h': case 'H': {
      const h = tok[0] === 'H' ? wrap(p.h + delta, 0, 23) : p.h < 12 ? wrap(p.h + delta, 0, 11) : wrap(p.h + delta, 12, 23);
      return dateFrom(p.y, p.m, p.d, h, p.n, p.s).serial;
    }
    case 'm': return dateFrom(p.y, p.m, p.d, p.h, wrap(p.n + delta, 0, 59), p.s).serial;
    case 's': return dateFrom(p.y, p.m, p.d, p.h, p.n, wrap(p.s + delta, 0, 59)).serial;
    case 't': return dateFrom(p.y, p.m, p.d, (p.h + 12) % 24, p.n, p.s).serial;
  }
  return serial;
}

/** The number of digits a numeric field takes (0: a name, typed digits do not apply). */
export function fieldDigits(tok: string): number {
  if (tok === 'ddd' || tok === 'dddd' || tok === 'MMM' || tok === 'MMMM' || tok[0] === 't') return 0;
  return tok === 'yyyy' ? 4 : 2;
}

/** The date with the field `tok` typed as `n`, or null when `n` does not fit the field. */
export function typeField(serial: number, tok: string, n: number): number | null {
  const p = dateParts(serial);
  switch (tok[0]) {
    case 'd': return setPart(serial, 'Day', n);
    case 'M': return setPart(serial, 'Month', n);
    case 'y': return setPart(serial, 'Year', tok === 'yyyy' ? n : n <= 29 ? 2000 + n : 1900 + n);
    case 'H': return setPart(serial, 'Hour', n);
    case 'h': return n >= 1 && n <= 12 ? setPart(serial, 'Hour', (n % 12) + (p.h >= 12 ? 12 : 0)) : null;
    case 'm': return setPart(serial, 'Minute', n);
    case 's': return setPart(serial, 'Second', n);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// MonthView

/** mvwSunday 1 ... mvwSaturday 7: the week start of the system (Monday on a Norwegian Mac). */
export function systemStartOfWeek(locale: string): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?(): { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = (l.getWeekInfo ? l.getWeekInfo() : l.weekInfo)?.firstDay;   // 1 Monday ... 7 Sunday
    if (typeof first === 'number') return first === 7 ? 1 : first + 1;
  } catch { /* an unknown locale */ }
  return 1;
}

export interface GridDay { serial: number; inMonth: boolean }

/** The 6 weeks of a month, 42 days; `startOfWeek` is 1 (Sunday) ... 7. */
export function monthGrid(year: number, month: number, startOfWeek: number): GridDay[] {
  const first = dateFrom(year, month, 1).serial;
  const start = first - ((weekdayOf(first) - startOfWeek + 7) % 7);
  const out: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const serial = start + i;
    const p = dateParts(serial);
    out.push({ serial, inMonth: p.y === year && p.m === month });
  }
  return out;
}

/** The ISO 8601 week number of the week that starts with `weekStart` (its Thursday decides the year). */
export function weekNumberOf(weekStart: number): number {
  const thu = weekStart + ((5 - weekdayOf(weekStart) + 7) % 7);
  const jan1 = dateFrom(dateParts(thu).y, 1, 1).serial;
  return Math.floor((thu - jan1) / 7) + 1;
}

/** The month `delta` months from year/month. */
export function addMonths(year: number, month: number, delta: number): { y: number; m: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12 + 12) % 12 + 1 };
}
