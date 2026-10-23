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
  AlignStmt, ArrayBound, CaseTest, CompareOp, ConstDecl, DebugAssertStmt, ErrorStmt, Expr, ForEachStmt, ForStmt, GotoStmt, LabelStmt, MidStmt, MissingArg,
  OnGotoStmt, ProcDecl, ReturnStmt, SelectStmt, Stmt, VarDecl, VBTypeName,
} from '../ast';
import { VBRuntimeError, internalError } from '../errors';
import { PrintLine } from '../printFormat';
import {
  Empty, Missing, NothingT, NullT, VBArray, VBRecord, VBRef, bankers, compare, isObject, maybeSingle, single7, toNumber, toStr, type VBValue,
} from '../values';
import { EndSignal, SubCall, nextTick, type Gen } from './driver';
import { execFileStmt, printItems } from './fileStmts';
import { execGraphics } from './gfxStmts';
import {
  AutoNewSlot, ClassInstance, ClassValue, Frame, ProcRef, PropRef, Run, Variable, classesInUse, lc, rawValue, release, retain, storeValue,
  type Slot,
} from './scope';
import {
  afterHostCall, assign, awaitHost, callBuiltin, callProc, classCall, constExpr, evalArgValues, evalExpr, formMethod, hostRefs, lookup,
  memberGet, methodArgs, objectFactory, shownArgs, textBinary, variableOf, withObject,
} from './eval';
import { compareResult, plain, truthy } from './operators';
import { shown, type StaticType } from './staticTypes';
import { BuiltinRef, EnumRef, MemberRef, ModuleRef } from './scope';
import type { VBObject } from '../host';

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

/**
 * A `Resume` statement in an error handler, travelling up to the handler's
 * root in `runHandler` (which turns it into RETRY, RESUME_NEXT or a GotoJump).
 */
export class ResumeJump {
  constructor(readonly mode: 'resume' | 'next' | 'label', readonly label = '') {}
}

/** `'return'`: a `Return` going back to its GoSub (`gosub`). */
export type Completion = undefined | 'exitFor' | 'exitDo' | 'exitProc' | 'return' | GotoJump | ResumeJump;

/** Returned by `handleError` to run the failing statement (or loop step) again (Resume, Continue). */
export const RETRY = Symbol('retry');
/** Returned by `handleError` to go on after the failing statement (Resume Next, On Error Resume Next). */
export const RESUME_NEXT = Symbol('resumeNext');
type ErrorOutcome = Completion | typeof RETRY | typeof RESUME_NEXT;

/**
 * Thrown by a guarded part of a statement (a loop or If condition) whose error
 * handler ended in a completion (Exit Sub, Resume label): the statement's
 * `execStmt` returns that completion.
 */
class Unwind {
  constructor(readonly completion: Completion) {}
}

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

/** A label that is a line number (`20`), which `Erl` reports. */
const isLineNumber = (name: string): boolean => name.charCodeAt(0) <= 57;

