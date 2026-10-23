// Conversion and type-check built-ins: Str Val CStr CInt CLng CDbl CSng CCur
// CByte CBool CDate CDec CVar CVErr, IsNumeric IsEmpty IsDate IsArray IsObject IsNull
// IsMissing IsError TypeName VarType.

import { VBRuntimeError } from '../errors';
import { plain } from '../interp/operators';
import { printNumber } from '../printFormat';
import {
  EmptyT, Missing, NothingT, NullT, VBArray, VBErrorValue, VBRecord, coerce, isDate, isObject, toNumber, toStr, vbTypeName,
  type VBValue,
} from '../values';
import { def, intArg } from './util';

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
  const m = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?/.exec(s);
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
/** CDec: VibeBasic has no Decimal type; the value is a Double (TypeName reports Decimal for the call itself). */
def('CDec', 1, 1, a => coerce(plain(a[0]), 'Double'));
/** CVErr(n): a Variant of subtype Error. */
def('CVErr', 1, 1, a => {
  const n = intArg(a[0]);
  if (n < 0 || n > 65535) throw new VBRuntimeError(5);
  return new VBErrorValue(n);
});

// ---- type checks ----

const raw = { raw: true };
def('IsNull', 1, 1, a => plain(a[0]) instanceof NullT, raw);
def('IsEmpty', 1, 1, a => plain(a[0]) instanceof EmptyT, raw);
def('IsArray', 1, 1, a => a[0] instanceof VBArray, raw);
def('IsObject', 1, 1, a => a[0] instanceof NothingT || isObject(a[0]), raw);
/** True for an Optional Variant parameter the caller left out (and that has no default). */
def('IsMissing', 1, 1, a => a[0] === Missing, raw);
def('IsError', 1, 1, a => a[0] instanceof VBErrorValue, raw);

def('IsNumeric', 1, 1, a => {
  const v = plain(a[0]);
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof EmptyT) return true;
  if (typeof v !== 'string') return false;
  try { toNumber(v); return true; } catch { return false; }
}, raw);

def('IsDate', 1, 1, a => {
  const v = plain(a[0]);
  if (isDate(v)) return true;
  if (typeof v !== 'string') return false;
  try { coerce(v, 'Date'); return true; } catch { return false; }
}, raw);

/** A number's type comes from the code when it is known there (`types`: a typed variable or expression), else from the value. */
const known = (a: VBValue[], types: (string | undefined)[] | undefined): string | undefined =>
  typeof a[0] === 'number' ? types?.[0] : undefined;

def('TypeName', 1, 1, (a, _ctx, types) => known(a, types) ?? vbTypeName(a[0]), { raw: true, types: true });

const VAR_TYPES: Record<string, number> = { Integer: 2, Long: 3, Single: 4, Double: 5, Currency: 6, Decimal: 14, Byte: 17 };

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
  if (v instanceof VBErrorValue) return 10;
  return 9;
}

def('VarType', 1, 1, (a, _ctx, types) => {
  const t = known(a, types);
  return t !== undefined ? VAR_TYPES[t] : varType(a[0]);
}, { raw: true, types: true });
