// Statement execution.
//
// `execStmt` is the unit of execution: it marks the statement boundary
// (current line, End/slice/pause checks) and runs the statement inside a
// try. A failing statement goes to `handleError`, which can ask for the
// same statement to be run again (RETRY) — that is how Task 8's
// break-mode "Continue" re-executes a faulting statement. Loop conditions
// and the For increment are guarded the same way, so a retry never restarts
// a whole loop.
//
// Exit For/Do/Sub and GoTo travel as completion values, not exceptions.

import type {
  ArrayBound, CaseTest, ConstDecl, Expr, ForEachStmt, ForStmt, MissingArg, ProcDecl, SelectStmt, Stmt, VarDecl, VBTypeName,
} from '../ast';
import { VBRuntimeError } from '../errors';
import { PrintLine } from '../printFormat';
import { Empty, NothingT, NullT, VBArray, VBRef, compare, toNumber, type VBValue } from '../values';
import { EndSignal, nextTick, type Gen } from './driver';
import { Frame, ProcRef, Run, Variable, lc, storeValue, type Slot } from './scope';
import {
  afterHostCall, assign, callBuiltin, callProc, constExpr, evalArgValues, evalExpr, lookup, memberGet, variableOf, withObject,
} from './eval';
import { compareResult, isObject, plain, truthy } from './operators';
import { BuiltinRef, EnumRef, ModuleRef } from './scope';

/** VB's limit on nested procedure calls; one more is error 28 (Out of stack space). */
export const MAX_CALL_DEPTH = 2000;

const compileError = (msg: string) => VBRuntimeError.compile(msg);

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

/** `GoTo label` looking for its label in the enclosing blocks. */
export class GotoJump {
  constructor(readonly label: string) {}
}

export type Completion = undefined | 'exitFor' | 'exitDo' | 'exitProc' | GotoJump;

/** Returned by `handleError` to run the failing statement (or loop step) again. */
export const RETRY = Symbol('retry');
type ErrorOutcome = Completion | typeof RETRY;

const END = new EndSignal();

// ---------------------------------------------------------------------------
// Blocks and statement boundary
// ---------------------------------------------------------------------------

const labelCache = new WeakMap<Stmt[], Map<string, number>>();

function labelsOf(body: Stmt[]): Map<string, number> {
  let m = labelCache.get(body);
  if (!m) {
    m = new Map();
    for (let i = 0; i < body.length; i++) {
      const s = body[i];
      if (s.kind === 'label') m.set(lc(s.name), i);
    }
    labelCache.set(body, m);
  }
  return m;
}

const procLabelCache = new WeakMap<ProcDecl, Set<string>>();

/** All label names anywhere in a procedure. */
function procLabels(p: ProcDecl): Set<string> {
  let set = procLabelCache.get(p);
  if (set) return set;
  set = new Set();
  const walk = (body: Stmt[] | undefined) => {
    if (!body) return;
    for (const s of body) {
      switch (s.kind) {
        case 'label': set!.add(lc(s.name)); break;
        case 'if': s.branches.forEach(b => walk(b.body)); walk(s.elseBody); break;
        case 'select': s.cases.forEach(c => walk(c.body)); walk(s.elseBody); break;
        case 'for': case 'forEach': case 'do': case 'while': case 'with': walk(s.body); break;
      }
    }
  };
  walk(p.body);
  procLabelCache.set(p, set);
  return set;
}

export function* execBlock(f: Frame, body: Stmt[]): Gen<Completion> {
  let i = 0;
  while (i < body.length) {
    const c = yield* execStmt(f, body[i]);
    if (c === undefined) { i++; continue; }
    if (c instanceof GotoJump) {
      const target = labelsOf(body).get(c.label);
      if (target !== undefined) { i = target + 1; continue; }
    }
    return c;
  }
  return undefined;
}

/**
 * Statement boundary (every statement, and every loop iteration so that an
 * empty `Do: Loop` can be stopped): sets the current line and counts the
 * boundary; true when `boundary()` must run: stop on End, give the event
 * loop a turn every `sliceSize` boundaries, enter break mode on a pause request.
 */
function atBoundary(f: Frame, line: number): boolean {
  const rt = f.run.rt;
  f.line = line;
  return ++rt.stmtCount >= rt.sliceSize || rt.stopping || rt.pauseRequested;
}