/** Index of a GoTo's label in `body` (undefined: not in this block); passing a line number label counts for Erl. */
function jumpTo(f: Frame, body: Stmt[], label: string): number | undefined {
  const target = labelsOf(body).get(label);
  if (target !== undefined) {
    const name = (body[target] as LabelStmt).name;
    if (isLineNumber(name)) f.lastLine = +name;
  }
  return target;
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

export function* execBlock(f: Frame, body: Stmt[], start = 0): Gen<Completion> {
  let i = start;
  while (i < body.length) {
    const c = yield* execStmt(f, body[i]);
    if (c === undefined) { i++; continue; }
    if (c instanceof GotoJump) {
      const target = jumpTo(f, body, c.label);
      if (target !== undefined) { i = target + 1; continue; }
    }
    return c;
  }
  return undefined;
}

/**
 * Statement boundary (every statement, and every loop iteration so that an
 * empty `Do: Loop` can be stopped): sets the current line and counts the
 * boundary; true when `boundary()` must run: stop on End, check the clock
 * every `sliceSize` boundaries (a time slice when `sliceMs` have passed since
 * the last one), enter break mode on a pause request.
 */
function atBoundary(f: Frame, line: number): boolean {
  const rt = f.run.rt;
  if (f.line !== line) {
    f.line = line;
    // a breakpoint is checked only when the line changes (not on every pass of a one-line loop)
    const bp = f.module.breakpoints;
    if (bp !== null && bp.has(line) && !f.run.immediate) rt.pauseRequested = true;
  }
  // stepping (Step Into/Over/Out): one comparison of the call depth
  return ++rt.stmtCount >= rt.sliceSize || rt.stopping || rt.pauseRequested || rt.callDepth <= rt.stepDepth;
}

/**
 * The slow part of a boundary, when `atBoundary` returned true. `stoppable`
 * is false for statements a step never stops at (Dim, Const, labels).
 */
function* boundary(f: Frame, stoppable = true): Gen<void> {
  const rt = f.run.rt;
  if (rt.stopping) throw END;
  if (rt.stmtCount >= rt.sliceSize && rt.sliceDue()) {
    // A time slice is not an event pump: events arriving now are queued (Runtime.slicing).
    rt.slicing++;
    try {
      // count-based slices (an explicit sliceSize, tests) keep the plain setTimeout(0) turn: every timer queued before runs first
      yield rt.sliceMs > 0 ? nextTick() : new Promise<void>(r => setTimeout(r, 0));
    } finally {
      rt.slicing--;
      rt.sliced();
    }
    if (rt.stopping) throw END;
  }
  // Immediate commands never break (the program may already be in break mode)
  if (f.run.immediate) return;
  if (rt.pauseRequested || (stoppable && rt.callDepth <= rt.stepDepth)) yield* pauseHere(f);
}

const notStoppable = (s: Stmt) => s.kind === 'dim' || s.kind === 'const' || s.kind === 'label';

/** Runs one statement: boundary checks, then the statement with error handling (and retry). */
export function* execStmt(f: Frame, s: Stmt): Gen<Completion> {
  if (atBoundary(f, s.line)) yield* boundary(f, !notStoppable(s));
  for (;;) {
    try {
      const c = yield* execInner(f, s);
      // objects whose last reference went away in this statement terminate now (Class_Terminate)
      const rt = f.run.rt;
      if (rt.dying !== null) yield* reap(f.run, rt.callDepth);
      return c;
    } catch (e) {
      if (e instanceof Unwind) return e.completion;
      const r = yield* handleError(f, e);
      if (r === RETRY) { f.line = s.line; continue; }
      if (r === RESUME_NEXT) return undefined;
      return r;
    }
  }
}

/**
 * Evaluates a loop/branch condition belonging to `line`, with the statement's
 * error handling. `onResumeNext` is the value used when the error is resumed
 * with Resume Next: VB6 goes on with the next statement in the source, so an
 * If/ElseIf/While/Do While condition counts as True (its body follows) and a
 * `Loop While/Until` test leaves the loop.
 */
function* guardedCond(f: Frame, line: number, e: Expr, onResumeNext: boolean): Gen<boolean> {
  for (;;) {
    f.line = line;
    try {
      return truthy(yield* evalExpr(f, e));
    } catch (err) {
      const r = yield* handleError(f, err);
      if (r === RETRY) continue;
      if (r === RESUME_NEXT) return onResumeNext;
      throw new Unwind(r);
    }
  }
}

/** Errors on their way to a handler in a caller, with the frame they are leaving (its outer statements let them pass). */
const propagating = new WeakMap<VBRuntimeError, Frame>();

/** A frame whose handler can take an error now: `On Error` is on and its GoTo handler is not already running. */
function canHandle(fr: Frame): boolean {
  return fr.onError !== 'none' && !fr.inHandler;
}

/**
 * A run-time error escaped a statement (or a guarded loop step) in frame `f`.
 * VB6 rules:
 * - `f` has an active handler: Resume Next goes on after the statement; a
 *   GoTo handler runs (`runHandler`) and its Resume decides what happens.
 * - otherwise, if a caller in the same run has an active handler, the error
 *   is rethrown (marked, so `f`'s outer statements let it pass) and the
 *   caller's statement handles it: Resume re-runs the call, Resume Next
 *   skips it.
 * - otherwise it is unhandled, reported at the innermost line: 'end' ends
 *   the program, 'debug' enters break mode and Continue retries (RETRY).
 * Compile errors are never handled by On Error. In an Immediate command an
 * unhandled error is rethrown to the command (no report, no break mode).
 * A JS stack overflow is error 28; any other plain JS error (host code, a
 * built-in, an interpreter bug) is error 51 "Internal error: <message>".
 */
export function* handleError(f: Frame, e: unknown): Gen<ErrorOutcome> {
  if (e instanceof EndSignal || e instanceof Unwind) throw e;
  let err: VBRuntimeError;
  if (e instanceof VBRuntimeError) err = e;
  else if (isStackOverflow(e)) err = new VBRuntimeError(28);
  else err = internalError(e); // a JS error from host code (sync or a rejected promise), a built-in or the interpreter
  if (propagating.get(err) === f) throw err;
  propagating.delete(err);
  const rt = f.run.rt;
  if (rt.stopping) throw END;
  if (!err.compile) {
    if (canHandle(f)) return yield* runHandler(f, err);
    const frames = f.run.frames;
    for (let i = frames.lastIndexOf(f) - 1; i >= 0; i--) {
      if (canHandle(frames[i])) {
        propagating.set(err, f);
        throw err;
      }
    }
  }
  if (f.run.immediate) throw err;
  return yield* unhandledError(f, err);
}

/**
 * Runs `f`'s active error handler for `err`. On Error Resume Next: go on
 * after the statement. On Error GoTo label: the code after the label runs
 * (inside the failing statement's error handling, so the statement's place is
 * kept); then
 * - `Resume` gives RETRY (the statement runs again),
 * - `Resume Next` gives RESUME_NEXT,
 * - `Resume label` gives a GotoJump to that label,
 * - Exit Sub/Function or reaching End Sub/Function ends the procedure.
 */
function* runHandler(f: Frame, err: VBRuntimeError): Gen<ErrorOutcome> {
  f.rt.err.setFrom(err, f.lastLine);
  if (f.onError === 'resumeNext') return RESUME_NEXT;
  const body = f.proc!.body;
  const at = labelsOf(body).get(f.handlerLabel)!;
  f.inHandler = true;
  const c = yield* execBlock(f, body, at + 1);
  if (c instanceof ResumeJump) {
    if (c.mode === 'resume') return RETRY;
    if (c.mode === 'next') return RESUME_NEXT;
    return new GotoJump(c.label);
  }
  // a GoTo from the handler code to a label inside a block
  if (c instanceof GotoJump) throw compileError('GoTo into a block is not supported');
  return 'exitProc';
}

/**
 * A JS stack overflow (V8/JavaScriptCore: RangeError "Maximum call stack size
 * exceeded"). Uses no regex: this runs when the stack is nearly exhausted.
 */
export function isStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && e.message.indexOf('call stack') >= 0;
}

