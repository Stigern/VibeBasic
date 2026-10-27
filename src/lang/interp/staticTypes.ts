// Static (declared) types of expressions, as VB6's compiler knows them.
//
// Values are plain JS numbers, so the type of a number comes from the code instead: a typed variable, a literal, a
// typed function, a conversion function (CInt, CSng ...) and the operators' result types. Used for
//  - Integer/Long/Byte overflow of `+ - * \ Mod` and unary minus (`a * b` with two Integers is error 6 above 32767,
//    as in VB6; Variant arithmetic widens instead, so an expression with a Variant operand is not checked),
//  - Single and Currency results (`CSng(2) / 3` is a Single), and where a Single leaves Single-typed code for text or a
//    Variant (`shown`: Print, `&`, CStr, a Label show .3333333; inside numeric code the value stays an exact IEEE single),
//  - TypeName / VarType of typed variables and expressions (`TypeName(d)` of a Double holding 5 is "Double"), and of a
//    Variant variable assigned a typed expression (`v = CDbl(5)`).
// 'Variant' means "not known" (a Variant, a String, an object, a host property ...).
//
// The type of an operator node depends only on the code, so it is computed once and kept on the node (`st`, and the
// check its results need, `chk`: see eval.ts `binaryResult`).

import type { BinaryExpr, BinaryOp, CallOrIndex, Expr, MissingArg, UnaryExpr, VBTypeName } from '../ast';
import { VBArray, maybeSingle, single7, type VBValue } from '../values';
import { lookup } from './eval';
import { BuiltinRef, Frame, ProcRef, ValueRef, Variable, lc } from './scope';

/** A static type: a declared type, or 'Decimal' (CDec, for TypeName/VarType only). */
export type StaticType = VBTypeName | 'Decimal';

const V: StaticType = 'Variant';

/** Numeric types of the operator rules (Boolean counts as an Integer in arithmetic). */
const NUMERIC = new Set<StaticType>(['Byte', 'Boolean', 'Integer', 'Long', 'Single', 'Double', 'Currency']);
/** Types TypeName/VarType report from the code rather than from the value. */
const REPORTED = new Set<StaticType>(['Byte', 'Integer', 'Long', 'Single', 'Double', 'Currency', 'Decimal']);

const SUFFIX: Record<string, VBTypeName> = { '%': 'Integer', '&': 'Long', '!': 'Single', '#': 'Double', '$': 'String', '@': 'Currency' };

/** Built-ins with a typed (non-Variant) result; 'arg' is the type of the first argument (Abs, Int, Fix). */
const BUILTIN_TYPES: Record<string, StaticType | 'arg'> = {
  cint: 'Integer', clng: 'Long', csng: 'Single', cdbl: 'Double', ccur: 'Currency', cbyte: 'Byte', cbool: 'Boolean',
  cdec: 'Decimal', cdate: 'Date', cstr: 'String', len: 'Long', lenb: 'Long', asc: 'Integer', ascw: 'Integer', ascb: 'Integer',
  sgn: 'Integer', timer: 'Single', rnd: 'Single', val: 'Double', lbound: 'Long', ubound: 'Long', abs: 'arg', int: 'arg', fix: 'arg',
  pmt: 'Double', ppmt: 'Double', ipmt: 'Double', fv: 'Double', pv: 'Double', npv: 'Double', irr: 'Double', mirr: 'Double',
  nper: 'Double', rate: 'Double', ddb: 'Double', sln: 'Double', syd: 'Double',
};

/** A whole number literal is an Integer or a Long by its size; one with a point or exponent is a Double. */
function literalType(value: number, suffix: string | undefined, isDouble: boolean | undefined): StaticType {
  if (suffix) return SUFFIX[suffix];
  if (isDouble || !Number.isInteger(value)) return 'Double';
  if (value >= -32768 && value <= 32767) return 'Integer';
  if (value >= -2147483648 && value <= 2147483647) return 'Long';
  return 'Double';
}

/** The type of a Const without `As`: that of its value (VB6: the type that suits the expression). */
function valueType(v: VBValue): StaticType {
  if (typeof v === 'number') return literalType(v, undefined, false);
  if (typeof v === 'string') return 'String';
  if (typeof v === 'boolean') return 'Boolean';
  return V;
}

function variableType(b: Variable): StaticType {
  if (b.opts.isArray) return V;
  if (b.opts.isConst && b.type === 'Variant') return valueType(b.value);
  return b.type;
}

