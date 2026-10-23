// Get / Put layouts of Binary and Random files, as VB6 writes them (little-endian, no padding):
// Byte 1, Boolean and Integer 2, Long and Single 4, Double, Date and Currency 8 bytes; a fixed-length string its length;
// a variable-length string its characters (Binary, top level) or a 2-byte length and its characters (Random, and inside a
// user type); a Variant a 2-byte VarType and its data; a user type its fields in order; a fixed array its elements
// (first index fastest), a dynamic array first a descriptor (2-byte dimension count, then a 4-byte count and a 4-byte
// lower bound per dimension). Strings are Windows-1252 bytes.

import type { VBTypeName } from '../ast';
import { VBRuntimeError } from '../errors';
import type { TypeInfo } from '../interp/scope';
import {
  Empty, EmptyT, Null, NullT, VBArray, VBRecord, bankers, isDate, toBool, toNumber, toStr, vbTypeName, type VBValue,
} from '../values';
import { decode1252, encode1252 } from './textFormat';

/** What a layout needs from the interpreter: user types and fresh values. */
export interface TypeSource {
  typeInfo(name: string): TypeInfo;
  newRecord(typeName: string): VBRecord;
  defaultFor(t: VBTypeName, fixedLength?: number): VBValue;
}

/** Where a value is: at the top level of a Get/Put (`nested` false) or inside a user type or array. */
interface Ctx { random: boolean; types: TypeSource }

export class ByteWriter {
  private buf = new Uint8Array(64);
  length = 0;
  private dv = new DataView(this.buf.buffer);

  private room(n: number): number {
    if (this.length + n > this.buf.length) {
      const b = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
      b.set(this.buf.subarray(0, this.length));
      this.buf = b;
      this.dv = new DataView(b.buffer);
    }
    const at = this.length;
    this.length += n;
    return at;
  }
  u8(n: number): void { this.dv.setUint8(this.room(1), n & 0xff); }
  i16(n: number): void { this.dv.setInt16(this.room(2), n, true); }
  i32(n: number): void { this.dv.setInt32(this.room(4), n, true); }
  f32(n: number): void { this.dv.setFloat32(this.room(4), n, true); }
  f64(n: number): void { this.dv.setFloat64(this.room(8), n, true); }
  i64(n: bigint): void { this.dv.setBigInt64(this.room(8), n, true); }
  bytes(b: Uint8Array): void { const at = this.room(b.length); this.buf.set(b, at); }
  result(): Uint8Array { return this.buf.slice(0, this.length); }
}

/** Thrown when a Binary Get needs more bytes than were fetched (the caller fetches more and decodes again). */
export class NeedMore {
  constructor(readonly upTo: number) {}
}

/**
 * Reads a record. Past the end of `data`: `more` → NeedMore (fetch further); otherwise zeros and `short` is set (the end
 * of the file: EOF). Past `limit` (a Random record's length): error 59, Bad record length.
 */
export class ByteReader {
  pos = 0;
  short = false;
  private dv: DataView;
  constructor(private data: Uint8Array, private limit = Infinity, private more = false) {
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  private take(n: number): number {
    const at = this.pos;
    if (at + n > this.limit) throw new VBRuntimeError(59);
    if (at + n > this.data.length) {
      if (this.more) throw new NeedMore(at + n);
      this.short = true;
    }
    this.pos += n;
    return at;
  }
  private avail(at: number, n: number): boolean { return at + n <= this.data.length; }
  u8(): number { const at = this.take(1); return this.avail(at, 1) ? this.dv.getUint8(at) : 0; }
  i16(): number { const at = this.take(2); return this.avail(at, 2) ? this.dv.getInt16(at, true) : 0; }
  i32(): number { const at = this.take(4); return this.avail(at, 4) ? this.dv.getInt32(at, true) : 0; }
  f32(): number { const at = this.take(4); return this.avail(at, 4) ? this.dv.getFloat32(at, true) : 0; }
  f64(): number { const at = this.take(8); return this.avail(at, 8) ? this.dv.getFloat64(at, true) : 0; }
  i64(): bigint { const at = this.take(8); return this.avail(at, 8) ? this.dv.getBigInt64(at, true) : 0n; }
  bytes(n: number): Uint8Array {
    const at = this.take(n);
    const out = new Uint8Array(n);
    out.set(this.data.subarray(at, Math.min(at + n, this.data.length)));
    return out;
  }
}

const fitFixed = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s.padEnd(n, ' '));

