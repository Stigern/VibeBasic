// Expression evaluation, name lookup, member access, calls and assignment.
//
// Everything that can run user code is a generator (`Gen<T>`, see driver.ts):
// a procedure call yields a SubCall, a host promise is yielded as-is.

import type { CallOrIndex, Expr, MemberExpr, MissingArg, NameExpr, TypeSuffix, VBTypeName } from '../ast';
import { VBRuntimeError } from '../errors';
import { BUILTINS, CONSTANTS } from '../builtins';
import { Empty, Null, Nothing, NothingT, VBArray, VBRecord, VBRef, coerce, toNumber, type VBValue } from '../values';
import { SubCall, runSync, type Gen } from './driver';
import {
  BuiltinRef, ConstSlot, ElementSlot, EnumRef, FieldSlot, Frame, ModuleRef, ModuleScope, ObjectRef, ProcRef,
  ValueRef, Variable, getField, lc, setField, storeValue, type Binding,
} from './scope';
import { binaryOp, isObject, plain, unaryOp } from './operators';
import { invokeProc, type BoundArg, MISSING } from './exec';
import type { Runtime } from './program';

const compileError = (msg: string) => VBRuntimeError.compile(msg);

// ---------------------------------------------------------------------------
// Name lookup
// ---------------------------------------------------------------------------

const builtinRefs = new Map<string, BuiltinRef>();
const constantRefs = new Map<string, ValueRef>();

/**
 * Hook for built-in functions (Task 6 fills BUILTINS). Returns a cached
 * BuiltinRef or undefined.
 */
function builtinFor(key: string): BuiltinRef | undefined {
  let r = builtinRefs.get(key);
  if (r) return r;
  const b = BUILTINS.get(key);
  if (!b) return undefined;
  r = new BuiltinRef(key, b);
  builtinRefs.set(key, r);
  return r;
}

/** Hook for built-in constants (Task 6 fills CONSTANTS). */
function constantFor(key: string): ValueRef | undefined {
  let r = constantRefs.get(key);
  if (r) return r;
  if (!CONSTANTS.has(key)) return undefined;
  r = new ValueRef(CONSTANTS.get(key)!);
  constantRefs.set(key, r);
  return r;
}

/** The Variable of a module/public constant, evaluating it on first use. */
function constVariable(rt: Runtime, slot: ConstSlot): Variable {
  if (slot.variable) return slot.variable;
  if (slot.evaluating) throw compileError('Constant expression required');
  slot.evaluating = true;
  try {
    const { decl, module } = slot;
    const value = constExpr(rt.moduleFrame(module), decl.value);
    const type = rt.resolveType(decl.type, module);
    slot.variable = new Variable(decl.name, type, new VBRef(storeValue(value, type)), { isConst: true });
    return slot.variable;
  } finally {
    slot.evaluating = false;
  }
}

/** Evaluates a constant expression (no procedure calls, no waiting). */
export function constExpr(f: Frame, e: Expr): VBValue {
  return runSync(evalExpr(f, e), () => { throw compileError('Constant expression required'); });
}

/**
 * Resolves a name, in VB order: local → module (variables, constants,
 * procedures) → public globals → enum members, enum types and built-in
 * constants → built-in functions → standard module names → host objects.
 */
export function lookup(f: Frame, key: string, name: string): Binding | undefined {
  const local = f.locals.get(key);
  if (local) return local;
  const m = f.module;
  const rt = f.run.rt;
  const g = rt.globals;
  const mv = m.vars.get(key);
  if (mv) return mv;
  const mc = m.consts.get(key);
  if (mc) return constVariable(rt, mc);
  const mp = m.procs.get(key);
  if (mp) return mp;
  const gv = g.vars.get(key);
  if (gv) return gv;
  const gc = g.consts.get(key);
  if (gc) return constVariable(rt, gc);
  const gp = g.procs.get(key);
  if (gp) return gp;
  const en = m.enumMembers.get(key) ?? g.enumMembers.get(key) ?? m.enums.get(key) ?? g.enums.get(key) ?? constantFor(key);
  if (en) return en;
  const b = builtinFor(key);
  if (b) return b;
  const mod = g.modules.get(key);
  if (mod) return mod;
  const obj = rt.host.resolveName(m.name, name);
  return obj ? new ObjectRef(obj) : undefined;
}

const SUFFIX_TYPES: Record<TypeSuffix, VBTypeName> = { '%': 'Integer', '&': 'Long', '!': 'Single', '#': 'Double', '$': 'String' };

