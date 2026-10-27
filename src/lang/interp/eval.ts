// Expression evaluation, name lookup, member access, calls and assignment.
//
// Everything that can run user code is a generator (`Gen<T>`, see driver.ts):
// a procedure call yields a SubCall, a host promise is yielded as-is.

import { argNames, type BinaryExpr, type CallOrIndex, type Expr, type MemberExpr, type MissingArg, type NameExpr, type Param, type TypeSuffix, type UnaryExpr, type VBTypeName } from '../ast';
import { VBRuntimeError } from '../errors';
import { BUILTINS, CONSTANTS } from '../builtins';
import { BUILTIN_CLASSES } from '../builtins/collection';
import {
  Empty, Missing, Null, Nothing, NothingT, RefContainer, VBArray, VBRecord, VBRef, isObject, parseDate, single7, toCurrency, toNumber,
  toSingle, type VBValue,
} from '../values';
import { localeDateParser } from '../builtins/format';
import { EndSignal, SubCall, runCallsSync, runSync, type Gen } from './driver';
import {
  BuiltinRef, ClassInstance, ClassValue, ConstSlot, ElementSlot, EnumRef, FieldSlot, Frame, MemberRef, ModuleRef, ModuleScope, ObjectRef,
  ProcRef, PropRef, Run, ValueRef, Variable, classesInUse, escape, getField, lc, setClassCaller, setField, storeValue, type Binding,
} from './scope';
import { binaryOp, compareResult, likeMatch, plain, unaryOp } from './operators';
import { bigSingleText, isNumericType, noteSubtype, operatorType, reportedType, shown, staticType, type StaticType } from './staticTypes';
import { invokeProc, type BoundArg, MISSING } from './exec';
import type { Runtime } from './program';
import type { OutSlot, VBObject } from '../host';

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
 * procedures, its own enum members and enum types) → in a form's procedures,
 * the form's own names (controls, then properties of `Me`: see `formName`) →
 * public globals → other modules' public enum members/types and built-in
 * constants → built-in functions → standard module names → host objects.
 * `call` is true when the name is used with call arguments (`Left(s, 2)`).
 */
export function lookup(f: Frame, key: string, name: string, call = false): Binding | undefined {
  const local = f.locals.get(key);
  if (local) return local;
  const m = f.module;
  const rt = f.run.rt;
  const g = rt.globals;
  const mv = f.vars.get(key);
  if (mv) return mv;
  const mc = m.consts.get(key);
  if (mc) return constVariable(rt, mc);
  const mp = m.procs.get(key) ?? m.props.get(key);
  if (mp) return mp;
  const me = m.enumMembers.get(key) ?? m.enums.get(key);
  if (me) return me;
  const inForm = m.kind === 'form' && f.proc !== null;
  if (inForm) {
    const fm = formName(f, key, name, call);
    if (fm) return fm;
  }
  const gv = g.vars.get(key);
  if (gv) return gv;
  const gc = g.consts.get(key);
  if (gc) return constVariable(rt, gc);
  const gp = g.procs.get(key) ?? g.props.get(key);
  if (gp) return gp;
  const en = g.enumMembers.get(key) ?? g.enums.get(key) ?? constantFor(key);
  if (en) return en;
  const b = builtinFor(key);
  if (b) return b;
  const mod = g.modules.get(key);
  if (mod) return mod;
  if (inForm) return undefined; // host names were asked for in formName
  const obj = rt.host.resolveName(m.name, name);
  return obj ? new ObjectRef(obj) : undefined;
}

/**
 * The form's own names inside its procedures, which VB6 puts before global
 * names and built-ins: a control or other host name (`Text1`), else a
 * property of `Me` (`Caption`, `Width`) as a MemberRef. A property whose name
 * is also a built-in function is not used with call arguments: `Left(s, 2)`
 * is the built-in, a bare `Left` is the form's property. Only `resolveName`
 * and `hasMember` are asked here (no member is read).
 */
function formName(f: Frame, key: string, name: string, call: boolean): Binding | undefined {
  const host = f.rt.host;
  const obj = host.resolveName(f.module.name, name);
  if (obj) return new ObjectRef(obj);
  if (call && BUILTINS.has(key)) return undefined;
  const me = host.resolveName(f.module.name, 'Me');
  return me && me.hasMember(name) ? new MemberRef(me, name) : undefined;
}

/**
 * A call to a name that is not declared (`Hide`, `Move 0, 0`, `x = Point(1, 2)`):
 * in a form's procedure a method of `Me` (`Me.callMethod`); an object
 * without that method (error 438) or no form: `Sub or Function not defined`.
 */
export function* formMethod(f: Frame, name: string, args: (Expr | MissingArg)[]): Gen<VBValue> {
  const me = f.module.kind === 'form' && f.proc !== null ? f.rt.host.resolveName(f.module.name, 'Me') : undefined;
  if (!me) throw compileError('Sub or Function not defined');
  args = hostArgs(me, name, args);
  const argv = shownArgs(f, args, yield* evalArgValues(f, args));
  const notDefined = (e: unknown) => (e instanceof VBRuntimeError && e.number === 438 ? compileError('Sub or Function not defined') : e);
  let r: VBValue | Promise<VBValue>;
  try {
    r = me.callMethod(name, methodArgs(argv, me), yield* hostRefs(f, me, name, args));
  } catch (e) {
    throw notDefined(e);
  }
  if (r instanceof Promise) return yield* awaitHost(f, r.catch(e => { throw notDefined(e); }));
  yield* afterHostCall(f);
  return r;
}

const SUFFIX_TYPES: Record<TypeSuffix, VBTypeName> = { '%': 'Integer', '&': 'Long', '!': 'Single', '#': 'Double', '$': 'String', '@': 'Currency' };

/** An undeclared name used as a variable: a new local Variant (or suffix type), or a compile error under Option Explicit. */
export function implicitVariable(f: Frame, e: NameExpr): Variable {
  if (f.proc === null || f.module.optionExplicit) throw compileError('Variable not defined');
  const type = e.suffix ? SUFFIX_TYPES[e.suffix] : 'Variant';
  const v = new Variable(e.name, type, new VBRef(f.rt.defaultFor(type)));
  f.locals.set(lc(e.name), v);
  return v;
}

function meObject(f: Frame): ObjectRef {
  if (f.instance) return new ObjectRef(f.instance);
  const o = f.module.kind === 'class' ? undefined : f.rt.host.resolveName(f.module.name, 'Me');
  if (!o) throw compileError('Invalid use of Me keyword');
  return new ObjectRef(o);
}