/**
 * An unhandled error at the current statement of `f`: `host.onRuntimeError`.
 * 'end' ends the program; 'debug' enters break mode, where Continue returns
 * RETRY (the statement runs again) and End ends the program. Err holds the
 * error meanwhile (`? Err.Number` in the Immediate window).
 */
function* unhandledError(f: Frame, err: VBRuntimeError): Gen<ErrorOutcome> {
  const rt = f.run.rt;
  if (rt.stopping) throw END;
  rt.err.setFrom(err, f.lastLine);
  let answer: 'end' | 'debug';
  // no event pump while the error is reported (events are dropped, like in break mode)
  rt.eventsSuspended++;
  try {
    answer = (yield rt.host.onRuntimeError(err, f.location())) as 'end' | 'debug';
  } catch (e) {
    if (e instanceof EndSignal) throw e;
    // a failing onRuntimeError (host bug): the program ends
    console.error('VibeBasic: onRuntimeError failed', e);
    answer = 'end';
  } finally {
    rt.eventsSuspended--;
  }
  if (rt.stopping) throw END;
  if (answer === 'debug') {
    yield* enterBreak(f, 'error', err);
    return RETRY;
  }
  rt.endProgram();
  throw END;
}

/**
 * Break mode at the current statement of `f` (an error with 'debug', Stop,
 * requestPause): state 'break', `f` is the frame the Immediate window sees,
 * and events are dropped (no event pump) until `host.onBreak` answers.
 * 'continue' goes on; 'end' (or End meanwhile) ends the program. A rejected
 * or throwing onBreak ends the program for reason 'error' and goes on for 'pause'. A pending pause request is consumed. Ignored in an Immediate
 * command (Stop there does nothing).
 */
export function* enterBreak(f: Frame, reason: 'error' | 'pause', error?: VBRuntimeError): Gen<void> {
  const rt = f.run.rt;
  if (f.run.immediate) return;
  rt.pauseRequested = false; // this break answers a pending pause request too
  rt.stopDebugging(); // a step or Run To Cursor ends at any break
  rt.state = 'break';
  rt.breakFrame = f;
  rt.eventsSuspended++;
  let answer: 'continue' | 'end' = 'continue';
  try {
    let asked: Promise<'continue' | 'end'>;
    try {
      asked = Promise.resolve(rt.host.onBreak({ reason, at: f.location(), error }));
    } catch (e) {
      asked = Promise.reject(e);
    }
    try {
      answer = (yield asked) as 'continue' | 'end';
    } catch (e) {
      if (e instanceof EndSignal) throw e;
      // A failing onBreak: after an error, continuing would re-run the failing
      // statement (and fail again), so the program ends; a pause/Stop goes on.
      answer = reason === 'error' ? 'end' : 'continue';
    }
  } finally {
    rt.breakFrame = undefined;
    rt.eventsSuspended--;
    if (rt.state === 'break') rt.state = 'running';
  }
  if (rt.stopping) throw END;
  if (answer === 'end') {
    rt.endProgram();
    throw END;
  }
}

function* pauseHere(f: Frame): Gen<void> {
  f.run.rt.pauseRequested = false;
  yield* enterBreak(f, 'pause');
}

// ---------------------------------------------------------------------------
// Objects of class modules: Class_Terminate
// ---------------------------------------------------------------------------

/**
 * Terminates the objects in `Runtime.dying` that were let go at call depth `depth` or deeper and still have no counted
 * reference (a Function's result is stored by the statement that called it before this runs): Class_Terminate runs,
 * then the object's variables let go of what they hold (which may terminate more objects).
 */