/** An undeclared name used as a variable: a new local Variant (or suffix type), or a compile error under Option Explicit. */
export function implicitVariable(f: Frame, e: NameExpr): Variable {
  if (f.proc === null || f.module.optionExplicit) throw compileError('Variable not defined');
  const type = e.suffix ? SUFFIX_TYPES[e.suffix] : 'Variant';
  const v = new Variable(e.name, type, new VBRef(f.rt.defaultFor(type)));
  f.locals.set(lc(e.name), v);
  return v;
}

function meObject(f: Frame): ObjectRef {
  const o = f.rt.host.resolveName(f.module.name, 'Me');
  if (!o) throw compileError('Invalid use of Me keyword');
  return new ObjectRef(o);
}

/** Binding of a NameExpr, including `Me`. */
function bindingOf(f: Frame, e: NameExpr): Binding | undefined {
  const key = lc(e.name);
  if (key === 'me') return meObject(f);
  return lookup(f, key, e.name);
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** Marker: the expression needs the generator path. */
const NOT_SYNC = Symbol('notSync');
/** Expressions that once needed the generator path (performance hint only). */
const needsGen = new WeakSet<Expr>();

/**
 * Fast path: evaluates expressions made only of literals, variables,
 * constants, operators, array elements and record fields without creating
 * generators. Returns NOT_SYNC (before any side effect) for anything else:
 * procedure/built-in calls, host objects, With members, undeclared names.
 */
function evalSync(f: Frame, e: Expr): VBValue | typeof NOT_SYNC {
  switch (e.kind) {
    case 'number': case 'string': case 'bool': return e.value;
    case 'name': {
      const key = lc(e.name);
      const local = f.locals.get(key);
      if (local) return local.value;
      if (key === 'empty') return Empty;
      if (key === 'null') return Null;
      if (key === 'me') return NOT_SYNC;
      const b = lookup(f, key, e.name);
      return b instanceof Variable || b instanceof ValueRef ? b.value : NOT_SYNC;
    }
    case 'unary': {
      const v = evalSync(f, e.operand);
      return v === NOT_SYNC ? v : unaryOp(e.op, v);
    }
    case 'binary': {
      const a = evalSync(f, e.left);
      if (a === NOT_SYNC) return a;
      const b = evalSync(f, e.right);
      if (b === NOT_SYNC) return b;
      return binaryOp(e.op, a, b);
    }
    case 'call': {
      const t = e.target;
      if (t.kind !== 'name') return NOT_SYNC;
      const key = lc(t.name);
      if (f.returnVar && key === lc(f.proc!.name)) return NOT_SYNC;
      const b = f.locals.get(key) ?? lookup(f, key, t.name);
      if (!(b instanceof Variable)) return NOT_SYNC;
      const arr = b.value;
      if (!(arr instanceof VBArray)) return NOT_SYNC;
      const idx: number[] = new Array(e.args.length);
      for (let i = 0; i < e.args.length; i++) {
        const a = e.args[i];
        if (a.kind === 'missing') return NOT_SYNC;
        const v = evalSync(f, a);
        if (v === NOT_SYNC) return v;
        idx[i] = toNumber(v);
      }
      return arr.get(idx);
    }
    case 'member': {
      if (e.object.kind !== 'name' && e.object.kind !== 'member' && e.object.kind !== 'call') return NOT_SYNC;
      const base = evalSync(f, e.object);
      return base instanceof VBRecord ? getField(base, e.name) : NOT_SYNC;
    }
  }
  return NOT_SYNC;
}

export function* evalExpr(f: Frame, e: Expr): Gen<VBValue> {
  if (!needsGen.has(e)) {
    const v = evalSync(f, e);
    if (v !== NOT_SYNC) return v;
    needsGen.add(e);
  }
  switch (e.kind) {
    case 'number': case 'string': case 'bool': return e.value;
    case 'nothing': return Nothing;
    case 'date': return coerce(e.text, 'Date');
    case 'name': {
      const key = lc(e.name);
      const local = f.locals.get(key);
      if (local) return local.value;
      if (key === 'empty') return Empty;
      if (key === 'null') return Null;
      return yield* bindingValue(f, bindingOf(f, e), e);
    }
    case 'member': return yield* evalMember(f, e, null);
    case 'withMember': return yield* memberGet(f, withObject(f), e.name, null);
    case 'call': return yield* evalCall(f, e);
    case 'unary': return unaryOp(e.op, yield* evalExpr(f, e.operand));
    case 'binary': {
      const a = yield* evalExpr(f, e.left);
      const b = yield* evalExpr(f, e.right);
      return binaryOp(e.op, a, b);
    }
    case 'new': throw compileError('Not supported in VibeBasic: New');
  }
}

/** The value of a name's binding (calls a parameterless Function or built-in). */
function* bindingValue(f: Frame, b: Binding | undefined, e: NameExpr): Gen<VBValue> {
  if (b instanceof Variable) return b.value;
  if (b === undefined) return implicitVariable(f, e).value;
  if (b instanceof ValueRef) return b.value;
  if (b instanceof ProcRef) {
    if (b.proc.kind === 'sub') throw compileError('Expected Function or variable');
    return yield* callProc(f, b, []);
  }
  if (b instanceof BuiltinRef) return yield* callBuiltin(f, b, []);
  if (b instanceof ObjectRef) return b.obj;
  throw compileError(b instanceof EnumRef ? 'Expected: expression' : 'Expected variable or procedure, not module');
}

/** Top `With` object. */
export function withObject(f: Frame): VBValue {
  if (f.withStack.length === 0) throw compileError('Invalid or unqualified reference');
  return f.withStack[f.withStack.length - 1];
}

/** The object part of `x.y`: a value, or an enum/module name for `Color.Red` / `Module1.Total`. */
function* memberBase(f: Frame, e: Expr): Gen<VBValue | EnumRef | ModuleRef> {
  if (e.kind === 'name') {
    const b = bindingOf(f, e);
    if (b instanceof EnumRef || b instanceof ModuleRef) return b;
    return yield* bindingValue(f, b, e);
  }
  return yield* evalExpr(f, e);
}

function* evalMember(f: Frame, e: MemberExpr, args: (Expr | MissingArg)[] | null): Gen<VBValue> {
  const base = yield* memberBase(f, e.object);
  return yield* memberGet(f, base, e.name, args);
}

/** `base.name` or `base.name(args)` as a value. */
export function* memberGet(f: Frame, base: VBValue | EnumRef | ModuleRef, name: string, args: (Expr | MissingArg)[] | null): Gen<VBValue> {
  if (base instanceof EnumRef) {
    const v = base.members.get(lc(name));
    if (v === undefined) throw compileError('Method or data member not found');
    return args ? yield* indexValue(f, v, args) : v;
  }
  if (base instanceof ModuleRef) return yield* moduleMember(f, base.module, name, args);
  if (base instanceof VBRecord) {
    const v = getField(base, name);
    return args ? yield* indexValue(f, v, args) : v;
  }
  if (base instanceof NothingT) throw new VBRuntimeError(91);
  if (isObject(base)) {
    const argv = args ? yield* evalArgValues(f, args) : [];
    if (base.hasMember(name)) return base.getMember(name, argv);
    const r = base.callMethod(name, argv);
    return r instanceof Promise ? (yield r) as VBValue : r;
  }
  throw new VBRuntimeError(424);
}

/** `Module1.name[(args)]`: a module-level variable, constant or procedure of that module. */
function* moduleMember(f: Frame, m: ModuleScope, name: string, args: (Expr | MissingArg)[] | null): Gen<VBValue> {
  const key = lc(name);
  const v = m.vars.get(key) ?? (m.consts.has(key) ? constVariable(f.rt, m.consts.get(key)!) : undefined);
  if (v) return args ? yield* indexValue(f, v.value, args) : v.value;
  const p = m.procs.get(key);
  if (p && (p.proc.visibility === 'public' || m === f.module)) return yield* callProc(f, p, args ?? []);
  throw compileError('Method or data member not found');
}

function* evalCall(f: Frame, e: CallOrIndex): Gen<VBValue> {
  const t = e.target;
  if (t.kind === 'name') {
    const key = lc(t.name);
    // Inside Function Foo, `Foo(...)` is a recursive call, not the return value.
    if (f.returnVar && key === lc(f.proc!.name)) return yield* callProc(f, f.module.procs.get(key)!, e.args);
    const b = bindingOf(f, t);
    if (b instanceof Variable) return yield* indexValue(f, b.value, e.args);
    if (b instanceof ProcRef) {
      if (b.proc.kind === 'sub') throw compileError('Expected Function or variable');
      return yield* callProc(f, b, e.args);
    }
    if (b instanceof BuiltinRef) return yield* callBuiltin(f, b, e.args);
    if (b instanceof ObjectRef) return yield* indexValue(f, b.obj, e.args);
    if (b instanceof ValueRef) return yield* indexValue(f, b.value, e.args);
    throw compileError('Sub or Function not defined');
  }
  if (t.kind === 'member') {
    const base = yield* memberBase(f, t.object);
    return yield* memberGet(f, base, t.name, e.args);
  }
  if (t.kind === 'withMember') return yield* memberGet(f, withObject(f), t.name, e.args);
  return yield* indexValue(f, yield* evalExpr(f, t), e.args);
}

/** `v(args)` where v is an array, or an object (control array item / default member with arguments). */
function* indexValue(f: Frame, v: VBValue, args: (Expr | MissingArg)[]): Gen<VBValue> {
  if (v instanceof VBArray) return v.get(yield* evalIndices(f, args));
  if (v instanceof NothingT) throw new VBRuntimeError(91);
  if (isObject(v)) {
    const argv = yield* evalArgValues(f, args);
    if (v.item && argv.length === 1) return v.item(toNumber(argv[0]));
    if (v.defaultMember !== undefined) return v.getMember(v.defaultMember, argv);
    throw new VBRuntimeError(438);
  }
  throw new VBRuntimeError(13);
}

export function* evalIndices(f: Frame, args: (Expr | MissingArg)[]): Gen<number[]> {
  const idx: number[] = new Array(args.length);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.kind === 'missing') throw compileError('Expected: expression');
    idx[i] = toNumber(yield* evalExpr(f, a));
  }
  return idx;
}

