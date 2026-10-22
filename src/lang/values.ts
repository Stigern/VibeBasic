// Value model for the VibeBasic interpreter: VBValue, singletons, arrays,
// records, conversion and comparison. Pure TypeScript, no DOM.

import type { VBTypeName } from './ast';
import type { VBObject } from './host';
import { VBRuntimeError } from './errors';

// ---------------------------------------------------------------------------
// Singletons and compound values
// ---------------------------------------------------------------------------

export class EmptyT { readonly kind = 'empty' as const; toString() { return 'Empty'; } }
export class NullT { readonly kind = 'null' as const; toString() { return 'Null'; } }
export class NothingT { readonly kind = 'nothing' as const; toString() { return 'Nothing'; } }
export const Empty = new EmptyT();
export const Null = new NullT();
export const Nothing = new NothingT();

/** OLE date: `serial` is days since 1899-12-30, the fraction is the time of day. */
export interface VBDate { kind: 'date'; serial: number }

export type VBValue =
  | number | string | boolean | VBDate | VBArray | VBRecord | VBObject | EmptyT | NullT | NothingT;

/** A by-reference slot (ByRef arguments, event arguments). */
export class VBRef {
  constructor(public value: VBValue) {}
}

/** A user-defined type instance (`Type ... End Type`). Keys are the interpreter's choice. */
export class VBRecord {
  constructor(public typeName: string, public fields: Map<string, VBValue>) {}

  /** Deep copy (records have value semantics). */
  clone(): VBRecord {
    const f = new Map<string, VBValue>();
    for (const [k, v] of this.fields) f.set(k, cloneValue(v));
    return new VBRecord(this.typeName, f);
  }
}

function cloneValue(v: VBValue): VBValue {
  return v instanceof VBRecord || v instanceof VBArray ? v.clone() : v;
}

/**
 * A VB array. `fixed` is true for `Dim a(10)` (cannot be ReDim'd, error 10);
 * the interpreter passes `true` for those and leaves it false for `Dim a()`.
 * `init` makes the value of a fresh element (default: `defaultValue(elemType)`);
 * pass a factory for arrays of user types so each cell gets its own record.
 * A dimension with `hi = lo - 1` is allowed and empty (like `Array()`).
 * `VBArray.unallocated()` makes a dynamic array before its first `ReDim`
 * (`Dim a()`): it has no dimensions and every access is error 9.
 * More than `MAX_ARRAY_ELEMENTS` elements is error 7 (Out of memory).
 */
export class VBArray {
  bounds: [lo: number, hi: number][];
  private data: VBValue[] = [];

  constructor(
    public elemType: VBTypeName,
    bounds: [number, number][],
    public fixed = false,
    private init: () => VBValue = () => defaultValue(elemType),
  ) {
    this.bounds = bounds.length === 0 && unallocating ? [] : checkBounds(bounds);
    this.data = this.bounds.length === 0 ? [] : this.fresh(this.bounds);
  }

  /** A dynamic array that has not been `ReDim`'d yet (`Dim a() As T`). */
  static unallocated(elemType: VBTypeName, init?: () => VBValue): VBArray {
    unallocating = true;
    try {
      return new VBArray(elemType, [], false, init);
    } finally {
      unallocating = false;
    }
  }

  /** False for a dynamic array before its first `ReDim` (and after `Erase`). */
  get allocated(): boolean { return this.bounds.length > 0; }

  /** Total number of elements. */
  get size(): number { return this.bounds.length === 0 ? 0 : sizeOf(this.bounds); }

  /** All elements in storage order (last index varies fastest). */
  values(): VBValue[] { return this.data.slice(); }

  get(idx: number[]): VBValue { return this.data[this.offset(idx)]; }

  /** Stores `v` after coercing it to the element type. */
  set(idx: number[], v: VBValue): void {
    this.data[this.offset(idx)] = coerce(v, this.elemType);
  }

