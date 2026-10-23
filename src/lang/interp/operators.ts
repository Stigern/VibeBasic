// VB operator semantics on values (no scopes, no generators).

import type { BinaryOp, UnaryOp } from '../ast';
import { VBRuntimeError } from '../errors';
import {
  EmptyT, Null, NullT, NothingT, coerce, compare, isDate, isObject, toBool, toNumber, toStr,
  type VBDate, type VBValue,
} from '../values';

/** A plain value: objects give their default member (no default member: 438); Nothing is error 91. */
export function plain(v: VBValue): VBValue {
  if (v instanceof NothingT) throw new VBRuntimeError(91);
  if (isObject(v)) {
    if (v.defaultMember === undefined) throw new VBRuntimeError(438);
    return plain(v.getMember(v.defaultMember, []));
  }
  return v;
}

/** Condition value of If/While/Do/Case: Null counts as False. */
export function truthy(v: VBValue): boolean {
  v = plain(v);
  if (v instanceof NullT) return false;
  return toBool(v);
}

/** CLng-style integer (banker's rounding, overflow 6), for `\`, Mod and the logical operators. */
function toLong(v: VBValue): number {
  return coerce(v, 'Long') as number;
}

const date = (serial: number): VBDate => ({ kind: 'date', serial });

function arith(op: BinaryOp, a: VBValue, b: VBValue): VBValue {
  switch (op) {
    case '+': {
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      if (a instanceof EmptyT && typeof b === 'string') return b;
      if (b instanceof EmptyT && typeof a === 'string') return a;
      const s = toNumber(a) + toNumber(b);
      return isDate(a) || isDate(b) ? date(s) : s;
    }
    case '-': {
      const s = toNumber(a) - toNumber(b);
      if (isDate(a) && isDate(b)) return s;
      return isDate(a) || isDate(b) ? date(s) : s;
    }
    case '*': return toNumber(a) * toNumber(b);
    case '/': {
      const x = toNumber(a);
      const y = toNumber(b);
      if (y === 0) throw new VBRuntimeError(x === 0 ? 6 : 11);
      return x / y;
    }
    case '\\': {
      const x = toLong(a);
      const y = toLong(b);
      if (y === 0) throw new VBRuntimeError(11);
      return Math.trunc(x / y) + 0;
    }
    case 'mod': {
      const x = toLong(a);
      const y = toLong(b);
      if (y === 0) throw new VBRuntimeError(11);
      return (x % y) + 0;
    }
    case '^': {
      const x = toNumber(a);
      const y = toNumber(b);
      if ((x < 0 && !Number.isInteger(y)) || (x === 0 && y < 0)) throw new VBRuntimeError(5);
      return Math.pow(x, y);
    }
  }
  throw new Error(`arith: ${op}`);
}

function isTrueValue(v: VBValue): boolean {
  return v === true || v === -1;
}

function isFalseValue(v: VBValue): boolean {
  return v === false || v === 0 || v instanceof EmptyT;
}

/** And/Or/Xor/Eqv/Imp with a Null operand (VB three-valued logic). */
function nullLogic(op: BinaryOp, a: VBValue, b: VBValue): VBValue {
  const aN = a instanceof NullT;
  const bN = b instanceof NullT;
  const other = aN ? b : a;
  switch (op) {
    case 'and': return !(aN && bN) && isFalseValue(other) ? other : Null;
    case 'or': return !(aN && bN) && isTrueValue(other) ? other : Null;
    case 'imp':
      if (aN && !bN && isTrueValue(b)) return b;
      if (bN && !aN && isFalseValue(a)) return typeof a === 'boolean' ? true : -1;
      return Null;
    default: return Null;
  }
}

function logic(op: BinaryOp, a: VBValue, b: VBValue): VBValue {
  if (a instanceof NullT || b instanceof NullT) return nullLogic(op, a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    switch (op) {
      case 'and': return a && b;
      case 'or': return a || b;
      case 'xor': return a !== b;
      case 'eqv': return a === b;
      case 'imp': return !a || b;
    }
  }
  const x = toLong(a);
  const y = toLong(b);
  switch (op) {
    case 'and': return x & y;
    case 'or': return x | y;
    case 'xor': return x ^ y;
    case 'eqv': return ~(x ^ y);
    case 'imp': return ~x | y;
  }
  throw new Error(`logic: ${op}`);
}

/** VB `Like` (binary compare): `*`, `?`, `#`, `[list]`, `[!list]`, ranges `a-z`. */
export function likeMatch(text: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '#') re += '[0-9]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) throw new VBRuntimeError(93, 'Invalid pattern string');
      let body = pattern.slice(i + 1, end);
      let neg = false;
      if (body.startsWith('!')) { neg = true; body = body.slice(1); }
      if (body === '') re += neg ? '[\\s\\S]' : '(?!)';
      else re += '[' + (neg ? '^' : '') + body.replace(/[\\\]^]/g, m => '\\' + m) + ']';
      i = end;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, m => '\\' + m);
  }
  return new RegExp('^' + re + '$', 'u').test(text);
}

const COMPARE_OPS = new Set<BinaryOp>(['=', '<>', '<', '>', '<=', '>=']);

/** Result of a comparison operator for a compare() result. */
export function compareResult(op: string, c: -1 | 0 | 1): boolean {
  switch (op) {
    case '=': return c === 0;
    case '<>': return c !== 0;
    case '<': return c < 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '>=': return c >= 0;
  }
  throw new Error(`compare op: ${op}`);
}

export function binaryOp(op: BinaryOp, a: VBValue, b: VBValue): VBValue {
  if (op === 'is') {
    const okA = a instanceof NothingT || isObject(a);
    const okB = b instanceof NothingT || isObject(b);
    if (!okA || !okB) throw new VBRuntimeError(424);
    return (isObject(a) ? a.identity ?? a : a) === (isObject(b) ? b.identity ?? b : b);
  }
  a = plain(a);
  b = plain(b);
  if (COMPARE_OPS.has(op)) {
    if (a instanceof NullT || b instanceof NullT) return Null;
    return compareResult(op, compare(a, b));
  }
  switch (op) {
    case '&':
      if (a instanceof NullT && b instanceof NullT) return Null;
      return (a instanceof NullT ? '' : toStr(a)) + (b instanceof NullT ? '' : toStr(b));
    case 'like':
      if (a instanceof NullT || b instanceof NullT) return Null;
      return likeMatch(toStr(a), toStr(b));
    case 'and': case 'or': case 'xor': case 'eqv': case 'imp':
      return logic(op, a, b);
  }
  if (a instanceof NullT || b instanceof NullT) return Null;
  return arith(op, a, b);
}

export function unaryOp(op: UnaryOp, v: VBValue): VBValue {
  v = plain(v);
  if (v instanceof NullT) return Null;
  if (op === 'not') {
    if (typeof v === 'boolean') return !v;
    return ~toLong(v);
  }
  if (v instanceof EmptyT) return 0;
  if (isDate(v)) return date(-v.serial);
  return 0 - toNumber(v);
}
