// String built-ins: Len Left Right Mid InStr InStrRev Replace UCase LCase
// Trim LTrim RTrim Space String Chr Asc ChrW AscW Split Join StrReverse StrComp.
// Functions that VB6 lets take Null (Left, UCase, ...) return Null for Null.

import { VBRuntimeError } from '../errors';
import { Null, VBArray, VBRecord, toBool, toStr, type VBValue } from '../values';
import { def, intArg, isNullV, isTextCompare, optInt, repeat, textMode } from './util';

// ---- Windows-1252 ----

const CP1252_HIGH = [
  '€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', '\u008D', 'Ž', '\u008F',
  '\u0090', '‘', '’', '“', '”', '•', '–', '—',
  '˜', '™', 'š', '›', 'œ', '\u009D', 'ž', 'Ÿ',
];
const CP1252_REVERSE = new Map<string, number>(CP1252_HIGH.map((c, i) => [c, 0x80 + i]));

/** `Chr`: a byte 0..255 as its Windows-1252 character. */
export function chr1252(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new VBRuntimeError(5);
  return n >= 0x80 && n <= 0x9f ? CP1252_HIGH[n - 0x80] : String.fromCharCode(n);
}

/** `Asc`: the Windows-1252 byte of a character (`?` = 63 when it has none). */
export function asc1252(c: string): number {
  const code = c.charCodeAt(0);
  const hi = CP1252_REVERSE.get(c[0]);
  if (hi !== undefined) return hi;
  return code <= 0xff ? code : 63;
}

// ---- length, slicing ----

/** Bytes of a variable of a numeric, Boolean or Date type (Len and LenB of one); a String or Variant uses its text. */
const STORAGE: Record<string, number> = { Byte: 1, Integer: 2, Boolean: 2, Long: 4, Single: 4, Double: 8, Currency: 8, Date: 8 };

/**
 * Len of a user-type variable is its size in a file (Open ... Len = Len(rec)); of a numeric, Boolean or Date variable
 * its storage size (`Len(l)` of a Long is 4); otherwise the length of the text.
 */
def('Len', 1, 1, (a, ctx, types) => {
  if (isNullV(a[0])) return Null;
  if (a[0] instanceof VBRecord && ctx.files) return ctx.files.recordLength(a[0]);
  return STORAGE[types?.[0] ?? ''] ?? toStr(a[0]).length;
}, { vars: true });

def('Left', 2, 2, a => {
  if (isNullV(a[0])) return Null;
  const n = intArg(a[1]);
  if (n < 0) throw new VBRuntimeError(5);
  return toStr(a[0]).slice(0, n);
});

def('Right', 2, 2, a => {
  if (isNullV(a[0])) return Null;
  const n = intArg(a[1]);
  if (n < 0) throw new VBRuntimeError(5);
  const s = toStr(a[0]);
  return n === 0 ? '' : s.slice(Math.max(0, s.length - n));
});

def('Mid', 2, 3, a => {
  if (isNullV(a[0])) return Null;
  const s = toStr(a[0]);
  const start = intArg(a[1]);
  const len = optInt(a[2], -1);
  if (start < 1 || (a[2] !== undefined && len < 0)) throw new VBRuntimeError(5);
  if (start > s.length) return '';
  return a[2] === undefined ? s.slice(start - 1) : s.slice(start - 1, start - 1 + len);
});

def('UCase', 1, 1, a => (isNullV(a[0]) ? Null : toStr(a[0]).toUpperCase()));
def('LCase', 1, 1, a => (isNullV(a[0]) ? Null : toStr(a[0]).toLowerCase()));

/** StrConv: vbUpperCase 1, vbLowerCase 2, vbProperCase 3; the others (vbWide, vbNarrow, vbUnicode, vbFromUnicode) leave the text as it is. */
def('StrConv', 2, 3, a => {
  if (isNullV(a[0])) return Null;
  const s = toStr(a[0]);
  const conv = intArg(a[1]);
  if (conv === 1) return s.toUpperCase();
  if (conv === 2) return s.toLowerCase();
  if (conv === 3) return s.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  return s;
});
def('Trim', 1, 1, a => (isNullV(a[0]) ? Null : toStr(a[0]).replace(/^ +| +$/g, '')));
def('LTrim', 1, 1, a => (isNullV(a[0]) ? Null : toStr(a[0]).replace(/^ +/, '')));
def('RTrim', 1, 1, a => (isNullV(a[0]) ? Null : toStr(a[0]).replace(/ +$/, '')));

def('Space', 1, 1, a => repeat(' ', intArg(a[0])));

def('String', 2, 2, a => {
  const n = intArg(a[0]);
  if (n < 0) throw new VBRuntimeError(5);
  const c = a[1];
  let ch: string;
  if (typeof c === 'string') {
    if (c === '') throw new VBRuntimeError(5);
    ch = c[0];
  } else {
    ch = chr1252(intArg(c) & 0xff);
  }
  return repeat(ch, n);
});