  /**
   * ReDim. A fixed array gives error 10. With `preserve` only the last
   * dimension may change (same dimension count, same lower bound there),
   * otherwise error 9; existing elements that still fit are kept.
   */
  redim(bounds: [number, number][], preserve: boolean): void {
    if (this.fixed) throw new VBRuntimeError(10);
    const nb = checkBounds(bounds);
    const next = this.fresh(nb);
    if (preserve) {
      const last = nb.length - 1;
      const ok = nb.length === this.bounds.length
        && nb.every((b, i) => i === last ? b[0] === this.bounds[i][0] : b[0] === this.bounds[i][0] && b[1] === this.bounds[i][1]);
      if (!ok && this.bounds.length > 0) throw new VBRuntimeError(9);
      const old = this.bounds;
      for (let flat = 0; flat < this.data.length; flat++) {
        // decompose the old flat offset into indexes, then re-place it in `next`
        const idx: number[] = new Array(old.length);
        let rest = flat;
        for (let d = old.length - 1; d >= 0; d--) {
          const n = old[d][1] - old[d][0] + 1;
          idx[d] = old[d][0] + (rest % n);
          rest = Math.floor(rest / n);
        }
        if (idx[last] > nb[last][1]) continue;
        next[offsetIn(nb, idx)] = this.data[flat];
      }
    }
    this.bounds = nb;
    this.data = next;
  }

  /** Deep copy. */
  clone(): VBArray {
    const c = this.bounds.length === 0
      ? VBArray.unallocated(this.elemType, this.init)
      : new VBArray(this.elemType, this.bounds.map(b => [b[0], b[1]] as [number, number]), this.fixed, this.init);
    c.data = this.data.map(cloneValue);
    return c;
  }

  private fresh(b: [number, number][]): VBValue[] {
    const n = sizeOf(b);
    const out: VBValue[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.init();
    return out;
  }

  private offset(idx: number[]): number { return offsetIn(this.bounds, idx); }
}

/** Set while `VBArray.unallocated` runs, so the constructor accepts zero dimensions. */
let unallocating = false;

/** Arrays larger than this (2^26 elements) are error 7, Out of memory. */
export const MAX_ARRAY_ELEMENTS = 2 ** 26;

/** Bounds are rounded like `CLng` (banker's rounding); more than `MAX_ARRAY_ELEMENTS` elements is error 7. */
function checkBounds(bounds: [number, number][]): [number, number][] {
  if (bounds.length === 0) throw new VBRuntimeError(9);
  const out = bounds.map(([lo, hi]) => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new VBRuntimeError(6);
    const l = bankers(lo);
    const h = bankers(hi);
    if (h < l - 1) throw new VBRuntimeError(9);
    return [l, h] as [number, number];
  });
  if (sizeOf(out) > MAX_ARRAY_ELEMENTS) throw new VBRuntimeError(7);
  return out;
}

function sizeOf(b: [number, number][]): number {
  let n = 1;
  for (const [lo, hi] of b) n *= hi - lo + 1;
  return n;
}

function offsetIn(bounds: [number, number][], idx: number[]): number {
  if (idx.length !== bounds.length || bounds.length === 0) throw new VBRuntimeError(9);
  let off = 0;
  for (let d = 0; d < bounds.length; d++) {
    const i = bankers(idx[d]);
    const [lo, hi] = bounds[d];
    if (!(i >= lo && i <= hi)) throw new VBRuntimeError(9);
    off = off * (hi - lo + 1) + (i - lo);
  }
  return off;
}

// ---------------------------------------------------------------------------
// Type tests
// ---------------------------------------------------------------------------

export function isDate(v: VBValue): v is VBDate {
  return typeof v === 'object' && !(v instanceof EmptyT) && (v as VBDate).kind === 'date'
    && typeof (v as VBDate).serial === 'number';
}