/** Calls `fn` with every index of `bounds`, first index fastest (VB6 file order). */
function eachIndex(bounds: [number, number][], fn: (idx: number[]) => void): void {
  if (bounds.some(([lo, hi]) => hi < lo)) return;
  const idx = bounds.map(b => b[0]);
  for (;;) {
    fn(idx);
    let d = 0;
    for (; d < bounds.length; d++) {
      if (idx[d] < bounds[d][1]) { idx[d]++; break; }
      idx[d] = bounds[d][0];
    }
    if (d === bounds.length) return;
  }
}

// ---- Put ----

/** VarType numbers of a Variant's tag. */
const VT = { empty: 0, null: 1, integer: 2, long: 3, single: 4, double: 5, currency: 6, date: 7, string: 8, boolean: 11, byte: 17 };

function putString(w: ByteWriter, s: string, withLength: boolean): void {
  if (withLength) {
    if (s.length > 0xffff) throw new VBRuntimeError(59);
    w.i16(s.length > 0x7fff ? s.length - 0x10000 : s.length);
  }
  w.bytes(encode1252(s));
}

function putVariant(w: ByteWriter, v: VBValue): void {
  if (v instanceof EmptyT) { w.i16(VT.empty); return; }
  if (v instanceof NullT) { w.i16(VT.null); return; }
  if (typeof v === 'string') { w.i16(VT.string); putString(w, v, true); return; }
  if (typeof v === 'boolean') { w.i16(VT.boolean); w.i16(v ? -1 : 0); return; }
  if (isDate(v)) { w.i16(VT.date); w.f64(v.serial); return; }
  if (typeof v === 'number') {
    const t = vbTypeName(v);
    if (t === 'Integer') { w.i16(VT.integer); w.i16(v); } else if (t === 'Long') { w.i16(VT.long); w.i32(v); } else { w.i16(VT.double); w.f64(v); }
    return;
  }
  throw new VBRuntimeError(13);
}

function putArray(w: ByteWriter, a: VBArray, elem: VBTypeName, fixedLength: number | undefined, c: Ctx): void {
  if (!a.fixed) {
    w.i16(a.bounds.length);
    for (const [lo, hi] of a.bounds) { w.i32(hi - lo + 1); w.i32(lo); }
  }
  eachIndex(a.bounds, idx => putValue(w, a.get(idx), elem, fixedLength, c, true));
}

function putValue(w: ByteWriter, v: VBValue, t: VBTypeName, fixedLength: number | undefined, c: Ctx, nested: boolean): void {
  if (v instanceof VBArray) { putArray(w, v, v.elemType, fixedLength, c); return; }
  if (typeof t === 'object') {
    if (!('userType' in t) || !(v instanceof VBRecord)) throw new VBRuntimeError(13);
    const info = c.types.typeInfo(t.userType);
    for (const [key, fi] of info.fields) {
      const fv = v.fields.get(key) ?? Empty;
      if (fv instanceof VBArray) putArray(w, fv, fi.type, fi.fixedLength, c);
      else putValue(w, fv, fi.type, fi.fixedLength, c, true);
    }
    return;
  }
  switch (t) {
    case 'Byte': w.u8(bankers(toNumber(v))); return;
    case 'Boolean': w.i16(toBool(v) ? -1 : 0); return;
    case 'Integer': w.i16(bankers(toNumber(v))); return;
    case 'Long': w.i32(bankers(toNumber(v))); return;
    case 'Single': w.f32(toNumber(v)); return;
    case 'Double': w.f64(toNumber(v)); return;
    case 'Date': w.f64(isDate(v) ? v.serial : toNumber(v)); return;
    case 'Currency': w.i64(BigInt(Math.round(toNumber(v) * 10000))); return;
    case 'String':
      if (fixedLength !== undefined) w.bytes(encode1252(fitFixed(toStr(v), fixedLength)));
      else putString(w, toStr(v), c.random || nested);
      return;
    case 'Variant': putVariant(w, v); return;
    default: throw new VBRuntimeError(13);
  }
}