/** Argument values; an omitted argument is `undefined`, trailing omitted ones are dropped. */
export function* evalArgValues(f: Frame, args: (Expr | MissingArg)[]): Gen<VBValue[]> {
  let n = args.length;
  while (n > 0 && args[n - 1].kind === 'missing') n--;
  const out: VBValue[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = args[i];
    out[i] = a.kind === 'missing' ? (undefined as unknown as VBValue) : yield* evalExpr(f, a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function* callBuiltin(f: Frame, b: BuiltinRef, args: (Expr | MissingArg)[]): Gen<VBValue> {
  const argv = yield* evalArgValues(f, args);
  const { minArgs, maxArgs, fn } = b.builtin;
  if (argv.length < minArgs || argv.length > maxArgs) throw new VBRuntimeError(450);
  const r = fn(argv, f.rt.builtinCtx);
  return r instanceof Promise ? (yield r) as VBValue : r;
}

/** Calls a user Sub/Function: binds arguments in the caller, then runs the body as a SubCall. */
export function* callProc(f: Frame, ref: ProcRef, args: (Expr | MissingArg)[]): Gen<VBValue> {
  const bound = yield* bindArgs(f, ref, args);
  return (yield new SubCall(invokeProc(f.run, ref, bound))) as VBValue;
}

function* bindArgs(f: Frame, ref: ProcRef, args: (Expr | MissingArg)[]): Gen<BoundArg[]> {
  const params = ref.proc.params;
  if (args.length > params.length) throw compileError('Wrong number of arguments or invalid property assignment');
  const out: BoundArg[] = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const a = args[i];
    if (a === undefined || a.kind === 'missing') {
      if (!p.optional) throw compileError('Argument not optional');
      out.push(MISSING);
      continue;
    }
    if (p.byRef) {
      const r = yield* refOf(f, a);
      if (r) { out.push(r); continue; }
    }
    out.push({ value: yield* evalExpr(f, a) });
  }
  return out;
}

/** A by-reference argument: the slot of a variable, array element or record field; null for other expressions. */
function* refOf(f: Frame, e: Expr): Gen<BoundArg | null> {
  if (e.kind === 'name') {
    let b = bindingOf(f, e);
    if (b === undefined) b = implicitVariable(f, e);
    if (b instanceof Variable && !b.opts.isConst) return { slot: b.ref, type: b.type, isArray: b.opts.isArray };
    return null;
  }
  if (e.kind === 'call' && e.target.kind === 'name') {
    const key = lc(e.target.name);
    if (f.returnVar && key === lc(f.proc!.name)) return null;
    const b = bindingOf(f, e.target);
    if (b instanceof Variable && b.value instanceof VBArray) {
      const arr = b.value;
      const idx = yield* evalIndices(f, e.args);
      arr.get(idx); // range check now, like VB
      return { slot: new ElementSlot(arr, idx), type: arr.elemType };
    }
    return null;
  }
  if (e.kind === 'member' || e.kind === 'withMember') {
    const base = e.kind === 'member' ? yield* memberBase(f, e.object) : withObject(f);
    if (base instanceof VBRecord) {
      const key = lc(e.name);
      const info = f.rt.typeInfo(base.typeName).fields.get(key);
      if (!info) throw compileError('Method or data member not found');
      return { slot: new FieldSlot(f.rt, base, key), type: info.type, isArray: info.isArray };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** Sets the default member of a host object (`Text1 = "x"`, `List1(0) = "y"`). */
function setDefault(obj: VBValue, args: VBValue[], value: VBValue): void {
  if (obj instanceof NothingT) throw new VBRuntimeError(91);
  if (!isObject(obj)) throw new VBRuntimeError(424);
  if (obj.defaultMember === undefined) throw new VBRuntimeError(438);
  obj.setMember(obj.defaultMember, args, value);
}

/** `target = value` (Let) or `Set target = value`. */
export function* assign(f: Frame, target: Expr, value: VBValue, isSet: boolean): Gen<void> {
  if (isSet) {
    if (!(value instanceof NothingT) && !isObject(value)) throw new VBRuntimeError(424);
  } else if (value instanceof NothingT || isObject(value)) {
    value = plain(value);
  }
  switch (target.kind) {
    case 'name': {
      let b = bindingOf(f, target);
      if (b === undefined) b = implicitVariable(f, target);
      if (b instanceof Variable) { b.set(value); return; }
      if (b instanceof ObjectRef && !isSet) { setDefault(b.obj, [], value); return; }
      if (b instanceof ProcRef) throw compileError('Function call on left-hand side of assignment must return Variant or Object');
      throw compileError('Assignment to constant not permitted');
    }
    case 'call': {
      const t = target.target;
      let container: VBValue;
      if (t.kind === 'name') {
        const b = bindingOf(f, t);
        if (b instanceof Variable) container = b.value;
        else if (b instanceof ObjectRef) container = b.obj;
        else if (b === undefined) throw compileError('Sub or Function not defined');
        else throw compileError('Function call on left-hand side of assignment must return Variant or Object');
      } else if (t.kind === 'member' || t.kind === 'withMember') {
        const base = t.kind === 'member' ? yield* memberBase(f, t.object) : withObject(f);
        if (!(base instanceof ModuleRef) && !(base instanceof EnumRef) && isObject(base)) {
          // `List1.List(2) = "x"`
          const argv = yield* evalArgValues(f, target.args);
          base.setMember(t.name, argv, value);
          return;
        }
        container = yield* memberGet(f, base, t.name, null);
      } else {
        container = yield* evalExpr(f, t);
      }
      if (container instanceof VBArray) {
        const idx = yield* evalIndices(f, target.args);
        container.set(idx, value instanceof VBRecord || value instanceof VBArray ? value.clone() : value);
        return;
      }
      if (isObject(container)) {
        const argv = yield* evalArgValues(f, target.args);
        if (container.item && argv.length === 1) { setDefault(container.item(toNumber(argv[0])), [], value); return; }
        setDefault(container, argv, value);
        return;
      }
      if (container instanceof NothingT) throw new VBRuntimeError(91);
      throw new VBRuntimeError(13);
    }
    case 'member': case 'withMember': {
      const base = target.kind === 'member' ? yield* memberBase(f, target.object) : withObject(f);
      yield* memberSet(f, base, target.name, value);
      return;
    }
  }
  throw compileError('Expected: variable');
}

function* memberSet(f: Frame, base: VBValue | EnumRef | ModuleRef, name: string, value: VBValue): Gen<void> {
  if (base instanceof VBRecord) { setField(f.rt, base, lc(name), value); return; }
  if (base instanceof ModuleRef) {
    const v = base.module.vars.get(lc(name));
    if (!v) throw compileError('Method or data member not found');
    v.set(value);
    return;
  }
  if (base instanceof EnumRef) throw compileError('Assignment to constant not permitted');
  if (base instanceof NothingT) throw new VBRuntimeError(91);
  if (isObject(base)) { base.setMember(name, [], value); return; }
  throw new VBRuntimeError(424);
}

/** Resolves a name to a Variable for For/ReDim/Erase targets (implicit declaration allowed). */
export function variableOf(f: Frame, e: NameExpr): Variable {
  let b = bindingOf(f, e);
  if (b === undefined) b = implicitVariable(f, e);
  if (!(b instanceof Variable) || b.opts.isConst) throw compileError('Variable required - can\'t assign to this expression');
  return b;
}