export function* reap(run: Run, depth: number): Gen<void> {
  const rt = run.rt;
  for (;;) {
    const list = rt.dying;
    if (list === null) return;
    const i = list.findIndex(e => e.depth >= depth);
    if (i < 0) return;
    const { inst } = list[i];
    list.splice(i, 1);
    if (list.length === 0) rt.dying = null;
    inst.dying = false;
    if (inst.refs > 0 || inst.escaped || inst.dead) continue;
    const t = inst.initPending ? undefined : inst.module.procs.get('class_terminate');
    if (t) {
      inst.dead = true;
      yield new SubCall(invokeProc(run, t, [], inst));
    }
    rt.dropInstance(inst);
  }
}

/** Leaving a procedure: its own variables let go of the class objects they hold. */
function releaseLocals(f: Frame): void {
  for (const v of f.locals.values()) {
    if (v.opts.shared) continue;
    const x = rawValue(v.ref);
    if (x instanceof ClassValue) x.inst.release();
  }
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

/** An argument bound by the caller: a by-reference slot (with the slot's declared type, if any), a value, or omitted. */
export type BoundArg =
  | { slot: Slot; type?: VBTypeName; isArray?: boolean; fixedLength?: number }
  | { value: VBValue; sub?: StaticType }
  | typeof MISSING;
export const MISSING = Symbol('missing');

function sameType(a: VBTypeName, b: VBTypeName): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if ('userType' in a && 'userType' in b) return lc(a.userType) === lc(b.userType);
  if ('objectType' in a && 'objectType' in b) return lc(a.objectType) === lc(b.objectType);
  return false;
}

/** An object type (`As Object`, `As TextBox`): passing one object variable for another copies the reference. */
const isObjectType = (t: VBTypeName): boolean => t === 'Object' || (typeof t === 'object' && 'objectType' in t);

/** The parameters of `f`'s procedure as its locals, from the arguments the caller bound; a Function's result variable. */
function bindParams(f: Frame, args: BoundArg[]): void {
  const rt = f.run.rt;
  const module = f.module;
  const proc = f.proc!;
  for (let i = 0; i < proc.params.length; i++) {
    const p = proc.params[i];
    let a = args[i];
    if (p.paramArray && (a === undefined || a === MISSING)) a = { value: new VBArray('Variant', [[0, -1]]) };   // no extra arguments: an empty array
    if ((a === undefined || a === MISSING) && !p.optional) throw compileError('Argument not optional');
    if (a !== undefined && a !== MISSING && 'slot' in a && !p.byRef) a = { value: a.slot.value };
    const type = rt.resolveType(p.type, module);
    let v: Variable;
    if (a === undefined || a === MISSING) {
      if (p.isArray) v = new Variable(p.name, type, new VBRef(rt.unallocatedArray(type)), { isArray: true });
      else {
        // an omitted Optional Variant without a default is Missing (IsMissing); a typed one gets its type's default
        const dv = p.defaultValue ? constExpr(rt.moduleFrame(module), p.defaultValue) : type === 'Variant' ? Missing : rt.defaultFor(type);
        v = new Variable(p.name, type, new VBRef(storeValue(dv, type)));
      }
    } else if ('slot' in a) {
      if (p.isArray) {
        if (!(a.slot.value instanceof VBArray)) throw new VBRuntimeError(13);
        v = new Variable(p.name, type, a.slot, { isArray: true, shared: true });
      } else if (a.type === undefined) {
        // untyped reference from the host (event arguments): convert in place and share
        a.slot.value = storeValue(a.slot.value, type);
        v = new Variable(p.name, type, a.slot, { shared: true });
      } else if (sameType(a.type, type) || type === 'Variant') {
        // shared: assignments convert to the caller's declared type (an array stays an array, a String * n keeps n)
        v = new Variable(p.name, a.type, a.slot, { isArray: a.isArray, fixedLength: a.fixedLength, variantAlias: !sameType(a.type, type), shared: true });
      } else if (isObjectType(a.type) && isObjectType(type)) {
        // another object type (an interface of the object): a reference of the parameter's own type
        v = new Variable(p.name, type, new VBRef(storeValue(a.slot.value, type)));
      } else {
        // VB6 does not compile a variable of another type passed to a typed ByRef parameter (`Foo (x)` passes a copy)
        throw compileError('ByRef argument type mismatch');
      }
    } else if (p.isArray) {
      if (!(a.value instanceof VBArray)) throw new VBRuntimeError(13);
      v = new Variable(p.name, type, new VBRef(a.value.clone()), { isArray: true });
    } else {
      v = new Variable(p.name, type, new VBRef(storeValue(a.value, type)));
      if (a.sub !== undefined) { v.sub = a.sub; v.subOf = v.value; }
    }
    if (classesInUse && !v.opts.shared) retain(v.value);
    f.locals.set(lc(p.name), v);
  }
  if (proc.kind === 'function') {
    const t = rt.resolveType(proc.returnType, module);
    f.returnVar = proc.returnsArray
      ? new Variable(proc.name, t, new VBRef(rt.unallocatedArray(t)), { isArray: true })
      : new Variable(proc.name, t, new VBRef(rt.defaultFor(t)));
    f.locals.set(lc(proc.name), f.returnVar);
  }
}