function isObject(v: VBValue): v is VBObject {
  return typeof v === 'object' && !(v instanceof EmptyT) && !(v instanceof NullT) && !(v instanceof NothingT)
    && !(v instanceof VBArray) && !(v instanceof VBRecord) && !isDate(v);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** Round half to even (VB6 integer conversion). Never returns -0. */
export function bankers(n: number): number {
  const fl = Math.floor(n);
  const diff = n - fl;
  let r: number;
  if (diff < 0.5) r = fl;
  else if (diff > 0.5) r = fl + 1;
  else r = fl % 2 === 0 ? fl : fl + 1;
  return r === 0 ? 0 : r;
}

const SINGLE_MAX = 3.402823466e38;
const CURRENCY_MAX = 922337203685477.5807;

/** Parse VB numeric text: spaces around, `&H`/`&O`, `.` decimal. `undefined` if not numeric. */
function parseNumber(text: string): number | undefined {
  const s = text.trim();
  if (s === '') return undefined;
  const m = /^&([HhOo])([0-9A-Fa-f]+)(&?)$/.exec(s);
  if (m) {
    const hex = m[1].toLowerCase() === 'h';
    if (!(hex ? /^[0-9A-Fa-f]+$/ : /^[0-7]+$/).test(m[2])) return undefined;
    const v = parseInt(m[2], hex ? 16 : 8);
    if (v > 0xFFFFFFFF) return undefined;
    if (m[3] === '' && v <= 0xFFFF) return v >= 0x8000 ? v - 0x10000 : v; // Integer literal
    return v >= 0x80000000 ? v - 0x100000000 : v; // Long literal
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return undefined;
  return Number(s);
}

/** Follow an object's default member to a plain value; Nothing is error 91. */
function resolve(v: VBValue): VBValue {
  if (v instanceof NothingT) throw new VBRuntimeError(91);
  if (isObject(v)) {
    if (v.defaultMember === undefined) throw new VBRuntimeError(13);
    return resolve(v.getMember(v.defaultMember, []));
  }
  return v;
}

export function toNumber(v: VBValue): number {
  v = resolve(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? -1 : 0;
  if (typeof v === 'string') {
    const n = parseNumber(v);
    if (n === undefined) throw new VBRuntimeError(13);
    if (!Number.isFinite(n)) throw new VBRuntimeError(6);
    return n;
  }
  if (v instanceof EmptyT) return 0;
  if (v instanceof NullT) throw new VBRuntimeError(94);
  if (isDate(v)) return v.serial;
  throw new VBRuntimeError(13);
}

/** CStr of a Double: up to 15 significant digits, no leading space, VB-style exponent. */
function numberToStr(n: number): string {
  if (!Number.isFinite(n)) throw new VBRuntimeError(6);
  if (n === 0) return '0';
  const neg = n < 0;
  const [mant, expStr] = Math.abs(n).toExponential(14).split('e');
  const e = Number(expStr);
  const digits = mant.replace('.', '').replace(/0+$/, '') || '0';
  let out: string;
  if (e >= -4 && e < 15) {
    if (e >= 0) {
      const padded = digits.padEnd(e + 1, '0');
      const frac = padded.slice(e + 1);
      out = padded.slice(0, e + 1) + (frac ? '.' + frac : '');
    } else {
      out = '0.' + '0'.repeat(-e - 1) + digits;
    }
  } else {
    out = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '')
      + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
  }
  return neg ? '-' + out : out;
}

export function toStr(v: VBValue): string {
  v = resolve(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberToStr(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof EmptyT) return '';
  if (v instanceof NullT) throw new VBRuntimeError(94);
  if (isDate(v)) return dateToText(v);
  throw new VBRuntimeError(13);
}

export function toBool(v: VBValue): boolean {
  v = resolve(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return toNumber(v) !== 0;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const OLE_EPOCH_DAYS = 25569; // serial of 1970-01-01
const DAY_MS = 86400000;

/**
 * Build a date from calendar parts (months/days/time may overflow and roll
 * over). Before 1899-12-30 the time fraction counts away from zero, as in OLE.
 */
export function dateFrom(y: number, m: number, d: number, h = 0, n = 0, s = 0): VBDate {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d); // setUTCFullYear keeps years 0-99 as-is
  dt.setUTCHours(0, 0, 0, 0);
  const days = Math.round(dt.getTime() / DAY_MS) + OLE_EPOCH_DAYS;
  const frac = (h * 3600 + n * 60 + s) / 86400;
  return { kind: 'date', serial: days < 0 ? days - frac : days + frac };
}

/** Split a serial into calendar parts (inverse of `dateFrom`). */
export function dateParts(serial: number): { y: number; m: number; d: number; h: number; n: number; s: number } {
  let days = serial < 0 ? Math.ceil(serial) : Math.floor(serial);
  let secs = Math.round(Math.abs(serial - days) * 86400);
  if (secs >= 86400) { secs -= 86400; days += serial < 0 ? -1 : 1; }
  const dt = new Date((days - OLE_EPOCH_DAYS) * DAY_MS);
  return {
    y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
    h: Math.floor(secs / 3600), n: Math.floor((secs % 3600) / 60), s: secs % 60,
  };
}

/**
 * How `toStr` (CStr, `&`, Print) turns a date into text. The default is a
 * locale-free ISO-like text; `Program` installs the locale-based General Date
 * formatter (builtins/format.ts) with `setDateTextFormatter`. Global, so the
 * most recently created Program's locale wins.
 */
let dateToText: (v: VBDate) => string = v => dateToPlaceholder(v);
export function setDateTextFormatter(fn: ((v: VBDate) => string) | undefined): void {
  dateToText = fn ?? (v => dateToPlaceholder(v));
}

/** Locale-free text for a date (the default for `toStr`). */
function dateToPlaceholder(v: VBDate): string {
  const p = dateParts(v.serial);
  const p2 = (x: number) => String(x).padStart(2, '0');
  const date = `${String(p.y).padStart(4, '0')}-${p2(p.m)}-${p2(p.d)}`;
  return p.h || p.n || p.s ? `${date} ${p2(p.h)}:${p2(p.n)}:${p2(p.s)}` : date;
}

/** Minimal text-to-date: a number, `yyyy-mm-dd[ hh:nn[:ss]]` or `m/d/yyyy[ hh:nn[:ss]]`. */
function parseDate(text: string): VBDate | undefined {
  const s = text.trim();
  const num = parseNumber(s);
  if (num !== undefined) return { kind: 'date', serial: num };
  const t = String.raw`(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?`;
  let y: number, m: number, d: number, rest: string[];
  let mm = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})${t}$`).exec(s);
  if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; rest = mm.slice(4); }
  else {
    mm = new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${t}$`).exec(s);
    if (!mm) return undefined;
    m = +mm[1]; d = +mm[2]; y = +mm[3]; rest = mm.slice(4);
  }
  const [h, n, sec] = rest.map(x => (x === undefined ? 0 : +x));
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || n > 59 || sec > 59) return undefined;
  const out = dateFrom(y, m, d, h, n, sec);
  return dateParts(out.serial).d === d ? out : undefined; // reject Feb 30 etc.
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** toNumber that also rejects NaN/Infinity (overflow). */
function finite(v: VBValue): number {
  const n = toNumber(v);
  if (!Number.isFinite(n)) throw new VBRuntimeError(6);
  return n;
}

