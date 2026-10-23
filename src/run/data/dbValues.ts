// Database values and VB values: the kind of a column (from its declared SQLite type), Field.Type numbers for DAO and ADO,
// and the conversions both ways. Dates are stored as ISO text ("2000-01-02" or "2000-01-02 13:45:00"), Booleans as 1 / 0.

import type { DbValue } from '../../backend/backend';
import { VBRuntimeError } from '../../lang/errors';
import {
  EmptyT, NullT, Null, VBArray, coerce, dateFrom, dateParts, isDate, isObject, toBool, toNumber, toStr, type VBDate, type VBValue,
} from '../../lang/values';

export type FieldKind = 'long' | 'double' | 'currency' | 'bool' | 'date' | 'text' | 'memo' | 'binary' | 'variant';

/** The kind of a column from its declared type ('' for an expression: the value decides). */
export function fieldKind(decl: string): FieldKind {
  const t = decl.toUpperCase();
  if (t === '') return 'variant';
  if (/BOOL|\bBIT\b|YESNO|LOGICAL/.test(t)) return 'bool';
  if (/DATE|TIME/.test(t)) return 'date';
  if (/CURRENCY|MONEY/.test(t)) return 'currency';
  if (/INT/.test(t)) return 'long';
  if (/MEMO|CLOB|LONGTEXT/.test(t)) return 'memo';
  if (/CHAR|TEXT|STRING/.test(t)) return 'text';
  if (/BLOB|BINARY|IMAGE|OLE/.test(t)) return 'binary';
  if (/REAL|FLOA|DOUB|NUM|DEC|SINGLE/.test(t)) return 'double';
  return 'variant';
}

const DAO_TYPES: Record<FieldKind, number> = { bool: 1, long: 4, currency: 5, double: 7, date: 8, text: 10, binary: 11, memo: 12, variant: 10 };
const ADO_TYPES: Record<FieldKind, number> = { bool: 11, long: 3, currency: 6, double: 5, date: 7, text: 202, binary: 205, memo: 203, variant: 12 };

/** Field.Type: dbText 10, dbLong 4 ... (DAO) or adVarWChar 202, adInteger 3 ... (ADO). */
export function fieldTypeNumber(kind: FieldKind, ado: boolean): number { return (ado ? ADO_TYPES : DAO_TYPES)[kind]; }

/** Field.Size / DefinedSize: VARCHAR(n) gives n, text 255, numbers their byte size. */
export function fieldSize(kind: FieldKind, decl: string): number {
  const m = /\((\d+)/.exec(decl);
  if (m && (kind === 'text' || kind === 'memo')) return Number(m[1]);
  return ({ bool: 1, long: 4, currency: 8, double: 8, date: 8, text: 255, binary: 0, memo: 0, variant: 0 } as Record<FieldKind, number>)[kind];
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** A date as stored: date only when there is no time, the time only when there is no date. */
export function dateText(d: VBDate): string {
  const p = dateParts(d.serial);
  const day = `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`, time = `${pad(p.h)}:${pad(p.n)}:${pad(p.s)}`;
  if (Number.isInteger(d.serial)) return day;
  if (Math.abs(d.serial) < 1) return time;
  return `${day} ${time}`;
}

/** ISO text ("2000-01-02", "2000-01-02 13:45:00", "2000-01-02T13:45", "13:45:00") as a date; undefined for anything else. */
export function parseDateText(s: string): VBDate | undefined {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (m) return dateFrom(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (m) return { kind: 'date', serial: (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) / 86400 };
  return undefined;
}

function bytesOf(b64: string): VBArray {
  const s = atob(b64);
  const a = new VBArray('Byte', [[0, s.length - 1]]);
  for (let i = 0; i < s.length; i++) a.set([i], s.charCodeAt(i));
  return a;
}

/** A database value as the VB value a Field gives. */
export function toVB(v: DbValue, kind: FieldKind): VBValue {
  if (v === null) return Null;
  if (typeof v === 'object') return bytesOf(v.blob);
  switch (kind) {
    case 'bool': return typeof v === 'number' ? v !== 0 : /^(true|yes|-?[1-9]\d*)$/i.test(v.trim());
    case 'date': {
      if (typeof v === 'number') return { kind: 'date', serial: v };
      return parseDateText(v) ?? v;
    }
    case 'long': case 'double': case 'currency': {
      if (typeof v === 'number') return v;
      const n = v.trim() === '' ? NaN : Number(v);
      return Number.isFinite(n) ? n : v;
    }
    case 'text': case 'memo': return typeof v === 'number' ? String(v) : v;
    default: return v;
  }
}

/** A VB value for a column of `kind` (Field.Value = x, bound controls). Error 3421 when it does not convert. */
export function toDb(v: VBValue, kind: FieldKind): DbValue {
  if (v instanceof NullT || v instanceof EmptyT || v === undefined) return null;
  if (isObject(v)) throw new VBRuntimeError(3421);
  if (v instanceof VBArray) {
    let s = '';
    const [lo, hi] = v.bounds[0] ?? [0, -1];
    for (let i = lo; i <= hi; i++) s += String.fromCharCode(toNumber(v.get([i])) & 255);
    return { blob: btoa(s) };
  }
  const blank = typeof v === 'string' && v.trim() === '';
  try {
    switch (kind) {
      case 'bool':
        if (blank) return null;
        return toBool(v) ? 1 : 0;
      case 'date': {
        if (blank) return null;
        if (typeof v === 'string') { const d = parseDateText(v); if (d) return dateText(d); }
        return dateText(coerce(v, 'Date') as VBDate);
      }
      case 'long': case 'double': case 'currency': {
        if (blank) return null;
        const n = typeof v === 'boolean' ? (v ? -1 : 0) : isDate(v) ? v.serial : toNumber(v);
        if (!Number.isFinite(n)) throw new VBRuntimeError(3421);
        return kind === 'long' ? coerce(n, 'Long') as number : kind === 'currency' ? coerce(n, 'Currency') as number : n;
      }
      case 'text': case 'memo': return toStr(v);
      default:
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (isDate(v)) return dateText(v);
        if (typeof v === 'number' || typeof v === 'string') return v;
        return toStr(v);
    }
  } catch (e) {
    if (e instanceof VBRuntimeError && e.number !== 3421) throw new VBRuntimeError(3421);
    throw e;
  }
}

/** Two database values hold the same thing (an edit that changes nothing is not written). */
export function sameDb(a: DbValue, b: DbValue): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  return a.blob === b.blob;
}