/** Runs a Sub/Function body in a new frame (run by the driver as a SubCall); `inst` is `Me` of a class module's procedure. */
export function* invokeProc(run: Run, ref: ProcRef, args: BoundArg[], inst?: ClassInstance): Gen<VBValue> {
  const rt = run.rt;
  if (run.frames.length >= MAX_CALL_DEPTH) throw new VBRuntimeError(28);
  const { module, proc } = ref;
  const f = new Frame(run, module, proc, proc.line, inst);
  const hasRest = proc.params.length > 0 && proc.params[proc.params.length - 1].paramArray === true;
  if (args.length > proc.params.length && !hasRest) throw compileError('Wrong number of arguments or invalid property assignment');
  bindParams(f, args);
  run.frames.push(f);
  rt.callDepth++;
  try {
    yield* declareLocals(f);
    const c = yield* execBlock(f, proc.body);
    // a GoTo whose label is inside a block it is not in (e.g. into a loop body)
    if (c instanceof GotoJump) throw compileError('GoTo into a block is not supported');
    // VB6 clears Err when a procedure with an active error handler returns
    if (f.onError !== 'none' || f.inHandler) rt.err.clear();
  } finally {
    rt.callDepth--;
    run.frames.pop();
    if (rt.instances.size > 0) releaseLocals(f);
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
    const lo = b.lower ? toNumber(yield* evalExpr(f, b.lower)) : f.module.optionBase;
    const hi = toNumber(yield* evalExpr(f, b.upper));
    out.push([lo, hi]);
  }
  return out;
}

/** Creates the variable for a declaration (default value, fixed or dynamic array). */
export function* declareVariable(f: Frame, d: VarDecl): Gen<Variable> {
  return newVariable(f, d, d.isArray && d.bounds ? yield* evalBounds(f, d.bounds) : null);
}