/** The declared type of an expression (see the header). */
export function staticType(f: Frame, e: Expr | MissingArg): StaticType {
  switch (e.kind) {
    case 'number': return literalType(e.value, e.suffix, e.isDouble);
    case 'string': return 'String';
    case 'bool': return 'Boolean';
    case 'date': return 'Date';
    case 'name': {
      const key = lc(e.name);
      if (key === 'me' || key === 'empty' || key === 'null') return V;
      const b = lookup(f, key, e.name);
      if (b instanceof Variable) return variableType(b);
      if (b instanceof ProcRef) return procType(f, b);
      if (b instanceof BuiltinRef) return builtinType(f, b.name, []);
      if (b instanceof ValueRef) return typeof b.value === 'number' ? 'Long' : valueType(b.value);   // enum members, vb constants
      return V;
    }
    case 'call': {
      const t = e.target;
      if (t.kind !== 'name') return V;
      const key = lc(t.name);
      if (f.returnVar && key === lc(f.proc!.name)) return procType(f, f.module.procs.get(key)!);   // a recursive call
      const b = lookup(f, key, t.name, true);
      // an element of a declared array; an array a Variant holds has Variant items (VB6), so the type never depends on the value
      if (b instanceof Variable) return b.opts.isArray && !b.opts.variantAlias && b.value instanceof VBArray ? b.value.elemType : V;
      if (b instanceof ProcRef) return procType(f, b);
      if (b instanceof BuiltinRef) return builtinType(f, b.name, e.args);
      return V;
    }
    case 'member': {
      // a field of a record: `p.X`, `a(i).X`
      const base = staticType(f, e.object);
      if (typeof base !== 'object' || !('userType' in base)) return V;
      const fi = f.rt.typeInfo(base.userType).fields.get(lc(e.name));
      return fi && !fi.isArray ? fi.type : V;
    }
    case 'unary': return e.st ?? (e.st = unaryType(f, e));
    case 'binary': return e.st ?? (e.st = binaryType(f, e));
    case 'typeOf': return 'Boolean';
  }
  return V;
}

function procType(f: Frame, b: ProcRef): StaticType {
  const p = b.proc;
  if (p.kind !== 'function' || p.returnsArray) return V;
  return f.rt.resolveType(p.returnType, b.module);
}

function builtinType(f: Frame, name: string, args: (Expr | MissingArg)[]): StaticType {
  const t = BUILTIN_TYPES[name];
  if (t === undefined) return V;
  if (t !== 'arg') return t;
  const a = args[0] === undefined ? V : staticType(f, args[0]);
  return NUMERIC.has(a) || a === 'Decimal' ? (a === 'Boolean' ? 'Integer' : a) : V;
}

const isWhole = (t: StaticType) => t === 'Byte' || t === 'Boolean' || t === 'Integer';

/** `+ - *`: the wider operand type (Single with Long is a Double; Byte only with Byte). */
function wider(a: StaticType, b: StaticType): StaticType {
  if (a === 'Double' || b === 'Double') return 'Double';
  if (a === 'Currency' || b === 'Currency') return a === 'Single' || b === 'Single' ? 'Double' : 'Currency';
  if (a === 'Single' || b === 'Single') return a === 'Long' || b === 'Long' ? 'Double' : 'Single';
  if (a === 'Long' || b === 'Long') return 'Long';
  return a === 'Byte' && b === 'Byte' ? 'Byte' : 'Integer';
}

function binaryType(f: Frame, e: BinaryExpr): StaticType {
  const op: BinaryOp = e.op;
  switch (op) {
    case '&': return 'String';
    case '=': case '<>': case '<': case '>': case '<=': case '>=': case 'like': case 'is': return 'Boolean';
  }
  const a = staticType(f, e.left);
  const b = staticType(f, e.right);
  if (op === '-' && a === 'Date' && b === 'Date') return 'Double';
  if (!NUMERIC.has(a) || !NUMERIC.has(b)) return V;
  switch (op) {
    case '+': case '-': case '*': return wider(a, b);
    case '/': return (a === 'Single' || b === 'Single') && (a === 'Single' || isWhole(a)) && (b === 'Single' || isWhole(b)) ? 'Single' : 'Double';
    case '^': return 'Double';
    case '\\': case 'mod': return isWhole(a) && isWhole(b) ? (a === 'Byte' && b === 'Byte' ? 'Byte' : 'Integer') : 'Long';
    default:   // And Or Xor Eqv Imp
      if (a === 'Boolean' && b === 'Boolean') return 'Boolean';
      return isWhole(a) && isWhole(b) ? (a === 'Byte' && b === 'Byte' ? 'Byte' : 'Integer') : 'Long';
  }
}