def('StrReverse', 1, 1, a => Array.from(toStr(a[0])).reverse().join(''));

// ---- chars ----

def('Chr', 1, 1, a => chr1252(intArg(a[0])));
def('ChrW', 1, 1, a => {
  let n = intArg(a[0]);
  if (n < -32768 || n > 65535) throw new VBRuntimeError(5);
  if (n < 0) n += 65536;
  return String.fromCharCode(n);
});
def('Asc', 1, 1, a => {
  const s = toStr(a[0]);
  if (s === '') throw new VBRuntimeError(5);
  return asc1252(s);
});
def('AscW', 1, 1, a => {
  const s = toStr(a[0]);
  if (s === '') throw new VBRuntimeError(5);
  return s.charCodeAt(0);
});

// ---- searching ----

const fold = (s: string, text: boolean) => (text ? s.toLowerCase() : s);

def('InStr', 2, 4, (a, ctx) => {
  let start = 1;
  let rest = a;
  if (a.length === 4 || (a.length === 3 && typeof a[0] === 'number')) {
    start = intArg(a[0]);
    rest = a.slice(1);
  }
  const [h, n, cmp] = rest;
  if (isNullV(h) || isNullV(n)) return Null;
  if (start < 1) throw new VBRuntimeError(5);
  const text = textMode(cmp, ctx);
  const hay = fold(toStr(h), text);
  const needle = fold(toStr(n), text);
  if (start > hay.length) return 0;
  if (needle === '') return start;
  return hay.indexOf(needle, start - 1) + 1;
});

def('InStrRev', 2, 4, a => {
  if (isNullV(a[0]) || isNullV(a[1])) return Null;
  const text = isTextCompare(a[3]);
  const hay = fold(toStr(a[0]), text);
  const needle = fold(toStr(a[1]), text);
  let start = optInt(a[2], -1);
  if (start === 0 || start < -1) throw new VBRuntimeError(5);
  if (start === -1) start = hay.length;
  if (start > hay.length) return 0;
  if (hay === '') return 0;
  if (needle === '') return start;
  if (start < needle.length) return 0;
  return hay.lastIndexOf(needle, start - needle.length) + 1;
});

def('StrComp', 2, 3, (a, ctx) => {
  if (isNullV(a[0]) || isNullV(a[1])) return Null;
  const text = textMode(a[2], ctx);
  const x = fold(toStr(a[0]), text);
  const y = fold(toStr(a[1]), text);
  return x < y ? -1 : x > y ? 1 : 0;
});

def('Replace', 3, 6, a => {
  if (isNullV(a[0])) return Null;
  const text = isTextCompare(a[5]);
  let s = toStr(a[0]);
  const find = toStr(a[1]);
  const repl = toStr(a[2]);
  const start = optInt(a[3], 1);
  const count = optInt(a[4], -1);
  if (start < 1 || count < -1) throw new VBRuntimeError(5);
  if (find === '') return s;
  if (start > s.length) return '';
  s = s.slice(start - 1);
  if (count === 0) return s;
  const hay = fold(s, text);
  const needle = fold(find, text);
  let out = '';
  let pos = 0;
  let done = 0;
  for (;;) {
    const i = count !== -1 && done >= count ? -1 : hay.indexOf(needle, pos);
    if (i < 0) break;
    out += s.slice(pos, i) + repl;
    pos = i + needle.length;
    done++;
  }
  return out + s.slice(pos);
});

// ---- Split / Join ----

def('Split', 1, 4, a => {
  if (isNullV(a[0])) throw new VBRuntimeError(94);
  const s = toStr(a[0]);
  const delim = a[1] === undefined ? ' ' : toStr(a[1]);
  const limit = optInt(a[2], -1);
  const text = isTextCompare(a[3]);
  let parts: string[];
  if (s === '' || limit === 0) parts = [];
  else if (delim === '') parts = [s];
  else {
    parts = [];
    const hay = fold(s, text);
    const needle = fold(delim, text);
    let pos = 0;
    for (;;) {
      const i = limit > 0 && parts.length >= limit - 1 ? -1 : hay.indexOf(needle, pos);
      if (i < 0) break;
      parts.push(s.slice(pos, i));
      pos = i + needle.length;
    }
    parts.push(s.slice(pos));
  }
  const arr = new VBArray('String', [[0, parts.length - 1]]);
  parts.forEach((p, i) => arr.set([i], p));
  return arr;
});