/** The variable of a declaration, with the bounds of a fixed array. */
export function newVariable(f: Frame, d: VarDecl, bounds: [number, number][] | null): Variable {
  const rt = f.run.rt;
  const type = rt.resolveType(d.type, f.module);
  // `As New T`: each element / the variable makes its object when it is first used
  const create = d.isNew ? objectFactory(rt, d.type ?? 'Variant', f.module) : undefined;
  const n = d.fixedLength;
  if (d.isArray) {
    if (bounds) {
      const arr = n === undefined ? rt.newArray(type, bounds, true, create) : VBArray.fixedString(bounds, n, true);
      return new Variable(d.name, type, new VBRef(arr), { isArray: true, fixedArray: true });
    }
    const arr = n === undefined ? rt.unallocatedArray(type, create) : VBArray.fixedString(null, n, false);
    return new Variable(d.name, type, new VBRef(arr), { isArray: true });
  }
  if (create) return new Variable(d.name, type, new AutoNewSlot(create));
  return new Variable(d.name, type, new VBRef(rt.defaultFor(type, n)), { fixedLength: n });
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
          const store = f.instance ? f.instance.staticStore(proc) : rt.staticStore(proc);
          let v = store.get(key);
          if (!v) {
            v = yield* declareVariable(f, item.decl);
            v.opts.shared = true;   // it outlives the call
            store.set(key, v);
          }
          f.locals.set(key, v);
        } else {
          f.locals.set(key, yield* declareVariable(f, item.decl));
        }
        break;
      } catch (e) {
        // On Error has not run yet: the error is unhandled (RETRY on Continue) or goes to a caller (rethrown)
        const r = yield* handleError(f, e);
        if (r !== RETRY) throw new Error('declareLocals: an error handler is active before the procedure body');
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
      yield* assign(f, s.target, value, s.isSet, s.value);
      return;
    }
    case 'call': return yield* execCall(f, s.target, s.args);
    case 'debugPrint': {
      const line = new PrintLine(rt.printColumn, '\n');
      const newline = yield* printItems(f, s.items, line);
      rt.printColumn = newline ? 0 : line.column();
      rt.host.debugPrint(line.text(), newline);
      return;
    }
    case 'open': case 'close': case 'printFile': case 'writeFile': case 'inputFile': case 'lineInput':
    case 'getFile': case 'putFile': case 'seekFile': case 'name':
      yield* execFileStmt(f, s);
      return;
    case 'gfx': yield* execGraphics(f, s); return;
    case 'if': {
      for (const b of s.branches) {
        if (yield* guardedCond(f, b.line, b.cond, true)) return yield* execBlock(f, b.body);
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
        if (t && !t.atEnd && (yield* guardedCond(f, s.line, t.expr, t.mode === 'while')) !== (t.mode === 'while')) return;
        const c = yield* execBlock(f, s.body);
        if (c === 'exitDo') return;
        if (c !== undefined) return c;
        if (t && t.atEnd && (yield* guardedCond(f, s.line, t.expr, t.mode !== 'while')) !== (t.mode === 'while')) return;
      }
    }
    case 'while': {
      while (yield* guardedCond(f, s.line, s.cond, true)) {
        const c = yield* execBlock(f, s.body);
        if (c !== undefined) return c;
        if (atBoundary(f, s.line)) yield* boundary(f);
      }
      return;
    }
    case 'exit':
      if (s.what === 'for') return 'exitFor';
      if (s.what === 'do') return 'exitDo';
      // VB6 resets Err when an error-handling procedure exits (as when it reaches End Sub)
      if (f.onError !== 'none' || f.inHandler) rt.err.clear();
      return 'exitProc';
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
        const n = cur.fixedLength;
        if (!v.opts.isArray) v.ref.value = Empty;
        else if (cur.fixed) v.ref.value = n === undefined ? rt.newArray(cur.elemType, cur.bounds, true) : VBArray.fixedString(cur.bounds, n, true);
        else v.ref.value = n === undefined ? rt.unallocatedArray(cur.elemType) : VBArray.fixedString(null, n, false);
      }
      return;
    }
    case 'with': {
      const obj = yield* evalExpr(f, s.object);
      if (obj instanceof NothingT) throw new VBRuntimeError(91);
      f.withStack.push(obj);
      retain(obj);   // `With New Class1`: the object lives until End With
      try {
        return yield* execBlock(f, s.body);
      } finally {
        f.withStack.pop();
        release(obj);
      }
    }
    case 'raiseEvent': return yield* raiseEvent(f, s.name, s.args);
    case 'label':
      if (isLineNumber(s.name)) f.lastLine = +s.name;
      return;
    case 'error': case 'mid': case 'lset': case 'rset': return yield* execStringStmt(f, s);
    case 'return': case 'onGoto': case 'debugAssert': return yield* execJumpStmt(f, s);
    case 'goto': {
      if (s.gosub) return yield* execJumpStmt(f, s);
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
      // `Load Command1(i)`: an element of a control array, which may not exist yet
      if (s.target.kind === 'call' && s.target.target.kind === 'name' && s.target.args.length === 1) {
        const arr = yield* evalExpr(f, s.target.target);
        if (isObject(arr) && (s.kind === 'load' ? arr.loadElement : arr.unloadElement)) {
          const a = s.target.args[0];
          if (a.kind === 'missing') throw new VBRuntimeError(450);
          const index = toNumber(yield* evalExpr(f, a));
          const r = s.kind === 'load' ? arr.loadElement!(index) : arr.unloadElement!(index);
          if (r instanceof Promise) yield* awaitHost(f, r.then(() => Empty));
          else yield* afterHostCall(f);
          return;
        }
        // `Load Text1(1)` where Text1 is a single control (or another object): not a control array
        if (isObject(arr)) throw new VBRuntimeError(343, 'Object not an array');
      }
      const obj = yield* evalExpr(f, s.target);
      if (obj instanceof NothingT) throw new VBRuntimeError(91);
      if (!isObject(obj)) throw new VBRuntimeError(424);
      const r = obj.callMethod(s.kind === 'unload' ? 'Unload' : 'Load', []);
      if (r instanceof Promise) yield* awaitHost(f, r);
      else yield* afterHostCall(f);
      return;
    }
    case 'onError': {
      if (s.mode === 'goto') {
        const label = lc(s.label!);
        if (!f.proc || !procLabels(f.proc).has(label)) throw compileError('Label not defined');
        // the handler runs from a label in the procedure's own body (not inside a block)
        if (!labelsOf(f.proc.body).has(label)) throw compileError('GoTo into a block is not supported');
        f.handlerLabel = label;
      }
      f.onError = s.mode === 'goto0' ? 'none' : s.mode;
      rt.err.clear();
      return;
    }
    case 'resume': {
      let label = '';
      if (s.mode === 'label') {
        label = lc(s.label!);
        if (!f.proc || !procLabels(f.proc).has(label)) throw compileError('Label not defined');
      }
      if (!f.inHandler) throw new VBRuntimeError(20);
      f.inHandler = false;
      rt.err.clear();
      return new ResumeJump(s.mode, label);
    }
  }
}

/**
 * `RaiseEvent Name(args)`: runs `x_Name(args)` in each module (and object) whose WithEvents variable `x` holds this
 * object, in the order they were set. Arguments are passed like a call's (a ByRef parameter of the handler changes the
 * raiser's variable). An event the module does not declare is a compile error; outside a class object nothing listens.
 */