function intInRange(v: VBValue, lo: number, hi: number): number {
  const n = bankers(finite(v));
  if (n < lo || n > hi) throw new VBRuntimeError(6);
  return n;
}

/** Convert `v` for assignment to a variable of type `t` (error 6 overflow, 13 mismatch, 94 Null). */
export function coerce(v: VBValue, t: VBTypeName): VBValue {
  if (typeof t === 'object') {
    if ('userType' in t) {
      if (v instanceof VBRecord && v.typeName.toLowerCase() === t.userType.toLowerCase()) return v;
      throw new VBRuntimeError(13);
    }
    return coerceObject(v);
  }
  switch (t) {
    case 'Variant': return v;
    case 'Object': return coerceObject(v);
    case 'Integer': return intInRange(v, -32768, 32767);
    case 'Long': return intInRange(v, -2147483648, 2147483647);
    case 'Byte': return intInRange(v, 0, 255);
    case 'Single': {
      const n = finite(v);
      if (Math.abs(n) > SINGLE_MAX) throw new VBRuntimeError(6);
      return n;
    }
    case 'Double': return finite(v);
    case 'Currency': {
      const n = Number((finite(v) * 10000).toPrecision(15));
      const r = bankers(n) / 10000;
      if (Math.abs(r) > CURRENCY_MAX) throw new VBRuntimeError(6);
      return r;
    }
    case 'String': return toStr(v);
    case 'Boolean': return toBool(v);
    case 'Date': {
      if (isDate(v)) return v;
      if (typeof v === 'string') {
        const d = parseDate(v);
        if (!d) throw new VBRuntimeError(13);
        return d;
      }
      return { kind: 'date', serial: toNumber(v) };
    }
  }
}