/** Filter(strings, match[, include[, compare]]): the elements that contain `match` (or, with include False, do not). */
def('Filter', 2, 4, a => {
  const arr = a[0];
  if (isNullV(arr) || isNullV(a[1])) throw new VBRuntimeError(94);
  if (!(arr instanceof VBArray) || arr.bounds.length !== 1) throw new VBRuntimeError(13);
  const text = isTextCompare(a[3]);
  const match = fold(toStr(a[1]), text);
  const include = a[2] === undefined || toBool(a[2]);
  const hits = arr.values().map(v => toStr(v)).filter(v => fold(v, text).includes(match) === include);
  const out = new VBArray('String', [[0, hits.length - 1]]);
  hits.forEach((h, i) => out.set([i], h));
  return out;
});

def('Join', 1, 2, a => {
  const arr = a[0];
  if (!(arr instanceof VBArray) || arr.bounds.length !== 1) throw new VBRuntimeError(5);
  const delim = a[1] === undefined ? ' ' : toStr(a[1]);
  return arr.values().map(v => toStr(v)).join(delim);
});

// ---- bytes: a string is UTF-16, two bytes a character (low byte first) ----
// VibeBasic strings hold whole characters: where a byte function would leave an odd last byte, that byte becomes a
// character of its own (ChrB(65) is "A", LenB(ChrB(65)) is 2; in VB6 it is a 1-byte string).

const bytesOf = (s: string): number[] => {
  const b: number[] = [];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b.push(c & 0xff, c >> 8); }
  return b;
};
const fromBytes = (b: number[]): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 2) s += String.fromCharCode(b[i] | ((b[i + 1] ?? 0) << 8));
  return s;
};
const byteCount = (v: VBValue): number => {
  const n = intArg(v);
  if (n < 0) throw new VBRuntimeError(5);
  return n;
};

def('LenB', 1, 1, (a, ctx, types) => {
  if (isNullV(a[0])) return Null;
  if (a[0] instanceof VBRecord && ctx.files) return ctx.files.recordLength(a[0]);
  return STORAGE[types?.[0] ?? ''] ?? toStr(a[0]).length * 2;
}, { vars: true });
def('LeftB', 2, 2, a => (isNullV(a[0]) ? Null : fromBytes(bytesOf(toStr(a[0])).slice(0, byteCount(a[1])))));
def('RightB', 2, 2, a => {
  if (isNullV(a[0])) return Null;
  const n = byteCount(a[1]);
  const b = bytesOf(toStr(a[0]));
  return n === 0 ? '' : fromBytes(b.slice(Math.max(0, b.length - n)));
});
def('MidB', 2, 3, a => {
  if (isNullV(a[0])) return Null;
  const start = intArg(a[1]);
  if (start < 1) throw new VBRuntimeError(5);
  const b = bytesOf(toStr(a[0]));
  return fromBytes(a[2] === undefined ? b.slice(start - 1) : b.slice(start - 1, start - 1 + byteCount(a[2])));
});
def('InStrB', 2, 4, a => {
  let start = 1;
  let rest = a;
  if (a.length === 4 || (a.length === 3 && typeof a[0] === 'number')) {
    start = intArg(a[0]);
    rest = a.slice(1);
  }
  const [h, n] = rest;
  if (isNullV(h) || isNullV(n)) return Null;
  if (start < 1) throw new VBRuntimeError(5);
  const hay = bytesOf(toStr(h));
  const needle = bytesOf(toStr(n));
  if (start > hay.length) return 0;
  if (needle.length === 0) return start;
  for (let i = start - 1; i + needle.length <= hay.length; i++) {
    let k = 0;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return i + 1;
  }
  return 0;
});
def('AscB', 1, 1, a => {
  const s = toStr(a[0]);
  if (s === '') throw new VBRuntimeError(5);
  return s.charCodeAt(0) & 0xff;
});
def('ChrB', 1, 1, a => {
  const n = intArg(a[0]);
  if (n < 0 || n > 255) throw new VBRuntimeError(5);
  return String.fromCharCode(n);
});

// ---- Partition ----

/**
 * Partition(Number, Start, Stop, Interval): the range of `Interval` numbers from `Start` that Number is in, as
 * "lo:hi", both sides padded to the width of Stop + 1 (" 20: 29"); below Start "   : 19", above Stop " 200:    ".
 */
def('Partition', 4, 4, a => {
  if (a.some(v => isNullV(v))) return Null;
  const n = intArg(a[0]);
  const start = intArg(a[1]);
  const stop = intArg(a[2]);
  const interval = intArg(a[3]);
  if (start < 0 || stop <= start || interval < 1) throw new VBRuntimeError(5);
  const w = Math.max(String(stop + 1).length, String(start - 1).length);
  const pad = (v: number | string) => String(v).padStart(w, ' ');
  if (n < start) return `${pad('')}:${pad(start - 1)}`;
  if (n > stop) return `${pad(stop + 1)}:${pad('')}`;
  const lo = start + Math.floor((n - start) / interval) * interval;
  return `${pad(lo)}:${pad(Math.min(lo + interval - 1, stop))}`;
}, { num: true });