function unaryType(f: Frame, e: UnaryExpr): StaticType {
  const t = staticType(f, e.operand);
  if (!NUMERIC.has(t)) return V;
  if (e.op === 'neg') return t === 'Byte' || t === 'Boolean' ? 'Integer' : t;
  return t === 'Single' || t === 'Double' || t === 'Currency' ? 'Long' : t;
}

/** The static type of an operator node (computed; eval.ts keeps it on the node as `st`). */
export function operatorType(f: Frame, e: BinaryExpr | UnaryExpr): StaticType {
  return e.kind === 'binary' ? binaryType(f, e) : unaryType(f, e);
}

/**
 * The type TypeName/VarType report for an argument expression, when the code knows it better than the value: a typed
 * numeric variable or expression, a Variant variable last assigned a typed number (`v = CDbl(5)`). Undefined: use the
 * value.
 */
export function reportedType(f: Frame, e: Expr | MissingArg): string | undefined {
  if (e.kind === 'call') { const s = elementSub(f, e); if (s !== undefined) return s; }
  let t: StaticType | undefined;
  const b = e.kind === 'name' ? lookup(f, lc(e.name), e.name) : undefined;
  if (b instanceof Variable) {
    if (b.opts.isArray) return undefined;
    t = b.type === 'Variant' && !b.opts.isConst ? (b.subOf === b.value ? b.sub : undefined) : variableType(b);
  } else t = staticType(f, e);
  return t !== undefined && REPORTED.has(t) ? (t as string) : undefined;
}

/**
 * `a(i)` of an array with noted subtypes (a ParamArray): the subtype of that element. Only for indexes that can be read
 * without running code (numbers, variables, constants, + and -); undefined otherwise.
 */
function elementSub(f: Frame, e: CallOrIndex): string | undefined {
  if (e.target.kind !== 'name') return undefined;
  const b = lookup(f, lc(e.target.name), e.target.name, true);
  if (!(b instanceof Variable) || !(b.value instanceof VBArray)) return undefined;
  const pure = (x: Expr | MissingArg): number | undefined => {
    if (x.kind === 'number') return x.value;
    if (x.kind === 'name') {
      const v = lookup(f, lc(x.name), x.name);
      const n = v instanceof Variable || v instanceof ValueRef ? v.value : undefined;
      return typeof n === 'number' ? n : undefined;
    }
    if (x.kind === 'unary' && x.op === 'neg') { const n = pure(x.operand); return n === undefined ? undefined : -n; }
    if (x.kind === 'binary' && (x.op === '+' || x.op === '-')) {
      const l = pure(x.left), r = pure(x.right);
      return l === undefined || r === undefined ? undefined : x.op === '+' ? l + r : l - r;
    }
    return undefined;
  };
  const idx = e.args.map(pure);
  if (idx.some(n => n === undefined || !Number.isInteger(n))) return undefined;
  try { return b.value.subAt(idx as number[]); } catch { return undefined; }
}

/** Records on a Variant variable the type of the typed number just assigned to it (see `Variable.sub`). */
export function noteSubtype(f: Frame, v: Variable, src: Expr): void {
  const value = v.value;
  if (typeof value !== 'number') { v.sub = undefined; return; }
  const t = src.kind === 'name' || src.kind === 'call' ? reportedType(f, src) : staticType(f, src);
  v.sub = t !== undefined && REPORTED.has(t as StaticType) ? (t as StaticType) : undefined;
  v.subOf = value;
}

/**
 * `v`, the value of `e`, as text-facing code gets it: a Single (an exact IEEE single in Single-typed code) becomes its 7
 * significant digits (`single7`), so that Print, `&`, CStr, a Label or a Variant show .3333333 as VB6 does.
 */
export function shown(f: Frame, e: Expr | MissingArg, v: VBValue): VBValue {
  return maybeSingle(v) && staticType(f, e) === 'Single' ? single7(v) : v;
}

/** Numeric declared types: a Single stored there keeps its exact value (`d = s`, `a(i) = s`). */
export function isNumericType(t: VBTypeName): boolean {
  return t === 'Single' || t === 'Double' || t === 'Currency' || t === 'Integer' || t === 'Long' || t === 'Byte';
}