function coerceObject(v: VBValue): VBValue {
  if (v instanceof NothingT || isObject(v)) return v;
  throw new VBRuntimeError(13);
}

export function defaultValue(t: VBTypeName): VBValue {
  if (typeof t === 'object') {
    return 'userType' in t ? new VBRecord(t.userType, new Map()) : Nothing;
  }
  switch (t) {
    case 'Integer': case 'Long': case 'Single': case 'Double': case 'Currency': case 'Byte': return 0;
    case 'String': return '';
    case 'Boolean': return false;
    case 'Date': return { kind: 'date', serial: 0 };
    case 'Object': return Nothing;
    case 'Variant': return Empty;
  }
}

/** `TypeName()` of a value. Numbers carry no declared type: whole numbers report Integer/Long, others Double. */
export function vbTypeName(v: VBValue): string {
  if (v instanceof EmptyT) return 'Empty';
  if (v instanceof NullT) return 'Null';
  if (v instanceof NothingT) return 'Nothing';
  if (typeof v === 'string') return 'String';
  if (typeof v === 'boolean') return 'Boolean';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      if (v >= -32768 && v <= 32767) return 'Integer';
      if (v >= -2147483648 && v <= 2147483647) return 'Long';
    }
    return 'Double';
  }
  if (v instanceof VBArray) {
    const e = v.elemType;
    return (typeof e === 'string' ? e : 'userType' in e ? e.userType : e.objectType) + '()';
  }
  if (v instanceof VBRecord) return v.typeName;
  if (isDate(v)) return 'Date';
  return v.vbTypeName;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const cmp = <T extends number | string>(a: T, b: T): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

/**
 * VB comparison. Two strings compare as text (case-insensitive in
 * `textMode`); Empty counts as "" next to a string and 0 next to a number;
 * a number against a numeric string compares numerically, against a
 * non-numeric string the number is the smaller. Null is error 94.
 */
export function compare(a: VBValue, b: VBValue, textMode = false): -1 | 0 | 1 {
  a = resolve(a);
  b = resolve(b);
  if (a instanceof NullT || b instanceof NullT) throw new VBRuntimeError(94);
  const aS = typeof a === 'string';
  const bS = typeof b === 'string';
  if (aS || bS) {
    if ((aS || a instanceof EmptyT) && (bS || b instanceof EmptyT)) {
      let x = aS ? (a as string) : '';
      let y = bS ? (b as string) : '';
      if (textMode) { x = x.toLowerCase(); y = y.toLowerCase(); }
      return cmp(x, y);
    }
    if (aS) {
      const n = parseNumber(a as string);
      return n === undefined ? 1 : cmp(n, toNumber(b));
    }
    const n = parseNumber(b as string);
    return n === undefined ? -1 : cmp(toNumber(a), n);
  }
  return cmp(toNumber(a), toNumber(b));
}