/** The bytes Put writes for `v`, declared as `t` (`String * fixedLength`). */
export function encodeRecord(v: VBValue, t: VBTypeName, fixedLength: number | undefined, random: boolean, types: TypeSource): Uint8Array {
  const w = new ByteWriter();
  putValue(w, v, t, fixedLength, { random, types }, false);
  return w.result();
}

// ---- Get ----

function getString(r: ByteReader, n: number): string {
  return decode1252(r.bytes(n));
}

function getVariant(r: ByteReader): VBValue {
  const tag = r.i16();
  switch (tag) {
    case VT.empty: return Empty;
    case VT.null: return Null;
    case VT.integer: return r.i16();
    case VT.long: return r.i32();
    case VT.single: return r.f32();
    case VT.double: return r.f64();
    case VT.currency: return Number(r.i64()) / 10000;
    case VT.date: return { kind: 'date', serial: r.f64() };
    case VT.string: return getString(r, r.i16() & 0xffff);
    case VT.boolean: return r.i16() !== 0;
    case VT.byte: return r.u8();
  }
  if (r.short) return Empty;
  throw new VBRuntimeError(458, 'Variable uses an Automation type not supported in Visual Basic');
}

/** Reads into an array in place; a dynamic array is ReDim'd from its descriptor. */
function getArray(r: ByteReader, a: VBArray, elem: VBTypeName, fixedLength: number | undefined, c: Ctx): void {
  if (!a.fixed) {
    const dims = r.i16();
    if (dims > 0 && !r.short) {
      const bounds: [number, number][] = [];
      for (let d = 0; d < dims; d++) { const n = r.i32(); const lo = r.i32(); bounds.push([lo, lo + n - 1]); }
      if (!r.short) a.redim(bounds, false);
    }
  }
  eachIndex(a.bounds, idx => a.set(idx, getValue(r, a.get(idx), elem, fixedLength, c, true)));
}

function getValue(r: ByteReader, cur: VBValue, t: VBTypeName, fixedLength: number | undefined, c: Ctx, nested: boolean): VBValue {
  if (cur instanceof VBArray) { getArray(r, cur, cur.elemType, fixedLength, c); return cur; }
  if (typeof t === 'object') {
    if (!('userType' in t)) throw new VBRuntimeError(13);
    const rec = cur instanceof VBRecord ? cur : c.types.newRecord(t.userType);
    const info = c.types.typeInfo(t.userType);
    for (const [key, fi] of info.fields) {
      const fv = rec.fields.get(key) ?? c.types.defaultFor(fi.type, fi.fixedLength);
      if (fv instanceof VBArray) getArray(r, fv, fi.type, fi.fixedLength, c);
      else rec.fields.set(key, getValue(r, fv, fi.type, fi.fixedLength, c, true));
    }
    return rec;
  }
  switch (t) {
    case 'Byte': return r.u8();
    case 'Boolean': return r.i16() !== 0;
    case 'Integer': return r.i16();
    case 'Long': return r.i32();
    case 'Single': return r.f32();
    case 'Double': return r.f64();
    case 'Date': return { kind: 'date', serial: r.f64() };
    case 'Currency': return Number(r.i64()) / 10000;
    case 'String':
      if (fixedLength !== undefined) return getString(r, fixedLength);
      // Binary, top level: as many bytes as the variable's current length
      return getString(r, c.random || nested ? r.i16() & 0xffff : toStr(cur).length);
    case 'Variant': return getVariant(r);
    default: throw new VBRuntimeError(13);
  }
}

/** Decodes what Get reads into a target declared as `t` whose current value is `cur` (arrays and records are filled in place). */
export function decodeRecord(r: ByteReader, cur: VBValue, t: VBTypeName, fixedLength: number | undefined, random: boolean, types: TypeSource): VBValue {
  return getValue(r, cur, t, fixedLength, { random, types }, false);
}