/** Binding of a NameExpr, including `Me`; `call`: used with call arguments (see `lookup`). */
function bindingOf(f: Frame, e: NameExpr, call = false): Binding | undefined {
  const key = lc(e.name);
  if (key === 'me') return meObject(f);
  return lookup(f, key, e.name, call);
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/**
 * `a op b` for an operator node, by the node's `chk` (see OperatorTypeInfo in ast.ts): most nodes (Double, Variant,
 * String, comparisons) need nothing; Integer, Long and Byte nodes compare the result with their range (error 6,
 * Overflow); the rest take `slowBinary`.
 */
function binaryResult(f: Frame, e: BinaryExpr, a: VBValue, b: VBValue): VBValue {
  const k = e.chk;
  if (k === 0) return binaryOp(e.op, a, b);
  if (k === 1) {
    const r = binaryOp(e.op, a, b);
    if (typeof r === 'number' && (r > e.hi! || r < e.lo!)) throw new VBRuntimeError(6);
    return r;
  }
  return slowBinary(f, e, a, b);
}

function unaryResult(f: Frame, e: UnaryExpr, v: VBValue): VBValue {
  const k = e.chk;
  if (k === 0) return unaryOp(e.op, v);
  if (k === 1) {
    const r = unaryOp(e.op, v);
    if (typeof r === 'number' && (r > e.hi! || r < e.lo!)) throw new VBRuntimeError(6);
    return r;
  }
  if (k !== 3) learn(f, e);   // 2: not known yet (also a node made without `chk`)
  return e.chk === 3 ? rounded(e, unaryOp(e.op, v)) : unaryResult(f, e, v);
}

const RANGES: Record<string, [number, number]> = { Integer: [-32768, 32767], Long: [-2147483648, 2147483647], Byte: [0, 255] };

/** Works out (once) the static type of an operator node and what its results need (`chk` 0, 1 or 3; `lo`, `hi`). */
function learn(f: Frame, e: BinaryExpr | UnaryExpr): void {
  const t = e.st ??= operatorType(f, e);
  const range = RANGES[t as string];
  if (range) { e.chk = 1; e.lo = range[0]; e.hi = range[1]; }
  else if (t === 'Single' || t === 'Currency') e.chk = 3;
  // `&` with a Single operand shows it with 7 digits
  else if (e.kind === 'binary' && e.op === '&' && (staticType(f, e.left) === 'Single' || staticType(f, e.right) === 'Single')) e.chk = 3;
  else e.chk = 0;
}

/** A Single or Currency node's result, rounded like one. */
function rounded(e: BinaryExpr | UnaryExpr, r: VBValue): VBValue {
  if (typeof r !== 'number') return r;
  return e.st === 'Single' ? toSingle(r) : e.st === 'Currency' ? toCurrency(r) : r;
}

function slowBinary(f: Frame, e: BinaryExpr, a: VBValue, b: VBValue): VBValue {
  if (e.text) return textBinary(e.op, a, b);
  if (e.chk !== 3) learn(f, e);
  if (e.chk !== 3) return binaryResult(f, e, a, b);
  if (e.op === '&') return binaryOp('&', bigSingleText(f, e.left, a) ?? shown(f, e.left, a), bigSingleText(f, e.right, b) ?? shown(f, e.right, b));
  return rounded(e, binaryOp(e.op, a, b));
}

/** `a op b` for a comparison or Like under `Option Compare Text`: two strings compare without case. */
export function textBinary(op: BinaryExpr['op'], a: VBValue, b: VBValue): VBValue {
  a = plain(a);
  b = plain(b);
  if (typeof a !== 'string' || typeof b !== 'string') return binaryOp(op, a, b);
  if (op === 'like') return likeMatch(a, b, true);
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return compareResult(op, x < y ? -1 : x > y ? 1 : 0);
}

/** A number that may be a Single that is not whole (`maybeSingle` in values.ts; local, the checks run often). */
const isSingleFrac = (v: VBValue): v is number => typeof v === 'number' && Math.fround(v) === v && Math.floor(v) !== v;

/** Marker: the expression needs the generator path. */
const NOT_SYNC = Symbol('notSync');
/** Expressions that once needed the generator path (performance hint only). */
const needsGen = new WeakSet<Expr>();

/** A value the fast path may hand on: host objects are not (using one as a value calls into host code). */
function syncValue(v: VBValue): VBValue | typeof NOT_SYNC {
  return typeof v === 'object' && isObject(v) ? NOT_SYNC : v;
}

/**
 * Fast path: evaluates expressions made only of literals, variables,
 * constants, operators, array elements and record fields without creating
 * generators. Returns NOT_SYNC (before any side effect) for anything else:
 * procedure/built-in calls, host objects (also held in variables, array
 * elements or fields), With members, undeclared names. It never calls into
 * host code, so falling back to the generator path never repeats a host call.
 */
function evalSync(f: Frame, e: Expr): VBValue | typeof NOT_SYNC {
  switch (e.kind) {
    case 'number': case 'string': case 'bool': return e.value;
    case 'name': {
      const key = lc(e.name);
      const local = f.locals.get(key);
      if (local) return syncValue(local.value);
      if (key === 'empty') return Empty;
      if (key === 'null') return Null;
      if (key === 'me') return NOT_SYNC;
      const b = lookup(f, key, e.name);
      return b instanceof Variable || b instanceof ValueRef ? syncValue(b.value) : NOT_SYNC;
    }
    case 'unary': {
      const v = evalSync(f, e.operand);
      if (v === NOT_SYNC) return v;
      return e.chk === 0 ? unaryOp(e.op, v) : unaryResult(f, e, v);
    }
    case 'binary': {
      const a = evalSync(f, e.left);
      if (a === NOT_SYNC) return a;
      const b = evalSync(f, e.right);
      if (b === NOT_SYNC) return b;
      // binaryResult, inlined for the two common cases
      const k = e.chk;
      if (k === 0) return binaryOp(e.op, a, b);
      if (k === 1) {
        const r = binaryOp(e.op, a, b);
        if (typeof r === 'number' && (r > e.hi! || r < e.lo!)) throw new VBRuntimeError(6);
        return r;
      }
      return slowBinary(f, e, a, b);
    }
    case 'call': {
      const t = e.target;
      if (t.kind !== 'name') return NOT_SYNC;
      const key = lc(t.name);
      if (f.returnVar && key === lc(f.proc!.name)) return NOT_SYNC;
      const b = f.locals.get(key) ?? lookup(f, key, t.name, true);
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
      return syncValue(arr.get(idx));
    }
    case 'member': {
      if (e.object.kind !== 'name' && e.object.kind !== 'member' && e.object.kind !== 'call') return NOT_SYNC;
      const base = evalSync(f, e.object);
      return base instanceof VBRecord ? syncValue(getField(base, e.name)) : NOT_SYNC;
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
    case 'date': {
      // a date literal is locale-free: #m/d/yyyy [h:nn:ss AM]# or #yyyy-mm-dd#
      const d = parseDate(e.text, localeDateParser('en-US'));
      if (!d) throw new VBRuntimeError(13);
      return d;
    }
    case 'name': {
      const key = lc(e.name);
      const local = f.locals.get(key);
      if (local) {
        const v = local.value;
        if (v instanceof ClassInstance && v.initPending) yield* ready(f, v);   // `Dim x As New Class1`: made on first use
        return v;
      }
      if (key === 'empty') return Empty;
      if (key === 'null') return Null;
      return yield* bindingValue(f, bindingOf(f, e), e);
    }
    case 'member': return yield* evalMember(f, e, null);
    case 'withMember': return yield* memberGet(f, withObject(f), e.name, null);
    case 'withObject': return withObject(f);
    case 'call': return yield* evalCall(f, e);
    case 'unary': return unaryResult(f, e, yield* classPlain(f, yield* evalExpr(f, e.operand)));
    case 'binary': {
      let a = yield* evalExpr(f, e.left);
      let b = yield* evalExpr(f, e.right);
      if (e.op !== 'is') {   // a class object's default member (Attribute VB_UserMemId = 0), with its code run here
        if (a instanceof ClassValue) a = yield* classPlain(f, a);
        if (b instanceof ClassValue) b = yield* classPlain(f, b);
      }
      return binaryResult(f, e, a, b);
    }
    case 'typeOf': return typeOfIs(yield* evalExpr(f, e.object), e.typeName);
    case 'new': {
      const o = objectFactory(f.rt, { objectType: e.typeName }, f.module)();
      if (o instanceof ClassInstance) {
        yield* ready(f, o);
        // a temporary until it is stored: it terminates at the end of the statement if nothing keeps it
        if (o.refs === 0 && !o.dying && !o.dead) { o.dying = true; f.rt.queueDying(o); }
      }
      return o;
    }
  }
}

/**
 * `TypeOf v Is T`: False for Nothing; an object answers by `asType(T, true)` (class objects, forms, controls), else by
 * its type name (Collection). `Object` fits every object. A value that is not an object is error 424.
 */
function typeOfIs(v: VBValue, typeName: string): boolean {
  if (v instanceof NothingT) return false;
  if (!isObject(v)) throw new VBRuntimeError(424);
  const k = lc(typeName.slice(typeName.lastIndexOf('.') + 1));
  if (k === 'object') return true;
  if (v.asType) return v.asType(typeName, true) !== undefined;
  return lc(v.vbTypeName) === k;
}

/**
 * How `New T` makes an object (`Set c = New Class1`, `Dim c As New Collection`): an object of a class module of the
 * project, else a form of the project (Host.objectFactory: another instance), else a built-in class (Collection, ADODB…,
 * see BUILTIN_CLASSES). VB6 does not allow New with a user-defined type or a
 * plain type (compile error "Invalid use of New keyword"); a name that is no class is "User-defined type not defined".
 * A class module's object comes back before Class_Initialize has run (`ready` runs it).
 */
export function objectFactory(rt: Runtime, type: VBTypeName, module: ModuleScope): () => VBObject {
  const t = typeof type === 'object' && 'objectType' in type ? rt.resolveType(type, module) : type;
  if (typeof t !== 'object' || 'userType' in t) throw compileError('Invalid use of New keyword');
  const name = lc(t.objectType);
  const cls = rt.classes.get(name);
  if (cls) return () => rt.newInstance(cls);
  const host = rt.host.objectFactory?.(t.objectType);   // a form: Dim f As New Form1
  if (host) return host;
  const b = BUILTIN_CLASSES.get(name);
  if (b) return () => b.create(rt.builtinCtx);
  throw compileError('User-defined type not defined');
}

/** Runs Class_Initialize of a new object (once; a `Dim x As New T` object when it is first used). */
export function* ready(f: Frame, inst: ClassInstance): Gen<void> {
  if (!inst.initPending) return;
  inst.initPending = false;
  const init = inst.module.procs.get('class_initialize');
  if (init) yield new SubCall(invokeProc(f.run, init, [], inst));
}

/** The value of a name's binding (calls a parameterless Function or built-in). */
function* bindingValue(f: Frame, b: Binding | undefined, e: NameExpr): Gen<VBValue> {
  if (b instanceof Variable) {
    const v = b.value;
    if (v instanceof ClassInstance && v.initPending) yield* ready(f, v);
    return v;
  }
  if (b === undefined) return implicitVariable(f, e).value;
  if (b instanceof ValueRef) return b.value;
  if (b instanceof ProcRef) {
    if (b.proc.kind === 'sub') throw compileError('Expected Function or variable');
    return yield* callProc(f, b, []);
  }
  if (b instanceof PropRef) return yield* propGet(f, b, []);
  if (b instanceof BuiltinRef) return yield* callBuiltin(f, b, []);
  if (b instanceof ObjectRef) return b.obj;
  if (b instanceof MemberRef) return yield* memberGet(f, b.obj, b.name, null);
  throw compileError(b instanceof EnumRef ? 'Expected: expression' : 'Expected variable or procedure, not module');
}

/**
 * After a synchronous call into a host object: if the host started event
 * handlers that are still running (e.g. setting Text1.Text fired a Change
 * handler that waits in a MsgBox), wait for them, as VB6 runs them nested.
 */
export function* afterHostCall(f: Frame): Gen<void> {
  const rt = f.rt;
  stopIfEnded(f);
  checkOverflow(rt);
  const p = rt.nestedRuns(f.run);
  if (p) {
    yield p;
    stopIfEnded(f);
    checkOverflow(rt);
  }
}

const END = new EndSignal();

/**
 * The program ended during a host call (an event handler it fired ran End):
 * the running statement stops at once instead of finishing its evaluation.
 * Not in an Immediate command, which may still evaluate after the end.
 */
function stopIfEnded(f: Frame): void {
  if (f.rt.stopping && !f.run.immediate) throw END;
}

/** Error 28 in the running statement when an event was refused for nesting too deep (see Runtime.runEvent). */
function checkOverflow(rt: Runtime): void {
  if (rt.overflow) {
    rt.overflow = false;
    throw new VBRuntimeError(28);
  }
}

/** Awaits a promise from a host object or built-in, then checks for nested events (see afterHostCall). */
export function* awaitHost(f: Frame, p: Promise<VBValue>): Gen<VBValue> {
  const v = (yield p) as VBValue;
  yield* afterHostCall(f);
  return v;
}

/**
 * The arguments of a host method in its parameter order, by the names the object lists (`col.Add x, Key:="k"`,
 * `paramNames`); a named argument for an object or method without names is error 448.
 */
export function hostArgs(obj: VBObject, name: string, args: (Expr | MissingArg)[]): (Expr | MissingArg)[] {
  const names = argNames(args);
  if (!names) return args;
  const params = obj.paramNames?.(name);
  if (!params) throw new VBRuntimeError(448);
  return positional(args, names, params);
}

/** Host method arguments: a Single as its 7 digits (`List1.AddItem s`, `Coll.Add s`), see `shown`. */
export function shownArgs(f: Frame, args: (Expr | MissingArg)[], argv: VBValue[]): VBValue[] {
  if (argNames(args)) throw new VBRuntimeError(448);
  for (let i = 0; i < argv.length; i++) if (isSingleFrac(argv[i])) argv[i] = shown(f, args[i], argv[i]);
  return argv;
}

/**
 * Arguments for `callMethod`: an object with a default member is passed as
 * that value (`List1.AddItem Text1` adds Text1.Text); objects without one (a
 * Form as owner, a Picture) and Nothing are passed as they are.
 */
export function methodArgs(argv: VBValue[], obj?: VBObject): VBValue[] {
  // a host object may keep it without a counted reference; a Collection or Dictionary counts its own
  if (classesInUse && !(obj instanceof RefContainer)) for (const a of argv) escape(a);
  if (obj?.rawArgs) return argv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === Missing) argv[i] = undefined as unknown as VBValue;   // a missing Optional argument passed on: omitted
    else if (a !== undefined && isObject(a) && a.defaultMember !== undefined) argv[i] = plain(a);
  }
  return argv;
}

