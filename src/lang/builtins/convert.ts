// Conversion and type-check built-ins: Str Val CStr CInt CLng CDbl CSng CCur
// CByte CBool CDate CVar, IsNumeric IsEmpty IsDate IsArray IsObject IsNull
// TypeName VarType.

import { VBRuntimeError } from '../errors';
import { plain, isObject } from '../interp/operators';
import { printNumber } from '../printFormat';
import {
  EmptyT, NothingT, NullT, VBArray, VBRecord, coerce, isDate, toNumber, toStr, vbTypeName,
  type VBValue,
} from '../values';
import { def } from './util';

// ---- Str / Val ----

def('Str', 1, 1, a => printNumber(toNumber(a[0])));

/** `Val`: the leading number in `text`, ignoring spaces; `&H`/`&O` prefixes; 0 if there is none. */
export function val(text: string): number {
  const s = text.replace(/[ \t\r\n]+/g, '');
  const radix = /^&([hHoO])([0-9a-fA-F]*)/.exec(s);
  if (radix) {
    const hex = radix[1].toLowerCase() === 'h';
    const digits = (hex ? /^[0-9a-fA-F]*/ : /^[0-7]*/).exec(radix[2])![0];
    if (digits === '') return 0;
    const v = parseInt(digits, hex ? 16 : 8);
    const small = hex ? digits.length <= 4 : v <= 0xffff;
    if (small) return v >= 0x8000 ? v - 0x10000 : v;
    const w = v % 0x100000000;
    return w >= 0x80000000 ? w - 0x100000000 : w;
  }
  const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?/.exec(s);
  if (!m) return 0;
  const n = Number(m[0].replace(/[dD]/, 'e'));
  if (!Number.isFinite(n)) throw new VBRuntimeError(6);
  return n;
}

def('Val', 1, 1, a => val(toStr(a[0])));

// ---- C-conversions ----

const conv = (name: string, type: Parameters<typeof coerce>[1]) => def(name, 1, 1, a => coerce(plain(a[0]), type));
conv('CInt', 'Integer');
conv('CLng', 'Long');
conv('CDbl', 'Double');
conv('CSng', 'Single');
conv('CCur', 'Currency');
conv('CByte', 'Byte');
conv('CBool', 'Boolean');
conv('CDate', 'Date');
conv('CStr', 'String');
def('CVar', 1, 1, a => plain(a[0]));

// ---- type checks ----

def('IsNull', 1, 1, a => plain(a[0]) instanceof NullT);
def('IsEmpty', 1, 1, a => plain(a[0]) instanceof EmptyT);
def('IsArray', 1, 1, a => a[0] instanceof VBArray);
def('IsObject', 1, 1, a => a[0] instanceof NothingT || isObject(a[0]));

def('IsNumeric', 1, 1, a => {
  const v = plain(a[0]);
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof EmptyT) return true;
  if (typeof v !== 'string') return false;
  try { toNumber(v); return true; } catch { return false; }
});

def('IsDate', 1, 1, a => {
  const v = plain(a[0]);
  if (isDate(v)) return true;
  if (typeof v !== 'string') return false;
  try { coerce(v, 'Date'); return true; } catch { return false; }
});

def('TypeName', 1, 1, a => vbTypeName(a[0]));

/** VarType code (vbEmpty 0 ... vbArray 8192). Numbers without a declared type: Integer, Long or Double. */
export function varType(v: VBValue): number {
  if (v instanceof EmptyT) return 0;
  if (v instanceof NullT) return 1;
  if (v instanceof NothingT) return 9;
  if (typeof v === 'string') return 8;
  if (typeof v === 'boolean') return 11;
  if (typeof v === 'number') {
    const t = vbTypeName(v);
    return t === 'Integer' ? 2 : t === 'Long' ? 3 : 5;
  }
  if (v instanceof VBArray) {
    const e = v.elemType;
    const code = typeof e === 'string'
      ? ({ Integer: 2, Long: 3, Single: 4, Double: 5, Currency: 6, Date: 7, String: 8, Object: 9, Boolean: 11, Variant: 12, Byte: 17 } as Record<string, number>)[e]
      : 'userType' in e ? 36 : 9;
    return 8192 + code;
  }
  if (v instanceof VBRecord) return 36;
  if (isDate(v)) return 7;
  return 9;
}

def('VarType', 1, 1, a => varType(a[0]));