/** The slow part of a boundary, when `atBoundary` returned true. */
function* boundary(f: Frame): Gen<void> {
  const rt = f.run.rt;
  if (rt.stopping) throw END;
  if (rt.stmtCount >= rt.sliceSize) {
    rt.stmtCount = 0;
    // A time slice is not an event pump: events arriving now are queued (Runtime.slicing).
    rt.slicing++;
    try {
      yield nextTick();
    } finally {
      rt.slicing--;
    }
    if (rt.stopping) throw END;
  }
  if (rt.pauseRequested) yield* pauseHere(f);
}

/** Runs one statement: boundary checks, then the statement with error handling (and retry). */
export function* execStmt(f: Frame, s: Stmt): Gen<Completion> {
  if (atBoundary(f, s.line)) yield* boundary(f);
  for (;;) {
    try {
      return yield* execInner(f, s);
    } catch (e) {
      const r = yield* handleError(f, e);
      if (r !== RETRY) return r;
      f.line = s.line;
    }
  }
}

/** Evaluates a loop/branch condition belonging to `line`, with the statement's error handling. */
function* guardedCond(f: Frame, line: number, e: Expr): Gen<boolean> {
  for (;;) {
    f.line = line;
    try {
      return truthy(yield* evalExpr(f, e));
    } catch (err) {
      const r = yield* handleError(f, err);
      if (r !== RETRY) throw new Error('guardedCond: unsupported error outcome'); // Task 8: Resume Next / GoTo handler
    }
  }
}

/**
 * A run-time error escaped a statement in frame `f`. Task 5 has no On Error
 * yet: every error is unhandled, goes to `host.onRuntimeError` and ends the
 * program. Task 8 adds handler lookup (this frame, then callers) and break
 * mode, where 'continue' returns RETRY.
 */
export function* handleError(f: Frame, e: unknown): Gen<ErrorOutcome> {
  if (e instanceof EndSignal) throw e;
  let err: VBRuntimeError;
  if (e instanceof VBRuntimeError) err = e;
  else if (e instanceof RangeError && /call stack/i.test(e.message)) err = new VBRuntimeError(28);
  else throw e;
  return yield* unhandledError(f, err);
}

function* unhandledError(f: Frame, err: VBRuntimeError): Gen<ErrorOutcome> {
  const rt = f.run.rt;
  if (rt.stopping) throw END;
  yield rt.host.onRuntimeError(err, f.location());
  // 'debug' (break mode, Continue = RETRY) is Task 8; for now both answers end the program.
  rt.endProgram();
  throw END;
}

/** Break mode at the current statement (Stop, requestPause). 'end' ends the program. */
export function* enterBreak(f: Frame, reason: 'error' | 'pause', error?: VBRuntimeError): Gen<void> {
  const rt = f.run.rt;
  rt.state = 'break';
  rt.breakFrame = f;
  let answer: 'continue' | 'end';
  try {
    answer = (yield rt.host.onBreak({ reason, at: f.location(), error })) as 'continue' | 'end';
  } finally {
    rt.breakFrame = undefined;
  }
  if (rt.stopping) throw END;
  if (answer === 'end') {
    rt.endProgram();
    throw END;
  }
  rt.state = 'running';
}

function* pauseHere(f: Frame): Gen<void> {
  f.run.rt.pauseRequested = false;
  yield* enterBreak(f, 'pause');
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

/** An argument bound by the caller: a by-reference slot (with the slot's declared type, if any), a value, or omitted. */
export type BoundArg =
  | { slot: Slot; type?: VBTypeName; isArray?: boolean }
  | { value: VBValue }
  | typeof MISSING;
export const MISSING = Symbol('missing');

function sameType(a: VBTypeName, b: VBTypeName): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if ('userType' in a && 'userType' in b) return lc(a.userType) === lc(b.userType);
  if ('objectType' in a && 'objectType' in b) return lc(a.objectType) === lc(b.objectType);
  return false;
}

