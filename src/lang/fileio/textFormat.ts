// Text of sequential files: the byte codec (Windows-1252 like VB6, UTF-8 read when the file is UTF-8), Write #
// items, and the fields of Input # and lines of Line Input #.

import { asc1252, chr1252 } from '../builtins/strings';
import { VBRuntimeError } from '../errors';
import { printItemText, printNumber } from '../printFormat';
import { Empty, EmptyT, Null, NullT, VBErrorValue, dateFrom, dateParts, isDate, isObject, type VBValue } from '../values';

// ---- codec ----

/** Windows-1252 bytes of `s` (a character it cannot hold is `?`, as VB6 writes it). */
export function encode1252(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 0x80 ? c : asc1252(s[i]);
  }
  return out;
}

/** Windows-1252 text of bytes. */
export function decode1252(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x2000) {
    const part = b.subarray(i, i + 0x2000);
    let chunk = '';
    for (const x of part) chunk += x < 0x80 ? String.fromCharCode(x) : chr1252(x);
    s += chunk;
  }
  return s;
}

/**
 * Text of a sequential file: UTF-8 when it starts with a UTF-8 BOM or is valid UTF-8 with non-ASCII bytes (a file made
 * on the Mac), else Windows-1252 (a file VB6 or this program wrote). Pure ASCII is the same either way.
 */
export function decodeText(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b.some(x => x >= 0x80)) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* not UTF-8 */ }
  }
  return decode1252(b);
}

// ---- Write # ----

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `#2000-01-31 13:05:00#`; only the date when there is no time, only the time when the date is 1899-12-30 (serial 0). */
function writeDate(serial: number): string {
  const p = dateParts(serial);
  const date = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  const time = `${pad2(p.h)}:${pad2(p.n)}:${pad2(p.s)}`;
  const hasTime = p.h !== 0 || p.n !== 0 || p.s !== 0;
  if (Math.trunc(serial) === 0 && hasTime) return `#${time}#`;
  return hasTime ? `#${date} ${time}#` : `#${date}#`;
}

/** One Write # item: strings in quotes, numbers without spaces, #TRUE#, #NULL#, dates as #yyyy-mm-dd hh:mm:ss#, Empty as nothing. */
export function writeItemText(v: VBValue): string {
  if (isObject(v)) {
    if (v.defaultMember === undefined) throw new VBRuntimeError(438);
    return writeItemText(v.getMember(v.defaultMember, []));
  }
  if (typeof v === 'number') return printNumber(v).trim();
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean') return v ? '#TRUE#' : '#FALSE#';
  if (v instanceof NullT) return '#NULL#';
  if (v instanceof EmptyT) return '';
  if (isDate(v)) return writeDate(v.serial);
  if (v instanceof VBErrorValue) return `#ERROR ${v.code}#`;
  return printItemText(v);
}

// ---- Input # and Line Input # ----

/** A field of Input #: `value` as VB6 reads it into a Variant, `text` as it reads it into a String. */
export interface InputField { value: VBValue; text: string }

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Text read sequentially from an Input file, with a position. */
export class TextReader {
  pos = 0;
  constructor(readonly text: string) {}

  get eof(): boolean { return this.pos >= this.text.length; }

  /** Line Input #: up to CR, LF or CRLF (not included). 62 at the end of the file. */
  line(): string {
    const t = this.text;
    if (this.pos >= t.length) throw new VBRuntimeError(62);
    let e = this.pos;
    while (e < t.length && t[e] !== '\r' && t[e] !== '\n') e++;
    const s = t.slice(this.pos, e);
    this.pos = this.skipBreak(e);
    return s;
  }

  /** Input(n, #f): the next n characters, line breaks included. 62 when fewer are left. */
  chars(n: number): string {
    if (this.pos + n > this.text.length) throw new VBRuntimeError(62);
    const s = this.text.slice(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  private skipBreak(p: number): number {
    const t = this.text;
    if (t[p] === '\r') return t[p + 1] === '\n' ? p + 2 : p + 1;
    return t[p] === '\n' ? p + 1 : p;
  }

  /** After a field: blanks, then the `,` or the line break that ends it. */
  private endField(p: number): number {
    const t = this.text;
    while (p < t.length && t[p] !== ',' && t[p] !== '\r' && t[p] !== '\n') p++;
    return t[p] === ',' ? p + 1 : this.skipBreak(p);
  }

  /**
   * Input #: the next comma- or line-separated field. 62 at the end of the file. An unquoted number read into a numeric
   * variable (`numeric` 'yes'), or into a Variant (`'auto'`, when the text there is a number), also ends at a space or
   * tab, so `Print #1, 1; 2; 3` (" 1  2  3 ") reads back as three fields.
   */
  field(numeric: 'yes' | 'no' | 'auto' = 'no'): InputField {
    const t = this.text;
    let p = this.pos;
    while (p < t.length && (t[p] === ' ' || t[p] === '\t')) p++;
    if (p >= t.length) throw new VBRuntimeError(62);
    if (t[p] === '"') {
      const close = t.indexOf('"', p + 1);
      const end = close < 0 ? t.length : close;
      const s = t.slice(p + 1, end);
      this.pos = this.endField(Math.min(t.length, end + 1));
      return { value: s, text: s };
    }
    if (t[p] === '#') {
      const close = t.indexOf('#', p + 1);
      if (close > 0) {
        const inner = t.slice(p + 1, close);
        const special = hashValue(inner);
        if (special !== undefined) {
          this.pos = this.endField(close + 1);
          return { value: special, text: typeof special === 'boolean' ? (special ? 'True' : 'False') : t.slice(p, close + 1) };
        }
      }
    }
    let e = p;
    if (numeric !== 'no') {
      while (e < t.length && t[e] !== ',' && t[e] !== '\r' && t[e] !== '\n' && t[e] !== ' ' && t[e] !== '\t') e++;
      const word = t.slice(p, e);
      if (word !== '' && (numeric === 'yes' || NUMBER.test(word))) {
        // after the number: blanks, then at most one comma or the line break
        let q = e;
        while (q < t.length && (t[q] === ' ' || t[q] === '\t')) q++;
        this.pos = t[q] === ',' ? q + 1 : this.skipBreak(q);
        return { value: NUMBER.test(word) ? Number(word) : word, text: word };
      }
      e = p;
    }
    while (e < t.length && t[e] !== ',' && t[e] !== '\r' && t[e] !== '\n') e++;
    const raw = t.slice(p, e).replace(/[ \t]+$/, '');
    this.pos = t[e] === ',' ? e + 1 : this.skipBreak(e);
    if (raw === '') return { value: Empty, text: '' };
    return { value: NUMBER.test(raw) ? Number(raw) : raw, text: raw };
  }
}

/** The inside of `#...#` in a Write # file: TRUE, FALSE, NULL, ERROR n, a date or a time; undefined otherwise. */
function hashValue(inner: string): VBValue | undefined {
  const s = inner.trim().toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  if (s === 'NULL') return Null;
  const err = /^ERROR\s+(\d+)$/.exec(s);
  if (err) return new VBErrorValue(+err[1]);
  const m = /^(?:(\d{4})-(\d{1,2})-(\d{1,2}))?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m && (m[1] || m[4])) {
    return m[1]
      ? dateFrom(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
      : dateFrom(1899, 12, 30, +m[4], +m[5], +(m[6] ?? 0));
  }
  return undefined;
}