function* raiseEvent(f: Frame, name: string, args: (Expr | MissingArg)[]): Gen<Completion> {
  if (!f.module.events.has(lc(name))) throw compileError('Event not found');
  const sinks = f.instance?.sinks;
  if (!sinks) return;
  for (const sink of [...sinks]) {
    const v = rawValue(sink.ref);
    const ev = sink.opts.events;
    if (!(v instanceof ClassValue) || v.inst !== f.instance || !ev || ev.instance?.dead) continue;
    const handler = ev.module.procs.get(`${lc(sink.name)}_${lc(name)}`);
    if (handler) yield* callProc(f, handler, args, ev.instance);
  }
}

/** `Error n`, the Mid statement, LSet and RSet (kept out of execInner, which stays small for the hot statements). */
function* execStringStmt(f: Frame, s: ErrorStmt | MidStmt | AlignStmt): Gen<Completion> {
  switch (s.kind) {
    case 'error': {
      // `Error n`: like Err.Raise n (VB's description for n)
      const n = bankers(toNumber(yield* evalExpr(f, s.number)));
      if (!(n >= 1 && n <= 65535)) throw new VBRuntimeError(5);
      throw new VBRuntimeError(n);
    }
    case 'mid': {
      const cur = toStr(plain(yield* evalExpr(f, s.target)));
      const start = bankers(toNumber(yield* evalExpr(f, s.start)));
      let n = s.length ? bankers(toNumber(yield* evalExpr(f, s.length))) : Infinity;
      const value = toStr(plain(shown(f, s.value, yield* evalExpr(f, s.value))));
      if (start < 1 || start > cur.length || n < 0) throw new VBRuntimeError(5);
      n = Math.min(n, value.length, cur.length - start + 1);
      yield* assign(f, s.target, cur.slice(0, start - 1) + value.slice(0, n) + cur.slice(start - 1 + n), false);
      return;
    }
    case 'lset': case 'rset': {
      const cur = yield* evalExpr(f, s.target);
      if (cur instanceof VBRecord) throw compileError(`Not supported in VibeBasic: ${s.kind === 'lset' ? 'LSet' : 'RSet'} of a user-defined type`);
      const n = toStr(plain(cur)).length;
      const v = toStr(plain(shown(f, s.value, yield* evalExpr(f, s.value))));
      const out = v.length >= n ? v.slice(0, n) : s.kind === 'lset' ? v.padEnd(n, ' ') : v.padStart(n, ' ');
      yield* assign(f, s.target, out, false);
      return;
    }
  }
}

/** `GoSub`, `Return`, `On n GoTo/GoSub` and `Debug.Assert` (kept out of execInner, which stays small for the hot statements). */
function* execJumpStmt(f: Frame, s: GotoStmt | ReturnStmt | OnGotoStmt | DebugAssertStmt): Gen<Completion> {
  switch (s.kind) {
    case 'goto': return yield* gosub(f, labelOf(f, s.label));
    case 'return':
      if (f.gosubDepth === 0) throw new VBRuntimeError(3);
      return 'return';
    case 'onGoto': {
      const labels = s.labels.map(l => labelOf(f, l));
      const n = bankers(toNumber(plain(yield* evalExpr(f, s.index))));
      if (n < 0 || n > 255) throw new VBRuntimeError(5);
      if (n === 0 || n > labels.length) return undefined;   // out of range: the next statement
      return s.gosub ? yield* gosub(f, labels[n - 1]) : new GotoJump(labels[n - 1]);
    }
    case 'debugAssert': {
      // a made app leaves the statement out (the expression is not evaluated)
      if (f.rt.ignoreAsserts) return undefined;
      if (!truthy(yield* evalExpr(f, s.cond))) yield* enterBreak(f, 'pause');
      return undefined;
    }
  }
}

/** A GoTo / GoSub label of the procedure (lower case); none: "Label not defined". */
function labelOf(f: Frame, name: string): string {
  const label = lc(name);
  if (!f.proc || !procLabels(f.proc).has(label)) throw compileError('Label not defined');
  return label;
}

/**
 * `GoSub label`: the procedure's code from the label (in the procedure's own body, not inside a block) runs until a
 * `Return`, then the statement after the GoSub. Reaching the end of the procedure first ends the procedure.
 */
function* gosub(f: Frame, label: string): Gen<Completion> {
  const body = f.proc!.body;
  const at = jumpTo(f, body, label);
  if (at === undefined) throw compileError('GoSub into a block is not supported');
  f.gosubDepth++;
  let c: Completion;
  try {
    c = yield* execBlock(f, body, at + 1);
  } finally {
    f.gosubDepth--;
  }
  if (c === 'return') return undefined;
  return c ?? 'exitProc';
}