/** Runs a Sub/Function body in a new frame (run by the driver as a SubCall). */
export function* invokeProc(run: Run, ref: ProcRef, args: BoundArg[]): Gen<VBValue> {
  const rt = run.rt;
  if (run.frames.length >= MAX_CALL_DEPTH) throw new VBRuntimeError(28);
  const { module, proc } = ref;
  const f = new Frame(run, module, proc, proc.line);
  if (args.length > proc.params.length) throw compileError('Wrong number of arguments or invalid property assignment');
  for (let i = 0; i < proc.params.length; i++) {
    const p = proc.params[i];
    let a = args[i];
    if ((a === undefined || a === MISSING) && !p.optional) throw compileError('Argument not optional');
    if (a !== undefined && a !== MISSING && 'slot' in a && !p.byRef) a = { value: a.slot.value };
    const type = rt.resolveType(p.type, module);
    let v: Variable;
    if (a === undefined || a === MISSING) {
      if (p.isArray) v = new Variable(p.name, type, new VBRef(rt.unallocatedArray(type)), { isArray: true });
      else {
        const dv = p.defaultValue ? constExpr(rt.moduleFrame(module), p.defaultValue) : rt.defaultFor(type);
        v = new Variable(p.name, type, new VBRef(storeValue(dv, type)));
      }
    } else if ('slot' in a) {
      if (p.isArray) {
        if (!(a.slot.value instanceof VBArray)) throw new VBRuntimeError(13);
        v = new Variable(p.name, type, a.slot, { isArray: true });
      } else if (a.type === undefined) {
        // untyped reference from the host (event arguments): convert in place and share
        a.slot.value = storeValue(a.slot.value, type);
        v = new Variable(p.name, type, a.slot);
      } else if (sameType(a.type, type) || type === 'Variant') {
        // shared: assignments convert to the caller's declared type (an array stays an array)
        v = new Variable(p.name, a.type, a.slot, { isArray: a.isArray });
      } else {
        v = new Variable(p.name, type, new VBRef(storeValue(a.slot.value, type)));
      }
    } else if (p.isArray) {
      if (!(a.value instanceof VBArray)) throw new VBRuntimeError(13);
      v = new Variable(p.name, type, new VBRef(a.value.clone()), { isArray: true });
    } else {
      v = new Variable(p.name, type, new VBRef(storeValue(a.value, type)));
    }
    f.locals.set(lc(p.name), v);
  }
  if (proc.kind === 'function') {
    const t = rt.resolveType(proc.returnType, module);
    f.returnVar = new Variable(proc.name, t, new VBRef(rt.defaultFor(t)));
    f.locals.set(lc(proc.name), f.returnVar);
  }
  run.frames.push(f);
  try {
    yield* declareLocals(f);
    const c = yield* execBlock(f, proc.body);
    // a GoTo whose label is inside a block it is not in (e.g. into a loop body)
    if (c instanceof GotoJump) throw compileError('GoTo into a block is not supported');
  } finally {
    run.frames.pop();
  }
  return f.returnVar ? f.returnVar.value : Empty;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** Evaluates `Dim`/`ReDim` bounds (lower bound defaults to 0). */
export function* evalBounds(f: Frame, bounds: ArrayBound[]): Gen<[number, number][]> {
  const out: [number, number][] = [];
  for (const b of bounds) {
    const lo = b.lower ? toNumber(yield* evalExpr(f, b.lower)) : 0;
    const hi = toNumber(yield* evalExpr(f, b.upper));
    out.push([lo, hi]);
  }
  return out;
}

/** Creates the variable for a declaration (default value, fixed or dynamic array). */
export function* declareVariable(f: Frame, d: VarDecl): Gen<Variable> {
  const rt = f.run.rt;
  const type = rt.resolveType(d.type, f.module);
  if (d.isArray) {
    if (d.bounds) {
      const arr = rt.newArray(type, yield* evalBounds(f, d.bounds), true);
      return new Variable(d.name, type, new VBRef(arr), { isArray: true, fixedArray: true });
    }
    return new Variable(d.name, type, new VBRef(rt.unallocatedArray(type)), { isArray: true });
  }
  return new Variable(d.name, type, new VBRef(rt.defaultFor(type, d.fixedLength)), { fixedLength: d.fixedLength });
}

type LocalDecl = { kind: 'dim'; decl: VarDecl } | { kind: 'const'; decl: ConstDecl };

const localDeclCache = new WeakMap<ProcDecl, LocalDecl[]>();

/** Every Dim/Static/Const anywhere in a procedure body, in source order. */
function localDecls(p: ProcDecl): LocalDecl[] {
  let list = localDeclCache.get(p);
  if (list) return list;
  const out: LocalDecl[] = [];
  const walk = (body: Stmt[] | undefined) => {
    if (!body) return;
    for (const s of body) {
      switch (s.kind) {
        case 'dim': for (const d of s.decls) out.push({ kind: 'dim', decl: d }); break;
        case 'const': for (const d of s.decls) out.push({ kind: 'const', decl: d }); break;
        case 'if': s.branches.forEach(b => walk(b.body)); walk(s.elseBody); break;
        case 'select': s.cases.forEach(c => walk(c.body)); walk(s.elseBody); break;
        case 'for': case 'forEach': case 'do': case 'while': case 'with': walk(s.body); break;
      }
    }
  };
  walk(p.body);
  list = out;
  localDeclCache.set(p, list);
  return list;
}

/**
 * VB declares a procedure's locals for the whole procedure, wherever the
 * Dim/Static/Const line is (a branch not taken, after a GoTo, in a loop that
 * never runs). This runs at procedure entry, in source order: fixed-array
 * bounds and Const values are evaluated here, Static variables come from the
 * static store (all locals of a `Static Sub`). A name that is already a
 * parameter (or the function result) is left alone. The Dim/Const
 * statements themselves do nothing when they run, so a Dim inside a loop
 * keeps its value. Each declaration is guarded like a statement (its line,
 * retry on Continue).
 */
function* declareLocals(f: Frame): Gen<void> {
  const proc = f.proc!;
  const rt = f.run.rt;
  for (const item of localDecls(proc)) {
    const d = item.decl;
    const key = lc(d.name);
    if (f.locals.has(key)) continue;
    for (;;) {
      f.line = d.line;
      try {
        if (item.kind === 'const') {
          const value = yield* evalExpr(f, item.decl.value);
          const type = rt.resolveType(item.decl.type, f.module);
          f.locals.set(key, new Variable(d.name, type, new VBRef(storeValue(value, type)), { isConst: true }));
        } else if (item.decl.scope === 'static' || proc.isStatic) {
          const store = rt.staticStore(proc);
          let v = store.get(key);
          if (!v) {
            v = yield* declareVariable(f, item.decl);
            store.set(key, v);
          }
          f.locals.set(key, v);
        } else {
          f.locals.set(key, yield* declareVariable(f, item.decl));
        }
        break;
      } catch (e) {
        const r = yield* handleError(f, e);
        if (r !== RETRY) throw new Error('declareLocals: unsupported error outcome'); // Task 8
      }
    }
  }
  f.line = proc.line;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function* execInner(f: Frame, s: Stmt): Gen<Completion> {
  const rt = f.run.rt;
  switch (s.kind) {
    case 'assign': {
      const value = yield* evalExpr(f, s.value);
      yield* assign(f, s.target, value, s.isSet);
      return;
    }
    case 'call': return yield* execCall(f, s.target, s.args);
    case 'debugPrint': {
      const line = new PrintLine(rt.printColumn);
      for (const it of s.items) {
        if (it.expr) line.addItem(yield* evalExpr(f, it.expr));
        if (it.sep === ';') line.addSemicolon();
        else if (it.sep === ',') line.addComma();
      }
      const last = s.items[s.items.length - 1];
      const newline = last === undefined || last.sep === undefined;
      const text = line.text();
      rt.printColumn = newline ? 0 : rt.printColumn + text.length;
      rt.host.debugPrint(text, newline);
      return;
    }
    case 'if': {
      for (const b of s.branches) {
        if (yield* guardedCond(f, b.line, b.cond)) return yield* execBlock(f, b.body);
      }
      return s.elseBody ? yield* execBlock(f, s.elseBody) : undefined;
    }
    case 'select': return yield* execSelect(f, s);
    case 'for': return yield* execFor(f, s);
    case 'forEach': return yield* execForEach(f, s);
    case 'do': {
      const t = s.test;
      for (let first = true; ; first = false) {
        if (!first && atBoundary(f, s.line)) yield* boundary(f);
        if (t && !t.atEnd && (yield* guardedCond(f, s.line, t.expr)) !== (t.mode === 'while')) return;
        const c = yield* execBlock(f, s.body);
        if (c === 'exitDo') return;
        if (c !== undefined) return c;
        if (t && t.atEnd && (yield* guardedCond(f, s.line, t.expr)) !== (t.mode === 'while')) return;
      }
    }
    case 'while': {
      while (yield* guardedCond(f, s.line, s.cond)) {
        const c = yield* execBlock(f, s.body);
        if (c !== undefined) return c;
        if (atBoundary(f, s.line)) yield* boundary(f);
      }
      return;
    }
    case 'exit': return s.what === 'for' ? 'exitFor' : s.what === 'do' ? 'exitDo' : 'exitProc';
    case 'dim': case 'const': return; // declared at procedure entry (declareLocals)
    case 'redim': {
      for (const d of s.decls) {
        const bounds = yield* evalBounds(f, d.bounds);
        const key = lc(d.name);
        let v = lookup(f, key, d.name);
        if (v === undefined) {
          // ReDim of an undeclared name declares a local dynamic array
          const type = rt.resolveType(d.type, f.module);
          const nv = new Variable(d.name, type, new VBRef(rt.unallocatedArray(type)), { isArray: true });
          f.locals.set(key, nv);
          v = nv;
        }
        if (!(v instanceof Variable) || v.opts.isConst) throw compileError('Expected: array');
        const cur = v.value;
        if (cur instanceof VBArray) cur.redim(bounds, s.preserve);
        else if (v.type === 'Variant') v.ref.value = rt.newArray(rt.resolveType(d.type, f.module), bounds, false);
        else throw compileError('Expected: array');
      }
      return;
    }
    case 'erase': {
      for (const t of s.targets) {
        const v = variableOf(f, t);
        const cur = v.value;
        if (!(cur instanceof VBArray)) throw new VBRuntimeError(13);
        if (!v.opts.isArray) v.ref.value = Empty;
        else if (cur.fixed) v.ref.value = rt.newArray(cur.elemType, cur.bounds, true);
        else v.ref.value = rt.unallocatedArray(cur.elemType);
      }
      return;
    }
    case 'with': {
      const obj = yield* evalExpr(f, s.object);
      if (obj instanceof NothingT) throw new VBRuntimeError(91);
      f.withStack.push(obj);
      try {
        return yield* execBlock(f, s.body);
      } finally {
        f.withStack.pop();
      }
    }
    case 'label': return;
    case 'goto': {
      const label = lc(s.label);
      if (!f.proc || !procLabels(f.proc).has(label)) throw compileError('Label not defined');
      return new GotoJump(label);
    }
    case 'end':
      rt.endProgram();
      throw END;
    case 'stop':
      yield* enterBreak(f, 'pause');
      return;
    case 'unload': case 'load': {
      const obj = yield* evalExpr(f, s.target);
      if (obj instanceof NothingT) throw new VBRuntimeError(91);
      if (!isObject(obj)) throw new VBRuntimeError(424);
      const r = obj.callMethod(s.kind === 'unload' ? 'Unload' : 'Load', []);
      if (r instanceof Promise) yield r;
      else yield* afterHostCall(f);
      return;
    }
    case 'onError': case 'resume':
      throw compileError(`${s.kind === 'onError' ? 'On Error' : 'Resume'} is not supported yet`); // Task 8
  }
}

/** A call statement: `Foo 1, 2`, `Call Foo(1)`, `obj.Method x`. */
function* execCall(f: Frame, target: Expr, args: (Expr | MissingArg)[]): Gen<Completion> {
  if (target.kind === 'name') {
    const key = lc(target.name);
    // Inside Function Foo, a `Foo` statement is a recursive call.
    if (f.returnVar && key === lc(f.proc!.name)) { yield* callProc(f, f.module.procs.get(key)!, args); return; }
    const b = key === 'me' ? undefined : lookup(f, key, target.name);
    if (b instanceof ProcRef) { yield* callProc(f, b, args); return; }
    if (b instanceof BuiltinRef) { yield* callBuiltin(f, b, args); return; }
    if (b === undefined) throw compileError('Sub or Function not defined');
    throw compileError('Expected Sub, Function, or Property');
  }
  if (target.kind === 'member' || target.kind === 'withMember') {
    let base: VBValue | EnumRef | ModuleRef;
    if (target.kind === 'withMember') base = withObject(f);
    else if (target.object.kind === 'name') {
      const o = target.object;
      const key = lc(o.name);
      const b = key === 'me' ? undefined : lookup(f, key, o.name);
      if (b instanceof ModuleRef || b instanceof EnumRef) base = b;
      else base = yield* evalExpr(f, o);
    } else base = yield* evalExpr(f, target.object);
    if (base instanceof ModuleRef) {
      yield* memberGet(f, base, target.name, args);
      return;
    }
    if (base instanceof EnumRef) throw new VBRuntimeError(438);
    if (base instanceof NothingT) throw new VBRuntimeError(91);
    if (isObject(base)) {
      const argv = yield* evalArgValues(f, args);
      const r = base.callMethod(target.name, argv);
      if (r instanceof Promise) yield r;
      else yield* afterHostCall(f);
      return;
    }
    throw new VBRuntimeError(424);
  }
  throw compileError('Expected Sub, Function, or Property');
}

function* caseMatches(f: Frame, subject: VBValue, t: CaseTest): Gen<boolean> {
  // Null never matches (the comparison is Null, i.e. not True)
  const cmp = (v: VBValue, op: string) => {
    const a = plain(subject);
    const b = plain(v);
    if (a instanceof NullT || b instanceof NullT) return false;
    return compareResult(op, compare(a, b));
  };
  switch (t.kind) {
    case 'value': return cmp(yield* evalExpr(f, t.value), '=');
    case 'is': return cmp(yield* evalExpr(f, t.value), t.op);
    case 'range': {
      const lo = yield* evalExpr(f, t.from);
      const hi = yield* evalExpr(f, t.to);
      return cmp(lo, '>=') && cmp(hi, '<=');
    }
  }
}

function* execSelect(f: Frame, s: SelectStmt): Gen<Completion> {
  const subject = yield* evalExpr(f, s.subject);
  for (const c of s.cases) {
    let hit = false;
    for (;;) {
      f.line = c.line;
      try {
        for (const t of c.tests) {
          if (yield* caseMatches(f, subject, t)) { hit = true; break; }
        }
        break;
      } catch (e) {
        const r = yield* handleError(f, e);
        if (r !== RETRY) throw new Error('execSelect: unsupported error outcome'); // Task 8
      }
    }
    if (hit) return yield* execBlock(f, c.body);
  }
  return s.elseBody ? yield* execBlock(f, s.elseBody) : undefined;
}

const NUMERIC_TYPES = new Set(['Integer', 'Long', 'Byte', 'Single', 'Double', 'Currency']);

function* execFor(f: Frame, s: ForStmt): Gen<Completion> {
  const v = variableOf(f, s.variable);
  const from = yield* evalExpr(f, s.from);
  // VB converts end and step to the counter's type once, before the loop (overflow 6 here)
  const ct = NUMERIC_TYPES.has(v.type as string) ? v.type : 'Variant';
  const to = toNumber(storeValue(yield* evalExpr(f, s.to), ct));
  const step = s.step ? toNumber(storeValue(yield* evalExpr(f, s.step), ct)) : 1;
  v.set(from);
  for (;;) {
    const cur = toNumber(v.value);
    if (step >= 0 ? cur > to : cur < to) return;
    const c = yield* execBlock(f, s.body);
    if (c === 'exitFor') return;
    if (c !== undefined) return c;
    if (atBoundary(f, s.line)) yield* boundary(f);
    // the increment belongs to the For statement; a failure is retried on its own
    for (;;) {
      f.line = s.line;
      try {
        v.set(toNumber(v.value) + step);
        break;
      } catch (e) {
        const r = yield* handleError(f, e);
        if (r !== RETRY) throw new Error('execFor: unsupported error outcome'); // Task 8
      }
    }
  }
}

function* execForEach(f: Frame, s: ForEachStmt): Gen<Completion> {
  const v = variableOf(f, s.variable);
  const coll = plainCollection(yield* evalExpr(f, s.collection));
  for (const item of coll) {
    // the element assignment belongs to the For Each statement; a failure is retried on its own
    for (;;) {
      f.line = s.line;
      try {
        v.set(item);
        break;
      } catch (e) {
        const r = yield* handleError(f, e);
        if (r !== RETRY) throw new Error('execForEach: unsupported error outcome'); // Task 8
      }
    }
    const c = yield* execBlock(f, s.body);
    if (c === 'exitFor') return;
    if (c !== undefined) return c;
    if (atBoundary(f, s.line)) yield* boundary(f);
  }
  return;
}

/** Elements of a For Each collection, in VB order (first index varies fastest). */
function plainCollection(v: VBValue): VBValue[] {
  if (!(v instanceof VBArray)) throw new VBRuntimeError(v instanceof NothingT ? 91 : 13); // objects: Task 7
  if (!v.allocated) throw new VBRuntimeError(9);
  const b = v.bounds;
  if (b.length === 1) return v.values();
  const out: VBValue[] = [];
  const idx = b.map(x => x[0]);
  const total = v.size;
  for (let n = 0; n < total; n++) {
    out.push(v.get(idx));
    for (let d = 0; d < b.length; d++) {
      if (idx[d] < b[d][1]) { idx[d]++; break; }
      idx[d] = b[d][0];
    }
  }
  return out;
}