/**
 * The slots of a host method's ByRef arguments (`Winsock1.GetData strData`): only for the positions the object lists in
 * `byRefArgs` and only where the caller passed a variable, array element or record field. A store converts to the
 * slot's declared type, like an assignment.
 */
export function* hostRefs(f: Frame, obj: VBObject, name: string, args: (Expr | MissingArg)[]): Gen<(OutSlot | undefined)[] | undefined> {
  const pos = obj.byRefArgs?.(name);
  if (!pos?.length) return undefined;
  const out: (OutSlot | undefined)[] = [];
  for (const i of pos) {
    const a = args[i];
    if (a === undefined || a.kind === 'missing') continue;
    const r = yield* refOf(f, a);
    if (!r || r === MISSING || !('slot' in r)) continue;
    const { slot, type, isArray, fixedLength } = r;
    out[i] = {
      get value() { return slot.value; },
      set value(v: VBValue) {
        if (isArray) {   // a dynamic array variable takes a whole array (GetData into a Byte array)
          if (!(v instanceof VBArray)) throw new VBRuntimeError(13);
          slot.value = v;
        } else slot.value = type === undefined ? v : storeValue(v, type, fixedLength);
      },
    };
  }
  return out;
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

/**
 * `base.name` or `base.name(args)` as a value. On a host object:
 * `a.b` is `getMember('b', [])`; `a.b(args)` is `getMember('b', args)` when
 * `hasMember('b')`, else `callMethod('b', args)` (a Promise result is awaited).
 */
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
  if (base instanceof ClassValue) return yield* classGet(f, base, name, args);
  if (isObject(base)) {
    let r: VBValue | Promise<VBValue>;
    if (args === null) r = base.getMember(name, []);
    else {
      args = hostArgs(base, name, args);
      const argv = yield* evalArgValues(f, args);
      r = base.hasMember(name) ? base.getMember(name, argv)
        : base.callMethod(name, methodArgs(shownArgs(f, args, argv), base), yield* hostRefs(f, base, name, args));
    }
    if (r instanceof Promise) return yield* awaitHost(f, r);
    yield* afterHostCall(f);
    return r;
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
  const pr = m.props.get(key);
  if (pr?.get && (pr.get.proc.visibility === 'public' || m === f.module)) return yield* propGet(f, pr, args ?? []);
  throw compileError('Method or data member not found');
}

// ---------------------------------------------------------------------------
// Properties and objects of class modules
// ---------------------------------------------------------------------------

/** A Property Get (`Total`, `Item(2)`); a property with only Let/Set is "Invalid use of property". */
function* propGet(f: Frame, p: PropRef, args: (Expr | MissingArg)[], inst?: ClassInstance): Gen<VBValue> {
  if (!p.get) throw compileError('Invalid use of property');
  return yield* callIndexed(f, p.get, args, inst);
}

/**
 * Calls a Function or Property Get; arguments given to one that takes none index its result (`obj.Items(2)` where
 * Items returns an array).
 */
function* callIndexed(f: Frame, ref: ProcRef, args: (Expr | MissingArg)[], inst?: ClassInstance): Gen<VBValue> {
  const params = ref.proc.params;
  if (args.length > 0 && params.length === 0) return yield* indexValue(f, yield* callProc(f, ref, [], inst), args);
  return yield* callProc(f, ref, args, inst);
}

/** `Total = v` / `Set Item(2) = obj`: the Property Let (or Set) with the index arguments and the value last (by value). */
function* propSet(f: Frame, p: PropRef, args: VBValue[], value: VBValue, isSet: boolean): Gen<void> {
  const ref = isSet ? p.set : p.let;
  if (!ref) throw compileError('Invalid use of property');
  yield* callLetSet(f, ref, args, value, isSet);
}

function* callLetSet(f: Frame, ref: ProcRef, args: VBValue[], value: VBValue, isSet: boolean, inst?: ClassInstance): Gen<void> {
  const bound: BoundArg[] = args.map(a => ({ value: a }));
  bound.push({ value: isSet ? value : plain(value) });
  const self = inst ?? (ref.module.kind === 'class' ? f.instance : undefined);
  yield new SubCall(invokeProc(f.run, ref, bound, self));
}

/**
 * The member of a class object a name means: a Public variable, Sub/Function or property of the class; through an
 * interface (`Dim x As IFoo`) the class's `IFoo_Name` procedure or property, Private or not. Undefined: error 438.
 */
function classMember(obj: ClassValue, name: string): Variable | ProcRef | PropRef | undefined {
  const m = obj.inst.module;
  if (obj.iface !== undefined) {
    const k = `${obj.iface}_${lc(name)}`;
    return m.procs.get(k) ?? m.props.get(k);
  }
  const k = lc(name);
  const v = obj.inst.publicVar(k);
  if (v) return v;
  const p = m.procs.get(k);
  if (p) return p.proc.visibility === 'public' ? p : undefined;
  const pr = m.props.get(k);
  return pr?.isPublic ? pr : undefined;
}

/** A Property procedure of the member that the caller may use (Private ones only through an interface). */
const usable = (obj: ClassValue, ref: ProcRef | undefined): ProcRef | undefined =>
  ref && (obj.iface !== undefined || ref.proc.visibility === 'public') ? ref : undefined;

/** `obj.name` / `obj.name(args)` as a value. */
function* classGet(f: Frame, obj: ClassValue, name: string, args: (Expr | MissingArg)[] | null): Gen<VBValue> {
  const inst = obj.inst;
  if (inst.initPending) yield* ready(f, inst);
  const m = classMember(obj, name);
  if (m === undefined) throw new VBRuntimeError(438);
  if (m instanceof Variable) return args ? yield* indexValue(f, m.value, args) : m.value;
  if (m instanceof ProcRef) {
    if (m.proc.kind === 'sub') throw compileError('Expected Function or variable');
    return yield* callIndexed(f, m, args ?? [], inst);
  }
  const get = usable(obj, m.get);
  if (!get) throw compileError('Invalid use of property');
  return yield* callIndexed(f, get, args ?? [], inst);
}

/** `obj.name(argv)` with argument values (a default member, host code): a Public variable, Property Get or Function. */
function* classGetValues(f: Frame, obj: ClassValue, name: string, argv: VBValue[]): Gen<VBValue> {
  const inst = obj.inst;
  if (inst.initPending) yield* ready(f, inst);
  const m = classMember(obj, name);
  if (m === undefined) throw new VBRuntimeError(438);
  let ref: ProcRef | undefined;
  if (m instanceof Variable) ref = undefined;
  else if (m instanceof ProcRef) {
    if (m.proc.kind === 'sub') throw compileError('Expected Function or variable');
    ref = m;
  } else {
    ref = usable(obj, m.get);
    if (!ref) throw compileError('Invalid use of property');
  }
  // arguments for a member that takes none index its value (`obj(2)` where the default member returns an array)
  const own = ref !== undefined && (argv.length === 0 || ref.proc.params.length > 0);
  const v = m instanceof Variable ? m.value
    : (yield new SubCall(invokeProc(f.run, ref!, (own ? argv : []).map(a => ({ value: a })), inst))) as VBValue;
  if (own || argv.length === 0) return v;
  if (v instanceof VBArray) return v.get(argv.map(toNumber));
  if (v instanceof ClassValue) return yield* classDefault(f, v, argv);
  if (isObject(v) && v.defaultMember !== undefined) return v.getMember(v.defaultMember, argv);
  throw new VBRuntimeError(v instanceof NothingT ? 91 : 13);
}

/** The default member of a class object (`Attribute X.VB_UserMemId = 0`) with arguments; none: error 438. */
function* classDefault(f: Frame, obj: ClassValue, argv: VBValue[]): Gen<VBValue> {
  const d = obj.defaultMember;
  if (d === undefined) throw new VBRuntimeError(438);
  return yield* classGetValues(f, obj, d, argv);
}

/** The value For Each goes through: for a class object, what its NewEnum member (VB_UserMemId -4) returns. */
export function* forEachSource(f: Frame, v: VBValue): Gen<VBValue> {
  if (!(v instanceof ClassValue)) return v;
  const name = v.iface ? undefined : v.inst.module.ast.newEnum;
  if (name === undefined) throw new VBRuntimeError(438);
  return yield* classGetValues(f, v, name, []);
}

/** A class object as a plain value: its default member, followed until it is no class object; other values as they are. */
export function* classPlain(f: Frame, v: VBValue): Gen<VBValue> {
  for (let i = 0; v instanceof ClassValue && v.defaultMember !== undefined && i < 100; i++) v = yield* classDefault(f, v, []);
  return v;
}

// Host code and `plain` read (or write) a member of a class object outside the generators: run its code now, in an
// Immediate-like run (an error goes to the caller; code that waits is an error).
setClassCaller((obj, name, args, value) => {
  const inst = obj.inst;
  const rt = inst.rt;
  const run = new Run(rt);
  run.immediate = true;
  const f = new Frame(run, inst.module, null, 0, inst);
  run.frames.push(f);
  rt.immediateRuns++;
  try {
    const gen: Gen<VBValue> = value === undefined
      ? classGetValues(f, obj, name, args)
      : (function* () { yield* classSet(f, obj, name, args, value, isObject(value) || value instanceof NothingT); return Empty; })();
    return runCallsSync(gen, () => { throw new VBRuntimeError(5, `The member ${name} of ${inst.module.name} waits; use it in a statement of its own`); });
  } finally {
    rt.immediateRuns--;
  }
});

/** `obj.name args` as a statement: a Sub or Function of the class (its result is dropped). */
export function* classCall(f: Frame, obj: ClassValue, name: string, args: (Expr | MissingArg)[]): Gen<void> {
  const inst = obj.inst;
  if (inst.initPending) yield* ready(f, inst);
  const m = classMember(obj, name);
  if (m === undefined) throw new VBRuntimeError(438);
  if (!(m instanceof ProcRef)) throw compileError('Invalid use of property');
  yield* callProc(f, m, args, inst);
}

/** `obj.name(args) = value` / `Set obj.name = value`: a Public variable (or its element), or a Property Let / Set. */
function* classSet(f: Frame, obj: ClassValue, name: string, args: VBValue[], value: VBValue, isSet: boolean): Gen<void> {
  const inst = obj.inst;
  if (inst.initPending) yield* ready(f, inst);
  const m = classMember(obj, name);
  if (m === undefined) throw new VBRuntimeError(438);
  if (m instanceof Variable) {
    if (args.length === 0) { assignVariable(m, value, isSet); return; }
    const arr = m.value;
    if (!(arr instanceof VBArray)) throw new VBRuntimeError(13);
    arr.set(args.map(toNumber), isSet ? value : plain(value));
    return;
  }
  if (m instanceof ProcRef) throw compileError('Function call on left-hand side of assignment must return Variant or Object');
  const ref = usable(obj, isSet ? m.set : m.let);
  if (!ref) throw compileError('Invalid use of property');
  yield* callLetSet(f, ref, args, value, isSet, inst);
}

function* evalCall(f: Frame, e: CallOrIndex): Gen<VBValue> {
  const t = e.target;
  if (t.kind === 'name') {
    const key = lc(t.name);
    // Inside Function Foo, `Foo(...)` is a recursive call, not the return value.
    if (f.returnVar && key === lc(f.proc!.name)) return yield* callProc(f, f.module.procs.get(key)!, e.args);
    const b = bindingOf(f, t, true);
    if (b instanceof Variable) return yield* indexValue(f, b.value, e.args);
    if (b instanceof ProcRef) {
      if (b.proc.kind === 'sub') throw compileError('Expected Function or variable');
      return yield* callProc(f, b, e.args);
    }
    if (b instanceof PropRef) return yield* propGet(f, b, e.args);
    if (b instanceof BuiltinRef) return yield* callBuiltin(f, b, e.args);
    if (b instanceof ObjectRef) return yield* indexValue(f, b.obj, e.args);
    if (b instanceof ValueRef) return yield* indexValue(f, b.value, e.args);
    if (b instanceof MemberRef) return yield* memberGet(f, b.obj, b.name, e.args);
    if (b === undefined) return yield* formMethod(f, t.name, e.args);
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
  if (v instanceof ClassValue) return yield* classDefault(f, v, yield* evalArgValues(f, args));
  if (isObject(v)) {
    const argv = yield* evalArgValues(f, args);
    if (v.item && argv.length === 1) return v.item(toNumber(argv[0]));
    if (v.defaultMember === undefined) throw new VBRuntimeError(438);
    const r = v.getMember(v.defaultMember, argv);
    yield* afterHostCall(f);
    return r;
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
  const names = argNames(args);
  if (names) {
    const params = b.builtin.params;
    if (!params) throw new VBRuntimeError(448);
    args = positional(args, names, params);
    // InStr([start,] s1, s2[, compare]): no Start, the strings come first
    if (b.name === 'instr' && args[0].kind === 'missing') args = args.slice(1);
  }
  const r = builtinCall(f, b, args, yield* evalArgValues(f, args));
  return r instanceof Promise ? yield* awaitHost(f, r) : r;
}

/** Checks a built-in's arguments (count, Missing ones, Singles shown) and calls it. */
function builtinCall(f: Frame, b: BuiltinRef, args: (Expr | MissingArg)[], argv: VBValue[]): VBValue | Promise<VBValue> {
  const { minArgs, maxArgs, fn, raw, types, vars, num } = b.builtin;
  if (argv.length < minArgs || argv.length > maxArgs) throw new VBRuntimeError(450);
  // the calling module's Option Compare / Option Base (InStr, StrComp, Array)
  const ctx = f.rt.builtinCtx;
  ctx.textCompare = f.module.textCompare;
  ctx.optionBase = f.module.optionBase;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    // a missing Optional argument passed on (`MsgBox s, , title` with title missing) counts as omitted
    if (v === Missing && !raw) {
      if (i < minArgs) throw new VBRuntimeError(448);
      argv[i] = undefined as unknown as VBValue;
    } else if (!num && isSingleFrac(v)) argv[i] = shown(f, args[i], v);   // CStr(s), Left(s, 3), MsgBox s: 7 digits
    else if (!num && b.name === 'cstr') argv[i] = bigSingleText(f, args[i], v) ?? v;   // CStr(s): 1.234568E+07
  }
  if (vars) return fn(argv, f.rt.builtinCtx, args.map(a => declaredType(f, a)));
  return types
    ? fn(argv, f.rt.builtinCtx, args.map(a => (a.kind === 'missing' ? undefined : reportedType(f, a))))
    : fn(argv, f.rt.builtinCtx);
}

/**
 * The declared type of an argument that is a variable (not an array, not a Variant), an element of a typed array or a
 * field of a record (`Len(l)`, `Len(a(1))`, `Len(p.Age)`), when it is a plain type; undefined for anything else.
 */
function declaredType(f: Frame, e: Expr | MissingArg): string | undefined {
  let t: VBTypeName | undefined;
  if (e.kind === 'name') {
    const b = lookup(f, lc(e.name), e.name);
    if (b instanceof Variable && !b.opts.isArray) t = b.type;
  } else if (e.kind === 'call' && e.target.kind === 'name') {
    const b = lookup(f, lc(e.target.name), e.target.name, true);
    if (b instanceof Variable && b.value instanceof VBArray) t = b.value.elemType;
  } else if (e.kind === 'member' && e.object.kind === 'name') {
    const b = lookup(f, lc(e.object.name), e.object.name);
    const base = b instanceof Variable ? b.value : undefined;
    if (base instanceof VBRecord) t = f.rt.typeInfo(base.typeName).fields.get(lc(e.name))?.type;
  }
  return typeof t === 'string' ? t : undefined;
}

/**
 * Calls a user Sub/Function: binds arguments in the caller, then runs the body as a SubCall. A class module's
 * procedure runs for `inst`, by default the caller's own object (`DoWork` inside the class).
 */
export function* callProc(f: Frame, ref: ProcRef, args: (Expr | MissingArg)[], inst?: ClassInstance): Gen<VBValue> {
  const bound = yield* bindArgs(f, ref, args);
  const self = inst ?? (ref.module.kind === 'class' ? f.instance : undefined);
  return (yield new SubCall(invokeProc(f.run, ref, bound, self))) as VBValue;
}

/**
 * The arguments of a call with named arguments in the order of `params` (names, any case): an omitted one is a
 * MissingArg. A name that is no parameter is error 448; one given twice "Named argument already specified".
 */
export function positional(args: (Expr | MissingArg)[], names: (string | undefined)[], params: readonly string[]): (Expr | MissingArg)[] {
  const out: (Expr | MissingArg | undefined)[] = [];
  for (let i = 0; i < args.length; i++) {
    const n = names[i];
    const at = n === undefined ? i : params.findIndex(p => lc(p) === lc(n));
    if (at < 0) throw new VBRuntimeError(448);
    if (out[at] !== undefined) throw compileError('Named argument already specified');
    out[at] = args[i];
  }
  const line = args[0]?.line ?? 0;
  for (let i = 0; i < out.length; i++) out[i] ??= { kind: 'missing', line };
  return out as (Expr | MissingArg)[];
}

function* bindArgs(f: Frame, ref: ProcRef, args: (Expr | MissingArg)[]): Gen<BoundArg[]> {
  const params = ref.proc.params;
  const names = argNames(args);
  if (names) args = positional(args, names, params.filter(p => !p.paramArray).map(p => p.name));
  const rest = params.length > 0 && params[params.length - 1].paramArray ? params.length - 1 : -1;
  if (args.length > params.length && rest < 0) throw compileError('Wrong number of arguments or invalid property assignment');
  const out: BoundArg[] = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const a = args[i];
    if (i === rest) {   // ParamArray: every remaining argument, by value, in a 0-based Variant array
      const extra = args.slice(i);
      const arr = new VBArray('Variant', [[0, extra.length - 1]]);
      for (let k = 0; k < extra.length; k++) {
        const e = extra[k];
        if (e.kind === 'missing') { arr.set([k], Empty); continue; }
        const v = yield* evalExpr(f, e);
        arr.set([k], isSingleFrac(v) ? shown(f, e, v) : v);   // a Variant item: a Single keeps its 7 digits
        // and a number keeps the type the code gives it, as in a Variant variable (TypeName(a(0)) of `5&` is Long)
        const t = typeof v === 'number' ? reportedType(f, e) : undefined;
        if (t !== undefined) arr.noteSub([k], t);
      }
      out.push({ value: arr });
      break;
    }
    if (a === undefined || a.kind === 'missing') {
      if (!p.optional) throw compileError('Argument not optional');
      out.push(MISSING);
      continue;
    }
    if ((a as { paren?: boolean }).paren && (p.isArray || isRecordType(f.rt.resolveType(p.type, ref.module)))) {
      // `Foo (arr)`: VB6 passes arrays and records only by reference, so a parenthesised one does not compile
      throw compileError('Type mismatch: array or user-defined type expected');
    }
    if (p.byRef) {
      const r = yield* refOf(f, a);
      if (r) { out.push(r); continue; }
    }
    out.push(valueArg(f, p, a, yield* evalExpr(f, a)));
  }
  return out;
}

const isRecordType = (t: VBTypeName): boolean => typeof t === 'object' && 'userType' in t;

/** A value argument; a number for a Variant parameter keeps the type the code gives it (TypeName), a Single its 7 digits. */
function valueArg(f: Frame, p: Param, a: Expr, value: VBValue): BoundArg {
  // `ByVal v` and `ByVal v As Variant` are the same Variant parameter
  const sub = typeof value === 'number' && (p.type === undefined || p.type === 'Variant') && !p.isArray ? reportedType(f, a) : undefined;
  if (sub === undefined) return { value };
  return { value: sub === 'Single' ? shown(f, a, value) : value, sub: sub as StaticType };
}

/** A by-reference argument: the slot of a variable, array element or record field; null for other expressions. */
function* refOf(f: Frame, e: Expr): Gen<BoundArg | null> {
  if ((e as { paren?: boolean }).paren) return null;   // `Foo (x)`: a value
  if (e.kind === 'name') {
    let b = bindingOf(f, e);
    if (b === undefined) b = implicitVariable(f, e);
    if (b instanceof Variable && !b.opts.isConst) return { slot: b.ref, type: b.type, isArray: b.opts.isArray, fixedLength: b.opts.fixedLength };
    return null;
  }
  if (e.kind === 'call' && e.target.kind === 'name') {
    const key = lc(e.target.name);
    if (f.returnVar && key === lc(f.proc!.name)) return null;
    const b = bindingOf(f, e.target, true);
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

/** Sets the default member of a host object (`Text1 = "x"`, `List1(0) = "y"`); `value` is a plain value. */
function setDefault(obj: VBValue, args: VBValue[], value: VBValue): void {
  if (obj instanceof NothingT) throw new VBRuntimeError(91);
  if (!isObject(obj)) throw new VBRuntimeError(424);
  if (obj.defaultMember === undefined) throw new VBRuntimeError(438);
  obj.setMember(obj.defaultMember, args, value);
}

const isObjectValue = (v: VBValue) => v instanceof NothingT || isObject(v);

/** Declared types that can hold an object reference (Set target). */
function holdsObjects(t: VBTypeName): boolean {
  return t === 'Variant' || t === 'Object' || (typeof t === 'object' && 'objectType' in t);
}

/**
 * Assignment to a variable. `Set v = obj` stores the reference (a variable that
 * cannot hold objects is a type mismatch). A Let into an object variable
 * (`As Object`, `As TextBox`) sets the default member of the object it holds
 * (Nothing: error 91); any other Let stores the plain value (an object's default member).
 */
function assignVariable(v: Variable, value: VBValue, isSet: boolean): void {
  if (isSet) {
    if (!holdsObjects(v.type)) throw new VBRuntimeError(13);
    v.set(value);
    return;
  }
  if (v.type !== 'Variant' && holdsObjects(v.type)) {
    setDefault(v.value, [], plain(value));
    return;
  }
  v.set(plain(value));
}

/**
 * `target = value` (Let) or `Set target = value`.
 *
 * Host objects: `Text1 = "x"` sets Text1's default member; `obj.name = v` and
 * `obj.name(args) = v` go through `memberSet`; `Command1(2) = v` sets the
 * default member of `item(2)` (or the default member with arguments when the
 * object has no `item`).
 */
export function* assign(f: Frame, target: Expr, value: VBValue, isSet: boolean, src?: Expr): Gen<void> {
  if (isSet && !isObjectValue(value)) throw new VBRuntimeError(424);
  switch (target.kind) {
    case 'name': {
      let b = bindingOf(f, target);
      if (b === undefined) b = implicitVariable(f, target);
      if (b instanceof Variable && !b.opts.isConst) {
        const text = src !== undefined && b.type === 'String' ? bigSingleText(f, src, value) : undefined;   // `t = s`: 1.234568E+07
        assignVariable(b, text ?? (src === undefined || !isSingleFrac(value) ? value : into(f, src, value, b.type)), isSet);
        // `v = CDbl(5)`: the Variant remembers the number's type for TypeName/VarType
        // (an operator node of Variant type tells nothing: skipped; a stale `sub` no longer matches the value)
        if (src !== undefined && b.type === 'Variant' && typeof value === 'number' && !((src.kind === 'binary' || src.kind === 'unary') && src.st === 'Variant')) {
          noteSubtype(f, b, src);
        }
        if (!isSet && b.type !== 'Variant' && holdsObjects(b.type)) yield* afterHostCall(f);
        return;
      }
      if (b instanceof ObjectRef && !isSet) {
        setDefault(b.obj, [], plain(src === undefined ? value : into(f, src, value, undefined)));
        yield* afterHostCall(f);
        return;
      }
      if (b instanceof ObjectRef && f.rt.host.setGlobalObject?.(target.name, value)) return;
      if (b instanceof MemberRef) {
        yield* memberSet(f, b.obj, b.name, [], src === undefined ? value : into(f, src, value, undefined), isSet);
        return;
      }
      if (b instanceof PropRef) { yield* propSet(f, b, [], value, isSet); return; }
      if (b instanceof ProcRef) throw compileError('Function call on left-hand side of assignment must return Variant or Object');
      throw compileError('Assignment to constant not permitted');
    }
    case 'call': {
      const t = target.target;
      let container: VBValue;
      if (t.kind === 'name') {
        const b = bindingOf(f, t, true);
        if (b instanceof MemberRef) {
          // `List(2) = "x"` in the form's code
          yield* memberSet(f, b.obj, b.name, yield* evalArgValues(f, target.args), src === undefined ? value : into(f, src, value, undefined), isSet);
          return;
        }
        if (b instanceof PropRef) { yield* propSet(f, b, yield* evalArgValues(f, target.args), value, isSet); return; }
        if (b instanceof Variable) container = b.value;
        else if (b instanceof ObjectRef) container = b.obj;
        else if (b === undefined) throw compileError('Sub or Function not defined');
        else throw compileError('Function call on left-hand side of assignment must return Variant or Object');
      } else if (t.kind === 'member' || t.kind === 'withMember') {
        const base = t.kind === 'member' ? yield* memberBase(f, t.object) : withObject(f);
        const moduleProp = base instanceof ModuleRef && !base.module.vars.has(lc(t.name)) && base.module.props.has(lc(t.name));
        if (moduleProp || (!(base instanceof ModuleRef) && !(base instanceof EnumRef) && isObject(base))) {
          // `List1.List(2) = "x"`, `Module1.Item(2) = "x"`
          yield* memberSet(f, base, t.name, yield* evalArgValues(f, target.args), src === undefined ? value : into(f, src, value, undefined), isSet);
          return;
        }
        container = yield* memberGet(f, base, t.name, null);
      } else {
        container = yield* evalExpr(f, t);
      }
      if (container instanceof VBArray) {
        const idx = yield* evalIndices(f, target.args);
        if (src !== undefined) value = into(f, src, value, container.elemType);
        if (!isSet) value = plain(value);
        container.set(idx, value instanceof VBRecord || value instanceof VBArray ? value.clone() : value);
        return;
      }
      if (container instanceof NothingT) throw new VBRuntimeError(91);
      if (container instanceof ClassValue) {   // `c(2) = v` / `Set c("k") = obj`: the class's default member
        const d = container.defaultMember;
        if (d === undefined) throw new VBRuntimeError(438);
        yield* classSet(f, container, d, yield* evalArgValues(f, target.args), value, isSet);
        return;
      }
      if (isObject(container) && isSet) {
        // `Set d(key) = obj`: the default member (Dictionary.Item) takes the reference
        if (container.defaultMember === undefined) throw compileError('Invalid use of property');
        const argv = yield* evalArgValues(f, target.args);
        if (classesInUse && !(container instanceof RefContainer)) escape(value);
        const wait = container.setMember(container.defaultMember, argv, value);
        if (wait instanceof Promise) yield* awaitHost(f, wait.then(() => Empty));
        else yield* afterHostCall(f);
        return;
      }
      if (isObject(container)) {
        const argv = yield* evalArgValues(f, target.args);
        if (src !== undefined) value = into(f, src, value, undefined);
        if (container.item && argv.length === 1) setDefault(container.item(toNumber(argv[0])), [], plain(value));
        else setDefault(container, argv, plain(value));
        yield* afterHostCall(f);
        return;
      }
      throw new VBRuntimeError(13);
    }
    case 'member': case 'withMember': {
      const base = target.kind === 'member' ? yield* memberBase(f, target.object) : withObject(f);
      yield* memberSet(f, base, target.name, [], src === undefined ? value : into(f, src, value, base, target.name), isSet);
      return;
    }
  }
  throw compileError('Expected: variable');
}

/**
 * `value` (of the expression `src`) for a slot of type `t` (undefined: a property; a record or module and a name: that
 * field or variable): a Single stays exact in a numeric slot and becomes its 7 shown digits anywhere else (a String or
 * Variant, a property).
 */
function into(f: Frame, src: Expr, value: VBValue, t: VBTypeName | undefined | VBValue | ModuleRef | EnumRef, name?: string): VBValue {
  if (!isSingleFrac(value) || staticType(f, src) !== 'Single') return value;
  let type: VBTypeName | undefined;
  if (name === undefined) type = t as VBTypeName | undefined;
  else if (t instanceof VBRecord) type = f.rt.typeInfo(t.typeName).fields.get(lc(name))?.type;
  else if (t instanceof ModuleRef) type = t.module.vars.get(lc(name))?.type;
  return type !== undefined && isNumericType(type) ? value : single7(value);
}

/**
 * `base.name(args) = value`. On a host object (the member must exist,
 * `hasMember`, else error 438):
 * - `Set`: `setMember(name, args, value)` with the reference;
 * - a Let: the member is read first (`getMember(name, args)`). If it holds an
 *   object (or Nothing):
 *   - an object value (or Nothing) is passed as it is (`Picture1.Picture = LoadPicture(f)`);
 *   - a plain value sets that object's default member (`Form1.Text1 = "x"`, `Text1.Font = "Arial"`).
 *   Otherwise `setMember(name, args, plain(value))`: an object value gives its
 *   default member (`Label1.Caption = Text1`; none: error 438).
 */
function* memberSet(f: Frame, base: VBValue | EnumRef | ModuleRef, name: string, args: VBValue[], value: VBValue, isSet: boolean): Gen<void> {
  if (base instanceof NothingT) throw new VBRuntimeError(91);
  if (base instanceof ClassValue) { yield* classSet(f, base, name, args, value, isSet); return; }
  if (!(base instanceof ModuleRef) && !(base instanceof EnumRef) && isObject(base)) {
    if (!base.hasMember(name)) throw new VBRuntimeError(438);
    if (classesInUse && !(base instanceof RefContainer)) escape(value);
    let wait: void | Promise<void> = undefined;   // a host may finish a property write later (MMControl1.Command = "Play" with Wait)
    if (isSet) wait = base.setMember(name, args, value);
    else if (base.codeProperty?.(name)) wait = base.setMember(name, args, isObjectValue(value) ? value : plain(value));
    else {
      let current: VBValue | undefined;
      try {
        current = base.getMember(name, args);
      } catch (e) {
        if (!(e instanceof VBRuntimeError)) throw e; // e.g. a write-only property: setMember decides
      }
      if (current !== undefined && isObjectValue(current)) {
        if (isObjectValue(value)) wait = base.setMember(name, args, value);
        else setDefault(current, [], value);
      } else {
        wait = base.setMember(name, args, plain(value));
      }
    }
    if (wait instanceof Promise) { yield* awaitHost(f, wait.then(() => Empty)); return; }
    yield* afterHostCall(f);
    return;
  }
  if (args.length > 0 && !(base instanceof ModuleRef)) throw new VBRuntimeError(424);
  if (base instanceof VBRecord) { setField(f.rt, base, lc(name), isSet ? value : plain(value)); return; }
  if (base instanceof ModuleRef) {
    const v = base.module.vars.get(lc(name));
    if (v) { assignVariable(v, value, isSet); return; }
    const p = base.module.props.get(lc(name));
    if (!p) throw compileError('Method or data member not found');
    yield* propSet(f, p, args, value, isSet);
    return;
  }
  if (base instanceof EnumRef) throw compileError('Assignment to constant not permitted');
  throw new VBRuntimeError(424);
}

/** Resolves a name to a Variable for For/ReDim/Erase targets (implicit declaration allowed). */
export function variableOf(f: Frame, e: NameExpr): Variable {
  let b = bindingOf(f, e);
  if (b === undefined) b = implicitVariable(f, e);
  if (!(b instanceof Variable) || b.opts.isConst) throw compileError('Variable required - can\'t assign to this expression');
  return b;
}