/** A call statement: `Foo 1, 2`, `Call Foo(1)`, `obj.Method x`. */
function* execCall(f: Frame, target: Expr, args: (Expr | MissingArg)[]): Gen<Completion> {
  if (target.kind === 'name') {
    const key = lc(target.name);
    // Inside Function Foo, a `Foo` statement is a recursive call.
    if (f.returnVar && key === lc(f.proc!.name)) { yield* callProc(f, f.module.procs.get(key)!, args); return; }
    const b = key === 'me' ? undefined : lookup(f, key, target.name, args.length > 0);
    if (b instanceof ProcRef) { yield* callProc(f, b, args); return; }
    if (b instanceof PropRef) throw compileError('Invalid use of property');
    if (b instanceof BuiltinRef) { yield* callBuiltin(f, b, args); return; }
    // a property of the form used as a statement: a method call, like `Me.name args`
    if (b instanceof MemberRef) { yield* callObjectMethod(f, b.obj, b.name, args); return; }
    // in a form: a method of Me (`Hide`, `Move 0, 0`)
    if (b === undefined && key !== 'me') { yield* formMethod(f, target.name, args); return; }
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
    if (base instanceof ClassValue) {
      yield* classCall(f, base, target.name, args);
      return;
    }
    if (isObject(base)) {
      yield* callObjectMethod(f, base, target.name, args);
      return;
    }
    throw new VBRuntimeError(424);
  }
  throw compileError('Expected Sub, Function, or Property');
}

/** `obj.name args` as a statement: `callMethod` (a Promise result is awaited). */
function* callObjectMethod(f: Frame, obj: VBObject, name: string, args: (Expr | MissingArg)[]): Gen<void> {
  const argv = shownArgs(f, args, yield* evalArgValues(f, args));
  const r = obj.callMethod(name, methodArgs(argv, obj), yield* hostRefs(f, obj, name, args));
  if (r instanceof Promise) yield* awaitHost(f, r);
  else yield* afterHostCall(f);
}

function* caseMatches(f: Frame, subject: VBValue, t: CaseTest): Gen<boolean> {
  // Null never matches (the comparison is Null, i.e. not True)
  const cmp = (v: VBValue, op: string) => {
    const a = plain(subject);
    const b = plain(v);
    if (a instanceof NullT || b instanceof NullT) return false;
    if (f.module.textCompare) return textBinary(op as CompareOp, a, b) === true;   // Option Compare Text
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
        if (r === RETRY) continue;
        // Resume Next: VB6 goes on with the next statement in the source, the Case body
        if (r === RESUME_NEXT) { hit = true; break; }
        return r;
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
    // the back-edge (increment and test) is the Next line, as in VB6: a step stops there, not on the For line again
    if (atBoundary(f, s.nextLine)) yield* boundary(f);
    // the increment belongs to the Next statement; a failure is retried on its own
    for (;;) {
      f.line = s.nextLine;
      try {
        v.set(toNumber(v.value) + step);
        break;
      } catch (e) {
        const r = yield* handleError(f, e);
        if (r === RETRY) continue;
        // Resume Next after the increment (the Next line): the statement after the loop
        return r === RESUME_NEXT ? undefined : r;
      }
    }
  }
}

function* execForEach(f: Frame, s: ForEachStmt): Gen<Completion> {
  const v = variableOf(f, s.variable);
  const source = yield* evalExpr(f, s.collection);
  let coll = plainCollection(source);
  // the elements of a Single array in a Variant: their 7 shown digits (see staticTypes.ts `shown`)
  if (source instanceof VBArray && source.elemType === 'Single' && v.type !== 'Single') coll = coll.map(x => (maybeSingle(x) ? single7(x) : x));
  // a ParamArray's items keep the number subtype the caller's code gave them (VBArray.noteSub)
  const subs = source instanceof VBArray && source.bounds.length === 1 && v.type === 'Variant' && !v.opts.isArray ? source : null;
  for (const [k, item] of coll.entries()) {
    // the element assignment belongs to the For Each statement; a failure is retried on its own
    for (;;) {
      f.line = s.line;
      try {
        v.set(item);
        if (subs) { v.sub = subs.subAt([subs.bounds[0][0] + k]) as StaticType | undefined; v.subOf = v.value; }
        break;
      } catch (e) {
        const r = yield* handleError(f, e);
        if (r === RETRY) continue;
        if (r === RESUME_NEXT) break; // the body follows, with the variable unchanged
        return r;
      }
    }
    const c = yield* execBlock(f, s.body);
    if (c === 'exitFor') return;
    if (c !== undefined) return c;
    if (atBoundary(f, s.nextLine)) yield* boundary(f);
  }
  return;
}

/**
 * Elements of a For Each collection: an array in VB order (first index varies
 * fastest), or an object's `items()` (a control array). An object without
 * `items` is error 438, Nothing 91, anything else 13.
 */
function plainCollection(v: VBValue): VBValue[] {
  if (!(v instanceof VBArray)) {
    if (v instanceof NothingT) throw new VBRuntimeError(91);
    if (isObject(v)) {
      if (!v.items) throw new VBRuntimeError(438);
      return v.items();
    }
    throw new VBRuntimeError(13);
  }
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
